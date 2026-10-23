# -*- coding: utf-8 -*-
"""
运行模式策略 — 只保留 plan / auto / create。

模式只决定自动程度：
  - plan   只读侦察（绑定层只给只读工具 + 执行口二次拒绝写工具），产出计划
  - auto   按项目权限执行：allow 直接做、ask 确认、deny 拒绝
  - create 在 auto 基础上允许 Creator 提案；系统变更仍需用户批准

具体工具能否执行由项目级 ProjectPolicy 决定（app.agent.policy），不靠提示词。
旧 token（approve / create_auto / plan_auto）只做兼容归一。

fail-closed：无 answerer（HTTP/SSE 无交互通道）时 ask 一律按拒绝处理。
"""
from typing import Any, Dict, Optional

RUN_MODES = ("plan", "auto", "create")

BEHAVIOR_MODES = ("plan", "auto", "create")
EXECUTION_MODES = ("auto",)

# 计划模式只读白名单（单一来源：绑定层 app.agent.tools.registry 与执行口 pipeline 都从这里取，
# 模型即使想变更也无工具可调、调了也会被拒——模式约束靠代码，不靠提示词）。
PLAN_READONLY_TOOLS = frozenset({
    "search_tools",
    "canvas_query", "canvas_query_assets",
    "list_assets", "get_asset",
    "list_image_providers", "list_video_providers", "list_voice_providers",
    "list_voices", "list_comfyui_workflows", "list_custom_providers",
    "get_provider_code",
    "provider_key_status",
    "fs_read", "read_skill",
    "director_3d_stage_plan",
    "stage_get_state",
    "split_novel_script",
    "creator_inspect_runtime",
    "list_custom_nodes",
    "todo_write",
    "ask_user_question",   # 问询无副作用（只读交流）→ 计划模式允许向用户确认需求
    "view_media",
    "job_list", "job_status",
    "task_status",
    "subagent_list", "subagent_status",
    "onekey_summary",
    "onekey_review",
})

# 工具风险分级：low 查询/规划 / medium 单镜生成 / high 批量·覆盖·花钱 / catastrophic 删源·越界写·危险命令
TOOL_RISK: Dict[str, str] = {
    # 查询规划
    "search_tools": "low", "list_assets": "low", "get_asset": "low",
    "list_image_providers": "low", "list_voice_providers": "low", "list_video_providers": "low",
    "list_voices": "low", "list_comfyui_workflows": "low", "list_custom_providers": "low",
    "get_provider_code": "low", "canvas_query": "low", "canvas_query_assets": "low",
    "fs_read": "low", "read_skill": "low", "view_media": "low",
    "ask_user_question": "low",
    "list_custom_nodes": "low",
    "director_3d_stage_plan": "low", "stage_get_state": "low",
    "split_novel_script": "medium",
    # 素材库：创建/发布是单条资产变更（发布=全局可见，可收回）→ medium，人审由执行维决定
    "create_asset": "medium", "publish_asset": "medium",
    # 分集管理：改的是项目结构（场归属/分集列表），单项目内可逆 → medium
    "episode_manage": "medium",
    # 生成
    "generate_image": "medium", "comfyui_render_node": "medium",
    "generate_voice": "medium", "generate_minimax_voice": "medium",
    "generate_video": "high", "canvas_create_node": "medium",
    "canvas_update_node": "medium", "canvas_connect": "medium",
    "canvas_execute": "high", "canvas_dispatch_skill": "high",
    # 3D导演台控制（落盘 + 前端实时应用；单镜舞台变更，非破坏性）
    "stage_control": "medium",
    "stage_export_clay": "medium",
    # 删节点不可逆（连带删线），且会打断已有链路 → 与 canvas_execute 同档。
    # 是否人审由执行维决定（审批=确认，自动=直跑），plan 模式无此工具（只读白名单外）。
    "canvas_delete_node": "high",
    "export_jianyin_draft": "medium",
    "export_timeline_mp4": "medium",
    # 能力变更（Creator 提案链，默认走人审）
    "register_custom_provider": "high", "update_custom_provider": "high",
    "delete_custom_provider": "catastrophic", "test_custom_provider": "low",
    "provider_key_status": "low", "migrate_provider_inline_key": "medium",
    "creator_inspect_runtime": "low", "creator_propose_capability": "medium",
    "creator_start_test": "medium", "creator_finalize": "high",
    "creator_propose_change_set": "medium", "creator_test_change_set": "medium",
    "creator_apply_change_set": "high", "creator_rollback_change_set": "high",
    "request_mode_switch": "medium",
    # 可信双工�?
    "fs_file": "high", "shell_exec": "high",
    # 子代理集群 / 一键成片原子工具
    "subagent_run": "medium", "subagent_list": "low", "subagent_status": "low",
    "subagent_cancel": "medium", "subagent_steer": "low",
    "onekey_split": "medium", "onekey_style_lock": "low", "onekey_scene_image": "medium", "onekey_role_image": "medium", "onekey_shot_image": "medium",
    "onekey_shot_video": "high", "onekey_shot_voice": "medium", "onekey_export": "medium",
    "onekey_summary": "low", "onekey_review": "low",
}

