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
import logging
from typing import List, Dict, Any, Optional, AsyncGenerator

import httpx

from app.core.config import settings

logger = logging.getLogger("llm_service")


class LLMServiceError(RuntimeError):
    """LLM 服务异常或配置错误"""


def strip_think_tags(text: str) -> str:
    """去除推理模型输出的 <think>...</think> 或 <thought>...</thought> 标签"""
    if not text:
        return ""
    cleaned = re.sub(r"<(think|thought)>[\s\S]*?</\1>", "", text, flags=re.IGNORECASE)
    return cleaned.strip()


def extract_json_from_text(text: str) -> Dict[str, Any]:
    """从 LLM 返回的文本中提取并解析合法 JSON"""
    if not text:
        raise LLMServiceError("LLM 返回空响应，无法解析 JSON")

    cleaned = strip_think_tags(text)

    # 匹配 Markdown 代码块 (```json ... ``` 或 ``` ...)
    code_block_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    candidates = []
    if code_block_match:
        candidates.append(code_block_match.group(1).strip())

    # 匹配最外层 { ... }
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidates.append(cleaned[first_brace:last_brace + 1].strip())

    candidates.append(cleaned.strip())

    last_error = None
    for cand in candidates:
        try:
            return json.loads(cand)
        except json.JSONDecodeError as e:
            last_error = e
            try:
                fixed = re.sub(r",\s*([}\]])", r"\1", cand)
                return json.loads(fixed)
            except Exception:
                pass

    preview = cleaned[:300] if len(cleaned) > 300 else cleaned
    raise LLMServiceError(f"无法从 LLM 返回内容中解析有效 JSON: {preview} (解析错误: {last_error})")


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

    async def chat_stream(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout: float = 120.0,
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
    ) -> AsyncGenerator[str, None]:
        """执行标准 OpenAI /chat/completions SSE 传输"""
        endpoint = self._normalize_chat_completions_url(base_url)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
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
    ) -> str:
        """非流式完整响应接口（优先流式聚合，具备自愈回退与错误提示）"""
        chunks = []
        stream_error = None
        try:
            async for chunk in self.chat_stream(messages, temperature=temperature, max_tokens=max_tokens, timeout=timeout):
                chunks.append(chunk)
            if chunks:
                return "".join(chunks).strip()
        except Exception as e:
            stream_error = e

        # 兜底非流式单次调用
        provider = (settings.LLM_PROVIDER or "openai_compatible").lower()
        api_type = (settings.LLM_API_TYPE or "chat_completions").lower()

        # 1. 尝试 Responses API 单次调用
        if provider == "responses_api" or api_type == "responses_api":
            api_key = settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY
            endpoint = self._normalize_responses_url(settings.RESPONSES_API_URL or settings.OPENAI_BASE_URL)
            model = settings.RESPONSES_MODEL or settings.OPENAI_MODEL or "gpt-4o"
            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            
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
        payload = {"model": model, "messages": messages, "temperature": temperature}
        
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.post(endpoint, headers=headers, json=payload)
                r.raise_for_status()
                data = r.json()
                return strip_think_tags(data["choices"][0]["message"]["content"])
        except Exception as e:
            if stream_error:
                raise LLMServiceError(f"大模型调用失败: {stream_error} (重试错误: {e})")
            raise LLMServiceError(f"大模型接口 ({endpoint}) 异常: {e}")

    async def chat_json(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        timeout: float = 120.0,
    ) -> Dict[str, Any]:
        """请求大模型生成严格结构化 JSON 并解析"""
        content = await self.chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            timeout=timeout,
        )
        return extract_json_from_text(content)


llm_service = LLMService()
