# -*- coding: utf-8 -*-
"""导出器管理器 — 文件即仓库：storage/exporters/<id>.json。

执行：载荷（project/shots/characters/assets/meta）按声明装配 → 统一执行口。
"""
import json
import os
import time
from typing import Any, Dict, List, Optional

from app.exporters.models import ExporterSpec


def _root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "exporters")
    os.makedirs(root, exist_ok=True)
    return root


def _path(eid: str) -> str:
    return os.path.join(_root(), f"{eid}.json")


class ExporterManager:
    def list_exporters(self) -> List[ExporterSpec]:
        out: List[ExporterSpec] = []
        try:
            for fn in sorted(os.listdir(_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_root(), fn), "r", encoding="utf-8") as f:
                        out.append(ExporterSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out

    def get(self, eid: str) -> Optional[ExporterSpec]:
        try:
            with open(_path(eid), "r", encoding="utf-8") as f:
                return ExporterSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save(self, spec: ExporterSpec) -> ExporterSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        tmp = _path(spec.id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(spec.model_dump(), f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(spec.id))
        return spec

    def delete(self, eid: str) -> bool:
        try:
            if os.path.isfile(_path(eid)):
                os.remove(_path(eid))
                return True
        except Exception:
            pass
        return False


exporter_manager = ExporterManager()


def list_effective_exporters(project_id: str = "", include_disabled: bool = False) -> List[ExporterSpec]:
    exporters = exporter_manager.list_exporters()
    if include_disabled:
        return exporters
    try:
        from app.extensions import state
        ids = state.effective_disabled(project_id or "")
    except Exception:
        ids = set()
    return [e for e in exporters if state.match_in("exporter", e.id, ids) is None]


def build_export_args(spec: ExporterSpec, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """装配执行参数：静态 args → 按 accepts/map 注入载荷。"""
    payload = dict(payload or {})
    args: Dict[str, Any] = {k: v for k, v in (spec.run.args or {}).items() if v not in (None, "")}
    mapping = dict(spec.run.map or {})
    if not mapping:
        mapping = {k: f"${k}" for k in (spec.accepts or ["project"])}
    for target, expr in mapping.items():
        raw = str(expr or "")
        if raw.startswith("$") and raw[1:] in ("project", "shots", "characters", "assets", "meta"):
            v = payload.get(raw[1:])
        else:
            v = raw
        if v not in (None, "", []):
            args[target] = v
    return args


async def run_exporter(spec: ExporterSpec,
                       payload: Optional[Dict[str, Any]] = None,
                       project_id: Optional[str] = None) -> Dict[str, Any]:
    """执行导出器：guard 审计 → 统一执行口；返回原始结果 + exporter_id。"""
    from app.extensions import guard
    guard.ensure_enabled("exporter", spec.id, project_id)

    args = build_export_args(spec, payload)
    from app.extensions.registry import extension_registry
    result = await extension_registry.execute(
        spec.run.extension, args=args,
        entry=(spec.run.entry or "generate"), scope=(project_id or ""))
    if not isinstance(result, dict):
        result = {"result": result}
    out = {"status": "success", "exporter_id": spec.id, "extension": spec.run.extension}
    out.update({k: v for k, v in result.items() if k not in ("status", "extension", "elapsed_ms")})
    return out
