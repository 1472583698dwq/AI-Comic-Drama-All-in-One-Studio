# -*- coding: utf-8 -*-
"""
生成源统一计时器 —— 所有生成源（图像 / 视频 / 音频）在「拿到结果」的那一刻记录耗时。

- 落盘：storage/gen_timings.jsonl，每次一条 JSON（含阶段 / 耗时 / 成败 / task_id / prompt 摘要），
  可回溯、可统计；超 5MB 自动滚动到 gen_timings.1.jsonl（只保留一份历史）。
- 控制台：同步打一行 [GenTimer]（dev 可见；桌面打包 stdout 不可见，以文件为准）。
- 阶段口径：
    return   同步生成：provider.generate 返回，结果已到手
    submit   异步生成：拿到 task_id（提交完成；出片另记 settle）
    settle   异步任务到达终态（真正拿到视频结果，从提交算起的总耗时）

三个生成注册表（image/video/audio registry.generate）经 `with_timer` 统一入口计时，
异步终态由 TaskCenter._settle 与 /videos/status 观察点经 `settle` 记账（二者以
进程内 pending 表配对，避免同一任务重复记账）。
"""
import json
import os
import time
from typing import Any, Dict, Optional

_MAX_BYTES = 5 * 1024 * 1024

# task_id -> 提交时刻（进程内；重启后丢失则该任务不再补记 settle，避免猜起点）
_pending: Dict[str, float] = {}

_SUCCESS_STATES = {"SUCCESS", "COMPLETED", "COMPLETE", "SUCCEEDED", "OK", "DONE", "FINISHED"}
_TERMINAL_STATES = _SUCCESS_STATES | {
    "FAILED", "FAIL", "ERROR", "TIMEOUT", "CANCELLED", "CANCELED", "REJECTED",
}


def _timings_path() -> str:
    try:
        from app.core.config import settings
        base = str(getattr(settings, "STORAGE_DIR", "storage") or "storage")
    except Exception:
        base = "storage"
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    return os.path.join(base, "gen_timings.jsonl")


def _rotate_if_needed(path: str) -> None:
    try:
        if os.path.exists(path) and os.path.getsize(path) > _MAX_BYTES:
            os.replace(path, os.path.splitext(path)[0] + ".1.jsonl")
    except Exception:
        pass


def record(
    kind: str,
    provider: str,
    elapsed_ms: int,
    *,
    phase: str = "return",
    ok: bool = True,
    task_id: str = "",
    status: str = "",
    detail: str = "",
) -> None:
    """记录一条生成耗时（落盘 + 控制台）。任何失败都静默，绝不影响生成链路。"""
    entry: Dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "epoch": round(time.time(), 3),
        "kind": kind,
        "provider": provider or "",
        "phase": phase,
        "elapsed_ms": int(max(0, elapsed_ms)),
        "ok": bool(ok),
    }
    if task_id:
        entry["task_id"] = task_id
    if status:
        entry["status"] = status
    if detail:
        entry["detail"] = str(detail)[:300]
    path = _timings_path()
    _rotate_if_needed(path)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    try:
        flag = "✓" if ok else "✗"
        extra = f" task={task_id}" if task_id else ""
        if status:
            extra += f" status={status}"
        tail = f" ({detail})" if detail and not ok else ""
        print(f"[GenTimer] {kind} {flag} provider={provider or '?'} phase={phase} "
              f"elapsed={int(max(0, elapsed_ms))}ms{extra}{tail}")
    except Exception:
        pass


def note_submit(task_id: str) -> None:
    """异步提交完成：记下起点，供 settle 配对算总耗时。"""
    try:
        if task_id:
            _pending[str(task_id)] = time.time()
    except Exception:
        pass


def settle(
    task_id: str,
    status: str,
    *,
    kind: str = "video",
    provider: str = "",
    elapsed_ms: Optional[int] = None,
    detail: str = "",
) -> bool:
    """异步任务终态记账（拿到结果的那一刻）。返回是否真正记录。

    - elapsed_ms 给定（如 TaskCenter 持有 created_at，可算精确总耗时）→ 直接用，并丢弃 pending；
    - 未给定 → 用本进程 submit 时刻配对；配不上（重启过 / 没见过该任务）则不记，避免猜起点。
    """
    tid = str(task_id or "")
    st = str(status or "").upper()
    if not tid or st not in _TERMINAL_STATES:
        return False
    started = _pending.pop(tid, None)
    if elapsed_ms is None:
        if started is None:
            return False
        elapsed_ms = int((time.time() - started) * 1000)
    record(
        kind or "video",
        provider,
        int(elapsed_ms),
        phase="settle",
        ok=st in _SUCCESS_STATES,
        task_id=tid,
        status=st,
        detail=detail,
    )
    return True


def observe_status(task_id: str, status: Any, provider: str = "") -> None:
    """状态查询观察点：任务已终态且本进程见过其 submit → 记一次 settle（幂等）。"""
    try:
        st = str(status or "").upper()
        if st in _TERMINAL_STATES:
            settle(str(task_id or ""), st, provider=provider)
    except Exception:
        pass


async def with_timer(kind: str, provider_id: str, coro, detail: str = ""):
    """await 一个生成协程：拿到结果的那一刻统一计时并记录（异常路径同样记录后原样抛出）。

    - 结果对象若有 elapsed_ms 字段则统一回写（三类生成结果口径一致）；
    - 结果带 task_id 视为异步提交，另记 pending 供终态配对。
    """
    t0 = time.monotonic()
    try:
        result = await coro
    except Exception as e:
        record(kind, provider_id, int((time.monotonic() - t0) * 1000),
               phase="return", ok=False, detail=str(e)[:200])
        raise
    ms = int((time.monotonic() - t0) * 1000)
    task_id = ""
    try:
        task_id = str(getattr(result, "task_id", "") or "")
    except Exception:
        task_id = ""
    try:
        result.elapsed_ms = ms  # 统一口径（image/video 本就有字段，audio 新增）
    except Exception:
        pass
    if task_id:
        note_submit(task_id)
        record(kind, provider_id, ms, phase="submit", ok=True, task_id=task_id, detail=detail)
    else:
        record(kind, provider_id, ms, phase="return", ok=True, detail=detail)
    return result
