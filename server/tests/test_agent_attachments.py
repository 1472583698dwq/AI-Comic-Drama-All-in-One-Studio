# -*- coding: utf-8 -*-
"""多模态附件回归测试（stdlib unittest，零外部依赖）。

运行：python -m unittest tests.test_agent_attachments -v
覆盖：附件校验/去重/上限、视觉能力开关、content parts 组装（图片内联/降级文本）、
Session.derive_messages 投影、上传落盘。
"""
import os
import asyncio
import base64
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.runtime import events as E  # noqa: E402
from app.agent.runtime.session import Session  # noqa: E402
from app.agent.runtime.store import SessionStore  # noqa: E402
from app.agent.runtime import attachments as A  # noqa: E402
from app.core import features as features_mod  # noqa: E402
from app.core.config import settings as app_settings  # noqa: E402

_LOOP = None


def run(coro):
    """显式复用测试事件循环（避免跨模块 get_event_loop 状态漂移）。"""
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


class AttachmentBase(unittest.TestCase):
    """多模态附件现由功能级开关 ``agent_multimodal`` 把门（出厂关闭）。

    本文件测的是「开启后」的既有行为，故类级把开关打开；storage 同时指到临时
    目录，开关文件与上传落盘都不会碰到真实 storage/。
    """

    @classmethod
    def setUpClass(cls):
        cls._orig_storage = app_settings.STORAGE_DIR
        cls._storage_tmp = tempfile.mkdtemp(prefix="agent_att_storage_")
        app_settings.STORAGE_DIR = cls._storage_tmp
        features_mod.set_values({"agent_multimodal": True})

    @classmethod
    def tearDownClass(cls):
        app_settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._storage_tmp, ignore_errors=True)

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="agent_att_")
        self.store = SessionStore(Path(self._tmp))
        # 造一张真实的小 PNG（1x1）供内联测试
        self.png = os.path.join(self._tmp, "pixel.png")
        with open(self.png, "wb") as f:
            f.write(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
                "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
            ))
        self._env_backup = {k: os.environ.get(k) for k in ("AGENT_MM_IMAGE", "AGENT_MM_VIDEO", "AGENT_MM_AUDIO")}
        # 上传落盘改到临时目录，避免污染真实 storage/
        self._root_backup = A._storage_root
        A._storage_root = lambda: self._tmp

    def tearDown(self):
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        A._storage_root = self._root_backup
        shutil.rmtree(self._tmp, ignore_errors=True)


class TestSanitize(AttachmentBase):
    def test_sanitize_dedup_and_cap(self):
        raw = [{"kind": "image", "ref": self.png, "name": "a"}] * 3
        raw += [{"kind": "image", "ref": f"https://x.test/{i}.png"} for i in range(10)]
        raw += [{"kind": "nope", "ref": ""}, "not-a-dict", {"ref": "javascript:alert(1)"}]
        out = A.sanitize_attachments(raw)
        self.assertEqual(len(out), A.MAX_ATTACHMENTS)
        self.assertEqual(len({a["ref"] for a in out}), len(out))
        self.assertTrue(all(a["kind"] == "image" for a in out))

    def test_kind_guess_by_extension(self):
        out = A.sanitize_attachments([
            {"ref": "https://x.test/a.mp4"},
            {"ref": "https://x.test/a.mp3"},
            {"ref": "https://x.test/a.webp"},
        ])
        self.assertEqual([a["kind"] for a in out], ["video", "audio", "image"])


