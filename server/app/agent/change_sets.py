# -*- coding: utf-8 -*-
"""Creator ChangeSet：把现有 Creator 提案/试跑/持久化包装成统一变更集。"""
from typing import Any, Dict, List, Optional

from app.agent import creator


_STATUS_MAP = {
    "proposed": "proposed",
    "testing": "testing",
    "tested": "tested",
    "test_failed": "failed",
    "persisted": "applied",
    "discarded": "discarded",
    "rolled_back": "rolled_back",
    "needs_manual": "needs_manual",
}

_RESOURCE_MAP = {
    "new_provider": ("provider", "create"),
    "patch_provider": ("provider", "patch"),
    "new_plugin": ("plugin", "create"),
    "storyboard_slot": ("storyboard_slot", "create"),
    "canvas_template": ("canvas_template", "create"),
    "new_skill": ("skill", "create"),
}


def change_set_id(proposal_id: str) -> str:
    pid = str(proposal_id or "").strip()
    return pid if pid.startswith("cs_") else f"cs_{pid}"


def proposal_id_of(value: str) -> str:
    raw = str(value or "").strip()
    return raw[3:] if raw.startswith("cs_") else raw


def _target(prop: Dict[str, Any]) -> str:
    for key in ("plugin_id", "provider_id", "target_provider_id", "slot_key",
                "template_id", "skill_slug"):
        value = prop.get(key)
        if value:
            return str(value)
    kind = str(prop.get("kind") or "")
    if kind == "new_provider":
        spec = prop.get("plugin_spec") or {}
        return str(spec.get("plugin_id") or "")
    if kind == "storyboard_slot":
        doc = (prop.get("slot_spec") or {}).get("doc") or {}
        slot, sid = str(doc.get("slot") or ""), str(doc.get("id") or "")
        if slot and sid:
            return f"{slot}:{sid}"
    if kind == "canvas_template":
        tid = str(prop.get("template_id") or "")
        if tid:
            return tid
    return str(prop.get("goal") or "")[:80]


def _resource_action(kind: str) -> tuple:
    return _RESOURCE_MAP.get(kind, (kind or "unknown", "create"))


def to_change_set(prop: Dict[str, Any]) -> Dict[str, Any]:
    raw_id = str(prop.get("proposal_id") or "")
    resource, action = _resource_action(str(prop.get("kind") or ""))
    changes = [{
        "resource": resource,
        "action": action,
        "target": _target(prop),
        "summary": prop.get("diff_preview") or prop.get("title") or "",
    }]
    status = _STATUS_MAP.get(str(prop.get("status") or "proposed"), "proposed")
    return {
        "id": change_set_id(raw_id),
        "proposal_id": raw_id,
        "goal": prop.get("goal") or "",
        "title": prop.get("title") or "",
        "kind": prop.get("kind") or "",
        "status": status,
        "risk": prop.get("risk") or "medium",
        "changes": changes,
        "impact": prop.get("diff_preview") or "",
        "diff_preview": prop.get("diff_preview") or "",
        "test_plan": prop.get("test_plan") or [],
        "test_report": prop.get("test_report"),
        "rollback_plan": [str(prop.get("reversible") or "可回滚：应用后可 rollback")],
        "reversible": prop.get("reversible") or "",
        "created_at": prop.get("created_at"),
        "raw": prop,
    }


def propose_change_set(goal: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prop = creator.propose_capability(goal or "", context or {})
    return to_change_set(prop)


async def test_change_set(cs_id: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prop = creator.get_proposal(proposal_id_of(cs_id))
    if not prop:
        raise ValueError(f"变更集不存在: {cs_id}")
    result = await creator.start_test(prop["proposal_id"], context or {})
    return to_change_set(result.get("proposal") or prop)


async def apply_change_set(cs_id: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prop = creator.get_proposal(proposal_id_of(cs_id))
    if not prop:
        raise ValueError(f"变更集不存在: {cs_id}")
    await creator.finalize(prop["proposal_id"], "persist", context or {})
    updated = creator.get_proposal(prop["proposal_id"]) or prop
    return to_change_set(updated)


async def discard_change_set(cs_id: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prop = creator.get_proposal(proposal_id_of(cs_id))
    if not prop:
        raise ValueError(f"变更集不存在: {cs_id}")
    await creator.finalize(prop["proposal_id"], "discard", context or {})
    prop["status"] = "discarded"
    return to_change_set(prop)


async def rollback_change_set(cs_id: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    prop = creator.get_proposal(proposal_id_of(cs_id))
    if not prop:
        raise ValueError(f"变更集不存在: {cs_id}")
    await creator.finalize(prop["proposal_id"], "rollback", context or {})
    updated = creator.get_proposal(prop["proposal_id"]) or prop
    return to_change_set(updated)


def get_change_set(cs_id: str) -> Optional[Dict[str, Any]]:
    prop = creator.get_proposal(proposal_id_of(cs_id))
    return to_change_set(prop) if prop else None


def list_change_sets(limit: int = 20) -> List[Dict[str, Any]]:
    return [to_change_set(p) for p in creator.list_proposals(limit=limit)]
