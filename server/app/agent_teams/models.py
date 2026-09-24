# -*- coding: utf-8 -*-
"""导演组声明模型 — 自定义剧组角色（agent_profile）与导演组编排（agent_team）。

agent_profile 示例：
{
  "id": "colorist", "name": "上色师",
  "description": "分镜上色专家：何时委派我（给编排者看的一句话）",
  "icon": "Palette", "color": "pink",
  "system_prompt": "你是上色子代理……",
  "allow_tools": ["onekey_shot_image", "onekey_summary", "fs_read"],
  "deny_tools": [], "max_steps": 30, "background_default": false
}

agent_team 示例：
{
  "id": "fast-short", "name": "快节奏短剧组", "icon": "Zap",
  "members": ["screenwriter", "storyboard_artist", "video_operator", "colorist"],
  "playbook": "执行一键成片任务…\\n1. 调用 onekey_split(draft_id=\"{draft_id}\")…",
  "defaults": {"gen_roles": true, "enable_video": true, "max_images": 12},
  "qa_gate": true
}

安全约束（代码强制，不靠提示词）：
- 外部角色 allow_tools 必须为显式白名单（禁止 None=全工具），且不得出现委派类 subagent_* 工具；
- 工具名必须在当前工具注册表内（注册表不可用时跳过该项校验，加载时再兜底拒绝）；
- 与内置角色重名默认拒绝，需显式 "override": true 才允许替换。
"""
import re
from typing import Any, Dict, List, Optional, Set

from pydantic import BaseModel, Field, field_validator

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")

MAX_PROFILES = 40
MAX_TEAMS = 20
MAX_PROMPT_CHARS = 4000
MAX_PLAYBOOK_CHARS = 8000
MAX_ALLOW_TOOLS = 64
MAX_DENY_TOOLS = 32
MAX_MEMBERS = 24
MAX_STEPS_RANGE = (1, 120)
MAX_TEAM_IMAGES_RANGE = (1, 30)

# 前端角色 chip 支持的图标名（lucide），未知回退 Bot
ICON_WHITELIST = (
    "Bot", "Users", "UserRound", "Palette", "Brush", "PenTool", "Image", "Camera",
    "Film", "Clapperboard", "Video", "Mic", "Music", "AudioLines", "Scissors",
    "Search", "Eye", "Target", "Sparkles", "Wand2", "Zap", "Puzzle", "Megaphone",
    "Gamepad2", "Layout", "Layers",
)

# 前端角色 chip 配色（映射见 swarmMeta.ts）
COLOR_WHITELIST = ("purple", "blue", "green", "pink", "amber", "cyan", "orange", "red", "gray")

# 委派类工具：外部角色一律禁止（防自建编排风暴/无限套娃）
DELEGATE_TOOLS: Set[str] = {
    "subagent_run", "subagent_wait", "subagent_list",
    "subagent_status", "subagent_cancel", "subagent_steer",
}


def known_tool_names() -> Optional[Set[str]]:
    """当前工具注册表可用工具名集合（含内部工具 onekey_*/subagent_* 等）；不可用时返回 None（跳过校验）。"""
    try:
        from app.agent.tools.registry import tool_view
        names = {
            str((s.get("function") or {}).get("name") or "")
            for s in tool_view.schemas()
        }
        names.discard("")
        return names or None
    except Exception:
        return None


def _check_allow_tools(v: List[str]) -> List[str]:
    tools: List[str] = []
    for t in v or []:
        t = str(t or "").strip()
        if t and t not in tools:
            tools.append(t)
    if not tools:
        raise ValueError("allow_tools 不能为空：外部角色必须显式声明工具白名单（不支持全局工具）")
    if len(tools) > MAX_ALLOW_TOOLS:
        raise ValueError(f"allow_tools 数量超限（≤{MAX_ALLOW_TOOLS}）")
    bad = sorted(set(tools) & DELEGATE_TOOLS)
    if bad:
        raise ValueError(f"外部角色禁止委派类工具（防无限嵌套编排）: {','.join(bad)}")
    known = known_tool_names()
    if known is not None:
        unknown = sorted(t for t in tools if t not in known)
        if unknown:
            raise ValueError(f"allow_tools 含未注册工具: {','.join(unknown)}")
    return tools


