# -*- coding: utf-8 -*-
"""项目内容版本（_rev）与分镜字段级 PATCH 回归测试。

背景：浏览器整份 PUT 曾把 Agent/导演台刚写入的 stage_control 状态与新分镜覆盖回旧快照；
现在整份保存/字段 patch 都带 _rev 乐观锁，patch 只合并差异字段。
"""
import os
import shutil
import tempfile
import unittest

from app.providers.project import manager as pm_module
from app.providers.project.manager import ProjectRevConflict, project_manager
from app.director_stage.ops import _new_shot


def _content(pid: str) -> dict:
    return {
        "id": pid,
        "title": "T",
        "original_novel": "",
        "style_preset": "donghua_xianxia",
        "aspect_ratio": "9:16",
        "characters": [],
        "episodes": [],
        "scenes": [{
            "id": "scene1",
            "scene_index": 1,
            "title": "S1",
            "location": "hall",
            "shots": [{
                "id": "shot1",
                "shot_index": 1,
                "action_desc": "fight",
                "image_prompt": "cinematic",
                "camera_framing": "full",
                "camera_motion": "orbit_boom_up",
                "focal_length_mm": 24,
                "cast_layout": "duel",
                "props_config": ["sword"],
                "walk_path": [{"x": 1, "z": 2}],
                "lighting_config": {"keyIntensity": 5},
            }],
        }],
    }


class ProjectRevTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="proj_rev_")
        self._root = pm_module.PROJECTS_ROOT
        self._index = pm_module.INDEX_PATH
        pm_module.PROJECTS_ROOT = self.tmp
        pm_module.INDEX_PATH = os.path.join(self.tmp, "index.json")
        self.meta = project_manager.create_project("rev-test")
        self.pid = self.meta["id"]

    def tearDown(self):
        pm_module.PROJECTS_ROOT = self._root
        pm_module.INDEX_PATH = self._index
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_sets_and_increments_rev(self):
        first = project_manager.save_content(self.pid, _content(self.pid))
        self.assertEqual(first["_rev"], 1)
        second = project_manager.save_content(self.pid, _content(self.pid), expected_rev=1)
        self.assertEqual(second["_rev"], 2)

    def test_stale_full_put_conflicts(self):
        project_manager.save_content(self.pid, _content(self.pid))
        project_manager.save_content(self.pid, _content(self.pid), expected_rev=1)
        with self.assertRaises(ProjectRevConflict) as ctx:
            project_manager.save_content(self.pid, _content(self.pid), expected_rev=1)
        self.assertEqual(ctx.exception.current_rev, 2)
        # 旧快照被拒绝后，磁盘仍是第二次保存的内容
        self.assertEqual(project_manager.get_content(self.pid)["_rev"], 2)

    def test_patch_shot_merges_only_given_fields(self):
        project_manager.save_content(self.pid, _content(self.pid))
        res = project_manager.patch_shot(
            self.pid, "shot1",
            {"clay_video_url": "/storage/videos/clay.mp4", "status": "completed"},
            expected_rev=1,
        )
        self.assertEqual(res["content_rev"], 2)
        shot = res["shot"]
        self.assertEqual(shot["clay_video_url"], "/storage/videos/clay.mp4")
        # 舞台字段必须原样保留（这正是整份 PUT 曾覆盖掉的部分）
        self.assertEqual(shot["camera_framing"], "full")
        self.assertEqual(shot["camera_motion"], "orbit_boom_up")
        self.assertEqual(shot["focal_length_mm"], 24)
        self.assertEqual(shot["cast_layout"], "duel")
        self.assertEqual(shot["props_config"], ["sword"])
        self.assertEqual(shot["walk_path"], [{"x": 1, "z": 2}])
        self.assertEqual(shot["lighting_config"], {"keyIntensity": 5})

    def test_patch_shot_rejects_stale_rev(self):
        project_manager.save_content(self.pid, _content(self.pid))
        project_manager.save_content(self.pid, _content(self.pid), expected_rev=1)
        with self.assertRaises(ProjectRevConflict):
            project_manager.patch_shot(self.pid, "shot1", {"status": "x"}, expected_rev=1)

    def test_patch_missing_shot(self):
        project_manager.save_content(self.pid, _content(self.pid))
        with self.assertRaises(KeyError):
            project_manager.patch_shot(self.pid, "nope", {"status": "x"}, expected_rev=1)

    def test_new_shot_keeps_stage_fields(self):
        shot = _new_shot(1, 1, {
            "action_desc": "duel",
            "cast_layout": "duel",
            "props_config": ["sword", "magic_circle"],
            "focal_length_mm": 24,
            "camera_roll_deg": 8,
            "walk_path": [{"x": 1, "z": 2}],
            "lighting_config": {"keyIntensity": 5},
        })
        self.assertEqual(shot["cast_layout"], "duel")
        self.assertEqual(shot["props_config"], ["sword", "magic_circle"])
        self.assertEqual(shot["focal_length_mm"], 24)
        self.assertEqual(shot["camera_roll_deg"], 8)
        self.assertEqual(shot["walk_path"], [{"x": 1, "z": 2}])
        self.assertEqual(shot["lighting_config"], {"keyIntensity": 5})


if __name__ == "__main__":
    unittest.main()
