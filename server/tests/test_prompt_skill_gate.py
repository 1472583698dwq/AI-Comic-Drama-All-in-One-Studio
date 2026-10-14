# -*- coding: utf-8 -*-
"""提示词技能门回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_prompt_skill_gate -v
钉住「写提示词调生成源前必须先读技能」的执行口硬门控：
- 未读技能：生成/写提示词类调用一律 denied，并给出 read_skill 指路；
- read_skill 只列清单（不带 name）不算读；具名读取成功才解锁；
- job_start / batch_run 的内层目标工具同样受门控；
- 门控可用 STUDIO_PROMPT_SKILL_GATE=0 关闭（逃生口）；
- 角色裁剪不得挡掉 read_skill（否则受限子代理无法自读，死锁）。
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


class TestPromptSkillGate(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.get("STUDIO_PROMPT_SKILL_GATE")
        os.environ.pop("STUDIO_PROMPT_SKILL_GATE", None)
        from app.agent.tools.pipeline import ToolPipeline
        self.pipe = ToolPipeline("sess_prompt_gate", lambda ev: None, interactive=False)

    def tearDown(self):
        if self._orig_env is None:
            os.environ.pop("STUDIO_PROMPT_SKILL_GATE", None)
        else:
            os.environ["STUDIO_PROMPT_SKILL_GATE"] = self._orig_env

    def test_generation_denied_without_skill_read(self):
        cases = [
            ("generate_image", {"prompt": "x"}),
            ("generate_video", {"prompt": "x"}),
            ("provider_demo_img", {"prompt": "x"}),
            ("canvas_execute", {}),
            ("onekey_shot_video", {"draft_id": "d", "shot_index": 1}),
        ]
        for tool, args in cases:
            out = _run(self.pipe.execute("c_" + tool, tool, args, run_mode="auto"))
            self.assertEqual(out.status, "denied", f"{tool} 未读技能应被拒")
            self.assertIn("read_skill", out.error or "")
            self.assertIn("执行口", out.error or "")
            self.assertTrue(out.meta.get("prompt_skill_gate"))

    def test_named_skill_read_unlocks_but_list_does_not(self):
        from app.mcp.server import mcp_registry
        orig = mcp_registry.execute_tool

        async def fake(tool_name, args, *a, **kw):
            return _OkResult()

        try:
            mcp_registry.execute_tool = fake
            _run(self.pipe.execute("r1", "read_skill", {}, run_mode="auto"))
            denied = _run(self.pipe.execute("c1", "generate_image", {"prompt": "x"}, run_mode="auto"))
            self.assertEqual(denied.status, "denied", "只列清单不算读技能")

            read = _run(self.pipe.execute("r2", "read_skill", {"name": "prompt-basics"}, run_mode="auto"))
            self.assertEqual(read.status, "success")
            passed = _run(self.pipe.execute("c2", "generate_image", {"prompt": "x"}, run_mode="auto"))
            self.assertNotEqual(passed.status, "denied", "具名读技能后应放行")
        finally:
            mcp_registry.execute_tool = orig

    def test_wrappers_gated_by_inner_tool(self):
        out = _run(self.pipe.execute("w1", "job_start",
                                     {"tool": "generate_image", "arguments": {"prompt": "x"}},
                                     run_mode="auto"))
        self.assertEqual(out.status, "denied")
        self.assertIn("generate_image", out.error or "")
        out2 = _run(self.pipe.execute("w2", "batch_run",
                                      {"tool": "generate_video", "items": [{"prompt": "x"}]},
                                      run_mode="auto"))
        self.assertEqual(out2.status, "denied")

    def test_env_escape_hatch(self):
        os.environ["STUDIO_PROMPT_SKILL_GATE"] = "0"
        from app.mcp.server import mcp_registry
        orig = mcp_registry.execute_tool

        async def fake(tool_name, args, *a, **kw):
            return _OkResult()

        try:
            mcp_registry.execute_tool = fake
            out = _run(self.pipe.execute("c1", "generate_image", {"prompt": "x"}, run_mode="auto"))
            self.assertEqual(out.status, "success", "关闭门控后不再拦截")
        finally:
            mcp_registry.execute_tool = orig

    def test_restricted_profile_can_read_skill(self):
        from app.agent.runtime.agents import get_profile
        prof = get_profile("video_operator")
        self.assertTrue(prof.allows("read_skill"), "受限角色必须能自读技能，否则门控死锁")
        self.assertTrue(prof.allows("onekey_shot_video"))
        self.assertTrue(prof.allows("fs_read"))

    def test_system_prompt_states_gate(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(run_mode="approve")
        self.assertIn("未读技能的生成调用", p)


if __name__ == "__main__":
    unittest.main(verbosity=2)
