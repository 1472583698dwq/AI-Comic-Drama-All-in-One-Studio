# -*- coding: utf-8 -*-
"""AgentLoop — 单一 turn/step 状态机（对标 dsh core/agent-loop）。

- 一个 turn = 0..N 个 step；step = 一次模型请求 + 其工具调用。
- 是否继续由数据决定：工具调用 → 欠一次响应；inbox 有待办输入 → 继续；否则关闭轮次。
- 所有模型可见内容先落 Session 事件，再发实时事件给传输层。
- 重试只重发模型请求：失败尝试落 assistant/attempt，不进入模型历史，用户消息只准入一次。
- 取消携带原因；被中止的悬挂工具调用补记"结果未知"。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from app.agent.llm.adapter import adapter, AssistantReply, LLMConfigError, LLMTransportError
from app.agent.runtime import events as E
from app.agent.runtime.inbox import Inbox
from app.agent.runtime.prompt import build_context_block, build_system_prompt
from app.agent.runtime.session import Session
from app.agent.runtime.store import SessionStore
from app.agent.tools.pipeline import ToolPipeline
from app.agent.tools.registry import tool_view

Sink = Callable[[Dict[str, Any]], Any]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except Exception:
        return default


class AgentLoop:
    def __init__(
        self,
        session_id: str,
        run_mode: str = "approve",
        mode: str = "execute",
        context: Optional[Dict[str, Any]] = None,
        interactive: bool = True,
        store: Optional[SessionStore] = None,
        max_steps: Optional[int] = None,
        agent_profile: Any = None,
    ):
        self.session = Session.open(session_id, store=store, strict=True)
        try:
            from app.agent.mode_policy import normalize_run_mode, behavior_of
            self.run_mode = normalize_run_mode(run_mode)
        except Exception:
            self.run_mode = run_mode or "approve"
            behavior_of = lambda m: "plan" if str(m).startswith("plan") else ("create" if str(m).startswith("create") else "standard")  # noqa: E731
        self.mode = "chat" if str(mode or "execute").lower() == "chat" else "execute"
        self.agent_profile = agent_profile
        self.plan_mode = behavior_of(self.run_mode) == "plan"
        # /plan off 回到进入计划前的行为（如 创造+自动），避免把行为维度一并重置
        self._pre_plan_run_mode = "approve"
        self.context: Dict[str, Any] = dict(context or {})
        # durable inbox：重启恢复未消费输入（排除 goal 提醒——由目标驱动重新生成，防重复计轮）
        _restore: List[Dict[str, Any]] = []
        try:
            _restore = [
                x for x in self.session.pending_inbox_snapshot()
                if str(((x or {}).get("message") or {}).get("source") or "") != "goal"
            ]
        except Exception:
            _restore = []
        self.inbox = Inbox(on_wake=self._wake, session=self.session, restore=_restore)
        # 自动唤醒预算（对标 dsh maxConsecutiveWakes）：后台任务/子代理连环完成最多自动开 N 轮，
        # 用户消息被领取即重置；超预算降级为静默注入，防自激唤醒环。
        self._auto_wake_budget = _env_int("AGENT_AUTO_WAKE_BUDGET", 3)
        self._auto_wake_full = self._auto_wake_budget
        self._header_logged_this_turn = 0
        self._turn_system_text = ""
        self._sinks: List[Sink] = []
        self._driver: Optional[asyncio.Task] = None
        self._open_turn = False
        self._open_step = False
        self._turn_seq = 0
        self._run_id = ""
        self._turn_started_at = 0.0
        self._lock = asyncio.Lock()
        self.pipeline = ToolPipeline(
            session_id,
            self._emit,
            plan_mode=self.plan_mode,
            approval_policy="ask",
            interactive=interactive,
            session=self.session,
            agent_profile=agent_profile,
        )
        try:
            from app.agent.runtime.goal import load_goal
            self.goal = load_goal(self.session)
        except Exception:
            self.goal = None
        self._last_turn_reason = ""
        # 已回投过的媒体引用（会话级去重：同一张图不重复作为附件塞给模型）
        self._seen_media_refs: set = set()
        _profile_steps = int(getattr(agent_profile, "max_steps", 0) or 0)
        self._max_steps = int(max_steps or _profile_steps or _env_int("AGENT_MAX_ITERATIONS", 200))
        # 后台任务（P5）：长耗时工具调用异步化，完成后注入通知
        try:
            from app.agent.runtime.jobs import JobManager
            self.jobs = JobManager(self.session, self._emit, self.pipeline.execute)
            self.jobs.notify_fn = self._notify_job_done
            # 后台任务执行时读取实时 run_mode：运行中切「自动」也能立即生效
            self.jobs.get_run_mode = lambda: self.run_mode
            self.pipeline.jobs = self.jobs
            self.pipeline.subagent_parent = self
        except Exception:
            self.jobs = None

    # ── 订阅（传输层）────────────────────────────────────
    def attach(self, sink: Sink) -> None:
        if sink not in self._sinks:
            self._sinks.append(sink)

    def detach(self, sink: Sink) -> None:
        try:
            self._sinks.remove(sink)
        except ValueError:
            pass

    async def _emit(self, ev: Dict[str, Any]) -> None:
        # 客户端按 session_id 分流（页面版与悬浮窗版独立会话共用一条 WS）。
        try:
            if isinstance(ev, dict) and "session_id" not in ev:
                ev = {**ev, "session_id": self.session_id}
        except Exception:
            pass
        for sink in list(self._sinks):
            try:
                r = sink(ev)
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                pass

    # ── 输入 ─────────────────────────────────────────────
    async def prompt(self, text: str, context: Optional[Dict[str, Any]] = None,
                     mode: Optional[str] = None, run_mode: Optional[str] = None,
                     attachments: Optional[List[Dict[str, Any]]] = None) -> None:
        # 免模型命令：/plan /goal /status /compact /cancel /help
        try:
            from app.agent.runtime.commands import execute_command
            cmd_reply = await execute_command(self, text)
        except Exception as e:
            cmd_reply = f"命令执行失败: {e}"
        if cmd_reply is not None:
            await self._emit({"event": "agent_response", "message": cmd_reply,
                              "suggested_actions": [], "executed_tools": [], "mode": self.mode})
            return
        if mode:
            self.mode = "chat" if str(mode).lower() == "chat" else "execute"
        if run_mode:
            await self.apply_run_mode(run_mode)
        if context:
            self.context = dict(context)
        self.pipeline.guard.reset()
        # 已批准的计划随输入注入（保证模型可见且可回放）
        approved = None
        if isinstance(context, dict):
            approved = context.get("approved_plan")
        if approved:
            try:
                plan_text = approved if isinstance(approved, str) else json.dumps(approved, ensure_ascii=False)
            except Exception:
                plan_text = str(approved)
            text = f"{text}\n\n【用户已批准的执行计划（请严格按步骤执行；偏离需说明理由）】\n{plan_text[:6000]}"
            # 计划批准审计（对标 dsh plan/approve 决议留痕）：批准事实落账，可回放
            try:
                self.session.append(E.PLAN_APPROVED, {
                    "source": "user", "plan_chars": len(plan_text),
                    "run_mode": self.run_mode,
                })
            except Exception:
                pass
        self.inbox.followup(text, source="user", meta={"attachments": attachments} if attachments else None)

    def set_run_mode(self, run_mode: str) -> None:
        try:
            from app.agent.mode_policy import normalize_run_mode, behavior_of, execution_of
            m = normalize_run_mode(run_mode)
            behavior = behavior_of(m)
            prev_behavior = behavior_of(self.run_mode)
        except Exception:
            m = str(run_mode or "approve")
            behavior = "plan" if m.startswith("plan") else ("create" if m.startswith("create") else "standard")
            prev_behavior = "plan" if str(self.run_mode).startswith("plan") else "standard"
            execution_of = lambda x: "auto" if str(x).endswith("auto") else "approve"  # noqa: E731
        if behavior == "plan" and prev_behavior != "plan":
            self._pre_plan_run_mode = self.run_mode
        changed = m != self.run_mode
        self.run_mode = m
        self.plan_mode = behavior == "plan"
        self.pipeline.plan_mode = self.plan_mode
        if changed:
            self.session.append(E.PLAN_MODE, {
                "active": self.plan_mode, "run_mode": m,
                "behavior": behavior, "execution": execution_of(m),
            })

    async def apply_run_mode(self, run_mode: str) -> str:
        """热切换运行模式（对当前轮后续工具立即生效）。

        切到「自动」时同步放行全部挂起审批并补发 approval_ack，
        否则用户切了自动，之前弹出的审批卡仍会阻塞工具直到超时。
        """
        self.set_run_mode(run_mode)
        try:
            from app.agent.mode_policy import execution_of
            to_auto = execution_of(self.run_mode) == "auto"
        except Exception:
            to_auto = str(self.run_mode).endswith("auto")
        if to_auto:
            approvals = getattr(getattr(self, "pipeline", None), "approvals", None)
            resolver = getattr(approvals, "resolve_all", None)
            if callable(resolver):
                for aid in resolver(True):
                    try:
                        await self._emit({"event": "approval_ack", "approval_id": aid,
                                          "approved": True, "resolved": True})
                    except Exception:
                        pass
        return self.run_mode

    def set_goal(self, objective: str, max_rounds: Optional[int] = None):
        from app.agent.runtime.goal import GoalState, save_goal, DEFAULT_MAX_ROUNDS
        g = GoalState(
            id=f"goal_{uuid.uuid4().hex[:8]}",
            objective=(objective or "").strip()[:1000],
            max_rounds=int(max_rounds or _env_int("AGENT_GOAL_MAX_ROUNDS", DEFAULT_MAX_ROUNDS)),
            rounds_started=0,
        )
        self.goal = g
        save_goal(self.session, g)
        return g

    def clear_goal(self) -> None:
        from app.agent.runtime.goal import save_goal
        self.goal = None
        save_goal(self.session, None)

    async def steer(self, text: str, attachments: Optional[List[Dict[str, Any]]] = None) -> None:
        self.inbox.steer(text, source="user", meta={"attachments": attachments} if attachments else None)

    def is_running(self) -> bool:
        return self._driver is not None and not self._driver.done()

    def resolve_approval(self, approval_id: str, approved: bool) -> bool:
        return self.pipeline.resolve_approval(approval_id, approved)

    def resolve_question(self, question_id: str, selections: Optional[List[str]] = None,
                         custom: str = "") -> bool:
        return self.pipeline.resolve_question(question_id, selections, custom)

    def notify(self, text: str, source: str = "system") -> None:
        """外部完成通知（后台任务 / 前端回执等）：运行中→插话（进当前轮下一步）；空闲→唤醒新轮（受预算约束）。

        对齐 dsh：busy → steer/inject；idle → followup 但受 maxConsecutiveWakes 约束，
        超预算降级静默注入（结果仍可达、不丢，但不再无界自激开轮）。
        """
        try:
            if self.is_running():
                self.inbox.steer(text, source=source)
                return
        except Exception:
            pass
        if self._auto_wake_budget <= 0:
            self.inbox.inject(text, source=source, form="notice")
            return
        self._auto_wake_budget -= 1
        self.inbox.followup(text, source=source)

    def _notify_job_done(self, text: str) -> None:
        """后台任务/子代理完成通知（保留原入口，语义与 notify 一致）。"""
        self.notify(text, source="job")

    async def abort(self, cause: str = "user") -> None:
        self.inbox.clear()
        task = self._driver
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        if self._open_turn:
            self._close_turn("aborted", cause)
        await self._emit({"event": "agent_response", "message": "⏹️ 已暂停",
                          "suggested_actions": [], "executed_tools": []})
    async def wait_idle(self, timeout: Optional[float] = None) -> None:
        task = self._driver
        if task and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

    # ── 驱动 ─────────────────────────────────────────────
    def _wake(self) -> None:
        if self._driver is None or self._driver.done():
            try:
                self._driver = asyncio.get_running_loop().create_task(self._drive())
            except RuntimeError:
                self._driver = None

    async def _drive(self) -> None:
        try:
            while True:
                while self.inbox.has_pending():
                    await self._run_turn()
                if not self._maybe_continue_goal():
                    break
        except asyncio.CancelledError:
            raise
        except Exception as e:
            try:
                await self._emit({"event": "error", "message": f"Agent 执行失败: {e}"})
            except Exception:
                pass

    def _maybe_continue_goal(self) -> bool:
        """目标续跑：完成标记 / 轮次用尽 / 上一轮非正常结束都不续。"""
        g = self.goal
        if g is None or not g.can_continue():
            return False
        if self._last_turn_reason != "completed":
            return False
        from app.agent.runtime.goal import GOAL_DONE_MARKER, save_goal
        if GOAL_DONE_MARKER in (self.session.last_assistant_text() or ""):
            g.phase = "complete"
            save_goal(self.session, g)
            return False
        self.inbox.followup(g.reminder(), source="goal")
        return True

    # ── 单轮 ─────────────────────────────────────────────
    def _trace(self, event: str, data: Dict[str, Any]) -> None:
        """run 级审计留痕：一次运行一个文件 `storage/agent_traces/<run_id>.jsonl`。

        与「会话事件日志」（`storage/agent_sessions/*/events.v1.jsonl`，全量事件溯源、
        给模型当记忆用）分工不同：这里只记**审计关心的骨架**（回合边界、工具名/状态/
        耗时/错误），一个文件对应一次运行，便于按运行检索与统计。

        注意：**不落工具入参的值** —— provider_* 类工具的参数里带 api_key，
        写进磁盘就是泄密面。只留参数名，够定位"调了什么"即可。
        """
        try:
            from app.agent.trace import log_event
            log_event(self._run_id, event, data)
        except Exception:
            pass

    async def _run_turn(self) -> None:
        claimed = self.inbox.claim()
        if not claimed:
            return
        # 用户消息被领取 → 重置自动唤醒预算（人已接手推进，解除后台通知的防自激限流）
        try:
            if any(getattr(m, "source", "") == "user" for m in claimed):
                self._auto_wake_budget = self._auto_wake_full
        except Exception:
            pass
        self._header_logged_this_turn = 0
        self._turn_seq += 1
        self._run_id = f"{self.session.id}_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        self._turn_started_at = time.time()
        self.session.append(E.TURN_START, {"mode": self.mode, "run_mode": self.run_mode, "run_id": self._run_id})
        self._trace("turn_start", {
            "session_id": self.session.id,
            "mode": self.mode,
            "run_mode": self.run_mode,
            "input": (claimed[0].text[:200] if claimed else ""),
        })
        self._open_turn = True
        reason = "completed"
        final_text = ""
        safety_cap = self._max_steps
        _llm_token = None
        try:
            from app.agent.llm.adapter import push_chat_override
            from app.llm.plaza import chat_override_from_context
            _llm_token = push_chat_override(chat_override_from_context(self.context))
        except Exception:
            _llm_token = None
        try:
            for m in claimed:
                self.session.append(E.USER_MESSAGE, m.to_event_data())
            # 目标轮次预占-准入：目标提示真正进入历史时才计一轮
            if self.goal is not None and any(getattr(m, "source", "") == "goal" for m in claimed):
                self.goal.rounds_started += 1
                from app.agent.runtime.goal import save_goal
                save_goal(self.session, self.goal)
            first_text = claimed[0].text[:40] if claimed else ""
            await self._emit({"event": "agent_thinking", "message": f"正在解析导演指令: 「{first_text}」..."})
            system_text = build_system_prompt(plan_mode=self.plan_mode, run_mode=self.run_mode)
            _profile = getattr(self, "agent_profile", None)
            if _profile is not None:
                try:
                    system_text = f"{system_text}\n\n{_profile.system_prompt}"
                except Exception:
                    pass
            self._turn_system_text = system_text
            # 幂等 append：系统提示词/运行时上下文与上次一致时不重复落账（稳定 KV-cache 前缀）
            self.session.append_system_if_changed(system_text)
            context_block = build_context_block(self.context)
            if context_block:
                self.session.append_context_if_changed(context_block)
            # 画布「加入会话」节点的已有产出：自动作为媒体附件注入（图片始终；视频/音频按开关）
            try:
                from app.agent.runtime.attachments import attachments_from_focus_nodes
                _focus_atts = [
                    a for a in attachments_from_focus_nodes(self.context)
                    if a.get("ref") and a["ref"] not in self._seen_media_refs
                ]
                if _focus_atts:
                    for a in _focus_atts:
                        self._seen_media_refs.add(a["ref"])
                    self.session.append(E.USER_MESSAGE, {
                        "text": "【会话关注节点（画布已加入会话）的已有产出（自动附带）】",
                        "source": "canvas-focus", "form": "notice",
                        "meta": {"attachments": _focus_atts},
                    })
                    await self._emit({"event": "media_attached", "tool_name": "canvas_focus",
                                      "items": [{k: a.get(k) for k in ("kind", "name", "ref")} for a in _focus_atts]})
            except Exception:
                pass
            tools = self._tool_schemas()
            step_index = 0
            bad_args_streak = 0
            trunc_streak = 0
            overflow_compacts = 0
            while True:
                if step_index >= safety_cap:
                    reason = "max-steps"
                    break
                step_index += 1
                self._open_step = True
                self.session.append(E.STEP_START, {"index": step_index})
                step_reason = "completed"
                try:
                    try:
                        from app.agent.runtime.compaction import maintain_context
                        await maintain_context(self.session, emit=self._emit,
                                               system_text=self._turn_system_text or None)
                    except Exception:
                        pass
                    messages = self.session.derive_messages(system_text=system_text)
                    cfg = adapter.resolve()
                    self._log_request_header(cfg, tools)
                    reply = await self._call_model(messages, tools)
                    truncated = reply.finish_reason == "length"
                    # 截断时也保留模型实际发出的调用（日志事实）；非法参数在被丢弃时补错误结果配对
                    tool_calls = list(reply.tool_calls)
                    self.session.append(E.ASSISTANT_MESSAGE, {
                        "text": reply.content or "",
                        "thinking": reply.reasoning or "",
                        "tool_calls": [
                            {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                            for tc in tool_calls
                        ],
                        "usage": reply.usage or {},
                        "finish_reason": reply.finish_reason,
                    })
                    if truncated:
                        trunc_streak += 1
                        # 长思考/长参数吃满输出上限（reasoning 也计入 completion_tokens）时
                        # finish_reason=length：块级保留（对标 dsh BlockAssembler）——
                        # 只丢弃参数非法/不完整的调用，完整合法的调用照常执行；
                        # 随后注入"停止展开思考、参数从简"提示并在同一回合内继续；
                        # 连续多次截断才终止，避免死循环。
                        _good_t = [tc for tc in reply.tool_calls if getattr(tc, "arguments_valid", True)]
                        _bad_t = [tc for tc in reply.tool_calls if not getattr(tc, "arguments_valid", True)]
                        if _bad_t:
                            await self._emit({"event": "error",
                                              "message": f"模型输出达到长度上限：{len(_bad_t)} 个不完整工具调用已丢弃"
                                                         + (f"，{len(_good_t)} 个完整调用照常执行" if _good_t else "")
                                                         + "…"})
                        for tc in _bad_t:
                            _err_t = "工具参数 JSON 不完整（输出被截断），已跳过执行；请精简参数后重试。"
                            self.session.append(E.TOOL_CALL, {"call_id": tc.id, "name": tc.name, "arguments": {}})
                            self.session.append(E.TOOL_RESULT, {"call_id": tc.id, "name": tc.name,
                                                                "status": "error", "result": None, "error": _err_t})
                        if _good_t:
                            # 完整合法的调用照常执行（块级保留：截断不牵连可用调用）
                            await self._execute_tools(_good_t)
                        if trunc_streak <= 2:
                            await self._emit({"event": "agent_thinking", "message": f"输出达到长度上限被截断（第 {trunc_streak} 次），正压缩思考继续执行…"})
                            self.session.append(E.USER_MESSAGE, {
                                "text": (
                                    "[系统] 你上一条回复在思考/输出中途因输出长度上限被截断，"
                                    "不完整的工具调用已丢弃（完整合法的已执行）。"
                                    "请立刻直接行动：不要复述思考、不要解释，优先输出下一步工具调用；"
                                    "参数务必从简且一次给出完整合法 JSON（长文档/长文本拆成多次调用分步提交）。"
                                ),
                                "source": "system", "form": "notice",
                            })
                            self._claim_steers()
                            continue
                        reason = "max-tokens"
                        final_text = ("模型输出连续达到长度上限，未能产出完整执行指令；"
                                      "请到「设置 → 系统」调大「单次回复最大 token」（AGENT_MAX_TOKENS），"
                                      "或把任务拆小后重试。")
                        await self._emit({"event": "error", "message": final_text})
                        break
                    if tool_calls:
                        # 参数被截断/非法（多为输出超长）：绝不执行，也绝不把非法 JSON 回传上游，
                        # 以结构化错误让模型自行精简重试（历史投影层还会二次清洗，防毒化会话）。
                        bad = [tc for tc in tool_calls if not getattr(tc, "arguments_valid", True)]
                        good = [tc for tc in tool_calls if getattr(tc, "arguments_valid", True)]
                        for tc in bad:
                            _err = ("工具参数 JSON 不完整或非法（多为输出超长被截断），已跳过执行。"
                                    "请精简参数后重试：长文档分段传入、批量任务拆分，或直接提供精简版 code。")
                            self.session.append(E.TOOL_CALL, {"call_id": tc.id, "name": tc.name, "arguments": {}})
                            await self._emit({"event": "tool_calling", "tool_name": tc.name,
                                              "arguments": {}, "status": "error"})
                            self.session.append(E.TOOL_RESULT, {"call_id": tc.id, "name": tc.name,
                                                                "status": "error", "result": None, "error": _err})
                            await self._emit({"event": "tool_result", "tool_name": tc.name,
                                              "status": "error", "result": None, "error": _err})
                        bad_args_streak = bad_args_streak + 1 if bad else 0
                        if good:
                            await self._execute_tools(good)
                        self._claim_steers()
                        if bad_args_streak >= 3:
                            reason = "error"
                            await self._emit({"event": "error", "message": "连续多轮工具参数被截断/非法，已停止本回合；请精简指令或缩短文档后重试。"})
                            break
                        continue
                    final_text = reply.content or ""
                    steers = self._claim_steers()
                    if steers:
                        continue
                    break
                except asyncio.CancelledError:
                    reason = "aborted"
                    raise
                except LLMConfigError as e:
                    if await self._recover_context_overflow(e, overflow_compacts):
                        overflow_compacts += 1
                        continue
                    reason = "error"
                    self.session.append(E.ASSISTANT_ATTEMPT, {"error": str(e)[:500], "terminal": True})
                    await self._emit({"event": "error", "message": str(e)})
                    break
                except Exception as e:
                    if await self._recover_context_overflow(e, overflow_compacts):
                        overflow_compacts += 1
                        continue
                    reason = "error"
                    self.session.append(E.ASSISTANT_ATTEMPT, {"error": str(e)[:500], "terminal": True})
                    await self._emit({"event": "error", "message": f"模型调用失败: {e}"})
                    break
                finally:
                    if self._open_step:
                        self.session.append(E.STEP_END, {"index": step_index})
                        self._open_step = False
                if reason in ("error", "max-steps"):
                    break
        finally:
            if _llm_token is not None:
                try:
                    from app.agent.llm.adapter import pop_chat_override
                    pop_chat_override(_llm_token)
                except Exception:
                    pass
            if self._open_turn:
                self._close_turn(reason)
            self._last_turn_reason = reason
            try:
                await asyncio.shield(self._emit({
                    "event": "agent_response",
                    "message": final_text or self.session.last_assistant_text() or ("已暂停" if reason == "aborted" else "指令已执行。"),
                    "thinking": None,
                    "suggested_actions": [] if reason == "aborted" else [],
                    "executed_tools": [],
                    "mode": self.mode,
                    "run_mode": self.run_mode,
                }))
            except Exception:
                pass

    def _close_turn(self, reason: str, cause: str = "") -> None:
        if not self._open_turn:
            return
        self.session.append(E.TURN_END, {"reason": reason, "cause": cause or reason})
        self._trace("turn_end", {
            "reason": reason,
            "cause": cause or reason,
            "elapsed_ms": int((time.time() - self._turn_started_at) * 1000) if self._turn_started_at else None,
        })
        self._open_turn = False
        if self._open_step:
            self.session.append(E.STEP_END, {"index": -1, "note": "interrupted"})
            self._open_step = False

    # ── 工具执行 ─────────────────────────────────────────
    # 并发安全工具（只读/查询为主）：同一步内相邻调用并行执行（对标 dsh 并行工具调度）。
    # 未列出的工具一律独占执行（变更/生成类不并行；保守优先，宁可慢不撞车）。
    _PARALLEL_SAFE_TOOLS = frozenset({
        "list_assets", "get_asset", "canvas_query", "canvas_query_assets",
        "list_image_providers", "list_voice_providers", "list_video_providers",
        "list_voices", "list_comfyui_workflows", "list_custom_providers",
        "get_provider_code", "provider_key_status", "fs_read", "read_skill",
        "view_media", "search_tools", "job_list", "job_status", "task_status",
        "subagent_list", "subagent_status", "onekey_summary", "onekey_review",
        "stage_get_state", "list_custom_nodes",
    })

    @classmethod
    def _is_parallel_safe(cls, name: str) -> bool:
        try:
            if name in cls._PARALLEL_SAFE_TOOLS:
                return True
            from app.agent.tools.registry import tool_view
            t = tool_view.get(name)
            if t is not None and getattr(t, "concurrency_safe", None) is True:
                return True
        except Exception:
            pass
        return False

    def _fill_tool_results(self, tool_calls: List[Any], error: str) -> None:
        """中断/异常时为未结算的工具调用补错误结果，保证历史 tool_calls 全部有响应。"""
        for tc in tool_calls:
            self.session.append(E.TOOL_RESULT, {
                "call_id": tc.id, "name": tc.name, "status": "error", "result": None,
                "error": str(error)[:300],
            })

    async def _execute_tools(self, tool_calls: List[Any]) -> None:
        max_par = max(1, min(_env_int("AGENT_MAX_PARALLEL_TOOL_CALLS", 4), 8))
        i, n = 0, len(tool_calls)
        while i < n:
            if max_par > 1 and self._is_parallel_safe(getattr(tool_calls[i], "name", "")):
                j = i
                while (j < n and (j - i) < max_par
                       and self._is_parallel_safe(getattr(tool_calls[j], "name", ""))):
                    j += 1
                if j - i >= 2:
                    await self._execute_tools_parallel(tool_calls[i:j])
                    i = j
                    continue
            await self._execute_tool(tool_calls[i])
            i += 1

    async def _execute_tool(self, tc: Any) -> None:
        self.session.append(E.TOOL_CALL, {
            "call_id": tc.id, "name": tc.name, "arguments": tc.parsed or {},
        })
        await self._emit({
            "event": "tool_calling", "tool_name": tc.name,
            "arguments": tc.parsed or {}, "status": "executing",
        })
        _t0 = time.time()
        try:
            outcome = await self.pipeline.execute(
                tc.id, tc.name, tc.parsed or {},
                project_context=(self.context or {}).get("project"),
                run_mode=self.run_mode,
            )
        except asyncio.CancelledError:
            self._fill_tool_results([tc], "用户中止，工具结果未知（恢复后请先检查外部状态再重试）。")
            raise
        except Exception as e:
            self._fill_tool_results([tc], f"工具执行异常: {e}")
            raise
        await self._settle_tool_result(tc, outcome, _t0)

    async def _execute_tools_parallel(self, group: List[Any]) -> None:
        """并行执行一组并发安全调用；事件与结果按模型序落账（与顺序路径完全同形）。"""
        for tc in group:
            self.session.append(E.TOOL_CALL, {
                "call_id": tc.id, "name": tc.name, "arguments": tc.parsed or {},
            })
            await self._emit({
                "event": "tool_calling", "tool_name": tc.name,
                "arguments": tc.parsed or {}, "status": "executing",
            })
        t0s = {id(tc): time.time() for tc in group}

        async def _one(tc: Any) -> Any:
            try:
                return await self.pipeline.execute(
                    tc.id, tc.name, tc.parsed or {},
                    project_context=(self.context or {}).get("project"),
                    run_mode=self.run_mode,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                from app.agent.tools.pipeline import ToolOutcome
                return ToolOutcome(tc.id, tc.name, "error", error=f"工具执行异常: {e}")

        tasks = [asyncio.create_task(_one(tc)) for tc in group]
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            for t in tasks:
                if not t.done():
                    t.cancel()
            self._fill_tool_results(group, "用户中止，工具结果未知（恢复后请先检查外部状态再重试）。")
            raise
        for tc, res in zip(group, results):
            if isinstance(res, BaseException):
                err = "已取消（结果未知）" if isinstance(res, asyncio.CancelledError) else str(res)[:300]
                self.session.append(E.TOOL_RESULT, {
                    "call_id": tc.id, "name": tc.name, "status": "error", "result": None, "error": err,
                })
                await self._emit({"event": "tool_result", "tool_name": tc.name,
                                  "status": "error", "result": None, "error": err})
                continue
            await self._settle_tool_result(tc, res, t0s.get(id(tc), time.time()))

    async def _settle_tool_result(self, tc: Any, outcome: Any, _t0: float) -> None:
        """工具结果结算（单执行/并行共用）：落账 → 实时事件 → 审计 → 上下文注入 → 媒体回投。"""
        self.session.append(E.TOOL_RESULT, {
            "call_id": tc.id, "name": tc.name, "status": outcome.status,
            "result": outcome.result if outcome.status == "success" else None,
            "model_content": outcome.model_content or "",
            "error": outcome.error, "meta": outcome.meta or None,
        })
        await self._emit({
            "event": "tool_result", "tool_name": tc.name, "status": outcome.status,
            "result": outcome.result if outcome.status == "success" else None,
            "error": outcome.error, "meta": outcome.meta or None,
        })
        # 审计：被拒（denied）/超时（error）也会走到这里，正好把"没执行成功"的原因留痕
        self._trace("tool", {
            "name": tc.name,
            "status": outcome.status,
            "elapsed_ms": int((time.time() - _t0) * 1000),
            "error": ((outcome.error or "")[:300] or None),
            # 只记参数名不记值（provider_* 会带 api_key）
            "arg_keys": sorted((tc.parsed or {}).keys()),
            "spill": (outcome.meta or {}).get("spill_path"),
        })
        if outcome.additional_context:
            self.inbox.inject(outcome.additional_context, source="plugin", form="notice")
        # 多模态回投：工具产物（图/视频/音频）作为附件注入，让模型下一步"看到"结果
        if outcome.status == "success":
            try:
                atts = list((outcome.meta or {}).get("media_attachments") or [])
                if not atts:
                    from app.agent.runtime.attachments import attachments_from_tool_result
                    atts = attachments_from_tool_result(tc.name, outcome.result)
                atts = [a for a in atts if a.get("ref") and a["ref"] not in self._seen_media_refs]
                if atts:
                    for a in atts:
                        self._seen_media_refs.add(a["ref"])
                    self.session.append(E.USER_MESSAGE, {
                        "text": f"【工具 {tc.name} 的媒体产物（自动附带）】",
                        "source": "tool-media", "form": "notice",
                        "meta": {"attachments": atts},
                    })
                    await self._emit({"event": "media_attached", "tool_name": tc.name,
                                      "items": [{k: a.get(k) for k in ("kind", "name", "ref")} for a in atts]})
            except Exception:
                pass

    # ── 模型调用（流式 + 重试）────────────────────────────
    def _log_request_header(self, cfg: Dict[str, Any], tools: List[Dict[str, Any]]) -> None:
        """请求头按变更落账（对标 dsh request/header）：首次/路由变更/每轮首步才记录。

        模型热切换时写入 durable 用户可见通知（dsh modelSwitchNotice 同形）：
        上一段助手回复由旧模型生成、会话从此刻起使用新模型——宁可重复，不可丢失。
        """
        key = {
            "provider": str(cfg.get("endpoint", "")),
            "model": str(cfg.get("model", "")),
            "tools_count": len(tools),
            "purpose": "plan" if self.plan_mode else self.mode,
        }
        prev: Optional[Dict[str, Any]] = None
        try:
            for ev in reversed(self.session.events):
                if ev.get("type") == E.REQUEST_HEADER:
                    prev = ev.get("data") or {}
                    break
        except Exception:
            prev = None
        route_changed = bool(prev) and (
            prev.get("provider") != key["provider"] or prev.get("model") != key["model"]
        )
        if route_changed:
            try:
                self.session.append(E.USER_MESSAGE, {
                    "text": (
                        f"[模型已切换：{prev.get('model') or '未知'} → {key['model'] or '未知'}；"
                        f"此前的助手回复由 {prev.get('model') or '旧模型'} 生成，会话继续使用 {key['model'] or '新模型'}]"
                    ),
                    "source": "system", "form": "notice",
                })
            except Exception:
                pass
        need = (
            prev is None
            or route_changed
            or self._header_logged_this_turn == 0
            or prev.get("tools_count") != key["tools_count"]
            or prev.get("purpose") != key["purpose"]
        )
        if need:
            reason = "initial" if prev is None else ("change" if route_changed else "series")
            try:
                self.session.append(E.REQUEST_HEADER, {**key, "reason": reason})
            except Exception:
                pass
        self._header_logged_this_turn += 1

    def _tool_schemas(self) -> List[Dict[str, Any]]:
        if self.mode != "execute":
            return []
        schemas = tool_view.schemas(plan_mode=self.plan_mode)
        _profile = getattr(self, "agent_profile", None)
        if _profile is not None:
            schemas = [
                s for s in schemas
                if _profile.allows(str((((s.get("function") or {}).get("name")) or "")))
            ]
        return schemas

    async def _recover_context_overflow(self, err: Exception, used: int) -> bool:
        """上游报"上下文超限"时的应急恢复：强制压缩历史后由调用方重试本步（每回合最多 2 次）。

        默认窗口 800k、压缩阈值 80%（约 64 万 token 才压缩），常规会话不会触发压缩；
        仅当模型真实窗口小于阈值、上游明确拒绝时才走这里兜底——既不"压得太狠"，
        也不至于把长会话直接打死。
        """
        try:
            from app.agent.runtime.compaction import is_context_overflow_error, maybe_compact
            if used >= 2 or not is_context_overflow_error(err):
                return False
            await maybe_compact(self.session, emit=self._emit, force=True,
                                system_text=(self._turn_system_text or None),
                                trigger="context-overflow")
            await self._emit({"event": "agent_thinking", "message": "模型上下文超限，已压缩历史后重试本步…"})
            return True
        except Exception:
            return False

    async def _call_model(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> AssistantReply:
        retries = _env_int("AGENT_LLM_RETRIES", 2)
        timeout = float(_env_int("AGENT_LLM_TIMEOUT", 600))
        max_tokens = _env_int("AGENT_MAX_TOKENS", 32768)
        last_err: Optional[Exception] = None

        for attempt in range(1, retries + 2):
            stream_started = {"text": False, "think": False}
            processed = {"text_len": 0, "think_len": 0}

            async def on_chunk(chunk) -> None:
                if chunk.kind == "text":
                    if not stream_started["text"]:
                        stream_started["text"] = True
                        await self._emit({"event": "agent_stream_start"})
                    # 先结束思考流（模型先推理后正文）
                    if stream_started["think"]:
                        stream_started["think"] = False
                        await self._emit({"event": "agent_thinking_end"})
                    processed["text_len"] += len(chunk.text)
                    await self._emit({"event": "agent_stream_chunk", "delta": chunk.text})
                elif chunk.kind == "reasoning":
                    if not stream_started["think"]:
                        stream_started["think"] = True
                        await self._emit({"event": "agent_thinking_start"})
                    processed["think_len"] += len(chunk.text)
                    await self._emit({"event": "agent_thinking_chunk", "delta": chunk.text})

            try:
                reply = await asyncio.wait_for(
                    adapter.complete(
                        messages, tools=tools or None,
                        temperature=0.3, max_tokens=max_tokens, timeout=timeout,
                        on_chunk=on_chunk,
                    ),
                    timeout=timeout + 30,
                )
                if stream_started["think"]:
                    await self._emit({"event": "agent_thinking_end"})
                return reply
            except asyncio.CancelledError:
                raise
            except LLMConfigError:
                raise
            except Exception as e:
                last_err = e
                if stream_started["think"]:
                    await self._emit({"event": "agent_thinking_end"})
                self.session.append(E.ASSISTANT_ATTEMPT, {"attempt": attempt, "error": str(e)[:500]})
                if attempt <= retries:
                    delay = min(1.5 * attempt, 5.0)
                    try:
                        from app.agent.llm.adapter import error_code_of
                        _code = error_code_of(e)
                    except Exception:
                        _code = ""
                    try:
                        # 重试留账（对标 dsh llm/retry）：等待排定先落账，崩溃后可见"已安排的重试"
                        self.session.append(E.LLM_RETRY, {
                            "attempt": attempt, "max_retries": retries,
                            "delay_ms": int(delay * 1000), "code": _code or None,
                            "error": str(e)[:300],
                        })
                    except Exception:
                        pass
                    await self._emit({"event": "agent_thinking", "message": f"模型调用失败，重试 {attempt}/{retries} …"})
                    await asyncio.sleep(delay)
        raise last_err or LLMTransportError("模型调用失败")

    # ── 插话领取 ─────────────────────────────────────────
    def _claim_steers(self) -> List[Any]:
        steers = self.inbox.claim_step()
        for m in steers:
            self.session.append(E.USER_MESSAGE, m.to_event_data())
        return steers
