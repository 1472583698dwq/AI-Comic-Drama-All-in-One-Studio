# -*- coding: utf-8 -*-
"""主题包管理器 — 文件即仓库：storage/themes/<id>.json（插件贡献 + 裸件统一）。"""
import json
import os
import time
from typing import Any, Dict, List, Optional

from app.themes.models import ThemeSpec


def _root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "themes")
    os.makedirs(root, exist_ok=True)
    return root


def _path(tid: str) -> str:
    return os.path.join(_root(), f"{tid}.json")


class ThemeManager:
    def list_themes(self) -> List[ThemeSpec]:
        out: List[ThemeSpec] = []
        try:
            for fn in sorted(os.listdir(_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_root(), fn), "r", encoding="utf-8") as f:
                        out.append(ThemeSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out

    def get(self, tid: str) -> Optional[ThemeSpec]:
        try:
            with open(_path(tid), "r", encoding="utf-8") as f:
                return ThemeSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save(self, spec: ThemeSpec) -> ThemeSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        tmp = _path(spec.id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(spec.model_dump(), f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(spec.id))
        return spec

    def delete(self, tid: str) -> bool:
        try:
            if os.path.isfile(_path(tid)):
                os.remove(_path(tid))
                return True
        except Exception:
            pass
        return False


theme_manager = ThemeManager()


def list_effective_themes(project_id: str = "", include_disabled: bool = False) -> List[ThemeSpec]:
    """运行时有效主题（默认过滤扩展中心停用项；管理面可 include_disabled）。"""
    themes = theme_manager.list_themes()
    if include_disabled:
        return themes
    try:
        from app.extensions import state
        ids = state.effective_disabled(project_id or "")
    except Exception:
        ids = set()
    return [t for t in themes if state.match_in("theme", t.id, ids) is None]
