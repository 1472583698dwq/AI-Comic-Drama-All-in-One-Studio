# -*- coding: utf-8 -*-
"""生成源代码异步契约回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_codegen -v
验收：
1) 生成提示词包含"提交/查询"双分支硬契约（不再出现"代码内 while 轮询"的矛盾指令）；
2) 框架守卫能识别"查询调用返回新 task_id"的坏源（缺查询分支）并 FAILED 明错。
"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _defn(code: str):
    from app.models.provider_definition import ProviderDefinition
    return ProviderDefinition(
        id="prov_codegen_test", name="生成契约测试源", kind="video",
        provider_type="code", language="python", code=code, code_entry="generate",
    )


class TestCodeGenPromptContract(unittest.TestCase):
    def test_async_two_branch_contract_in_prompt(self):
        from app.api.provider_routes import code_gen_system_prompt
        p = code_gen_system_prompt("video", "python")
        for kw in ("提交分支", "查询分支", "dynamic_inputs", "SUBMITTED", "同一个id", "缺少查询分支"):
            self.assertIn(kw, p, f"生成提示词缺少异步契约关键项: {kw}")
        self.assertNotIn("while/for+sleep", p)


class TestQueryBranchGuard(unittest.TestCase):
    def _query(self, code: str, tid: str):
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.generic import code_provider as cp
        self.addCleanup(cp._CODE_VIDEO_TASKS.pop, tid, None)
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=_defn(code)):
            return asyncio.run(cp.query_code_task_once("prov_codegen_test", tid))

    def test_resubmit_new_task_id_fails_with_hint(self):
        code = (
            "async def generate(ctx, api):\n"
            "    return {'task_id': 'brand_new', 'status': 'SUBMITTED'}\n"
        )
        res = self._query(code, "old_task")
        self.assertEqual(res.get("status"), "FAILED")
        self.assertIn("查询分支", res.get("error") or "")

    def test_correct_query_branch_keeps_same_id(self):
        code = (
            "async def generate(ctx, api):\n"
            "    tid = (ctx.get('task_id') or (ctx.get('dynamic_inputs') or {}).get('task_id') or '').strip()\n"
            "    if tid and not (ctx.get('prompt') or '').strip():\n"
            "        return {'video_url': None, 'task_id': tid, 'status': 'RUNNING'}\n"
            "    return {'task_id': 'new', 'status': 'SUBMITTED'}\n"
        )
        res = self._query(code, "same_task")
        self.assertEqual(res.get("status"), "RUNNING")
        self.assertNotIn("查询分支", res.get("error") or "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
