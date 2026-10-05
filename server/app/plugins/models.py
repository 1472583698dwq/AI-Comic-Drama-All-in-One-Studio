# -*- coding: utf-8 -*-
"""
插件系统 Manifest 模型 — 对标 VSCode(package.json contributes) / ComfyUI(manifest.json extensionPoints) / MiniMax SKILL.md

P0支持的 extensionPoints：
- providers: ProviderDefinition JSON（code模式优先），热注册+转MCP Tool
- skills: 含YAML frontmatter的 SKILL.md 目录（通用分支零代码）
- workflows: ComfyUI工作流JSON（P0仅落盘+提示去Infra同步，P1自动单文件sync）

P1预留（声明即校验，执行延后）：mcp_tools / canvas_nodes / director_packs / exporters / themes
"""
from typing import Dict, List, Optional
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
    "id": "my-drama-pack",
    "name": "我的漫剧包",
    "version": "1.0.0",
    "description": "一句话说明这个包带来什么",
    "author": "you",
    "publisher": "you",
    "license": "MIT",
    "dependsOn": {},
    "extensionPoints": {
        "providers": ["providers/*.json"],
        "skills": ["skills/*/SKILL.md"],
        "workflows": ["workflows/*.json"],
        "custom_nodes": ["custom_nodes/*.json"],
        "storyboard_slots": ["slots/*.json"],
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
