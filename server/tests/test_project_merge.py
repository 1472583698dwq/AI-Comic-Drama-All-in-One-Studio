# -*- coding: utf-8 -*-
"""项目多轨时间线 → MP4 回归测试。

运行：python -m unittest tests.test_project_merge -v

钉住三件事：
1. 镜头规整：空分镜/超限/非法路径明确拒绝，缺画面留给合成阶段输出黑场并给出提示；
2. 命令构造：主画面轨 concat、视频不足补帧、静帧拉长、黑场占位、配音延迟混音、
   BGM 循环平铺、字幕烧录与关闭字幕两条分支都在命令里；
3. 真机端到端：有 ffmpeg 时实际产出一条带音轨的 MP4（无 ffmpeg 自动 skip）。
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _shot(**patch):
    data = {
        "id": "s1",
        "shot_index": 1,
        "duration": 2.0,
        "video_url": "/storage/videos/a.mp4",
        "image_url": "",
        "audio_url": "",
        "audio_duration": 0,
        "subtitle_text": "",
        "dialogue": "",
        "voiceover": "",
    }
    data.update(patch)
    return data


class _Sandbox(unittest.TestCase):
    def setUp(self):
        from app.core.config import settings
        self.root = tempfile.mkdtemp(prefix="tl_project_test_")
        self.storage = os.path.join(self.root, "storage")
        self.exports = os.path.join(self.root, "exports")
        os.makedirs(os.path.join(self.storage, "videos"), exist_ok=True)
        os.makedirs(os.path.join(self.storage, "images"), exist_ok=True)
        os.makedirs(os.path.join(self.storage, "audio"), exist_ok=True)
        os.makedirs(self.exports, exist_ok=True)
        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = self.exports
        for rel in ("videos/a.mp4", "videos/b.mp4", "images/a.png", "audio/a.mp3", "audio/bgm.mp3"):
            with open(os.path.join(self.storage, rel), "wb") as fh:
                fh.write(b"\x00")
        self.out = os.path.join(self.exports, "timeline", "out.mp4")
        os.makedirs(os.path.dirname(self.out), exist_ok=True)

    def tearDown(self):
        from app.core.config import settings
        settings.STORAGE_DIR, settings.EXPORTS_DIR = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def mod(self):
        from app.media import project_merge
        return project_merge

    def norm(self, shots):
        return self.mod().normalize_project_shots(shots)


class TestNormalize(_Sandbox):
    def test_empty_shots_rejected(self):
        with self.assertRaises(Exception) as ctx:
            self.norm([])
        self.assertIn("没有可导出的分镜", str(ctx.exception))

    def test_duration_falls_back_to_audio_then_default(self):
        shots, _ = self.norm([
            _shot(duration=0, audio_duration=4.2, video_url="", subtitle_text="字幕"),
            _shot(duration=0, audio_duration=0, video_url="", subtitle_text="字幕"),
        ])
        self.assertEqual(shots[0]["duration"], 4.2)
        self.assertEqual(shots[1]["duration"], 3.5)

    def test_short_duration_is_clamped_to_minimum(self):
        shots, _ = self.norm([_shot(duration=0.1)])
        self.assertEqual(shots[0]["duration"], self.mod().MIN_SHOT_SECONDS)

    def test_dialogue_voiceover_and_speaker_are_preserved_for_tts(self):
        shots, _ = self.norm([
            _shot(dialogue="台词", voiceover="旁白", speaker_name="甲", emotion="angry"),
        ])
        self.assertEqual(shots[0]["dialogue"], "台词")
        self.assertEqual(shots[0]["voiceover"], "旁白")
        self.assertEqual(shots[0]["speaker_name"], "甲")
        self.assertEqual(shots[0]["emotion"], "angry")

    def test_subtitle_falls_back_to_dialogue_and_voiceover(self):
        shots, _ = self.norm([
            _shot(subtitle_text="", dialogue="台词"),
            _shot(subtitle_text="", dialogue="", voiceover="旁白"),
        ])
        self.assertEqual(shots[0]["subtitle"], "台词")
        self.assertEqual(shots[1]["subtitle"], "旁白")

    def test_too_many_shots_rejected(self):
        limit = self.mod().MAX_SHOTS
        with self.assertRaises(Exception) as ctx:
            self.norm([_shot() for _ in range(limit + 1)])
        self.assertIn("上限", str(ctx.exception))

    def test_total_duration_limit_rejected(self):
        with self.assertRaises(Exception) as ctx:
            self.norm([_shot(duration=600) for _ in range(4)])
        self.assertIn("总时长", str(ctx.exception))

    def test_unsupported_local_picture_ext_falls_back_to_image(self):
        shots, warnings = self.norm([
            _shot(video_url="/storage/videos/a.txt", image_url="/storage/images/a.png"),
        ])
        self.assertEqual(shots[0]["picture_kind"], "image")
        self.assertTrue(any("后缀不支持" in warning for warning in warnings))

    def test_no_media_anywhere_is_rejected(self):
        with self.assertRaises(Exception) as ctx:
            self.norm([_shot(video_url="", image_url="", audio_url="")])
        self.assertIn("没有可导出", str(ctx.exception))

    def test_local_path_traversal_rejected(self):
        with self.assertRaises(Exception):
            self.mod()._local_path("/storage/../../secret.mp4", "video")

    def test_local_path_outside_roots_rejected(self):
        outside = os.path.join(self.root, "outside.mp4")
        with open(outside, "wb") as fh:
            fh.write(b"\x00")
        with self.assertRaises(Exception):
            self.mod()._local_path(outside, "video")


class TestBuildCommand(_Sandbox):
    def _resolved(self):
        return [
            {
                "duration": 2.0,
                "picture_path": "/storage/videos/a.mp4",
                "picture_kind": "video",
                "audio_path": "/storage/audio/a.mp3",
                "audio_duration": 1.5,
                "subtitle": "第一镜",
            },
            {
                "duration": 1.5,
                "picture_path": "/storage/images/a.png",
                "picture_kind": "image",
                "audio_path": None,
                "audio_duration": 0,
                "subtitle": "",
            },
            {
                "duration": 1.0,
                "picture_path": None,
                "picture_kind": None,
                "audio_path": None,
                "audio_duration": 0,
                "subtitle": "第三镜",
            },
        ]

    def test_video_concat_and_black_fallback(self):
        cmd = self.mod().build_project_command(self._resolved(), self.out, aspect_ratio="9:16")
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("concat=n=3:v=1:a=0[vo]", graph)
        self.assertIn("tpad=stop_mode=clone", graph)
        self.assertIn("color=c=black:s=1080x1920", " ".join(cmd))
        self.assertIn("scale=1080:1920", graph)
        self.assertIn("adelay=0:all=1", graph)
        self.assertIn("amix=inputs=2:duration=first", graph)
        self.assertIn("[vo]", cmd)
        self.assertIn("[abase]", graph)
        self.assertIn("libx264", cmd)
        self.assertIn("aac", cmd)
        self.assertEqual(cmd[cmd.index("-t") + 1], "4.5")

    def test_video_original_audio_is_mixed_when_no_voice(self):
        shots = [{
            "duration": 2.0,
            "picture_path": "/storage/videos/a.mp4",
            "picture_kind": "video",
            "video_audio": True,
            "video_audio_duration": 2.0,
            "audio_path": None,
            "audio_duration": 0,
            "subtitle": "",
        }]
        cmd = self.mod().build_project_command(shots, self.out)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("[1:a]atrim=start=0:end=2", graph)
        self.assertIn("adelay=0:all=1[va0]", graph)
        self.assertIn("[abase][va0]amix=inputs=2", graph)

    def test_bgm_and_subtitles_are_wired(self):
        cmd = self.mod().build_project_command(
            self._resolved(),
            self.out,
            bgm_path="/storage/audio/bgm.mp3",
            bgm_volume=0.35,
            subtitle_file="subs.ass",
        )
        graph = cmd[cmd.index("-filter_complex") + 1]
        joined = " ".join(cmd)
        self.assertIn("-stream_loop", cmd)
        self.assertIn("volume=0.35", graph)
        self.assertIn("amix=inputs=3:duration=first:dropout_transition=0:normalize=0", graph)
        self.assertIn("subtitles=filename=subs.ass:wrap_unicode=1[vout]", graph)
        self.assertIn("[vout]", joined)
        self.assertIn("-map", cmd)

    def test_without_subtitles_maps_concatenated_video(self):
        cmd = self.mod().build_project_command(self._resolved(), self.out)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertNotIn("subtitles=", graph)
        self.assertIn("[vo]", cmd)
        self.assertNotIn("vout", graph)

    def test_ass_contains_dialogue_timings(self):
        ass = self.mod().build_ass(self._resolved(), 1080, 1920)
        self.assertIn("PlayResX: 1080", ass)
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:02.00", ass)
        self.assertIn("Dialogue: 0,0:00:03.50,0:00:04.50", ass)
        self.assertNotIn("第二镜", ass)


    def test_subtitle_layout_scales_with_frame(self):
        layout = self.mod().subtitle_layout(1080, 1920)
        self.assertEqual(layout["font_size"], 65)
        self.assertEqual(layout["margin_lr"], 65)
        self.assertEqual(layout["margin_v"], 115)
        wide = self.mod().subtitle_layout(1920, 1080)
        self.assertEqual(wide["font_size"], 65)
        self.assertGreater(wide["max_units"], layout["max_units"])

    def test_long_subtitle_wraps_within_frame_width(self):
        text = "\u88ab\u88c1\u7b2c47\u5929\uff0c\u6211\u6446\u4e86\u8fd9\u4e2a\u644a\u3002\u8fd9\u662f\u4e00\u884c\u5f88\u957f\u7684\u5b57\u5e55\u7528\u6765\u6d4b\u8bd5\u81ea\u52a8\u6362\u884c\u548c\u753b\u5e45\u9002\u914d\u3002"
        ass = self.mod().build_ass([{"duration": 2.0, "subtitle": text}], 1080, 1920)
        dialogue = next(line for line in ass.splitlines() if line.startswith("Dialogue:"))
        body = dialogue.rsplit(",,", 1)[1]
        max_units = self.mod().subtitle_layout(1080, 1920)["max_units"]
        self.assertIn("\\N", body)
        for line in body.split("\\N"):
            self.assertLessEqual(sum(self.mod()._char_units(ch) for ch in line), max_units + 0.01)


class TestAudioGuard(_Sandbox):
    def test_silent_export_rejected_when_no_audio_and_not_allowed(self):
        from app.media import project_merge
        shots, _ = self.norm([
            _shot(duration=1.0, video_url="", image_url="/storage/images/a.png", subtitle_text="字幕"),
        ])
        with mock.patch.object(project_merge.tm, "has_binary", return_value=True):
            with self.assertRaises(Exception) as ctx:
                asyncio.run(project_merge.merge_project_shots(shots, self.out))
        self.assertIn("没有可混入的音频", str(ctx.exception))
        self.assertFalse(os.path.exists(self.out))


@unittest.skipUnless(
    shutil.which("ffmpeg"),
    "本机没有 ffmpeg，跳过真机端到端：请安装 ffmpeg 后重跑",
)
class TestProjectMergeEndToEnd(_Sandbox):
    def test_video_original_audio_is_audible_in_output(self):
        video = os.path.join(self.storage, "videos", "with_audio.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-t", "0.8", "-i", "testsrc=size=160x120:rate=10",
             "-f", "lavfi", "-t", "0.8", "-i", "sine=frequency=660:sample_rate=44100",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video],
            check=True, capture_output=True,
        )
        shots, _ = self.norm([
            _shot(duration=0.8, video_url="/storage/videos/with_audio.mp4", subtitle_text="原声"),
        ])
        result = asyncio.run(self.mod().merge_project_shots(shots, self.out, aspect_ratio="16:9"))
        self.assertGreater(result["video_audio_tracks"], 0)
        probe = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", result["output_path"], "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        self.assertIn("max_volume:", probe.stderr)
        max_line = next(line for line in probe.stderr.splitlines() if "max_volume:" in line)
        max_db = float(max_line.split("max_volume:")[1].strip().split()[0])
        self.assertGreater(max_db, -60.0, max_line)

    def test_merge_produces_mp4_with_audio(self):
        video = os.path.join(self.storage, "videos", "real.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-t", "0.8", "-i", "testsrc=size=160x120:rate=10",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
            check=True, capture_output=True,
        )
        image = os.path.join(self.storage, "images", "real.png")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", "color=c=blue:s=120x160:r=1", "-frames:v", "1", image],
            check=True, capture_output=True,
        )
        voice = os.path.join(self.storage, "audio", "real.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-t", "0.7", "-i", "sine=frequency=660:sample_rate=44100",
             "-c:a", "libmp3lame", voice],
            check=True, capture_output=True,
        )
        shots, _ = self.norm([
            _shot(duration=0.8, video_url="/storage/videos/real.mp4", audio_url="/storage/audio/real.mp3",
                  subtitle_text="第一镜字幕"),
            _shot(shot_index=2, duration=0.7, video_url="", image_url="/storage/images/real.png",
                  audio_url="", subtitle_text="第二镜字幕"),
        ])
        result = asyncio.run(self.mod().merge_project_shots(
            shots,
            self.out,
            aspect_ratio="9:16",
            bgm_url="/storage/audio/real.mp3",
            bgm_volume=0.2,
            subtitles=True,
        ))
        self.assertTrue(os.path.exists(result["output_path"]))
        self.assertGreater(result["size_bytes"], 1000)
        self.assertAlmostEqual(result["duration"], 1.5, places=2)
        self.assertTrue(result["subtitles"])
        from app.media import timeline_merge
        info = asyncio.run(timeline_merge.probe_media(result["output_path"]))
        self.assertTrue(info.get("has_video"))
        self.assertTrue(info.get("has_audio"))


if __name__ == "__main__":
    unittest.main()
