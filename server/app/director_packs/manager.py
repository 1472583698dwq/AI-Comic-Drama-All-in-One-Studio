# -*- coding: utf-8 -*-
"""导演包管理器 — 文件即仓库：storage/director_packs/<id>.json（插件贡献 + 裸件统一）。"""
import json
import os
import time
from typing import List, Optional

from app.director_packs.models import DirectorPackSpec


def _root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "director_packs")
    os.makedirs(root, exist_ok=True)
    return root


def _path(pid: str) -> str:
    return os.path.join(_root(), f"{pid}.json")


class DirectorPackManager:
    def list_packs(self) -> List[DirectorPackSpec]:
        out: List[DirectorPackSpec] = []
        try:
            for fn in sorted(os.listdir(_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_root(), fn), "r", encoding="utf-8") as f:
                        out.append(DirectorPackSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out

    def get(self, pid: str) -> Optional[DirectorPackSpec]:
        try:
            with open(_path(pid), "r", encoding="utf-8") as f:
                return DirectorPackSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save(self, spec: DirectorPackSpec) -> DirectorPackSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        tmp = _path(spec.id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(spec.model_dump(), f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(spec.id))
        return spec

    def delete(self, pid: str) -> bool:
        try:
            if os.path.isfile(_path(pid)):
                os.remove(_path(pid))
                return True
        except Exception:
            pass
        return False


director_pack_manager = DirectorPackManager()


def list_effective_packs(project_id: str = "", include_disabled: bool = False) -> List[DirectorPackSpec]:
    packs = director_pack_manager.list_packs()
    if include_disabled:
        return packs
    try:
        from app.extensions import state
        ids = state.effective_disabled(project_id or "")
    except Exception:
        ids = set()
    return [p for p in packs if state.match_in("director_pack", p.id, ids) is None]
