# -*- coding: utf-8 -*-
"""后台任务 — 长耗时工具调用的异步化（对标 dsh jobs）。

模型用 job_start 提交任务拿到 job_id 立即继续；任务完成后结果以事件落账，
并向 Inbox 注入通知唤醒后续处理。并发上限、取消、列表查询齐备。
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from app.agent.runtime import events as E


def _max_jobs() -> int:
    try:
        return max(1, int(os.environ.get("AGENT_MAX_JOBS") or 4))
    except Exception:
        return 4


class JobManager:
    def __init__(self, session, emit, run_tool: Callable[..., Any]):
        self.session = session
        self.emit = emit
        self.run_tool = run_tool  # async (call_id, name, args, project_context, run_mode) -> ToolOutcome
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._tasks: Dict[str, asyncio.Task] = {}

    # ── 提交 ─────────────────────────────────────────────
    def start(self, name: str, args: Dict[str, Any], project_context: Any = None,
              run_mode: str = "approve") -> Dict[str, Any]:
        running = sum(1 for j in self._jobs.values() if j["status"] == "running")
        if running >= _max_jobs():
            return {"error": f"并发后台任务已达上限（{_max_jobs()}），请等待或使用 job_list 查看进度"}
        if name in ("job_start", "job_list", "job_status", "job_cancel", "subagent_run", "batch_run"):
            return {"error": f"不允许把 {name} 作为后台任务提交"}
        jid = f"job_{uuid.uuid4().hex[:10]}"
        job = {"job_id": jid, "tool": name, "arguments": args or {}, "status": "running",
               "created_at": time.time(), "settled_at": None, "result": None, "error": None}
        self._jobs[jid] = job
        self.session.append(E.JOB_STARTED, {"job_id": jid, "kind": name, "label": str((args or {}).get("prompt") or name)[:120]})
        self._tasks[jid] = asyncio.get_running_loop().create_task(
            self._run(jid, name, args or {}, project_context, run_mode)
        )
        return {"job_id": jid, "status": "running", "tool": name,
                "note": "任务已后台化，完成后会自动通知；可用 job_list/job_status 查询。"}

    async def _run(self, jid: str, name: str, args: Dict[str, Any], project_context: Any, run_mode: str) -> None:
        job = self._jobs[jid]
        # 优先取实时模式：任务入队后用户切了审批/自动，执行时按最新口径
        get_rm = getattr(self, "get_run_mode", None)
        if callable(get_rm):
            try:
                run_mode = get_rm() or run_mode
            except Exception:
                pass
        try:
            outcome = await self.run_tool(jid, name, args, project_context, run_mode)
            job["status"] = getattr(outcome, "status", "error")
            job["result"] = getattr(outcome, "result", None)
            job["error"] = getattr(outcome, "error", None)
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            raise
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)[:500]
        finally:
            job["settled_at"] = time.time()
            self.session.append(E.JOB_SETTLED, {
                "job_id": jid, "status": job["status"],
                "result_summary": self._summary(job),
            })
            try:
                await self.emit({"event": "job_settled", "job_id": jid, "status": job["status"],
                                 "tool": name, "result": job["result"] if job["status"] == "success" else None,
                                 "error": job["error"]})
            except Exception:
                pass
            # 完成通知进入 Inbox（唤醒后续处理）
            try:
                from app.agent.runtime.inbox import InboxMessage
                text = f"【后台任务{'完成' if job['status'] == 'success' else '失败'}】{name}（{jid}）\n{self._summary(job)}"
                self._notify(text)
            except Exception:
                pass

    @staticmethod
    def _summary(job: Dict[str, Any]) -> str:
        import json
        if job["status"] == "success":
            try:
                s = json.dumps(job["result"], ensure_ascii=False, default=str)
            except Exception:
                s = str(job["result"])
            return s[:1500]
        return str(job.get("error") or job["status"])[:500]

    def _notify(self, text: str) -> None:
        cb = getattr(self, "notify_fn", None)
        if cb:
            cb(text)

    # ── 查询/控制 ────────────────────────────────────────
    def list(self, limit: int = 20) -> Dict[str, Any]:
        jobs = sorted(self._jobs.values(), key=lambda j: j["created_at"], reverse=True)[:limit]
        return {"jobs": [{k: j[k] for k in ("job_id", "tool", "status", "created_at", "settled_at")}
                         for j in jobs]}

    def get(self, jid: str) -> Dict[str, Any]:
        j = self._jobs.get(jid)
        if not j:
            return {"error": f"任务不存在: {jid}"}
        return {"job_id": j["job_id"], "tool": j["tool"], "status": j["status"],
                "result": j["result"], "error": j["error"],
                "summary": self._summary(j)}

    async def cancel(self, jid: str) -> Dict[str, Any]:
        t = self._tasks.get(jid)
        if not t or t.done():
            return {"error": f"任务不存在或已结束: {jid}"}
        t.cancel()
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
        return {"job_id": jid, "status": "cancelled"}

    def running_count(self) -> int:
        return sum(1 for j in self._jobs.values() if j["status"] == "running")
