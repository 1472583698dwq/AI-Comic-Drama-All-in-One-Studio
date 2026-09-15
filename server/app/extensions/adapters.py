# -*- coding: utf-8 -*-
"""各管家只读适配器：把六套 list/get 口径翻译为 ExtensionInfo。

原则：只读、不改存储、不抛异常（单个管家失败只记 error，不炸全表）。
"""
from typing import Any, Dict, List, Optional

from .models import (
    ExtensionKind,
    ExtensionStatus,
    ExtensionSource,
    ExtensionInfo,
    make_ext_id,
)


def _plugin_owner(field: str, local_id: str) -> tuple:
    """在已启用插件索引里查某个 local_id 属于哪个插件的哪个贡献字段。

    返回 (source, plugin_id)：属于插件则 (PLUGIN, pid)，否则 (STANDALONE, "")。
    """
    try:
        from app.plugins.manager import _load_index
        idx = _load_index() or {}
        for pid, rec in (idx.get("plugins") or {}).items():
            if not isinstance(rec, dict) or not rec.get("enabled"):
                continue
            if local_id in (rec.get(field) or []):
                return ExtensionSource.PLUGIN, str(pid)
    except Exception:
        pass
    return ExtensionSource.STANDALONE, ""


def _provider_source(local_id: str) -> tuple:
    """判定自定义 provider 来源：包内件 vs 裸件（包内优先）。"""
    return _plugin_owner("provider_ids", local_id)


def _skill_owner(skill, name: str) -> tuple:
    """技能归属：优先按 file_path（server/skills/.plugins/<pid>/…）判定，回退索引。"""
    fp = (getattr(skill, "file_path", "") or "").replace("\\", "/")
    marker = "/skills/.plugins/"
    if marker in fp:
        pid = fp.split(marker, 1)[1].split("/", 1)[0]
        if pid:
            return ExtensionSource.PLUGIN, pid
    return _plugin_owner("skill_names", name)


def list_provider_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        from app.providers.video.registry import video_registry
        for reg, sub in (
            (image_registry, "image"),
            (video_registry, "video"),
            (audio_registry, "audio"),
        ):
            try:
                ids = reg.list_ids()
            except Exception:
                continue
            for pid in ids:
                try:
                    prov = reg.get(pid)
                except Exception:
                    prov = None
                if prov is None:
                    continue
                is_custom = bool(hasattr(reg, "is_custom") and reg.is_custom(pid))
                if is_custom:
                    source, detail = _provider_source(pid)
                    status = ExtensionStatus.ENABLED
                else:
                    source, detail = ExtensionSource.BUILTIN, ""
                    status = ExtensionStatus.BUILTIN
                derived = ""
                if pid.startswith("comfyui_wf_"):
                    # 工作流 sync 出的独立源：派生关系，去重删除时联动
                    derived = "workflow:sync"
                try:
                    configured = prov.is_configured() if hasattr(prov, "is_configured") else None
                except Exception:
                    configured = None
                _pub = ("builtin" if source == ExtensionSource.BUILTIN else (detail or "local"))
                out.append(ExtensionInfo(
                    id=make_ext_id(ExtensionKind.PROVIDER, pid, _pub),
                    kind=ExtensionKind.PROVIDER,
                    local_id=pid,
                    publisher=_pub,
                    name=getattr(prov, "display_name", pid) or pid,
                    description=getattr(prov, "description", "") or "",
                    icon=getattr(prov, "icon", "") or "",
                    source=source,
                    source_detail=detail,
                    status=status,
                    is_configured=configured,
                    sub_kind=sub,
                    derived_from=derived,
                    detail_hint="providers/hub",
                ))
    except Exception:
        pass
    # 自定义 provider 定义（含已禁用）：补上未注册的 disabled 项
    try:
        from app.providers.custom.manager import custom_provider_manager
        seen = {e.local_id for e in out}
        for d in custom_provider_manager.list_definitions():
            lid = getattr(d, "id", "")
            if not lid or lid in seen:
                continue
            source, detail = _provider_source(lid)
            _pub = ("builtin" if source == ExtensionSource.BUILTIN else (detail or "local"))
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.PROVIDER, lid, _pub),
                kind=ExtensionKind.PROVIDER,
                local_id=lid,
                publisher=_pub,
                name=getattr(d, "name", lid) or lid,
                description=getattr(d, "description", "") or "",
                icon=getattr(d, "icon", "") or "",
                source=source,
                source_detail=detail,
                status=(ExtensionStatus.ENABLED if getattr(d, "enabled", True)
                        else ExtensionStatus.DISABLED),
                is_configured=None,
                sub_kind=getattr(d, "kind", "") or "",
                detail_hint="providers/hub",
            ))
    except Exception:
        pass
    return out


