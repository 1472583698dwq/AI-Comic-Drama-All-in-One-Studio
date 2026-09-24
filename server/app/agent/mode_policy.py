# -*- coding: utf-8 -*-
"""
运行模式策略 — 两个正交维度（行为 × 执行），UI 分开展示、可自由组合：

行为模式 behavior（能干什么，代码硬门控，不靠提示词）：
  - standard 标准：常规工具集，按风险分级放行
  - create   创造：缺能力先造能力（Creator 提案链），能力变更类默认人审
  - plan     计划：只读侦察（绑定层只给只读工具 + 执行口二次拒绝写工具），产出计划

执行方式 execution（要不要逐项人审）：
  - approve 审批：变异动作先审后干（问答式确认）
  - auto    自动：全部工具自动执行、不再逐项弹确认（含删源/可信写/命令）

组合 token（单一 wire/持久化口径）：
  approve = 标准+审批 / auto = 标准+自动 / create = 创造+审批 / create_auto = 创造+自动
  plan = 计划+审批 / plan_auto = 计划+自动（计划只读，两 token 等价，保留仅为 UI 往返）

fail-closed：无 answerer（HTTP/SSE 无交互通道）时 ask 一律按拒绝处理。
"""
from typing import Any, Dict, Optional

RUN_MODES = ("approve", "auto", "create", "create_auto", "plan", "plan_auto")

BEHAVIOR_MODES = ("standard", "create", "plan")
EXECUTION_MODES = ("approve", "auto")

# 计划模式只读白名单（单一来源：绑定层 app.agent.tools.registry 与执行口 pipeline 都从这里取，
# 模型即使想变更也无工具可调、调了也会被拒——模式约束靠代码，不靠提示词）。
PLAN_READONLY_TOOLS = frozenset({
    "search_tools",
    "canvas_query", "canvas_query_assets",
    "list_assets", "get_asset",
    "list_image_providers", "list_video_providers", "list_voice_providers",
    "list_voices", "list_comfyui_workflows", "list_custom_providers",
    "get_provider_code",
    "fs_read", "read_skill",
    "director_3d_stage_plan",
    "split_novel_script",
    "creator_inspect_runtime",
    "list_custom_nodes",
    "todo_write",
    "job_list", "job_status",
    "task_status",
    "subagent_list", "subagent_status",
    "onekey_summary",
})

# 工具风险分级：low 查询/规划 / medium 单镜生成 / high 批量·覆盖·花钱 / catastrophic 删源·越界写·危险命令
TOOL_RISK: Dict[str, str] = {
    # 查询规划
    "search_tools": "low", "list_assets": "low", "get_asset": "low",
    "list_image_providers": "low", "list_voice_providers": "low", "list_video_providers": "low",
    "list_voices": "low", "list_comfyui_workflows": "low", "list_custom_providers": "low",
    "get_provider_code": "low", "canvas_query": "low", "canvas_query_assets": "low",
    "fs_read": "low", "read_skill": "low",
    "director_3d_stage_plan": "low", "split_novel_script": "medium",
    # 生成
    "generate_image": "medium", "comfyui_render_node": "medium",
    "generate_voice": "medium", "generate_minimax_voice": "medium",
    "generate_video": "high", "canvas_create_node": "medium",
    "canvas_update_node": "medium", "canvas_connect": "medium",
    "canvas_execute": "high", "canvas_dispatch_skill": "high",
    "export_jianyin_draft": "medium",
    # 能力变更（Creator 提案链，默认走人审）
    "register_custom_provider": "high", "update_custom_provider": "high",
    "delete_custom_provider": "catastrophic", "test_custom_provider": "low",
    "creator_inspect_runtime": "low", "creator_propose_capability": "medium",
    "creator_start_test": "medium", "creator_finalize": "high",
    # 可信双工具
    "fs_file": "high", "shell_exec": "high",
    # 子代理集群 / 一键成片原子工具
    "subagent_run": "medium", "subagent_list": "low", "subagent_status": "low",
    "subagent_cancel": "medium", "subagent_steer": "low",
    "onekey_split": "medium", "onekey_role_image": "medium", "onekey_shot_image": "medium",
    "onekey_shot_video": "high", "onekey_shot_voice": "medium", "onekey_export": "medium",
    "onekey_summary": "low",
}

CATASTROPHIC_TOOLS = {"delete_custom_provider"}

# 创造模式下必须人审的能力变更类工具（Start/Persist 才是真门；propose 本身不生效）
CREATE_REVIEW_TOOLS = frozenset({
    "creator_start_test", "creator_finalize",
    "register_custom_provider", "update_custom_provider",
})

