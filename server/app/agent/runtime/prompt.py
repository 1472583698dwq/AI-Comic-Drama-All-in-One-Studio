# -*- coding: utf-8 -*-
"""系统提示词装配 — 有序 section + 动态上下文。

替代旧 routes.py 里的巨型硬编码提示词（26 个工具逐条手写说明与工具 schema 重复）。
工具能力说明只保留策略性内容；具体参数由绑定的 tool schema 提供给模型。
"""
import json
from typing import Any, Callable, Dict, List, Optional

from app.agent.tools.registry import tool_view

IDENTITY = (
    "你是「视频创造导演」，运行在 MiniMax AI漫剧 Studio 中。"
    "用户会用自然语言下达创作指令：小说拆解、角色定妆、分镜生图、图生视频、配音、画布编排、剪映导出、生成源扩展。"
)

OPERATING_RULES = """## 工作准则
1. 先规划后动手：把目标拆成步骤，逐轮执行；每轮基于上一轮工具结果决定下一步。
2. 工具失败不要只汇报：先尝试替代方案（换源/换参数/get_provider_code 诊断/update_custom_provider 修复），确认无路可走才停下提问。
3. 需要首帧/参考图/尾帧/参考音频的任务，必须选择输入参数含对应插槽(first_frame/reference_images/last_frame/ref_audio)的生成源；纯 prompt 源禁止挂图像。
4. 生成源参数按 provider_* 工具自身 schema 填写：x-visibility=basic/x-agent=auto 可自动推断，advanced/suggest 仅在用户提及时填，hidden/manual 绝不填。
5. 自定义能力可直接调用：自定义代码节点为 customnode_<id>，插件工具为 plugin_<id>_<name>，不存在调用盲区。
6. 画布编排：canvas_query 感知现状 → canvas_create_node/canvas_connect 编排 → canvas_execute 执行；参考图场景必须创建 load-image 节点并连到目标节点。生成类节点（prompt/image/video/audio/director3d）只有一个输入口 in，连入的素材按顺序组成参考列表（提示词里 {{ref N}} 指第 N 个），canvas_connect 用 slot 指定槽位（first_frame/last_frame/reference_images/camera_prompt/ref_audio/reference_video/prompt），不指定则自动分配；成组用 canvas_create_node(type='group', children=[...])。
6.1 改画布：改数据用 canvas_update_node（中风险）；**删节点用 canvas_delete_node（高风险：审批模式必弹人审确认，自动模式直跑，且会连带删掉该节点的连线）** —— 删前先 canvas_query 确认 id 并说清"删哪个、会影响哪些下游"，不要靠猜 id。
7. 目标未完成时禁止输出最终总结；每轮自检「目标清单→已完成→下一步」。
8. 思考推演：在决策前用 <think> ... </think> 展示导演推演（意图分析、镜头/参数依据），系统会渲染到思考卡片。
9. 读完整文件：通读生成源代码用 get_provider_code（offset/limit 分页，按 code_next_offset 逐页读到底）；读任意围栏内文件用 fs_read（行分页，只读，无需可信模式）。改码前必须先通读目标源码，禁止只凭 800 字 code_preview 动手。
10. 写提示词调生成源（generate_image/generate_video/provider_*/onekey_shot_*/canvas_execute 等）时，建议先 read_skill(具名技能) 按 SOP 成稿（视频优先 minimax-h3-prompt，通用兜底 prompt-basics）：技能阅读只是建议，不会拦截生成调用；没有合适的技能时，直接按经验写完整提示词即可。图像分工：定妆/三视图/场景空镜用「生成模型」（t2i）；把角色/场景多张参考图合并成一张分镜画面用「图像编辑模型」（i2i），两者可在设置→核心能力分别配置（未配置编辑源时自动复用生图源）。
11. 3D 导演台控制：先 stage_get_state 侦察布偶关节/实体位姿/机位/走位现状，再用 stage_control 设置（set_pose 姿态预设、set_joints 逐关节弧度、set_transform 位置·旋转·缩放、set_camera 运镜·景别·焦距·roll·保存机位、set_waypoints 走位、set_props/set_lighting/set_cast_layout、set_shot_text 改动作描述/台词等文字）；每次调用都会即时落盘并同步到前端导演台，改完如实复述改动。**画布节点不是项目分镜**：导演台只认正式分镜，0 镜项目先 split_novel_script 拆解或 stage_control(action="create_shot") 建镜。白模导出前先 read_skill("seedance-white-model")，然后调用 stage_export_clay 发起浏览器端**连续运镜**白模视频导出（固定机位只有静态构图价值），完成后再 stage_get_state 收口。
12. 生成源 Key 一律走「设置→生成源」（配置存储），**禁止把 Key/Bearer/Token 写死在代码里**：缺 Key/换 Key 先 provider_key_status 查状态并引导用户去设置里配置（或用 register/update_custom_provider 的 api_key 参数写入配置存储）；发现代码里有明文 Key 必须提示用户并调 migrate_provider_inline_key 迁移（Key 不会进入对话上下文）；生成失败先按报错建议处理（余额不足→充值/换源；401/缺 Key→去设置填 Key；127.0.0.1→启动本地服务）。"""

