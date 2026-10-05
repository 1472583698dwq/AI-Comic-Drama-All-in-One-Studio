# -*- coding: utf-8 -*-
"""日志系统回归（stdlib unittest，零外部依赖）

运行：python -m unittest tests.test_logging -v
覆盖：
1) bootstrap 落盘 + print 重定向入档 + 未捕获异常 traceback 入档
2) tail 级别过滤 / 关键词过滤 / 行数上限
3) 运行期级别切换（持久化 + 立即生效）
4) /system/logs/{tail,files,download,level,frontend} 接口
5) 未处理异常 handler 返回 500 且 traceback 落盘
"""
import asyncio
import logging
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _flush_all():
    for h in logging.getLogger().handlers:
        try:
            h.flush()
        except Exception:
            pass


class TestLoggingCore(unittest.TestCase):
    def setUp(self):
        from app.core import logging_config as lc
        self.lc = lc
        self.tmp = tempfile.mkdtemp(prefix="logtest_")
        self.log_dir = os.path.join(self.tmp, "logs")
        lc.bootstrap_logging(log_directory=self.log_dir, level="DEBUG", force=True)

    def _content(self):
        _flush_all()
        with open(self.lc.main_log_path(), encoding="utf-8") as f:
            return f.read()

    def test_print_redirected_and_excepthook_traceback(self):
        print("print-marker-abc123")
        try:
            raise ValueError("boom-marker-xyz789")
        except ValueError:
            tb = sys.exc_info()[2]
            self.lc._excepthook(ValueError, ValueError("boom-marker-xyz789"), tb)
        content = self._content()
        self.assertIn("print-marker-abc123", content)
        self.assertIn("boom-marker-xyz789", content)
        self.assertIn("ValueError", content)

    def test_set_level_persists_and_applies(self):
        self.assertEqual(self.lc.set_level("DEBUG"), "DEBUG")
        self.assertEqual(logging.getLogger().level, logging.DEBUG)
        self.assertEqual(self.lc.resolve_level(self.log_dir), logging.DEBUG)
        level_file = os.path.join(self.tmp, "log_level.json")
        self.assertTrue(os.path.exists(level_file), level_file)
        with open(level_file, encoding="utf-8") as f:
            self.assertIn("DEBUG", f.read())
        self.lc.set_level("INFO")
        self.assertEqual(logging.getLogger().level, logging.INFO)

    def test_set_level_rejects_unknown(self):
        with self.assertRaises(ValueError):
            self.lc.set_level("NOPE")


class TestTailFilter(unittest.TestCase):
    def setUp(self):
        from app.core import logging_config as lc
        self.lc = lc
        self.tmp = tempfile.mkdtemp(prefix="logtail_")
        self.log_path = os.path.join(self.tmp, "studio.log")
        sample = "\n".join([
            "2026-09-29 10:00:00 [D] mod: debug line alpha",
            "2026-09-29 10:00:01 [I] mod: info line beta",
            "2026-09-29 10:00:02 [W] mod: warn line gamma",
            "2026-09-29 10:00:03 [E] mod: error line delta",
        ]) + "\n"
        with open(self.log_path, "w", encoding="utf-8") as f:
            f.write(sample)
        self._orig_main = lc._MAIN_LOG
        lc._MAIN_LOG = self.log_path

    def tearDown(self):
        self.lc._MAIN_LOG = self._orig_main

    def test_level_filter_and_keyword(self):
        from app.api.log_routes import read_tail
        all_lines = read_tail(lines=100)
        self.assertEqual(len(all_lines), 4)
        warn_plus = read_tail(lines=100, level="WARNING")
        self.assertEqual(len(warn_plus), 2)
        self.assertTrue(all(("[W]" in ln or "[E]" in ln) for ln in warn_plus))
        q_lines = read_tail(lines=100, q="gamma")
        self.assertEqual(len(q_lines), 1)
        self.assertIn("gamma", q_lines[0])

    def test_lines_cap(self):
        from app.api.log_routes import read_tail
        self.assertEqual(len(read_tail(lines=2)), 2)


class TestLogEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import app.main as main_mod
        from app.core import logging_config as lc
        cls.client = TestClient(main_mod.app)
        cls.lc = lc
        cls.main_mod = main_mod
        cls.tmp = tempfile.mkdtemp(prefix="logapi_")
        lc.bootstrap_logging(log_directory=os.path.join(cls.tmp, "logs"), level="DEBUG", force=True)

    def _content(self):
        _flush_all()
        with open(self.lc.main_log_path(), encoding="utf-8") as f:
            return f.read()

    def test_frontend_report_then_tail(self):
        r = self.client.post("/api/v1/system/logs/frontend", json={
            "entries": [
                {"level": "error", "message": "fe-marker-q1w2e3", "stack": "at foo (a.tsx:1:1)", "source": "test"},
                {"level": "warn", "message": "api warn marker", "source": "fetch"},
            ],
        })
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["written"], 2)
        content = self._content()
        self.assertIn("fe-marker-q1w2e3", content)
        self.assertIn("[frontend]", content)
        r = self.client.get("/api/v1/system/logs/tail?lines=200")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("fe-marker-q1w2e3", "\n".join(body["lines"]))
        self.assertIn("path", body)

    def test_files_and_download(self):
        r = self.client.get("/api/v1/system/logs/files")
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(r.json()["total"], 1)
        r = self.client.get("/api/v1/system/logs/download")
        self.assertEqual(r.status_code, 200)
        self.assertIn("studio.log", r.headers.get("content-disposition", ""))

    def test_level_switch(self):
        r = self.client.post("/api/v1/system/logs/level", json={"level": "DEBUG"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["level"], "DEBUG")
        r = self.client.post("/api/v1/system/logs/level", json={"level": "NOPE"})
        self.assertEqual(r.status_code, 400)

    def test_unhandled_exception_handler_returns_500_and_logs(self):
        from starlette.requests import Request
        scope = {
            "type": "http", "method": "GET", "path": "/boom", "headers": [],
            "query_string": b"", "scheme": "http", "server": ("127.0.0.1", 8000),
            "root_path": "", "http_version": "1.1", "client": ("127.0.0.1", 1),
        }
        req = Request(scope)
        exc = RuntimeError("handler-marker-zxc987")
        resp = asyncio.run(self.main_mod._unhandled_exception_handler(req, exc))
        self.assertEqual(resp.status_code, 500)
        self.assertIn("handler-marker-zxc987", resp.body.decode("utf-8"))
        content = self._content()
        self.assertIn("handler-marker-zxc987", content)


if __name__ == "__main__":
    unittest.main()
