"""
MiniMax Speech-01 / T2A 超拟人情绪 TTS 流水线
仅在配置 MINIMAX_API_KEY 后调用真实 API；未配置时抛出 TTSUnconfiguredError，
绝不返回假音频地址。
"""
import os
import uuid as uuidlib
from typing import Dict, Any

import httpx

from app.core.config import settings

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


class TTSUnconfiguredError(RuntimeError):
    """MINIMAX_API_KEY 未配置"""


class MiniMaxTTSPipeline:
    async def generate_speech(
        self,
        text: str,
        voice_id: str = "male-qn-qingse",
        emotion: str = "neutral",
        speed: float = 1.0,
        pitch: float = 0.0,
    ) -> Dict[str, Any]:
        if not text or not text.strip():
            return {"audio_url": "", "duration": 0.0, "status": "empty"}

        if not settings.MINIMAX_API_KEY:
            raise TTSUnconfiguredError(
                "MINIMAX_API_KEY 未配置：请在 server/.env 中填入密钥后重启后端服务（参考 .env.example）"
            )

        return await self._call_minimax_t2a(text, voice_id, emotion, speed, pitch)

    async def _call_minimax_t2a(
        self,
        text: str,
        voice_id: str,
        emotion: str,
        speed: float,
        pitch: float,
    ) -> Dict[str, Any]:
        emotion_tag = EMOTION_TAGS.get(emotion, "")
        formatted_text = f"{emotion_tag}{text}" if emotion_tag else text

        headers = {
            "Authorization": f"Bearer {settings.MINIMAX_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": settings.TTS_MODEL,
            "text": formatted_text,
            "voice_setting": {
                "voice_id": voice_id,
                "speed": speed,
                "vol": 1.0,
                "pitch": int(pitch),
            },
            "audio_setting": {
                "sample_rate": 32000,
                "bitrate": 128000,
                "format": "mp3",
                "channel": 1,
            },
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{settings.MINIMAX_BASE_URL}/t2a_v2",
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

        # 由真实码率推算音频时长（128 kbps CBR）
        duration = round(len(audio_bytes) * 8 / 128000, 2) if audio_bytes else 1.0

        return {
            "audio_url": f"/storage/{filename}",
            "local_path": filepath,
            "voice_id": voice_id,
            "text": text,
            "emotion": emotion,
            "duration": duration,
            "status": "ready",
        }


tts_pipeline = MiniMaxTTSPipeline()