class AgentProfileSpec(BaseModel):
    model_config = {"extra": "forbid"}

    id: str = Field(description="角色名（即 subagent_run.agent 取值），小写字母数字_-")
    name: str = Field(description="展示名，如 上色师")
    description: str = Field(description="whenToUse：给编排者看的委派依据，一句话")
    icon: str = "Bot"
    color: str = "purple"
    system_prompt: str = Field(description="子代理系统提示词")
    allow_tools: List[str] = Field(default_factory=list, description="显式工具白名单（必填）")
    deny_tools: List[str] = Field(default_factory=list)
    max_steps: int = 40
    background_default: bool = False
    override: bool = Field(default=False, description="与内置角色重名时须显式声明才允许替换")
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"角色 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        v = str(v or "").strip()
        if not v or len(v) > 40:
            raise ValueError("name 必填且 ≤40 字符")
        return v

    @field_validator("description")
    @classmethod
    def _check_desc(cls, v: str) -> str:
        v = str(v or "").strip()
        if not v or len(v) > 500:
            raise ValueError("description 必填（whenToUse）且 ≤500 字符")
        return v

    @field_validator("system_prompt")
    @classmethod
    def _check_prompt(cls, v: str) -> str:
        v = str(v or "").strip()
        if not v or len(v) > MAX_PROMPT_CHARS:
            raise ValueError(f"system_prompt 必填且 ≤{MAX_PROMPT_CHARS} 字符")
        return v

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, v: str) -> str:
        v = str(v or "Bot").strip()
        if v not in ICON_WHITELIST:
            raise ValueError(f"icon 不在支持列表: {v}（支持 {', '.join(ICON_WHITELIST)}）")
        return v

    @field_validator("color")
    @classmethod
    def _check_color(cls, v: str) -> str:
        v = str(v or "purple").strip()
        if v not in COLOR_WHITELIST:
            raise ValueError(f"color 不在支持列表: {v}（支持 {', '.join(COLOR_WHITELIST)}）")
        return v

    @field_validator("allow_tools")
    @classmethod
    def _check_allow(cls, v: List[str]) -> List[str]:
        return _check_allow_tools(v)

    @field_validator("deny_tools")
    @classmethod
    def _check_deny(cls, v: List[str]) -> List[str]:
        tools: List[str] = []
        for t in v or []:
            t = str(t or "").strip()
            if t and t not in tools:
                tools.append(t)
        if len(tools) > MAX_DENY_TOOLS:
            raise ValueError(f"deny_tools 数量超限（≤{MAX_DENY_TOOLS}）")
        return tools

    @field_validator("max_steps")
    @classmethod
    def _check_steps(cls, v: int) -> int:
        lo, hi = MAX_STEPS_RANGE
        v = int(v or 40)
        if not (lo <= v <= hi):
            raise ValueError(f"max_steps 越界（{lo}~{hi}）")
        return v


