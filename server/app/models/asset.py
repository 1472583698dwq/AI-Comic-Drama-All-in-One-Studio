from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import uuid

# 类别枚举：与前端保持一致
ASSET_CATEGORIES = ["character", "scene", "prop", "background", "effect", "ui", "previz", "text", "other"]
ASSET_STATUS = ["draft", "approved", "archived"]

class Asset(BaseModel):
    id: str = Field(default_factory=lambda: f"ast_{uuid.uuid4().hex[:8]}")
    project_id: Optional[str] = None  # 所属项目/集合，None为全局
    scope: str = "project"  # project | global —— 隔离域（owner）
    shared_to: List[str] = Field(default_factory=list)  # 定向共享到哪些项目 id（接收方只读可见）
    # 分级/共享扩展
    origin_project_id: Optional[str] = None  # 出生项目：项目素材=归属项目；发布到全局后用于追溯与收回
    group_path: Optional[str] = None  # 项目内分组路径，如 "角色/主角"（L2 分级）
    published_at: Optional[str] = None  # 发布到全局的时间（撤回后清空）
    name: str
    category: str = "character"  # character | scene | prop | background | effect | ui | other
    subcategory: Optional[str] = None  # 细分，如 character: protagonist/supporting, scene: interior/exterior
    status: str = "approved"  # draft | approved | archived
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    # 视觉与一致性
    visual_prompt: str = ""  # 用于生成/一致性召回
    negative_prompt: Optional[str] = None
    # 文本/提示词素材正文（category=text 时使用；无文件资源也能入库、可拖入画布填充）
    content: str = ""
    style_preset: Optional[str] = None  # donghua_xianxia 等
    # 关联资源
    file_url: Optional[str] = None  # /assets/library/{id}/original.png 或 /storage/...
    thumb_url: Optional[str] = None
    file_path: Optional[str] = None  # 磁盘绝对路径，不暴露给前端
    width: Optional[int] = None
    height: Optional[int] = None
    # 风格锚点与一致性
    style_anchor_id: Optional[str] = None  # 关联的风格锚点资产ID
    lora_trigger: Optional[str] = None  # 触发词
    ip_adapter_refs: List[str] = Field(default_factory=list)  # 参考图资产ID列表
    # 技术元数据
    checkpoint: Optional[str] = None
    seed: Optional[int] = None
    workflow_id: Optional[str] = None
    # 语音（仅character）
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    # 三视图（仅character）
    three_views: Dict[str, str] = Field(default_factory=dict)
    # 来源
    source: str = "upload"  # upload | generate | external | migrate
    extra: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    def touch(self):
        self.updated_at = datetime.now().isoformat()

class AssetCreateRequest(BaseModel):
    name: str
    category: str = "character"
    subcategory: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    visual_prompt: Optional[str] = None
    content: Optional[str] = None
    style_preset: Optional[str] = None
    project_id: Optional[str] = None
    status: Optional[str] = "approved"
    file_url: Optional[str] = None  # 已有URL直接入库
    style_anchor_id: Optional[str] = None
    lora_trigger: Optional[str] = None
    voice_id: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None

class AssetUpdateRequest(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    visual_prompt: Optional[str] = None
    content: Optional[str] = None
    style_preset: Optional[str] = None
    status: Optional[str] = None
    file_url: Optional[str] = None
    thumb_url: Optional[str] = None
    style_anchor_id: Optional[str] = None
    lora_trigger: Optional[str] = None
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    three_views: Optional[Dict[str, str]] = None
    extra: Optional[Dict[str, Any]] = None
