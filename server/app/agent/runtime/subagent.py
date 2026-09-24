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
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.agent.runtime import events as E
from app.agent.runtime.agents import AgentProfile, get_profile


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
        }


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
        return float(_env_int("AGENT_SUBAGENT_TIMEOUT", 600))

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
                background: bool, batch_id: str = "") -> Tuple[SubAgentHandle, asyncio.Task]:
        h = SubAgentHandle(
            id=f"sub_{uuid.uuid4().hex[:8]}",
            agent=agent,
            task=task,
            status="queued",
            background=background,
            batch_id=batch_id,
            parent_session_id=_session_id_of(parent),
        )
        self._handles[h.id] = h
        self._orders.append(h.id)
        self._prune()
        task_obj = asyncio.get_running_loop().create_task(
            self._guarded_run(parent, h, get_profile(agent), context, max_steps, timeout_s)
        )
        self._tasks[h.id] = task_obj
        return h, task_obj

    async def spawn(self, parent, agent: str, task: str,
                    context: Optional[Dict[str, Any]] = None,
                    background: bool = False,
                    max_steps: Optional[int] = None,
                    timeout_s: Optional[float] = None,
                    auto_bg_ok: bool = True) -> Dict[str, Any]:
        """委派单个子任务。

        background=False（默认）同步阻塞直到结果返回；
        background=True 立即返回句柄（完成后通知，可用 subagent_wait 阻塞等待）。
        auto_bg_ok=False 时禁用「同步超时自动转后台」，保证严格阻塞语义。
        """
        task = str(task or "").strip()
        if not task:
            return {"status": "error", "error": "subagent_run 需要非空 task"}
        if _depth_of(parent) >= self._max_depth():
            return {"status": "error",
                    "error": f"子代理深度已达上限（{self._max_depth()}），禁止继续嵌套委派"}
        h, task_obj = self._launch(parent, agent, task, context, max_steps, timeout_s, background)
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
        if h.status == "success":
            return {**h.brief(), "status": "success", "result": h.result[:6000]}
        return {**h.brief(), "status": "error", "error": h.error or "子代理执行失败"}

    async def spawn_batch(self, parent, agent: str, items: List[Dict[str, Any]],
                          background: bool = False,
                          context: Optional[Dict[str, Any]] = None,
                          max_steps: Optional[int] = None,
                          timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """同质任务批量扇出：items=[{task, context?}, ...]，并行受会话信号量约束。"""
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
            h, task_obj = self._launch(parent, agent, t, ctx, max_steps, timeout_s, background, batch_id)
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
        total = len(handles)
        success = sum(1 for h in handles if h.status == "success")
        failed = total - success
        critical_ms = max((h.elapsed_ms for h in handles), default=0)
        peak = self._peak.pop(batch_id, 0)
        items = []
        for i, h in enumerate(handles):
            items.append({
                "index": i, "subagent_id": h.id, "status": h.status,
                "result": (h.result[:1500] if h.status == "success" else None),
                "error": h.error or None,
            })
        metrics = {"batch_id": batch_id, "agent": handles[0].agent if handles else "",
                   "total": total, "success": success, "failed": failed,
                   "critical_steps_ms": critical_ms, "parallel_width": peak}
        await self._notify_parent(parent, E.SUBAGENT_METRICS, metrics)
        return {"batch_id": batch_id, "status": "success" if failed == 0 else "partial",
                "total": total, "success": success, "failed": failed,
                "critical_steps_ms": critical_ms, "parallel_width": peak,
                "items": items}

    # ── 执行 ─────────────────────────────────────────────
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
            self._attach_progress_bridge(parent, h, child)
            await child.prompt(f"你是子代理（角色：{profile.name}）。独立完成以下子任务并只输出最终结果：\n{h.task}")
            await child.wait_idle(timeout=to)
            if child.is_running():
                try:
                    await child.abort("timeout")
                except Exception:
                    pass
                h.status = "error"
                h.error = f"子任务超时（{to:.0f}s）"
            else:
                h.status = "success"
                try:
                    h.result = child.session.last_assistant_text() or "（子代理未产出文本结果）"
                except Exception:
                    h.result = ""
        except asyncio.CancelledError:
            h.status = "cancelled"
            h.error = "已取消"
            if child is not None:
                try:
                    await child.abort("cancel")
                except Exception:
                    pass
            raise
        except Exception as e:
            h.status = "error"
            h.error = f"子代理执行失败: {str(e)[:400]}"
        finally:
            h.settled_at = time.time()
            self._detach_progress_bridge(child)
            await self._notify_parent(parent, E.SUBAGENT_SETTLED, {
                "subagent_id": h.id, "agent": profile.name, "status": h.status,
                "elapsed_ms": h.elapsed_ms,
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
                now = time.time()
                if now - last["ts"] < 0.8:
                    return
                last["ts"] = now
                emit = getattr(parent, "_emit", None)
                if callable(emit):
                    r = emit({"event": "subagent_progress", "subagent_id": h.id,
                              "agent": h.agent, "tool_name": ev.get("tool_name") or "",
                              "status": ev.get("status") or etype})
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
