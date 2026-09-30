# -*- coding: utf-8 -*-
"""画布时间线节点·合片内核回归测试（stdlib unittest）。

运行： python -m unittest tests.test_timeline_merge -v

钉住四件事：
1. 片段校验是**宽容钳制 + 明确拒绝**：越界 in/out 钳到合法区间，非法路径/后缀/超限
   直接拒绝并给出可读原因，绝不把用户的随意输入拼进 ffmpeg 命令行；
2. 命令构造走 filter_complex（trim + concat），因为片段级入出点裁剪是产品需求
   的核心（concat demuxer 只能整文件首尾相连）；无音轨的片段必须补 anullsrc 静音，
   纯音频片段必须补黑色视频轨，否则 concat 会因流数不一致整体失败；
3. 所有输入路径必须落在 storage/exports 之内（realpath 后比对），拒绝 `..` 与库外绝对路径；
4. ffmpeg 缺失时给出可读错误并指向剪映草稿降级出口，而不是抛裸 FileNotFoundError。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _clip(url="/storage/videos/a.mp4", duration=5.0, cin=0.0, cout=5.0, kind="video", name="a.mp4"):
    return {"id": "c1", "url": url, "name": name, "duration": duration,
            "in": cin, "out": cout, "kind": kind}


class _Sandbox(unittest.TestCase):
    """把 STORAGE_DIR / EXPORTS_DIR 搬进临时目录，绝不碰用户真数据。"""

    def setUp(self):
        from app.core.config import settings
        self.root = tempfile.mkdtemp(prefix="tl_merge_test_")
        self.storage = os.path.join(self.root, "storage")
        self.exports = os.path.join(self.root, "exports")
        os.makedirs(os.path.join(self.storage, "videos"), exist_ok=True)
        os.makedirs(self.exports, exist_ok=True)
        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = self.exports
        for rel in ("videos/a.mp4", "videos/b.mp4", "videos/c.mov", "audio/bgm.mp3"):
            target = os.path.join(self.storage, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(b"\x00")
        self.out = os.path.join(self.exports, "out.mp4")

    def tearDown(self):
        from app.core.config import settings
        settings.STORAGE_DIR, settings.EXPORTS_DIR = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def mod(self):
        from app.media import timeline_merge
        return timeline_merge

    def norm(self, clips):
        return self.mod().normalize_clips(clips)


class TestNormalizeClips(_Sandbox):
    """片段规整：宽容钳制 + 明确拒绝。"""

    def test_empty_clips_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([])
        self.assertIn("片段", str(ctx.exception))

    def test_out_beyond_duration_is_clamped(self):
        got = self.norm([_clip(duration=5.0, cin=1.0, cout=99.0)])
        self.assertEqual(got[0]["in"], 1.0)
        self.assertEqual(got[0]["out"], 5.0)

    def test_negative_in_is_clamped_to_zero(self):
        got = self.norm([_clip(duration=5.0, cin=-3.0, cout=2.0)])
        self.assertEqual(got[0]["in"], 0.0)
        self.assertEqual(got[0]["out"], 2.0)

    def test_clip_shorter_than_minimum_after_trim_is_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip(duration=5.0, cin=3.0, cout=3.05)])
        self.assertIn("过短", str(ctx.exception))

    def test_unknown_duration_clip_gives_readable_reason(self):
        # 前端还没探测到时长（链接失效 / 格式不受支持）时，必须点明「时长未知」，
        # 而不是笼统报「裁剪后过短」让用户去调入出点
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip(duration=0.0, cin=0.0, cout=0.0)])
        self.assertIn("时长未知", str(ctx.exception))

    def test_clip_without_url_is_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip(url="")])
        self.assertIn("url", str(ctx.exception))

    def test_too_many_clips_rejected(self):
        limit = self.mod().MAX_CLIPS
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip() for _ in range(limit + 1)])
        self.assertIn("上限", str(ctx.exception))

    def test_total_duration_limit_rejected(self):
        one = self.mod().MAX_TOTAL_SECONDS / 2 + 10
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip(duration=one, cout=one), _clip(duration=one, cout=one)])
        self.assertIn("总时长", str(ctx.exception))

    def test_missing_file_on_disk_is_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.norm([_clip(url="/storage/videos/ghost.mp4")])
        self.assertIn("不存在", str(ctx.exception))

    def test_kind_is_normalized_to_video_or_audio(self):
        got = self.norm([_clip(url="/storage/audio/bgm.mp3", kind="audio", duration=3.0, cout=3.0)])
        self.assertEqual(got[0]["kind"], "audio")


class TestStaticPathFor(_Sandbox):
    """路径围栏：只认 storage/exports 内的相对 URL。"""

    def test_storage_url_maps_inside_storage(self):
        got = self.mod().static_path_for("/storage/videos/a.mp4")
        self.assertEqual(os.path.realpath(got), os.path.realpath(os.path.join(self.storage, "videos/a.mp4")))

    def test_parent_traversal_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError):
            self.mod().static_path_for("/storage/../../secret.mp4")

    def test_absolute_path_outside_roots_rejected(self):
        outside = os.path.join(self.root, "outside.mp4")
        with open(outside, "wb") as f:
            f.write(b"\x00")
        with self.assertRaises(self.mod().TimelineMergeError):
            self.mod().static_path_for(outside)

    def test_http_url_rejected_by_static_resolver(self):
        with self.assertRaises(self.mod().TimelineMergeError):
            self.mod().static_path_for("https://example.com/a.mp4")

    def test_disallowed_extension_rejected(self):
        with self.assertRaises(self.mod().TimelineMergeError) as ctx:
            self.mod().static_path_for("/storage/videos/a.txt")
        self.assertIn("后缀", str(ctx.exception))


class TestBuildCommand(_Sandbox):
    """命令构造：trim + concat，缺音轨补静音，纯音频补黑场。"""

    def _cmd(self, clips, probes, aspect_ratio="9:16"):
        return self.mod().build_ffmpeg_command(clips, probes, self.out, aspect_ratio=aspect_ratio)

    def test_trims_and_concats_two_video_clips(self):
        clips = self.norm([
            _clip(url="/storage/videos/a.mp4", duration=5.0, cin=1.0, cout=3.0),
            _clip(url="/storage/videos/b.mp4", duration=5.0, cin=0.0, cout=2.0),
        ])
        probes = [{"has_video": True, "has_audio": True}, {"has_video": True, "has_audio": True}]
        cmd = self._cmd(clips, probes)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("trim=start=1:end=3", graph)
        self.assertIn("atrim=start=1:end=3", graph)
        self.assertIn("concat=n=2:v=1:a=1", graph)
        self.assertIn("[vo]", cmd)
        self.assertIn("[ao]", cmd)
        self.assertIn("libx264", cmd)
        self.assertIn("aac", cmd)
        self.assertEqual(cmd[cmd.index("-y")], "-y")

    def test_silent_audio_injected_when_source_has_no_audio(self):
        clips = self.norm([_clip(url="/storage/videos/a.mp4", duration=2.0, cout=2.0)])
        probes = [{"has_video": True, "has_audio": False}]
        cmd = self._cmd(clips, probes)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("anullsrc", " ".join(cmd))
        self.assertIn("concat=n=1:v=1:a=1", graph)

    def test_audio_only_clip_gets_black_video_track(self):
        clips = self.norm([_clip(url="/storage/audio/bgm.mp3", kind="audio", duration=4.0, cout=4.0)])
        probes = [{"has_video": False, "has_audio": True}]
        cmd = self._cmd(clips, probes)
        joined = " ".join(cmd)
        self.assertIn("color=c=black", joined)
        self.assertIn("concat=n=1:v=1:a=1", cmd[cmd.index("-filter_complex") + 1])

    def test_all_inputs_are_normalized_to_same_size(self):
        clips = self.norm([
            _clip(url="/storage/videos/a.mp4"),
            _clip(url="/storage/videos/c.mov"),
        ])
        probes = [{"has_video": True, "has_audio": False}] * 2
        cmd = self._cmd(clips, probes)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertEqual(graph.count("scale=1080:1920"), 2)
        self.assertEqual(graph.count("setsar=1"), 2)

    def test_output_extension_is_mp4(self):
        clips = self.norm([_clip()])
        cmd = self._cmd(clips, [{"has_video": True, "has_audio": True}])
        self.assertTrue(cmd[-1].endswith(".mp4"))


class TestOutputSize(_Sandbox):
    """成片画幅必须跟着项目画幅走，否则竖屏项目会导出成横屏黑边片。"""

    def test_output_size_follows_aspect_ratio(self):
        output_size = self.mod().output_size
        self.assertEqual(output_size("9:16"), (1080, 1920))
        self.assertEqual(output_size("16:9"), (1920, 1080))
        self.assertEqual(output_size("1:1"), (1080, 1080))
        self.assertEqual(output_size(None), (1920, 1080))


class TestEngineStatus(_Sandbox):
    """引擎自检：ffmpeg 在位与否要能被前端读到，并带安装指引。"""

    def test_reports_available_when_ffmpeg_present(self):
        with mock.patch.object(self.mod().shutil, "which", return_value="C:/ffmpeg.exe"):
            st = self.mod().engine_status()
        self.assertTrue(st["ffmpeg"])
        self.assertTrue(st["available"])

    def test_reports_unavailable_with_hint_when_ffmpeg_missing(self):
        with mock.patch.object(self.mod().shutil, "which", return_value=None):
            st = self.mod().engine_status()
        self.assertFalse(st["ffmpeg"])
        self.assertFalse(st["available"])
        self.assertTrue(st["ffmpeg_hint"])


class TestMergeClips(_Sandbox):
    """合成入口：ffmpeg 缺失必须是可读错误 + 降级建议，而不是裸异常。"""

    def test_merge_without_ffmpeg_raises_readable_error(self):
        clips = self.norm([_clip()])
        with mock.patch.object(self.mod().shutil, "which", return_value=None):
            with self.assertRaises(self.mod().TimelineMergeError) as ctx:
                asyncio.run(self.mod().merge_clips(clips, self.out))
        msg = str(ctx.exception)
        self.assertIn("ffmpeg", msg)
        self.assertIn("剪映", msg)
        self.assertFalse(os.path.exists(self.out))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "本机没有 ffmpeg/ffprobe")
class TestMergeEndToEnd(_Sandbox):
    """真 ffmpeg 端到端：真素材、真裁剪、真落盘，断言时长与流构成。

    刻意用一条「有音轨」+ 一条「无音轨」的素材，正是为了让 anullsrc 静音补轨这条
    分支被真实执行到（ComfyUI 兜底生成的 mp4 就是无音轨的）。
    """

    def _make(self, name, seconds, with_audio):
        out = os.path.join(self.storage, "videos", name)
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
               "-f", "lavfi", "-t", str(seconds), "-i", "testsrc=size=320x240:rate=10"]
        if with_audio:
            cmd += ["-f", "lavfi", "-t", str(seconds), "-i", "sine=frequency=440:sample_rate=44100"]
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
        if with_audio:
            cmd += ["-c:a", "aac", "-shortest"]
        cmd += [out]
        import subprocess
        subprocess.run(cmd, check=True, capture_output=True)
        return f"/storage/videos/{name}"

    def test_merges_trimmed_clips_into_single_mp4(self):
        url_a = self._make("e2e_a.mp4", 2.0, with_audio=True)
        url_b = self._make("e2e_b.mp4", 2.0, with_audio=False)
        clips = self.norm([
            {"id": "a", "url": url_a, "name": "a", "duration": 2.0, "in": 0.5, "out": 1.5, "kind": "video"},
            {"id": "b", "url": url_b, "name": "b", "duration": 2.0, "in": 0.0, "out": 1.0, "kind": "video"},
        ])
        result = asyncio.run(self.mod().merge_clips(clips, self.out, aspect_ratio="16:9"))

        self.assertTrue(os.path.exists(result["output_path"]))
        self.assertGreater(result["size_bytes"], 1000)
        self.assertEqual(result["clips"], 2)
        self.assertAlmostEqual(result["duration"], 2.0, places=2)

        info = asyncio.run(self.mod().probe_media(result["output_path"]))
        self.assertTrue(info["has_video"], "成片必须含视频轨")
        self.assertTrue(info["has_audio"], "无音轨素材必须被补上静音轨")
        self.assertAlmostEqual(info["duration"], 2.0, delta=0.4)

    def test_merge_works_under_selector_event_loop(self):
        """回归：uvicorn 在 Windows 上给的是 Selector 事件循环，而
        `asyncio.create_subprocess_exec` 在 Selector 循环上直接抛 NotImplementedError
        （真机就是这样挂的：任务提交成功、轮询结果却是 `NotImplementedError: `）。
        合片必须走线程里的同步 subprocess，不能被事件循环实现绑死。"""
        url = self._make("e2e_selector.mp4", 1.0, with_audio=False)
        clips = self.norm([
            {"id": "a", "url": url, "name": "s", "duration": 1.0, "in": 0, "out": 1.0, "kind": "video"},
        ])
        loop = asyncio.SelectorEventLoop()
        try:
            asyncio.set_event_loop(loop)
            result = loop.run_until_complete(self.mod().merge_clips(clips, self.out))
        finally:
            loop.close()
            asyncio.set_event_loop(None)
        self.assertTrue(os.path.exists(result["output_path"]))
        self.assertGreater(result["size_bytes"], 1000)

    def test_url_and_duration_reported_for_frontend(self):
        url_a = self._make("e2e_c.mp4", 1.0, with_audio=False)
        clips = self.norm([
            {"id": "a", "url": url_a, "name": "c", "duration": 1.0, "in": 0.0, "out": 1.0, "kind": "video"},
        ])
        result = asyncio.run(self.mod().merge_clips(clips, self.out))
        self.assertTrue(result["output_url"].endswith(".mp4"))
        self.assertTrue(result["output_url"].startswith("/exports/"))


if __name__ == "__main__":
    unittest.main()
