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
    # P1预留：声明后仅展示，不执行
    mcp_tools: List[str] = Field(default_factory=list)
    canvas_nodes: List[str] = Field(default_factory=list)
    director_packs: List[str] = Field(default_factory=list)
    exporters: List[str] = Field(default_factory=list)
    themes: List[str] = Field(default_factory=list)


class PluginManifest(BaseModel):
    model_config = {"extra": "forbid"}

    id: str = Field(description="插件唯一ID，小写字母数字中划线，如 my-drama-pack")
    name: str = Field(description="展示名")
    version: str = Field(description="semver，如 1.0.0")
    description: str = ""
    author: str = ""
    license: str = "MIT"
    min_app_version: Optional[str] = None
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


MANIFEST_TEMPLATE: Dict = {
    "id": "my-drama-pack",
    "name": "我的漫剧包",
    "version": "1.0.0",
    "description": "一句话说明这个包带来什么",
    "author": "you",
    "license": "MIT",
    "extensionPoints": {
        "providers": ["providers/*.json"],
        "skills": ["skills/*/SKILL.md"],
        "workflows": ["workflows/*.json"],
    },
}

# P1扩展点说明（给插件作者看，不参与P0执行）
EXTENSION_POINTS_DOC: Dict[str, str] = {
    "providers": "P0可用：ProviderDefinition JSON（推荐code模式python/javascript），启用后热注册并自动转为 provider_* MCP Tool + 画布可选源",
    "skills": "P0可用：SKILL.md目录（含name/description/tools frontmatter），通用技能零代码生效，编排技能需P1",
    "workflows": "P0半可用：ComfyUI工作流JSON落盘到storage/workflows，启用后需到Infra页手动同步（P1自动单文件sync）",
    "mcp_tools": "P1：在插件内声明新增MCP工具（python函数+schema），走trusted闸门执行",
    "canvas_nodes": "P1：声明新画布节点类型（NodeSpec+组件），需前端贡献点注册",
    "director_packs": "P1：导演台扩展包（预设/环境/道具/GLB），复用directorPresets同源机制",
    "exporters": "P1：新导出目标（CapCut/FFmpeg/MP4），复用ExportModal装配",
    "themes": "P1：主题变量包",
}
