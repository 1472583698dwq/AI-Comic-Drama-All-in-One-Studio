# -*- coding: utf-8 -*-
"""Agent LLM 适配器 — 单一 stream() 接缝，对标 dsh 的 llm 语义。

- 统一 chunk 词汇：text / reasoning / tool_call_delta / usage / finish。
- 工具调用全程保留原始 JSON 字符串，解析失败不静默吞掉（保留原文供模型修正）。
- provider 选择沿用项目现有配置（OpenAI 兼容 / MiniMax），Responses API 自动走 chat/completions
  （工具调用要求 chat/completions 协议）。
"""
from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from app.core.config import settings


def _sanitize_tool_schemas(tools: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    """工具 schema 防御性清洗（发送前守门）。

    JSON Schema 规定 `required` 必须是字符串数组；任何来源（工作流派生源 / 用户代码源 /
    自定义节点）把布尔的 "required" 写进属性 schema 时，严格校验的 LLM 上游会直接
    400 "Invalid request parameters" 把整次调用一票否决。这里递归剔除所有非法 required，
    保证脏 schema 永远不会打穿模型调用。
    """
    if not tools:
        return tools

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            req = node.get("required")
            if req is not None and not (isinstance(req, list) and all(isinstance(x, str) for x in req)):
                node.pop("required", None)
            for v in list(node.values()):
                _walk(v)
        elif isinstance(node, list):
            for v in node:
                _walk(v)

    out = copy.deepcopy(tools)
    _walk(out)
    return out


class LLMTransportError(RuntimeError):
    """可重试：网络/超时/限流/5xx。"""

    def __init__(self, message: str, status: Optional[int] = None, retryable: bool = True):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class LLMConfigError(RuntimeError):
    """不可重试：缺 Key/参数错误/4xx（网关转发的上游瞬时错误除外，见 _is_upstream_blame）。"""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # 原始 JSON 字符串（模型输出，不保证合法）
    parsed: Dict[str, Any] = field(default_factory=dict)
    # 参数是否为合法 JSON（超长被 max_tokens 截断时会是 False，绝不能原样回传上游）
    arguments_valid: bool = True

    def to_openai(self) -> Dict[str, Any]:
        return {"id": self.id, "type": "function", "function": {"name": self.name, "arguments": self.arguments}}


@dataclass
class LLMChunk:
    kind: str  # text | reasoning | tool_call_delta | usage | finish
    text: str = ""
    index: int = 0
    tool_call_id: str = ""
    tool_name: str = ""
    arguments_delta: str = ""
    usage: Optional[Dict[str, Any]] = None
    finish_reason: str = ""


@dataclass
class AssistantReply:
    content: str = ""
    reasoning: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)
    finish_reason: str = "stop"

    @property
    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)


def _is_upstream_blame(body: str) -> bool:
    """网关代转的上游瞬时故障：形态是 400，责任不在本次请求，该重试而非打死回合。

    真·请求错误（缺 model、参数非法）不带这类字样，仍按配置错误立即失败。
    """
    b = (body or "").lower()
    return any(k in b for k in ("upstream", "server_error", "server error", "internal server", "bad gateway"))


def _arguments_valid(raw: str) -> bool:
    """工具参数是否为合法 JSON。空参视为合法；截断/非法一律 False（禁止回传上游）。"""
    s = (raw or "").strip()
    if not s:
        return True
    try:
        json.loads(s)
        return True
    except Exception:
        try:
            import re
            json.loads(re.sub(r",\s*([}\]])", r"\1", s))
            return True
        except Exception:
            return False


def _parse_tool_arguments(raw: str) -> Dict[str, Any]:
    s = (raw or "").strip()
    if not s:
        return {}
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else {"value": v}
    except Exception:
        # 容错：去掉尾随垃圾 / 中文标点
        try:
            import re
            fixed = re.sub(r",\s*([}\]])", r"\1", s)
            v = json.loads(fixed)
            return v if isinstance(v, dict) else {"value": v}
        except Exception:
            return {}


