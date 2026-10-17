# -*- coding: utf-8 -*-
"""模型广场。

一个供应商 = 名称 + 协议（OpenAI 兼容 / Claude）+ base URL + API Key。
同一模型名可以出现在多家供应商里，选中时用「供应商 id + 模型 id」区分。
OpenAI 兼容走 ``/v1/models`` + ``/chat/completions``（Bearer）。
Claude 走 Anthropic Messages：``/v1/models``（``x-api-key``）+ ``/v1/messages``。
对话里选中的组合写在 active 里，Agent 回合用它覆盖全局文本通道。
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

_LOCK = threading.Lock()


def _store_path() -> str:
    return os.path.join(settings.STORAGE_DIR, "llm_plaza.json")


def normalize_protocol(protocol: str) -> str:
    p = (protocol or "openai").strip().lower()
    if p in ("claude", "anthropic"):
        return "claude"
    return "openai"


def _root(base_url: str) -> str:
    b = (base_url or "").strip().rstrip("/")
    for suffix in ("/chat/completions", "/messages", "/models", "/responses"):
        if b.endswith(suffix):
            b = b[: -len(suffix)].rstrip("/")
    return b


def models_url(base_url: str, protocol: str = "openai") -> str:
    """收成模型列表地址。OpenAI 与 Claude 都是 ``/v1/models``，差别在请求头。"""
    b = _root(base_url)
    if not b:
        raise ValueError("请填写接口地址")
    if b.endswith("/v1"):
        return f"{b}/models"
    return f"{b}/v1/models"


def chat_endpoint(base_url: str, protocol: str = "openai") -> str:
    """OpenAI 兼容收成 /chat/completions；Claude 收成 /messages。"""
    b = _root(base_url)
    if not b:
        raise ValueError("请填写接口地址")
    tail = "/messages" if normalize_protocol(protocol) == "claude" else "/chat/completions"
    if b.endswith("/v1"):
        return f"{b}{tail}"
    return f"{b}/v1{tail}"


def list_headers(protocol: str, api_key: str) -> Dict[str, str]:
    headers = {"Accept": "application/json"}
    key = (api_key or "").strip()
    if normalize_protocol(protocol) == "claude":
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
        return headers
    if key:
        headers["Authorization"] = f"Bearer {key}"
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
    return {"suppliers": [], "active": {"supplier_id": "", "model": ""}}


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
            "models": [],
            "fetched_at": "",
            "error": "",
        })
    model = (getattr(settings, "OPENAI_MODEL", "") or "").strip()
    if data["suppliers"] and model:
        data["active"] = {"supplier_id": data["suppliers"][0]["id"], "model": model}
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
    active = raw.get("active") if isinstance(raw.get("active"), dict) else {}
    raw["active"] = {
        "supplier_id": str(active.get("supplier_id") or ""),
        "model": str(active.get("model") or ""),
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
    return {
        "id": s.get("id") or "",
        "name": s.get("name") or "",
        "protocol": normalize_protocol(str(s.get("protocol") or "openai")),
        "base_url": s.get("base_url") or "",
        "has_key": bool((s.get("api_key") or "").strip()),
        "api_key_hint": _mask(s.get("api_key") or ""),
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
        "active": data.get("active") or {"supplier_id": "", "model": ""},
    }


def add_supplier(name: str, base_url: str, api_key: str, protocol: str = "openai") -> Dict[str, Any]:
    name = (name or "").strip()
    base_url = (base_url or "").strip()
    api_key = (api_key or "").strip()
    protocol = normalize_protocol(protocol)
    if not name:
        raise ValueError("请填写供应商名称")
    if not base_url:
        raise ValueError("请填写接口地址")
    models_url(base_url, protocol)
    sid = "sup_" + uuid.uuid4().hex[:8]
    rec = {
        "id": sid,
        "name": name[:40],
        "protocol": protocol,
        "base_url": base_url.rstrip("/"),
        "api_key": api_key,
        "models": [],
        "fetched_at": "",
        "error": "",
    }
    with _LOCK:
        data = _load()
        data["suppliers"].append(rec)
        _save(data)
    return _public(rec)


def delete_supplier(sid: str) -> None:
    with _LOCK:
        data = _load()
        before = len(data["suppliers"])
        data["suppliers"] = [s for s in data["suppliers"] if s.get("id") != sid]
        if len(data["suppliers"]) == before:
            raise ValueError("供应商不存在")
        if (data.get("active") or {}).get("supplier_id") == sid:
            data["active"] = {"supplier_id": "", "model": ""}
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
    url = models_url(base, protocol)
    headers = list_headers(protocol, key)
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


def resolve_override(supplier_id: str, model: str) -> Optional[Dict[str, str]]:
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
    return {
        "endpoint": chat_endpoint(sup.get("base_url") or "", protocol),
        "api_key": key,
        "model": model,
        "protocol": protocol,
    }


def chat_override_from_context(context: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    if not isinstance(context, dict):
        return None
    llm = context.get("llm")
    if not isinstance(llm, dict):
        return None
    return resolve_override(str(llm.get("supplier_id") or ""), str(llm.get("model") or ""))
