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
        self.session = Session.open(session_id, store=store)
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
        self.inbox = Inbox(on_wake=self._wake)
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
            self.jobs.notify_fn = lambda text: self.inbox.followup(text, source="job")
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
            self.session.append(E.SYSTEM_MESSAGE, {"text": system_text})
            context_block = build_context_block(self.context)
            if context_block:
                # 运行时上下文是模型可见输入：以 user 消息形式落账，附在本轮输入之后
                self.session.append(E.USER_MESSAGE, {"text": context_block, "source": "system", "form": "context"})
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
                        await maintain_context(self.session, emit=self._emit)
                    except Exception:
                        pass
                    messages = self.session.derive_messages(system_text=system_text)
                    cfg = adapter.resolve()
                    self.session.append(E.REQUEST_HEADER, {
                        "provider": cfg.get("endpoint", ""),
                        "model": cfg.get("model", ""),
                        "tools_count": len(tools),
                        "purpose": "plan" if self.plan_mode else self.mode,
                    })
                    reply = await self._call_model(messages, tools)
                    truncated = reply.finish_reason == "length"
                    tool_calls = [] if truncated else list(reply.tool_calls)
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
                        # finish_reason=length：截断的工具调用一律丢弃（JSON 不可信），
                        # 但不因此结束回合——明确要求"停止展开思考、参数从简、立刻给出可解析调用"后继续下一步，
                        # 让同一回合内仍能产出执行指令；连续多次截断才终止，避免死循环。
                        if reply.tool_calls:
                            await self._emit({"event": "error", "message": "模型输出达到长度上限，工具调用被截断已丢弃；正在要求模型精简参数后重试…"})
                        if trunc_streak <= 2:
                            await self._emit({"event": "agent_thinking", "message": f"输出达到长度上限被截断（第 {trunc_streak} 次），正压缩思考继续执行…"})
                            self.session.append(E.USER_MESSAGE, {
                                "text": (
                                    "[系统] 你上一条回复在思考/输出中途因输出长度上限被截断，"
                                    "其中不完整的工具调用已全部丢弃，尚未产出可执行指令。"
                                    "请立刻直接行动：不要复述思考、不要解释，优先输出下一步工具调用；"
                                    "参数务必从简且一次给出完整合法 JSON（长文档/长文本拆成多次调用分步提交）。"
                                ),
                                "source": "system", "form": "notice",
                            })
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
    def _fill_tool_results(self, tool_calls: List[Any], error: str) -> None:
        """中断/异常时为未结算的工具调用补错误结果，保证历史 tool_calls 全部有响应。"""
        for tc in tool_calls:
            self.session.append(E.TOOL_RESULT, {
                "call_id": tc.id, "name": tc.name, "status": "error", "result": None,
                "error": str(error)[:300],
            })

    async def _execute_tools(self, tool_calls: List[Any]) -> None:
        for idx, tc in enumerate(tool_calls):
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
                self._fill_tool_results(tool_calls[idx:],
                                        "用户中止，工具结果未知（恢复后请先检查外部状态再重试）。")
                raise
            except Exception as e:
                self._fill_tool_results(tool_calls[idx:], f"工具执行异常: {e}")
                raise
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
            await maybe_compact(self.session, emit=self._emit, force=True)
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
                    await self._emit({"event": "agent_thinking", "message": f"模型调用失败，重试 {attempt}/{retries} …"})
                    await asyncio.sleep(min(1.5 * attempt, 5.0))
        raise last_err or LLMTransportError("模型调用失败")

    # ── 插话领取 ─────────────────────────────────────────
    def _claim_steers(self) -> List[Any]:
        steers = self.inbox.claim_step()
        for m in steers:
            self.session.append(E.USER_MESSAGE, m.to_event_data())
        return steers
