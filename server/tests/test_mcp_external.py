# -*- coding: utf-8 -*-
"""MCP 对外端点的最小鉴权回归：设置 Token 后，缺失/错误 Bearer 必须 401。"""
import os
import unittest

from fastapi.testclient import TestClient


class TestMCPExternalAuth(unittest.TestCase):
    def setUp(self):
        self._old = os.environ.get("STUDIO_MCP_AUTH_TOKEN")
        os.environ["STUDIO_MCP_AUTH_TOKEN"] = "test-token"

    def tearDown(self):
        if self._old is None:
            os.environ.pop("STUDIO_MCP_AUTH_TOKEN", None)
        else:
            os.environ["STUDIO_MCP_AUTH_TOKEN"] = self._old

    def test_missing_or_wrong_bearer_is_rejected(self):
        from app.main import app

        client = TestClient(app)
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0.0.0"},
            },
        }
        headers = {"Accept": "application/json, text/event-stream"}

        missing = client.post("/mcp-server/", json=payload, headers=headers)
        self.assertEqual(missing.status_code, 401)
        self.assertIn("Bearer", missing.headers.get("www-authenticate", ""))

        wrong = client.post(
            "/mcp-server/",
            json=payload,
            headers={**headers, "Authorization": "Bearer wrong"},
        )
        self.assertEqual(wrong.status_code, 401)


if __name__ == "__main__":
    unittest.main()
