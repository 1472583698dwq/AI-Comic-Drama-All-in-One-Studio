# -*- coding: utf-8 -*-
"""系统提示词装配 — 有序 section + 动态上下文。

替代旧 routes.py 里的巨型硬编码提示词（26 个工具逐条手写说明与工具 schema 重复）。
工具能力说明只保留策略性内容；具体参数由绑定的 tool schema 提供给模型。
"""
from typing import Any, Callable, Dict, List, Optional

from app.agent.tools.registry import tool_view

IDENTITY = (
    "你是「AI漫剧导演 Agent」，运行在 MiniMax AI漫剧 Studio 中。"
    "用户会用自然语言下达漫剧制作指令：小说拆解、角色定妆、分镜生图、图生视频、配音、画布编排、剪映导出、生成源扩展。"
)

OPERATING_RULES = """## 工作准则
1. 先规划后动手：把目标拆成步骤，逐轮执行；每轮基于上一轮工具结果决定下一步。
2. 工具失败不要只汇报：先尝试替代方案（换源/换参数/get_provider_code 诊断/update_custom_provider 修复），确认无路可走才停下提问。
3. 需要首帧/参考图/尾帧/参考音频的任务，必须选择输入参数含对应插槽(first_frame/reference_images/last_frame/ref_audio)的生成源；纯 prompt 源禁止挂图像。
4. 生成源参数按 provider_* 工具自身 schema 填写：x-visibility=basic/x-agent=auto 可自动推断，advanced/suggest 仅在用户提及时填，hidden/manual 绝不填。
5. 自定义能力可直接调用：自定义代码节点为 customnode_<id>，插件工具为 plugin_<id>_<name>，不存在调用盲区。
6. 画布编排：canvas_query 感知现状 → canvas_create_node/canvas_connect 编排 → canvas_execute 执行；参考图场景必须创建 load-image 节点并连到目标插槽。
7. 目标未完成时禁止输出最终总结；每轮自检「目标清单→已完成→下一步」。
8. 思考推演：在决策前用 <think> ... </think> 展示导演推演（意图分析、镜头/参数依据），系统会渲染到思考卡片。"""

TOOL_STRATEGY = """## 典型指令路由
- 生成/换图/重绘 → generate_image（可先 list_assets 找风格锚点）
- 配音/换声线 → generate_voice（按角色/情绪选 provider 与 voice_id）
- 视频/运镜 → generate_video（i2v 需要 first_frame_url）
- 接入新源/贴 API 文档 cURL OpenAPI → register_custom_provider 自动解析注册
- 查健康/排障 → list_* / get_provider_code 先只读排查再修复
- 一键成片/整集批量 → 先拆解剧本，再按角色定妆→生图→视频→配音→导出推进
- 不确定可用哪种源/音色/工作流/素材时，先调用对应 list_* 查询再决策
- 生成前的参数确认：先查 get_provider_code 看 input_schema，避免把参考图挂给纯文本源"""

PLAN_MODE_RULES = """## PLAN MODE（计划模式）
当前只允许只读侦察工具，任何生成/写盘/执行/删改调用都会被硬拦截。
请充分侦察（画布/素材/生成源/项目状态），然后输出完整可执行的 markdown 计划：
以 `# 计划：` 开头，含目标、按序步骤（工具+关键参数+预期产出）、风险与注意、验收标准。不要执行任何变更。"""

CREATE_MODE_RULES = """## 创造模式（Creator）
当前是创造模式：当现有能力不足时，先造能力再干活，禁止在能力未生效前声称已完成。典型场景：
- 生成源缺参数插槽（如 first_frame / reference_images 未暴露）
- 需要接入新的图片/视频/音频生成源
- 需要新的 Skill 规范 / 画布模板 / 插件包

标准流程（提案 → 人审 → 试跑 → 持久化，四步不可跳）：
1. `creator_inspect_runtime` 侦察运行时现状（只读）；
2. `creator_propose_capability` 生成临时提案（只写临时文件，不生效）；把提案要点（kind/改动预览/风险/可逆性）简洁转述给用户；
3. 用户点击「Start 试跑」后，才允许调用 `creator_start_test` 做只读/小参试跑；
4. 试跑通过且用户点击「持久化」后，才调用 `creator_finalize(action=persist)` 写入生产；用户选择「丢弃」则 `creator_finalize(action=discard)` 卸载临时包。

约束：
- 用户对提案的反馈（改哪里/不接受）作为新指令继续调整提案，不要直接注册或改生产配置绕过提案；
- 若用户已批准含提案的主计划，不要重复提案；先执行主计划，等待用户对提案卡的操作；
- 提案卡由界面展示给用户，你只负责生成与解释，不要替用户执行 Start/Persist。"""

