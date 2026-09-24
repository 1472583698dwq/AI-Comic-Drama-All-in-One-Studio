# -*- coding: utf-8 -*-
"""跨源防护回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_cors_origin -v
背景：/mcp/call 与 /extensions/execute 是能跑代码、能花钱的任意工具执行口。
CORS 只挡浏览器读响应，跨源 POST 仍会在服务端执行（fire-and-forget），
故这两个口额外做 Origin 校验；本测试钉住「唯一口径」与「拦截发生在执行之前」。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestOriginPredicate(unittest.TestCase):
    def test_local_origins_allowed(self):
        from app.core.config import is_local_or_allowed_origin as ok
        for o in ("http://localhost:5173", "http://127.0.0.1:8000", "http://[::1]:8000",
                  "https://LOCALHOST", "http://127.0.0.1:8000/"):
            self.assertTrue(ok(o), o)

    def test_empty_origin_allowed_null_and_remote_denied(self):
        from app.core.config import is_local_or_allowed_origin as ok
        self.assertTrue(ok(""))          # curl / 原生壳 / 同源 GET
        self.assertTrue(ok(None))
        self.assertFalse(ok("null"))     # file:// 与沙箱 iframe
        for o in ("http://evil.example.com", "https://evil.test:8000", "http://localhost.evil.test"):
            self.assertFalse(ok(o), o)

    def test_extra_origins_whitelist(self):
        from app.core import config as cfg
        orig = cfg.settings.STUDIO_CORS_EXTRA_ORIGINS
        try:
            cfg.settings.STUDIO_CORS_EXTRA_ORIGINS = "https://app.corp.test, https://lan.corp.test/"
            self.assertEqual(cfg.cors_extra_origins(),
                             ["https://app.corp.test", "https://lan.corp.test"])
            self.assertTrue(cfg.is_local_or_allowed_origin("https://lan.corp.test"))
            self.assertFalse(cfg.is_local_or_allowed_origin("https://other.corp.test"))
        finally:
            cfg.settings.STUDIO_CORS_EXTRA_ORIGINS = orig


class TestExecutionPortGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import app.main as main_mod
        cls.client = TestClient(main_mod.app)

    def test_foreign_origin_rejected_before_execution(self):
        # 若不拦截，这个调用会因缺参数报错/或因未知工具报错；403 说明根本没进执行器
        r = self.client.post("/api/v1/mcp/call",
                             json={"name": "nonexistent_tool_x", "arguments": {}},
                             headers={"origin": "http://evil.example.com"})
        self.assertEqual(r.status_code, 403)
        self.assertIn("跨源", r.json().get("detail", ""))

    def test_extensions_execute_guarded_too(self):
        r = self.client.post("/api/v1/extensions/execute",
                             json={"id": "nonexistent_x"},
                             headers={"origin": "http://evil.example.com"})
        self.assertEqual(r.status_code, 403)

    def test_local_origin_passes_guard(self):
        r = self.client.post("/api/v1/mcp/call",
                             json={"name": "nonexistent_tool_x", "arguments": {}},
                             headers={"origin": "http://127.0.0.1:8000"})
        self.assertNotEqual(r.status_code, 403)

    def test_same_origin_no_origin_header_passes(self):
        r = self.client.post("/api/v1/mcp/call",
                             json={"name": "nonexistent_tool_x", "arguments": {}})
        self.assertNotEqual(r.status_code, 403)

    def test_preflight_not_blocked_by_guard(self):
        # OPTIONS 交给 CORSMiddleware 处理，Origin 门不该抢先 403
        r = self.client.options("/api/v1/mcp/call",
                                headers={"origin": "http://localhost:5173",
                                         "access-control-request-method": "POST"})
        self.assertNotEqual(r.status_code, 403)

    def test_wildcard_cors_removed(self):
        for m in self.client.app.user_middleware:
            if m.cls.__name__ == "CORSMiddleware":
                self.assertNotIn("*", m.kwargs.get("allow_origins", []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
