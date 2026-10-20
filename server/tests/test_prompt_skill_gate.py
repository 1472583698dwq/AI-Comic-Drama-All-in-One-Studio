# -*- coding: utf-8 -*-
"""提示词技能门已解除的回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_prompt_skill_gate -v
钉住现状：读技能只是建议，**不再**在执行口拦截生成/写提示词类调用。
- 未读技能：generate_image / generate_video / provider_* / canvas_execute / onekey_shot_* 直接放行；
- job_start / batch_run 的内层目标工具同样不再被拦；
- 系统提示词不再声称「未读技能会被拒绝」；
- 角色裁剪不得挡掉 read_skill（受限子代理仍可自读技能）。
"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _run(coro):
    return asyncio.run(coro)


class _OkResult:
    status = "success"
    result = {"ok": True}
    error = None


class TestPromptSkillGateRemoved(unittest.TestCase):
    def setUp(self):
        from app.agent.tools.pipeline import ToolPipeline
        self.pipe = ToolPipeline("sess_prompt_gate", lambda ev: None, interactive=False)

    def test_generation_allowed_without_skill_read(self):
        from app.mcp.server import mcp_registry
        orig = mcp_registry.execute_tool

        async def fake(tool_name, args, *a, **kw):
            return _OkResult()

        cases = [
            ("generate_image", {"prompt": "x"}),
            ("generate_video", {"prompt": "x"}),
            ("provider_demo_img", {"prompt": "x"}),
            ("canvas_execute", {}),
            ("onekey_shot_video", {"draft_id": "d", "shot_index": 1}),
        ]
        try:
            mcp_registry.execute_tool = fake
            for tool, args in cases:
                out = _run(self.pipe.execute("c_" + tool, tool, args, run_mode="auto"))
                self.assertNotEqual(out.status, "denied", f"{tool} 不应再因未读技能被拒")
                self.assertFalse(out.meta.get("prompt_skill_gate"), f"{tool} 不应带门控 meta")
                if tool != "onekey_shot_video":  # 该工具走本地草稿逻辑，draft_id 不存在返回 error
                    self.assertEqual(out.status, "success", f"{tool} 应正常执行")
        finally:
            mcp_registry.execute_tool = orig

    def test_wrappers_not_blocked(self):
        from app.mcp.server import mcp_registry
        orig = mcp_registry.execute_tool

        async def fake(tool_name, args, *a, **kw):
            return _OkResult()

        try:
            mcp_registry.execute_tool = fake
            out = _run(self.pipe.execute("w1", "job_start",
                                         {"tool": "generate_image", "arguments": {"prompt": "x"}},
                                         run_mode="auto"))
            self.assertNotEqual(out.status, "denied")
            out2 = _run(self.pipe.execute("w2", "batch_run",
                                          {"tool": "generate_video", "items": [{"prompt": "x"}]},
                                          run_mode="auto"))
            self.assertNotEqual(out2.status, "denied")
        finally:
            mcp_registry.execute_tool = orig

    def test_read_skill_still_works(self):
        from app.mcp.server import mcp_registry
        orig = mcp_registry.execute_tool

        async def fake(tool_name, args, *a, **kw):
            return _OkResult()

        try:
            mcp_registry.execute_tool = fake
            out = _run(self.pipe.execute("r1", "read_skill", {"name": "prompt-basics"}, run_mode="auto"))
            self.assertEqual(out.status, "success")
            self.assertIn("prompt-basics", self.pipe.skills_read)
        finally:
            mcp_registry.execute_tool = orig

    def test_restricted_profile_can_read_skill(self):
        from app.agent.runtime.agents import get_profile
        prof = get_profile("video_operator")
        self.assertTrue(prof.allows("read_skill"))
        self.assertTrue(prof.allows("onekey_shot_video"))
        self.assertTrue(prof.allows("fs_read"))

    def test_system_prompt_no_hard_gate_claim(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(run_mode="approve")
        self.assertNotIn("未读技能的生成调用", p)
        self.assertNotIn("硬门控直接拒绝", p)
        self.assertIn("read_skill", p)


if __name__ == "__main__":
    unittest.main(verbosity=2)
