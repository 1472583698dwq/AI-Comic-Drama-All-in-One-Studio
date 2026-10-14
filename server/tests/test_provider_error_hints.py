# -*- coding: utf-8 -*-
"""生成源错误 → 行动建议（error_hints）回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_error_hints -v
钉住三类最常被卡住的错误都能给出"下一步去哪做什么"，且不误伤普通错误。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.providers.error_hints import provider_error_hint  # noqa: E402


class TestProviderErrorHints(unittest.TestCase):
    def test_balance(self):
        h = provider_error_hint("API error 605: Your balance is insufficient")
        self.assertIsNotNone(h)
        self.assertIn("充值", h)

    def test_missing_key_chinese(self):
        h = provider_error_hint("缺少 RunningHub API Key，请在生成源中配置")
        self.assertIsNotNone(h)
        self.assertIn("设置→生成源", h)

    def test_unauthorized(self):
        self.assertIsNotNone(provider_error_hint("HTTP 401 Unauthorized"))
        self.assertIsNotNone(provider_error_hint("invalid token"))

    def test_local_service_down(self):
        h = provider_error_hint("HTTPConnectionPool: Connection refused 127.0.0.1:8188")
        self.assertIsNotNone(h)
        self.assertIn("服务", h)

    def test_moderation(self):
        self.assertIsNotNone(provider_error_hint("请求被内容安全审核拦截"))

    def test_unknown_error_no_hint(self):
        self.assertIsNone(provider_error_hint("unexpected token '<' in JSON at position 0"))

    def test_mcp_appends_hint_for_provider_errors(self):
        """provider_* 工具失败时执行口要自动补行动建议（模型/用户都能看到下一步）。"""
        import asyncio
        from unittest import mock
        from app.mcp.server import mcp_registry

        async def boom(*a, **kw):
            raise RuntimeError("Your balance is insufficient (code 605)")
        # 直接替换动态 provider tool 的执行分支不易；改从执行口结果验证：
        # 用 test_custom_provider（同样走建议注入）打样
        with mock.patch("app.api.provider_routes.run_provider_test",
                        new=mock.AsyncMock(side_effect=RuntimeError("Your balance is insufficient (code 605)"))):
            res = asyncio.run(mcp_registry.execute_tool("test_custom_provider", {"provider_id": "prov_x"}))
        self.assertEqual(res.status, "error")
        self.assertIn("建议", res.error or "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
