# -*- coding: utf-8 -*-
"""白模导出待办登记 — 「Agent 发起 → 浏览器录制 → 完成回执」的闭环对账表。

``stage_export_clay`` 是前端代理型工具：后端只受理请求，真正的 WebGL/MediaRecorder
录制在浏览器里跑，完成后由前端回调 ``POST /agent/stage/clay-result``。
本表按 ``(project_id, shot_id/shot_index)`` 记住**发起导出的会话**，
回执到达时只把结果通知投给那个会话（而不是广播给所有会话）。

- 进程内内存表：只服务"这一次导出"的对账，后端重启即失效（回执找不到登记时静默
  ``no_pending``，不会误唤醒任何会话）；
- TTL 默认 30 分钟：过期登记自动清掉，防止永远挂着的陈旧条目在很久以后误触发；
- 同一分镜重复发起时后一次覆盖前一次（最近一次意图为准）。
"""
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

#: 登记有效期（秒）：超过后视为陈旧，清掉不再对账
TTL_SECONDS = 30 * 60


@dataclass
class PendingClayExport:
    session_id: str
    project_id: str
    shot_id: str
    shot_index: Any
    created_at: float


_LOCK = threading.RLock()
#: key: (project_id, "id:<shot_id>" or "idx:<shot_index>")
_PENDING: Dict[Tuple[str, str], PendingClayExport] = {}


def _keys(project_id: str, shot_id: str = "", shot_index: Any = None) -> List[Tuple[str, str]]:
    pid = str(project_id or "")
    out: List[Tuple[str, str]] = []
    sid = str(shot_id or "").strip()
    if sid:
        out.append((pid, f"id:{sid}"))
    try:
        if shot_index is not None:
            out.append((pid, f"idx:{int(shot_index)}"))
    except Exception:
        pass
    return out


def _sweep_locked() -> None:
    now = time.time()
    for k, e in list(_PENDING.items()):
        if now - e.created_at > TTL_SECONDS:
            _PENDING.pop(k, None)


def register(project_id: str, shot_id: str, shot_index: Any, session_id: str) -> None:
    """登记一次白模导出（发起会话 + 目标分镜）；session_id 为空则忽略（v1/无会话调用不登记）。"""
    if not session_id:
        return
    entry = PendingClayExport(
        session_id=str(session_id),
        project_id=str(project_id or ""),
        shot_id=str(shot_id or ""),
        shot_index=shot_index,
        created_at=time.time(),
    )
    with _LOCK:
        _sweep_locked()
        for k in _keys(project_id, shot_id, shot_index):
            _PENDING[k] = entry


def pop(project_id: str, shot_id: str = "", shot_index: Any = None) -> Optional[PendingClayExport]:
    """取出并删除匹配登记（不存在返回 None）；同一登记挂的 id/index 双键一并清掉。"""
    with _LOCK:
        _sweep_locked()
        hit: Optional[PendingClayExport] = None
        for k in _keys(project_id, shot_id, shot_index):
            e = _PENDING.pop(k, None)
            if e is not None and hit is None:
                hit = e
        if hit is not None:
            for k, e in list(_PENDING.items()):
                if e is hit:
                    _PENDING.pop(k, None)
        return hit


def pending_count() -> int:
    with _LOCK:
        _sweep_locked()
        return len({id(e) for e in _PENDING.values()})
