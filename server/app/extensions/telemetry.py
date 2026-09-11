# -*- coding: utf-8 -*-
"""扩展执行可观测：调用/成功/错误/超时/耗时 + 近因环形缓冲 + 健康汇总。

进程内、无依赖、线程安全。所有统一执行口（ExtensionRegistry.execute）与
插件查壳工具（plugins.manager.run_plugin_tool）都会记录到此。
"""
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_MAX_RECENT = 200

_stats: Dict[str, Dict[str, Any]] = {}
_recent: "deque[Dict[str, Any]]" = deque(maxlen=_MAX_RECENT)


def record(ext_id: str, ok: bool, elapsed_ms: int, *, kind: str = "",
           error: Optional[Any] = None, timeout: bool = False) -> None:
    ext_id = str(ext_id or "?")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with _LOCK:
        s = _stats.setdefault(ext_id, {
            "calls": 0, "ok": 0, "errors": 0, "timeouts": 0,
            "last_ms": 0, "last_at": "", "last_error": "",
        })
        s["calls"] += 1
        if ok:
            s["ok"] += 1
        else:
            s["errors"] += 1
        if timeout:
            s["timeouts"] += 1
        s["last_ms"] = int(elapsed_ms)
        s["last_at"] = now
        if error:
            s["last_error"] = str(error)[:300]
        _recent.appendleft({
            "extension": ext_id, "kind": kind, "ok": bool(ok),
            "ms": int(elapsed_ms), "timeout": bool(timeout),
            "error": (str(error)[:200] if error else ""), "at": now,
        })


def snapshot() -> Dict[str, Dict[str, Any]]:
    with _LOCK:
        return {k: dict(v) for k, v in _stats.items()}


def recent(n: int = 30) -> List[Dict[str, Any]]:
    with _LOCK:
        return list(_recent)[:max(0, int(n))]


def reset() -> None:
    with _LOCK:
        _stats.clear()
        _recent.clear()


def health() -> Dict[str, Any]:
    with _LOCK:
        stats = {k: dict(v) for k, v in _stats.items()}
    calls = sum(s["calls"] for s in stats.values())
    errors = sum(s["errors"] for s in stats.values())
    timeouts = sum(s["timeouts"] for s in stats.values())
    unhealthy = sorted(
        ext for ext, s in stats.items()
        if s["errors"] > 0 and s["errors"] >= max(1, s["calls"] // 2)
    )
    return {
        "executed_kinds_total": len(stats),
        "calls": calls,
        "errors": errors,
        "timeouts": timeouts,
        "error_rate": round(errors / calls, 4) if calls else 0.0,
        "unhealthy": unhealthy,
        "stats": stats,
    }
