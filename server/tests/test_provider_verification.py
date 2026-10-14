# -*- coding: utf-8 -*-
"""生成源「生产可用」验证链路回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_verification -v
背景：画布/分镜生产端选择器按 production_only=true 过滤（configured && verified）。
HTTP /providers/{id}/test 会写 verified 标记，而 MCP test_custom_provider 曾漏写，
导致 Agent 侧测试过的源在画布下拉里选不到。现两端共用 run_provider_test 单一实现。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402


class TestProviderVerification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="prov_verify_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _defn(self, pid: str):
        from app.models.provider_definition import ProviderDefinition
        return ProviderDefinition(
            id=pid, name="验证测试源", kind="video", provider_type="code",
            language="python",
            code="async def generate(ctx, api):\n"
                 "    return {'video_url': None, 'task_id': 't1', 'status': 'SUBMITTED'}\n",
            code_entry="generate",
        )

    def test_health_ok_marks_verified(self):
        from app.api.provider_routes import run_provider_test
        from app.providers import verification
        from app.providers.custom.manager import custom_provider_manager
        d = self._defn("prov_vt_ok")
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=d), \
             mock.patch("app.providers.generic.code_provider.compile_check_code", return_value={"ok": True}), \
             mock.patch("app.providers.generic.code_provider.GenericCodeVideoProvider.check_health",
                        new=mock.AsyncMock(return_value=True)):
            res = asyncio.run(run_provider_test("prov_vt_ok"))
        self.assertTrue(res["ok"])
        self.assertTrue(res["verified"])
        self.assertTrue(verification.is_verified("prov_vt_ok"))
        # 诚实口径：代码源默认只做编译体检，必须标明"未真实调用上游"
        self.assertEqual(res.get("probe"), "compile")
        self.assertIn("未真实调用上游", res.get("detail", ""))

    def test_live_probe_failure_carries_hint(self):
        """live=true 实测失败：真实错误（余额/Key）必须带行动建议，且撤销生产可用标记。"""
        from app.api.provider_routes import run_provider_test
        from app.providers import verification
        from app.providers.custom.manager import custom_provider_manager
        d = self._defn("prov_vt_live")
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=d), \
             mock.patch("app.providers.generic.code_provider.compile_check_code", return_value={"ok": True}), \
             mock.patch("app.providers.generic.code_provider.GenericCodeVideoProvider.check_health",
                        new=mock.AsyncMock(return_value=True)), \
             mock.patch("app.api.provider_routes._live_probe_provider",
                        new=mock.AsyncMock(return_value=(False, "实测失败：Your balance is insufficient｜建议：去充值"))):
            res = asyncio.run(run_provider_test("prov_vt_live", live=True))
        self.assertFalse(res["ok"])
        self.assertFalse(res["verified"])
        self.assertEqual(res.get("probe"), "live")
        self.assertIn("balance", res.get("detail", "").lower())
        self.assertIn("充值", res.get("hint", ""))

    def test_health_fail_revokes_verified(self):
        from app.api.provider_routes import run_provider_test
        from app.providers import verification
        from app.providers.custom.manager import custom_provider_manager
        d = self._defn("prov_vt_bad")
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=d), \
             mock.patch("app.providers.generic.code_provider.compile_check_code", return_value={"ok": True}), \
             mock.patch("app.providers.generic.code_provider.GenericCodeVideoProvider.check_health",
                        new=mock.AsyncMock(return_value=False)):
            res = asyncio.run(run_provider_test("prov_vt_bad"))
        self.assertFalse(res["ok"])
        self.assertFalse(res["verified"])
        self.assertFalse(verification.is_verified("prov_vt_bad"))

    def test_mcp_test_tool_uses_shared_impl(self):
        """MCP test_custom_provider 必须走 run_provider_test（与 HTTP 同口径，含验证标记写入）。"""
        from app.mcp.server import mcp_registry
        fake = {"provider_id": "prov_mcp", "ok": True, "is_configured": True,
                "verified": True, "detail": "连通正常"}
        with mock.patch("app.api.provider_routes.run_provider_test",
                        new=mock.AsyncMock(return_value=fake)) as m:
            res = asyncio.run(mcp_registry.execute_tool("test_custom_provider", {"provider_id": "prov_mcp"}))
        m.assert_awaited_once_with("prov_mcp", live=False)
        self.assertEqual(res.status, "success")
        self.assertTrue((res.result or {}).get("verified"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
