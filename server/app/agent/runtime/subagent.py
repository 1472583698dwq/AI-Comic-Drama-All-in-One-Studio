# -*- coding: utf-8 -*-
"""子代理集群 — 参考 Kimi Agent Swarm / Claude Code Subagents 的并行委派实现。

三种运行形态（统一入口 SubAgentPool.spawn / spawn_batch）：
- 同步（sync）：父代理阻塞等待结果——"结果决定下一步"（拆解、导出）；
- 异步（async/background）：立即返回句柄，完成后通知注入父 Inbox——"fire-and-steer"（生图/视频/配音）；
- 批量（batch）：同质任务一次扇出 N 个子代理并行执行，受会话级信号量约束。

纪律：
- 深度限制（AGENT_SUBAGENT_MAX_DEPTH）、并发上限（AGENT_SUBAGENT_MAX_CONCURRENCY）同步/异步共用；
- Critical Steps 指标：批量完成时记录最慢子项耗时与观测到的并行宽度（防假并行）；
- Context Sharding：子代理独立会话，只回最终结果；父会话可见 started/progress/settled 事件。
- 功能开关 ``agent_subagent``（设置 → 功能开关，出厂关闭）关闭时，两个启动入口
  （``spawn`` / ``spawn_batch``）直接返回与既有失败分支同形状的 ``{"status": "error", …}``，
  不抛异常、不打断调用方（工具层照既有 error 分支处理）；
  查询/控制类入口（list/status/wait/cancel/steer）不受影响，仍能读到已存在的句柄。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.agent.runtime import events as E
from app.agent.runtime.agents import AgentProfile, get_profile

#: 归本模块管的功能开关 id（子代理委派）
FEATURE_ID = "agent_subagent"
#: 关闭时的统一话术（与页面开关的 404 detail 同一措辞风格：指向设置页）
DISABLED_ERROR = "子代理能力已关闭（设置 → 功能开关）"


def feature_on() -> bool:
    """子代理能力是否开启（未知/读盘失败 → False，即视为关闭）。"""
    try:
        from app.core import features
        return features.is_enabled(FEATURE_ID)
    except Exception:
        return False


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except Exception:
        return default


def _depth_of(loop) -> int:
    try:
        return int((getattr(loop, "context", None) or {}).get("subagent_depth") or 0)
    except Exception:
        return 0


_EMPTY_RESULT = "（子代理未产出文本结果）"


def _session_id_of(loop) -> str:
    try:
        return str(getattr(getattr(loop, "session", None), "id", "") or "")
    except Exception:
        return ""


@dataclass
class SubAgentHandle:
    id: str
    agent: str
    task: str
    status: str = "queued"          # queued | running | success | error | cancelled
    background: bool = False
    batch_id: str = ""
    session_id: str = ""
    parent_session_id: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    settled_at: float = 0.0
    result: str = ""
    error: str = ""
    # 终态原因谱系（对标 dsh SubagentStopReason）：completed|max-tokens|aborted|error|interrupted|refusal
    stop_reason: str = ""
    # 结构化输出（output_schema 请求时抽取/校验的 JSON 对象；未请求为 None）
    structured: Any = None
    output_schema: Any = None
    loop: Any = None

    @property
    def elapsed_ms(self) -> int:
        if not self.started_at:
            return 0
        end = self.settled_at or time.time()
        return int((end - self.started_at) * 1000)

    def brief(self) -> Dict[str, Any]:
        return {
            "subagent_id": self.id, "agent": self.agent, "status": self.status,
            "task": self.task[:120], "background": self.background,
            "batch_id": self.batch_id, "session_id": self.session_id,
            "elapsed_ms": self.elapsed_ms,
            **({"stop_reason": self.stop_reason} if self.stop_reason else {}),
        }


def _extract_structured(text: str, schema: Any) -> Tuple[Any, str]:
    """从子代理最终文本抽取结构化 JSON 并做轻量校验（对标 dsh structured output）。

    返回 ``(value, status)``：status ∈ ok | missing（未找到 JSON）| invalid（不满足 schema）。
    抽取顺序：```json 围栏块 → 整段 JSON → 首个平衡大括号对象。
    """
    import re as _re
    s = (text or "").strip()
    if not s:
        return None, "missing"
    candidates: List[str] = []
    for m in _re.finditer(r"```(?:json)?\s*([\s\S]*?)```", s, _re.IGNORECASE):
        candidates.append(m.group(1).strip())
    candidates.append(s)
    # 首个 { ... } 平衡片段（贪婪到最后一个 }，交给 json.loads 容错）
    first, last = s.find("{"), s.rfind("}")
    if first >= 0 and last > first:
        candidates.append(s[first:last + 1])
    value = None
    for c in candidates:
        if not c:
            continue
        try:
            v = json.loads(c)
            if isinstance(v, (dict, list)):
                value = v
                break
        except Exception:
            continue
    if value is None:
        return None, "missing"
    if isinstance(schema, dict) and schema:
        if not isinstance(value, dict):
            return value, "invalid"
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if str(key) and str(key) not in value:
                    return value, "invalid"
    return value, "ok"


class SubAgentPool:
    def __init__(self) -> None:
        self._handles: Dict[str, SubAgentHandle] = {}
        self._tasks: Dict[str, asyncio.Task] = {}
        self._sem: Dict[str, asyncio.Semaphore] = {}
        self._active: Dict[str, int] = {}
        self._peak: Dict[str, int] = {}
        self._orders: List[str] = []

    # ── 限额 ─────────────────────────────────────────────
    def _max_concurrency(self) -> int:
        return max(1, min(_env_int("AGENT_SUBAGENT_MAX_CONCURRENCY", 6), 32))

    def _max_depth(self) -> int:
        return max(0, _env_int("AGENT_SUBAGENT_MAX_DEPTH", 2))

    def _batch_max(self) -> int:
        return max(1, min(_env_int("AGENT_SUBAGENT_BATCH_MAX", 30), 100))

    def _timeout(self, override: Optional[float]) -> float:
        if override:
            return float(override)
        return float(_env_int("AGENT_SUBAGENT_TIMEOUT", 1200))

    def _semaphore(self, parent) -> asyncio.Semaphore:
        key = _session_id_of(parent) or "default"
        sem = self._sem.get(key)
        if sem is None:
            sem = asyncio.Semaphore(self._max_concurrency())
            self._sem[key] = sem
        return sem

    # ── 父会话桥接（全部容错：测试/宿主缺失时静默降级）──────
    async def _notify_parent(self, parent, event_type: str, data: Dict[str, Any]) -> None:
        try:
            sess = getattr(parent, "session", None)
            if sess is not None and hasattr(sess, "append"):
                sess.append(event_type, data)
        except Exception:
            pass
        try:
            emit = getattr(parent, "_emit", None)
            if callable(emit):
                r = emit({"event": event_type.replace("/", "_"), **data})
                if asyncio.iscoroutine(r):
                    await r
        except Exception:
            pass

    def _inbox_notify(self, parent, text: str) -> None:
        """后台子代理完成通知：优先走父会话的预算化通知口（busy→插话 / idle→有预算才开轮）。"""
        try:
            cb = getattr(parent, "_notify_job_done", None)
            if callable(cb):
                cb(text)
                return
        except Exception:
            pass
        try:
            ib = getattr(parent, "inbox", None)
            if ib is not None and hasattr(ib, "followup"):
                ib.followup(text, source="subagent")
        except Exception:
            pass

    # ── 查询/控制 ────────────────────────────────────────
    def get(self, subagent_id: str) -> Optional[SubAgentHandle]:
        return self._handles.get(subagent_id)

    def list(self, parent=None, limit: int = 50) -> List[Dict[str, Any]]:
        psid = _session_id_of(parent) if parent is not None else ""
        out: List[SubAgentHandle] = []
        for sid in reversed(self._orders):
            h = self._handles.get(sid)
            if h is None:
                continue
            if psid and h.parent_session_id != psid:
                continue
            out.append(h)
            if len(out) >= limit:
                break
        return [h.brief() for h in out]

    async def cancel(self, subagent_id: str) -> Dict[str, Any]:
        h = self._handles.get(subagent_id)
        if h is None:
            return {"status": "error", "error": f"子代理不存在: {subagent_id}"}
        if h.status in ("success", "error", "cancelled"):
            return {"status": "error", "error": f"子代理已结束（{h.status}），无需取消"}
        t = self._tasks.get(subagent_id)
        if t is not None and not t.done():
            t.cancel()
        return {"subagent_id": subagent_id, "status": "cancelling"}

    async def steer(self, subagent_id: str, text: str) -> Dict[str, Any]:
        h = self._handles.get(subagent_id)
        if h is None:
            return {"status": "error", "error": f"子代理不存在: {subagent_id}"}
        if h.status != "running" or h.loop is None:
            return {"status": "error", "error": f"子代理不在运行中（{h.status}），无法插话"}
        try:
            await h.loop.steer(text)
            return {"subagent_id": subagent_id, "status": "steered"}
        except Exception as e:
            return {"status": "error", "error": str(e)[:200]}

    async def wait(self, subagent_id: str = "", batch_id: str = "",
                   timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """阻塞等待一个子代理（或整批）完成——异步提交后的同步收口。

        - subagent_id：等待单个子代理；batch_id：等待该批次全部子代理；
        - 已结束的立即返回；超时返回当前状态快照（timed_out=true），不取消任务。
        """
        handles: List[SubAgentHandle] = []
        if subagent_id:
            h = self._handles.get(subagent_id)
            if h is None:
                return {"status": "error", "error": f"子代理不存在: {subagent_id}"}
            handles = [h]
        elif batch_id:
            handles = [h for h in self._handles.values() if h.batch_id == batch_id]
            if not handles:
                return {"status": "error", "error": f"批次不存在或已过期: {batch_id}"}
        else:
            return {"status": "error", "error": "subagent_wait 需要 subagent_id 或 batch_id"}

        to = float(timeout_s or _env_int("AGENT_SUBAGENT_WAIT_TIMEOUT", 1800))
        pending = []
        for h in handles:
            t = self._tasks.get(h.id)
            if h.status in ("queued", "running") and t is not None and not t.done():
                pending.append(t)
        timed_out = False
        if pending:
            done, not_done = await asyncio.wait(set(pending), timeout=to)
            timed_out = bool(not_done)

        def _item(h: SubAgentHandle) -> Dict[str, Any]:
            return {
                "subagent_id": h.id, "agent": h.agent, "status": h.status,
                "task": h.task[:120], "elapsed_ms": h.elapsed_ms,
                "result": (h.result[:3000] if h.status == "success" else None),
                "error": h.error or None,
                **({"stop_reason": h.stop_reason} if h.stop_reason else {}),
                **({"structured": h.structured} if (h.output_schema is not None and h.status == "success") else {}),
            }

        if subagent_id:
            out = _item(handles[0])
            out["timed_out"] = timed_out
            if timed_out:
                out["note"] = f"等待超时（{to:.0f}s），任务仍在运行，可再次 subagent_wait"
            return out
        success = sum(1 for h in handles if h.status == "success")
        failed = sum(1 for h in handles if h.status in ("error", "cancelled"))
        return {
            "batch_id": batch_id,
            "status": ("timeout" if timed_out else ("success" if failed == 0 else "partial")),
            "total": len(handles), "success": success, "failed": failed,
            "settled": len(handles) - len(pending),
            "critical_steps_ms": max((h.elapsed_ms for h in handles), default=0),
            "timed_out": timed_out,
            "items": [_item(h) for h in handles],
        }

    # ── 启动 ─────────────────────────────────────────────
    def _launch(self, parent, agent: str, task: str, context: Optional[Dict[str, Any]],
                max_steps: Optional[int], timeout_s: Optional[float],
                background: bool, batch_id: str = "",
                output_schema: Optional[Dict[str, Any]] = None) -> Tuple[SubAgentHandle, asyncio.Task]:
        h = SubAgentHandle(
            id=f"sub_{uuid.uuid4().hex[:8]}",
            agent=agent,
            task=task,
            status="queued",
            background=background,
            batch_id=batch_id,
            parent_session_id=_session_id_of(parent),
            output_schema=output_schema or None,
        )
        self._handles[h.id] = h
        self._orders.append(h.id)
        self._prune()
        task_obj = asyncio.get_running_loop().create_task(
            self._guarded_run(parent, h, get_profile(agent), context, max_steps, timeout_s)
        )
        self._tasks[h.id] = task_obj
        return h, task_obj

    def _result_of(self, h: SubAgentHandle, limit: int = 6000) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "subagent_id": h.id, "agent": h.agent, "status": h.status,
            "task": h.task[:120], "elapsed_ms": h.elapsed_ms,
        }
        if h.stop_reason:
            out["stop_reason"] = h.stop_reason
        if h.status == "success":
            out["result"] = (h.result or "")[:limit]
            if h.output_schema is not None:
                out["structured"] = h.structured
        else:
            out["error"] = h.error or "子代理执行失败"
        return out

    async def spawn(self, parent, agent: str, task: str,
                    context: Optional[Dict[str, Any]] = None,
                    background: bool = False,
                    max_steps: Optional[int] = None,
                    timeout_s: Optional[float] = None,
                    auto_bg_ok: bool = True,
                    output_schema: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """委派单个子任务。

        background=False（默认）同步阻塞直到结果返回；
        background=True 立即返回句柄（完成后通知，可用 subagent_wait 阻塞等待）。
        auto_bg_ok=False 时禁用「同步超时自动转后台」，保证严格阻塞语义。
        output_schema 给定时要求子代理以 JSON 返回并做校验（不合规视为失败）。
        """
        if not feature_on():  # 功能开关关闭：同步/异步全路径都在这里被挡住
            return {"status": "error", "error": DISABLED_ERROR}
        task = str(task or "").strip()
        if not task:
            return {"status": "error", "error": "subagent_run 需要非空 task"}
        if _depth_of(parent) >= self._max_depth():
            return {"status": "error",
                    "error": f"子代理深度已达上限（{self._max_depth()}），禁止继续嵌套委派"}
        h, task_obj = self._launch(parent, agent, task, context, max_steps, timeout_s, background,
                                   output_schema=output_schema)
        if background:
            return {**h.brief(), "status": "launched",
                    "note": "子代理已后台运行，完成后会自动通知；可用 subagent_wait 阻塞等待，"
                            "或用 subagent_list/subagent_status 查询。"}
        auto_bg = _env_float("AGENT_SUBAGENT_AUTO_BG_S", 0)
        if auto_bg > 0 and auto_bg_ok:
            done, _pending = await asyncio.wait({task_obj}, timeout=auto_bg)
            if not done:
                h.background = True
                return {**h.brief(), "status": "launched", "auto_background": True,
                        "note": f"同步等待超过 {auto_bg:.0f}s 已自动转后台，完成后自动通知。"}
        try:
            await task_obj
        except asyncio.CancelledError:
            h.status = "cancelled"
        except Exception as e:
            h.status = "error"
            h.error = str(e)[:500]
        return self._result_of(h)

    async def spawn_batch(self, parent, agent: str, items: List[Dict[str, Any]],
                          background: bool = False,
                          context: Optional[Dict[str, Any]] = None,
                          max_steps: Optional[int] = None,
                          timeout_s: Optional[float] = None,
                          output_schema: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """同质任务批量扇出：items=[{task, context?}, ...]，并行受会话信号量约束。

        注：batch 走的是独立入口（不经 ``spawn``），故这里单独加同一道闸。
        """
        if not feature_on():
            return {"status": "error", "error": DISABLED_ERROR}
        if not isinstance(items, list) or not items:
            return {"status": "error", "error": "subagent_run.batch 需要非空数组"}
        if _depth_of(parent) >= self._max_depth():
            return {"status": "error",
                    "error": f"子代理深度已达上限（{self._max_depth()}），禁止继续嵌套委派"}
        items = items[: self._batch_max()]
        batch_id = f"batch_{uuid.uuid4().hex[:8]}"
        handles: List[SubAgentHandle] = []
        tasks: List[asyncio.Task] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            t = str(it.get("task") or "").strip()
            if not t:
                continue
            ctx = dict(context or {})
            if isinstance(it.get("context"), dict):
                ctx.update(it["context"])
            h, task_obj = self._launch(parent, agent, t, ctx, max_steps, timeout_s, background,
                                       batch_id, output_schema=output_schema)
            handles.append(h)
            tasks.append(task_obj)
        if not handles:
            return {"status": "error", "error": "batch 内没有合法任务项（每项需 {task}）"}
        if background:
            asyncio.get_running_loop().create_task(
                self._watch_batch(parent, batch_id, handles, tasks)
            )
            return {"batch_id": batch_id, "agent": agent, "status": "launched", "total": len(handles),
                    "note": "批量子代理已后台运行，全部完成后自动通知；可用 subagent_list 查询。"}
        await asyncio.gather(*tasks, return_exceptions=True)
        summary = await self._batch_summary(parent, batch_id, handles)
        return summary

    async def _watch_batch(self, parent, batch_id: str,
                           handles: List[SubAgentHandle], tasks: List[asyncio.Task]) -> None:
        try:
            await asyncio.gather(*tasks, return_exceptions=True)
            summary = await self._batch_summary(parent, batch_id, handles)
            briefs = [f"- {h.agent} {h.status}（{h.task[:40]}）" for h in handles]
            self._inbox_notify(
                parent,
                f"【子代理批次完成】{batch_id}：成功 {summary['success']}/{summary['total']}"
                f"，最慢子项 {summary['critical_steps_ms']}ms\n" + "\n".join(briefs[:20]),
            )
        except Exception:
            pass

    async def _batch_summary(self, parent, batch_id: str, handles: List[SubAgentHandle]) -> Dict[str, Any]:
        def _empty(h) -> bool:
            return h.status == "success" and str(h.result or "").strip() in ("", _EMPTY_RESULT)

        total = len(handles)
        success = sum(1 for h in handles if h.status == "success")
        failed = total - success
        no_output = sum(1 for h in handles if _empty(h))
        critical_ms = max((h.elapsed_ms for h in handles), default=0)
        peak = self._peak.pop(batch_id, 0)
        items = []
        for i, h in enumerate(handles):
            entry = {
                "index": i, "subagent_id": h.id, "status": h.status,
                "no_output": True if _empty(h) else None,
                "result": (h.result[:1500] if h.status == "success" else None),
                "error": h.error or None,
            }
            if h.stop_reason:
                entry["stop_reason"] = h.stop_reason
            if h.status == "success" and h.output_schema is not None:
                entry["structured"] = h.structured
            items.append(entry)
        metrics = {"batch_id": batch_id, "agent": handles[0].agent if handles else "",
                   "total": total, "success": success, "failed": failed, "no_output": no_output,
                   "critical_steps_ms": critical_ms, "parallel_width": peak}
        await self._notify_parent(parent, E.SUBAGENT_METRICS, metrics)
        return {"batch_id": batch_id, "status": "success" if failed == 0 else "partial",
                "total": total, "success": success, "failed": failed, "no_output": no_output,
                "note": ("有子项未产出结果（no_output=true），勿当作成功，需核对产物" if no_output else None),
                "critical_steps_ms": critical_ms, "parallel_width": peak,
                "items": items}

    # ── 执行 ─────────────────────────────────────────────
    _CTX_SKIP_KEYS = {"subagent_depth", "parent_session", "project_title", "agent",
                      "subagent_id", "project", "agent_focus_nodes", "canvas_summary"}

    @classmethod
    def _child_prompt(cls, profile, task: str, ctx: Optional[Dict[str, Any]]) -> str:
        """子代理首条提示词：任务文本 + 显式上下文（draft_id 等键值对，保证子代理"看得到"）。"""
        text = f"你是子代理（角色：{profile.name}）。独立完成以下子任务并只输出最终结果：\n{task}"
        pairs = []
        for k, v in (ctx or {}).items():
            if k in cls._CTX_SKIP_KEYS or v is None:
                continue
            if isinstance(v, (str, int, float, bool)):
                s = str(v).strip()
                if s:
                    pairs.append(f"- {k}: {s[:300]}")
            if len(pairs) >= 12:
                break
        if pairs:
            text += "\n\n任务上下文（调用工具时直接使用，不要自行猜测）：\n" + "\n".join(pairs)
        return text

    async def _guarded_run(self, parent, h: SubAgentHandle, profile: AgentProfile,
                           context: Optional[Dict[str, Any]],
                           max_steps: Optional[int], timeout_s: Optional[float]) -> None:
        sem = self._semaphore(parent)
        async with sem:
            if h.batch_id:
                self._active[h.batch_id] = self._active.get(h.batch_id, 0) + 1
                self._peak[h.batch_id] = max(self._peak.get(h.batch_id, 0), self._active[h.batch_id])
            try:
                await self._run_child(parent, h, profile, context, max_steps, timeout_s)
            finally:
                if h.batch_id:
                    self._active[h.batch_id] = max(0, self._active.get(h.batch_id, 1) - 1)

    async def _run_child(self, parent, h: SubAgentHandle, profile: AgentProfile,
                         context: Optional[Dict[str, Any]],
                         max_steps: Optional[int], timeout_s: Optional[float]) -> None:
        from app.agent.runtime.loop import AgentLoop

        h.status = "running"
        h.started_at = time.time()
        child_sid = f"{h.parent_session_id or 'sub'}__sub_{h.id}"
        h.session_id = child_sid
        depth = _depth_of(parent)
        try:
            project_title = (getattr(parent, "context", None) or {}).get("project_title")
        except Exception:
            project_title = None
        ctx = dict(context or {})
        ctx.update({
            "subagent_depth": depth + 1,
            "parent_session": h.parent_session_id,
            "project_title": project_title,
            "agent": profile.name,
            "subagent_id": h.id,
        })
        try:
            store = getattr(getattr(parent, "session", None), "store", None)
        except Exception:
            store = None
        to = self._timeout(timeout_s)

        await self._notify_parent(parent, E.SUBAGENT_STARTED, {
            "subagent_id": h.id, "agent": profile.name, "task": h.task[:200],
            "background": h.background, "batch_id": h.batch_id,
        })

        child = None
        try:
            child = AgentLoop(
                child_sid,
                run_mode=str(getattr(parent, "run_mode", "") or "approve"),
                mode="execute",
                context=ctx,
                interactive=False,
                store=store,
                max_steps=max_steps or profile.max_steps,
                agent_profile=profile,
            )
            h.loop = child
            # 委派策略钉柱（对标 dsh delegation/policy）：权限在派生时固定、审计可见。
            # 子代理 interactive=False → 审批 fail-closed；这里把策略事实写进子会话日志。
            try:
                child.session.append(E.DELEGATION_POLICY, {
                    "run_mode": str(getattr(parent, "run_mode", "") or "approve"),
                    "agent": profile.name,
                    "subagent_id": h.id,
                    "source": "delegation",
                    "approval": "never",  # 子代理无交互通道：ask 一律被拒（fail-closed）
                    "depth": int(ctx.get("subagent_depth") or 0),
                })
            except Exception:
                pass
            self._attach_progress_bridge(parent, h, child)
            _prompt = self._child_prompt(profile, h.task, ctx)
            if isinstance(h.output_schema, dict) and h.output_schema:
                # 结构化输出契约（对标 dsh structured output）：最终回复必须含符合 schema 的 JSON
                try:
                    _schema_text = json.dumps(h.output_schema, ensure_ascii=False)[:4000]
                except Exception:
                    _schema_text = str(h.output_schema)[:4000]
                _prompt += (
                    "\n\n【结构化输出契约】最终回复必须包含一个 ```json 代码块，"
                    "内容为满足以下 JSON Schema 的**单个 JSON 对象**（不要多余解释文本）：\n"
                    f"{_schema_text}"
                )
            if profile.background_default:
                _prompt += ("\n\n【后台纪律】本角色默认后台执行：长耗时任务提交后立即返回（task_id/异步句柄），"
                            "不要阻塞等待完成。")
            await child.prompt(_prompt)
            await child.wait_idle(timeout=to)
            if child.is_running():
                try:
                    await child.abort("timeout")
                except Exception:
                    pass
                h.status = "error"
                h.stop_reason = "aborted"
                h.error = f"子任务超时（{to:.0f}s）"
            else:
                h.status = "success"
                try:
                    h.result = child.session.last_assistant_text() or _EMPTY_RESULT
                except Exception:
                    h.result = _EMPTY_RESULT
                # 终态原因谱系（对标 dsh SubagentStopReason）
                try:
                    h.stop_reason = str(getattr(child, "_last_turn_reason", "") or "completed")
                except Exception:
                    h.stop_reason = "completed"
                if h.stop_reason in ("error", "max-tokens", "aborted", "interrupted", "blocked"):
                    if h.stop_reason == "max-tokens":
                        h.status = "error"
                        h.error = "子代理输出达到长度上限（max-tokens），未产出完整结果"
                        h.stop_reason = "max-tokens"
                # 结构化输出抽取/校验（请求了 schema 才做；缺失/不合规 → 显式失败，不假装成功）
                if isinstance(h.output_schema, dict) and h.output_schema and h.status == "success":
                    value, st = _extract_structured(h.result, h.output_schema)
                    if st == "ok":
                        h.structured = value
                    elif st == "invalid":
                        h.status = "error"
                        h.error = ("子代理输出不含满足 output_schema 的 JSON 对象（结构校验失败）；"
                                   f"原始输出前 300 字：{str(h.result)[:300]}")
                        h.stop_reason = h.stop_reason or "error"
                    else:
                        h.status = "error"
                        h.error = ("子代理未按结构化输出契约返回 JSON（未找到 JSON 对象）；"
                                   f"原始输出前 300 字：{str(h.result)[:300]}")
                        h.stop_reason = h.stop_reason or "error"
        except asyncio.CancelledError:
            h.status = "cancelled"
            h.stop_reason = "aborted"
            h.error = "已取消"
            if child is not None:
                try:
                    await child.abort("cancel")
                except Exception:
                    pass
            raise
        except Exception as e:
            h.status = "error"
            h.stop_reason = h.stop_reason or "error"
            h.error = f"子代理执行失败: {str(e)[:400]}"
        finally:
            h.settled_at = time.time()
            self._detach_progress_bridge(child)
            await self._notify_parent(parent, E.SUBAGENT_SETTLED, {
                "subagent_id": h.id, "agent": profile.name, "status": h.status,
                "elapsed_ms": h.elapsed_ms,
                "stop_reason": h.stop_reason or None,
                "result_summary": (h.result[:300] if h.status == "success" else ""),
                "error": h.error or "",
            })
            if h.background:
                ok = "完成" if h.status == "success" else f"失败（{h.error}）"
                self._inbox_notify(
                    parent,
                    f"【子代理{ok}】{profile.name}（{h.id}）{h.task[:60]}\n"
                    + (h.result[:1200] if h.status == "success" else ""),
                )

    # ── 子代理进度桥（节流，父会话 UI 可见）──────────────
    def _attach_progress_bridge(self, parent, h: SubAgentHandle, child) -> None:
        attach = getattr(child, "attach", None)
        if not callable(attach):
            return
        last = {"ts": 0.0}

        def _sink(ev: Dict[str, Any]) -> None:
            try:
                etype = ev.get("event")
                if etype not in ("tool_calling", "tool_result"):
                    return
                is_result = etype == "tool_result"
                now = time.time()
                # 调用阶段节流 0.8s；结果阶段全量透传（轨迹要完整）
                if not is_result and now - last["ts"] < 0.8:
                    return
                last["ts"] = now
                detail = ""
                if is_result and str(ev.get("status") or "") != "success":
                    detail = str(ev.get("error") or "")[:160]
                emit = getattr(parent, "_emit", None)
                if callable(emit):
                    r = emit({"event": "subagent_progress", "subagent_id": h.id,
                              "agent": h.agent, "tool_name": ev.get("tool_name") or "",
                              "phase": "result" if is_result else "calling",
                              "status": (str(ev.get("status") or "") if is_result else ""),
                              "detail": detail})
                    if asyncio.iscoroutine(r):
                        asyncio.get_running_loop().create_task(r)
                if h.batch_id:
                    self._peak.setdefault(h.batch_id, 0)
            except Exception:
                pass

        try:
            child.attach(_sink)
            h._bridge_sink = _sink  # type: ignore[attr-defined]
        except Exception:
            pass

    def _detach_progress_bridge(self, child) -> None:
        if child is None:
            return
        detach = getattr(child, "detach", None)
        if not callable(detach):
            return
        for h in self._handles.values():
            sink = getattr(h, "_bridge_sink", None)
            if sink is not None and h.loop is child:
                try:
                    detach(sink)
                except Exception:
                    pass
                try:
                    delattr(h, "_bridge_sink")
                except Exception:
                    pass

    def _prune(self) -> None:
        if len(self._orders) <= 200:
            return
        drop = self._orders[:-150]
        self._orders = self._orders[-150:]
        for sid in drop:
            h = self._handles.get(sid)
            if h is not None and h.status in ("success", "error", "cancelled"):
                self._handles.pop(sid, None)
                self._tasks.pop(sid, None)


subagent_pool = SubAgentPool()


# ── 兼容旧接口（单子代理同步阻塞执行）────────────────────────
async def run_subagent(parent_loop, task: str, context: Optional[Dict[str, Any]] = None,
                       max_steps: int = 40, timeout: Optional[float] = None) -> Dict[str, Any]:
    r = await subagent_pool.spawn(
        parent_loop, "generalist", task, context=context,
        background=False, max_steps=max_steps, timeout_s=timeout,
        auto_bg_ok=False,  # 旧调用语义 = 严格阻塞
    )
    if r.get("status") != "success":
        out = {"status": "error", "error": r.get("error") or "子代理失败",
               "session_id": r.get("session_id", "")}
        if r.get("status") == "cancelled":
            out["error"] = "子代理已取消"
        return out
    return {
        "status": "success",
        "result": r.get("result") or "",
        "session_id": r.get("session_id", ""),
        "elapsed_s": round((r.get("elapsed_ms") or 0) / 1000, 1),
    }
