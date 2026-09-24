# -*- coding: utf-8 -*-
"""Agent runtime 回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_agent_runtime -v
覆盖：历史裁剪配对安全、事件模型、会话日志（含撕裂尾）、derive_messages、
Inbox 三通道、turn/step 状态机、工具管线门控、审批 fail-closed、abort、计划模式。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.llm.adapter import AssistantReply, ToolCall  # noqa: E402
from app.agent.runtime import events as E  # noqa: E402
from app.agent.runtime.inbox import Inbox  # noqa: E402
from app.agent.runtime.session import Session  # noqa: E402
from app.agent.runtime.store import SessionStore  # noqa: E402


_LOOP = None


def run(coro):
    """显式复用测试事件循环（避免跨模块 get_event_loop 状态漂移）。"""
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


class TempStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="agent_rt_")
        cls.store = SessionStore(Path(cls._tmp))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def unique(self, prefix: str) -> str:
        import uuid
        return f"{prefix}_{uuid.uuid4().hex[:8]}"


class TestEvents(TempStore):
    def test_unknown_event_rejected(self):
        with self.assertRaises(ValueError):
            E.validate_event(E.make_event("some/unknown"))

    def test_open_turn_detection(self):
        evs = [
            {"type": E.TURN_START, "seq": 1},
            {"type": E.TURN_END, "seq": 2},
            {"type": E.TURN_START, "seq": 3},
        ]
        self.assertEqual(E.open_turn_seq(evs), 3)
        evs.append({"type": E.TURN_END, "seq": 4})
        self.assertIsNone(E.open_turn_seq(evs))


class TestStore(TempStore):
    def test_append_read_and_torn_tail(self):
        sid = self.unique("store")
        self.store.append(sid, [{"type": E.TURN_START, "seq": 1, "data": {}}])
        self.store.append(sid, [{"type": E.TURN_END, "seq": 2, "data": {"reason": "completed"}}])
        events = self.store.read(sid)
        self.assertEqual([e["type"] for e in events], [E.TURN_START, E.TURN_END])
        # 模拟崩溃留下半行
        p = self.store.path_for(sid)
        with open(p, "a", encoding="utf-8") as f:
            f.write('{"type": "turn/sta')
        events = self.store.read(sid)
        self.assertEqual(len(events), 2)


class TestSession(TempStore):
    def test_derive_messages_pairs_tool_calls(self):
        sid = self.unique("sess")
        s = Session.open(sid, store=self.store)
        s.append(E.USER_MESSAGE, {"text": "生成一张图", "source": "user"})
        s.append(E.ASSISTANT_MESSAGE, {
            "text": "", "tool_calls": [{"id": "c1", "name": "generate_image",
                                        "arguments": json.dumps({"prompt": "x"})}],
        })
        s.append(E.TOOL_RESULT, {"call_id": "c1", "name": "generate_image",
                                 "status": "success", "result": {"image_url": "http://a.png"}})
        s.append(E.ASSISTANT_MESSAGE, {"text": "已完成"})
        msgs = s.derive_messages(system_text="SYS")
        self.assertEqual(msgs[0], {"role": "system", "content": "SYS"})
        self.assertEqual(msgs[1]["role"], "user")
        self.assertEqual(msgs[2]["role"], "assistant")
        self.assertEqual(msgs[2]["tool_calls"][0]["function"]["name"], "generate_image")
        self.assertEqual(msgs[3]["role"], "tool")
        self.assertEqual(msgs[3]["tool_call_id"], "c1")
        self.assertIn("a.png", msgs[3]["content"])
        self.assertEqual(msgs[4]["content"], "已完成")

    def test_attempt_not_in_history(self):
        sid = self.unique("sess_attempt")
        s = Session.open(sid, store=self.store)
        s.append(E.USER_MESSAGE, {"text": "hi"})
        s.append(E.ASSISTANT_ATTEMPT, {"error": "boom"})
        msgs = s.derive_messages()
        self.assertEqual([m["role"] for m in msgs], ["user"])

    def test_compaction_shadowing(self):
        sid = self.unique("sess_comp")
        s = Session.open(sid, store=self.store)
        e1 = s.append(E.USER_MESSAGE, {"text": "第1条"})
        e2 = s.append(E.ASSISTANT_MESSAGE, {"text": "回复1"})
        s.append(E.COMPACTION_SUMMARY, {"text": "摘要：用户要求生成", "shadowed_seqs": [e1["seq"], e2["seq"]]})
        s.append(E.USER_MESSAGE, {"text": "第2条"})
        msgs = s.derive_messages(system_text="S")
        self.assertEqual([m["content"] for m in msgs[1:]], ["摘要：用户要求生成", "第2条"])

    def test_repair_interrupted(self):
        sid = self.unique("sess_repair")
        s = Session.open(sid, store=self.store)
        s.append(E.TURN_START, {"mode": "execute"})
        s.append(E.TOOL_CALL, {"call_id": "cx", "name": "generate_video", "arguments": {}})
        # 重新打开触发修复
        s2 = Session.open(sid, store=self.store)
        types = [ev["type"] for ev in s2.events]
        self.assertIn(E.TOOL_RESULT, types)
        self.assertIn(E.TURN_END, types)
        end = [ev for ev in s2.events if ev["type"] == E.TURN_END][-1]
        self.assertEqual(end["data"]["reason"], "interrupted")


class TestInbox(unittest.TestCase):
    def test_claim_semantics(self):
        ib = Inbox()
        ib.followup("第一轮")
        ib.steer("插话")
        ib.inject("通知")
        first = ib.claim()
        self.assertEqual([m.text for m in first], ["插话", "通知", "第一轮"])
        self.assertFalse(ib.has_pending())
        ib.followup("第二轮")
        self.assertTrue(ib.has_pending())
        self.assertEqual([m.text for m in ib.claim()], ["第二轮"])

    def test_steer_only_one_followup_per_turn(self):
        ib = Inbox()
        ib.followup("A")
        ib.followup("B")
        claimed = ib.claim()
        self.assertEqual(len(claimed), 1)  # 一轮只开一条 followup
        self.assertTrue(ib.has_pending())


class FakePipeline:
    """替换真实工具执行，记录调用。"""

    def __init__(self, outcomes=None):
        self.calls = []
        self.outcomes = outcomes or {}

    async def execute(self, call_id, name, args, project_context=None, run_mode="approve"):
        from app.agent.tools.pipeline import ToolOutcome
        self.calls.append((name, args, run_mode))
        o = self.outcomes.get(name)
        if isinstance(o, ToolOutcome):
            o.call_id, o.name = call_id, name
            return o
        return ToolOutcome(call_id, name, "success", result={"ok": True},
                           model_content=json.dumps({"ok": True}))

    def resolve_approval(self, approval_id, approved):
        return False

    class _Guard:
        def reset(self):
            pass

        def observe(self, *a, **k):
            return None

    guard = _Guard()


class AgentLoopTest(TempStore):
    def make_loop(self, session_prefix, mode="execute", run_mode="approve"):
        from app.agent.runtime.loop import AgentLoop
        sid = self.unique(session_prefix)
        lp = AgentLoop(sid, run_mode=run_mode, mode=mode, store=self.store)
        lp.pipeline = FakePipeline()
        return lp

    def fake_model(self, lp, replies):
        """按脚本逐一返回 AssistantReply，并记录每次 messages。"""
        import app.agent.runtime.loop as loop_mod
        calls = []

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            calls.append({"messages": messages, "tools": tools})
            if not replies:
                return AssistantReply(content="（无更多脚本）")
            return replies.pop(0)

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        return calls

    def test_single_tool_turn(self):
        lp = self.make_loop("loop_tool")
        replies_alias = [
            AssistantReply(content="", tool_calls=[ToolCall(id="c1", name="generate_image", arguments="{}", parsed={})]),
            AssistantReply(content="图片已生成"),
        ]
        calls = self.fake_model(lp, replies_alias)
        events = []
        lp.attach(lambda ev: events.append(dict(ev)))
        run(lp.prompt("生成一张图", context={}))
        run(lp.wait_idle(timeout=10))
        types = [ev["type"] for ev in lp.session.events]
        self.assertIn(E.TURN_START, types)
        self.assertIn(E.TOOL_CALL, types)
        self.assertIn(E.TOOL_RESULT, types)
        self.assertEqual(types[-1], E.TURN_END)
        self.assertEqual([e for e in lp.session.events if e["type"] == E.TURN_END][-1]["data"]["reason"], "completed")
        # 第二次请求必须带上第一次的工具结果
        self.assertEqual(len(calls), 2)
        roles = [m["role"] for m in calls[1]["messages"]]
        self.assertIn("tool", roles)
        # 实时事件
        ev_names = [e.get("event") for e in events]
        self.assertIn("tool_calling", ev_names)
        self.assertIn("tool_result", ev_names)
        self.assertIn("agent_response", ev_names)

    def test_multi_step_queueing(self):
        lp = self.make_loop("loop_queue")
        self.fake_model(lp, [
            AssistantReply(content="第一轮完成"),
            AssistantReply(content="第二轮完成"),
        ])
        run(lp.prompt("任务A"))
        # 运行中再发一条：followup 排队成第二轮
        run(lp.prompt("任务B"))
        run(lp.wait_idle(timeout=10))
        turn_ends = [e for e in lp.session.events if e["type"] == E.TURN_END]
        self.assertGreaterEqual(len(turn_ends), 2)
        msgs = lp.session.derive_messages()
        user_texts = [m["content"] for m in msgs if m["role"] == "user"]
        self.assertIn("任务A", user_texts)
        self.assertIn("任务B", user_texts)

    def test_steer_mid_run(self):
        lp = self.make_loop("loop_steer")
        released = asyncio.Event()
        first_entered = asyncio.Event()
        import app.agent.runtime.loop as loop_mod
        calls = []

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            calls.append(messages)
            if len(calls) == 1:
                first_entered.set()
                # 模型思考期间等待插话入队
                await released.wait()
                return AssistantReply(content="", tool_calls=[ToolCall(id="c1", name="canvas_query", arguments="{}", parsed={})])
            return AssistantReply(content="已按插话调整")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))

        async def scenario():
            await lp.prompt("先查画布")
            await first_entered.wait()
            await lp.steer("改成先规划再做")
            released.set()
            await lp.wait_idle(timeout=10)

        run(scenario())
        user_texts = [m["content"] for m in lp.session.derive_messages() if m["role"] == "user"]
        self.assertIn("改成先规划再做", user_texts)
        # 插话在同一个 turn 内被领取（turn 数量为 1）
        self.assertEqual(len([e for e in lp.session.events if e["type"] == E.TURN_START]), 1)

    def test_abort_records_reason(self):
        lp = self.make_loop("loop_abort")
        started = asyncio.Event()
        import app.agent.runtime.loop as loop_mod

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            started.set()
            await asyncio.sleep(30)
            return AssistantReply(content="never")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))

        async def scenario():
            await lp.prompt("长任务")
            await started.wait()
            await lp.abort("user")
        run(scenario())
        ends = [e for e in lp.session.events if e["type"] == E.TURN_END]
        self.assertTrue(ends)
        self.assertEqual(ends[-1]["data"]["reason"], "aborted")

    def test_plan_mode_restricts_tools(self):
        lp = self.make_loop("loop_plan", run_mode="plan")
        seen = {}
        import app.agent.runtime.loop as loop_mod

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            seen["tools"] = tools or []
            return AssistantReply(content="# 计划：\n1. 侦察\n2. 生成")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        run(lp.prompt("给我一个计划"))
        run(lp.wait_idle(timeout=10))
        names = {t["function"]["name"] for t in seen["tools"]}
        self.assertIn("canvas_query", names)
        self.assertNotIn("generate_image", names)
        self.assertNotIn("generate_video", names)

    def test_history_trim_keeps_pairs(self):
        from app.pipelines.agent.langchain_engine import _trim_history
        try:
            from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
        except Exception:
            self.skipTest("langchain_core 不可用")
        history = []
        for i in range(30):
            history.append(HumanMessage(content=f"u{i}"))
            history.append(AIMessage(content="", tool_calls=[{"name": "t", "args": {}, "id": f"c{i}"}]))
            history.append(ToolMessage(content="ok", tool_call_id=f"c{i}", name="t"))
        trimmed = _trim_history(history)
        self.assertTrue(trimmed)
        self.assertIsInstance(trimmed[0], HumanMessage)


class TestToolPipeline(TempStore):
    def make_pipeline(self, plan_mode=False, interactive=True):
        from app.agent.tools.pipeline import ToolPipeline
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline(self.unique("pipe"), emit, plan_mode=plan_mode, interactive=interactive)
        return p, events

    def test_plan_mode_denies_write_tools(self):
        p, _ = self.make_pipeline(plan_mode=True)
        out = run(p.execute("c1", "generate_image", {"prompt": "x"}))
        self.assertEqual(out.status, "denied")
        self.assertIn("计划模式", out.error)

    def test_approval_fail_closed_without_channel(self):
        p, _ = self.make_pipeline(interactive=False)
        out = run(p.execute("c1", "generate_video", {"prompt": "x"}, run_mode="approve"))
        self.assertEqual(out.status, "denied")

    def test_approval_granted_via_future(self):
        p, events = self.make_pipeline(interactive=True)

        async def scenario():
            task = asyncio.create_task(p.execute("c1", "generate_video", {"prompt": "x"}, run_mode="approve"))
            # 等审批请求事件
            for _ in range(100):
                req = next((e for e in events if e.get("event") == "approval_required"), None)
                if req:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(req)
            self.assertTrue(p.resolve_approval(req["approval_id"], True))
            # 真实执行会被 mcp 拒绝（工具不存在），但审批已放行
            out = await task
            self.assertIn(out.status, ("success", "error"))

        run(scenario())

    def test_repeat_guard_thresholds(self):
        from app.agent.tools.pipeline import RepeatToolGuard
        g = RepeatToolGuard(thresholds=(3, 5, 8))
        args = {"prompt": "same"}
        notes = [g.observe("generate_image", args, "success") for _ in range(8)]
        self.assertIsNone(notes[0])
        self.assertIsNone(notes[1])
        self.assertIsNotNone(notes[2])  # 第3次
        self.assertIsNotNone(notes[4])  # 第5次
        self.assertIsNotNone(notes[7])  # 第8次
        # 参数变化即重置
        self.assertIsNone(g.observe("generate_image", {"prompt": "other"}, "success"))

    def test_spill_large_result(self):
        from app.agent.tools.pipeline import _summarize_result
        big = {"data": "x" * 50000}
        s = _summarize_result("get_provider_code", {"code": "y" * 50000, "provider_id": "p1"}, 4000)
        self.assertLessEqual(len(s), 4200)
        self.assertIn("code_preview", s)
        s2 = _summarize_result("list_assets", big, 4000)
        self.assertIn("已截断", s2)


class TestCompaction(TempStore):
    def _big_session(self, sid, n=12):
        s = Session.open(sid, store=self.store)
        for i in range(n):
            s.append(E.USER_MESSAGE, {"text": f"第{i}条用户指令" + "内容" * 200})
            s.append(E.ASSISTANT_MESSAGE, {"text": "收到" + "回复" * 200})
        return s

    def test_prune_keeps_tool_pairing(self):
        from app.agent.runtime.compaction import maybe_prune_tool_results
        sid = self.unique("prune")
        s = Session.open(sid, store=self.store)
        s.append(E.USER_MESSAGE, {"text": "查一下"})
        s.append(E.ASSISTANT_MESSAGE, {"text": "", "tool_calls": [{"id": "c1", "name": "get_provider_code", "arguments": "{}"}]})
        s.append(E.TOOL_RESULT, {"call_id": "c1", "name": "get_provider_code", "status": "success",
                                 "result": {"code": "x" * 20000}})
        n = maybe_prune_tool_results(s, max_chars=1000)
        self.assertEqual(n, 1)
        msgs = s.derive_messages()
        roles = [m["role"] for m in msgs]
        self.assertEqual(roles, ["user", "assistant", "tool"])
        self.assertLessEqual(len(msgs[2]["content"]), 1200)
        self.assertIn("已剪裁", msgs[2]["content"])
        self.assertEqual(msgs[1]["tool_calls"][0]["id"], "c1")
        self.assertEqual(msgs[2]["tool_call_id"], "c1")

    def test_select_shadow_range_avoids_tool_start(self):
        from app.agent.runtime.compaction import select_shadow_range
        surface = [
            {"seq": 1, "role": "user", "tokens": 2000, "type": E.USER_MESSAGE},
            {"seq": 2, "role": "assistant", "tokens": 100, "type": E.ASSISTANT_MESSAGE},
            {"seq": 3, "role": "tool", "tokens": 3000, "type": E.TOOL_RESULT},
            {"seq": 4, "role": "user", "tokens": 100, "type": E.USER_MESSAGE},
            {"seq": 5, "role": "assistant", "tokens": 100, "type": E.ASSISTANT_MESSAGE},
            {"seq": 6, "role": "user", "tokens": 100, "type": E.USER_MESSAGE},
        ]
        # keep_tokens 极大 → cut 会落到 0，返回 None（保留全部）
        self.assertIsNone(select_shadow_range(surface, keep_tokens=99999))
        # keep_tokens 使 cut 落在 tool 上时，应前移到 tool 之后
        cut = select_shadow_range(surface, keep_tokens=3000)
        self.assertIsNotNone(cut)
        self.assertNotEqual(surface[cut]["role"], "tool")

    def test_compact_creates_summary_and_shadows(self):
        from app.agent.runtime.compaction import maybe_compact
        import app.agent.runtime.compaction as comp_mod
        os.environ["AGENT_CONTEXT_WINDOW"] = "1500"
        self.addCleanup(lambda: os.environ.pop("AGENT_CONTEXT_WINDOW", None))
        sid = self.unique("compact")
        s = self._big_session(sid, n=12)

        import app.agent.llm.adapter as adapter_mod
        orig = adapter_mod.adapter.complete

        async def fake_summary(messages, tools=None, temperature=0.3, max_tokens=4096, timeout=300, on_chunk=None):
            return AssistantReply(content="【摘要】用户要求制作漫剧")

        adapter_mod.adapter.complete = fake_summary
        self.addCleanup(lambda: setattr(adapter_mod.adapter, "complete", orig))
        ev = run(maybe_compact(s))
        self.assertIsNotNone(ev)
        self.assertEqual(ev["type"], E.COMPACTION_SUMMARY)
        msgs = s.derive_messages()
        contents = [m["content"] for m in msgs]
        self.assertIn("【摘要】用户要求制作漫剧", contents)
        # 最早的原始消息已被遮蔽
        self.assertNotIn("第0条用户指令" + "内容" * 200, contents)

    def test_token_meter_estimates_cjk(self):
        from app.agent.runtime.token_meter import estimate_text, estimate_messages
        self.assertGreater(estimate_text("你好世界"), 0)
        n = estimate_messages([{"role": "user", "content": "测试" * 100}])
        self.assertGreater(n, 50)


class TestModesAndCommands(TempStore):
    def make_loop(self, prefix="modes", run_mode="approve"):
        from app.agent.runtime.loop import AgentLoop
        lp = AgentLoop(self.unique(prefix), run_mode=run_mode, mode="execute", store=self.store)
        lp.pipeline = FakePipeline()
        return lp

    def fake_model(self, lp, texts):
        import app.agent.runtime.loop as loop_mod

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            return AssistantReply(content=texts.pop(0) if texts else "完成")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))

    def test_todo_write_internal_tool(self):
        from app.agent.tools.pipeline import ToolPipeline
        from app.agent.runtime.session import Session
        s = Session.open(self.unique("todo"), store=self.store)
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline(s.id, emit, session=s)
        out = run(p.execute("c1", "todo_write", {"items": [
            {"content": "拆分剧本", "status": "completed"},
            {"content": "生成首帧", "status": "in_progress"},
        ]}))
        self.assertEqual(out.status, "success")
        self.assertEqual(out.result["completed"], 1)
        todo_events = [e for e in s.events if e["type"] == E.TODO_WRITE]
        self.assertEqual(len(todo_events), 1)
        # 空 items 必须报错
        out2 = run(p.execute("c2", "todo_write", {"items": []}))
        self.assertEqual(out2.status, "error")

    def test_plan_command_toggles_logged_state(self):
        lp = self.make_loop("cmd_plan")
        events = []
        lp.attach(lambda ev: events.append(dict(ev)))
        run(lp.prompt("/plan"))
        self.assertTrue(lp.plan_mode)
        plan_events = [e for e in lp.session.events if e["type"] == E.PLAN_MODE]
        self.assertTrue(plan_events)
        self.assertTrue(plan_events[-1]["data"]["active"])
        # 命令不产生模型轮次
        self.assertEqual([e for e in lp.session.events if e["type"] == E.TURN_START], [])
        run(lp.prompt("/plan off"))
        self.assertFalse(lp.plan_mode)
        self.assertEqual([e.get("event") for e in events].count("agent_response"), 2)

    def test_status_and_goal_off_commands(self):
        lp = self.make_loop("cmd_status")
        run(lp.prompt("/goal 整集生成"))
        self.assertIsNotNone(lp.goal)
        run(lp.prompt("/status"))
        run(lp.prompt("/goal off"))
        self.assertIsNone(lp.goal)

    def test_goal_driver_bounded_rounds(self):
        lp = self.make_loop("goal_run")
        self.fake_model(lp, ["继续推进", "继续推进", "继续推进"])

        async def scenario():
            g = lp.set_goal("一键成片", max_rounds=2)
            lp.inbox.followup(g.reminder(), source="goal")
            await lp.wait_idle(timeout=10)

        run(scenario())
        turns = [e for e in lp.session.events if e["type"] == E.TURN_START]
        self.assertEqual(len(turns), 2)
        self.assertEqual(lp.goal.rounds_started, 2)
        self.assertFalse(lp.goal.can_continue())

    def test_goal_completes_via_marker(self):
        lp = self.make_loop("goal_done")
        self.fake_model(lp, ["全部完成 [GOAL_DONE]"])

        async def scenario():
            g = lp.set_goal("一键成片", max_rounds=5)
            lp.inbox.followup(g.reminder(), source="goal")
            await lp.wait_idle(timeout=10)

        run(scenario())
        turns = [e for e in lp.session.events if e["type"] == E.TURN_START]
        self.assertEqual(len(turns), 1)
        self.assertEqual(lp.goal.phase, "complete")


class TestJobsSubagentBatch(TempStore):
    def test_job_background_lifecycle(self):
        from app.agent.runtime.loop import AgentLoop
        from app.agent.tools.pipeline import ToolOutcome
        lp = AgentLoop(self.unique("job"), store=self.store)
        lp.jobs.notify_fn = None  # 不唤醒驱动，避免真实模型调用

        async def fake_run_tool(call_id, name, args, ctx, rm):
            await asyncio.sleep(0.05)
            return ToolOutcome(call_id, name, "success", result={"image_url": "http://x.png"})

        lp.jobs.run_tool = fake_run_tool

        async def scenario():
            out = await lp.pipeline.execute("c1", "job_start", {"tool": "generate_image", "arguments": {"prompt": "x"}})
            self.assertEqual(out.status, "success")
            jid = out.result["job_id"]
            for _ in range(100):
                st = await lp.pipeline.execute("c2", "job_status", {"job_id": jid})
                if st.result and st.result.get("status") != "running":
                    return st.result
                await asyncio.sleep(0.02)
            return None

        final = run(scenario())
        self.assertIsNotNone(final)
        self.assertEqual(final["status"], "success")
        types = [e["type"] for e in lp.session.events]
        self.assertIn(E.JOB_STARTED, types)
        self.assertIn(E.JOB_SETTLED, types)

    def test_job_rejects_internal_recursion(self):
        from app.agent.runtime.loop import AgentLoop
        lp = AgentLoop(self.unique("job_rec"), store=self.store)
        out = run(lp.pipeline.execute("c1", "job_start", {"tool": "subagent_run", "arguments": {}}))
        self.assertEqual(out.status, "error")

    def test_subagent_depth_limit(self):
        from app.agent.runtime.loop import AgentLoop
        from app.agent.runtime.subagent import run_subagent
        lp = AgentLoop(self.unique("sub_depth"), context={"subagent_depth": 1}, store=self.store)
        r = run(run_subagent(lp, "调研"))
        self.assertEqual(r["status"], "error")
        self.assertIn("深度", r["error"])

    def test_subagent_runs_fresh_context(self):
        import app.agent.runtime.loop as loop_mod
        from app.agent.runtime.loop import AgentLoop
        from app.agent.runtime.subagent import run_subagent

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            # 子代理历史里不应出现父会话的消息
            texts = [m.get("content") or "" for m in messages if m.get("role") == "user"]
            assert not any("父会话机密" in t for t in texts), "子代理不应继承父历史"
            return AssistantReply(content="子代理结果：调研完成")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))

        lp = AgentLoop(self.unique("sub_run"), store=self.store)
        lp.session.append(E.USER_MESSAGE, {"text": "父会话机密：不要泄漏"})
        r = run(run_subagent(lp, "独立调研任务", max_steps=5, timeout=10))
        self.assertEqual(r["status"], "success")
        self.assertIn("子代理结果", r["result"])

    def test_batch_runner(self):
        from app.agent.runtime.batch import run_batch
        from app.agent.tools.pipeline import ToolOutcome

        async def fake_run_tool(call_id, tool, args, ctx, rm):
            if args.get("fail"):
                return ToolOutcome(call_id, tool, "error", error="boom")
            return ToolOutcome(call_id, tool, "success", result={"url": f"http://{args.get('i')}.png"})

        items = [{"i": 1}, {"i": 2}, {"fail": True}, {"i": 4}]
        res = run(run_batch(fake_run_tool, "generate_image", items, concurrency=2))
        self.assertEqual(res["total"], 4)
        self.assertEqual(res["success"], 3)
        self.assertEqual(res["failed"], 1)
        # 内置工具禁止批量
        res2 = run(run_batch(fake_run_tool, "batch_run", items))
        self.assertEqual(res2["status"], "error")


class TestRunModeHotSwitch(TempStore):
    """运行模式热切换：切「自动」必须立即放行挂起审批并回执，且对子代理/后台任务生效。"""

    def test_switch_to_auto_resolves_pending_approvals(self):
        from app.agent.runtime.loop import AgentLoop
        sid = self.unique("hot_switch")
        lp = AgentLoop(sid, run_mode="approve", mode="execute", interactive=True, store=self.store)
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
            await lp.apply_run_mode("auto")
            return await task

        out = run(scenario())
        self.assertEqual(lp.run_mode, "auto")
        # 审批已放行（工具不存在 → error 也算已放行）
        self.assertIn(out.status, ("success", "error"))
        acks = [e for e in events if e.get("event") == "approval_ack"]
        self.assertEqual(len(acks), 1)
        self.assertTrue(acks[0]["approved"])
        self.assertTrue(acks[0]["resolved"])

    def test_job_uses_live_run_mode(self):
        from app.agent.runtime.jobs import JobManager
        from app.agent.tools.pipeline import ToolOutcome
        sid = self.unique("job_rm")
        s = Session.open(sid, store=self.store)
        calls = []

        async def run_tool(call_id, name, args, ctx, run_mode):
            calls.append(run_mode)
            return ToolOutcome(call_id, name, "success", result={"ok": True})

        async def emit(ev):
            pass

        jm = JobManager(s, emit, run_tool)
        jm.get_run_mode = lambda: "auto"

        async def scenario():
            jm.start("generate_image", {"prompt": "x"}, None, "approve")
            for _ in range(100):
                if calls:
                    break
                await asyncio.sleep(0.01)

        run(scenario())
        self.assertEqual(calls, ["auto"])

    def test_subagent_inherits_parent_run_mode(self):
        import app.agent.runtime.loop as loop_mod
        from app.agent.runtime.subagent import run_subagent

        captured = {}

        class FakeChild:
            def __init__(self, child_sid, run_mode=None, mode=None, context=None,
                         interactive=None, store=None, max_steps=None):
                captured["run_mode"] = run_mode
                self.session = type("S", (), {
                    "id": child_sid, "seq": 0, "store": store,
                    "last_assistant_text": lambda self: "子代理完成",
                })()

            async def prompt(self, text):
                pass

            async def wait_idle(self, timeout=None):
                pass

            def is_running(self):
                return False

        class FakeParent:
            run_mode = "auto"
            context = {}

            class session:
                id = "parent_x"
                store = None

        orig = loop_mod.AgentLoop
        loop_mod.AgentLoop = FakeChild
        self.addCleanup(lambda: setattr(loop_mod, "AgentLoop", orig))

        r = run(run_subagent(FakeParent(), "独立任务", max_steps=5, timeout=5))
        self.assertEqual(r["status"], "success")
        self.assertEqual(captured.get("run_mode"), "auto")


class TestCreatorMode(TempStore):
    def test_create_mode_prompt_contains_creator_flow(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(plan_mode=False, run_mode="create")
        self.assertIn("创造模式", p)
        self.assertIn("creator_propose_capability", p)
        self.assertIn("creator_finalize", p)
        # 非创造模式不应出现
        p2 = build_system_prompt(plan_mode=False, run_mode="approve")
        self.assertNotIn("## 创造模式", p2)
        # 计划模式优先于创造模式
        p3 = build_system_prompt(plan_mode=True, run_mode="create")
        self.assertIn("PLAN MODE", p3)
        self.assertNotIn("## 创造模式", p3)

    def test_create_mode_approval_policy(self):
        from app.agent.mode_policy import requires_confirm
        # 提案不生效：无需审批（Start/Persist 才是人审门）
        self.assertFalse(requires_confirm("creator_propose_capability", "approve"))
        self.assertFalse(requires_confirm("creator_propose_capability", "create"))
        # 试跑/持久化必须人审
        self.assertTrue(requires_confirm("creator_start_test", "create"))
        self.assertTrue(requires_confirm("creator_finalize", "create"))
        self.assertTrue(requires_confirm("register_custom_provider", "create"))


class TestTransportIntegration(TempStore):
    """HTTP / SSE / WS 三个传输接到同一内核的端到端验证（假模型，不打真实 API）。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from fastapi.testclient import TestClient
        import app.main as main_mod
        from app.agent.runtime import store as store_mod
        from app.core.config import settings as app_settings
        cls._orig_root = store_mod.store.root
        store_mod.store.root = Path(cls._tmp)
        cls._orig_storage = app_settings.STORAGE_DIR
        app_settings.STORAGE_DIR = cls._tmp
        cls.client = TestClient(main_mod.app)
        cls.app = main_mod.app

    @classmethod
    def tearDownClass(cls):
        from app.agent.runtime import store as store_mod
        from app.core.config import settings as app_settings
        store_mod.store.root = cls._orig_root
        app_settings.STORAGE_DIR = cls._orig_storage
        super().tearDownClass()

    def fake_model(self, text="完成", tool_calls=None):
        import app.agent.runtime.loop as loop_mod
        calls = []

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096,
                                timeout=300, on_chunk=None):
            calls.append(messages)
            reply = AssistantReply(content=text, tool_calls=tool_calls or [])
            if on_chunk:
                for ch in text:
                    await on_chunk(type("C", (), {"kind": "text", "text": ch})())
            return reply

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        return calls

    def test_ws_attach_session_snapshot(self):
        sid = self.unique("ws_attach")
        self.fake_model("首轮完成")
        with self.client.websocket_connect("/api/v1/ws/agent") as ws:
            ws.send_json({"action": "agent_prompt", "prompt": "hello", "session_id": sid,
                          "mode": "execute", "run_mode": "approve", "context": {}})
            for _ in range(30):
                ev = ws.receive_json()
                if ev.get("event") == "agent_response":
                    break
        # 模拟断线重连：新 socket 发送 attach_session
        with self.client.websocket_connect("/api/v1/ws/agent") as ws2:
            ws2.send_json({"action": "attach_session", "session_id": sid, "tail": 50})
            snap = None
            for _ in range(10):
                ev = ws2.receive_json()
                if ev.get("event") == "session_snapshot":
                    snap = ev
                    break
            self.assertIsNotNone(snap)
            self.assertEqual(snap["session_id"], sid)
            self.assertGreater(len(snap["events"]), 0)
            self.assertGreater(snap["as_of_seq"], 0)

    def test_create_mode_propose_round_v2(self):
        """创造模式：模型发起提案（无交互通道也应放行），结果含 proposal_id 供前端提案卡。"""
        sid = self.unique("create_prop")
        import app.agent.runtime.loop as loop_mod
        replies = [
            AssistantReply(content="", tool_calls=[ToolCall(
                id="c1", name="creator_propose_capability",
                arguments='{"goal":"给H3视频源补first_frame插槽"}',
                parsed={"goal": "给H3视频源补first_frame插槽"})]),
            AssistantReply(content="提案已生成，请点击 Start 试跑。"),
        ]

        async def fake_complete(messages, tools=None, **kwargs):
            return replies.pop(0)

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        resp = self.client.post("/api/v1/agent/chat", json={
            "prompt": "帮H3补首帧插槽", "session_id": sid, "mode": "execute", "run_mode": "create",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("提案", data["reply"])
        tool = data["executed_tools"][0]
        self.assertEqual(tool["tool_name"], "creator_propose_capability")
        self.assertEqual(tool["status"], "success")
        self.assertIn("proposal_id", tool["result"])
        self.assertEqual(tool["result"]["status"], "proposed")

    def test_create_mode_finalize_fail_closed(self):
        """创造模式：无交互通道时 Persist 必须 fail-closed 拒绝（人审门不可绕过）。"""
        sid = self.unique("create_final")
        import app.agent.runtime.loop as loop_mod
        replies = [
            AssistantReply(content="", tool_calls=[ToolCall(
                id="c1", name="creator_finalize",
                arguments='{"proposal_id":"prop_fake","action":"persist"}',
                parsed={"proposal_id": "prop_fake", "action": "persist"})]),
            AssistantReply(content="无法持久化：需要你确认。"),
        ]

        async def fake_complete(messages, tools=None, **kwargs):
            return replies.pop(0)

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        resp = self.client.post("/api/v1/agent/chat", json={
            "prompt": "把提案持久化", "session_id": sid, "mode": "execute", "run_mode": "create",
        })
        data = resp.json()
        tool = data["executed_tools"][0]
        self.assertEqual(tool["tool_name"], "creator_finalize")
        self.assertEqual(tool["status"], "denied")

    def test_http_tool_round_v2(self):
        sid = self.unique("http_tool")
        import app.agent.runtime.loop as loop_mod
        replies = [
            AssistantReply(content="", tool_calls=[ToolCall(
                id="c1", name="todo_write",
                arguments='{"items":[{"content":"拆分剧本","status":"pending"}]}',
                parsed={"items": [{"content": "拆分剧本", "status": "pending"}]})]),
            AssistantReply(content="已建立任务清单"),
        ]

        async def fake_complete(messages, tools=None, **kwargs):
            return replies.pop(0)

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))

        resp = self.client.post("/api/v1/agent/chat", json={
            "prompt": "建立清单", "session_id": sid, "mode": "execute", "run_mode": "approve",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("已建立任务清单", data["reply"])
        self.assertEqual(data["executed_tools"][0]["tool_name"], "todo_write")
        self.assertEqual(data["executed_tools"][0]["status"], "success")
        snap = self.client.get(f"/api/v1/agent/session/{sid}/snapshot").json()
        types = [e["type"] for e in snap["events"]]
        self.assertIn("todo/write", types)
        self.assertIn("tool/result", types)
        # 历史投影里 tool_call 配对完整
        hist = self.client.get(f"/api/v1/agent/history?session_id={sid}").json()
        roles = [m["role"] for m in hist["history"]]
        self.assertIn("assistant", roles)
        self.assertIn("tool", roles)

    def test_http_chat_v2(self):
        sid = self.unique("http")
        self.fake_model("你好，我是导演")
        resp = self.client.post("/api/v1/agent/chat", json={
            "prompt": "打个招呼", "session_id": sid, "mode": "execute", "run_mode": "approve",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("你好", data["reply"])
        # 快照可重建
        snap = self.client.get(f"/api/v1/agent/session/{sid}/snapshot").json()
        types = [e["type"] for e in snap["events"]]
        self.assertIn("turn/start", types)
        self.assertIn("turn/end", types)
        self.assertGreater(snap["as_of_seq"], 0)

    def test_ws_chat_v2(self):
        sid = self.unique("ws")
        self.fake_model("WS 响应")
        with self.client.websocket_connect("/api/v1/ws/agent") as ws:
            ws.send_json({"action": "agent_prompt", "prompt": "hello", "session_id": sid,
                          "mode": "execute", "run_mode": "approve", "context": {}})
            events = []
            for _ in range(30):
                ev = ws.receive_json()
                events.append(ev)
                if ev.get("event") == "agent_response":
                    break
            names = [e.get("event") for e in events]
            self.assertIn("agent_response", names)
            final = next(e for e in events if e.get("event") == "agent_response")
            self.assertIn("WS 响应", final.get("message", ""))

    def test_sse_chat_v2(self):
        sid = self.unique("sse")
        self.fake_model("SSE 响应")
        with self.client.stream("POST", "/api/v1/agent/chat/stream", json={
            "prompt": "hello", "session_id": sid, "mode": "execute", "run_mode": "approve",
        }) as resp:
            self.assertEqual(resp.status_code, 200)
            body = "".join(resp.iter_text())
        self.assertIn("agent_response", body)
        self.assertIn("SSE 响应", body)
        self.assertIn("[DONE]", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
