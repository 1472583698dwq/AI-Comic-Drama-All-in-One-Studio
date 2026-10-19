# -*- coding: utf-8 -*-
"""generate_video 具名工具的异步任务登记回归（孤儿 task_id 修复）。

背景：generate_video 拿到代码源的异步 task_id 后直接返回、不登记 TaskCenter，
agent 再调 task_wait/task_status 会报「任务不存在」，云端任务成孤儿。
运行：python -m unittest tests.test_generate_video_registration -v
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.providers.tasks import task_center  # noqa: E402
from app.mcp.server import finalize_video_async_result  # noqa: E402

_LOOP = None


def run(coro):
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


class TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app.core.config import settings
        cls._orig = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="gv_reg_")
        settings.STORAGE_DIR = cls._tmp
        os.environ["AGENT_VIDEO_WAIT_S"] = "5"
        os.environ["STUDIO_TASK_POLL_INTERVAL"] = "0.05"

    @classmethod
    def tearDownClass(cls):
        from app.core.config import settings
        settings.STORAGE_DIR = cls._orig
        os.environ.pop("AGENT_VIDEO_WAIT_S", None)
        os.environ.pop("STUDIO_TASK_POLL_INTERVAL", None)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        task_center._tasks.clear()
        task_center._events.clear()
        task_center._pollers.clear()
        task_center._custom_pollers.clear()
        task_center._ready = False

    def tearDown(self):
        for t in list(task_center._pollers.values()):
            t.cancel()


class _FakeRes:
    def __init__(self, task_id="", video_url="", provider="prov_x"):
        self.task_id = task_id
        self.video_url = video_url
        self.provider = provider
        self.local_path = None
        self.duration = 5
        self.engine = "code"


class TestGenerateVideoRegistration(TempStorage):
    def test_async_submit_registers_into_task_center(self):
        """wait=False：登记后返回 SUBMITTED；task_status 能查到，不再是孤儿。"""
        async def scenario():
            res = _FakeRes(task_id="2109999999999999901")
            result = await finalize_video_async_result(
                res, "prov_x", {"id": "proj_t"}, {"mode": "r2v", "wait": False},
                {"video_url": "", "task_id": "2109999999999999901"},
            )
            self.assertEqual(result.get("status"), "SUBMITTED")
            rec = task_center.status("2109999999999999901")
            self.assertIsNotNone(rec)
            self.assertEqual(rec.provider_id, "prov_x")
            self.assertEqual(rec.project_id, "proj_t")
        run(scenario())

    def test_default_wait_blocks_until_poller_settles(self):
        """默认（不传 wait）：登记后阻塞到成片，成功回填 video_url。"""
        async def scenario():
            tid = "2109999999999999902"
            task_center.register(tid, "prov_x", "video", poller=lambda rec: {"status": "SUCCESS", "video_url": "/storage/vid/x.mp4"})
            res = _FakeRes(task_id=tid)
            result = await finalize_video_async_result(
                res, "prov_x", None, {"mode": "r2v"},
                {"video_url": "", "task_id": tid},
            )
            self.assertEqual(result.get("status"), "SUCCESS")
            self.assertEqual(result.get("video_url"), "/storage/vid/x.mp4")
        run(scenario())

    def test_failed_raises_runtime_error(self):
        """轮询失败 → 工具报错（与 provider_* 路径一致）。"""
        async def scenario():
            tid = "2109999999999999903"
            task_center.register(tid, "prov_x", "video", poller=lambda rec: {"status": "FAILED", "error": "上游 400"})
            res = _FakeRes(task_id=tid)
            with self.assertRaises(RuntimeError):
                await finalize_video_async_result(
                    res, "prov_x", None, {"mode": "i2v"},
                    {"video_url": "", "task_id": tid},
                )
        run(scenario())

    def test_sync_result_untouched(self):
        """同步成片（有 video_url）：不登记、不改结果。"""
        async def scenario():
            res = _FakeRes(task_id="2109999999999999904", video_url="/storage/vid/done.mp4")
            result = await finalize_video_async_result(
                res, "prov_x", None, {},
                {"video_url": "/storage/vid/done.mp4", "task_id": "2109999999999999904"},
            )
            self.assertIsNone(task_center.status("2109999999999999904"))
            self.assertNotIn("status", result)
        run(scenario())

    def test_register_is_idempotent(self):
        """register 幂等：先登记过（如 onekey/canvas 已记），helper 不覆盖原记录。"""
        async def scenario():
            tid = "2109999999999999905"
            task_center.register(tid, "prov_orig", "video", project_id="proj_a")
            res = _FakeRes(task_id=tid, provider="prov_other")
            await finalize_video_async_result(
                res, "prov_other", {"id": "proj_b"}, {"wait": False},
                {"video_url": "", "task_id": tid},
            )
            rec = task_center.status(tid)
            self.assertEqual(rec.provider_id, "prov_orig")
            self.assertEqual(rec.project_id, "proj_a")
        run(scenario())


if __name__ == "__main__":
    unittest.main()
