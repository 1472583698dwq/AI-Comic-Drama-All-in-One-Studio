# -*- coding: utf-8 -*-
"""
插件系统 Manifest 模型 — 对标 VSCode(package.json contributes) / ComfyUI(manifest.json extensionPoints) / MiniMax SKILL.md

P0支持的 extensionPoints：
- providers: ProviderDefinition JSON（code模式优先），热注册+转MCP Tool
- skills: 含YAML frontmatter的 SKILL.md 目录（通用分支零代码）
- workflows: ComfyUI工作流JSON（P0仅落盘+提示去Infra同步，P1自动单文件sync）

P1预留（声明即校验，执行延后）：mcp_tools / canvas_nodes / director_packs / exporters / themes
"""
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class PluginExtensionPoints(BaseModel):
    providers: List[str] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    workflows: List[str] = Field(default_factory=list)
    custom_nodes: List[str] = Field(default_factory=list)
    # 统一扩展注册表新增 kind（P1 起可声明，执行随各槽宿主落地）
    storyboard_slots: List[str] = Field(default_factory=list)
    # P1预留：声明后仅展示，不执行
    mcp_tools: List[str] = Field(default_factory=list)
    canvas_nodes: List[str] = Field(default_factory=list)
    director_packs: List[str] = Field(default_factory=list)
    exporters: List[str] = Field(default_factory=list)
    themes: List[str] = Field(default_factory=list)
    agent_profiles: List[str] = Field(default_factory=list)
    agent_teams: List[str] = Field(default_factory=list)


V2_GROUPS = {
    "capability": {
        "providers": "providers",
        "workflows": "workflows",
        "tools": "mcp_tools",
    },
    "canvas": {
        "nodes": "canvas_nodes",
        "codeNodes": "custom_nodes",
    },
    "workspace": {
        "slots": "storyboard_slots",
        "themes": "themes",
        "exporters": "exporters",
        "directorPacks": "director_packs",
    },
    "agent": {
        "skills": "skills",
        "profiles": "agent_profiles",
        "teams": "agent_teams",
    },
}


V2_DOMAINS = {
    "capability": {
        "label": "能力",
        "description": "生成源、ComfyUI 工作流、MCP 工具：扩展系统能做什么。",
        "fields": {
            "providers": "生成源",
            "workflows": "工作流",
            "tools": "MCP 工具",
        },
    },
    "canvas": {
        "label": "画布",
        "description": "声明式节点与代码节点：扩展画布上能拖什么、连什么。",
        "fields": {
            "nodes": "画布节点",
            "codeNodes": "代码节点",
        },
    },
    "workspace": {
        "label": "工作台",
        "description": "分镜槽、主题、导出器、导演包：扩展创作工作台。",
        "fields": {
            "slots": "分镜槽",
            "themes": "主题",
            "exporters": "导出器",
            "directorPacks": "导演包",
        },
    },
    "agent": {
        "label": "智能体",
        "description": "技能、角色画像、导演组：扩展 AI 导演团队。",
        "fields": {
            "skills": "技能",
            "profiles": "角色",
            "teams": "导演组",
        },
    },
}

DOMAIN_ORDER = ("capability", "canvas", "workspace", "agent")

# 内部 extensionPoints 字段 -> v2 四域
FIELD_DOMAIN = {
    "providers": "capability", "workflows": "capability", "mcp_tools": "capability",
    "custom_nodes": "canvas", "canvas_nodes": "canvas",
    "storyboard_slots": "workspace", "themes": "workspace",
    "exporters": "workspace", "director_packs": "workspace",
    "skills": "agent", "agent_profiles": "agent", "agent_teams": "agent",
}

# 统一扩展 kind -> v2 四域（UI 筛选与计数用）
KIND_DOMAIN = {
    "provider": "capability", "workflow": "capability", "mcp_tool": "capability",
    "custom_node": "canvas", "canvas_node": "canvas",
    "storyboard_slot": "workspace", "theme": "workspace",
    "exporter": "workspace", "director_pack": "workspace",
    "skill": "agent", "agent_profile": "agent", "agent_team": "agent",
}


def domains_of(eps: Any, declared: Optional[List[str]] = None) -> List[str]:
    """从 extensionPoints 与显式 domains 推导四域，按固定顺序返回。"""
    found = {str(d) for d in (declared or []) if str(d) in V2_DOMAINS}
    for field, domain in FIELD_DOMAIN.items():
        if getattr(eps, field, None):
            found.add(domain)
    return [d for d in DOMAIN_ORDER if d in found]


def domain_counts(eps: Any) -> Dict[str, int]:
    counts = {d: 0 for d in DOMAIN_ORDER}
    for field, domain in FIELD_DOMAIN.items():
        counts[domain] += len(getattr(eps, field, None) or [])
    return {k: v for k, v in counts.items() if v}


def normalize_manifest_v2(data: Dict) -> Dict:
    """把 v2 的四域 contributes 归一成内部 v1 extensionPoints，保持旧执行器不变。"""
    if not isinstance(data, dict):
        return data
    contributes = data.get("contributes")
    if not isinstance(contributes, dict):
        return data
    eps = dict(data.get("extensionPoints") or {})
    for group, fields in V2_GROUPS.items():
        items = contributes.get(group)
        if not isinstance(items, dict):
            continue
        for key, target in fields.items():
            values = items.get(key)
            if isinstance(values, list):
                eps[target] = [str(v) for v in values if str(v).strip()]
    out = {k: v for k, v in data.items() if k not in ("schema", "contributes")}
    out["extensionPoints"] = eps
    return out


