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
    def test_run_modes_are_six_tokens(self):
        self.assertEqual(
            list(RUN_MODES),
            ["approve", "auto", "create", "create_auto", "plan", "plan_auto"],
        )

    def test_aliases_normalize_to_composed_token(self):
        cases = {
            "supervisor": "approve", "standard": "approve", "ask": "approve", "default": "approve",
            "automation": "auto", "never": "auto", "yolo": "auto",
            "creator": "create", "creative": "create",
            "planning": "plan", "readonly": "plan",
            "create-auto": "create_auto", "create+auto": "create_auto", "auto_create": "create_auto",
            "plan-auto": "plan_auto", "auto_plan": "plan_auto",
            "": "approve", None: "approve", "不认识的": "approve",
        }
        for raw, want in cases.items():
            self.assertEqual(normalize_run_mode(raw), want, raw)

    def test_dimension_derivation(self):
        self.assertEqual(behavior_of("approve"), "standard")
        self.assertEqual(behavior_of("auto"), "standard")
        self.assertEqual(behavior_of("create"), "create")
        self.assertEqual(behavior_of("create_auto"), "create")
        self.assertEqual(behavior_of("plan"), "plan")
        self.assertEqual(behavior_of("plan_auto"), "plan")
        self.assertEqual(execution_of("approve"), "approve")
        self.assertEqual(execution_of("auto"), "auto")
        self.assertEqual(execution_of("create"), "approve")
        self.assertEqual(execution_of("create_auto"), "auto")
        self.assertEqual(execution_of("plan_auto"), "auto")

    def test_compose_roundtrip(self):
        for b in ("standard", "create", "plan"):
            for e in ("approve", "auto"):
                token = compose_run_mode(b, e)
                self.assertEqual(behavior_of(token), b)
                self.assertEqual(execution_of(token), e, f"{b}+{e}={token}")
        self.assertEqual(compose_run_mode("乱填", "乱填"), "approve")


class TestRequiresConfirm(unittest.TestCase):
    def test_approve_asks_for_medium_and_above(self):
        self.assertTrue(requires_confirm("generate_image", "approve"))
        self.assertTrue(requires_confirm("generate_video", "approve"))
        self.assertFalse(requires_confirm("list_assets", "approve"))

    def test_auto_never_asks_even_catastrophic(self):
        # 「自动执行」= 全自动：连删源/可信写/命令都不再逐项确认（风险由前端危险态 + 随时暂停兜底）
        for mode in ("auto", "create_auto", "plan_auto"):
            for tool in ("delete_custom_provider", "shell_exec", "fs_file", "canvas_delete_node"):
                self.assertFalse(requires_confirm(tool, mode), f"{tool}@{mode}")

    def test_plan_never_asks(self):
        self.assertFalse(requires_confirm("generate_video", "plan"))
        self.assertFalse(requires_confirm("canvas_delete_node", "plan_auto"))

    def test_create_review_tools_gated_only_in_approve_execution(self):
        for tool in ("creator_start_test", "creator_finalize",
                     "register_custom_provider", "update_custom_provider"):
            self.assertTrue(requires_confirm(tool, "create"), tool)
        # 创造+自动：提案链不再等人点，随自动执行推进
        self.assertFalse(requires_confirm("creator_finalize", "create_auto"))
        # 标准行为下同类工具属 medium → 审批模式仍拦
        self.assertTrue(requires_confirm("creator_start_test", "approve"))
        # 提案本身不生效（仅写临时文件），任何模式都不拦
        self.assertFalse(requires_confirm("creator_propose_capability", "approve"))


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

    def test_approve_execution_still_asks(self):
        p, _ = self.make_pipeline(interactive=False)
        p.skills_read.add("prompt-basics")
        out = run(p.execute("c1", "generate_video", {"prompt": "x"}, run_mode="approve"))
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

    def test_plan_off_restores_previous_combo(self):
        lp = self.make_loop(run_mode="create_auto")
        lp.set_run_mode("plan")
        self.assertTrue(lp.plan_mode)
        self.assertEqual(lp._pre_plan_run_mode, "create_auto")
        lp.set_run_mode(lp._pre_plan_run_mode)
        self.assertEqual(lp.run_mode, "create_auto")
        self.assertFalse(lp.plan_mode)

    def test_plan_auto_is_readonly_behavior(self):
        lp = self.make_loop(run_mode="approve")
        lp.set_run_mode("plan_auto")
        self.assertTrue(lp.plan_mode)
        self.assertTrue(lp.pipeline.plan_mode)
        self.assertEqual(lp.run_mode, "plan_auto")


class TestHotSwitchExecutionDim(TempStore):
    """执行维=auto 即放行挂起审批：create_auto 不能因为不是字符串 "auto" 而被漏判。"""

    def test_switch_to_create_auto_resolves_pending(self):
        from app.agent.runtime.loop import AgentLoop
        sid = self.unique("hot_create_auto")
        lp = AgentLoop(sid, run_mode="create", mode="execute", interactive=True, store=self.store)
        lp.pipeline.skills_read.add("prompt-basics")  # 预读技能解锁提示词门控，聚焦审批热切换
        events = []
        lp.attach(lambda ev: events.append(ev))

        async def scenario():
            task = asyncio.create_task(lp.pipeline.execute(
                "c1", "generate_video", {"prompt": "x"}, run_mode=lp.run_mode))
            for _ in range(200):
                if any(e.get("event") == "approval_required" for e in events):
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(any(e.get("event") == "approval_required" for e in events))
            await lp.apply_run_mode("create_auto")
            return await task

        out = run(scenario())
        self.assertEqual(lp.run_mode, "create_auto")
        self.assertIn(out.status, ("success", "error"))
        acks = [e for e in events if e.get("event") == "approval_ack"]
        self.assertEqual(len(acks), 1)
        self.assertTrue(acks[0]["approved"])
        self.assertTrue(acks[0]["resolved"])


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
