# -*- coding: utf-8 -*-
"""时间线片段 → 剪映草稿降级出口的桥接测试（stdlib unittest）。

运行： python -m unittest tests.test_timeline_draft -v

钉住一件事：降级出口不是「另起一套数据」，而是把时间线的片段**翻译成既有
jianyin_exporter 认得的 Project**（一场景 N 镜，duration = 裁剪后时长），
这样草稿的轨道排布、缺素材回执、时长探测全部复用既有实现，不产生第二套排布逻辑。
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestClipsToProject(unittest.TestCase):

    def setUp(self):
        from app.core.config import settings
        self.root = tempfile.mkdtemp(prefix="tl_draft_test_")
        self.storage = os.path.join(self.root, "storage")
        os.makedirs(os.path.join(self.storage, "videos"), exist_ok=True)
        for rel in ("videos/a.mp4", "videos/b.mp4"):
            with open(os.path.join(self.storage, rel), "wb") as f:
                f.write(b"\x00")
        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = os.path.join(self.root, "exports")
        os.makedirs(settings.EXPORTS_DIR, exist_ok=True)

    def tearDown(self):
        from app.core.config import settings
        settings.STORAGE_DIR, settings.EXPORTS_DIR = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def mod(self):
        from app.media import timeline_draft
        return timeline_draft

    def clips(self):
        from app.media.timeline_merge import normalize_clips
        return normalize_clips([
            {"url": "/storage/videos/a.mp4", "name": "a", "duration": 4.0, "in": 0.5, "out": 2.5, "kind": "video"},
            {"url": "/storage/videos/b.mp4", "name": "b", "duration": 3.0, "in": 0.0, "out": 3.0, "kind": "video"},
        ])

    def test_builds_single_scene_with_one_shot_per_clip(self):
        proj = self.mod().clips_to_project(self.clips(), title="夜巡成片", aspect_ratio="9:16")
        self.assertEqual(len(proj.scenes), 1)
        self.assertEqual(len(proj.scenes[0].shots), 2)
        self.assertEqual([s.shot_index for s in proj.scenes[0].shots], [1, 2])

    def test_shot_duration_is_trimmed_span_not_source_duration(self):
        proj = self.mod().clips_to_project(self.clips(), title="夜巡成片")
        self.assertAlmostEqual(proj.scenes[0].shots[0].duration, 2.0, places=3)
        self.assertAlmostEqual(proj.scenes[0].shots[1].duration, 3.0, places=3)

    def test_shot_carries_video_url_for_real_material_layout(self):
        proj = self.mod().clips_to_project(self.clips(), title="夜巡成片")
        self.assertEqual(proj.scenes[0].shots[0].video_url, "/storage/videos/a.mp4")

    def test_aspect_ratio_and_title_are_passed_through(self):
        proj = self.mod().clips_to_project(self.clips(), title="夜巡成片", aspect_ratio="16:9")
        self.assertEqual(proj.aspect_ratio, "16:9")
        self.assertEqual(proj.title, "夜巡成片")

    def test_audio_only_clip_goes_to_audio_slot_without_video(self):
        from app.media.timeline_merge import normalize_clips
        os.makedirs(os.path.join(self.storage, "audio"), exist_ok=True)
        with open(os.path.join(self.storage, "audio", "bgm.mp3"), "wb") as f:
            f.write(b"\x00")
        clips = normalize_clips([
            {"url": "/storage/audio/bgm.mp3", "kind": "audio", "duration": 5.0, "in": 0.0, "out": 5.0},
        ])
        proj = self.mod().clips_to_project(clips, title="纯音频")
        shot = proj.scenes[0].shots[0]
        self.assertIsNone(shot.video_url)
        self.assertEqual(shot.audio_url, "/storage/audio/bgm.mp3")

    def test_empty_clips_rejected(self):
        from app.media.timeline_merge import TimelineMergeError
        with self.assertRaises(TimelineMergeError):
            self.mod().clips_to_project([], title="空")


if __name__ == "__main__":
    unittest.main()
