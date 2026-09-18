# -*- coding: utf-8 -*-
"""TaskCenter 统一异步任务抽象回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_task_center -v
覆盖：成功/失败/超时/取消、旧内存表桥接、持久化与重启 bootstrap、状态归一化、
Agent task_status/task_wait/task_cancel 内置工具与计划模式门控。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.providers.tasks import TaskCenter, normalize_status, task_center  # noqa: E402


_LOOP = None


def run(coro):
    """显式复用测试事件循环（避免跨模块 get_event_loop 状态漂移）。"""
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
        cls._tmp = tempfile.mkdtemp(prefix="task_center_")
        settings.STORAGE_DIR = cls._tmp
        os.environ["STUDIO_TASK_POLL_INTERVAL"] = "0.05"
        os.environ["AGENT_VIDEO_WAIT_S"] = "5"

    @classmethod
    def tearDownClass(cls):
        from app.core.config import settings
        settings.STORAGE_DIR = cls._orig
        os.environ.pop("STUDIO_TASK_POLL_INTERVAL", None)
        os.environ.pop("AGENT_VIDEO_WAIT_S", None)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def unique(self, prefix="t"):
        import uuid
        return f"{prefix}_{uuid.uuid4().hex[:10]}"


class TestTaskCenter(TempStorage):
    def test_wait_success_with_poller(self):
        async def scenario():
            calls = {"n": 0}
            tid = self.unique("ok")

            async def poller(rec):
                calls["n"] += 1
                if calls["n"] >= 2:
                    return {"status": "SUCCESS", "video_url": f"/storage/videos/{tid}.mp4"}
                return {"status": "RUNNING"}

            task_center.register(tid, "prov_test", "video", poller=poller, timeout_s=30)
            rec = await task_center.wait(tid, timeout_s=5)
            return tid, rec, calls["n"]

        tid, rec, n = run(scenario())
        self.assertEqual(rec.status, "SUCCESS")
        self.assertIn(f"/storage/videos/{tid}.mp4", rec.video_url)
        self.assertGreaterEqual(n, 2)
        # 持久化落盘
        p = Path(self._tmp) / "tasks" / f"task_{tid}.json"
        self.assertTrue(p.exists())
        saved = json.loads(p.read_text(encoding="utf-8"))
        self.assertEqual(saved["status"], "SUCCESS")

    def test_failed_records_error(self):
        async def scenario():
            tid = self.unique("fail")

            async def poller(rec):
                return {"status": "FAILED", "error": "显存不足"}
            task_center.register(tid, "prov_test", "video", poller=poller, timeout_s=30)
            return await task_center.wait(tid, timeout_s=5)

        rec = run(scenario())
        self.assertEqual(rec.status, "FAILED")
        self.assertIn("显存不足", rec.error)

    def test_timeout_then_cancel(self):
        async def scenario():
            tid = self.unique("cancel")

            async def poller(rec):
                return {"status": "RUNNING"}
            task_center.register(tid, "prov_test", "video", poller=poller, timeout_s=60)
            rec = await task_center.wait(tid, timeout_s=0.5)
            self.assertFalse(rec.terminal)
            out = await task_center.cancel(tid)
            return out

        out = run(scenario())
        self.assertEqual(out["status"], "CANCELLED")

    def test_bootstrap_reloads_fresh_instance(self):
        async def scenario():
            tid = self.unique("boot")

            async def poller(rec):
                return {"status": "SUCCESS", "video_url": f"/storage/videos/{tid}.mp4"}
            task_center.register(tid, "prov_boot", "video", poller=poller, timeout_s=30)
            rec = await task_center.wait(tid, timeout_s=5)
            return tid, rec.status

        tid, status = run(scenario())
        self.assertEqual(status, "SUCCESS")
        fresh = TaskCenter()
        n = fresh.bootstrap()
        self.assertGreaterEqual(n, 1)
        rec2 = fresh.status(tid)
        self.assertIsNotNone(rec2)
        self.assertEqual(rec2.status, "SUCCESS")

    def test_normalize_status(self):
        self.assertEqual(normalize_status("succeeded"), "SUCCESS")
        self.assertEqual(normalize_status("completed"), "SUCCESS")
        self.assertEqual(normalize_status("failed"), "FAILED")
        self.assertEqual(normalize_status("running"), "RUNNING")
        self.assertEqual(normalize_status(""), "RUNNING")


class TestTaskTools(TempStorage):
    def _pipeline(self):
        from app.agent.tools.pipeline import ToolPipeline
        return ToolPipeline(self.unique("pipe"), lambda ev: None, session=None)

    def test_task_tools_lifecycle(self):
        async def scenario():
            tid = self.unique("tool")

            async def poller(rec):
                return {"status": "SUCCESS", "video_url": f"/storage/videos/{tid}.mp4"}
            task_center.register(tid, "prov_test", "video", poller=poller, timeout_s=30)
            p = self._pipeline()
            # 先阻塞等待终态（事件驱动），再查状态，避免与轮询间隔竞态
            wait = await p.execute("c2", "task_wait", {"task_id": tid, "timeout_s": 5})
            st = await p.execute("c1", "task_status", {"task_id": tid})
            return st, wait

        st, wait = run(scenario())
        self.assertEqual(st.status, "success")
        self.assertEqual(st.result["status"], "SUCCESS")
        self.assertEqual(wait.status, "success")
        self.assertEqual(wait.result["status"], "SUCCESS")

    def test_plan_mode_gates_task_wait(self):
        from app.agent.tools.pipeline import ToolPipeline

        async def scenario():
            tid = self.unique("plan")

            async def poller(rec):
                return {"status": "RUNNING"}
            task_center.register(tid, "prov_test", "video", poller=poller, timeout_s=30)
            p = ToolPipeline(self.unique("pipe_plan"), lambda ev: None, plan_mode=True, session=None)
            denied = await p.execute("c1", "task_wait", {"task_id": tid})
            allowed = await p.execute("c2", "task_status", {"task_id": tid})
            await task_center.cancel(tid)
            return denied, allowed

        denied, allowed = run(scenario())
        self.assertEqual(denied.status, "denied")
        self.assertEqual(allowed.status, "success")

    def test_missing_task_reports_error(self):
        p = self._pipeline()
        out = run(p.execute("c1", "task_status", {"task_id": "no_such_task"}))
        self.assertEqual(out.status, "error")
        self.assertIn("任务不存在", out.error)


class TestCodeSourceQueryFailure(TempStorage):
    """代码源查询分支按契约 raise 终态失败 → 必须判 FAILED 并暴露真实错误（不得静默空转到超时）。"""

    def _save_video_provider(self, pid: str, code: str):
        from app.models.provider_definition import ProviderDefinition
        from app.providers.custom.manager import custom_provider_manager
        pd = ProviderDefinition(id=pid, name=pid, kind="video", provider_type="code",
                                code=code, language="python", code_entry="generate")
        custom_provider_manager.save_definition(pd)

    def test_raised_failure_settles_failed(self):
        pid = self.unique("prov_fail")
        self._save_video_provider(pid, '''
async def generate(ctx, api):
    dyn = ctx.get("dynamic_inputs") or {}
    tid = str(ctx.get("task_id") or dyn.get("task_id") or "").strip()
    if tid and not str(ctx.get("prompt") or "").strip():
        raise RuntimeError("任务失败(FAILED): 内容审核未通过")
    return {"video_url": None, "task_id": "t_submit", "status": "SUBMITTED"}
''')
        tid = self.unique("code_fail")

        async def scenario():
            task_center.register(tid, pid, "video", timeout_s=30)
            return await task_center.wait(tid, timeout_s=5)

        rec = run(scenario())
        self.assertEqual(rec.status, "FAILED")
        self.assertIn("任务失败", rec.error or "")

    def test_network_error_not_terminal(self):
        pid = self.unique("prov_net")
        self._save_video_provider(pid, '''
async def generate(ctx, api):
    dyn = ctx.get("dynamic_inputs") or {}
    tid = str(ctx.get("task_id") or dyn.get("task_id") or "").strip()
    if tid and not str(ctx.get("prompt") or "").strip():
        raise RuntimeError("Connection refused by remote host")
    return {"video_url": None, "task_id": "t_submit", "status": "SUBMITTED"}
''')
        tid = self.unique("code_net")

        async def scenario():
            task_center.register(tid, pid, "video", timeout_s=30)
            return await task_center.wait(tid, timeout_s=1)

        rec = run(scenario())
        # 网络类异常不误杀：仍非终态，但错误已记录可见
        self.assertFalse(rec.terminal)
        self.assertIn("Connection refused", rec.meta.get("last_error") or "")


class TestMCPTaskIntegration(TempStorage):
    """provider_xxx MCP 工具全链路：提交即返 task_id → TaskCenter 阻塞 → 返回 video_url。"""

    def test_provider_tool_blocks_until_video(self):
        import app.mcp.server as mcp_mod
        from app.models.schemas import MCPToolDefinition
        from app.providers.video.registry import video_registry
        from app.providers.video.base import VideoGenerateResult

        tid = self.unique("mcp")
        pid = f"fake_{tid}"
        tool_name = f"provider_{pid}"

        async def scenario():
            async def poller(rec):
                return {"status": "SUCCESS", "video_url": f"/storage/videos/{tid}.mp4"}

            task_center.register(tid, pid, "video", poller=poller, timeout_s=30)
            orig_get, orig_gen = video_registry.get, video_registry.generate

            def fake_get(x):
                return object() if x == pid else orig_get(x)

            async def fake_gen(req, provider_id=None):
                return VideoGenerateResult(video_url="", local_path=None, provider=pid, engine="test",
                                           duration=5, elapsed_ms=1, task_id=tid, raw={})

            video_registry.get = fake_get
            video_registry.generate = fake_gen
            mcp_mod.mcp_registry.register_tool(MCPToolDefinition(
                name=tool_name, description="test provider", category="ai_generation",
                icon="Video", author="test", input_schema={"type": "object", "properties": {}},
            ))
            try:
                return await mcp_mod.mcp_registry.execute_tool(tool_name, {"prompt": "测试"})
            finally:
                mcp_mod.mcp_registry.tools.pop(tool_name, None)
                video_registry.get = orig_get
                video_registry.generate = orig_gen

        res = run(scenario())
        self.assertEqual(res.status, "success")
        self.assertIn(tid, res.result.get("video_url") or "")
        self.assertEqual(res.result.get("status"), "SUCCESS")


if __name__ == "__main__":
    unittest.main(verbosity=2)
