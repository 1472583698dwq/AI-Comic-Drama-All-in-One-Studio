# -*- coding: utf-8 -*-
"""
三运行模式策略 — 参考 DeepSeek Harness：
  approve(审批/ask) / auto(自动/never+预算笼头) / create(创造/Standard+运行时检查+内存实验)

- approve：默认。变异动作先审后干，Plan 必确认。映射 DSH workspace-write + ask。
- auto：全环自跑，画布验收。低/中风险直跑+Undo，高/灾难仍需确认。映射 danger-full-access + never，但加预算/收据笼头。
- create：缺能力先造能力。提案默认临时，人来 Start，关停即卸载。映射 Creator mode。

fail-closed：无 answerer（HTTP/SSE 无交互通道）时 ask 一律按拒绝处理。
"""
from typing import Any, Dict, Optional

RUN_MODES = ("approve", "auto", "create", "plan")

# 工具风险分级：low 查询/规划 / medium 单镜生成 / high 批量·覆盖·花钱 / catastrophic 删源·越界写·危险命令
TOOL_RISK: Dict[str, str] = {
    # 查询规划
    "search_tools": "low", "list_assets": "low", "get_asset": "low",
    "list_image_providers": "low", "list_voice_providers": "low", "list_video_providers": "low",
    "list_voices": "low", "list_comfyui_workflows": "low", "list_custom_providers": "low",
    "get_provider_code": "low", "canvas_query": "low", "canvas_query_assets": "low",
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
}

CATASTROPHIC_TOOLS = {"delete_custom_provider"}

MODE_BUDGETS: Dict[str, Dict[str, Any]] = {
    # max_steps 仅用于计划展示与死循环兜底（引擎默认 200，可用 AGENT_MAX_ITERATIONS 覆盖）
    "approve": {"max_steps": 100, "deadline_s": 1200, "auto_confirm": False},
    "auto": {"max_steps": 200, "deadline_s": 1200, "auto_confirm": True, "still_confirm": ["high", "catastrophic"]},
    "create": {"max_steps": 120, "deadline_s": 1200, "auto_confirm": False},
    # 计划模式：只读侦察 + 产出计划，不执行任何变更（工具由引擎绑定层硬门控）
    "plan": {"max_steps": 60, "deadline_s": 1200, "auto_confirm": True, "readonly": True},
}


def normalize_run_mode(m: Optional[str]) -> str:
    s = (m or "approve").strip().lower()
    # 兼容旧值：supervisor->approve, automation->auto, creator/create
    alias = {"supervisor": "approve", "approval": "approve", "ask": "approve",
             "automation": "auto", "automatic": "auto", "never": "auto",
             "creator": "create", "creation": "create", "creative": "create",
             "plan": "plan", "planning": "plan", "plan_mode": "plan"}
    s = alias.get(s, s)
    return s if s in RUN_MODES else "approve"


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
    """该工具在该模式下是否需要人审。fail-closed：无交互通道时 ask 视为需要确认（调用方应直接拒绝/排队）。"""
    mode = normalize_run_mode(run_mode)
    if mode == "plan":
        # 计划模式只绑定只读工具，无需逐工具审批
        return False
    # 能力提案本身不生效（仅写临时文件，可 discard）；Start/Persist 才是人审门
    if tool_name == "creator_propose_capability":
        return False
    risk = tool_risk(tool_name)
    if tool_name in CATASTROPHIC_TOOLS:
        return True
    if mode == "approve":
        # 审批模式：medium 以上全部确认；low 直跑
        return risk in ("medium", "high", "catastrophic")
    if mode == "auto":
        # 自动模式：仅 high/灾难确认，中低直跑+Undo
        return risk in ("high", "catastrophic")
    if mode == "create":
        # 创造模式：能力变更类必须人来 Start；普通生成沿用审批口径
        if tool_name in ("creator_propose_capability", "creator_start_test", "creator_finalize",
                         "register_custom_provider", "update_custom_provider"):
            return True
        return risk in ("medium", "high", "catastrophic")
    return True


def apply_to_plan(plan: Dict[str, Any], run_mode: str) -> Dict[str, Any]:
    """按模式重算 Plan 的 needs_confirm（不改步骤本身）。"""
    mode = normalize_run_mode(run_mode)
    steps = plan.get("steps") or []
    if not steps:
        plan["needs_confirm"] = False
        plan["run_mode"] = mode
        return plan
    if mode == "auto":
        # 自动：仅当含 high/灾难步骤才拦一下（给 3s 反悔），否则直跑
        has_high = any(tool_risk(s.get("tool", "")) in ("high", "catastrophic") for s in steps)
        plan["needs_confirm"] = bool(has_high)
        plan["autonomy_hint"] = "自动" if not has_high else "自动·高风险步需确认"
    elif mode == "plan":
        # 计划模式：运行本身就是规划（只读），无需再确认
        plan["needs_confirm"] = False
        plan["autonomy_hint"] = "规划（只读）"
    elif mode == "create":
        plan["needs_confirm"] = True
        plan["autonomy_hint"] = "创造·提案需Start"
    else:
        plan["needs_confirm"] = len(steps) > 1 or plan.get("risk") in ("medium", "high")
        plan["autonomy_hint"] = plan.get("autonomy_hint") or "审批"
    plan["run_mode"] = mode
    plan["budget"] = MODE_BUDGETS.get(mode, {})
    return plan
