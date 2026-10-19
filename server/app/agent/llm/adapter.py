# -*- coding: utf-8 -*-
"""Agent LLM 适配器 — 单一 stream() 接缝，对标 dsh 的 llm 语义。

- 统一 chunk 词汇：text / reasoning / tool_call_delta / usage / finish。
- 工具调用全程保留原始 JSON 字符串，解析失败不静默吞掉（保留原文供模型修正）。
- provider 选择沿用项目现有配置（OpenAI 兼容 / MiniMax），Responses API 自动走 chat/completions
  （工具调用要求 chat/completions 协议）。
"""
from __future__ import annotations

import asyncio
import contextvars
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


# ── 错误码谱系（对标 dsh error code taxonomy）──────────────
# 调用方按 code 决策：可重试 / 去设置修 Key / 压缩后重试 / 直接失败，不再靠关键词猜。
ERROR_AUTH = "AUTH"                                  # 401/403/缺 Key：不重试，引导去设置
ERROR_QUOTA = "QUOTA_EXCEEDED"                       # 余额/配额耗尽：不重试
ERROR_RATE_LIMIT = "RATE_LIMIT"                      # 429 限流：退避重试
ERROR_CONTEXT_OVERFLOW = "CONTEXT_WINDOW_EXCEEDED"   # 上下文超限：压缩后重试
ERROR_INVALID_REQUEST = "INVALID_REQUEST"            # 请求参数非法：不重试
ERROR_SERVER = "SERVER"                              # 上游 5xx：重试
ERROR_TIMEOUT = "TIMEOUT"                            # 超时：重试
ERROR_TRANSPORT = "TRANSPORT"                        # 网络传输失败：重试
ERROR_CONFIG = "CONFIG"                              # 其他配置错误：不重试
ERROR_EMPTY_RESPONSE = "EMPTY_RESPONSE"              # 空响应：重试

_RETRYABLE_CODES = frozenset({ERROR_RATE_LIMIT, ERROR_SERVER, ERROR_TIMEOUT, ERROR_TRANSPORT, ERROR_EMPTY_RESPONSE})

_QUOTA_PHRASES = ("insufficient balance", "insufficient_quota", "quota exceeded", "exceeded your current quota",
                  "balance", "余额不足", "配额", "欠费", "arrears")
_AUTH_PHRASES = ("invalid api key", "incorrect api key", "unauthorized", "authentication", "api key",
                 "密钥", "鉴权", "认证失败")
_CONTEXT_PHRASES = ("context length", "context_length", "maximum context", "context limit", "too many tokens",
                    "input is too long", "reduce the length", "上下文长度", "上下文超限", "输入过长")


def classify_http_error(status: int, body: str) -> str:
    """HTTP 状态 + 响应体 → 单一错误码（responders 分流重试/引导去设置/压缩）。"""
    b = (body or "").lower()
    if status in (401, 403):
        return ERROR_AUTH
    if status == 429:
        return ERROR_RATE_LIMIT
    if status in (408, 409, 425):
        return ERROR_TRANSPORT
    if status == 413:
        return ERROR_INVALID_REQUEST
    if status >= 500:
        return ERROR_SERVER
    if status == 400:
        if any(p in b for p in _CONTEXT_PHRASES):
            return ERROR_CONTEXT_OVERFLOW
        if any(p in b for p in _QUOTA_PHRASES):
            return ERROR_QUOTA
        if any(p in b for p in _AUTH_PHRASES):
            return ERROR_AUTH
        return ERROR_INVALID_REQUEST
    return ERROR_INVALID_REQUEST if 400 <= status < 500 else ERROR_SERVER


def is_retryable_code(code: str) -> bool:
    return code in _RETRYABLE_CODES


def error_code_of(err: Any) -> str:
    """从异常取错误码（无码异常按类型回退）。"""
    code = getattr(err, "code", "") or ""
    if code:
        return str(code)
    if isinstance(err, LLMTransportError):
        return ERROR_TRANSPORT
    if isinstance(err, LLMConfigError):
        return ERROR_CONFIG
    return ""


class LLMTransportError(RuntimeError):
    """可重试：网络/超时/限流/5xx。"""

    def __init__(self, message: str, status: Optional[int] = None, retryable: bool = True,
                 code: str = ERROR_TRANSPORT):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.code = code


class LLMConfigError(RuntimeError):
    """不可重试：缺 Key/参数错误/4xx（网关转发的上游瞬时错误除外，见 _is_upstream_blame）。"""

    def __init__(self, message: str, code: str = ERROR_CONFIG):
        super().__init__(message)
        self.code = code


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


# 模型广场选中的供应商：只在当前 Agent 回合内生效，用完即复位。
_chat_override: contextvars.ContextVar[Optional[Dict[str, str]]] = contextvars.ContextVar(
    "llm_chat_override", default=None,
)


def push_chat_override(cfg: Optional[Dict[str, str]]):
    return _chat_override.set(cfg if cfg else None)


def pop_chat_override(token) -> None:
    _chat_override.reset(token)