class PluginManifest(BaseModel):
    model_config = {"extra": "forbid"}

    id: str = Field(description="插件唯一ID，小写字母数字中划线，如 my-drama-pack")
    name: str = Field(description="展示名")
    version: str = Field(description="semver，如 1.0.0")
    description: str = ""
    author: str = ""
    publisher: str = Field(default="", description="命名空间/发布者，缺省用 author，再缺省用 id")
    license: str = "MIT"
    min_app_version: Optional[str] = None
    dependsOn: Dict[str, str] = Field(
        default_factory=dict,
        description="依赖的插件 → 版本约束，如 {\"base-pack\": \">=1.0.0\"}；支持 *, =, >, >=, <, <=, ^, ~")
    domains: List[str] = Field(default_factory=list, description="v2 四域声明：capability/canvas/workspace/agent")
    extensionPoints: PluginExtensionPoints = Field(default_factory=PluginExtensionPoints)


class PluginRecord(BaseModel):
    id: str
    version: str = ""
    enabled: bool = False
    installed_at: str = ""
    # enable时落盘的产物追踪（disable时精确回滚）
    installed_files: List[str] = Field(default_factory=list)
    provider_ids: List[str] = Field(default_factory=list)
    skill_names: List[str] = Field(default_factory=list)
    workflow_ids: List[str] = Field(default_factory=list)
    mcp_tools: List[str] = Field(default_factory=list)
    custom_nodes: List[str] = Field(default_factory=list)
    canvas_nodes: List[str] = Field(default_factory=list)
    theme_ids: List[str] = Field(default_factory=list)
    exporter_ids: List[str] = Field(default_factory=list)
    director_pack_ids: List[str] = Field(default_factory=list)
    agent_profile_ids: List[str] = Field(default_factory=list)
    agent_team_ids: List[str] = Field(default_factory=list)


# mcp_tools 查壳文件契约（P1）：每个 .py 须定义 PLUGIN_TOOLS 列表 + 同模块入口函数
# PLUGIN_TOOLS = [{"name": "text_stats", "description": "...",
#                  "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
#                  "entry": "text_stats"}]
# def text_stats(args: dict, ctx: dict) -> dict: return {...}
# 注册名为 plugin_<插件id>_<name>；执行强制走 trusted 总闸 + 20分钟超时 + 结果截断。
MCP_TOOL_NAME_RE = r"^[a-z0-9_]{2,48}$"


MANIFEST_TEMPLATE: Dict = {
    "schema": 2,
    "id": "my-drama-pack",
    "name": "我的漫剧包",
    "version": "1.0.0",
    "description": "一句话说明这个包带来什么",
    "author": "you",
    "publisher": "you",
    "license": "MIT",
    "dependsOn": {},
    "domains": ["workspace"],
    "contributes": {
        "workspace": {
            "themes": ["themes/*.json"],
            "slots": ["slots/*.json"],
        },
    },
}

# 扩展点说明（给插件作者看）
EXTENSION_POINTS_DOC: Dict[str, str] = {
    "providers": "可用：ProviderDefinition JSON（推荐code模式python/javascript），启用后热注册并自动转为 provider_* MCP Tool + 画布可选源",
    "skills": "可用：SKILL.md目录（含name/description/tools frontmatter），通用技能零代码生效，编排技能为高级分支",
    "workflows": "可用：ComfyUI工作流JSON经save_workflow校验入库（含Save格式自动转换）并自动sync为独立生成源",
    "mcp_tools": "可用：在插件内声明新增MCP工具（python查壳函数+schema），注册为 plugin_<id>_<name>，执行强制走trusted总闸",
    "custom_nodes": "可用：代码节点包（input_schema+params_schema+run代码JSON），启用后体检入库并出现在画布工具栏",
    "storyboard_slots": "可用：分镜工作台槽贡献（slot/id/label/order/when JSON），启用后挂载到对应 Slot 宿主",
    "canvas_nodes": "可用：声明式画布节点（inputs/outputs/params_schema + run.extension 指向 provider|skill|custom_node|mcp_tool），启用后出现在画布工具栏，无需前端代码",
    "themes": "可用：CSS 变量主题包（vars: --xxx → 值，mode: all|dark|light），启用后在扩展中心可应用/取消",
    "exporters": "可用：声明式导出器（accepts 载荷 + run.extension），启用后出现在导出中心",
    "director_packs": "可用：导演台扩展包（presets 景别/运镜/姿态/站位 + environments 背景底图 + props GLB），启用后注入 3D 导演台",
    "agent_profiles": "可用：导演组成员角色画像（system_prompt + allow_tools 工具白名单，禁止委派类 subagent_*），启用后成为 subagent_run 可委派角色",
    "agent_teams": "可用：导演组编排包（members 成员名单 + playbook 总导演脚本，支持 {draft_id} 等占位符与 qa_gate 质检门），启用后在一键成片可选",
}
