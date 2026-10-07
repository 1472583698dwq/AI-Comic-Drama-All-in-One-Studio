# -*- coding: utf-8 -*-
"""剪映草稿导出回归测试（stdlib unittest）。

运行： python -m unittest tests.test_jianyin_export -v

钉住三件事：
1. 时间线按**素材真实时长**排布（静帧可延长覆盖配音、视频不冻帧、无画面时让位给配音）；
2. 素材缺失必须被显式记入 skipped_shots / warnings，而不是静默推进游标把配音错压到下一镜；
3. 静态路径围栏不允许越出 storage/exports。

素材是真实生成的最小 PNG/WAV，pymediainfo 真探测，不 mock 时长。
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# 1x1 不透明 PNG
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _write_wav(path: str, seconds: float, rate: int = 44100) -> str:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(round(rate * seconds)))
    return path


def _shot(index: int, **kw):
    from app.models.schemas import StoryboardShot
    base = dict(id=f"shot_{index}", shot_index=index, scene_index=1, action_desc=f"镜头{index}",
                image_prompt=f"p{index}")
    base.update(kw)
    return StoryboardShot(**base)


class _Sandbox(unittest.TestCase):
    """把 storage/exports/剪映目录全部搬到临时目录，绝不碰用户真数据"""

    def setUp(self):
        from app.core.config import settings
        from app.pipelines import jianyin_exporter as mod

        self.root = tempfile.mkdtemp(prefix="jy_export_test_")
        self.storage = os.path.join(self.root, "storage")
        self.exports = os.path.join(self.root, "exports")
        os.makedirs(self.storage, exist_ok=True)
        os.makedirs(self.exports, exist_ok=True)

        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR, settings.JIANYIN_DRAFT_PATH)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = self.exports
        settings.JIANYIN_DRAFT_PATH = ""  # 空 → 不同步到真剪映草稿目录

        self.mod = mod
        self.png = os.path.join(self.storage, "frame.png")
        with open(self.png, "wb") as f:
            f.write(_PNG_1X1)

    def tearDown(self):
        from app.core.config import settings
        settings.STORAGE_DIR, settings.EXPORTS_DIR, settings.JIANYIN_DRAFT_PATH = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def project(self, shots, **kw):
        from app.models.schemas import Project, Scene
        base = dict(id="pj_test", title="测试剧", original_novel="", style_preset="donghua_xianxia",
                    aspect_ratio="9:16", characters=[], scenes=[Scene(id="sc1", scene_index=1,
                    title="场1", location="测试", shots=shots)])
        base.update(kw)
        return Project(**base)

    def draft_json(self, result):
        with open(os.path.join(result["export_dir"], "draft_content.json"), encoding="utf-8") as f:
            return json.load(f)

    def segments_of(self, content, track_name):
        for track in content["tracks"]:
            if track.get("name") == track_name:
                return track["segments"]
        raise AssertionError(f"没有名为 {track_name} 的轨道：" +
                             str([t.get('name') for t in content['tracks']]))


class TestPlanSlot(unittest.TestCase):
    """纯时长规划：不依赖 pyJianYingDraft，先跑通再谈导出"""

    def setUp(self):
        from app.pipelines import jianyin_exporter as mod
        self.plan = mod.plan_slot

    def test_still_frame_extends_to_cover_audio(self):
        # 设计 1s、配音 5s、画面是静帧 → 槽位延长到 5s，配音不被腰斩
        got = self.plan(1_000_000, 10_800_000_000, True, 5_000_000)
        self.assertEqual(got, {"slot_us": 5_000_000, "pic_us": 5_000_000, "audio_us": 5_000_000})

    def test_video_is_not_frozen_and_clips_audio(self):
        # 视频只有 2s，设计 5s → 槽位 2s，配音裁到 2s
        got = self.plan(5_000_000, 2_000_000, False, 4_000_000)
        self.assertEqual(got["slot_us"], 2_000_000)
        self.assertEqual(got["audio_us"], 2_000_000)

    def test_video_longer_than_design_is_trimmed_not_extended(self):
        got = self.plan(3_000_000, 8_000_000, False, None)
        self.assertEqual(got["slot_us"], 3_000_000)

    def test_missing_picture_yields_slot_to_audio(self):
        got = self.plan(3_000_000, None, False, 2_500_000)
        self.assertEqual(got["slot_us"], 2_500_000)
        self.assertEqual(got["pic_us"], 0)

    def test_zero_length_slot_is_impossible(self):
        from app.pipelines.jianyin_exporter import MIN_SLOT_US
        got = self.plan(0, None, False, 0)
        self.assertGreaterEqual(got["slot_us"], MIN_SLOT_US)


class TestPathFence(unittest.TestCase):
    def test_static_urls_map_inside_storage(self):
        from app.pipelines.jianyin_exporter import _resolve_local_url
        with tempfile.TemporaryDirectory() as td:
            from app.core.config import settings
            saved = settings.STORAGE_DIR
            settings.STORAGE_DIR = td
            try:
                self.assertEqual(_resolve_local_url("/storage/a/b.png"),
                                 os.path.realpath(os.path.join(td, "a/b.png")))
            finally:
                settings.STORAGE_DIR = saved

    def test_traversal_is_rejected(self):
        from app.pipelines.jianyin_exporter import _resolve_local_url
        for bad in ("/storage/../../Windows/win.ini", "/storage//etc/passwd", "/exports/../secret.txt"):
            with self.assertRaises(ValueError, msg=bad):
                _resolve_local_url(bad)

    def test_unknown_prefix_returns_none(self):
        from app.pipelines.jianyin_exporter import _resolve_local_url
        self.assertIsNone(_resolve_local_url("/media/x.png"))


class TestAssetStore(_Sandbox):
    def test_data_url_is_written_with_parseable_extension(self):
        store = self.mod.AssetStore()
        url = "data:image/png;base64," + base64.b64encode(_PNG_1X1).decode()
        path = store.local_path(url, "video")
        self.assertTrue(path.endswith(".png"), path)
        self.assertTrue(os.path.exists(path))
        if not self.mod.HAS_PYJIANYING:
            self.skipTest("pyJianYingDraft 未安装：无法校验 VideoMaterial.material_type"
                          "（data URL 落盘与扩展名断言已通过）")
        self.assertEqual(self.mod.draft.VideoMaterial(path).material_type, "photo")

    def test_same_url_reuses_one_material_instance(self):
        store = self.mod.AssetStore()
        if self.mod.HAS_PYJIANYING:
            a = store.video_material("/storage/frame.png")
            b = store.video_material("/storage/frame.png")
        else:
            # pyJianYingDraft 未安装：用轻量替身仍验证「同一路径只造一个 material 实例」的自有去重契约；
            # material_type / duration 属引擎行为，无依赖时不做断言。
            from unittest import mock
            sentinel = object()
            with mock.patch.object(self.mod, "HAS_PYJIANYING", True), \
                    mock.patch.object(self.mod, "draft", create=True,
                                      new=mock.Mock(VideoMaterial=lambda path: sentinel)):
                a = store.video_material("/storage/frame.png")
                b = store.video_material("/storage/frame.png")
        self.assertIs(a, b)
        if self.mod.HAS_PYJIANYING:
            self.assertEqual(a.duration, 10_800_000_000)  # 静帧按 3h 计

    def test_missing_local_asset_raises_with_reason(self):
        store = self.mod.AssetStore()
        with self.assertRaises(FileNotFoundError):
            store.local_path("/storage/nope.png", "video")


@unittest.skipUnless(getattr(__import__("app.pipelines.jianyin_exporter", fromlist=["x"]),
                             "HAS_PYJIANYING", False), "pyJianYingDraft 未安装")
class TestDraftBuild(_Sandbox):

    def test_tracks_durations_and_skips_follow_real_assets(self):
        wav5 = "/storage/vo.wav"
        wav1 = "/storage/short.wav"
        _write_wav(os.path.join(self.storage, "vo.wav"), 5.0)
        _write_wav(os.path.join(self.storage, "short.wav"), 1.0)

        shots = [
            _shot(1, image_url="/storage/frame.png", audio_url=wav5, duration=1.0,
                  dialogue="长台词", subtitle_text="长台词"),          # 静帧延长到 5s
            _shot(2, image_url="/storage/frame.png", duration=1.5,
                  subtitle_text="无配音"),                              # 1.5s
            _shot(3, audio_url=wav1, duration=9.0, voiceover="只有旁白"),  # 无画面 → 1s
            _shot(4, duration=3.0),                                     # 什么都没有 → 跳过
        ]
        result = self.mod.jianyin_exporter.export_project_to_jianyin_draft(self.project(shots))

        self.assertEqual(result["tracks"], ["main_video", "dialogue", "captions"])
        self.assertEqual(result["video_segments"], 2)
        self.assertEqual(result["audio_segments"], 2)
        self.assertEqual(result["caption_segments"], 3)
        self.assertEqual(result["placed_shots"], 3)
        self.assertEqual([s["shot_index"] for s in result["skipped_shots"]], [4])
        self.assertEqual(result["duration_seconds"], 7.5)

        content = self.draft_json(result)
        video = self.segments_of(content, "main_video")
        audio = self.segments_of(content, "dialogue")
        text = self.segments_of(content, "captions")
        # 微秒口径：5s + 1.5s + 1s，且首尾相接无缝隙（无画面镜头不再让配音错位）
        self.assertEqual([s["target_timerange"] for s in video],
                         [{"start": 0, "duration": 5_000_000},
                          {"start": 5_000_000, "duration": 1_500_000}])
        self.assertEqual([s["target_timerange"] for s in audio],
                         [{"start": 0, "duration": 5_000_000},
                          {"start": 6_500_000, "duration": 1_000_000}])
        self.assertEqual(len(text), 3)
        self.assertEqual([s["target_timerange"]["start"] for s in text],
                         [0, 5_000_000, 6_500_000])
        # 素材去重：两张静帧复用同一份 material
        self.assertEqual(len(content["materials"]["videos"]), 1)
        self.assertEqual(len(content["materials"]["audios"]), 2)

        notes = {r["shot_index"]: r.get("notes", []) for r in result["report"]}
        self.assertIn("无画面，仅占配音时长", notes[3])
        self.assertTrue(any("跳过" in w for w in result["warnings"]))
        # 静帧按槽位伸缩是正常行为，不该被误报成"视频被裁掉"
        self.assertFalse([w for w in result["warnings"] if "超出该镜槽位" in w], result["warnings"])

    def test_bgm_only_when_bound_and_tiled_to_end(self):
        _write_wav(os.path.join(self.storage, "bgm.wav"), 2.0)
        shots = [_shot(1, image_url="/storage/frame.png", duration=5.0)]

        without = self.mod.jianyin_exporter.export_project_to_jianyin_draft(self.project(shots))
        self.assertNotIn("bgm", without["tracks"])
        self.assertFalse(without["bgm"]["bound"])

        with_bgm = self.mod.jianyin_exporter.export_project_to_jianyin_draft(
            self.project(shots, bgm_url="/storage/bgm.wav"))
        self.assertIn("bgm", with_bgm["tracks"])
        self.assertEqual(with_bgm["bgm"]["segments"], 3)  # 2s + 2s + 1s = 5s
        bgm = self.segments_of(self.draft_json(with_bgm), "bgm")
        self.assertEqual(sum(s["target_timerange"]["duration"] for s in bgm), 5_000_000)
        self.assertEqual([s["target_timerange"]["start"] for s in bgm], [0, 2_000_000, 4_000_000])

    def test_no_asset_project_fails_loudly(self):
        with self.assertRaises(self.mod.DraftExportError):
            self.mod.jianyin_exporter.export_project_to_jianyin_draft(
                self.project([_shot(1, duration=2.0)]))


class TestEngineGate(_Sandbox):
    """引擎缺失时必须显式失败并给出安装指引，而不是产出"看起来成功"的空工程"""

    def _project(self):
        return self.project([_shot(1, image_url="/storage/frame.png", duration=2.0)])

    def test_missing_engine_raises_draft_export_error_with_install_hint(self):
        from unittest import mock
        with mock.patch.object(self.mod, "HAS_PYJIANYING", False):
            with self.assertRaises(self.mod.DraftExportError) as ctx:
                self.mod.jianyin_exporter.export_project_to_jianyin_draft(self._project())
        self.assertIn("pip install", str(ctx.exception))

    def test_engine_status_matches_importability(self):
        import importlib.util
        status = self.mod.engine_status()
        self.assertIn("installed", status)
        self.assertEqual(status["installed"], importlib.util.find_spec("pyJianYingDraft") is not None)


class TestExportRoute(_Sandbox):
    def test_route_maps_engine_missing_to_503(self):
        from unittest import mock
        from fastapi.testclient import TestClient
        from app.main import app
        with mock.patch.object(self.mod, "HAS_PYJIANYING", False):
            client = TestClient(app)
            res = client.post("/api/v1/projects/export-jianyin", json=self._project().model_dump())
            self.assertEqual(res.status_code, 503)
            self.assertIn("剪映引擎未就绪", res.json()["detail"])
            got = client.get("/api/v1/projects/export-jianyin/engine")
        self.assertEqual(got.status_code, 200)
        self.assertFalse(got.json()["installed"])

    def _project(self):
        return self.project([_shot(1, image_url="/storage/frame.png", duration=2.0)])


if __name__ == "__main__":
    unittest.main()
