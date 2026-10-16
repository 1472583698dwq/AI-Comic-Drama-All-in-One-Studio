# -*- coding: utf-8 -*-
"""
通用 AI 大模型调用与实时流式生成引擎 (LLM Service)
支持:
1. OpenAI 兼容标准接口 (DeepSeek, 阿里百炼通义千问, 硅基流动, OpenCode, Kimi, Ollama, OneAPI 等)
2. OpenAI 现代 Responses API (/v1/responses) 与自动平滑降级机制
3. MiniMax 官方 API (作为可选厂商)
具备全模型流式输出 (SSE Streaming)、思考标签自动剥离、结构化 JSON 鲁棒解析与容错自愈机制。
"""
import os
import re
import json
import asyncio
import logging
from typing import List, Dict, Any, Optional, AsyncGenerator

import httpx

from app.core.config import settings

logger = logging.getLogger("llm_service")


def _err_text(e: Any) -> str:
    """异常消息可读化：httpx 超时类异常 str() 为空，退化为类名。"""
    s = str(e or "").strip()
    return s or type(e).__name__


async def _with_deadline(agen: AsyncGenerator[str, None], budget_s: float,
                         label: str = "大模型流式响应") -> AsyncGenerator[str, None]:
    """给流式生成器加**整体时限**（httpx 的 timeout 只管单次读取，不管总时长）。

    背景：部分网关对超长请求只发心跳不吐内容，read timeout 永不触发 → 一次调用挂 8 分钟。
    这里按总预算强制中止，失败快、重试快。
    """
    loop = asyncio.get_running_loop()
    start = loop.time()
    ait = agen.__aiter__()
    while True:
        remain = budget_s - (loop.time() - start)
        if remain <= 0:
            raise LLMServiceError(f"{label}超时（总时限 {budget_s:.0f}s，已中止）")
        try:
            chunk = await asyncio.wait_for(ait.__anext__(), timeout=remain)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            raise LLMServiceError(f"{label}超时（总时限 {budget_s:.0f}s，已中止）")
        yield chunk


class LLMServiceError(RuntimeError):
    """LLM 服务异常或配置错误"""


def strip_think_tags(text: str) -> str:
    """去除推理模型输出的 <think>...</think> 或 <thought>...</thought> 标签"""
    if not text:
        return ""
    cleaned = re.sub(r"<(think|thought)>[\s\S]*?(?:</\1>|$)", "", text, flags=re.IGNORECASE)
    return cleaned.strip()


def extract_think_tags(text: str) -> str:
    """提取推理模型输出的 <think>...</think> 或 <thought>...</thought> 思考内容"""
    if not text:
        return ""
    matches = re.findall(r"<(think|thought)>([\s\S]*?)(?:</\1>|$)", text, flags=re.IGNORECASE)
    if matches:
        return "\n\n".join(m[1].strip() for m in matches if m[1].strip()).strip()
    return ""


