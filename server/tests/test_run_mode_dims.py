# -*- coding: utf-8 -*-
"""运行模式「行为 × 执行」双维口径回归测试（stdlib unittest）。

运行： python -m unittest tests.test_run_mode_dims -v
覆盖：组合 token 归一/别名、两维派生与合成、requires_confirm 矩阵、plan 行为在 pipeline 层硬门控、
      /plan 进出栈原样回退、切自动（含 create_auto）放行挂起审批、系统提示词按两维装配。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.mode_policy import (  # noqa: E402
    RUN_MODES, behavior_of, compose_run_mode, execution_of, normalize_run_mode, requires_confirm,
)
from app.agent.runtime.store import SessionStore  # noqa: E402

_LOOP = None


def run(coro):
    """显式复用测试事件循环（与 test_agent_runtime 同口径）。"""
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


class TempStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="agent_dims_")
        cls.store = SessionStore(Path(cls._tmp))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def unique(self, prefix: str) -> str:
        import uuid
        return f"{prefix}_{uuid.uuid4().hex[:8]}"


class TestCompose(unittest.TestCase):
    def test_run_modes_are_three_tokens(self):
        self.assertEqual(list(RUN_MODES), ["plan", "auto", "create"])

    def test_aliases_normalize_to_new_tokens(self):
        cases = {
            "approve": "auto", "supervisor": "auto", "standard": "auto",
            "ask": "auto", "default": "auto", "automation": "auto",
            "never": "auto", "yolo": "auto",
            "creator": "create", "creative": "create",
            "create_auto": "create", "create-auto": "create", "auto_create": "create",
            "planning": "plan", "readonly": "plan",
            "plan_auto": "plan", "plan-auto": "plan", "auto_plan": "plan",
            "": "auto", None: "auto", "不认识的": "auto",
        }
        for raw, want in cases.items():
            self.assertEqual(normalize_run_mode(raw), want, raw)

    def test_dimension_derivation(self):
        self.assertEqual(behavior_of("auto"), "auto")
        self.assertEqual(behavior_of("create"), "create")
        self.assertEqual(behavior_of("plan"), "plan")
        self.assertEqual(behavior_of("approve"), "auto")
        self.assertEqual(execution_of("auto"), "auto")
        self.assertEqual(execution_of("create"), "auto")
        self.assertEqual(execution_of("plan"), "approve")

    def test_compose_roundtrip(self):
        self.assertEqual(compose_run_mode("plan", "auto"), "plan")
        self.assertEqual(compose_run_mode("create", "approve"), "create")
        self.assertEqual(compose_run_mode("standard", "approve"), "auto")
        self.assertEqual(compose_run_mode("乱填", "乱填"), "auto")


class TestRequiresConfirm(unittest.TestCase):
    def test_auto_allows_read_and_generate_but_asks_for_writes(self):
        self.assertFalse(requires_confirm("list_assets", "auto"))
        self.assertFalse(requires_confirm("generate_image", "auto"))
        self.assertFalse(requires_confirm("canvas_create_node", "auto"))
        self.assertTrue(requires_confirm("register_custom_provider", "auto"))
        self.assertTrue(requires_confirm("delete_custom_provider", "auto"))
        self.assertTrue(requires_confirm("shell_exec", "auto"))

    def test_plan_never_asks(self):
        self.assertFalse(requires_confirm("generate_video", "plan"))
        self.assertFalse(requires_confirm("canvas_delete_node", "plan"))
        self.assertFalse(requires_confirm("canvas_delete_node", "plan_auto"))

    def test_create_review_tools_are_gated(self):
        for tool in ("creator_start_test", "creator_finalize",
                     "register_custom_provider", "update_custom_provider"):
            self.assertTrue(requires_confirm(tool, "create"), tool)
        self.assertFalse(requires_confirm("creator_propose_capability", "create"))


class TestPipelineBehaviorGate(TempStore):
    def make_pipeline(self, plan_mode=False, interactive=True):
        from app.agent.tools.pipeline import ToolPipeline
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline(self.unique("pipe"), emit, plan_mode=plan_mode, interactive=interactive)
        return p, events

    def test_plan_behavior_denies_writes_without_plan_mode_flag(self):
        # pipeline.plan_mode 由 loop 同步；此处刻意留 False，验证执行口按 run_mode 行为维独立硬门控
        p, _ = self.make_pipeline(plan_mode=False)
        out = run(p.execute("c1", "canvas_create_node", {"type": "image"}, run_mode="plan_auto"))
        self.assertEqual(out.status, "denied")
        self.assertIn("只读工具", out.error or "")

    def test_auto_execution_skips_approval_for_high_risk(self):
        p, events = self.make_pipeline(interactive=True)
        p.skills_read.add("prompt-basics")
        out = run(p.execute("c1", "generate_video", {"prompt": "x"}, run_mode="create_auto"))
        # 未走审批：该工具不存在 → error；关键是没弹审批、也没被判 denied
        self.assertNotEqual(out.status, "denied")
        self.assertFalse([e for e in events if e.get("event") == "approval_required"])

    def test_auto_mode_still_asks_for_admin(self):
        p, _ = self.make_pipeline(interactive=False)
        out = run(p.execute("c1", "register_custom_provider", {"kind": "image"}, run_mode="auto"))
        self.assertEqual(out.status, "denied")


class TestPlanRoundTrip(TempStore):
    def make_loop(self, run_mode="approve"):
        from app.agent.runtime.loop import AgentLoop
        from app.agent.tools.pipeline import ToolOutcome

        class FakePipeline:
            plan_mode = False

            async def execute(self, call_id, name, args, project_context=None,
                              run_mode="approve", auto_approved=False):
                return ToolOutcome(call_id, name, "success", result={"ok": True})

        lp = AgentLoop(self.unique("dims"), run_mode=run_mode, mode="execute", store=self.store)
        lp.pipeline = FakePipeline()
        return lp

    def test_plan_off_restores_previous_mode(self):
        lp = self.make_loop(run_mode="create")
        lp.set_run_mode("plan")
        self.assertTrue(lp.plan_mode)
        self.assertEqual(lp._pre_plan_run_mode, "create")
        lp.set_run_mode(lp._pre_plan_run_mode)
        self.assertEqual(lp.run_mode, "create")
        self.assertFalse(lp.plan_mode)

    def test_plan_auto_is_readonly_behavior(self):
        lp = self.make_loop(run_mode="auto")
        lp.set_run_mode("plan_auto")
        self.assertTrue(lp.plan_mode)
        self.assertTrue(lp.pipeline.plan_mode)
        self.assertEqual(lp.run_mode, "plan")


class TestHotSwitchExecutionDim(TempStore):
    def test_mode_switch_does_not_auto_approve_pending_ask(self):
        from app.agent.runtime.loop import AgentLoop
        sid = self.unique("hot_mode_switch")
        lp = AgentLoop(sid, run_mode="auto", mode="execute", interactive=True, store=self.store)
        events = []
        lp.attach(lambda ev: events.append(ev))

        async def scenario():
            task = asyncio.create_task(lp.pipeline.execute(
                "c1", "register_custom_provider", {"kind": "image"}, run_mode=lp.run_mode))
            for _ in range(200):
                if any(e.get("event") == "approval_required" for e in events):
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(any(e.get("event") == "approval_required" for e in events))
            pending = list(lp.pipeline.approvals._pending.keys())
            self.assertEqual(len(pending), 1)
            await lp.apply_run_mode("create")
            self.assertEqual(len(lp.pipeline.approvals._pending), 1)
            lp.pipeline.resolve_approval(pending[0], False)
            return await task

        out = run(scenario())
        self.assertEqual(lp.run_mode, "create")
        self.assertEqual(out.status, "denied")


class TestModeSwitchApproval(TempStore):
    def test_request_create_requires_user_approval(self):
        from app.agent.tools.pipeline import ToolPipeline
        events = []
        switched = []

        async def emit(ev):
            events.append(ev)

        pipe = ToolPipeline(self.unique("mode_switch"), emit, interactive=True)
        pipe.mode_switch_callback = switched.append

        async def scenario():
            task = asyncio.create_task(pipe.execute(
                "c1", "request_mode_switch", {"target": "create", "reason": "需要造能力"},
                run_mode="auto"))
            for _ in range(200):
                if any(e.get("event") == "approval_required" for e in events):
                    break
                await asyncio.sleep(0.01)
            pending = list(pipe.approvals._pending.keys())
            self.assertEqual(len(pending), 1)
            self.assertEqual(switched, [])
            pipe.resolve_approval(pending[0], True)
            return await task

        out = run(scenario())
        self.assertEqual(out.status, "success")
        self.assertEqual(switched, ["create"])


class TestPromptDims(unittest.TestCase):
    def test_create_auto_includes_both_sections(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(plan_mode=False, run_mode="create_auto")
        self.assertIn("## 创造模式", p)
        self.assertIn("## 自动执行", p)

    def test_plan_auto_is_plan_only(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(plan_mode=False, run_mode="plan_auto")
        self.assertIn("PLAN MODE", p)
        self.assertNotIn("## 自动执行", p)

    def test_standard_auto_has_no_create_section(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(plan_mode=False, run_mode="auto")
        self.assertIn("## 自动执行", p)
        self.assertNotIn("## 创造模式", p)


if __name__ == "__main__":
    unittest.main()