MODE_BUDGETS: Dict[str, Dict[str, Any]] = {
    # max_steps 仅用于计划展示与死循环兜底（引擎默认 200，可用 AGENT_MAX_ITERATIONS 覆盖）
    "approve": {"max_steps": 100, "deadline_s": 1200, "auto_confirm": False},
    "auto": {"max_steps": 200, "deadline_s": 1200, "auto_confirm": True, "still_confirm": []},
    "create": {"max_steps": 120, "deadline_s": 1200, "auto_confirm": False},
    "create_auto": {"max_steps": 200, "deadline_s": 1200, "auto_confirm": True, "still_confirm": []},
    # 计划模式：只读侦察 + 产出计划，不执行任何变更（工具由引擎绑定层硬门控）
    "plan": {"max_steps": 60, "deadline_s": 1200, "auto_confirm": True, "readonly": True},
    "plan_auto": {"max_steps": 60, "deadline_s": 1200, "auto_confirm": True, "readonly": True},
}

_ALIASES = {
    # 旧值 / 口语值 → 组合 token
    "supervisor": "approve", "approval": "approve", "ask": "approve",
    "standard": "approve", "normal": "approve", "default": "approve",
    "automation": "auto", "automatic": "auto", "never": "auto", "yolo": "auto",
    "creator": "create", "creation": "create", "creative": "create",
    "plan": "plan", "planning": "plan", "plan_mode": "plan", "readonly": "plan",
    "create-auto": "create_auto", "create+auto": "create_auto", "create:auto": "create_auto",
    "createauto": "create_auto", "creator_auto": "create_auto", "auto_create": "create_auto",
    "plan-auto": "plan_auto", "plan+auto": "plan_auto", "plan:auto": "plan_auto",
    "planauto": "plan_auto", "auto_plan": "plan_auto",
}


def normalize_run_mode(m: Optional[str]) -> str:
    s = (m or "approve").strip().lower()
    s = _ALIASES.get(s, s)
    return s if s in RUN_MODES else "approve"


def behavior_of(run_mode: Optional[str]) -> str:
    """从组合 token 取行为维度：standard / create / plan。"""
    m = normalize_run_mode(run_mode)
    if m.startswith("plan"):
        return "plan"
    if m.startswith("create"):
        return "create"
    return "standard"


def execution_of(run_mode: Optional[str]) -> str:
    """从组合 token 取执行维度：approve / auto。"""
    m = normalize_run_mode(run_mode)
    return "auto" if m.endswith("auto") else "approve"


def compose_run_mode(behavior: Optional[str], execution: Optional[str]) -> str:
    """行为 × 执行 → 组合 token（UI 两个选择器的唯一合成口径）。"""
    b = str(behavior or "standard").strip().lower()
    e = str(execution or "approve").strip().lower()
    b = b if b in BEHAVIOR_MODES else "standard"
    e = e if e in EXECUTION_MODES else "approve"
    if b == "plan":
        return "plan_auto" if e == "auto" else "plan"
    if b == "create":
        return "create_auto" if e == "auto" else "create"
    return "auto" if e == "auto" else "approve"


def tool_risk(tool_name: str) -> str:
    if not tool_name:
        return "low"
    if tool_name.startswith("provider_"):
        # provider_* 按 kind 粗分：含 video 视为 high，其余 medium
        return "medium"
    if tool_name.startswith("customnode_"):
        return "medium"
    if tool_name.startswith("plugin_"):
        return "high"
    return TOOL_RISK.get(tool_name, "medium")


def requires_confirm(tool_name: str, run_mode: str, has_interactive_channel: bool = True) -> bool:
    """该工具在该组合模式下是否需要人审。fail-closed：无交互通道时 ask 视为需要确认（调用方应直接拒绝/排队）。"""
    behavior = behavior_of(run_mode)
    execution = execution_of(run_mode)
    if behavior == "plan":
        # 计划模式只绑定只读工具，无需逐工具审批
        return False
    # 能力提案本身不生效（仅写临时文件，可 discard）；Start/Persist 才是人审门
    if tool_name == "creator_propose_capability":
        return False
    if execution == "auto":
        # 自动执行：全部工具自动执行（包括删源/可信写/命令），不再逐项审批。
        # 风险由前端"自动执行"危险态明示 + 随时暂停/Abort 兜底；可信总闸 STUDIO_TRUSTED_MODE 仍独立生效。
        return False
    risk = tool_risk(tool_name)
    if behavior == "create":
        # 创造模式：能力变更类必须人来 Start/持久化；普通生成沿用审批口径
        if tool_name in CREATE_REVIEW_TOOLS:
            return True
    return risk in ("medium", "high", "catastrophic")
