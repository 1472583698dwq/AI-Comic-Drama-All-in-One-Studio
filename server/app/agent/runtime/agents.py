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
    "list_comfyui_workflows", "list_custom_providers", "get_provider_code",
    "fs_read", "read_skill", "director_3d_stage_plan", "todo_write",
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
    name="character_designer",
    description="角色定妆：为单个角色生成三视图正面定妆图并写回草稿（一键成片 Stage2）。输入 draft_id 与角色名。",
    system_prompt=(
        "你是角色美术子代理，负责单角色定妆：调用 onekey_role_image(draft_id, character=角色名)，"
        "返回 image_url 与是否成功。一次只处理一个角色。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_role_image", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="storyboard_artist",
    description="分镜画师：为单个分镜生成画面（角色参考+运镜），写回草稿（一键成片 Stage3）。输入 draft_id 与 shot_index。",
    system_prompt=(
        "你是分镜画师子代理：调用 onekey_shot_image(draft_id, shot_index=镜号) 生成画面并返回 image_url。"
        "一次只处理一个镜头；失败时可用 onekey_summary 查看该镜状态后重试一次。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_shot_image", "onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="video_operator",
    description="动态影像师：为有画面的分镜做图生视频（一键成片 Stage4，长耗时默认后台提交；需要阻塞等待时显式 background=false，或用 subagent_wait 在关键节点收口）。输入 draft_id 与 shot_index。",
    system_prompt=(
        "你是动态影像子代理：调用 onekey_shot_video(draft_id, shot_index=镜号)。"
        "若返回 task_id（异步任务）说明已提交，无需等待；若返回 video_url 即已完成。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_shot_video", "onekey_summary", "task_status", "task_wait", "todo_write"],
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
    description="质检员（只读）：检查草稿各镜产物完整性/失败项，给出需要重做的镜头清单。输入 draft_id。",
    system_prompt=(
        "你是质检子代理（只读）：调用 onekey_summary(draft_id) 汇总产物完整性，"
        "输出：缺失/失败的镜头号清单 + 每项一句话原因（没有缺失就明确说全部通过）。\n"
        f"{_COMMON_RULES}"
    ),
    allow_tools=["onekey_summary"] + _READ,
    max_steps=20,
))

_add(AgentProfile(
    name="director",
    description="总导演（编排者）：制定计划、并行委派专家、汇总交付。一键成片 Agent 模式的主会话角色。",
    system_prompt=(
        "你是 AI 漫剧总导演（编排者），通过全局 Goal 驱动整片制作。\n"
        "团队与工具：用 subagent_run 把同质批量任务并行委派给最合适的专家角色；"
        "用 subagent_list/status/cancel/steer 管理子代理；用 todo_write 跟踪阶段进度。\n"
        "规则：\n"
        "1. 每个子任务描述必须自包含（带上 draft_id、镜头号、角色名等全部上下文）；\n"
        "2. 同步/异步混用：需要结果才能继续的阶段（拆解/生图/配音/导出）用同步阻塞委派；"
        "长耗时且独立的（视频）用 background=true 提交后继续推进，关键节点用 subagent_wait 阻塞收口；\n"
        "3. 阶段顺序：拆解→角色定妆→逐镜生图→图生视频→配音→导出；每阶段完成后再进入下一阶段；\n"
        "4. 单个子任务失败不阻塞全片：记录失败项，继续推进其余部分，最终在总结里说明；\n"
        "5. 最后用中文输出制作总结（角色/分镜/成图/成片/配音/导出数量与待补项）。"
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
