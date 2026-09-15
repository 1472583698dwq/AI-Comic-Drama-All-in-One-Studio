# -*- coding: utf-8 -*-
"""扩展启停覆盖层：为无原生生命周期的 kind 提供统一启停，并支持项目作用域。

存储 ``storage/extensions/state.json``：
{
  "global":   {"disabled": ["skill:foo", "workflow:bar"]},
  "projects": {"<project_id>": {"disabled": ["provider:baz"]}}
}

- 原生生命周期 kind（plugin / 自定义 provider）走各自管家，不落这里；
- 其余 kind（skill / workflow / custom_node / mcp_tool / storyboard_slot…）
  以及 standalone 项通过本覆盖层“软停用”：
  - ``list`` 时状态标记为 disabled
  - ``execute`` 时拒绝执行
- 项目作用域在全局基础上叠加（global ∪ project），互不覆盖。
"""
import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

_LOCK = threading.RLock()


def _state_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "extensions"
    except Exception:
        base = Path("storage") / "extensions"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _state_path() -> Path:
    return _state_dir() / "state.json"


def _load() -> Dict[str, Any]:
    try:
        with open(_state_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data.setdefault("global", {})
            data.setdefault("projects", {})
            if not isinstance(data.get("projects"), dict):
                data["projects"] = {}
            return data
    except Exception:
        pass
    return {"global": {}, "projects": {}}


def _save(data: Dict[str, Any]) -> None:
    with _LOCK:
        p = _state_path()
        tmp = str(p) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, str(p))


def _scope_bucket(data: Dict[str, Any], scope: str) -> Dict[str, Any]:
    if not scope:
        return data.setdefault("global", {})
    return data.setdefault("projects", {}).setdefault(str(scope), {})


def disabled_ids(scope: str = "") -> Set[str]:
    """指定作用域自身的停用集（不含全局继承）。"""
    with _LOCK:
        data = _load()
        return set((_scope_bucket(data, scope).get("disabled") or []))


def effective_disabled(scope: str = "") -> Set[str]:
    """全局 ∪ 指定项目 的生效停用集。"""
    with _LOCK:
        data = _load()
        out: Set[str] = set(data.get("global", {}).get("disabled") or [])
        if scope:
            proj = (data.get("projects") or {}).get(str(scope)) or {}
            out |= set(proj.get("disabled") or [])
        return out


def is_disabled(ext_id: str, scope: str = "") -> bool:
    return ext_id in effective_disabled(scope)


def match_in(kind: str, local_id: str, disabled_ids: Set[str]) -> Optional[str]:
    """在给定停用集合中按 (kind, local_id) 匹配（避免逐项重复读盘）。"""
    if not disabled_ids:
        return None
    direct = f"{kind}:{local_id}"
    if direct in disabled_ids:
        return direct
    prefix = f"{kind}:"
    suffix = f"/{local_id}"
    for i in disabled_ids:
        if i.startswith(prefix) and i.endswith(suffix):
            return i
    return None


def match_disabled(kind: str, local_id: str, scope: str = "") -> Optional[str]:
    """按 (kind, local_id) 匹配生效停用集，命中返回停用 id，否则 None。

    同时兼容无命名空间 `kind:local_id` 与带命名空间 `kind:publisher/local_id`，
    这样引擎层无需解析 publisher 即可强制停用。
    """
    return match_in(kind, local_id, effective_disabled(scope))


def set_disabled(ext_id: str, disabled: bool, scope: str = "") -> Dict[str, Any]:
    """写入指定作用域（scope 为空 = 全局）。"""
    ext_id = str(ext_id or "").strip()
    if not ext_id:
        raise ValueError("ext_id 不能为空")
    with _LOCK:
        data = _load()
        bucket = _scope_bucket(data, scope)
        cur = set(bucket.get("disabled") or [])
        if disabled:
            cur.add(ext_id)
        else:
            cur.discard(ext_id)
        bucket["disabled"] = sorted(cur)
        _save(data)
    return {"extension": ext_id, "disabled": bool(disabled), "scope": scope or "global"}


def prune_unknown(known_ids: Set[str]) -> int:
    """清理状态文件里已不存在的扩展 id（历史悬空引用）。返回清理条数。"""
    removed = 0
    with _LOCK:
        data = _load()
        for bucket in [data.get("global", {})] + list((data.get("projects") or {}).values()):
            if not isinstance(bucket, dict):
                continue
            cur = [x for x in (bucket.get("disabled") or []) if x in known_ids]
            if len(cur) != len(bucket.get("disabled") or []):
                removed += len(bucket.get("disabled") or []) - len(cur)
            bucket["disabled"] = cur
        if removed:
            _save(data)
    return removed
