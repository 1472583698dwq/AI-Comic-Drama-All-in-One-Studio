# -*- coding: utf-8 -*-
"""文档导入任务化回归（stdlib unittest，零外部依赖）

运行：python -m unittest tests.test_provider_import_tasks -v
覆盖：
1) 导入任务记录创建 / 更新（阶段、日志、终态）
2) _import_task_run 成功路径：阶段推进 + provider 落记录
3) _import_task_run 失败路径：stage=failed 且带 error
4) POST /providers/import（async_task=True）返回 task_id，GET /providers/import/tasks/{id} 轮询到终态
5) llm_generate_code 的 on_stage 进度回调被调用
"""
import asyncio
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _req():
    from app.api.provider_routes import ProviderImportRequest
    return ProviderImportRequest(
        kind="image", name="任务化测试源",
        doc_text="POST https://api.example.com/v1/images/generations body {prompt, size}",
    )


class TestImportTaskStore(unittest.TestCase):
    def test_create_and_update(self):
        from app.api import provider_routes as pr
        tid = pr._import_task_create()
        self.assertTrue(tid.startswith("imp_"))
        rec = pr._IMPORT_TASKS[tid]
        self.assertEqual(rec["stage"], "queued")
        self.assertFalse(rec["done"])
        pr._import_task_update(tid, stage="generating_code", stage_label="生成中", log_line="step-1")
        rec = pr._IMPORT_TASKS[tid]
        self.assertEqual(rec["stage"], "generating_code")
        self.assertEqual(len(rec["log"]), 1)
        self.assertEqual(rec["log"][0]["text"], "step-1")

    def test_update_unknown_task_is_noop(self):
        from app.api import provider_routes as pr
        pr._import_task_update("imp_notexist", stage="done")  # 不应抛异常


class TestImportTaskRun(unittest.TestCase):
    def test_success_path(self):
        from app.api import provider_routes as pr
        fake_created = {
            "id": "prov_taskok", "provider": {"id": "prov_taskok", "kind": "image"},
            "compile_check": {"ok": True}, "code": "async def generate(ctx, api):\n    return {'image_url': 'u'}",
        }

        async def fake_lgc(kind, language, doc_text, name_hint="", on_stage=None):
            if on_stage:
                on_stage("正在调用 LLM 生成源代码（第 1 次）…")
                on_stage("代码生成完成")
            return "async def generate(ctx, api):\n    return {'image_url': 'https://x/y.png'}"

        tid = pr._import_task_create()
        with mock.patch.object(pr, "llm_generate_code", fake_lgc), \
                mock.patch.object(pr, "create_code_source", return_value=fake_created):
            asyncio.run(pr._import_task_run(tid, _req()))
        rec = pr._IMPORT_TASKS[tid]
        self.assertEqual(rec["stage"], "done")
        self.assertTrue(rec["done"])
        self.assertEqual(rec["result_status"], "success")
        self.assertEqual((rec.get("provider") or {}).get("id"), "prov_taskok")
        self.assertTrue(any("LLM" in x["text"] for x in rec["log"]), rec["log"])

    def test_failure_path(self):
        from app.api import provider_routes as pr

        async def fake_lgc(kind, language, doc_text, name_hint="", on_stage=None):
            raise RuntimeError("LLM 代码生成失败: boom")

        tid = pr._import_task_create()
        with mock.patch.object(pr, "llm_generate_code", fake_lgc):
            asyncio.run(pr._import_task_run(tid, _req()))
        rec = pr._IMPORT_TASKS[tid]
        self.assertEqual(rec["stage"], "failed")
        self.assertTrue(rec["done"])
        self.assertIn("boom", rec["error"])


class TestImportTaskEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import app.main as main_mod
        cls.client = TestClient(main_mod.app)

    def test_async_task_flow_and_missing(self):
        from app.api import provider_routes as pr

        async def fake_core(req, on_stage=None):
            if on_stage:
                on_stage("正在注册生成源…")
            return {"status": "success", "provider": {"id": "prov_ep"}, "mode": "llm_code",
                    "code": "async def generate(ctx, api):" + " " * 40, "compile_check": {"ok": True}}

        with mock.patch.object(pr, "_import_from_doc_core", fake_core):
            r = self.client.post("/api/v1/providers/import", json={
                "kind": "image", "name": "ep", "doc_text": "POST https://api.x.com/v1/images {}", "async_task": True,
            })
            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            self.assertEqual(body["status"], "queued")
            tid = body["task_id"]
            rec = None
            for _ in range(80):
                rr = self.client.get(f"/api/v1/providers/import/tasks/{tid}")
                self.assertEqual(rr.status_code, 200, rr.text)
                rec = rr.json()
                if rec.get("done"):
                    break
                time.sleep(0.05)
            self.assertIsNotNone(rec)
            self.assertTrue(rec.get("done"), rec)
            self.assertEqual(rec.get("result_status"), "success")
            self.assertEqual((rec.get("provider") or {}).get("id"), "prov_ep")
        r404 = self.client.get("/api/v1/providers/import/tasks/imp_notexist")
        self.assertEqual(r404.status_code, 404)

    def test_sync_mode_missing_doc_is_400(self):
        r = self.client.post("/api/v1/providers/import", json={"kind": "image"})
        self.assertEqual(r.status_code, 400, r.text)


class TestLLMGenerateCodeStages(unittest.TestCase):
    def test_on_stage_called(self):
        from app.api import provider_routes as pr

        class FakeReply:
            content = "async def generate(ctx, api):\n    return {'image_url': 'https://x/y.png'}"
            finish_reason = "stop"

        class FakeAdapter:
            async def complete(self, *a, **k):
                return FakeReply()

        stages = []
        with mock.patch("app.agent.llm.adapter.adapter", FakeAdapter()):
            out = asyncio.run(pr.llm_generate_code("image", "python", "doc " * 30, "t", on_stage=stages.append))
        self.assertIn("generate", out)
        self.assertTrue(any("LLM" in s for s in stages), stages)
        self.assertTrue(any("完成" in s for s in stages), stages)


if __name__ == "__main__":
    unittest.main()