def _strip_code_fence(text: str) -> str:
    """剥掉 markdown 代码围栏（含只开出、未闭合的截断情况）。"""
    s = text.strip()
    if s.startswith("```"):
        s = s[3:]
        if s[:4].lower() == "json":
            s = s[4:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def _escape_control_chars_in_strings(s: str) -> str:
    """把字符串内的裸控制字符（换行/回车/制表）转义为 \\n 等（常见非法 JSON 来源）。"""
    out: List[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
                out.append(ch)
                continue
            if ch == "\\":
                esc = True
                out.append(ch)
                continue
            if ch == '"':
                in_str = False
                out.append(ch)
                continue
            if ch == "\n":
                out.append("\\n")
                continue
            if ch == "\r":
                out.append("\\r")
                continue
            if ch == "\t":
                out.append("\\t")
                continue
            out.append(ch)
        else:
            if ch == '"':
                in_str = True
            out.append(ch)
    return "".join(out)


def _close_unbalanced(s: str) -> str:
    """按括号栈补全被截断的 JSON（字符串先补引号，去掉悬空的 , : 再闭合括号）。"""
    stack: List[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
    fixed = s.rstrip()
    if in_str:
        fixed += '"'
    fixed = re.sub(r"[,:]\s*$", "", fixed.rstrip())
    for opener in reversed(stack):
        fixed += "}" if opener == "{" else "]"
    return fixed


def _repair_truncated_json(text: str) -> Optional[Dict[str, Any]]:
    """尝试修复被截断的 JSON：先补齐括号；仍失败则按解析错误位置回退到上一个分隔符。"""
    cur = text
    for _ in range(12):
        if not cur.strip():
            return None
        try:
            obj = json.loads(_close_unbalanced(cur))
            if isinstance(obj, dict) and obj:
                return obj
            return None
        except json.JSONDecodeError as e:
            pos = int(getattr(e, "pos", 0) or 0)
            head = cur[:pos] if 0 < pos <= len(cur) else cur[:-1]
            cut = max(head.rfind(","), head.rfind("{"), head.rfind("["))
            if cut <= 0:
                return None
            cur = head[:cut]
        except Exception:
            return None
    return None


def _parse_json_lenient(cand: str) -> Optional[Dict[str, Any]]:
    """宽松解析：原文 → 去尾逗号 → 转义裸控制字符 → 组合。"""
    for variant in (
        cand,
        re.sub(r",\s*([}\]])", r"\1", cand),
        _escape_control_chars_in_strings(cand),
        _escape_control_chars_in_strings(re.sub(r",\s*([}\]])", r"\1", cand)),
    ):
        try:
            obj = json.loads(variant)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


def extract_json_from_text(text: str) -> Dict[str, Any]:
    """从 LLM 返回的文本中提取并解析合法 JSON（含代码围栏/尾逗号/裸换行/截断自愈）。"""
    if not text:
        raise LLMServiceError("LLM 返回空响应，无法解析 JSON")

    cleaned = strip_think_tags(text).replace("\ufeff", "")

    candidates: List[str] = []
    # ① 完整代码块 ```json ... ```
    code_block_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if code_block_match:
        candidates.append(code_block_match.group(1).strip())
    # ② 只开了围栏、没闭合（响应被截断）
    fenced = _strip_code_fence(cleaned)
    if fenced and fenced != cleaned.strip():
        candidates.append(fenced)
    # ③ 最外层 { ... }
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidates.append(cleaned[first_brace:last_brace + 1].strip())
    # ④ 全文（可能本身就是 JSON）
    if cleaned.strip():
        candidates.append(cleaned.strip())

    last_error: Optional[Exception] = None
    last_cand = candidates[-1] if candidates else ""
    for cand in candidates:
        obj = _parse_json_lenient(cand)
        if obj is not None:
            return obj
        try:
            json.loads(cand)
        except json.JSONDecodeError as e:
            last_error = e
            last_cand = cand
        except Exception as e:
            last_error = e
        repaired = _repair_truncated_json(cand)
        if repaired is not None:
            return repaired

    preview = cleaned[:300]
    where = ""
    err_pos = getattr(last_error, "pos", None)
    if isinstance(err_pos, int) and 0 <= err_pos <= len(last_cand):
        lo = max(0, err_pos - 80)
        hi = min(len(last_cand), err_pos + 80)
        where = f" [出错位置附近: …{last_cand[lo:hi]}…]"
    raise LLMServiceError(
        f"无法从 LLM 返回内容中解析有效 JSON（响应 {len(cleaned)} 字符，超长响应可能被 max_tokens 截断）: "
        f"{preview}{where} (解析错误: {last_error})")


class LLMService:
    def _normalize_chat_completions_url(self, base_url: str) -> str:
        """格式化 OpenAI /chat/completions 完整端点"""
        url = (base_url or "https://api.deepseek.com/v1").strip().rstrip("/")
        if url.endswith("/chat/completions"):
            return url
        if url.endswith("/responses"):
            return url[:-10] + "/chat/completions"
        return f"{url}/chat/completions"

    def _normalize_responses_url(self, url: str) -> str:
        """格式化 OpenAI Responses API 完整端点"""
        target = (url or "https://api.openai.com/v1/responses").strip().rstrip("/")
        if target.endswith("/responses"):
            return target
        if target.endswith("/chat/completions"):
            return target[:-17] + "/responses"
        return f"{target}/responses"

    def _get_custom_headers(self) -> Dict[str, str]:
        """读取并解析全局/环境变量中配置的大模型自定义请求头 (支持 JSON 或 key:val 行)"""
        raw = os.getenv("OPENAI_CUSTOM_HEADERS") or getattr(settings, "OPENAI_CUSTOM_HEADERS", "") or ""
        if not raw or not str(raw).strip():
            return {}
        try:
            val = json.loads(raw)
            if isinstance(val, dict):
                return {str(k): str(v) for k, v in val.items()}
        except Exception:
            pass
        hdrs: Dict[str, str] = {}
        for line in str(raw).split("\n"):
            line = line.strip()
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip()] = v.strip()
            elif "=" in line:
                k, v = line.split("=", 1)
                hdrs[k.strip()] = v.strip()

        # 兼容 OpenCode 会话路由
        base_url = os.getenv("OPENAI_BASE_URL") or getattr(settings, "OPENAI_BASE_URL", "") or ""
        if "opencode.ai" in str(base_url).lower():
            if not any(k.lower() == "x-opencode-session" for k in hdrs):
                import uuid
                hdrs["x-opencode-session"] = f"session_{uuid.uuid4().hex[:12]}"

        return hdrs

    async def chat_stream(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 120.0,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> AsyncGenerator[str, None]:
        """全模型统一流式 Token 生成器 (SSE Async Generator)，支持自动降级容错"""
        provider = (settings.LLM_PROVIDER or "openai_compatible").lower()
        api_type = (settings.LLM_API_TYPE or "chat_completions").lower()

        # ============================================================
        # 1. OpenAI Responses API 流式模式 (/v1/responses)
        # ============================================================
        if provider == "responses_api" or api_type == "responses_api":
            api_key = settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY
            if not api_key:
                raise LLMServiceError("Responses API 未配置密钥：请在系统配置中填入 API Key")
            endpoint = self._normalize_responses_url(settings.RESPONSES_API_URL or settings.OPENAI_BASE_URL)
            model = settings.RESPONSES_MODEL or settings.OPENAI_MODEL or "gpt-4o"

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            }
            headers.update(self._get_custom_headers())
            if extra_headers:
                headers.update(extra_headers)

            input_items = []
            instructions = ""
            for m in messages:
                role = m.get("role", "user")
                content = m.get("content", "")
                if role == "system":
                    instructions = content
                else:
                    input_items.append({"role": role, "content": content})

            payload: Dict[str, Any] = {
                "model": model,
                "input": input_items if input_items else messages,
                "stream": True,
            }
            if instructions:
                payload["instructions"] = instructions
            if temperature is not None:
                payload["temperature"] = temperature

            responses_succeeded = False
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                        if response.status_code == 200:
                            responses_succeeded = True
                            in_think_block = False
                            async for line in response.aiter_lines():
                                line = line.strip()
                                if not line or line.startswith(":"):
                                    continue
                                if line.startswith("data: "):
                                    data_str = line[6:].strip()
                                    if data_str == "[DONE]":
                                        break
                                    try:
                                        data = json.loads(data_str)
                                        delta_text = ""
                                        if "delta" in data and isinstance(data["delta"], str):
                                            delta_text = data["delta"]
                                        elif "output_text" in data and isinstance(data["output_text"], str):
                                            delta_text = data["output_text"]
                                        elif "choices" in data and data["choices"]:
                                            delta_text = data["choices"][0].get("delta", {}).get("content", "")
                                        elif "output" in data and isinstance(data["output"], list):
                                            for item in data["output"]:
                                                if isinstance(item, dict) and "content" in item:
                                                    for c in item["content"]:
                                                        if isinstance(c, dict) and "text" in c:
                                                            delta_text += c["text"]

                                        if delta_text:
                                            if "<think>" in delta_text:
                                                in_think_block = True
                                            if "</think>" in delta_text:
                                                in_think_block = False
                                                delta_text = delta_text.split("</think>")[-1]
                                            if not in_think_block and delta_text:
                                                yield delta_text
                                    except Exception:
                                        pass
                            return
                        else:
                            err_text = (await response.aread()).decode(errors="ignore")[:300]
                            print(f"[LLM] Responses API 返回 HTTP {response.status_code}: {err_text}，尝试自动平滑降级为 OpenAI /chat/completions 接口...")
            except Exception as e:
                print(f"[LLM] Responses API 异常: {e}，尝试自动平滑降级为 OpenAI /chat/completions 接口...")

            # 自动降级为 /chat/completions
            fallback_base = settings.OPENAI_BASE_URL or settings.RESPONSES_API_URL or "https://api.openai.com/v1"
            async for chunk in self._stream_openai_chat_completions(
                base_url=fallback_base,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                extra_headers=extra_headers,
            ):
                yield chunk
            return

        # ============================================================
        # 2. OpenAI / DeepSeek / 通义千问 / 硅基流动 / OpenCode 标准流式模式
        # ============================================================
        if provider != "minimax" or (settings.OPENAI_API_KEY and not settings.MINIMAX_API_KEY):
            api_key = settings.OPENAI_API_KEY
            if not api_key:
                raise LLMServiceError("未配置 OPENAI_API_KEY：请在系统配置中填入密钥")
            base_url = settings.OPENAI_BASE_URL or "https://api.deepseek.com/v1"
            model = settings.OPENAI_MODEL or "deepseek-chat"

            async for chunk in self._stream_openai_chat_completions(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                extra_headers=extra_headers,
            ):
                yield chunk
            return

        # ============================================================
        # 3. MiniMax API 流式模式
        # ============================================================
        if not settings.MINIMAX_API_KEY:
            raise LLMServiceError("未配置 MINIMAX_API_KEY：请在系统配置中填入密钥")

        headers = {
            "Authorization": f"Bearer {settings.MINIMAX_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        headers.update(self._get_custom_headers())
        if extra_headers:
            headers.update(extra_headers)
        payload = {
            "model": settings.LLM_MODEL or "abab6.5s-chat",
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{settings.MINIMAX_BASE_URL.rstrip('/')}/text/chatcompletion_v2", headers=headers, json=payload) as response:
                if response.status_code != 200:
                    err_body = await response.aread()
                    raise LLMServiceError(f"MiniMax 报错 HTTP {response.status_code}: {err_body.decode(errors='ignore')[:300]}")
                async for chunk in self._parse_openai_sse_stream(response):
                    yield chunk

    async def _stream_openai_chat_completions(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 120.0,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> AsyncGenerator[str, None]:
        """执行标准 OpenAI /chat/completions SSE 传输"""
        endpoint = self._normalize_chat_completions_url(base_url)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        headers.update(self._get_custom_headers())
        if extra_headers:
            headers.update(extra_headers)
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
        }
        is_reasoning_model = any(k in model.lower() for k in ["o1", "o3", "reasoner", "qwq"])
        if not is_reasoning_model:
            payload["temperature"] = temperature
            payload["max_tokens"] = max_tokens
        else:
            payload["max_completion_tokens"] = max_tokens

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                if response.status_code == 400 and "temperature" in payload:
                    # 剥离 temperature 重试
                    payload.pop("temperature", None)
                    async with client.stream("POST", endpoint, headers=headers, json=payload) as retry_resp:
                        if retry_resp.status_code != 200:
                            err_body = await retry_resp.aread()
                            raise LLMServiceError(f"大模型接口 ({endpoint}) 报错 HTTP {retry_resp.status_code}: {err_body.decode(errors='ignore')[:300]}")
                        async for chunk in self._parse_openai_sse_stream(retry_resp):
                            yield chunk
                        return

                if response.status_code != 200:
                    err_body = await response.aread()
                    raise LLMServiceError(f"大模型接口 ({endpoint}) 报错 HTTP {response.status_code}: {err_body.decode(errors='ignore')[:300]}")

                async for chunk in self._parse_openai_sse_stream(response):
                    yield chunk

    async def _parse_openai_sse_stream(self, response: httpx.Response) -> AsyncGenerator[str, None]:
        """解析标准 OpenAI 格式的 SSE 数据流"""
        in_think_block = False
        async for line in response.aiter_lines():
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if line.startswith("data: "):
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            if "<think>" in content:
                                in_think_block = True
                            if "</think>" in content:
                                in_think_block = False
                                content = content.split("</think>")[-1]
                            if not in_think_block and content:
                                yield content
                except Exception:
                    pass

    async def chat_completion(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 120.0,
        response_format: Optional[Dict[str, str]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> str:
        """非流式完整响应接口（优先流式聚合，具备自愈回退与错误提示）"""
        chunks = []
        stream_error = None
        budget = float(os.environ.get("LLM_TOTAL_TIMEOUT_S") or timeout or 120.0)
        try:
            async for chunk in _with_deadline(
                self.chat_stream(messages, temperature=temperature, max_tokens=max_tokens, timeout=timeout, extra_headers=extra_headers),
                budget,
            ):
                chunks.append(chunk)
            if chunks:
                return "".join(chunks).strip()
        except Exception as e:
            stream_error = e
        # REQ-toonflow-canvas FX-B 兜底单次调用抽成 _one_shot_completion（流式增量接口 chat_completion_stream 共用）
        return await self._one_shot_completion(messages, temperature=temperature, timeout=timeout,
                                               extra_headers=extra_headers, stream_error=stream_error)

    async def chat_completion_stream(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 120.0,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> AsyncGenerator[str, None]:
        """REQ-toonflow-canvas FX-B 流式增量接口：逐段 yield 文本增量（OpenAI 兼容 ``stream: true``）。

        - 流式通道与 :meth:`chat_completion` 相同（含整体时限、思考标签剥离）；
        - 上游不支持流式 / 流式失败且**尚未产出任何内容**时退化为一次性调用，整段 yield 一次；
        - 已产出部分内容后流中断 → 抛 LLMServiceError（不再补一次性结果，否则前半段会重复）。
        """
        emitted = False
        stream_error: Optional[Exception] = None
        budget = float(os.environ.get("LLM_TOTAL_TIMEOUT_S") or timeout or 120.0)
        try:
            async for chunk in _with_deadline(
                self.chat_stream(messages, temperature=temperature, max_tokens=max_tokens, timeout=timeout, extra_headers=extra_headers),
                budget,
            ):
                if not chunk:
                    continue
                emitted = True
                yield chunk
        except Exception as e:
            if emitted:
                if isinstance(e, LLMServiceError):
                    raise
                raise LLMServiceError(f"大模型流式响应中断: {_err_text(e)}") from e
            stream_error = e
        if emitted:
            return
        text = await self._one_shot_completion(messages, temperature=temperature, timeout=timeout,
                                               extra_headers=extra_headers, stream_error=stream_error)
        if text:
            yield text

    async def _one_shot_completion(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        timeout: float = 120.0,
        extra_headers: Optional[Dict[str, str]] = None,
        stream_error: Optional[Exception] = None,
    ) -> str:
        """兜底非流式单次调用（Responses API → /chat/completions）；stream_error 为此前流式失败的原因（拼进报错）。"""
        # 兜底非流式单次调用
        provider = (settings.LLM_PROVIDER or "openai_compatible").lower()
        api_type = (settings.LLM_API_TYPE or "chat_completions").lower()

        # 1. 尝试 Responses API 单次调用
        if provider == "responses_api" or api_type == "responses_api":
            api_key = settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY
            endpoint = self._normalize_responses_url(settings.RESPONSES_API_URL or settings.OPENAI_BASE_URL)
            model = settings.RESPONSES_MODEL or settings.OPENAI_MODEL or "gpt-4o"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            headers.update(self._get_custom_headers())
            if extra_headers:
                headers.update(extra_headers)
            
            input_items = []
            instructions = ""
            for m in messages:
                role = m.get("role", "user")
                content = m.get("content", "")
                if role == "system":
                    instructions = content
                else:
                    input_items.append({"role": role, "content": content})

            payload: Dict[str, Any] = {"model": model, "input": input_items if input_items else messages, "temperature": temperature}
            if instructions:
                payload["instructions"] = instructions

            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.post(endpoint, headers=headers, json=payload)
                    if r.status_code == 200:
                        data = r.json()
                        if "output_text" in data and isinstance(data["output_text"], str):
                            return strip_think_tags(data["output_text"])
                        if "output" in data:
                            for item in data["output"]:
                                if "content" in item:
                                    for c in item["content"]:
                                        if isinstance(c, dict) and "text" in c:
                                            return strip_think_tags(c["text"])
            except Exception:
                pass

        # 2. 默认 / 降级 OpenAI /chat/completions
        api_key = settings.OPENAI_API_KEY or settings.RESPONSES_API_KEY or settings.MINIMAX_API_KEY
        endpoint = self._normalize_chat_completions_url(settings.OPENAI_BASE_URL or settings.RESPONSES_API_URL or "https://api.openai.com/v1")
        model = settings.OPENAI_MODEL or settings.RESPONSES_MODEL or "deepseek-chat"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        headers.update(self._get_custom_headers())
        if extra_headers:
            headers.update(extra_headers)
        payload = {"model": model, "messages": messages, "temperature": temperature}
        
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(endpoint, headers=headers, json=payload)
                r.raise_for_status()
                data = r.json()
                return strip_think_tags(data["choices"][0]["message"]["content"])
        except Exception as e:
            if stream_error:
                raise LLMServiceError(f"大模型调用失败: {_err_text(stream_error)} (重试错误: {_err_text(e)})")
            raise LLMServiceError(f"大模型接口 ({endpoint}) 异常: {_err_text(e)}")

    async def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        timeout: float = 120.0,
        max_tokens: int = 16384,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """请求大模型生成严格结构化 JSON 并解析"""
        content = await self.chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            timeout=timeout,
            max_tokens=max_tokens,
            extra_headers=extra_headers,
        )
        return extract_json_from_text(content)


llm_service = LLMService()
