# -*- coding: utf-8 -*-
"""Anthropic Messages 与本项目 OpenAI 风格消息之间的转换。

Agent 运行时始终用 OpenAI 形态（system / user / assistant.tool_calls / tool）。
选中 Claude 协议的供应商时，发出去之前收成 Messages API，流式事件再收成同一套 chunk。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict) and p.get("type") in ("text", "input_text"):
                parts.append(str(p.get("text") or ""))
        return "\n".join(x for x in parts if x)
    return str(content)


def _user_blocks(content: Any) -> List[Dict[str, Any]]:
    if isinstance(content, list):
        blocks: List[Dict[str, Any]] = []
        for p in content:
            if isinstance(p, str):
                if p:
                    blocks.append({"type": "text", "text": p})
                continue
            if not isinstance(p, dict):
                continue
            kind = p.get("type")
            if kind in ("text", "input_text"):
                blocks.append({"type": "text", "text": str(p.get("text") or "")})
            elif kind in ("image_url", "image"):
                src = p.get("image_url") if kind == "image_url" else p.get("source")
                url = src if isinstance(src, str) else (src or {}).get("url") if isinstance(src, dict) else ""
                if url:
                    blocks.append({"type": "image", "source": {"type": "url", "url": url}})
        if blocks:
            return blocks
    text = _text(content)
    return [{"type": "text", "text": text}]


def _merge(out: List[Dict[str, Any]], role: str, blocks: List[Dict[str, Any]]) -> None:
    if not blocks:
        return
    if out and out[-1]["role"] == role:
        out[-1]["content"].extend(blocks)
        return
    out.append({"role": role, "content": list(blocks)})


def _tool_input(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    s = (raw or "").strip() if isinstance(raw, str) else ""
    if not s:
        return {}
    try:
        v = json.loads(s)
    except Exception:
        return {"_raw": s}
    return v if isinstance(v, dict) else {"value": v}


def to_anthropic(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """返回 (system, messages, tools)。messages 已按 user/assistant 交替合并。"""
    system_parts: List[str] = []
    out: List[Dict[str, Any]] = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "system":
            text = _text(m.get("content"))
            if text:
                system_parts.append(text)
            continue
        if role == "tool":
            _merge(out, "user", [{
                "type": "tool_result",
                "tool_use_id": str(m.get("tool_call_id") or ""),
                "content": _text(m.get("content")),
            }])
            continue
        if role == "assistant":
            blocks: List[Dict[str, Any]] = []
            text = _text(m.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for tc in m.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") or {}
                name = str(fn.get("name") or tc.get("name") or "")
                if not name:
                    continue
                blocks.append({
                    "type": "tool_use",
                    "id": str(tc.get("id") or f"call_{name}"),
                    "name": name,
                    "input": _tool_input(fn.get("arguments") if "arguments" in fn else tc.get("input")),
                })
            if blocks:
                _merge(out, "assistant", blocks)
            continue
        _merge(out, "user", _user_blocks(m.get("content")))

    if out and out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": [{"type": "text", "text": "继续。"}]})

    anth_tools: List[Dict[str, Any]] = []
    for t in tools or []:
        if not isinstance(t, dict):
            continue
        fn = t.get("function") if t.get("type") == "function" else t
        if not isinstance(fn, dict):
            continue
        name = str(fn.get("name") or "")
        if not name:
            continue
        schema = fn.get("parameters") or fn.get("input_schema") or {"type": "object", "properties": {}}
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}}
        anth_tools.append({
            "name": name,
            "description": str(fn.get("description") or ""),
            "input_schema": schema,
        })
    return "\n\n".join(system_parts), out, anth_tools


_STOP = {
    "end_turn": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "refusal": "stop",
}


def events_to_chunks(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """一条 Anthropic SSE data 对象 → 若干与 OpenAI 适配器同形的 chunk 字典。"""
    if not isinstance(data, dict):
        return []
    typ = data.get("type")
    if typ == "error":
        err = data.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else str(err)
        raise ValueError(msg or "Claude 接口返回错误")
    out: List[Dict[str, Any]] = []
    if typ == "content_block_start":
        block = data.get("content_block") or {}
        if isinstance(block, dict) and block.get("type") == "tool_use":
            out.append({
                "kind": "tool_call_delta",
                "index": int(data.get("index") or 0),
                "tool_call_id": str(block.get("id") or ""),
                "tool_name": str(block.get("name") or ""),
                "arguments_delta": "",
            })
    elif typ == "content_block_delta":
        delta = data.get("delta") or {}
        if not isinstance(delta, dict):
            return out
        dtyp = delta.get("type")
        if dtyp == "text_delta" and delta.get("text"):
            out.append({"kind": "text", "text": str(delta.get("text"))})
        elif dtyp == "thinking_delta" and delta.get("thinking"):
            out.append({"kind": "reasoning", "text": str(delta.get("thinking"))})
        elif dtyp == "input_json_delta":
            out.append({
                "kind": "tool_call_delta",
                "index": int(data.get("index") or 0),
                "arguments_delta": str(delta.get("partial_json") or ""),
            })
    elif typ == "message_delta":
        delta = data.get("delta") or {}
        reason = delta.get("stop_reason") if isinstance(delta, dict) else ""
        if reason:
            out.append({"kind": "finish", "finish_reason": _STOP.get(str(reason), "stop")})
        usage = data.get("usage")
        if isinstance(usage, dict):
            out.append({"kind": "usage", "usage": usage})
    elif typ == "message_start":
        msg = data.get("message") or {}
        usage = msg.get("usage") if isinstance(msg, dict) else None
        if isinstance(usage, dict):
            out.append({"kind": "usage", "usage": usage})
    return out