CATASTROPHIC_TOOLS = {"delete_custom_provider"}

# 创造模式下必须人审的能力变更类工具（Start/Persist 才是真门；propose 本身不生效）
CREATE_REVIEW_TOOLS = frozenset({
    "creator_start_test", "creator_finalize",
    "register_custom_provider", "update_custom_provider",
})

MODE_BUDGETS: Dict[str, Dict[str, Any]] = {
    "plan": {"max_steps": 60, "deadline_s": 1200, "auto_confirm": True, "readonly": True},
    "auto": {"max_steps": 200, "deadline_s": 1200, "auto_confirm": True, "still_confirm": []},
    "create": {"max_steps": 120, "deadline_s": 1200, "auto_confirm": True, "still_confirm": []},
}

_ALIASES = {
    "supervisor": "auto", "approval": "auto", "ask": "auto",
    "standard": "auto", "normal": "auto", "default": "auto",
    "approve": "auto", "automation": "auto", "automatic": "auto",
    "never": "auto", "yolo": "auto",
    "creator": "create", "creation": "create", "creative": "create",
    "create-auto": "create", "create+auto": "create", "create:auto": "create",
    "createauto": "create", "creator_auto": "create", "auto_create": "create",
    "create_auto": "create",
    "plan": "plan", "planning": "plan", "plan_mode": "plan", "readonly": "plan",
    "plan-auto": "plan", "plan+auto": "plan", "plan:auto": "plan",
    "planauto": "plan", "auto_plan": "plan", "plan_auto": "plan",
}


def normalize_run_mode(m: Optional[str]) -> str:
    s = (m or "auto").strip().lower()
    s = _ALIASES.get(s, s)
    return s if s in RUN_MODES else "auto"


def behavior_of(run_mode: Optional[str]) -> str:
    return normalize_run_mode(run_mode)


def execution_of(run_mode: Optional[str]) -> str:
    return "auto" if normalize_run_mode(run_mode) in ("auto", "create") else "approve"


def compose_run_mode(behavior: Optional[str], execution: Optional[str] = None) -> str:
    b = str(behavior or "auto").strip().lower()
    if b in ("plan", "planning", "readonly", "plan_auto"):
        return "plan"
    if b in ("create", "creator", "creation", "creative", "create_auto"):
        return "create"
    return "auto"


def _provider_kind(tool_name: str) -> str:
    """``provider_<id>`` → image / video / audio；解析不出来返回空串。

    两条取值路径，都失败就返回空串（调用方回落到 medium，宁可保守分级也不误升）：
    1. 注册时写进 description 的 ``[Provider:video]`` 前缀 —— 最便宜，不依赖注册表初始化；
    2. 回落逐个注册表 ``list_ids()`` 反查 —— 覆盖 description 未带前缀的兜底定义。
    """
    pid = tool_name[len("provider_"):] if tool_name.startswith("provider_") else ""
    if not pid:
        return ""
    try:
        from app.agent.tools.registry import tool_view
        t = tool_view.get(tool_name)
        desc = str(getattr(t, "description", "") or "")
        if desc.startswith("[Provider:"):
            kind = desc[len("[Provider:"):].split("]", 1)[0].strip().lower()
            if kind in ("image", "video", "audio"):
                return kind
    except Exception:
        pass
    try:
        from app.providers.image.registry import image_registry
        from app.providers.video.registry import video_registry
        from app.providers.audio.registry import audio_registry
        for kind, reg in (("image", image_registry), ("video", video_registry), ("audio", audio_registry)):
            if pid in (reg.list_ids() or []):
                return kind
    except Exception:
        pass
    return ""


def tool_risk(tool_name: str) -> str:
    if not tool_name:
        return "low"
    # 显式表优先：provider_key_status 等复用 provider_ 前缀的内置管理工具按表定级
    if tool_name in TOOL_RISK:
        return TOOL_RISK[tool_name]
    if tool_name.startswith("provider_"):
        # provider_* 动态源按 kind 分流：视频源单次耗时可达 20 分钟且按次/秒计费 → high；
        # 图片/音频单条生成 → medium。kind 解析不出来时保守留 medium。
        return "high" if _provider_kind(tool_name) == "video" else "medium"
    if tool_name.startswith("customnode_"):
        return "medium"
    if tool_name.startswith("plugin_"):
        return "high"
    return "medium"


def requires_confirm(tool_name: str, run_mode: str, has_interactive_channel: bool = True,
                     policy: Optional[Dict[str, Any]] = None,
                     args: Optional[Dict[str, Any]] = None) -> bool:
    """项目策略裁决：allow 不弹，ask 弹，deny 也返回 True（由执行口给出明确拒绝）。"""
    from app.agent.policy import normalize_mode, permission_decision
    if normalize_mode(run_mode) == "plan":
        return False
    decision = permission_decision(tool_name, args or {}, run_mode, policy)
    if decision == "allow":
        return False
    # ask / deny 都返回 True；deny 的具体拒绝由执行口给出
    return True
