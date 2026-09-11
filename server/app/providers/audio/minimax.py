"""
MiniMax TTS Provider (Speech-01)
从原 minimax_tts.py 迁移为Provider实现，保持完全兼容
"""
import os
import uuid as uuidlib
import httpx
from typing import Dict, Any, List

from app.core.config import settings
from .base import AudioProvider, AudioGenerateRequest, AudioGenerateResult

VOICE_PRESETS = [
    {"id": "male-qn-qingse", "name": "热血少年", "gender": "male", "tags": ["热血", "清脆", "坚毅"]},
    {"id": "female-shaonv", "name": "灵动少女", "gender": "female", "tags": ["灵动", "甜美", "傲娇"]},
    {"id": "male-badao", "name": "霸道魔尊 / 狂傲青年", "gender": "male", "tags": ["狂傲", "威慑", "霸气"]},
    {"id": "female-yujie", "name": "冷艳御姐 / 宗门仙子", "gender": "female", "tags": ["冷艳", "高贵", "清冷"]},
    {"id": "male-pangbai", "name": "史诗宏大旁白", "gender": "male", "tags": ["磁性", "史诗", "沧桑"]},
    {"id": "female-luoli", "name": "呆萌萝莉 / 灵兽精灵", "gender": "female", "tags": ["软萌", "可爱", "童声"]},
]

EMOTION_TAGS = {
    "neutral": "",
    "intense": "<emotion value='angry' intensity='0.9'>",
    "sorrow": "<emotion value='sad' intensity='0.85'>",
    "excited": "<emotion value='happy' intensity='0.9'>",
    "fearful": "<emotion value='fearful' intensity='0.8'>",
    "whispering": "<emotion value='whisper' intensity='1.0'>",
}


class MiniMaxTTSProvider(AudioProvider):
    id = "minimax"
    display_name = "MiniMax Speech-01"
    description = "MiniMax 超拟人语音，支持怒吼/低语/哭腔等情绪标签"
    icon = "Mic"

    def is_configured(self) -> bool:
        return bool(settings.MINIMAX_API_KEY)

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.post(
                    f"{settings.MINIMAX_BASE_URL.rstrip('/')}/text/chatcompletion_v2",
                    headers={"Authorization": f"Bearer {settings.MINIMAX_API_KEY}", "Content-Type": "application/json"},
                    json={"model": settings.LLM_MODEL, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
                )
                return r.status_code in (200, 400, 401)  # 401说明key无效但服务通
        except Exception:
            return False

    async def list_voices(self) -> List[Dict[str, Any]]:
        return VOICE_PRESETS

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        if not req.text or not req.text.strip():
            return AudioGenerateResult(
                audio_url="", local_path="", voice_id=req.voice_id,
                text=req.text, emotion=req.emotion, duration=0.0,
                provider=self.id, engine="minimax", status="empty"
            )
        if not settings.MINIMAX_API_KEY:
            raise RuntimeError("MINIMAX_API_KEY 未配置：请在系统配置中填入密钥")

        emotion_tag = EMOTION_TAGS.get(req.emotion, "")
        formatted_text = f"{emotion_tag}{req.text}" if emotion_tag else req.text
        # 空音色 → 本源声明的第一个预设（默认值由源自己给出，不再由调用方写死）
        voice_id = req.voice_id or VOICE_PRESETS[0]["id"]

        headers = {
            "Authorization": f"Bearer {settings.MINIMAX_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": settings.TTS_MODEL,
            "text": formatted_text,
            "voice_setting": {
                "voice_id": voice_id,
                "speed": req.speed,
                "vol": 1.0,
                "pitch": int(req.pitch),
            },
            "audio_setting": {
                "sample_rate": 32000,
                "bitrate": 128000,
                "format": "mp3",
                "channel": 1,
            },
        }

        try:
            async with httpx.AsyncClient(timeout=1200.0) as client:
                resp = await client.post(
                    f"{settings.MINIMAX_BASE_URL.rstrip('/')}/t2a_v2",
                    headers=headers,
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            detail = e.response.text[:300] if e.response is not None else ""
            raise RuntimeError(f"MiniMax TTS API 返回错误: {detail}") from e
        except httpx.HTTPError as e:
            raise RuntimeError(f"无法连接 MiniMax TTS API ({settings.MINIMAX_BASE_URL}): {e}") from e

        if data.get("base_resp", {}).get("status_code", 0) != 0:
            raise RuntimeError(f"MiniMax TTS 业务错误: {data.get('base_resp')}")

        audio_hex = data.get("data", {}).get("audio", "")
        if not audio_hex:
            raise RuntimeError(f"MiniMax TTS 未返回音频数据: {str(data)[:300]}")

        audio_bytes = bytes.fromhex(audio_hex)
        filename = f"tts_{uuidlib.uuid4().hex[:8]}.mp3"
        filepath = os.path.join(settings.STORAGE_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(audio_bytes)

        duration = round(len(audio_bytes) * 8 / 128000, 2) if audio_bytes else 1.0

        return AudioGenerateResult(
            audio_url=f"/storage/{filename}",
            local_path=filepath,
            voice_id=voice_id,
            text=req.text,
            emotion=req.emotion,
            duration=duration,
            provider=self.id,
            engine=f"minimax ({settings.TTS_MODEL})",
            status="ready",
            raw=data,
        )
