"""
视频生成 Provider 抽象
支持两种模式：
- r2v (Reference-to-Video): prompt + 多参考图/视频/音频 → 全新场景，强一致性
- i2v (Image-to-Video): prompt + 首帧图(必选) + 尾帧(可选) → 动画化
首帧合成则为 image 能力的特化：character + scene/prop → first_frame
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass

@dataclass
class VideoGenerateRequest:
    prompt: str  # 运动/运镜描述，I2V 时避免重述画面
    mode: str = "i2v"  # r2v | i2v | t2v
    first_frame_url: Optional[str] = None  # I2V 必选，本地 /storage 或 http
    last_frame_url: Optional[str] = None
    reference_images: Optional[List[str]] = None  # R2V 参考图 URL 列表
    reference_videos: Optional[List[str]] = None
    reference_audios: Optional[List[str]] = None
    duration: int = 5  # 秒，3-15
    resolution: str = "720p"  # 720p | 1080p
    aspect_ratio: str = "9:16"
    seed: Optional[int] = None
    workflow_id: Optional[str] = None  # ComfyUI 视频工作流
    provider: Optional[str] = None
    dynamic_inputs: Optional[Dict[str, Any]] = None  # 外部暴露表单动态输入
    extra: Optional[Dict[str, Any]] = None

@dataclass
class VideoGenerateResult:
    video_url: str
    local_path: Optional[str]
    provider: str
    engine: str
    duration: int
    elapsed_ms: int
    task_id: Optional[str] = None
    first_frame_url: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None

class VideoProvider(ABC):
    id: str = "base"
    display_name: str = "Base Video Provider"
    description: str = ""
    icon: str = "Video"
    category: str = "video"

    @abstractmethod
    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        ...

    @abstractmethod
    async def check_health(self) -> bool:
        ...

    def is_configured(self) -> bool:
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "description": self.description,
            "modes": ["i2v", "r2v", "t2v"],
            "supports_first_frame": True,
            "supports_last_frame": True,
            "supports_reference": True,
            "max_duration": 10,
            "is_configured": self.is_configured(),
        }

    def to_provider_info(self) -> Dict[str, Any]:
        cap = self.get_capabilities()
        cap.update({"icon": self.icon, "category": self.category})
        return cap
