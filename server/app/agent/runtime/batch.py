# -*- coding: utf-8 -*-
"""批量流水线 — 同一工具的参数矩阵扇出（对标 dsh workflow 的扇出场景）。

用于"20 个镜头批量生图/生视频"这类大量独立子项：一次工具调用内并发执行，
只回传每条的成功状态与产物 URL，中间过程不进入主对话。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional


async def run_batch(run_tool, tool: str, items: List[Dict[str, Any]],
                    concurrency: int = 3, max_items: int = 50) -> Dict[str, Any]:
    if not tool or not isinstance(items, list) or not items:
        return {"status": "error", "error": "batch_run 需要 tool 与 非空 items 数组"}
    if tool in ("batch_run", "subagent_run", "job_start", "job_list", "job_status", "job_cancel", "todo_write"):
        return {"status": "error", "error": f"不允许批量执行内置工具: {tool}"}
    try:
        conc = max(1, min(int(concurrency or 3), 8))
    except Exception:
        conc = 3
    items = [it for it in items[:max_items] if isinstance(it, dict)]

    sem = asyncio.Semaphore(conc)
    results: List[Optional[Dict[str, Any]]] = [None] * len(items)

    async def one(idx: int, args: Dict[str, Any]) -> None:
        async with sem:
            try:
                outcome = await run_tool(f"batch_{idx}", tool, args, None, "auto")
                results[idx] = {
                    "index": idx,
                    "status": getattr(outcome, "status", "error"),
                    "result": getattr(outcome, "result", None) if getattr(outcome, "status", "") == "success" else None,
                    "error": getattr(outcome, "error", None) if getattr(outcome, "status", "") != "success" else None,
                }
            except Exception as e:
                results[idx] = {"index": idx, "status": "error", "error": str(e)[:300]}

    await asyncio.gather(*(one(i, it) for i, it in enumerate(items)))
    ok = sum(1 for r in results if r and r["status"] == "success")
    failed = len(results) - ok
    summary = {
        "tool": tool,
        "total": len(results),
        "success": ok,
        "failed": failed,
        "items": results,
    }
    try:
        raw = json.dumps(summary, ensure_ascii=False, default=str)
        if len(raw) > 12000:
            for r in results:
                if r and r.get("result") is not None:
                    s = json.dumps(r["result"], ensure_ascii=False, default=str)
                    if len(s) > 400:
                        r["result"] = {"_truncated": s[:400]}
    except Exception:
        pass
    return summary