TRUSTED_RULES = """## 可信模式（仅 STUDIO_TRUSTED_MODE=1 时生效）
fs_file（list/read/write/append/delete）与 shell_exec 受围栏限制，写操作与命令执行会先弹窗确认。
长任务（视频等）已由框架统一阻塞到成片并返回 video_url；仅当工具提示「仍在生成中」时才用 task_wait 续等 / task_status 查询，不要用 shell_exec 反复轮询。"""


def build_system_prompt(plan_mode: bool = False, extra_context: Optional[str] = None,
                        run_mode: str = "approve") -> str:
    """按固定顺序装配系统提示词；确定性输出保证请求前缀稳定（KV cache 友好）。"""
    mode = (run_mode or "approve").strip().lower()
    sections: List[str] = [IDENTITY, OPERATING_RULES, TOOL_STRATEGY]
    brief = tool_view.provider_brief()
    if brief:
        sections.append("## 动态生成源速览（一源一工具，完整参数见工具 schema）\n" + brief)
    sections.append(TRUSTED_RULES)
    if plan_mode or mode == "plan":
        sections.append(PLAN_MODE_RULES)
    elif mode == "create":
        sections.append(CREATE_MODE_RULES)
    if extra_context:
        sections.append(extra_context)
    return "\n\n".join(s for s in sections if s)


def build_context_block(context: Optional[Dict[str, Any]]) -> str:
    """把项目/激活镜/画布现状压成一段上下文，附在用户消息后。"""
    if not isinstance(context, dict):
        return ""
    parts: List[str] = []
    project = context.get("project") or {}
    if project:
        scenes = project.get("scenes") or []
        shots = [s for sc in scenes for s in (sc.get("shots") or [])]
        parts.append(
            f"【当前项目】{project.get('title', '')} (id={project.get('id', '')}) | "
            f"风格:{project.get('style_preset', '')} 画幅:{project.get('aspect_ratio', '')} | "
            f"{len(scenes)}场/{len(shots)}镜"
        )
        chars = project.get("characters") or []
        if chars:
            lines = []
            for c in chars[:20]:
                lines.append(f"- {c.get('name', '?')}（{c.get('gender', '')}/{c.get('role', '')}）音色:{c.get('voice_name') or c.get('voice_id') or '未选'}")
            parts.append("【角色表】\n" + "\n".join(lines))
        shot_lines = []
        for sc in scenes[:30]:
            for s in (sc.get("shots") or []):
                media = "".join([
                    "图" if s.get("image_url") else "",
                    "视" if s.get("video_url") else "",
                    "音" if s.get("audio_url") else "",
                ]) or "无"
                shot_lines.append(
                    f"#{s.get('shot_index', '?')} {s.get('camera_framing', '')}/{s.get('camera_motion', '')} "
                    f"情绪:{s.get('emotion', '')} 台词:{(s.get('dialogue') or '')[:30]} "
                    f"动作:{(s.get('action_desc') or '')[:40]} 已生成:{media}"
                )
        if shot_lines:
            parts.append("【分镜清单】\n" + "\n".join(shot_lines[:150]))
    active = context.get("active_shot")
    if active:
        kv = [
            ("镜头号", active.get("shot_index")),
            ("动作描述", active.get("action_desc")),
            ("台词", active.get("dialogue")),
            ("景别", active.get("camera_framing")),
            ("运镜", active.get("camera_motion")),
            ("图像提示词", active.get("image_prompt")),
        ]
        lines = [f"  {k}: {v}" for k, v in kv if v not in (None, "")]
        if lines:
            parts.append("【当前激活镜头（指令未指明时默认针对它）】\n" + "\n".join(lines))
    cs = context.get("canvas_summary")
    if cs:
        parts.append(f"【画布状态】{str(cs)[:800]}")
    return "\n\n".join(parts)[:16000]