class AgentTeamDefaults(BaseModel):
    model_config = {"extra": "forbid"}

    gen_roles: Optional[bool] = None
    enable_video: Optional[bool] = None
    max_images: Optional[int] = None

    @field_validator("max_images")
    @classmethod
    def _check_max_images(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return v
        lo, hi = MAX_TEAM_IMAGES_RANGE
        v = int(v)
        if not (lo <= v <= hi):
            raise ValueError(f"defaults.max_images 越界（{lo}~{hi}）")
        return v


class AgentTeamSpec(BaseModel):
    model_config = {"extra": "forbid"}

    id: str = Field(description="导演组 id")
    name: str = Field(description="展示名")
    description: str = ""
    icon: str = "Users"
    color: str = "blue"
    members: List[str] = Field(default_factory=list, description="成员角色 id（内置或自定义画像）")
    playbook: str = Field(default="", description="总导演编排脚本模板，可用 {draft_id}/{title}/{aspect}/{max_images}/{max_videos} 占位符")
    defaults: AgentTeamDefaults = Field(default_factory=AgentTeamDefaults)
    qa_gate: bool = Field(default=False, description="导出前强制委派质检员复核（需 qa_reviewer 在成员内）")
    override: bool = Field(default=False, description="与内置导演组重名时须显式声明才允许替换")
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"导演组 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        v = str(v or "").strip()
        if not v or len(v) > 40:
            raise ValueError("name 必填且 ≤40 字符")
        return v

    @field_validator("description")
    @classmethod
    def _check_desc(cls, v: str) -> str:
        v = str(v or "").strip()
        if len(v) > 500:
            raise ValueError("description ≤500 字符")
        return v

    @field_validator("icon")
    @classmethod
    def _check_icon(cls, v: str) -> str:
        v = str(v or "Users").strip()
        if v not in ICON_WHITELIST:
            raise ValueError(f"icon 不在支持列表: {v}")
        return v

    @field_validator("color")
    @classmethod
    def _check_color(cls, v: str) -> str:
        v = str(v or "blue").strip()
        if v not in COLOR_WHITELIST:
            raise ValueError(f"color 不在支持列表: {v}")
        return v

    @field_validator("members")
    @classmethod
    def _check_members(cls, v: List[str]) -> List[str]:
        out: List[str] = []
        for m in v or []:
            m = str(m or "").strip()
            if not m:
                continue
            if not _ID_RE.match(m):
                raise ValueError(f"成员 id 非法: {m}")
            if m not in out:
                out.append(m)
        if len(out) > MAX_MEMBERS:
            raise ValueError(f"成员数量超限（≤{MAX_MEMBERS}）")
        return out

    @field_validator("playbook")
    @classmethod
    def _check_playbook(cls, v: str) -> str:
        v = str(v or "")
        if len(v) > MAX_PLAYBOOK_CHARS:
            raise ValueError(f"playbook 超长（≤{MAX_PLAYBOOK_CHARS} 字符）")
        return v


MANIFEST_TEMPLATES: Dict[str, Any] = {
    "profile": {
        "id": "my-role",
        "name": "我的角色",
        "description": "何时委派我（给总导演看的一句话）",
        "icon": "Bot",
        "color": "purple",
        "system_prompt": "你是……子代理。只做本职范围内的子任务，最终只输出结论。",
        "allow_tools": ["onekey_summary", "fs_read", "todo_write"],
        "deny_tools": [],
        "max_steps": 30,
        "background_default": False,
    },
    "team": {
        "id": "my-team",
        "name": "我的导演组",
        "description": "一句话说明这组的风格与适用场景",
        "icon": "Users",
        "color": "blue",
        "members": ["screenwriter", "storyboard_artist", "video_operator", "qa_reviewer"],
        "playbook": (
            "执行一键成片任务（自定义导演组）。draft_id={draft_id}；标题：{title}；画幅 {aspect}。\n"
            "严格按阶段推进，同质任务用 subagent_run 的 batch 并行委派；\n"
            "1. 调用 onekey_split(draft_id=\"{draft_id}\") 拆解；\n"
            "2. 用 subagent_run(agent=\"storyboard_artist\", batch=[每镜一项]) 并行生图；\n"
            "3. 用 subagent_run(agent=\"editor\", task=\"导出剪映\") 导出；\n"
            "4. 调用 onekey_summary 核对并输出中文总结。"
        ),
        "defaults": {"gen_roles": True, "enable_video": True, "max_images": 12},
        "qa_gate": True,
    },
    "contract": (
        "角色=自定义专家（工具白名单内生效，禁止递归委派 subagent_*）；"
        "导演组=成员名单 + 总导演编排脚本（playbook 支持 {draft_id}/{title}/{aspect}/{max_images}/{max_videos} 占位符）；"
        "与内置重名需显式 override=true。"
    ),
}
