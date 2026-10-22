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


def estimate_data_ref(ref: str, kind: str = "image") -> int:
    """估算媒体引用的 token。

    图片走 image_url content part 时，provider 按视觉 token 计（DeepSeek Flash 单图
    最多 1024，OpenAI patch 模型约 1536）。只有文本降级路径才可能把 base64 当文本，
    而那条路径已改成省略 data URI，所以这里不再按字符数放大图片。
    """
    s = str(ref or "")
    if not s:
        return 0
    if s.startswith("data:"):
        if kind == "image":
            return 1536
        return min(20000, max(800, len(s) // 8))
    return estimate_text(s)


def estimate_attachments(atts: Any) -> int:
    total = 0
    for a in (atts or []):
        if isinstance(a, dict):
            total += estimate_data_ref(str(a.get("ref") or ""), str(a.get("kind") or "image"))
    return total


def _part_media(part: Dict[str, Any]) -> tuple:
    for key, kind in (("image_url", "image"), ("video_url", "video"), ("audio_url", "audio")):
        v = part.get(key)
        if isinstance(v, dict):
            u = v.get("url")
        else:
            u = v
        if isinstance(u, str) and u:
            return u, kind
    u = part.get("url")
    return (u, "image") if isinstance(u, str) else ("", "image")


def estimate_message(msg: Dict[str, Any]) -> int:
    n = 4
    content = msg.get("content")
    if isinstance(content, str):
        n += estimate_text(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                n += estimate_text(str(part.get("text") or ""))
                url, kind = _part_media(part)
                n += estimate_data_ref(url, kind)
    for tc in (msg.get("tool_calls") or []):
        fn = (tc or {}).get("function") or {}
        n += estimate_text(str(fn.get("name") or "")) + estimate_text(str(fn.get("arguments") or ""))
    return n


def estimate_messages(messages: Iterable[Dict[str, Any]]) -> int:
    return sum(estimate_message(m) for m in messages)


def context_window() -> int:
    """上下文窗口（tokens）。可用 AGENT_CONTEXT_WINDOW 覆盖，默认 1M（压缩在窗口 80% 触发，约 80 万 token）。"""
    try:
        return int(os.environ.get("AGENT_CONTEXT_WINDOW") or 1000000)
    except Exception:
        return 1000000


def latest_context_tokens(session) -> int:
    """最近一次模型调用的 usage 作为"当前上下文压力"锚点。

    必须用最近一次（而非累计 usage_totals）——累计值是整个会话的流水，会话一长就会
    永久超过阈值，导致每一步都触发压缩（"压得太狠"的根因之一）。
    """
    try:
        events = getattr(session, "events", None) or getattr(session, "_events", None) or []
        for ev in reversed(list(events)):
            if ev.get("type") != "assistant/message":
                continue
            u = (ev.get("data") or {}).get("usage") or {}
            total = int(u.get("total_tokens") or 0)
            if total <= 0:
                total = int(u.get("prompt_tokens") or 0) + int(u.get("completion_tokens") or 0)
            if total > 0:
                return total
    except Exception:
        pass
    return 0


def pressure_of(session) -> Dict[str, int]:
    """当前会话压力：surface 估算 + 最近一次调用 usage 锚点（取两者较大值作为判断依据）。"""
    try:
        msgs = session.derive_messages()
        est = estimate_messages(msgs)
    except Exception:
        est = 0
    anchor = latest_context_tokens(session)
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