class TestContentParts(AttachmentBase):
    def test_vision_off_degrades_to_text(self):
        os.environ["AGENT_MM_IMAGE"] = "0"
        atts = A.sanitize_attachments([{"kind": "image", "ref": self.png, "name": "pixel"}])
        content = A.build_user_content("看看这张图", atts)
        self.assertIsInstance(content, str)
        self.assertIn("看看这张图", content)
        self.assertIn("图片附件", content)

    def test_vision_on_inlines_image(self):
        os.environ["AGENT_MM_IMAGE"] = "1"
        atts = A.sanitize_attachments([{"kind": "image", "ref": self.png, "name": "pixel"}])
        content = A.build_user_content("看图", atts)
        self.assertIsInstance(content, list)
        kinds = [p.get("type") for p in content]
        self.assertIn("text", kinds)
        self.assertIn("image_url", kinds)
        img = next(p for p in content if p["type"] == "image_url")
        self.assertTrue(img["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_missing_file_keeps_note(self):
        os.environ["AGENT_MM_IMAGE"] = "1"
        atts = A.sanitize_attachments([{"kind": "image", "ref": os.path.join(self._tmp, "ghost.png")}])
        content = A.build_user_content("缺失", atts)
        if isinstance(content, list):
            joined = " ".join(str(p.get("text") or "") for p in content)
        else:
            joined = str(content)
        self.assertIn("未能内联", joined)


class TestDeriveMessages(AttachmentBase):
    def _session_with_attachment(self, sid: str):
        s = Session(sid, store=self.store)
        s.append(E.USER_MESSAGE, {
            "text": "这张参考图改成黄昏",
            "source": "user",
            "form": "message",
            "meta": {"attachments": [{"kind": "image", "ref": self.png, "name": "ref.png"}]},
        })
        return s

    def test_derive_with_vision_on(self):
        os.environ["AGENT_MM_IMAGE"] = "1"
        s = self._session_with_attachment("sess_att_on")
        msgs = s.derive_messages(system_text="SYS")
        user = [m for m in msgs if m["role"] == "user"]
        self.assertTrue(user)
        self.assertIsInstance(user[-1]["content"], list)
        self.assertTrue(any(p.get("type") == "image_url" for p in user[-1]["content"]))

    def test_derive_with_vision_off(self):
        os.environ["AGENT_MM_IMAGE"] = "0"
        s = self._session_with_attachment("sess_att_off")
        msgs = s.derive_messages(system_text="SYS")
        user = [m for m in msgs if m["role"] == "user"]
        self.assertTrue(user)
        self.assertIsInstance(user[-1]["content"], str)
        self.assertIn("参考图", user[-1]["content"])

    def test_no_attachments_stays_string(self):
        s = Session("sess_att_none", store=self.store)
        s.append(E.USER_MESSAGE, {"text": "普通消息"})
        msgs = s.derive_messages(system_text="SYS")
        user = [m for m in msgs if m["role"] == "user"]
        self.assertEqual(user[-1]["content"], "普通消息")


class TestAutoCollect(AttachmentBase):
    def test_focus_nodes_images_collected_video_gated(self):
        os.environ["AGENT_FOCUS_MEDIA"] = "1"
        os.environ["AGENT_MM_VIDEO"] = "0"
        atts = A.attachments_from_focus_nodes({
            "agent_focus_nodes": [{
                "id": "n1", "label": "生图 Agent",
                "image_url": "https://x.test/a.png",
                "video_url": "https://x.test/a.mp4",
            }]
        })
        self.assertEqual([a["kind"] for a in atts], ["image"])
        os.environ["AGENT_MM_VIDEO"] = "1"
        atts2 = A.attachments_from_focus_nodes({
            "agent_focus_nodes": [{"id": "n1", "image_url": "https://x.test/a.png",
                                   "video_url": "https://x.test/a.mp4"}]
        })
        self.assertEqual([a["kind"] for a in atts2], ["image", "video"])
        os.environ["AGENT_FOCUS_MEDIA"] = "0"
        self.assertEqual(A.attachments_from_focus_nodes({"agent_focus_nodes": [{"image_url": "https://x.test/a.png"}]}), [])

    def test_tool_result_media_whitelist(self):
        atts = A.attachments_from_tool_result("generate_image", {"image_url": "https://x.test/a.png"})
        self.assertEqual(len(atts), 1)
        self.assertEqual(A.attachments_from_tool_result("list_assets", {"image_url": "https://x.test/a.png"}), [])
        self.assertEqual(A.attachments_from_tool_result("generate_image", "not-a-dict"), [])
        # 画布执行/任务续等的结果也应回投
        self.assertEqual(len(A.attachments_from_tool_result("canvas_execute", {"image_url": "https://x.test/b.png"})), 1)
        self.assertEqual(len(A.attachments_from_tool_result("task_wait", {"video_url": "https://x.test/c.mp4"})), 0)
        os.environ["AGENT_MM_VIDEO"] = "1"
        self.assertEqual(len(A.attachments_from_tool_result("task_wait", {"video_url": "https://x.test/c.mp4"})), 1)


class TestViewMediaTool(AttachmentBase):
    def _run_execute(self, args):
        from app.agent.tools.pipeline import ToolPipeline
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline("sess_view_media", emit, interactive=False)

        async def go():
            return await p.execute("c1", "view_media", args, run_mode="auto")

        return run(go()), events

    def test_view_media_by_url(self):
        out, _ = self._run_execute({"url": "https://x.test/a.png"})
        self.assertEqual(out.status, "success")
        self.assertTrue((out.meta or {}).get("media_attachments"))
        self.assertEqual(out.meta["media_attachments"][0]["kind"], "image")

    def test_view_media_empty_is_error(self):
        out, _ = self._run_execute({})
        self.assertEqual(out.status, "error")
        self.assertIn("未找到可用媒体", out.error or "")

    def test_view_media_plan_mode_allowed(self):
        from app.agent.tools.pipeline import ToolPipeline

        async def emit(ev):
            pass

        p = ToolPipeline("sess_view_media_plan", emit, plan_mode=True, interactive=False)

        async def go():
            return await p.execute("c1", "view_media", {"url": "https://x.test/a.png"}, run_mode="plan")

        out = run(go())
        self.assertEqual(out.status, "success")


class TestVideoFrames(AttachmentBase):
    """视频检查能力：模型看不了视频原片 → 抽帧成图片（工具产物回投 + view_media 展开）。"""

    def _make_video(self):
        import subprocess
        exe = A._ffmpeg_exe()
        if not exe:
            self.skipTest("无 ffmpeg（系统 PATH 与 imageio_ffmpeg 均不可用）")
        vid = os.path.join(self._tmp, "v.mp4")
        r = subprocess.run([exe, "-y", "-loop", "1", "-i", self.png, "-t", "1.2",
                            "-vf", "scale=64:64", "-pix_fmt", "yuv420p", vid],
                           capture_output=True, timeout=90)
        if r.returncode != 0 or not os.path.isfile(vid):
            self.skipTest(f"ffmpeg 造视频失败: {r.stderr[-200:]!r}")
        return vid

    def test_extract_video_frames_real(self):
        vid = self._make_video()
        frames = A.extract_video_frames(vid, count=3)
        self.assertTrue(frames, "应至少抽到 1 帧")
        self.assertTrue(all(u.startswith("/storage/frames/") for u in frames))
        for u in frames:
            p = os.path.join(self._tmp, "frames", os.path.basename(u))
            self.assertTrue(os.path.isfile(p) and os.path.getsize(p) > 0)
        # 二次调用走缓存
        self.assertEqual(A.extract_video_frames(vid, count=3), frames)

    def test_expand_video_frames_replaces_video(self):
        orig = A.extract_video_frames
        A.extract_video_frames = lambda ref, count=3: ["/storage/frames/x_1.jpg", "/storage/frames/x_2.jpg"]
        try:
            out = A.expand_video_frames([{"kind": "video", "ref": "https://x.test/v.mp4", "name": "成片"}])
        finally:
            A.extract_video_frames = orig
        self.assertEqual([a["kind"] for a in out], ["image", "image"])
        self.assertTrue(all(a["meta"]["from_video"].endswith("v.mp4") for a in out))

    def test_tool_result_video_attaches_frames_when_vision(self):
        os.environ["AGENT_MM_IMAGE"] = "1"
        orig = A.extract_video_frames
        A.extract_video_frames = lambda ref, count=2: ["/storage/frames/t_1.jpg"]
        try:
            out = A.attachments_from_tool_result("onekey_shot_video", {"video_url": "/storage/videos/a.mp4"})
        finally:
            A.extract_video_frames = orig
        self.assertEqual([a["kind"] for a in out], ["image"])
        self.assertEqual(out[0]["meta"]["from_video"], "/storage/videos/a.mp4")


class TestLongTextFold(AttachmentBase):
    def setUp(self):
        super().setUp()
        self._old_max = os.environ.get("AGENT_USER_TEXT_MAX")

    def tearDown(self):
        if self._old_max is None:
            os.environ.pop("AGENT_USER_TEXT_MAX", None)
        else:
            os.environ["AGENT_USER_TEXT_MAX"] = self._old_max
        super().tearDown()

    def test_short_text_untouched(self):
        from app.agent.runtime.compaction import maybe_fold_user_text
        self.assertEqual(maybe_fold_user_text("s", 1, "短文本"), "短文本")

    def test_fold_keeps_head_tail_and_locator(self):
        from app.agent.runtime import compaction as C
        os.environ["AGENT_USER_TEXT_MAX"] = "300"
        orig = C.spill_long_user_text
        C.spill_long_user_text = lambda sid, seq, t: "C:/fake/user_1_text.md"
        try:
            text = "开头" + "中" * 2000 + "结尾"
            folded = C.maybe_fold_user_text("s", 1, text)
        finally:
            C.spill_long_user_text = orig
        self.assertIn("开头", folded)
        self.assertIn("结尾", folded)
        self.assertIn("已折叠", folded)
        self.assertIn("fs_read", folded)
        self.assertLess(len(folded), 1200)

    def test_derive_folds_user_but_not_context(self):
        from app.agent.runtime import compaction as C
        os.environ["AGENT_USER_TEXT_MAX"] = "300"
        orig = C.spill_long_user_text
        C.spill_long_user_text = lambda sid, seq, t: "C:/fake/user_2_text.md"
        try:
            s = Session("sess_long_user", store=self.store)
            s.append(E.USER_MESSAGE, {"text": "A" * 50 + "长" * 2000 + "Z" * 50, "source": "user"})
            s.append(E.USER_MESSAGE, {"text": "C" * 2000, "source": "system", "form": "context"})
            msgs = s.derive_messages(system_text="SYS")
        finally:
            C.spill_long_user_text = orig
        users = [m for m in msgs if m["role"] == "user"]
        self.assertIn("已折叠", users[0]["content"])
        self.assertLess(len(users[0]["content"]), 1200)
        # 运行时上下文（system/context）不折叠，保持原样
        self.assertEqual(users[1]["content"], "C" * 2000)


class TestUpload(AttachmentBase):
    def test_save_upload_returns_storage_ref(self):
        meta = A.save_upload("shot.png", "image/png", b"\x89PNG\r\n\x1a\n" + b"0" * 16)
        self.assertTrue(meta["ref"].startswith("/storage/agent_uploads/"))
        self.assertEqual(meta["kind"], "image")
        self.assertEqual(meta["name"], "shot.png")

    def test_save_upload_rejects_empty(self):
        with self.assertRaises(ValueError):
            A.save_upload("x.png", "image/png", b"")


if __name__ == "__main__":
    unittest.main()