class OpenAICompatAdapter:
    """OpenAI 兼容 /chat/completions 流式适配器（含 tool_calls 增量组装）。"""

    def resolve(self) -> Dict[str, str]:
        provider = (getattr(settings, "LLM_PROVIDER", "") or "openai_compatible").lower()
        api_type = (getattr(settings, "LLM_API_TYPE", "") or "chat_completions").lower()
        if provider == "minimax" and not getattr(settings, "OPENAI_API_KEY", ""):
            # MiniMax M 系列（M3/M2.7/M2.5/M2.1/M2）统一走 OpenAI 兼容 /chat/completions；
            # 旧版 /text/chatcompletion_v2（abab 世代）已随 api.minimax.chat 域名一起弃用。
            base = (getattr(settings, "MINIMAX_BASE_URL", "") or "https://api.minimaxi.com/v1").rstrip("/")
            return {
                "endpoint": f"{base}/chat/completions",
                "api_key": getattr(settings, "MINIMAX_API_KEY", "") or "",
                "model": getattr(settings, "LLM_MODEL", "") or "MiniMax-M2.5",
            }
        base = (getattr(settings, "OPENAI_BASE_URL", "") or "https://api.deepseek.com/v1").rstrip("/")
        if base.endswith("/chat/completions"):
            endpoint = base
        elif base.endswith("/responses"):
            endpoint = base[: -len("/responses")] + "/chat/completions"
        else:
            endpoint = f"{base}/chat/completions"
        model = getattr(settings, "OPENAI_MODEL", "") or "deepseek-chat"
        if provider == "responses_api" or api_type == "responses_api":
            # 工具调用必须走 chat/completions；沿用同站点
            pass
        return {
            "endpoint": endpoint,
            "api_key": getattr(settings, "OPENAI_API_KEY", "") or "",
            "model": model,
        }

    def _headers(self, api_key: str) -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        try:
            from app.pipelines.llm_service import llm_service
            headers.update(llm_service._get_custom_headers() or {})
        except Exception:
            pass
        return headers

    def _build_payload(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]],
                       temperature: float, max_tokens: int, model: str, include_usage: bool = True) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"model": model, "messages": messages, "stream": True}
        if include_usage:
            payload["stream_options"] = {"include_usage": True}
        is_reasoning = any(k in (model or "").lower() for k in ("o1", "o3", "reasoner", "qwq", "r1"))
        if is_reasoning:
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["temperature"] = temperature
            payload["max_tokens"] = max_tokens
        if tools:
            payload["tools"] = _sanitize_tool_schemas(tools)
            payload["tool_choice"] = "auto"
        return payload

    async def stream(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 300.0,
    ) -> AsyncIterator[LLMChunk]:
        cfg = self.resolve()
        if not cfg["api_key"]:
            raise LLMConfigError("未配置大模型 API Key（OPENAI_API_KEY / MINIMAX_API_KEY）")
        headers = self._headers(cfg["api_key"])
        payload = self._build_payload(messages, tools, temperature, max_tokens, cfg["model"])

        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(30.0, timeout))) as client:
            for attempt_plain in (False, True):
                p = dict(payload)
                if attempt_plain:
                    # 部分网关不认 stream_options/temperature：剥离后重试一次
                    p.pop("stream_options", None)
                try:
                    async with client.stream("POST", cfg["endpoint"], headers=headers, json=p) as resp:
                        if resp.status_code != 200:
                            body = (await resp.aread()).decode(errors="ignore")[:400]
                            retryable = resp.status_code in (408, 409, 425, 429) or resp.status_code >= 500
                            # 网关转发的上游 400 交给外层重试（带退避），别按请求错误打死整轮
                            if _is_upstream_blame(body):
                                raise LLMTransportError(f"LLM HTTP {resp.status_code}: {body}", status=resp.status_code)
                            if not attempt_plain and resp.status_code == 400:
                                continue  # 用剥离版重试
                            if retryable:
                                raise LLMTransportError(f"LLM HTTP {resp.status_code}: {body}", status=resp.status_code)
                            raise LLMConfigError(f"LLM HTTP {resp.status_code}: {body}")
                        async for chunk in self._parse_sse(resp):
                            yield chunk
                        return
                except (httpx.TimeoutException, httpx.TransportError) as e:
                    if attempt_plain:
                        raise LLMTransportError(f"LLM 传输失败: {e}") from e
                    continue
        raise LLMTransportError("LLM 请求失败：流未建立")

    async def _parse_sse(self, response: httpx.Response) -> AsyncIterator[LLMChunk]:
        async for line in response.aiter_lines():
            line = (line or "").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                return
            try:
                data = json.loads(data_str)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue

            usage = data.get("usage")
            if usage:
                yield LLMChunk(kind="usage", usage=usage)

            choices = data.get("choices") or []
            if not choices:
                continue
            ch = choices[0] or {}
            delta = ch.get("delta") or {}
            if isinstance(delta, str):  # 个别网关把 delta 当字符串
                if delta:
                    yield LLMChunk(kind="text", text=delta)
                delta = {}
            content = delta.get("content")
            if content:
                yield LLMChunk(kind="text", text=str(content))
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if reasoning:
                yield LLMChunk(kind="reasoning", text=str(reasoning))
            for tcd in (delta.get("tool_calls") or []):
                if not isinstance(tcd, dict):
                    continue
                fn = tcd.get("function") or {}
                yield LLMChunk(
                    kind="tool_call_delta",
                    index=int(tcd.get("index") or 0),
                    tool_call_id=str(tcd.get("id") or ""),
                    tool_name=str(fn.get("name") or ""),
                    arguments_delta=str(fn.get("arguments") or ""),
                )
            finish = ch.get("finish_reason")
            if finish:
                yield LLMChunk(kind="finish", finish_reason=str(finish))

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 300.0,
        on_chunk: Optional[Any] = None,
    ) -> AssistantReply:
        """聚合一次完整调用。on_chunk 可为 async 回调（用于实时转发流式增量）。"""
        reply = AssistantReply()
        tc_map: Dict[int, Dict[str, str]] = {}
        async for chunk in self.stream(messages, tools=tools, temperature=temperature,
                                       max_tokens=max_tokens, timeout=timeout):
            if chunk.kind == "text":
                reply.content += chunk.text
            elif chunk.kind == "reasoning":
                reply.reasoning += chunk.text
            elif chunk.kind == "tool_call_delta":
                entry = tc_map.setdefault(chunk.index, {"id": "", "name": "", "arguments": ""})
                if chunk.tool_call_id:
                    entry["id"] = chunk.tool_call_id
                if chunk.tool_name:
                    if not entry["name"]:
                        entry["name"] = chunk.tool_name
                    elif not entry["name"].endswith(chunk.tool_name):
                        entry["name"] += chunk.tool_name
                entry["arguments"] += chunk.arguments_delta
            elif chunk.kind == "usage":
                reply.usage = chunk.usage or {}
            elif chunk.kind == "finish":
                reply.finish_reason = chunk.finish_reason or reply.finish_reason
            if on_chunk is not None:
                await on_chunk(chunk)
        for idx in sorted(tc_map):
            e = tc_map[idx]
            if not e["name"]:
                continue
            reply.tool_calls.append(ToolCall(
                id=e["id"] or f"call_{idx}",
                name=e["name"],
                arguments=e["arguments"],
                parsed=_parse_tool_arguments(e["arguments"]),
                arguments_valid=_arguments_valid(e["arguments"]),
            ))
        return reply


adapter = OpenAICompatAdapter()
