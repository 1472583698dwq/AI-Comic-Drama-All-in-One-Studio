# -*- coding: utf-8 -*-
"""时间线路由链路测试（stdlib unittest + fastapi TestClient）。

运行： python -m unittest tests.test_timeline_routes -v

钉住五件事：
1. 提交口是「先校验后排队」：片段非法当场 400，不把错误塞进异步任务里让前端轮询才发现；
2. ffmpeg 未就绪时提交口给 503 + 安装指引（而不是 500 裸异常）—— 这条用 mock 伪造引擎缺失，
   **不依赖本机真装 ffmpeg**，因此在没有 ffmpeg 的机器上也能验证「提醒安装」；
3. 长任务链路真能跑通：提交拿 task_id → 轮询到 success → 产物落在 exports/ 下且可被 URL 取回；
4. 输出命名避让：同秒同名提交必须依次拿到 `(1)`、`(2)`，且占位文件真实落盘；
5. 降级出口 `/timeline/draft` 与提交闸门：草稿桥接透传参数、引擎不可用 503、超出并发额度 429。

**缺 ffmpeg 时怎么办**：只有第 3、4 类里的真机端到端会被 skip（reason 里带安装指引），
其余用例全部照跑。装 ffmpeg：`conda install -c conda-forge ffmpeg`，
或下载官方构建后把 bin 目录加入系统 PATH，然后重启服务。
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.timeline_routes import router  # noqa: E402

API = "/api/v1"


def _client():
    app = FastAPI()
    app.include_router(router, prefix=API)
    return TestClient(app)


class TestTimelineRoutes(unittest.TestCase):

    def setUp(self):
        from app.core.config import settings
        self.root = tempfile.mkdtemp(prefix="tl_routes_test_")
        self.storage = os.path.join(self.root, "storage")
        self.exports = os.path.join(self.root, "exports")
        os.makedirs(os.path.join(self.storage, "videos"), exist_ok=True)
        os.makedirs(self.exports, exist_ok=True)
        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = self.exports
        self.client = _client()

    def tearDown(self):
        from app.core.config import settings
        settings.STORAGE_DIR, settings.EXPORTS_DIR = self._saved
        shutil.rmtree(self.root, ignore_errors=True)

    def _make_clip(self, name, seconds):
        out = os.path.join(self.storage, "videos", name)
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-t", str(seconds), "-i", "testsrc=size=160x120:rate=10",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", out],
            check=True, capture_output=True,
        )
        return f"/storage/videos/{name}"

    def _fake_clip(self, name):
        """写一个不依赖 ffmpeg 的假素材文件（只为过路径围栏与存在性），返回其静态 URL。"""
        path = os.path.join(self.storage, "videos", name)
        with open(path, "wb") as f:
            f.write(b"\x00" * 1024)
        return f"/storage/videos/{name}"

    def _clip_payload(self, url, seconds):
        return {"id": url, "url": url, "name": os.path.basename(url),
                "duration": seconds, "in": 0, "out": seconds, "kind": "video"}

    # ── 引擎自检 ──
    def test_engine_endpoint_reports_ffmpeg_and_hints(self):
        res = self.client.get(f"{API}/timeline/engine")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        for key in ("ffmpeg", "ffprobe", "jianyin", "available", "ffmpeg_hint", "draft_hint"):
            self.assertIn(key, body)

    # ── 提交口校验 ──
    def test_empty_clips_rejected_with_400(self):
        res = self.client.post(f"{API}/timeline/merge", json={"clips": []})
        self.assertEqual(res.status_code, 400)
        self.assertIn("片段", res.json()["detail"])

    def test_path_outside_storage_rejected_with_400(self):
        outside = os.path.join(self.root, "outside.mp4")
        with open(outside, "wb") as f:
            f.write(b"\x00")
        res = self.client.post(f"{API}/timeline/merge",
                               json={"clips": [self._clip_payload(outside, 2.0)]})
        self.assertEqual(res.status_code, 400)
        self.assertIn("storage", res.json()["detail"])

    def test_unknown_task_returns_404(self):
        res = self.client.get(f"{API}/timeline/tasks/tl_not_exist")
        self.assertEqual(res.status_code, 404)

    def test_merge_without_ffmpeg_returns_503_with_install_hint(self):
        """ffmpeg 缺失 → 503 + 安装指引。

        用假字节素材（不调 ffmpeg）造片段、mock `has_binary` 伪造引擎缺失：
        这样「提醒安装」这条路径在任何机器上都能验证，不会因为本机没装 ffmpeg 而 ERROR。
        """
        from app.media import timeline_merge
        url = self._fake_clip("nomedia.mp4")
        with mock.patch.object(timeline_merge, "has_binary", return_value=False):
            res = self.client.post(f"{API}/timeline/merge",
                                   json={"clips": [self._clip_payload(url, 1.0)]})
        self.assertEqual(res.status_code, 503)
        detail = res.json()["detail"]
        self.assertIn("ffmpeg", detail)
        self.assertIn("conda install", detail)   # 安装指引必须真的落到用户看到的文案里
        self.assertIn("PATH", detail)
        self.assertIn("剪映", detail)            # 同时给出降级出口

    def test_engine_status_without_ffmpeg_carries_install_hint(self):
        from app.media import timeline_merge
        with mock.patch.object(timeline_merge, "has_binary", return_value=False):
            body = self.client.get(f"{API}/timeline/engine").json()
        self.assertFalse(body["available"])
        self.assertIn("conda install", body["ffmpeg_hint"])
        self.assertIn("剪映", body["draft_hint"])

    # ── 全链路（唯一需要真 ffmpeg 的用例） ──
    @unittest.skipUnless(
        shutil.which("ffmpeg"),
        "本机没有 ffmpeg，跳过真机端到端：请 `conda install -c conda-forge ffmpeg`，"
        "或下载官方构建后把 bin 目录加入系统 PATH，再重启服务重跑",
    )
    def test_merge_task_runs_to_success_and_lands_in_exports(self):
        url_a = self._make_clip("rt_a.mp4", 1.0)
        url_b = self._make_clip("rt_b.mp4", 1.0)
        with _client() as client:
            res = client.post(f"{API}/timeline/merge", json={
                "clips": [self._clip_payload(url_a, 1.0), self._clip_payload(url_b, 1.0)],
                "title": "路由冒烟",
                "aspect_ratio": "16:9",
            })
            self.assertEqual(res.status_code, 200)
            task_id = res.json()["task_id"]
            self.assertTrue(task_id.startswith("tl_"))

            body = {}
            for _ in range(120):
                body = client.get(f"{API}/timeline/tasks/{task_id}").json()
                if body.get("status") in ("success", "error"):
                    break
                time.sleep(0.25)

        self.assertEqual(body.get("status"), "success", body.get("error"))
        self.assertTrue(body["output_url"].startswith("/exports/"))
        self.assertTrue(os.path.exists(body["output_path"]))
        self.assertGreater(body["size_bytes"], 1000)


class _IsolatedTimelineTest(unittest.TestCase):
    """共用脚手架：把 STORAGE_DIR/EXPORTS_DIR 指到临时目录，并提供一个最小 app。"""

    def setUp(self):
        from app.core.config import settings
        from app.api import timeline_routes as routes
        self.root = tempfile.mkdtemp(prefix="tl_routes_test_")
        self.storage = os.path.join(self.root, "storage")
        self.exports = os.path.join(self.root, "exports")
        os.makedirs(os.path.join(self.storage, "videos"), exist_ok=True)
        os.makedirs(self.exports, exist_ok=True)
        self._saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
        settings.STORAGE_DIR = self.storage
        settings.EXPORTS_DIR = self.exports
        # 计数器与任务表是跨用例共享的模块级全局态：每个用例从干净状态开始
        routes._merge_running = 0
        routes._merge_inflight = 0
        routes._TASKS.clear()
        self.client = _client()

    def tearDown(self):
        from app.core.config import settings
        from app.api import timeline_routes as routes
        settings.STORAGE_DIR, settings.EXPORTS_DIR = self._saved
        routes._merge_running = 0
        routes._merge_inflight = 0
        routes._TASKS.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def _fake_clip(self, name):
        with open(os.path.join(self.storage, "videos", name), "wb") as f:
            f.write(b"\x00" * 1024)
        return f"/storage/videos/{name}"

    @staticmethod
    def _clip_payload(url, seconds):
        return {"id": url, "url": url, "name": os.path.basename(url),
                "duration": seconds, "in": 0, "out": seconds, "kind": "video"}


class TestOutputNaming(_IsolatedTimelineTest):
    """输出命名：同秒同名必须让位成 (1)(2)，且非法名称不得逃出导出目录（不依赖 ffmpeg）。"""

    def test_duplicate_names_get_numbered_suffix(self):
        """同一秒反复导出同一项目：第二个必须是 `(1)`，第三个 `(2)`，且占位文件真实落盘。

        「真实落盘」是这条防线的关键：只靠 exists 检查会有竞态窗口，占位是独占创建的凭据。
        """
        from app.api import timeline_routes as routes
        first = routes._reserve_output_path(None, "同名项目")
        second = routes._reserve_output_path(None, "同名项目")
        third = routes._reserve_output_path(None, "同名项目")
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, third)
        self.assertTrue(second.endswith("(1).mp4"), second)
        self.assertTrue(third.endswith("(2).mp4"), third)
        for path in (first, second, third):
            self.assertTrue(os.path.exists(path), f"占位文件必须已创建：{path}")

    def test_safe_name_strips_traversal_and_illegal_chars(self):
        from app.api import timeline_routes as routes
        for raw in ("../../etc/passwd", r"..\..\windows\system32\cmd", 'a:b*c?d"e<f>g|h', "  ....  "):
            name = routes._safe_name(raw, None)
            self.assertEqual(os.path.basename(name), name, name)
            self.assertNotIn("/", name)
            self.assertNotIn("\\", name)
            self.assertTrue(name.lower().endswith(".mp4"), name)

    def test_reserved_path_never_escapes_exports_dir(self):
        from app.api import timeline_routes as routes
        from app.core.config import settings
        path = routes._reserve_output_path("../../escape", "../../escape")
        root = os.path.realpath(settings.EXPORTS_DIR)
        self.assertEqual(os.path.commonpath([os.path.realpath(path), root]), root)
        self.assertTrue(os.path.exists(path))


class TestDraftRoute(_IsolatedTimelineTest):
    """降级出口：参数透传 + 引擎不可用 503（mock 掉剪映引擎，不依赖 ffmpeg/剪映）。"""

    def test_empty_clips_rejected_with_400(self):
        res = self.client.post(f"{API}/timeline/draft", json={"clips": []})
        self.assertEqual(res.status_code, 400)
        self.assertIn("片段", res.json()["detail"])

    def test_draft_export_receives_params_and_returns_result(self):
        from app.api import timeline_routes as routes
        url = self._fake_clip("draft_a.mp4")
        seen = {}

        async def _fake_export(clips, *, title, aspect_ratio, project_id):
            seen.update(clips=clips, title=title, aspect_ratio=aspect_ratio, project_id=project_id)
            return {"draft_path": os.path.join(self.root, "draft"), "warnings": ["按素材完整时长排布"]}

        with mock.patch.object(routes, "export_clips_to_draft", _fake_export):
            res = self.client.post(f"{API}/timeline/draft", json={
                "clips": [self._clip_payload(url, 2.0)],
                "title": "草稿冒烟",
                "aspect_ratio": "16:9",
                "project_id": "proj_draft",
            })
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["status"], "success")
        self.assertIn("draft_path", body)
        self.assertEqual(seen["title"], "草稿冒烟")
        self.assertEqual(seen["aspect_ratio"], "16:9")
        self.assertEqual(seen["project_id"], "proj_draft")
        self.assertEqual(len(seen["clips"]), 1)
        self.assertTrue(seen["clips"][0]["path"].endswith("draft_a.mp4"))

    def test_draft_engine_unavailable_returns_503(self):
        from app.api import timeline_routes as routes
        from app.media.timeline_merge import TimelineMergeError
        url = self._fake_clip("draft_b.mp4")

        async def _boom(*_a, **_k):
            raise TimelineMergeError("剪映草稿引擎不可用：ModuleNotFoundError: pyJianYingDraft")

        with mock.patch.object(routes, "export_clips_to_draft", _boom):
            res = self.client.post(f"{API}/timeline/draft",
                                   json={"clips": [self._clip_payload(url, 1.0)]})
        self.assertEqual(res.status_code, 503)
        self.assertIn("剪映", res.json()["detail"])


class TestProjectExportRoute(_IsolatedTimelineTest):
    """多轨剪辑导出 MP4：提交口校验 + 后台合片任务走通。"""

    def test_empty_shots_rejected_with_400(self):
        res = self.client.post(f"{API}/timeline/export-project", json={"shots": []})
        self.assertEqual(res.status_code, 400)
        self.assertIn("分镜", res.json()["detail"])

    def test_without_ffmpeg_returns_503_with_install_hint(self):
        from app.media import timeline_merge
        url = self._fake_clip("project_nomedia.mp4")
        with mock.patch.object(timeline_merge, "has_binary", return_value=False):
            res = self.client.post(f"{API}/timeline/export-project", json={
                "shots": [{"shot_index": 1, "duration": 2.0, "video_url": url}],
            })
        self.assertEqual(res.status_code, 503)
        self.assertIn("ffmpeg", res.json()["detail"])

    def test_missing_voice_is_generated_before_merge(self):
        from app.api import timeline_routes as routes
        url = self._fake_clip("project_voice.mp4")
        seen = {}

        async def _fake_fill(shots, **kwargs):
            for shot in shots:
                shot["audio_url"] = "/storage/audio/generated.mp3"
                shot["audio_duration"] = 2.0
            return 1, []

        async def _fake_merge(shots, out_path, **kwargs):
            seen["audio_url"] = shots[0].get("audio_url")
            with open(out_path, "wb") as fh:
                fh.write(b"x" * 1024)
            return {
                "status": "success", "output_path": out_path,
                "output_url": "/exports/timeline/voice.mp4",
                "duration": 2.0, "size_bytes": 1024, "subtitles": False,
                "audio_tracks": 1, "warnings": [],
            }

        with mock.patch.object(routes, "fill_missing_voice", _fake_fill), \
             mock.patch.object(routes, "merge_project_shots", _fake_merge), \
             _client() as client:
            res = client.post(f"{API}/timeline/export-project", json={
                "shots": [{"shot_index": 1, "duration": 2.0, "video_url": url,
                           "voiceover": "旁白"}],
                "generate_missing_voice": True,
            })
            self.assertEqual(res.status_code, 200, res.text)
            task_id = res.json()["task_id"]
            body = {}
            for _ in range(80):
                body = client.get(f"{API}/timeline/tasks/{task_id}").json()
                if body.get("status") in ("success", "error"):
                    break
                time.sleep(0.05)

        self.assertEqual(body.get("status"), "success", body.get("error"))
        self.assertEqual(seen["audio_url"], "/storage/audio/generated.mp3")

    def test_task_completes_and_receives_all_tracks(self):
        from app.api import timeline_routes as routes
        url = self._fake_clip("project_a.mp4")
        seen = {}

        async def _fake_merge(shots, out_path, **kwargs):
            seen.update(shots=shots, out_path=out_path, **kwargs)
            with open(out_path, "wb") as fh:
                fh.write(b"x" * 2048)
            return {
                "status": "success",
                "output_path": out_path,
                "output_url": "/exports/timeline/fake.mp4",
                "duration": sum(s["duration"] for s in shots),
                "size_bytes": 2048,
                "subtitles": True,
                "audio_tracks": 1,
                "warnings": [],
                "engine": "ffmpeg",
            }

        with mock.patch.object(routes, "merge_project_shots", _fake_merge), _client() as client:
            res = client.post(f"{API}/timeline/export-project", json={
                "shots": [
                    {"shot_index": 1, "duration": 2.0, "video_url": url,
                     "audio_url": url, "subtitle_text": "字幕一"},
                    {"shot_index": 2, "duration": 1.0, "video_url": "",
                     "image_url": "", "subtitle_text": "字幕二"},
                ],
                "title": "多轨冒烟",
                "aspect_ratio": "9:16",
                "bgm_url": url,
                "bgm_volume": 0.3,
                "subtitles": True,
                "generate_missing_voice": False,
                "project_id": "proj_test",
            })
            self.assertEqual(res.status_code, 200, res.text)
            task_id = res.json()["task_id"]

            body = {}
            for _ in range(80):
                body = client.get(f"{API}/timeline/tasks/{task_id}").json()
                if body.get("status") in ("success", "error"):
                    break
                time.sleep(0.05)

        self.assertEqual(body.get("status"), "success", body.get("error"))
        self.assertTrue(body["output_path"].endswith(".mp4"))
        self.assertEqual(seen["bgm_url"], url)
        self.assertEqual(seen["bgm_volume"], 0.3)
        self.assertTrue(seen["subtitles"])
        self.assertEqual(len(seen["shots"]), 2)
        self.assertEqual(seen["shots"][0]["subtitle"], "字幕一")
        self.assertEqual(seen["shots"][1]["subtitle"], "字幕二")


class TestMergeConcurrencyGate(_IsolatedTimelineTest):
    """提交闸门：在途额度（2 个合成 + 8 个排队）用满后必须 429，而不是无界拉起 ffmpeg。"""

    def test_submissions_beyond_capacity_get_429(self):
        from app.api import timeline_routes as routes
        url = self._fake_clip("gate.mp4")
        payload = {"clips": [self._clip_payload(url, 1.0)]}

        async def _slow_merge(*_a, **_k):
            await asyncio.sleep(60)  # 一直占着合成槽：模拟编码中的 ffmpeg

        capacity = routes._MERGE_CONCURRENCY + routes._MERGE_QUEUE_LIMIT
        # 必须用长驻 portal（`with` 形式）：TestClient 逐请求新建事件循环时，请求一返回
        # 后台任务就被取消、在途计数当场归零，闸门永远测不出来。生产是单 loop 长驻，不会这样。
        with mock.patch.object(routes, "merge_clips", _slow_merge), _client() as client:
            codes = [client.post(f"{API}/timeline/merge", json=payload).status_code
                     for _ in range(capacity + 2)]

        self.assertEqual(codes[:capacity], [200] * capacity, codes)
        self.assertEqual(codes[capacity:], [429, 429], codes)


if __name__ == "__main__":
    unittest.main()
