# -*- coding: utf-8 -*-
"""Agent Profile 注册表 — 子代理角色画像（参考 Claude Code Subagents / Kimi Agent 集群）。

每个 Profile = 系统提示 + 工具子集 + 预算，是子代理"能干什么"的单一来源：
- 绑定层（loop._tool_schemas）裁剪模型可见工具；
- 执行口（pipeline.execute）二次拒绝越权调用——角色约束靠代码，不靠提示词。

编排者（director）通过 team_brief() 了解可用专家团队；
worker profile 的 allow 列表同时包含 onekey_* 原子工具与内部工具。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# 只读侦察工具（各角色通用拼装件）
_READ = [
    "search_tools", "list_assets", "get_asset", "canvas_query", "canvas_query_assets",
    "list_image_providers", "list_video_providers", "list_voice_providers", "list_voices",
    "list_comfyui_workflows", "list_custom_providers", "get_provider_code", "provider_key_status",
    "fs_read", "read_skill", "director_3d_stage_plan", "stage_get_state", "todo_write",
    "view_media", "onekey_review",
    "job_list", "job_status", "task_status",
]


@dataclass(frozen=True)
class AgentProfile:
    name: str
    description: str                                # whenToUse（给编排者看的委派依据）
    system_prompt: str
    allow_tools: Optional[List[str]] = None         # None = 不裁剪（全部工具）
    deny_tools: List[str] = field(default_factory=list)
    max_steps: int = 40
    background_default: bool = False                # 适合异步长任务的角色默认后台化

    def allows(self, tool: str) -> bool:
        if tool in self.deny_tools:
            return False
        if tool == "read_skill":
            # 只读技能规范：任何角色都可读（生成前的提示词技能门要求各角色自读 SOP，裁剪它会造成死锁）
            return True
        if self.allow_tools is None:
            return True
        return tool in self.allow_tools


_COMMON_RULES = (
    "工作纪律：\n"
    "1. 只做本职范围内的子任务，不要越权（越权工具会直接被拒绝）；\n"
    "2. 失败先自愈：换参数/换源重试一次，仍失败则如实报告错误，不要编造结果；\n"
    "3. 最终只输出结论（产物 URL / 状态 / 错误），不要输出过程流水账。"
)

_BUILTIN: Dict[str, AgentProfile] = {}


def _add(p: AgentProfile) -> None:
    _BUILTIN[p.name] = p


_add(AgentProfile(
    name="generalist",
    description="通用子代理：拥有全部工具，适合未指定角色的自由任务（兼容旧调用）。",
    system_prompt=f"你是通用子代理，独立完成委派任务并只回最终结果。\n{_COMMON_RULES}",
    allow_tools=None,
    max_steps=40,
))

_add(AgentProfile(
    name="screenwriter",
    description="编剧：把小说/梗概拆解为角色与分镜脚本（一键成片 Stage1）。输入 draft_id。",
    system_prompt=(
        "你是漫剧编剧子代理，负责剧本拆解。\n"
        "流程：调用 onekey_split(draft_id) 得到角色与分镜清单；如需可再读源素材补充。\n"
        "输出：角色名列表 + 分镜数 + 每镜一句话概要（≤12 镜时逐镜列出）。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_split", "onekey_summary", "split_novel_script"] + _READ,
    max_steps=30,
))

_add(AgentProfile(
    name="scene_designer",
    description="场景美术：为单个场景生成无人空镜参考图（含关键道具，自动附加全片风格规范）；已有场景参考直接复用。生成后必须 view_media 自查（描述/道具/画风），不合格重做。输入 draft_id 与场景号。",
    system_prompt=(
        "你是场景美术子代理：调用 onekey_scene_image(draft_id, scene_index=场景号) 生成场景参考图。"
        "工具会优先复用已有场景参考（status=reused 即完成）；一次只处理一个场景。\n"
        "生成后**必须自查**：view_media(结果 image_url) 对照场景描述/关键道具/画风；"
        "不一致就改提示词重生成一次（force=true），仍不合格如实报告。"
        "最终输出必须含：URL + verdict=pass/fail + 一句话理由。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_scene_image", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="character_designer",
    description="角色资产：已有三视图/形象直接复用；缺失角色才生成三视图角色表（正面+侧面+3/4，自动附加全片风格规范）。生成后必须 view_media 自查（同人性/设定/画风），不合格重做。输入 draft_id 与角色名。",
    system_prompt=(
        "你是角色美术子代理，负责单角色资产：调用 onekey_role_image(draft_id, character=角色名)。"
        "工具会**优先复用已有资产**（返回 status=reused 即完成，不要重试）；缺失才生成三视图角色表。"
        "一次只处理一个角色。\n"
        "生成后**必须自查**：view_media(结果 image_url) 对照角色设定（性别/年龄/发型/服饰/气质）"
        "与三视图同人性、画风一致性；不一致就重生成一次（force=true 可强制重做），仍不合格如实报告。"
        "最终输出必须含：URL + verdict=pass/fail + 一句话理由。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_role_image", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="storyboard_artist",
    description="分镜画师（可选，仅关键帧模式）：为单个分镜生成关键帧画面（自动装配出场角色多视图参考 + 运镜 + 全片风格规范）。默认流程不用。输入 draft_id 与 shot_index。",
    system_prompt=(
        "你是分镜画师子代理：调用 onekey_shot_image(draft_id, shot_index=镜号) 生成关键帧并返回 image_url。"
        "参考图与风格规范由工具自动装配，**无需**自己拼长 prompt；一次只处理一个镜头；"
        "失败时可用 onekey_summary 查看该镜状态后重试一次。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_shot_image", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="video_operator",
    description="动态影像师：逐镜生成视频——有画面用首帧 i2v，无画面直接用角色/场景资产参考生视频（r2v，自动装配多参考 + 风格规范）；生成后必须 view_media 看视频抽帧自查（动作/运镜/一致性），不合格重做。长耗时默认后台提交；需要阻塞等待时显式 background=false，或用 subagent_wait 在关键节点收口。输入 draft_id 与 shot_index。",
    system_prompt=(
        "你是动态影像子代理：调用 onekey_shot_video(draft_id, shot_index=镜号)。"
        "该镜有画面→首帧+参考；无画面→直接用角色多视图+场景参考生成（r2v）。"
        "参考图与风格规范由工具自动装配。\n"
        "**写/改视频提示词前先 read_skill(\"minimax-h3-prompt\")**（H3 官方三字段结构/对齐行/运镜三维度/参考标签），"
        "然后 read_skill 返回的 references 全文可按需 fs_read；成稿用 prompt_override 传给工具，不要只写一句动作词。\n"
        "**时间码规则**：本项目按场景组织、按镜生成——逐镜（默认）提示词不写任何时间码（不要写\"第1秒/第2秒\"）；"
        "仅当把同一场景的多个节拍合并为一条视频（≤15s）时，才从 Shot 2 起写 `At 00:03.500` 递增切镜时间（Shot 1 不允许带时间码）。\n"
        "**场景一致性规则**：同一场景的所有镜头复用同一场景参考图/同一光线（time_of_day）/同一道具与氛围/同一风格，只改动作与运镜；换场景才换这些锚点。\n"
        "若返回 task_id（异步任务）说明已提交，无需等待；若返回 video_url 即已完成。\n"
        "生成完成后**必须自查**：view_media(视频 URL)（工具自动抽帧成图片）对照分镜动作/运镜/角色一致性；"
        "不合格重生成一次（先说明问题），仍不合格如实报告。"
        "最终输出必须含：video_url + verdict=pass/fail + 一句话理由。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_shot_video", "onekey_summary", "task_status", "task_wait", "todo_write", "view_media", "onekey_review", "fs_read", "read_skill"],
    max_steps=20,
    background_default=True,
))

_add(AgentProfile(
    name="voice_operator",
    description="配音师：为单个分镜的台词/旁白生成配音（一键成片 Stage5）。输入 draft_id 与 shot_index。",
    system_prompt=(
        "你是配音子代理：调用 onekey_shot_voice(draft_id, shot_index=镜号)，返回 audio_url。一次一镜。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_shot_voice", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="editor",
    description="剪辑师：把草稿导出为剪映工程（一键成片 Stage6）。输入 draft_id。",
    system_prompt=(
        "你是剪辑子代理：调用 onekey_export(draft_id) 导出剪映草稿，返回导出路径与状态。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_export", "onekey_summary", "todo_write"],
    max_steps=15,
))

_add(AgentProfile(
    name="qa_reviewer",
    description="质检员：抽检草稿产物（角色表/场景/分镜图/视频）是否符合设定与风格——onekey_review 拿要点、view_media 看图/视频抽帧判定，输出不合格清单。输入 draft_id。",
    system_prompt=(
        "你是质检子代理：对 draft_id 的产物做**抽检**。步骤：\n"
        "1. onekey_summary 看整体进度与缺失项；\n"
        "2. onekey_review(draft_id, scope=\"all\", limit=8) 拿抽检清单（含 requirement/criteria 与参考图）；\n"
        "3. 逐项 view_media(urls=[ref]+refs[:2]) 观看（视频自动抽帧），对照 criteria 判定 pass/fail；\n"
        "4. 输出：通过项数/抽检数 + 不合格清单（条目 id + 一句话原因 + 建议修复动作）。没有不合格就明确说通过。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_summary"] + _READ,
    max_steps=30,
))

_add(AgentProfile(
    name="director",
    description="总导演（编排者）：制定计划、并行委派专家、汇总交付。一键成片 Agent 模式的主会话角色。",
    system_prompt=(
        "你是 AI 漫剧总导演（编排者），对全片负责。**怎么做完全由你决定**：先用 todo_write 写下计划并随时更新，"
        "然后自主调用工具/委派专家（subagent_run 可并行、可后台，subagent_wait 收口）一步步完成。\n"
        "工具与团队成员都是自解释的（工具描述就是说明书）；只按工具实际返回行事，不要编造结果；"
        "委派的子任务要自包含（draft_id、镜号、角色名等上下文带上）。\n"
        "单项失败记录后继续，不阻塞全片；导出前自行核验产物质量（view_media/onekey_review 等按需使用）。\n"
        "目标：把用户给的文本做成可导出的成片（剪映工程），最后用中文给出真实总结（关键决策、数量、失败与待补项）。"
    ),
    allow_tools=None,
    max_steps=200,
))


# ── 外部导演组扩展（storage/agent_profiles/*.json + 插件贡献）────────
# 签名变化时自动重建，实现热更新；外部角色与内置重名须显式 override=true。
_EXTERNAL: Dict[str, AgentProfile] = {}
_EXTERNAL_META: Dict[str, Dict[str, Any]] = {}
_EXTERNAL_ERRORS: List[str] = []
_EXTERNAL_SIG: str = ""


def refresh_external_profiles(force: bool = False) -> None:
    """按 mtime 签名重建外部角色表（签名未变则零成本跳过）。"""
    global _EXTERNAL, _EXTERNAL_META, _EXTERNAL_ERRORS, _EXTERNAL_SIG
    try:
        from app.agent_teams import manager as _mgr
        sig = _mgr.signature()
    except Exception:
        return
    if not force and sig == _EXTERNAL_SIG:
        return
    _EXTERNAL_SIG = sig
    external: Dict[str, AgentProfile] = {}
    meta: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    try:
        specs = _mgr.list_effective_profiles(include_disabled=False)
    except Exception as e:
        _EXTERNAL_ERRORS = [f"外部角色表加载失败: {e}"]
        return
    for spec in specs:
        key = spec.id.strip().lower()
        if key in _BUILTIN and not spec.override:
            errors.append(f"角色 {spec.id} 与内置角色重名（需显式 override=true 才允许替换），已跳过")
            continue
        external[key] = AgentProfile(
            name=key,
            description=spec.description,
            system_prompt=spec.system_prompt,
            allow_tools=list(spec.allow_tools or []),
            deny_tools=list(spec.deny_tools or []),
            max_steps=spec.max_steps,
            background_default=bool(spec.background_default),
        )
        meta[key] = {
            "name": spec.name, "icon": spec.icon, "color": spec.color,
            "source": "external", "override": bool(spec.override and key in _BUILTIN),
        }
    _EXTERNAL, _EXTERNAL_META, _EXTERNAL_ERRORS = external, meta, errors


def external_load_errors() -> List[str]:
    refresh_external_profiles()
    return list(_EXTERNAL_ERRORS)


def builtin_role_names() -> set:
    """内置角色名集合（用于重名冲突检测 / 插件启用告警）。"""
    return set(_BUILTIN.keys())


def get_profile(name: str) -> AgentProfile:
    """取角色画像；未知角色回退 generalist（保持旧调用可用）。"""
    refresh_external_profiles()
    key = (name or "").strip().lower()
    return _EXTERNAL.get(key) or _BUILTIN.get(key) or _BUILTIN["generalist"]


def list_profiles(include_internal: bool = False) -> List[AgentProfile]:
    refresh_external_profiles()
    out = list(_BUILTIN.values())
    for key, prof in _EXTERNAL.items():
        if key in _BUILTIN:
            # override：同位置替换，保持名单顺序稳定
            out = [prof if p.name == key else p for p in out]
        else:
            out.append(prof)
    if not include_internal:
        out = [p for p in out if p.name not in ("generalist", "director")]
    return out


def profile_catalog(include_internal: bool = False) -> List[Dict[str, Any]]:
    """角色目录（含来源/图标/配色），供 API 与前端集群视图使用。"""
    refresh_external_profiles()
    out: List[Dict[str, Any]] = []
    for p in list_profiles(include_internal=include_internal):
        meta = _EXTERNAL_META.get(p.name) or {}
        out.append({
            "id": p.name,
            "name": meta.get("name") or p.name,
            "description": p.description,
            "icon": meta.get("icon") or "",
            "color": meta.get("color") or "",
            "source": meta.get("source") or "builtin",
            "override": bool(meta.get("override")),
            "max_steps": p.max_steps,
            "background_default": bool(p.background_default),
        })
    return out


def team_brief(members: Optional[List[str]] = None) -> str:
    """给编排者的专家团队速览（name — description）。

    members 非空时仅列出该导演组成员，并追加成员约束说明。
    """
    allowed = {str(m).strip().lower() for m in (members or []) if str(m or "").strip()}
    profiles = list_profiles()
    if allowed:
        profiles = [p for p in profiles if p.name in allowed]
    lines = [f"- {p.name} — {p.description}" for p in profiles]
    brief = "可用专家团队（subagent_run.agent 取值）：\n" + "\n".join(lines)
    if allowed:
        brief += f"\n本任务导演组成员约束：只能委派上述成员，其他角色一律不允许。"
    return brief
