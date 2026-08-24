"""
ElevenLabs TTS Provider
API: https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
"""
import os
import uuid as uuidlib
import httpx
from typing import Dict, Any, List

from app.core.config import settings
from .base import AudioProvider, AudioGenerateRequest, AudioGenerateResult


class ElevenLabsProvider(AudioProvider):
    id = "elevenlabs"
    display_name = "ElevenLabs"
    description = "ElevenLabs 云端高质量多语言 TTS，支持情感与克隆"
    icon = "Mic2"

    def is_configured(self) -> bool:
        return bool(settings.ELEVENLABS_API_KEY)

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
                )
                return r.status_code == 200
        except Exception:
            return False

    async def list_voices(self) -> List[Dict[str, Any]]:
        if not self.is_configured():
            return []
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": settings.ELEVENLABS_API_KEY},
                )
                r.raise_for_status()
                data = r.json()
                voices = data.get("voices", [])
                return [{"id": v.get("voice_id"), "name": v.get("name"), "gender": "unknown", "tags": v.get("labels", {})} for v in voices[:50]]
        except Exception:
            return []

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        if not req.text or not req.text.strip():
            return AudioGenerateResult(audio_url="", local_path="", voice_id=req.voice_id, text=req.text, emotion=req.emotion, duration=0.0, provider=self.id, engine="elevenlabs", status="empty")
        if not settings.ELEVENLABS_API_KEY:
            raise RuntimeError("ELEVENLABS_API_KEY 未配置")

        # voice_id 若为预设的 male-qn-qingse 等，需要映射到真实 elevenlabs voice_id
        # 若用户直接填 elevenlabs voice_id 则直通
        voice_id = req.voice_id
        # 简单映射：若是预设中文ID，尝试使用默认多语言voice
        preset_map = {
            "male-qn-qingse": "JBFqnCBsd6RMkjVDRZzb",  # George
            "female-shaonv": "21m00Tcm4TlvDq8ikWAM",
            "male-pangbai": "2EiwWnXFnvU5JabPnv8n",
        }
        if voice_id in preset_map:
            voice_id = preset_map[voice_id]

        # ElevenLabs 情感通过 stability/similarity 等控制，这里将 emotion 映射
        emotion_to_settings = {
            "neutral": {"stability": 0.75, "similarity_boost": 0.75, "style": 0.0},
            "intense": {"stability": 0.5, "similarity_boost": 0.85, "style": 0.8},
            "sorrow": {"stability": 0.8, "similarity_boost": 0.7, "style": 0.6},
            "excited": {"stability": 0.4, "similarity_boost": 0.8, "style": 0.9},
            "fearful": {"stability": 0.6, "similarity_boost": 0.75, "style": 0.7},
            "whispering": {"stability": 0.9, "similarity_boost": 0.6, "style": 0.5},
        }
        vs = emotion_to_settings.get(req.emotion, emotion_to_settings["neutral"])

        model = req.model or "eleven_multilingual_v2"
        headers = {
            "xi-api-key": settings.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        payload = {
            "text": req.text,
            "model_id": model,
            "voice_settings": {
                "stability": vs["stability"],
                "similarity_boost": vs["similarity_boost"],
                "style": vs["style"],
                "use_speaker_boost": True,
            },
        }
        # speed 映射到 ElevenLabs 的 speed 参数（部分模型支持）
        if req.speed != 1.0:
            payload["voice_settings"]["speed"] = float(req.speed)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                headers=headers,
                json=payload,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"ElevenLabs TTS 失败 HTTP {resp.status_code}: {resp.text[:300]}")
            audio_bytes = resp.content

        if not audio_bytes:
            raise RuntimeError("ElevenLabs 未返回音频数据")

        filename = f"el_{uuidlib.uuid4().hex[:8]}.mp3"
        filepath = os.path.join(settings.STORAGE_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(audio_bytes)

        # 估算时长：按 128kbps
        duration = round(len(audio_bytes) * 8 / 128000, 2) if audio_bytes else 2.0

        return AudioGenerateResult(
            audio_url=f"/storage/{filename}",
            local_path=filepath,
            voice_id=voice_id,
            text=req.text,
            emotion=req.emotion,
            duration=duration,
            provider=self.id,
            engine=f"elevenlabs ({model})",
            status="ready",
        )
