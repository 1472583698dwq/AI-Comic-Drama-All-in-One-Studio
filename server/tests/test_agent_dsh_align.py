# -*- coding: utf-8 -*-
"""dsh 对齐新增能力回归测试（stdlib unittest，零外部依赖）。

覆盖：
- Session strict invariants（turn/step/tool 配对提交时校验）
- 幂等 system/context append + durable inbox 回放
- 错误码谱系（classify_http_error / error_code_of / is_retryable_code）
- ask_user_question（fail-closed / 超时 / 选项回填）
- pre/post hooks（deny / block / fail-open）
- 子代理结构化输出（_extract_structured）
- 压缩事务（compaction/start|end 配对 + shrink 校验）
- 重试留账（llm/retry）+ 请求头变更检测/模型切换通知
- 并行工具安全集判定

运行： python -m unittest tests.test_agent_dsh_align -v
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

from app.agent.llm.adapter import (  # noqa: E402
    AssistantReply, ToolCall, classify_http_error, error_code_of, is_retryable_code,
    ERROR_AUTH, ERROR_CONTEXT_OVERFLOW, ERROR_INVALID_REQUEST, ERROR_QUOTA,
    ERROR_RATE_LIMIT, ERROR_SERVER, ERROR_TIMEOUT, ERROR_TRANSPORT, ERROR_EMPTY_RESPONSE,
    LLMConfigError, LLMTransportError,
)
from app.agent.runtime import events as E  # noqa: E402
from app.agent.runtime.inbox import Inbox  # noqa: E402
from app.agent.runtime.session import Session  # noqa: E402
from app.agent.runtime.store import SessionStore  # noqa: E402

_LOOP = None


def run(coro):
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


class TempStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="agent_dsh_")
        cls.store = SessionStore(Path(cls._tmp))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def unique(self, prefix: str) -> str:
        import uuid
        return f"{prefix}_{uuid.uuid4().hex[:8]}"


class TestStrictInvariants(TempStore):
    def test_turn_nesting_rejected(self):
        s = Session.open(self.unique("strict"), store=self.store, strict=True)
        s.append(E.TURN_START, {"mode": "execute"})
        with self.assertRaises(RuntimeError):
            s.append(E.TURN_START, {"mode": "execute"})
        s.append(E.TURN_END, {"reason": "completed"})

    def test_tool_result_success_requires_pairing(self):
        s = Session.open(self.unique("strict2"), store=self.store, strict=True)
        s.append(E.TURN_START, {"mode": "execute"})
        with self.assertRaises(RuntimeError):
            s.append(E.TOOL_RESULT, {"call_id": "cx", "name": "t", "status": "success", "result": {}})
        # 合成错误结果（中断补账语义）允许无前导 tool/call
        s.append(E.TOOL_RESULT, {"call_id": "cy", "name": "t", "status": "error", "error": "中断"})
        s.append(E.TURN_END, {"reason": "completed"})

    def test_step_requires_open_turn(self):
        s = Session.open(self.unique("strict3"), store=self.store, strict=True)
        with self.assertRaises(RuntimeError):
            s.append(E.STEP_START, {"index": 1})

    def test_lenient_session_unaffected(self):
        s = Session.open(self.unique("lenient"), store=self.store)  # 默认非 strict
        s.append(E.TOOL_RESULT, {"call_id": "c1", "name": "t", "status": "success", "result": {"ok": True}})

    def test_repair_closes_open_turn_for_strict(self):
        sid = self.unique("strict_repair")
        s = Session.open(sid, store=self.store, strict=True)
        s.append(E.TURN_START, {"mode": "execute"})
        s.append(E.TOOL_CALL, {"call_id": "c9", "name": "generate_video", "arguments": {}})
        # 重新打开触发修复；之后新轮可正常开启（不变量闭合）
        s2 = Session.open(sid, store=self.store, strict=True)
        s2.append(E.TURN_START, {"mode": "execute"})
        s2.append(E.TURN_END, {"reason": "completed"})


class TestIdempotentAndDurable(TempStore):
    def test_system_append_idempotent(self):
        s = Session.open(self.unique("idem_sys"), store=self.store, strict=True)
        self.assertIsNotNone(s.append_system_if_changed("SYS"))
        self.assertIsNone(s.append_system_if_changed("SYS"))
        self.assertIsNotNone(s.append_system_if_changed("SYS2"))
        sys_events = [e for e in s.events if e["type"] == E.SYSTEM_MESSAGE]
        self.assertEqual(len(sys_events), 2)

    def test_context_append_idempotent(self):
        s = Session.open(self.unique("idem_ctx"), store=self.store, strict=True)
        self.assertIsNotNone(s.append_context_if_changed("CTX"))
        self.assertIsNone(s.append_context_if_changed("CTX"))
        ctx = [e for e in s.events if e["type"] == E.USER_MESSAGE and e["data"].get("form") == "context"]
        self.assertEqual(len(ctx), 1)

    def test_inbox_durable_replay(self):
        sid = self.unique("inbox_dur")
        s = Session.open(sid, store=self.store, strict=True)
        ib = Inbox(session=s)
        ib.followup("任务A", source="user")
        ib.steer("插话B", source="user")
        # 模拟重启：从日志折叠回放
        s2 = Session.open(sid, store=self.store, strict=True)
        snap = s2.pending_inbox_snapshot()
        self.assertEqual(len(snap), 2)
        ib2 = Inbox(restore=snap)
        texts = [m.text for m in ib2.claim()]
        self.assertEqual(sorted(texts), ["任务A", "插话B"])

    def test_inbox_claim_persisted(self):
        sid = self.unique("inbox_claim")
        s = Session.open(sid, store=self.store, strict=True)
        ib = Inbox(session=s)
        ib.followup("只一次", source="user")
        ib.claim()
        s2 = Session.open(sid, store=self.store, strict=True)
        self.assertEqual(s2.pending_inbox_snapshot(), [])

    def test_inbox_dedup(self):
        # 回放路径去重：同一 id 出现两次只恢复一条（幂等）
        snap = [
            {"target": "next-turn", "message": {"id": "imsg_dup1", "text": "X", "source": "user"}},
            {"target": "next-turn", "message": {"id": "imsg_dup1", "text": "X", "source": "user"}},
        ]
        ib = Inbox(restore=snap)
        self.assertEqual(ib.pending_count(), 1)
        # 入队路径：同 id 消息二次 followup 不重复排队
        first = ib.followup("Y", source="user")
        same_id = type(first)(text="Y", source="user", id=first.id)
        # _is_pending 命中 → 不重复 append
        self.assertTrue(ib._is_pending(first.id))


class TestErrorTaxonomy(unittest.TestCase):
    def test_classify_http(self):
        self.assertEqual(classify_http_error(401, ""), ERROR_AUTH)
        self.assertEqual(classify_http_error(403, ""), ERROR_AUTH)
        self.assertEqual(classify_http_error(429, ""), ERROR_RATE_LIMIT)
        self.assertEqual(classify_http_error(500, ""), ERROR_SERVER)
        self.assertEqual(classify_http_error(400, "insufficient balance"), ERROR_QUOTA)
        self.assertEqual(classify_http_error(400, "maximum context length exceeded"), ERROR_CONTEXT_OVERFLOW)
        self.assertEqual(classify_http_error(400, "bad request"), ERROR_INVALID_REQUEST)

    def test_retryable(self):
        self.assertTrue(is_retryable_code(ERROR_RATE_LIMIT))
        self.assertTrue(is_retryable_code(ERROR_SERVER))
        self.assertTrue(is_retryable_code(ERROR_TIMEOUT))
        self.assertTrue(is_retryable_code(ERROR_TRANSPORT))
        self.assertTrue(is_retryable_code(ERROR_EMPTY_RESPONSE))
        self.assertFalse(is_retryable_code(ERROR_AUTH))
        self.assertFalse(is_retryable_code(ERROR_QUOTA))
        self.assertFalse(is_retryable_code(ERROR_INVALID_REQUEST))
        self.assertFalse(is_retryable_code(ERROR_CONTEXT_OVERFLOW))

    def test_error_code_of(self):
        self.assertEqual(error_code_of(LLMTransportError("x", code=ERROR_RATE_LIMIT)), ERROR_RATE_LIMIT)
        self.assertEqual(error_code_of(LLMConfigError("x", code=ERROR_AUTH)), ERROR_AUTH)
        self.assertEqual(error_code_of(RuntimeError("x")), "")


class TestAskUserQuestion(TempStore):
    def _make_pipeline(self, interactive=True):
        from app.agent.tools.pipeline import ToolPipeline
        sid = self.unique("askq")
        s = Session.open(sid, store=self.store, strict=True)
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline(sid, emit, interactive=interactive, session=s)
        return p, events

    def test_fail_closed_without_channel(self):
        p, events = self._make_pipeline(interactive=False)
        out = run(p.execute("c1", "ask_user_question", {"question": "选哪个?", "options": ["A", "B"]}))
        self.assertEqual(out.status, "success")
        self.assertEqual(out.result["outcome"], "no_interactive")
        self.assertIn("不要重复", out.result.get("note", ""))

    def test_timeout_no_answer(self):
        p, events = self._make_pipeline(interactive=True)
        p.questions.timeout_s = 0.05
        out = run(p.execute("c1", "ask_user_question", {"question": "在吗?", "options": ["在"]}))
        self.assertEqual(out.result["outcome"], "timeout")

    def test_answer_flow(self):
        p, events = self._make_pipeline(interactive=True)

        async def scenario():
            task = asyncio.create_task(p.execute("c1", "ask_user_question", {
                "question": "画风选哪个?", "options": ["国风", "写实"], "multi_select": False}))
            for _ in range(300):
                q = next((e for e in events if e.get("event") == "question_required"), None)
                if q:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(q, "应收到 question_required 事件")
            self.assertTrue(p.resolve_question(q["question_id"], ["国风"]))
            return await task

        out = run(scenario())
        self.assertEqual(out.result["outcome"], "answered")
        self.assertEqual(out.result["selections"], ["国风"])
        # 落账审计
        types = [e["type"] for e in p.session.events]
        self.assertIn(E.QUESTION_ASKED, types)
        self.assertIn(E.QUESTION_ANSWERED, types)

    def test_empty_question_rejected(self):
        p, events = self._make_pipeline(interactive=True)
        out = run(p.execute("c1", "ask_user_question", {}))
        self.assertEqual(out.status, "error")


class TestHooksSeam(TempStore):
    def _make_pipeline(self):
        from app.agent.tools.pipeline import ToolPipeline
        events = []

        async def emit(ev):
            events.append(ev)

        p = ToolPipeline(self.unique("hooks"), emit)
        return p, events

    def test_pre_hook_deny(self):
        from app.agent.tools.pipeline import register_pre_hook, unregister_pre_hook
        p, events = self._make_pipeline()
        p.skills_read.add("prompt-basics")  # 预读技能解锁提示词门控，聚焦 hook 本身

        def deny_hook(name, args, pipe):
            if name == "generate_image":
                return {"decision": "deny", "reason": "合规拦截"}
            return None

        register_pre_hook(deny_hook)
        self.addCleanup(lambda: unregister_pre_hook(deny_hook))
        out = run(p.execute("c1", "generate_image", {"prompt": "x"}, run_mode="auto"))
        self.assertEqual(out.status, "denied")
        self.assertIn("合规拦截", out.error)

    def test_post_hook_block(self):
        from app.agent.tools.pipeline import register_post_hook, unregister_post_hook
        p, events = self._make_pipeline()

        def block_hook(name, args, outcome):
            if name == "todo_write":
                return None  # 内置分支不经过 post seam（当前设计）
            if name == "list_assets":
                return {"decision": "deny", "reason": "结果不合规", "additional_context": "请重试"}
            return None

        register_post_hook(block_hook)
        self.addCleanup(lambda: unregister_post_hook(block_hook))
        out = run(p.execute("c1", "list_assets", {}, run_mode="auto"))
        self.assertEqual(out.status, "error")
        self.assertIn("结果不合规", out.error)


class TestStructuredOutput(unittest.TestCase):
    def test_extract_fenced_json(self):
        from app.agent.runtime.subagent import _extract_structured
        text = '分析完成：\n```json\n{"shots": [{"i": 1}], "total": 1}\n```\n以上'
        val, st = _extract_structured(text, {"type": "object", "required": ["shots", "total"]})
        self.assertEqual(st, "ok")
        self.assertEqual(val["total"], 1)

    def test_extract_plain_object(self):
        from app.agent.runtime.subagent import _extract_structured
        val, st = _extract_structured('{"a": 1}', {"type": "object", "required": ["a"]})
        self.assertEqual(st, "ok")

    def test_missing(self):
        from app.agent.runtime.subagent import _extract_structured
        val, st = _extract_structured("没有 JSON 的纯文本", {"type": "object"})
        self.assertEqual(st, "missing")

    def test_invalid_required(self):
        from app.agent.runtime.subagent import _extract_structured
        val, st = _extract_structured('{"a": 1}', {"type": "object", "required": ["a", "b"]})
        self.assertEqual(st, "invalid")


class TestCompactionTxn(TempStore):
    def _big_session(self, sid, n=12):
        s = Session.open(sid, store=self.store, strict=True)
        for i in range(n):
            s.append(E.USER_MESSAGE, {"text": f"第{i}条用户指令" + "内容" * 200})
            s.append(E.ASSISTANT_MESSAGE, {"text": "收到" + "回复" * 200})
        return s

    def test_start_end_pair(self):
        from app.agent.runtime.compaction import maybe_compact
        import app.agent.llm.adapter as adapter_mod
        os.environ["AGENT_CONTEXT_WINDOW"] = "1500"
        self.addCleanup(lambda: os.environ.pop("AGENT_CONTEXT_WINDOW", None))
        sid = self.unique("ctx_txn")
        s = self._big_session(sid)
        orig = adapter_mod.adapter.complete

        async def fake_summary(messages, tools=None, temperature=0.3, max_tokens=4096, timeout=300, on_chunk=None):
            return AssistantReply(content="【摘要】短")

        adapter_mod.adapter.complete = fake_summary
        self.addCleanup(lambda: setattr(adapter_mod.adapter, "complete", orig))
        ev = run(maybe_compact(s))
        self.assertIsNotNone(ev)
        types = [e["type"] for e in s.events]
        self.assertEqual(types.count(E.COMPACTION_START), 1)
        self.assertEqual(types.count(E.COMPACTION_END), 1)
        start = next(e for e in s.events if e["type"] == E.COMPACTION_START)
        end = next(e for e in s.events if e["type"] == E.COMPACTION_END)
        self.assertEqual(start["data"]["compaction_id"], end["data"]["compaction_id"])
        self.assertEqual(end["data"]["status"], "success")

    def test_shrink_rejects_larger_summary(self):
        from app.agent.runtime.compaction import maybe_compact
        import app.agent.llm.adapter as adapter_mod
        os.environ["AGENT_CONTEXT_WINDOW"] = "1500"
        self.addCleanup(lambda: os.environ.pop("AGENT_CONTEXT_WINDOW", None))
        sid = self.unique("ctx_shrink")
        s = self._big_session(sid)
        orig = adapter_mod.adapter.complete

        async def fake_summary(messages, tools=None, temperature=0.3, max_tokens=4096, timeout=300, on_chunk=None):
            return AssistantReply(content="巨" * 20000)  # 比被遮蔽内容还大

        adapter_mod.adapter.complete = fake_summary
        self.addCleanup(lambda: setattr(adapter_mod.adapter, "complete", orig))
        ev = run(maybe_compact(s))
        self.assertIsNone(ev)
        types = [e["type"] for e in s.events]
        self.assertNotIn(E.COMPACTION_SUMMARY, types)
        end = next(e for e in s.events if e["type"] == E.COMPACTION_END)
        self.assertEqual(end["data"]["status"], "skipped")


class TestLoopDshAlign(TempStore):
    def test_parallel_safe_whitelist(self):
        from app.agent.runtime.loop import AgentLoop
        self.assertTrue(AgentLoop._is_parallel_safe("list_assets"))
        self.assertTrue(AgentLoop._is_parallel_safe("view_media"))
        self.assertTrue(AgentLoop._is_parallel_safe("canvas_query"))
        self.assertFalse(AgentLoop._is_parallel_safe("generate_image"))
        self.assertFalse(AgentLoop._is_parallel_safe("canvas_delete_node"))
        self.assertFalse(AgentLoop._is_parallel_safe("choose_anything_else"))

    def test_header_change_detection(self):
        from app.agent.runtime.loop import AgentLoop
        sid = self.unique("hdr")
        lp = AgentLoop(sid, store=self.store)
        lp._log_request_header({"endpoint": "http://a", "model": "m1"}, [])
        lp._log_request_header({"endpoint": "http://a", "model": "m1"}, [])
        lp._header_logged_this_turn = 1
        lp._log_request_header({"endpoint": "http://a", "model": "m2"}, [])
        headers = [e for e in lp.session.events if e["type"] == E.REQUEST_HEADER]
        self.assertEqual(len(headers), 2)  # 首记 + 变更；重复被去重
        self.assertEqual(headers[1]["data"]["reason"], "change")
        # 模型切换通知（durable user notice）
        notices = [e for e in lp.session.events
                   if e["type"] == E.USER_MESSAGE and "模型已切换" in str(e["data"].get("text") or "")]
        self.assertEqual(len(notices), 1)

    def test_retry_event_logged(self):
        from app.agent.runtime.loop import AgentLoop
        import app.agent.runtime.loop as loop_mod
        sid = self.unique("retry")
        lp = AgentLoop(sid, store=self.store)
        calls = {"n": 0}

        async def fake_complete(messages, tools=None, temperature=0.3, max_tokens=4096, timeout=300, on_chunk=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise LLMTransportError("rate limited", status=429, code=ERROR_RATE_LIMIT)
            return AssistantReply(content="恢复")

        orig = loop_mod.adapter.complete
        loop_mod.adapter.complete = fake_complete
        self.addCleanup(lambda: setattr(loop_mod.adapter, "complete", orig))
        os.environ["AGENT_LLM_RETRIES"] = "1"
        self.addCleanup(lambda: os.environ.pop("AGENT_LLM_RETRIES", None))
        run(lp.prompt("hi"))
        run(lp.wait_idle(timeout=10))
        retries = [e for e in lp.session.events if e["type"] == E.LLM_RETRY]
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0]["data"]["code"], ERROR_RATE_LIMIT)


if __name__ == "__main__":
    unittest.main()