def list_skill_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.skills.engine import skill_engine
        for s in skill_engine.list_skills():
            name = getattr(s, "name", "") or ""
            if not name:
                continue
            source, pid = _skill_owner(s, name)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.SKILL, name, publisher),
                kind=ExtensionKind.SKILL,
                local_id=name,
                publisher=publisher,
                name=name,
                version=getattr(s, "version", "") or "",
                description=getattr(s, "description", "") or "",
                icon="Sparkles",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind="skill",
                detail_hint="skills/workshop",
            ))
    except Exception:
        pass
    return out


def list_workflow_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.providers.workflow.manager import workflow_manager
        wfs = workflow_manager.list_workflows(source="all")
        if not isinstance(wfs, list):
            return out
        for w in wfs:
            if not isinstance(w, dict):
                continue
            wid = str(w.get("id") or "")
            if not wid:
                continue
            source, pid = _plugin_owner("workflow_ids", wid)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.WORKFLOW, wid, publisher),
                kind=ExtensionKind.WORKFLOW,
                local_id=wid,
                publisher=publisher,
                name=str(w.get("name") or wid),
                description=str(w.get("description") or ""),
                icon="GitBranch",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind=str(w.get("source") or ""),
                detail_hint="infra/workflows",
            ))
    except Exception:
        pass
    return out


def list_custom_node_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.custom_nodes.manager import custom_node_manager
        for n in custom_node_manager.list_nodes():
            nid = getattr(n, "id", "") or ""
            if not nid:
                continue
            source, pid = _plugin_owner("custom_nodes", nid)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.CUSTOM_NODE, nid, publisher),
                kind=ExtensionKind.CUSTOM_NODE,
                local_id=nid,
                publisher=publisher,
                name=getattr(n, "name", nid) or nid,
                description=getattr(n, "description", "") or "",
                icon="Code2",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind=getattr(n, "kind", "") or "",
                detail_hint="canvas/nodes",
            ))
    except Exception:
        pass
    return out


def list_plugin_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.plugins.manager import discover, _load_index
        idx = _load_index() or {}
        records = (idx.get("plugins") or {}) if isinstance(idx, dict) else {}
        for item in discover():
            if not isinstance(item, dict):
                continue
            pid = str(item.get("id") or "")
            if not pid:
                continue
            rec = records.get(pid) or {}
            enabled = bool(rec.get("enabled", False)) if isinstance(rec, dict) else False
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.PLUGIN, pid),
                kind=ExtensionKind.PLUGIN,
                local_id=pid,
                publisher=str(item.get("author") or pid),
                name=str(item.get("name") or pid),
                version=str(item.get("version") or ""),
                description=str(item.get("description") or ""),
                icon="Package",
                source=ExtensionSource.STANDALONE,
                status=(ExtensionStatus.ENABLED if enabled else ExtensionStatus.DISABLED),
                depends_on=list(str(k) for k in (item.get("dependsOn") or {}).keys()),
                detail_hint="plugins/hub",
            ))
    except Exception:
        pass
    return out


def list_mcp_tool_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.plugins.manager import _PLUGIN_TOOL_HANDLERS
        for tool_name, h in list((_PLUGIN_TOOL_HANDLERS or {}).items()):
            if not tool_name:
                continue
            pid = ""
            if isinstance(h, dict):
                pid = str(h.get("pid") or "")
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.MCP_TOOL, str(tool_name)),
                kind=ExtensionKind.MCP_TOOL,
                local_id=str(tool_name),
                publisher=pid or "local",
                name=str(tool_name),
                description="插件查壳工具（trusted 闸）",
                icon="Plug",
                source=(ExtensionSource.PLUGIN if pid else ExtensionSource.STANDALONE),
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                detail_hint="plugins/hub",
            ))
    except Exception:
        pass
    return out


def list_storyboard_slot_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.storyboard import slots as slot_store
        data = slot_store.list_effective_slots("", include_disabled=True)
        for s in (data.get("slots") or []):
            if not isinstance(s, dict):
                continue
            key = str(s.get("key") or "")
            if not key or key.startswith("invalid:"):
                continue
            src = str(s.get("source") or "builtin")
            detail = str(s.get("source_detail") or "")
            if src == "builtin":
                source, publisher = ExtensionSource.BUILTIN, "builtin"
            elif src == "plugin":
                source, publisher = ExtensionSource.PLUGIN, (detail or "plugin")
            else:
                source, publisher = ExtensionSource.STANDALONE, "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.STORYBOARD_SLOT, key, publisher),
                kind=ExtensionKind.STORYBOARD_SLOT,
                local_id=key,
                publisher=publisher,
                name=str(s.get("label") or s.get("id") or key),
                description=f"{s.get('slot')} · order {s.get('order', 50)}",
                icon=str(s.get("icon") or "LayoutTemplate"),
                source=source,
                source_detail=detail,
                status=ExtensionStatus.ENABLED,
                sub_kind=str(s.get("slot") or ""),
                detail_hint="storyboard/slots",
                placeholder=not bool(s.get("valid", True)),
            ))
    except Exception:
        pass
    return out


