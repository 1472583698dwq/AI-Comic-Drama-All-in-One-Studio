# -*- coding: utf-8 -*-
"""子代理委派 — 前台子任务（对标 dsh subagent 的 in-process provider）。

- 新会话、新上下文：子代理不继承父历史，只回传最终结果，不污染父上下文。
- 深度限制：默认只允许一层（父为 depth 0，子为 1），禁止嵌套再委派。
- 失败以结构化结果返回（永不抛错给父管线）。
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any, Dict, Optional


def _depth_limit() -> int:
    try:
        return max(0, int(os.environ.get("AGENT_SUBAGENT_MAX_DEPTH") or 1))
    except Exception:
        return 1


async def run_subagent(parent_loop, task: str, context: Optional[Dict[str, Any]] = None,
                       max_steps: int = 40, timeout: Optional[float] = None) -> Dict[str, Any]:
    depth = int((parent_loop.context or {}).get("subagent_depth") or 0)
    if depth >= _depth_limit():
        return {"status": "error", "error": f"子代理深度已达上限（{_depth_limit()}），禁止继续嵌套委派"}

    from app.agent.runtime.loop import AgentLoop
    child_sid = f"{parent_loop.session.id}__sub_{uuid.uuid4().hex[:8]}"
    try:
        to = float(timeout or os.environ.get("AGENT_SUBAGENT_TIMEOUT") or 600)
    except Exception:
        to = 600.0

    ctx = {
        "subagent_depth": depth + 1,
        "parent_session": parent_loop.session.id,
        "project_title": (parent_loop.context or {}).get("project_title"),
    }
    child = AgentLoop(
        child_sid, run_mode="approve", mode="execute", context=ctx,
        interactive=False, store=parent_loop.session.store, max_steps=max_steps,
    )
    started = time.time()
    try:
        await child.prompt(f"你是子代理，独立完成以下子任务并只输出最终结果：\n{task}")
        await child.wait_idle(timeout=to)
        if child.is_running():
            await child.abort("timeout")
            return {"status": "error", "error": f"子任务超时（{to}s）", "session_id": child_sid,
                    "partial": child.session.last_assistant_text()[:2000]}
        result = child.session.last_assistant_text() or "（子代理未产出文本结果）"
        return {
            "status": "success",
            "result": result[:6000],
            "session_id": child_sid,
            "events": child.session.seq,
            "elapsed_s": round(time.time() - started, 1),
        }
    except Exception as e:
        return {"status": "error", "error": f"子代理执行失败: {e}", "session_id": child_sid}
