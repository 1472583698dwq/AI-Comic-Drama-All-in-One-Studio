"""
图片生成 Provider 抽象基类
所有图片生成能力（ComfyUI/SiliconFlow/DashScope/OpenAI兼容）必须实现此接口
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass


@dataclass
class ImageGenerateRequest:
    prompt: str
    negative_prompt: str = ""
    aspect_ratio: str = "9:16"  # 9:16, 16:9, 1:1
    resolution: Optional[str] = None  # 480p/720p/1080p 独立下拉
    style_preset: Optional[str] = None
    seed: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    cfg: Optional[float] = None
    fps: Optional[int] = None
    duration: Optional[int] = None
    workflow_id: Optional[str] = None  # 仅ComfyUI工作流模式使用
    model: Optional[str] = None  # 覆盖默认模型
    reference_images: Optional[List[str]] = None  # 参考图/垫图 URL 列表
    dynamic_inputs: Optional[Dict[str, Any]] = None  # 外部暴露表单动态节点输入 (垫图/额外提示词等)
    extra: Optional[Dict[str, Any]] = None  # 透传扩展参数（独立控件透传）


@dataclass
class ImageGenerateResult:
    image_url: str
    local_path: str
    provider: str
    seed: int
    width: int
    height: int
    elapsed_ms: int
    engine: str
    prompt_id: Optional[str] = None
    checkpoint: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


class ImageProvider(ABC):
    """图片生成提供商抽象"""
    id: str = "base"
    display_name: str = "Base Image Provider"
    description: str = ""
    # 用于前端展示的图标/分类
    icon: str = "Image"
    category: str = "ai_generation"

    @abstractmethod
    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        """生成图片，返回本地落盘结果"""
        ...

    @abstractmethod
    async def check_health(self) -> bool:
        """健康检查"""
        ...

    def is_configured(self) -> bool:
        """是否已配置可用（API Key/服务地址等）"""
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        """返回能力描述，供前端/编排器做参数归一化"""
        return {
            "id": self.id,
            "display_name": self.display_name,
            "description": self.description,
            "supports_workflow": False,
            "supports_negative_prompt": True,
            "supports_seed": True,
            "supports_aspect_ratio": ["9:16", "16:9", "1:1"],
            "is_configured": self.is_configured(),
        }

    async def list_models(self) -> List[str]:
        return []

    def to_provider_info(self) -> Dict[str, Any]:
        """供 /images/providers 列表接口使用"""
        cap = self.get_capabilities()
        cap.update({
            "icon": self.icon,
            "category": self.category,
        })
        return cap