def list_canvas_node_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.canvas_nodes.manager import canvas_node_manager
        for n in canvas_node_manager.list_nodes():
            nid = getattr(n, "id", "") or ""
            if not nid:
                continue
            source, pid = _plugin_owner("canvas_nodes", nid)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.CANVAS_NODE, nid, publisher),
                kind=ExtensionKind.CANVAS_NODE,
                local_id=nid,
                publisher=publisher,
                name=getattr(n, "name", nid) or nid,
                description=getattr(n, "description", "") or "",
                icon=getattr(n, "icon", "") or "Boxes",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind=getattr(n, "kind", "") or "",
                detail_hint="canvas/nodes",
            ))
    except Exception:
        pass
    return out


def list_theme_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.themes.manager import theme_manager
        for t in theme_manager.list_themes():
            tid = getattr(t, "id", "") or ""
            if not tid:
                continue
            source, pid = _plugin_owner("theme_ids", tid)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.THEME, tid, publisher),
                kind=ExtensionKind.THEME,
                local_id=tid,
                publisher=publisher,
                name=getattr(t, "name", tid) or tid,
                description=getattr(t, "description", "") or "",
                icon=getattr(t, "icon", "") or "Palette",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind=getattr(t, "mode", "") or "",
                detail_hint="themes/hub",
            ))
    except Exception:
        pass
    return out


def list_exporter_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.exporters.manager import exporter_manager
        for e in exporter_manager.list_exporters():
            eid = getattr(e, "id", "") or ""
            if not eid:
                continue
            source, pid = _plugin_owner("exporter_ids", eid)
            publisher = pid if source == ExtensionSource.PLUGIN else "local"
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.EXPORTER, eid, publisher),
                kind=ExtensionKind.EXPORTER,
                local_id=eid,
                publisher=publisher,
                name=getattr(e, "name", eid) or eid,
                description=getattr(e, "description", "") or "",
                icon=getattr(e, "icon", "") or "FileOutput",
                source=source,
                source_detail=pid,
                status=ExtensionStatus.ENABLED,
                sub_kind=",".join(getattr(e, "accepts", []) or []),
                detail_hint="export/hub",
            ))
    except Exception:
        pass
    return out


def list_director_pack_extensions() -> List[ExtensionInfo]:
    out: List[ExtensionInfo] = []
    try:
        from app.director_packs.manager import director_pack_manager
        for p in director_pack_manager.list_packs():
            pid = getattr(p, "id", "") or ""
            if not pid:
                continue
            source, owner = _plugin_owner("director_pack_ids", pid)
            publisher = owner if source == ExtensionSource.PLUGIN else "local"
            preset_count = sum(len(v or []) for v in (getattr(p, "presets", {}) or {}).values())
            out.append(ExtensionInfo(
                id=make_ext_id(ExtensionKind.DIRECTOR_PACK, pid, publisher),
                kind=ExtensionKind.DIRECTOR_PACK,
                local_id=pid,
                publisher=publisher,
                name=getattr(p, "name", pid) or pid,
                description=getattr(p, "description", "") or "",
                icon=getattr(p, "icon", "") or "Clapperboard",
                source=source,
                source_detail=owner,
                status=ExtensionStatus.ENABLED,
                sub_kind=f"{preset_count} 预设/{(getattr(p, 'props', []) or []) and len(p.props)} 道具"
                         if preset_count or getattr(p, "props", None) else "",
                detail_hint="director/packs",
            ))
    except Exception:
        pass
    return out


ADAPTERS = {
    ExtensionKind.PROVIDER: list_provider_extensions,
    ExtensionKind.SKILL: list_skill_extensions,
    ExtensionKind.WORKFLOW: list_workflow_extensions,
    ExtensionKind.CUSTOM_NODE: list_custom_node_extensions,
    ExtensionKind.PLUGIN: list_plugin_extensions,
    ExtensionKind.MCP_TOOL: list_mcp_tool_extensions,
    ExtensionKind.STORYBOARD_SLOT: list_storyboard_slot_extensions,
    ExtensionKind.CANVAS_NODE: list_canvas_node_extensions,
    ExtensionKind.THEME: list_theme_extensions,
    ExtensionKind.EXPORTER: list_exporter_extensions,
    ExtensionKind.DIRECTOR_PACK: list_director_pack_extensions,
}
