# -*- coding: utf-8 -*-
"""项目级 Agent 权限裁决：模式只决定自动程度，项目设置决定能碰什么。"""
from typing import Any, Dict, Optional

from app.models.agent_policy import (
    DEFAULT_PERMISSIONS,
    POLICY_GROUPS,
    normalize_policy,
)

READ_ONLY_TOOLS = frozenset({
    "search_tools", "canvas_query", "canvas_query_assets",
    "list_assets", "get_asset", "list_image_providers", "list_video_providers",
    "list_voice_providers", "list_voices", "list_comfyui_workflows",
    "list_custom_providers", "get_provider_code", "provider_key_status",
    "fs_read", "read_skill", "director_3d_stage_plan", "stage_get_state",
    "creator_inspect_runtime", "list_custom_nodes", "todo_write",
    "ask_user_question", "view_media", "job_list", "job_status",
    "task_status", "subagent_list", "subagent_status",
    "onekey_summary", "onekey_review",
})

SETTINGS_TOOLS = {"request_mode_switch"}

ADMIN_TOOLS = {
    "register_custom_provider", "update_custom_provider", "delete_custom_provider",
    "test_custom_provider", "migrate_provider_inline_key",
    "creator_start_test", "creator_finalize",
    "creator_propose_capability",
    "creator_propose_change_set", "creator_test_change_set",
    "creator_apply_change_set", "creator_rollback_change_set",
}

GENERATE_TOOLS = {
    "generate_image", "comfyui_render_node", "generate_voice",
    "generate_minimax_voice", "generate_video", "canvas_execute",
    "canvas_dispatch_skill", "onekey_scene_image", "onekey_role_image",
    "onekey_shot_image", "onekey_shot_video", "onekey_shot_voice",
}

WRITE_PROJECT_TOOLS = {
    "canvas_create_node", "canvas_update_node", "canvas_connect",
    "canvas_delete_node", "stage_control", "stage_export_clay",
    "export_jianyin_draft", "export_timeline_mp4", "episode_manage",
    "onekey_split", "onekey_style_lock", "onekey_export",
}

WRITE_ASSET_TOOLS = {"create_asset", "publish_asset"}

DELEGATE_TOOLS = {
    "subagent_run", "subagent_cancel", "subagent_steer", "subagent_wait",
    "batch_run", "job_start",
}

SYSTEM_TOOLS = {"shell_exec", "fs_file"}

DESTRUCTIVE_TOOLS = {
    "shell_exec", "delete_custom_provider", "canvas_delete_node",
}


def normalize_mode(mode: Optional[str]) -> str:
    value = str(mode or "auto").strip().lower()
    if value in ("plan", "planning", "plan_auto", "readonly"):
        return "plan"
    if value in ("create", "creator", "creation", "creative", "create_auto"):
        return "create"
    return "auto"


def tool_group(name: str, args: Optional[Dict[str, Any]] = None) -> str:
    name = str(name or "")
    if name in SETTINGS_TOOLS:
        return "settings"
    if name in SYSTEM_TOOLS:
        return "system"
    if name in ADMIN_TOOLS or name.startswith("plugin_"):
        return "admin"
    if name in DELEGATE_TOOLS or name.startswith("subagent_"):
        return "delegate"
    if name in WRITE_ASSET_TOOLS:
        return "write_assets"
    if name in WRITE_PROJECT_TOOLS:
        return "write_project"
    if name in GENERATE_TOOLS or name.startswith("provider_") or name.startswith("customnode_"):
        return "generate"
    if name in READ_ONLY_TOOLS or name.startswith(("list_", "get_", "query_", "read_")):
        return "read"
    return "write_project"


def is_destructive(name: str, args: Optional[Dict[str, Any]] = None) -> bool:
    if name in DESTRUCTIVE_TOOLS:
        return True
    if name == "fs_file":
        return str((args or {}).get("action", "")).lower() in ("write", "append", "delete")
    return False


def policy_from_context(project_context: Any = None) -> Dict[str, Any]:
    if isinstance(project_context, dict):
        raw = project_context.get("agent_policy")
        if isinstance(raw, dict):
            return normalize_policy(raw)
        meta = project_context.get("meta")
        if isinstance(meta, dict) and isinstance(meta.get("agent_policy"), dict):
            return normalize_policy(meta["agent_policy"])
        pid = str(project_context.get("project_id") or "").strip()
        if not pid:
            project = project_context.get("project")
            if isinstance(project, dict):
                pid = str(project.get("project_id") or project.get("id") or "").strip()
        if pid:
            try:
                from app.providers.project.manager import project_manager
                meta = project_manager.get_meta(pid) or {}
                return normalize_policy(meta.get("agent_policy"))
            except Exception:
                pass
    return normalize_policy({})


def load_policy(project_id: str) -> Dict[str, Any]:
    try:
        from app.providers.project.manager import project_manager
        meta = project_manager.get_meta(project_id) or {}
        return normalize_policy(meta.get("agent_policy"))
    except Exception:
        return normalize_policy({})


def permission_decision(name: str, args: Optional[Dict[str, Any]], run_mode: str,
                        policy: Optional[Dict[str, Any]] = None) -> str:
    mode = normalize_mode(run_mode)
    if mode == "plan":
        return "allow" if name in READ_ONLY_TOOLS else "deny"

    if name == "request_mode_switch":
        target = normalize_mode((args or {}).get("target"))
        return "ask" if target == "create" else "allow"

    if name == "creator_inspect_runtime":
        return "allow"
    if name in ("creator_propose_capability", "creator_propose_change_set") and mode == "create":
        return "allow"

    current = normalize_policy(policy or {})
    group = tool_group(name, args)
    value = current["permissions"].get(group, DEFAULT_PERMISSIONS.get(group, "ask"))
    if value == "deny":
        return "deny"
    if is_destructive(name, args):
        return "ask"
    if mode == "create" and name in ("creator_start_test", "creator_finalize"):
        return "ask"
    return value if value in ("allow", "ask") else "ask"


def policy_summary(policy: Dict[str, Any]) -> Dict[str, Any]:
    current = normalize_policy(policy)
    return {
        "execution_mode": current["execution_mode"],
        "groups": list(POLICY_GROUPS),
        "permissions": current["permissions"],
        "creator": current["creator"],
    }
