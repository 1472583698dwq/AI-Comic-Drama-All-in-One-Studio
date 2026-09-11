# -*- coding: utf-8 -*-
"""Provider 生产可用「验证」状态。

只有 **已配置 + 测试联通** 的生成源才允许出现在生产端（画布/分镜/节点选择器）；
配置端始终显示全部，供配置与测试。

存储 ``storage/providers/verified.json``：
{
  "<provider_id>": {"verified": true, "at": "2026-..-.. ..:..:..", "detail": "连通正常", "kind": "image"}
}

- 测试成功 → verified=true；测试失败/改 Key/改代码 → verified=false 或清除。
- 运行时默认路由优先选择 verified 的源。
"""
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict

_LOCK = threading.RLock()


def _path() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "providers"
    except Exception:
        base = Path("storage") / "providers"
    base.mkdir(parents=True, exist_ok=True)
    return base / "verified.json"


def _load() -> Dict[str, Any]:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save(d: Dict[str, Any]) -> None:
    with _LOCK:
        p = _path()
        tmp = str(p) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, str(p))


def is_verified(pid: str) -> bool:
    if not pid:
        return False
    return bool((_load().get(str(pid)) or {}).get("verified"))


def mark(pid: str, ok: bool, detail: str = "", kind: str = "") -> Dict[str, Any]:
    pid = str(pid or "")
    if not pid:
        return {}
    with _LOCK:
        d = _load()
        rec = d.setdefault(pid, {})
        rec["verified"] = bool(ok)
        rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        rec["detail"] = str(detail)[:300]
        if kind:
            rec["kind"] = kind
        _save(d)
        return dict(rec)


def clear(pid: str) -> None:
    pid = str(pid or "")
    if not pid:
        return
    with _LOCK:
        d = _load()
        if pid in d:
            d.pop(pid, None)
            _save(d)


def all() -> Dict[str, Any]:
    return _load()
