# -*- coding: utf-8 -*-
"""模型广场。

一个供应商 = 名称 + 协议（OpenAI 兼容 / Claude）+ base URL + API Key + 自定义请求头。
同一模型名可以出现在多家供应商里，选中时用「供应商 id + 模型 id」区分。
OpenAI 兼容走 ``/v1/models`` + ``/chat/completions``（Bearer）。
Claude 走 Anthropic Messages：``/v1/models``（``x-api-key``）+ ``/v1/messages``。
私有网关要带会话 / 治理头时，在供应商的「高级 → 自定义请求头」里加。

两档选中：
- ``default``：全局默认模型，拆剧本 / 润色 / 一键成片 / AI 对话都用它；
- ``active``：对话输入框里的临时覆盖（只影响本次对话）。
两者都为空时回退到系统设置里的直连通道（OPENAI_* / RESPONSES_*）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.core.config import settings
from app.models.provider_definition import normalize_headers

_LOCK = threading.Lock()

_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$")
_MASKED_KEY_RE = re.compile(r"^[•·*×＊\-\s]+$")


def _store_path() -> str:
    return os.path.join(settings.STORAGE_DIR, "llm_plaza.json")


def normalize_protocol(protocol: str) -> str:
    p = (protocol or "openai").strip().lower()
    if p in ("claude", "anthropic"):
        return "claude"
    if p in ("responses", "responses_api", "openai_responses"):
        return "responses"
    return "openai"


def _root(base_url: str) -> str:
    b = (base_url or "").strip().rstrip("/")
    for suffix in ("/chat/completions", "/messages", "/models", "/responses"):
        if b.endswith(suffix):
            b = b[: -len(suffix)].rstrip("/")
    return b


def _clean_api_key(api_key: str) -> str:
    """Key 要放进 HTTP 请求头，必须是无空白的 ASCII 文本。打码占位符在这里直接拦下。"""
    k = (api_key or "").strip()
    if not k:
        return ""
    if _MASKED_KEY_RE.match(k):
        raise ValueError("API Key 是打码占位符（••••），不是真实 Key —— 请到供应商后台复制完整 Key 再填")
    for ch in k:
        if ord(ch) > 126:
            raise ValueError("API Key 含非 ASCII 字符（中文 / 全角符号 / 打码内容），HTTP 请求头发不出去，请重填真实 Key")
        if ch.isspace():
            raise ValueError("API Key 里不能有空格或换行，请检查是不是复制多了内容")
    return k


def _clean_base_url(base_url: str) -> str:
    b = (base_url or "").strip()
    if not b:
        raise ValueError("请填写接口地址")
    if not (b.startswith("http://") or b.startswith("https://")):
        raise ValueError("接口地址要以 http:// 或 https:// 开头")
    for ch in b:
        if ord(ch) > 126 or ch.isspace():
            raise ValueError("接口地址含空格或非 ASCII 字符，请检查")
    return b.rstrip("/")


def _clean_headers(raw: Any) -> Dict[str, str]:
    """自定义请求头：接受 dict / JSON 文本 / 每行「Key: Value」；值必须是 ASCII（HTTP 头限制）。

    带非 ASCII 的请求头会让 httpx/h11 在编码时报 ``'ascii' codec can't encode``，
    所以在写入时就拦下来并给出人话错误，而不是等请求失败。
    """
    if raw is None:
        return {}
    items: List[Any] = []
    if isinstance(raw, dict):
        items = list(raw.items())
    elif isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        parsed: Any = None
        if s[:1] in "[{":
            try:
                parsed = json.loads(s)
            except Exception:
                parsed = None
        if isinstance(parsed, dict):
            items = list(parsed.items())
        elif isinstance(parsed, list):
            items = parsed
        else:
            for line in s.splitlines():
                line = line.strip()
                if not line:
                    continue
                sep = ":" if ":" in line else ("=" if "=" in line else "")
                if not sep:
                    raise ValueError("自定义请求头格式不对：应为 JSON，或每行「Key: Value」")
                k, v = line.split(sep, 1)
                items.append((k, v))
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError("自定义请求头格式不对")

    rows: List[Tuple[str, str]] = []
    for it in items:
        if isinstance(it, (list, tuple)) and len(it) == 2:
            name, value = it[0], it[1]
        elif isinstance(it, dict):
            name = it.get("key") if it.get("key") is not None else it.get("name")
            value = it.get("value")
        else:
            raise ValueError("自定义请求头格式不对")
        n = str(name or "").strip()
        v = "" if value is None else str(value).strip()
        if not n:
            raise ValueError("自定义请求头存在空的名字")
        if not _HEADER_NAME_RE.match(n):
            raise ValueError(f"自定义请求头名称「{n}」不合法（只支持 ASCII 字母 / 数字 / - _ 等）")
        for ch in v:
            if ord(ch) > 126 or ch in "\r\n":
                raise ValueError(f"自定义请求头「{n}」的值含非 ASCII 字符或换行，请检查")
        rows.append((n, v))
    return normalize_headers(dict(rows))


def _with_session_header(base_url: str, headers: Dict[str, str]) -> Dict[str, str]:
    """OpenCode 网关要求带会话路由标识，没配就补一个（与全局通道的行为一致）。"""
    out = dict(headers or {})
    if "opencode.ai" in (base_url or "").lower():
        if not any(str(k).lower() == "x-opencode-session" for k in out):
            out["x-opencode-session"] = f"session_{uuid.uuid4().hex[:12]}"
    return out


def models_url(base_url: str, protocol: str = "openai") -> str:
    """收成模型列表地址。OpenAI 与 Claude 都是 ``/v1/models``，差别在请求头。"""
    b = _root(base_url)
    if not b:
        raise ValueError("请填写接口地址")
    if b.endswith("/v1"):
        return f"{b}/models"
    return f"{b}/v1/models"


def chat_endpoint(base_url: str, protocol: str = "openai") -> str:
    """OpenAI 兼容收成 /chat/completions；Responses 收成 /responses；Claude 收成 /messages。"""
    b = _root(base_url)
    if not b:
        raise ValueError("请填写接口地址")
    proto = normalize_protocol(protocol)
    tail = "/messages" if proto == "claude" else ("/responses" if proto == "responses" else "/chat/completions")
    if b.endswith("/v1"):
        return f"{b}{tail}"
    return f"{b}/v1{tail}"


def chat_completions_endpoint(base_url: str) -> str:
    """同站点的 /chat/completions：Responses 协议在工具调用 / 降级时兜底走它。"""
    b = _root(base_url)
    if not b:
        raise ValueError("请填写接口地址")
    if b.endswith("/v1"):
        return f"{b}/chat/completions"
    return f"{b}/v1/chat/completions"


def list_headers(protocol: str, api_key: str, extra_headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """OpenAI 与 Claude 都是 ``/v1/models``，差别在鉴权头；extra 是供应商自定义请求头，后写覆盖先写。"""
    headers = {"Accept": "application/json"}
    key = (api_key or "").strip()
    if normalize_protocol(protocol) == "claude":
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
    elif key:
        headers["Authorization"] = f"Bearer {key}"
    if extra_headers:
        headers.update(extra_headers)
    return headers


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _mask(key: str) -> str:
    k = (key or "").strip()
    if not k:
        return ""
    if len(k) <= 6:
        return "••••"
    return f"{k[:3]}••••{k[-4:]}"


def _empty() -> Dict[str, Any]:
    return {
        "suppliers": [],
        "default": {"supplier_id": "", "model": ""},
        "active": {"supplier_id": "", "model": ""},
    }


def _seed_from_settings() -> Dict[str, Any]:
    """第一次打开广场时，把已经配好的文本通道抄成供应商，避免再填一遍 Key。"""
    data = _empty()
    openai_key = (getattr(settings, "OPENAI_API_KEY", "") or "").strip()
    openai_base = (getattr(settings, "OPENAI_BASE_URL", "") or "").strip()
    if openai_key or openai_base:
        data["suppliers"].append({
            "id": "sup_openai",
            "name": "OpenAI 兼容",
            "protocol": "openai",
            "base_url": openai_base or "https://api.deepseek.com/v1",
            "api_key": openai_key,
            "headers": {},
            "models": [],
            "fetched_at": "",
            "error": "",
        })
    mini_key = (getattr(settings, "MINIMAX_API_KEY", "") or "").strip()
    if mini_key:
        data["suppliers"].append({
            "id": "sup_minimax",
            "name": "MiniMax",
            "protocol": "openai",
            "base_url": (getattr(settings, "MINIMAX_BASE_URL", "") or "").strip() or "https://api.minimaxi.com/v1",
            "api_key": mini_key,
            "headers": {},
            "models": [],
            "fetched_at": "",
            "error": "",
        })
    # 默认模型跟着系统设置里当前在用的通道走：MiniMax 走 MiniMax 那把，其余走 OpenAI 兼容
    provider = (getattr(settings, "LLM_PROVIDER", "") or "openai_compatible").lower()
    default_sid = ""
    model = ""
    if provider == "minimax" and any(s["id"] == "sup_minimax" for s in data["suppliers"]):
        default_sid = "sup_minimax"
        model = (getattr(settings, "LLM_MODEL", "") or "").strip()
    elif data["suppliers"]:
        default_sid = data["suppliers"][0]["id"]
        model = (getattr(settings, "OPENAI_MODEL", "") or "").strip()
    if default_sid and model:
        data["default"] = {"supplier_id": default_sid, "model": model}
    return data


def _load() -> Dict[str, Any]:
    path = _store_path()
    if not os.path.isfile(path):
        data = _seed_from_settings()
        _save(data)
        return data
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        raw = _empty()
    if not isinstance(raw, dict):
        raw = _empty()
    raw.setdefault("suppliers", [])
    for s in raw["suppliers"]:
        if isinstance(s, dict):
            s["protocol"] = normalize_protocol(str(s.get("protocol") or "openai"))
            if not isinstance(s.get("headers"), dict):
                s["headers"] = {}
    active = raw.get("active") if isinstance(raw.get("active"), dict) else {}
    raw["active"] = {
        "supplier_id": str(active.get("supplier_id") or ""),
        "model": str(active.get("model") or ""),
    }
    default = raw.get("default") if isinstance(raw.get("default"), dict) else {}
    raw["default"] = {
        "supplier_id": str(default.get("supplier_id") or ""),
        "model": str(default.get("model") or ""),
    }
    return raw


def _save(data: Dict[str, Any]) -> None:
    path = _store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _public(s: Dict[str, Any]) -> Dict[str, Any]:
    models = s.get("models") if isinstance(s.get("models"), list) else []
    headers = s.get("headers") if isinstance(s.get("headers"), dict) else {}
    return {
        "id": s.get("id") or "",
        "name": s.get("name") or "",
        "protocol": normalize_protocol(str(s.get("protocol") or "openai")),
        "base_url": s.get("base_url") or "",
        "has_key": bool((s.get("api_key") or "").strip()),
        "api_key_hint": _mask(s.get("api_key") or ""),
        "headers": {str(k): str(v) for k, v in headers.items()},
        "models": [
            {"id": str(m.get("id") or ""), "owned_by": str(m.get("owned_by") or ""), "display": str(m.get("display") or "")}
            for m in models if isinstance(m, dict) and m.get("id")
        ],
        "fetched_at": s.get("fetched_at") or "",
        "error": s.get("error") or "",
    }


def snapshot() -> Dict[str, Any]:
    with _LOCK:
        data = _load()
    return {
        "suppliers": [_public(s) for s in data.get("suppliers") or [] if isinstance(s, dict)],
        "default": data.get("default") or {"supplier_id": "", "model": ""},
        "active": data.get("active") or {"supplier_id": "", "model": ""},
    }


def add_supplier(name: str, base_url: str, api_key: str, protocol: str = "openai",
                 headers: Any = None) -> Dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("请填写供应商名称")
    base_url = _clean_base_url(base_url)
    api_key = _clean_api_key(api_key)
    protocol = normalize_protocol(protocol)
    clean_headers = _clean_headers(headers)
    models_url(base_url, protocol)
    sid = "sup_" + uuid.uuid4().hex[:8]
    rec = {
        "id": sid,
        "name": name[:40],
        "protocol": protocol,
        "base_url": base_url,
        "api_key": api_key,
        "headers": clean_headers,
        "models": [],
        "fetched_at": "",
        "error": "",
    }
    with _LOCK:
        data = _load()
        data["suppliers"].append(rec)
        _save(data)
    return _public(rec)


def update_supplier(sid: str, *, name: Optional[str] = None, base_url: Optional[str] = None,
                    api_key: Optional[str] = None, protocol: Optional[str] = None,
                    headers: Any = None) -> Optional[Dict[str, Any]]:
    """编辑供应商。None 表示不改；api_key 传空串表示保留旧 Key；headers 传 {} 表示清空。"""
    with _LOCK:
        data = _load()
        sup = next((s for s in data["suppliers"] if s.get("id") == sid), None)
        if sup is None:
            return None
        if name is not None:
            n = name.strip()
            if not n:
                raise ValueError("请填写供应商名称")
            sup["name"] = n[:40]
        if protocol is not None:
            sup["protocol"] = normalize_protocol(protocol)
        if base_url is not None:
            sup["base_url"] = _clean_base_url(base_url)
        if api_key is not None and api_key.strip():
            sup["api_key"] = _clean_api_key(api_key)
        if headers is not None:
            sup["headers"] = _clean_headers(headers)
        models_url(sup.get("base_url") or "", str(sup.get("protocol") or "openai"))
        sup["error"] = ""
        _save(data)
        return _public(sup)


def delete_supplier(sid: str) -> None:
    with _LOCK:
        data = _load()
        before = len(data["suppliers"])
        data["suppliers"] = [s for s in data["suppliers"] if s.get("id") != sid]
        if len(data["suppliers"]) == before:
            raise ValueError("供应商不存在")
        if (data.get("active") or {}).get("supplier_id") == sid:
            data["active"] = {"supplier_id": "", "model": ""}
        if (data.get("default") or {}).get("supplier_id") == sid:
            data["default"] = {"supplier_id": "", "model": ""}
        _save(data)


def set_active(supplier_id: str, model: str) -> Dict[str, str]:
    supplier_id = (supplier_id or "").strip()
    model = (model or "").strip()
    with _LOCK:
        data = _load()
        if supplier_id:
            sup = next((s for s in data["suppliers"] if s.get("id") == supplier_id), None)
            if not sup:
                raise ValueError("供应商不存在")
            if not model:
                raise ValueError("请选择模型")
        data["active"] = {"supplier_id": supplier_id, "model": model}
        _save(data)
        return dict(data["active"])


def set_default(supplier_id: str, model: str) -> Dict[str, str]:
    """设置全局默认模型（拆剧本 / 润色 / 对话共用）。传空串表示清空、回退直连通道。"""
    supplier_id = (supplier_id or "").strip()
    model = (model or "").strip()
    with _LOCK:
        data = _load()
        if supplier_id:
            sup = next((s for s in data["suppliers"] if s.get("id") == supplier_id), None)
            if not sup:
                raise ValueError("供应商不存在")
            if not model:
                raise ValueError("请选择模型")
        data["default"] = {"supplier_id": supplier_id, "model": model}
        _save(data)
        return dict(data["default"])


def _parse_models(payload: Any) -> List[Dict[str, str]]:
    rows: List[Any] = []
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            rows = data
        elif isinstance(payload.get("models"), list):
            rows = payload["models"]
    elif isinstance(payload, list):
        rows = payload
    out: List[Dict[str, str]] = []
    seen = set()
    for m in rows:
        if isinstance(m, str):
            mid = m.strip()
            owned = ""
            display = ""
        elif isinstance(m, dict):
            mid = str(m.get("id") or m.get("name") or "").strip()
            owned = str(m.get("owned_by") or m.get("owner") or "")
            display = str(m.get("display_name") or m.get("display") or "")
        else:
            continue
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append({"id": mid, "owned_by": owned, "display": display})
        if len(out) >= 300:
            break
    return out


async def refresh_supplier(sid: str) -> Dict[str, Any]:
    with _LOCK:
        data = _load()
        sup = next((s for s in data["suppliers"] if s.get("id") == sid), None)
        if not sup:
            raise ValueError("供应商不存在")
        base = sup.get("base_url") or ""
        key = (sup.get("api_key") or "").strip()
        protocol = normalize_protocol(str(sup.get("protocol") or "openai"))
        extra = sup.get("headers") if isinstance(sup.get("headers"), dict) else {}
    url = models_url(base, protocol)
    headers = _with_session_header(base, list_headers(protocol, key, extra))
    error = ""
    models: List[Dict[str, str]] = []
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code in (401, 403):
            error = f"鉴权失败（{r.status_code}）：请检查 API Key"
        elif r.status_code >= 400:
            error = f"拉取失败（{r.status_code}）：{r.text[:180]}"
        else:
            models = _parse_models(r.json())
            if not models:
                error = "接口通了，但没有返回模型列表"
    except UnicodeEncodeError:
        # 老数据里可能存着打码/全角内容：HTTP 头只能发 ASCII，给可操作的中文错误
        error = "连接失败：API Key 或自定义请求头含非 ASCII 字符（打码内容 / 全角符号），请点「编辑」重填"
    except Exception as e:
        error = f"连接失败：{e}"
    with _LOCK:
        data = _load()
        sup = next((s for s in data["suppliers"] if s.get("id") == sid), None)
        if not sup:
            raise ValueError("供应商不存在")
        sup["models"] = models
        sup["fetched_at"] = _now()
        sup["error"] = error
        _save(data)
        return _public(sup)


def resolve_default() -> Optional[Dict[str, Any]]:
    """全局默认模型（拆剧本 / 润色 / 一键成片 / 无对话覆盖时的 AI 对话）。未配置时返回 None。"""
    with _LOCK:
        data = _load()
    d = data.get("default") if isinstance(data.get("default"), dict) else {}
    return resolve_override(str(d.get("supplier_id") or ""), str(d.get("model") or ""))


def resolve_override(supplier_id: str, model: str) -> Optional[Dict[str, Any]]:
    """给 Agent 适配器用的端点。缺供应商、缺 Key 或没选模型时返回 None，走全局默认通道。"""
    supplier_id = (supplier_id or "").strip()
    model = (model or "").strip()
    if not supplier_id or not model:
        return None
    with _LOCK:
        data = _load()
    sup = next((s for s in data.get("suppliers") or [] if s.get("id") == supplier_id), None)
    if not sup:
        return None
    key = (sup.get("api_key") or "").strip()
    if not key:
        return None
    protocol = normalize_protocol(str(sup.get("protocol") or "openai"))
    base = sup.get("base_url") or ""
    extra = sup.get("headers") if isinstance(sup.get("headers"), dict) else {}
    out: Dict[str, Any] = {
        "endpoint": chat_endpoint(base, protocol),
        "api_key": key,
        "model": model,
        "protocol": protocol,
        "headers": _with_session_header(base, extra),
    }
    if protocol == "responses":
        # 工具调用 / Responses 不可用时，同站点的 chat/completions 兜底
        out["fallback_endpoint"] = chat_completions_endpoint(base)
    return out


def chat_override_from_context(context: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(context, dict):
        return None
    llm = context.get("llm")
    if not isinstance(llm, dict):
        return None
    return resolve_override(str(llm.get("supplier_id") or ""), str(llm.get("model") or ""))
