# -*- coding: utf-8 -*-
"""统一扩展模型：全局唯一的 Extension 身份 + 状态。

身份规则（去重核心）：
- Extension 全局 id = ``kind:local_id``（如 ``provider:kling``），跨 kind 永不碰撞；
- local_id 保持各管家原 id（不改名、不 breaking 存量引用与 MCP tool 名）。
"""
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class ExtensionKind:
    PROVIDER = "provider"
    SKILL = "skill"
    WORKFLOW = "workflow"
    CUSTOM_NODE = "custom_node"
    PLUGIN = "plugin"
    MCP_TOOL = "mcp_tool"
    STORYBOARD_SLOT = "storyboard_slot"
    DIRECTOR_PACK = "director_pack"
    EXPORTER = "exporter"
    THEME = "theme"
    CANVAS_NODE = "canvas_node"

    ALL = (
        "provider", "skill", "workflow", "custom_node", "plugin", "mcp_tool",
        "storyboard_slot", "director_pack", "exporter", "theme", "canvas_node",
    )


class ExtensionStatus:
    BUILTIN = "builtin"      # 内置，常驻启用，不可卸载
    ENABLED = "enabled"      # 已启用
    DISABLED = "disabled"    # 已安装但停用
    NOT_SUPPORTED = "not_supported"  # 该 kind 无此操作


class ExtensionSource:
    BUILTIN = "builtin"          # 内置
    STANDALONE = "standalone"    # 裸件（独立创建）
    PLUGIN = "plugin"            # 包内件（source_detail = 插件 id）


KIND_LABELS: Dict[str, str] = {
    "provider": "生成源",
    "skill": "技能",
    "workflow": "工作流",
    "custom_node": "代码节点",
    "plugin": "插件包",
    "mcp_tool": "MCP 工具",
    "storyboard_slot": "分镜槽",
    "director_pack": "导演包",
    "exporter": "导出器",
    "theme": "主题",
    "canvas_node": "画布节点",
}

# 可经统一执行口运行的 kind
EXECUTABLE_KINDS = ("provider", "skill", "custom_node", "mcp_tool")

# 有原生生命周期的 kind：启停/卸载委托各管家（plugin.package / 自定义 provider）
LIFECYCLE_KINDS = ("plugin", "provider")

# 无原生生命周期、经扩展层覆盖层启停的 kind
# （skill/workflow/custom_node/mcp_tool/slot/canvas_node/theme/exporter/director_pack）
OVERLAY_LIFECYCLE_KINDS = (
    "skill", "workflow", "custom_node", "mcp_tool", "storyboard_slot", "canvas_node",
    "theme", "exporter", "director_pack",
)

# 已声明但执行尚未落地的 kind（只读占位，UI 需明确标注；当前为空）
PLACEHOLDER_KINDS = ()


_NON_NAMESPACE_PUBLISHERS = ("", "builtin", "local", "standalone", "system")


def make_ext_id(kind: str, local_id: str, publisher: str = "") -> str:
    """全局唯一 id。

    - 内置 / 裸件（publisher 为 builtin/local/空）：``kind:local_id``
    - 插件来源（有命名空间）：``kind:publisher/local_id``（物理隔离，避免与内置撞名）
    """
    p = str(publisher or "").strip()
    if p and p not in _NON_NAMESPACE_PUBLISHERS:
        return f"{kind}:{p}/{local_id}"
    return f"{kind}:{local_id}"


def split_ext_id(ext_id: str) -> tuple:
    """解析扩展 id → ``(kind, local_id, publisher)``；非本系统 id 返回 ``("", ext_id, "")``。"""
    if ":" in ext_id:
        kind, _, rest = ext_id.partition(":")
        if kind in ExtensionKind.ALL and rest:
            if "/" in rest:
                pub, _, local = rest.partition("/")
                if pub and local:
                    return kind, local, pub
            return kind, rest, ""
    return "", ext_id, ""


def make_qualified_id(kind: str, local_id: str, publisher: str = "") -> str:
    """展示用限定名（与 make_ext_id 一致，语义化别名）。"""
    return make_ext_id(kind, local_id, publisher)


class ExtensionInfo(BaseModel):
    """跨管家统一的扩展描述（只读聚合视图，不含大字段如 code）。"""

    id: str = Field(description="全局唯一 id，格式 kind:local_id")
    kind: str = Field(description="kind，见 ExtensionKind")
    local_id: str = Field(description="各管家原生 id")
    publisher: str = Field(default="", description="命名空间/发布者：builtin 或插件 id 或 local（裸件）")
    name: str = ""
    version: str = ""
    description: str = ""
    icon: str = ""
    source: str = Field(default="standalone", description="builtin/standalone/plugin")
    source_detail: str = Field(default="", description="source=plugin 时为插件 id")
    status: str = Field(default="enabled", description="builtin/enabled/disabled")
    is_configured: Optional[bool] = Field(default=None, description="provider 类可用性，无意义时为 None")
    sub_kind: str = Field(default="", description="细分：provider 的 image/video/audio，workflow 的来源等")
    derived_from: str = Field(default="", description="派生关系：如 workflow sync 出的 provider 记源 workflow id")
    detail_hint: str = Field(default="", description="前端详情跳转提示，如 providers/hub")
    depends_on: List[str] = Field(default_factory=list, description="依赖的扩展 id（plugin 包间依赖）")
    placeholder: bool = Field(default=False, description="该 kind 尚无执行实现，仅占位展示")
