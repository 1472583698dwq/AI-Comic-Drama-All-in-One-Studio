# -*- coding: utf-8 -*-
"""分镜视频归属回归：显式 shot 定位 + 结果字段回写 history。"""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.director_stage.ops import apply_stage_control  # noqa: E402
from app.mcp.server import _video_target  # noqa: E402


def _content():
    return {
        "id": "proj_test",
        "scenes": [
            {"id": "scene-1", "shots": []},
            {
                "id": "scene-2",
                "shots": [
                    {"id": "shot-a", "shot_index": 1, "video_url": "/v/a-old.mp4", "history": []},
                    {"id": "shot-b", "shot_index": 2, "video_url": "", "history": []},
                ],
            },
        ],
    }


class TestVideoTarget(unittest.TestCase):
    def setUp(self):
        self.content = _content()
        self.ctx = {
            "id": "proj_test",
            "project": self.content,
            "active_shot": self.content["scenes"][1]["shots"][0],
        }

    def test_default_uses_active_not_first(self):
        self.content["scenes"][0]["shots"] = [{"id": "shot-zero", "shot_index": 0}]
        self.assertEqual(_video_target(self.ctx)["shot_id"], "shot-a")

    def test_by_index_and_id(self):
        self.assertEqual(_video_target(self.ctx, "", 2)["shot_id"], "shot-b")
        self.assertEqual(_video_target(self.ctx, "shot-b")["shot_id"], "shot-b")

    def test_invalid_explicit_target_raises(self):
        with self.assertRaises(ValueError):
            _video_target(self.ctx, "missing")

    def test_set_shot_text_writes_result_and_keeps_old_video(self):
        c = copy.deepcopy(self.content)
        shot = c["scenes"][1]["shots"][0]
        res = apply_stage_control(c, {
            "action": "set_shot_text",
            "shot_id": "shot-a",
            "payload": {"video_url": "/v/a-new.mp4", "status": "completed"},
        })
        self.assertEqual(shot["video_url"], "/v/a-new.mp4")
        self.assertEqual(shot["status"], "completed")
        self.assertEqual(shot["history"][-1]["video_url"], "/v/a-old.mp4")
        self.assertEqual(res["stage_patch"]["video_url"], "/v/a-new.mp4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