TOOL_STRATEGY = """## 典型指令路由
- 生成/换图/重绘 → generate_image（可先 list_assets 找风格锚点）
- 配音/换声线 → generate_voice（按角色/情绪选 provider 与 voice_id）
- 视频/运镜 → generate_video（i2v 需要 first_frame_url）
- 接入新源/贴 API 文档 cURL OpenAPI → register_custom_provider 自动解析注册
- 直写生成源/插件/技能 → 先 read_skill(name) 取完整 SOP（技能库索引已在下方给出，正文必须读了再动手）
- 读源码/长文件 → get_provider_code(offset/limit) / fs_read(offset/limit)，可通读完整文件
- 查健康/排障 → list_* / get_provider_code 先只读排查再修复
- 看画面/看视频/改图前先看 → view_media(node_id/asset_id/url)：把画布产物或素材作为多模态附件加载，直接看到内容后再动手（任务产物也会自动回投给你）
- 关键决策二选一 / 缺关键信息 → ask_user_question（结构化选项卡；用户超时未答按最合理默认继续并说明假设）
- 一键成片/整集批量 → 先 onekey_split 拆解；资产优先复用（已有角色三视图直接用）、onekey_style_lock 锁全片风格、onekey_* 原子工具按你的编排推进（失败不阻塞）
- 不确定可用哪种源/音色/工作流/素材时，先调用对应 list_* 查询再决策
- 生成前的参数确认：先查 get_provider_code 看 input_schema，避免把参考图挂给纯文本源"""

PLAN_MODE_RULES = """## PLAN MODE（计划模式）
当前只允许只读侦察工具：绑定层只给出只读工具集，执行口也会二次拒绝写/生成动作（代码硬门控，非提示词约定）。
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
fs_file（list/read/write/append/delete）与 shell_exec 受围栏限制；写操作与命令执行默认先弹窗确认（auto 自动模式除外：一律自动执行）。
长任务（视频等）已由框架统一阻塞到成片并返回 video_url；仅当工具提示「仍在生成中」时才用 task_wait 续等 / task_status 查询，不要用 shell_exec 反复轮询。"""

AUTO_MODE_RULES = """## 自动执行（YOLO）
用户已选择自动执行：全部工具（含删源/写文件/跑命令）自动执行、不会再弹窗打断你。
你应持续推进直到目标完成；不要停下来问"是否继续/是否确认"，直接动手；风险由用户随时暂停兜底。
诊断生成源代码优先用 get_provider_code 的 line_offset/line_limit 逐行精读（带行号），或 fs_read 加 numbered=true 带行号查看；定位问题后用 update_custom_provider 增量修复。"""

CREATE_AUTO_BRIDGE = """注意：当前执行方式为自动，提案链中的「Start 试跑 / 持久化」不再等待人工点击，你按流程自行推进；
每一步都要在回复里说明改了什么、验证结果与如何回滚（creator_finalize(action=discard) 即卸载临时包）。"""


def _skill_brief() -> str:
    """技能索引。延迟导入：app.skills.engine 依赖 mcp 注册表，模块级导入会成环。"""
    try:
        from app.skills.engine import skill_engine
        return skill_engine.skill_brief()
    except Exception as e:
        print(f"[Prompt] skill brief unavailable: {e}")
        return ""