class OpenAICompatAdapter:
    """OpenAI 兼容 /chat/completions 流式适配器（含 tool_calls 增量组装）。"""

    def resolve(self) -> Dict[str, Any]:
        def _from_plaza(pick: Dict[str, Any]) -> Dict[str, Any]:
            """广场选中项 → 适配器配置。Responses 协议在会话侧统一降级到同站点 chat/completions。"""
            proto = pick.get("protocol") or "openai"
            endpoint = pick["endpoint"]
            if proto == "responses":
                endpoint = pick.get("fallback_endpoint") or endpoint
                proto = "openai"
            return {
                "endpoint": endpoint,
                "api_key": pick["api_key"],
                "model": pick["model"],
                "protocol": proto,
                # 广场供应商自己的自定义请求头（如 OpenCode 的 x-opencode-session）
                "headers": pick.get("headers") or {},
                # 标记来自广场：此时不要再叠全局 OPENAI_CUSTOM_HEADERS，避免串站
                "from_plaza": True,
            }

        override = _chat_override.get()
        if override and override.get("endpoint") and override.get("api_key") and override.get("model"):
            return _from_plaza(override)
        # 对话没有单独选模型时，跟随模型广场的全局默认模型（与拆剧本同一口径）
        try:
            from app.llm import plaza
            default = plaza.resolve_default()
        except Exception:
            default = None
        if default and default.get("endpoint") and default.get("api_key") and default.get("model"):
            return _from_plaza(default)
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

    def _headers(self, api_key: str, extra: Optional[Dict[str, str]] = None,
                 use_global: bool = True) -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if use_global:
            try:
                from app.pipelines.llm_service import llm_service
                headers.update(llm_service._get_custom_headers() or {})
            except Exception:
                pass
        if extra:
            headers.update(extra)
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
            raise LLMConfigError("未配置大模型 API Key（OPENAI_API_KEY / MINIMAX_API_KEY）", code=ERROR_AUTH)
        if (cfg.get("protocol") or "openai") == "claude":
            async for chunk in self._stream_claude(cfg, messages, tools, temperature, max_tokens, timeout):
                yield chunk
            return
        headers = self._headers(cfg["api_key"], cfg.get("headers") or None,
                                use_global=not cfg.get("from_plaza"))
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
                            code = classify_http_error(resp.status_code, body)
                            # 网关转发的上游瞬时故障（400 形态）交给外层退避重试，别按请求错误打死整轮
                            if _is_upstream_blame(body):
                                raise LLMTransportError(f"LLM HTTP {resp.status_code}: {body}",
                                                        status=resp.status_code, code=ERROR_SERVER)
                            if not attempt_plain and resp.status_code == 400 and code == ERROR_INVALID_REQUEST:
                                continue  # 用剥离版重试
                            if is_retryable_code(code):
                                raise LLMTransportError(f"LLM HTTP {resp.status_code}: {body}",
                                                        status=resp.status_code, code=code)
                            raise LLMConfigError(f"LLM HTTP {resp.status_code}: {body}", code=code)
                        async for chunk in self._parse_sse(resp):
                            yield chunk
                        return
                except (httpx.TimeoutException, httpx.TransportError) as e:
                    if attempt_plain:
                        raise LLMTransportError(f"LLM 传输失败: {e}", code=ERROR_TRANSPORT) from e
                    continue
        raise LLMTransportError("LLM 请求失败：流未建立", code=ERROR_TRANSPORT)

    async def _stream_claude(
        self,
        cfg: Dict[str, str],
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]],
        temperature: float,
        max_tokens: int,
        timeout: float,
    ) -> AsyncIterator[LLMChunk]:
        from app.llm.claude_wire import events_to_chunks, to_anthropic

        system, anth_messages, anth_tools = to_anthropic(messages, tools)
        if not anth_messages:
            anth_messages = [{"role": "user", "content": [{"type": "text", "text": "继续。"}]}]
        payload: Dict[str, Any] = {
            "model": cfg["model"],
            "max_tokens": max_tokens,
            "messages": anth_messages,
            "stream": True,
        }
        if system:
            payload["system"] = system
        if temperature is not None:
            payload["temperature"] = temperature
        if anth_tools:
            payload["tools"] = anth_tools
        headers = {
            "x-api-key": cfg["api_key"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }
        if cfg.get("headers"):
            headers.update(cfg["headers"])
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(30.0, timeout))) as client:
            try:
                async with client.stream("POST", cfg["endpoint"], headers=headers, json=payload) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode(errors="ignore")[:400]
                        code = classify_http_error(resp.status_code, body)
                        if is_retryable_code(code) or _is_upstream_blame(body):
                            raise LLMTransportError(f"Claude HTTP {resp.status_code}: {body}",
                                                    status=resp.status_code, code=code)
                        raise LLMConfigError(f"Claude HTTP {resp.status_code}: {body}", code=code)
                    async for line in resp.aiter_lines():
                        line = (line or "").strip()
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        try:
                            data = json.loads(raw)
                        except Exception:
                            continue
                        try:
                            pieces = events_to_chunks(data)
                        except ValueError as e:
                            raise LLMConfigError(str(e)) from e
                        for piece in pieces:
                            yield LLMChunk(
                                kind=piece.get("kind") or "",
                                text=piece.get("text") or "",
                                index=int(piece.get("index") or 0),
                                tool_call_id=piece.get("tool_call_id") or "",
                                tool_name=piece.get("tool_name") or "",
                                arguments_delta=piece.get("arguments_delta") or "",
                                usage=piece.get("usage"),
                                finish_reason=piece.get("finish_reason") or "",
                            )
            except (httpx.TimeoutException, httpx.TransportError) as e:
                raise LLMTransportError(f"Claude 传输失败: {e}", code=ERROR_TRANSPORT) from e

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
        # 空响应（无正文/无思考/无工具调用）：上游瞬时抖动或网关吞包 → 报可重试错误（对标 dsh EMPTY_RESPONSE）
        if (not reply.tool_calls and not (reply.content or "").strip()
                and not (reply.reasoning or "").strip()
                and reply.finish_reason not in ("length",)):
            raise LLMTransportError("模型返回空响应（无正文/无工具调用）", code=ERROR_EMPTY_RESPONSE)
        return reply


adapter = OpenAICompatAdapter()
