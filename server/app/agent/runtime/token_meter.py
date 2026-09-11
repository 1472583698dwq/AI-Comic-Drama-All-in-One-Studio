# -*- coding: utf-8 -*-
"""Token 计量 — provider usage 优先，启发式回退（对标 dsh token-meter）。

口径：CJK 约 0.7 token/字，非 CJK 约 4 字/token；消息结构开销固定加 4。
"""
import json
import os
from typing import Any, Dict, Iterable, List


def estimate_text(text: str) -> int:
    if not text:
        return 0
    cjk = 0
    other = 0
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff" or "\uac00" <= ch <= "\ud7af":
            cjk += 1
        else:
            other += 1
    return int(cjk * 0.7 + other / 4.0) + 1


def estimate_message(msg: Dict[str, Any]) -> int:
    n = 4
    content = msg.get("content")
    if isinstance(content, str):
        n += estimate_text(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                n += estimate_text(str(part.get("text") or ""))
    for tc in (msg.get("tool_calls") or []):
        fn = (tc or {}).get("function") or {}
        n += estimate_text(str(fn.get("name") or "")) + estimate_text(str(fn.get("arguments") or ""))
    return n


def estimate_messages(messages: Iterable[Dict[str, Any]]) -> int:
    return sum(estimate_message(m) for m in messages)


def context_window() -> int:
    """上下文窗口（tokens）。可用 AGENT_CONTEXT_WINDOW 覆盖，默认 64k。"""
    try:
        return int(os.environ.get("AGENT_CONTEXT_WINDOW") or 65536)
    except Exception:
        return 65536


def pressure_of(session) -> Dict[str, int]:
    """当前会话压力：surface 估算 + provider usage 锚点（取两者较大值作为判断依据）。"""
    try:
        msgs = session.derive_messages()
        est = estimate_messages(msgs)
    except Exception:
        est = 0
    usage = session.usage_totals()
    anchor = int(usage.get("total_tokens") or 0)
    return {
        "estimated_input": est,
        "usage_anchor": anchor,
        "window": context_window(),
        "threshold": int(context_window() * 0.8),
    }


def should_compact(session) -> bool:
    p = pressure_of(session)
    return max(p["estimated_input"], p["usage_anchor"]) >= p["threshold"]


def dumps_estimate(obj: Any) -> int:
    try:
        return estimate_text(json.dumps(obj, ensure_ascii=False, default=str))
    except Exception:
        return estimate_text(str(obj))