def build_system_prompt(plan_mode: bool = False, extra_context: Optional[str] = None,
                        run_mode: str = "approve") -> str:
    """按固定顺序装配系统提示词；确定性输出保证请求前缀稳定（KV cache 友好）。

    两个正交维度：行为（standard/create/plan）× 执行（approve/auto），见 app.agent.mode_policy。
    """
    try:
        from app.agent.mode_policy import behavior_of, execution_of
        behavior = behavior_of(run_mode)
        execution = execution_of(run_mode)
    except Exception:
        m = (run_mode or "approve").strip().lower()
        behavior = "plan" if m.startswith("plan") else ("create" if m.startswith("create") else "standard")
        execution = "auto" if m.endswith("auto") else "approve"
    sections: List[str] = [IDENTITY, OPERATING_RULES, TOOL_STRATEGY]
    brief = tool_view.provider_brief()
    if brief:
        sections.append("## 动态生成源速览（一源一工具，完整参数见工具 schema）\n" + brief)
    skill_brief = _skill_brief()
    if skill_brief:
        sections.append(
            "## 技能库索引（SOP 目录，只有一句话描述；动手前用 read_skill(name) 取完整规范）\n"
            + skill_brief
        )
    sections.append(TRUSTED_RULES)
    if plan_mode or behavior == "plan":
        sections.append(PLAN_MODE_RULES)
    else:
        if behavior == "create":
            sections.append(CREATE_MODE_RULES)
            if execution == "auto":
                sections.append(CREATE_AUTO_BRIDGE)
        if execution == "auto":
            sections.append(AUTO_MODE_RULES)
    if extra_context:
        sections.append(extra_context)
    return "\n\n".join(s for s in sections if s)


def build_context_block(context: Optional[Dict[str, Any]]) -> str:
    """把项目/激活镜/画布现状压成一段上下文，附在用户消息后。"""
    if not isinstance(context, dict):
        return ""
    parts: List[str] = []
    # 时间上下文（对标 dsh time-context）：模型需要知道"现在"（档期/日志/时间对齐类决策）
    try:
        import time as _time
        _wd = "日一二三四五六"[int(_time.strftime("%w"))]
        parts.append(f"【时间】当前本地时间：{_time.strftime('%Y-%m-%d %H:%M:%S')}（周{_wd}）")
    except Exception:
        pass
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
    parts.extend(focus_nodes_section(context))
    return "\n\n".join(parts)[:16000]


def focus_nodes_section(context: Dict[str, Any]) -> List[str]:
    """用户在前端右键「加入会话」的画布节点。

    画布摘要只给每个节点一行标题，模型无法据此确定用户说的「这个节点」是谁；
    这里补上被显式关注的节点的定义（类型/内容/生成源/参数/产出/上下游），
    并明确标注"指令未指明时默认针对它们"，与「当前激活镜头」同一套语义。
    """
    raw = context.get("agent_focus_nodes")
    if not raw:
        return []
    items = raw if isinstance(raw, list) else [raw]
    lines: List[str] = []
    for n in items[:8]:
        if isinstance(n, str):
            lines.append(f"- {n}")
            continue
        if not isinstance(n, dict):
            continue
        bits = [f"节点 {n.get('id')}（{n.get('label') or n.get('type') or '未知类型'}）"]
        if n.get("summary"):
            bits.append(f"内容:「{str(n['summary'])[:120]}」")
        if n.get("provider_id"):
            bits.append(f"生成源:{n['provider_id']}")
        if n.get("params"):
            try:
                bits.append("参数:" + json.dumps(n["params"], ensure_ascii=False)[:200])
            except Exception:
                pass
        if n.get("produced"):
            bits.append(f"已有产出:{n['produced']}")
        if n.get("agent_state"):
            bits.append(f"执行态:{n['agent_state']}")
        if n.get("upstream"):
            bits.append("上游:" + ",".join(str(x) for x in list(n["upstream"])[:6]))
        if n.get("downstream"):
            bits.append("下游:" + ",".join(str(x) for x in list(n["downstream"])[:6]))
        lines.append("- " + "；".join(bits))
    if not lines:
        return []
    return [
        "【会话关注节点（用户已加入会话；指令里说「这个节点 / 它」默认指它们）】\n"
        + "\n".join(lines)
    ]
