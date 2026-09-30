# -*- coding: utf-8 -*-
"""TaskCenter — 生成源异步任务的统一抽象（提交→轮询→落盘→事件）。

目标契约：
- 任何生成源，无论同步返回 URL 还是"提交拿 task_id 再轮询"，调用方统一
  `register()` + `wait()` 阻塞到成片；全项目只有本模块一处轮询循环。
- 任务记录持久化 storage/tasks/{id}.json，后端重启可续跑 bootstrap。
- 适配器统一解析三类源：
  1. code_query ：代码源（AutoDL/H3 等），task_id + 空 prompt 调用户代码查询分支
  2. legacy      ：代码源内存任务表（code_provider 的后台轮询结果）
  3. builtin     ：内置视频源 provider.get_task_status(task_id)
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


TERMINAL_STATUSES = {"SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"}
_SUCCESS = {"SUCCESS", "COMPLETED", "COMPLETE", "SUCCEEDED", "OK", "DONE", "FINISHED"}
_FAIL = {"FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED", "EXPIRED"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except Exception:
        return default


def _tasks_dir() -> Path:
    from app.core.config import settings
    base = Path(settings.STORAGE_DIR) / "tasks"
    base.mkdir(parents=True, exist_ok=True)
    return base


def normalize_status(raw: Any) -> str:
    s = str(raw or "").strip().upper()
    if s in _SUCCESS:
        return "SUCCESS"
    if s in _FAIL:
        return "FAILED"
    if s in ("TIMEOUT", "TIMED_OUT"):
        return "TIMEOUT"
    if s in ("CANCEL", "CANCELLED", "CANCELED"):
        return "CANCELLED"
    if s:
        return s
    return "RUNNING"


@dataclass
class TaskRecord:
    task_id: str
    provider_id: str
    kind: str = "video"
    status: str = "SUBMITTED"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    deadline_at: float = 0.0
    attempts: int = 0
    remote_status: str = ""
    video_url: str = ""
    local_path: str = ""
    error: str = ""
    project_id: str = ""
    node_id: str = ""
    session_id: str = ""
    request: Dict[str, Any] = field(default_factory=dict)
    meta: Dict[str, Any] = field(default_factory=dict)

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def age_s(self) -> float:
        return round(max(0.0, time.time() - self.created_at), 1)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["terminal"] = self.terminal
        d["age_s"] = self.age_s
        if self.deadline_at:
            d["remaining_s"] = round(max(0.0, self.deadline_at - time.time()), 1)
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TaskRecord":
        allowed = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in (d or {}).items() if k in allowed})


class TaskCenter:
    def __init__(self):
        self._tasks: Dict[str, TaskRecord] = {}
        self._events: Dict[str, asyncio.Event] = {}
        self._pollers: Dict[str, asyncio.Task] = {}
        self._custom_pollers: Dict[str, Callable[[TaskRecord], Any]] = {}
        self._lock = asyncio.Lock()
        self._ready = False
        self._settle_hooks: List[Callable[[TaskRecord], Any]] = []

    # ── 生命周期 ─────────────────────────────────────────
    def bootstrap(self) -> int:
        """加载持久化记录（幂等）；返回加载条数。"""
        if self._ready:
            return len(self._tasks)
        self._ready = True
        loaded = 0
        try:
            for p in _tasks_dir().glob("task_*.json"):
                try:
                    rec = TaskRecord.from_dict(json.loads(p.read_text(encoding="utf-8")))
                    if rec.task_id:
                        self._tasks[rec.task_id] = rec
                        loaded += 1
                except Exception:
                    continue
        except Exception:
            pass
        return loaded

    def _ensure_pollers(self) -> None:
        """有运行中事件循环时，为未终态任务补起轮询（重启续跑/懒启动）。"""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        for rec in list(self._tasks.values()):
            if not rec.terminal and rec.task_id not in self._pollers:
                self._spawn_poller(rec)

    def on_settle(self, hook: Callable[[TaskRecord], Any]) -> None:
        if hook not in self._settle_hooks:
            self._settle_hooks.append(hook)

    # ── 持久化 ───────────────────────────────────────────
    def _path(self, task_id: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(task_id))[:80]
        return _tasks_dir() / f"task_{safe}.json"

    def _persist(self, rec: TaskRecord) -> None:
        try:
            p = self._path(rec.task_id)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(rec.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, p)
        except Exception:
            pass

    # ── 注册 ─────────────────────────────────────────────
    def register(
        self,
        task_id: str,
        provider_id: str,
        kind: str = "video",
        *,
        request: Optional[Dict[str, Any]] = None,
        project_id: str = "",
        node_id: str = "",
        session_id: str = "",
        timeout_s: Optional[float] = None,
        poller: Optional[Callable[[TaskRecord], Any]] = None,
    ) -> TaskRecord:
        self.bootstrap()
        tid = str(task_id or "").strip()
        if not tid:
            raise ValueError("task_id 不能为空")
        rec = self._tasks.get(tid)
        if rec is None:
            timeout = float(timeout_s or _env_float("STUDIO_TASK_TIMEOUT", 1500.0))
            rec = TaskRecord(
                task_id=tid, provider_id=str(provider_id or ""), kind=str(kind or "video"),
                status="SUBMITTED", deadline_at=time.time() + max(60.0, timeout),
                project_id=str(project_id or ""), node_id=str(node_id or ""),
                session_id=str(session_id or ""), request=dict(request or {}),
            )
            self._tasks[tid] = rec
            self._persist(rec)
        if poller is not None:
            self._custom_pollers[tid] = poller
        self._ensure_pollers()
        return rec

    # ── 查询/取消 ────────────────────────────────────────
    def status(self, task_id: str) -> Optional[TaskRecord]:
        self.bootstrap()
        rec = self._tasks.get(str(task_id or ""))
        if rec is not None:
            self._ensure_pollers()
        return rec

    def list_active(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        self.bootstrap()
        out = [r for r in self._tasks.values() if not r.terminal and (not kind or r.kind == kind)]
        out.sort(key=lambda r: r.created_at, reverse=True)
        return [r.to_dict() for r in out]

    async def cancel(self, task_id: str) -> Dict[str, Any]:
        tid = str(task_id or "")
        t = self._pollers.get(tid)
        if t and not t.done():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        rec = self._tasks.get(tid)
        if not rec:
            return {"error": f"任务不存在: {tid}"}
        if not rec.terminal:
            self._settle(rec, "CANCELLED", error="用户取消")
        return rec.to_dict()

    async def wait(self, task_id: str, timeout_s: Optional[float] = None) -> TaskRecord:
        """事件驱动等待任务终态；超时返回当前记录（不抛错）。"""
        self.bootstrap()
        tid = str(task_id or "")
        rec = self._tasks.get(tid)
        if rec is None:
            raise ValueError(f"任务不存在: {tid}")
        self._ensure_pollers()
        if rec.terminal:
            return rec
        ev = self._events.get(tid)
        if ev is None:
            ev = asyncio.Event()
            self._events[tid] = ev
        budget = float(timeout_s or _env_float("AGENT_VIDEO_WAIT_S", 1200.0))
        try:
            await asyncio.wait_for(ev.wait(), timeout=max(1.0, budget))
        except asyncio.TimeoutError:
            pass
        return self._tasks.get(tid, rec)

    # ── 轮询器 ───────────────────────────────────────────
    def _interval(self, rec: TaskRecord) -> float:
        try:
            per = float(rec.request.get("poll_interval_s") or 0)
        except Exception:
            per = 0.0
        return max(0.2, per or _env_float("STUDIO_TASK_POLL_INTERVAL", 5.0))

    def _spawn_poller(self, rec: TaskRecord) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if rec.task_id in self._pollers:
            return
        self._pollers[rec.task_id] = loop.create_task(self._run_poller(rec.task_id))

    async def _run_poller(self, task_id: str) -> None:
        rec = self._tasks.get(task_id)
        if rec is None:
            return
        interval = self._interval(rec)
        errors = 0
        try:
            while not rec.terminal and time.time() < rec.deadline_at:
                await asyncio.sleep(interval)
                if rec.terminal:
                    break
                rec.attempts += 1
                try:
                    snapshot = await self._poll_once(rec)
                    errors = 0
                    await self._apply(rec, snapshot or {})
                    interval = self._interval(rec)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    errors += 1
                    rec.meta["last_error"] = str(e)[:200]
                    interval = min(30.0, self._interval(rec) * (1.5 ** min(errors, 4)))
                    rec.updated_at = time.time()
                    self._persist(rec)
            if not rec.terminal:
                self._settle(rec, "TIMEOUT", error=f"任务超时（{int(rec.age_s)}s），可凭 task_id 继续查询")
        finally:
            self._pollers.pop(task_id, None)

    async def _poll_once(self, rec: TaskRecord) -> Dict[str, Any]:
        custom = self._custom_pollers.get(rec.task_id)
        if custom is not None:
            r = custom(rec)
            return await r if asyncio.iscoroutine(r) else (r or {})
        return await self._default_poll(rec)

    async def _default_poll(self, rec: TaskRecord) -> Dict[str, Any]:
        # 1) 代码源：优先看旧表（其后台轮询可能在跑），无则单次查询推进
        try:
            from app.providers.custom.manager import custom_provider_manager as _mgr
            d = _mgr.get_definition(rec.provider_id)
            if d is not None and (getattr(d, "provider_type", "") == "code" or getattr(d, "code", None)):
                from app.providers.generic import code_provider as cp
                legacy = cp.get_code_video_task(rec.task_id)
                if legacy and normalize_status(legacy.get("status")) in TERMINAL_STATUSES:
                    return legacy
                if rec.task_id in getattr(cp, "_CODE_VIDEO_POLLING", set()):
                    return {"status": (legacy or {}).get("status") or "SUBMITTED"}
                return await cp.query_code_task_once(rec.provider_id, rec.task_id)
        except Exception:
            pass
        # 2) 内置源 get_task_status
        try:
            from app.providers.video.registry import video_registry
            prov = video_registry.get(rec.provider_id) if rec.provider_id else None
            fn = getattr(prov, "get_task_status", None) if prov is not None else None
            if callable(fn):
                st = fn(rec.task_id)
                if isinstance(st, dict) and str(st.get("status") or "").lower() != "not_found":
                    return st
        except Exception:
            pass
        return {"status": "RUNNING"}

    # ── 应用轮询结果 ─────────────────────────────────────
    async def _apply(self, rec: TaskRecord, snapshot: Dict[str, Any]) -> None:
        snap = snapshot or {}
        url = str(snap.get("video_url") or snap.get("url") or "")
        local = str(snap.get("local_path") or "")
        status = normalize_status(snap.get("status"))
        rec.remote_status = status
        if snap.get("last_error"):
            rec.meta["last_error"] = str(snap.get("last_error"))[:200]
        rec.updated_at = time.time()
        if url:
            rec.video_url = await self._localize(rec, url, local)
            rec.local_path = rec.local_path or local
            rec.error = ""
            self._settle(rec, "SUCCESS")
            return
        if status == "FAILED":
            self._settle(rec, "FAILED", error=str(snap.get("error") or rec.error or "任务失败")[:400])
            return
        if status == "TIMEOUT":
            self._settle(rec, "TIMEOUT", error=str(snap.get("error") or "任务超时")[:400])
            return
        rec.status = status if status not in TERMINAL_STATUSES else rec.status
        self._persist(rec)

    async def _localize(self, rec: TaskRecord, url: str, local: str) -> str:
        """远端 URL 下载落盘；已是本地/存储路径直接使用。"""
        if local:
            return url
        low = url.lower()
        if low.startswith("/storage/") or low.startswith("data:"):
            return url
        if not low.startswith("http"):
            return url
        try:
            from app.providers.generic.code_provider import _download_to_storage
            storage_url, local_path = await _download_to_storage(url, prefix="vid")
            rec.local_path = local_path or ""
            return storage_url or url
        except Exception as e:
            rec.meta["download_error"] = str(e)[:200]
            return url

    def _settle(self, rec: TaskRecord, status: str, error: str = "") -> None:
        _already = rec.terminal
        rec.status = status
        if error:
            rec.error = error
        rec.updated_at = time.time()
        # 异步任务终态计时：提交→拿到结果的总耗时（meta.elapsed_ms 随 to_dict 暴露给 /videos/status）。
        # 重复 settle（取消/超时竞态）不重复记账。
        if not _already:
            try:
                _ms = int(max(0.0, rec.updated_at - rec.created_at) * 1000)
                rec.meta["elapsed_ms"] = _ms
                from app.providers.gen_timer import settle as _settle_timer
                _settle_timer(rec.task_id, status, kind=rec.kind or "video",
                              provider=rec.provider_id, elapsed_ms=_ms,
                              detail=(rec.error or "")[:120])
            except Exception:
                pass
        self._persist(rec)
        ev = self._events.get(rec.task_id)
        if ev is not None:
            try:
                ev.set()
            except Exception:
                pass
        for hook in list(self._settle_hooks):
            try:
                r = hook(rec)
                if asyncio.iscoroutine(r):
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(r)
                    except RuntimeError:
                        pass
            except Exception:
                pass


task_center = TaskCenter()
