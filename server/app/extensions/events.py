# -*- coding: utf-8 -*-
"""扩展 / 插件状态变更事件流（进程内广播，供前端 SSE 订阅）。

**为什么需要它**：插件启用 / 停用 / 卸载后，前端各宿主（主题、导出器、导演包、画布节点、分镜槽）
原先只能等组件重新挂载才发现变化（《UI开关热插拔设计》§2.5 缺口 #1）。这里提供一个**极简进程内**广播：
HTTP 变更口在操作成功后调用 :func:`publish`，SSE 端点订阅队列并把事件推给浏览器，
前端收到后失效相关缓存并重拉 —— 这就是「热插拔」的推送通道（设计 §4 Phase 4，Q1 定稿用 SSE）。

约束与取舍：

- **不持久化、不跨进程**：uvicorn 单 worker（``run_server.py`` 的 reload 模式只有子进程在跑），
  多 worker 部署需要换 Redis 之类的总线，本项目不需要（本机单进程桌面应用）。
- **发布方可能是同步线程**：manager 的全生命周期持 ``RLock`` 串行执行，
  所以投递一律走 ``loop.call_soon_threadsafe``，绝不在锁内做 IO。
- **慢订阅者不阻塞发布**：队列有界（``_MAX_QUEUE``），满了丢最旧的一条。
  前端本来就有手动刷新兜底，不需要「事件不丢」。
- **只做变更通知，不带业务数据**：前端收到后自己重拉（``/extensions`` 等），
  避免事件体与真实状态产生第二份真相。
"""
import asyncio
import threading
import time
from typing import Any, Dict, List, Optional, Set

#: 单个订阅者的队列上限；满了丢最旧（前端有手动刷新兜底）
_MAX_QUEUE = 64

_lock = threading.Lock()
_subscribers: Set["asyncio.Queue[Dict[str, Any]]"] = set()
_loop: Optional[asyncio.AbstractEventLoop] = None

#: 已知事件动作（供文档与前端映射参考，不做强校验，新增动作不改这里也能跑）
ACTIONS = ("install", "uninstall", "enable", "disable", "reload")


def bind_loop() -> None:
    """在 SSE 端点的 async 上下文里调用，记住事件循环（供其它线程投递）。"""
    global _loop
    try:
        _loop = asyncio.get_running_loop()
    except RuntimeError:  # 不在事件循环里（理论上不会发生）
        _loop = None


def subscribe() -> "asyncio.Queue[Dict[str, Any]]":
    """订阅：返回一个队列，调用方负责在断开时 :func:`unsubscribe`。"""
    q: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=_MAX_QUEUE)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: "asyncio.Queue[Dict[str, Any]]") -> None:
    with _lock:
        _subscribers.discard(q)


def subscriber_count() -> int:
    with _lock:
        return len(_subscribers)


def _safe_put(q: "asyncio.Queue[Dict[str, Any]]", ev: Dict[str, Any]) -> None:
    try:
        q.put_nowait(ev)
    except asyncio.QueueFull:
        # 积压：丢最旧的，保住「最近状态」语义
        try:
            q.get_nowait()
            q.put_nowait(ev)
        except Exception:
            pass


def publish(kind: str, action: str, ext_id: str = "", **extra: Any) -> None:
    """广播一条变更事件。可从任意线程调用；**永不抛异常**（推送失败不该影响业务操作）。"""
    ev: Dict[str, Any] = {"kind": kind, "action": action, "id": ext_id, "ts": time.time()}
    if extra:
        ev.update(extra)
    try:
        with _lock:
            subs: List["asyncio.Queue[Dict[str, Any]]"] = list(_subscribers)
            loop = _loop
        if not subs or loop is None or loop.is_closed():
            return
        for q in subs:
            try:
                loop.call_soon_threadsafe(_safe_put, q, ev)
            except RuntimeError:
                # 事件循环恰好关闭：忽略即可
                return
    except Exception:
        return
