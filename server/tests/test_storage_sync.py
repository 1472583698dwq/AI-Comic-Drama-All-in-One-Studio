# -*- coding: utf-8 -*-
"""
storage 云端同步的纯逻辑用例（不连网）。

重点守住三件事：
  1. 同步范围是白名单 —— config_store.json 这种带 API Key 的永远不能被传出去；
  2. 本地相对路径 ↔ 远端路径是一一对应的，换台机器才对得上；
  3. 项目索引按 id 合并、新的赢 —— 否则 A 机器拉一次就把 B 机器的项目抹了。
"""
import json
import os
import tempfile
import unittest

from app.storage_sync import mirror as M


class TestScope(unittest.TestCase):
    def test_secrets_never_sync(self):
        self.assertFalse(M.in_scope("config_store.json"))
        self.assertFalse(M.in_scope(".sync/journal.json"))
        self.assertFalse(M.in_scope("providers/custom/x.json"))
        self.assertFalse(M.in_scope("plugins/whatever.py"))
        self.assertFalse(M.in_scope("extensions/e.json"))

    def test_media_and_projects_sync(self):
        for rel in ("generated/a.png", "videos/b.mp4",
                    "assets/ast_1/original.png", "assets/ast_1/meta.json",
                    "projects/proj_1/content.json", "projects/index.json"):
            self.assertTrue(M.in_scope(rel), rel)

    def test_root_level_only_media(self):
        self.assertTrue(M.in_scope("indextts_abc.wav"))
        self.assertTrue(M.in_scope("vid_1.mp4"))
        self.assertFalse(M.in_scope("notes.txt"))
        self.assertFalse(M.in_scope("something.json"))

    def test_dotfiles_skipped(self):
        self.assertFalse(M.in_scope("generated/.gitkeep"))
        self.assertFalse(M.in_scope("videos/.DS_Store"))

    def test_mutable_classification(self):
        # 可变的走版本化快照，不可变的直接镜像
        for rel in ("projects/p/content.json", "projects/p/canvas.json",
                    "projects/p/agent_sessions.json", "assets/a/meta.json",
                    "projects/index.json"):
            self.assertTrue(M.is_mutable(rel), rel)
        for rel in ("generated/a.png", "videos/b.mp4", "assets/a/original.png"):
            self.assertFalse(M.is_mutable(rel), rel)


class TestRemotePaths(unittest.TestCase):
    def setUp(self):
        self.m = M.StorageMirror()
        self.m.root = "/autoword/comic-studio"

    def test_media_path_is_one_to_one(self):
        self.assertEqual(self.m.media_path("videos/b.mp4"),
                         "/autoword/comic-studio/media/videos/b.mp4")
        self.assertEqual(self.m.media_path("tts_1.wav"),
                         "/autoword/comic-studio/media/tts_1.wav")

    def test_state_dir_drops_json_suffix(self):
        self.assertEqual(self.m.state_dir("projects/p1/content.json"),
                         "/autoword/comic-studio/state/projects/p1/content")
        self.assertEqual(self.m.state_dir("projects/index.json"),
                         "/autoword/comic-studio/state/projects/index")


class TestIndexMerge(unittest.TestCase):
    """两台机器各建了项目，合并后谁都不能消失。"""

    def _write(self, d, name, payload):
        p = os.path.join(d, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return p

    def test_union_and_newest_wins(self):
        with tempfile.TemporaryDirectory() as d:
            local = self._write(d, "local.json", [
                {"id": "p1", "title": "本机改过", "updated_at": "2026-09-24T10:00:00"},
                {"id": "p2", "title": "只有本机有", "updated_at": "2026-09-20T10:00:00"},
            ])
            remote = self._write(d, "remote.json", [
                {"id": "p1", "title": "远端旧版", "updated_at": "2026-09-23T10:00:00"},
                {"id": "p3", "title": "只有远端有", "updated_at": "2026-09-22T10:00:00"},
            ])
            self.assertTrue(M._merge_index(local, remote))
            with open(local, encoding="utf-8") as f:
                out = json.load(f)
            by_id = {x["id"]: x for x in out}
            self.assertEqual(set(by_id), {"p1", "p2", "p3"}, "三个项目一个都不能少")
            self.assertEqual(by_id["p1"]["title"], "本机改过", "同 id 取 updated_at 新的那份")

    def test_bad_json_does_not_destroy_local(self):
        with tempfile.TemporaryDirectory() as d:
            local = self._write(d, "local.json", [{"id": "p1", "updated_at": "x"}])
            bad = os.path.join(d, "bad.json")
            with open(bad, "w", encoding="utf-8") as f:
                f.write("{ 这不是 json")
            self.assertFalse(M._merge_index(local, bad))
            with open(local, encoding="utf-8") as f:
                self.assertEqual(len(json.load(f)), 1, "合并失败时本地索引必须原样保留")


class TestSwitch(unittest.TestCase):
    """没配 / 没开的时候，同步层必须是彻底的空操作，不能影响生成流程。"""

    def setUp(self):
        from app.core.config import settings
        self.settings = settings
        self.saved = {k: getattr(settings, k, "") for k in
                      ("OPENLIST_BASE_URL", "OPENLIST_USERNAME", "OPENLIST_PASSWORD",
                       "OPENLIST_SYNC_ENABLED")}

    def tearDown(self):
        for k, v in self.saved.items():
            object.__setattr__(self.settings, k, v)

    def _set(self, **kw):
        for k, v in kw.items():
            object.__setattr__(self.settings, k, v)

    def test_enqueue_is_noop_when_unconfigured(self):
        self._set(OPENLIST_BASE_URL="", OPENLIST_USERNAME="", OPENLIST_PASSWORD="",
                  OPENLIST_SYNC_ENABLED="1")
        m = M.StorageMirror()
        self.assertFalse(m.configured())
        m.enqueue("videos/x.mp4")
        self.assertEqual(m.queue.qsize(), 0)

    def test_enqueue_is_noop_when_switched_off(self):
        self._set(OPENLIST_BASE_URL="http://x", OPENLIST_USERNAME="u",
                  OPENLIST_PASSWORD="p", OPENLIST_SYNC_ENABLED="0")
        m = M.StorageMirror()
        self.assertTrue(m.configured())
        self.assertFalse(m.enabled())
        m.enqueue("videos/x.mp4")
        self.assertEqual(m.queue.qsize(), 0)

    def test_out_of_scope_never_queued_even_when_on(self):
        self._set(OPENLIST_BASE_URL="http://x", OPENLIST_USERNAME="u",
                  OPENLIST_PASSWORD="p", OPENLIST_SYNC_ENABLED="1")
        m = M.StorageMirror()
        self.assertTrue(m.enabled())
        m.enqueue("config_store.json")
        self.assertEqual(m.queue.qsize(), 0, "带 API Key 的配置文件开着同步也不能入队")
        m.enqueue("videos/x.mp4")
        self.assertEqual(m.queue.qsize(), 1)


if __name__ == "__main__":
    unittest.main()
