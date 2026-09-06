"""
音频/TTS Provider 抽象基类
所有语音生成能力（MiniMax/ElevenLabs/CosyVoice/GPT-SoVITS/Azure等）必须实现此接口
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from dataclasses import dataclass


@dataclass
class AudioGenerateRequest:
    text: str
    # 不写死音色：空值由具体源按其声明（models 首位/DEFAULT_VOICE）兜底
    voice_id: str = ""
    emotion: str = ""  # 空 = 源默认情绪
    speed: float = 1.0
    pitch: float = 0.0
    # 扩展：克隆/参考音频
    ref_audio_path: Optional[str] = None
    ref_text: Optional[str] = None
    model: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


@dataclass
class AudioGenerateResult:
    audio_url: str
    local_path: str
    voice_id: str
    text: str
    emotion: str
    duration: float
    provider: str
    engine: str
    status: str = "ready"
    raw: Optional[Dict[str, Any]] = None


class AudioProvider(ABC):
    """音频生成提供商抽象"""
    id: str = "base"
    display_name: str = "Base Audio Provider"
    description: str = ""
    icon: str = "Mic"
    category: str = "audio"

    @abstractmethod
    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        ...

    @abstractmethod
    async def check_health(self) -> bool:
        ...

    def is_configured(self) -> bool:
        return True

    async def list_voices(self) -> List[Dict[str, Any]]:
        """返回可用音色列表"""
        return []

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "description": self.description,
            "supports_emotion": True,
            "supports_speed": True,
            "supports_pitch": True,
            "supports_clone": False,
            "supports_stream": False,
            "is_configured": self.is_configured(),
        }

    def to_provider_info(self) -> Dict[str, Any]:
        cap = self.get_capabilities()
        cap.update({"icon": self.icon, "category": self.category})
        return cap
