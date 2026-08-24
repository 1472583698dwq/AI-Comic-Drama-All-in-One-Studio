"""
CosyVoice TTS Provider (本地/远程 HTTP)
适配常见 CosyVoice API 封装（FunAudioLLM/CosyVoice2）
常见接口：
- POST /tts  或  POST /v1/audio/speech  (OpenAI兼容)
- GET /tts?text=&voice=&speed=  (简易)
支持通过 COSYVOICE_URL 配置
"""
import os
import uuid as uuidlib
import httpx
from typing import Dict, Any, List

from app.core.config import settings
from .base import AudioProvider, AudioGenerateRequest, AudioGenerateResult


class CosyVoiceProvider(AudioProvider):
    id = "cosyvoice"
    display_name = "CosyVoice (本地)"
    description = "阿里 CosyVoice 本地/远程 TTS，支持克隆与多音色"
    icon = "Speaker"

    def is_configured(self) -> bool:
        # 只要URL可达即认为配置，允许空Key的本地服务
        return bool(settings.COSYVOICE_URL)

    async def check_health(self) -> bool:
        url = settings.COSYVOICE_URL.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                # 尝试常见健康检查路径
                for path in ["/health", "/", "/v1/models", "/tts/health"]:
                    try:
                        r = await client.get(f"{url}{path}")
                        if r.status_code < 500:
                            return True
                    except Exception:
                        continue
                return False
        except Exception:
            return False

    async def list_voices(self) -> List[Dict[str, Any]]:
        url = settings.COSYVOICE_URL.rstrip("/")
        # 尝试获取音色列表
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                for path in ["/v1/voices", "/voices", "/tts/voices"]:
                    try:
                        r = await client.get(f"{url}{path}")
                        if r.status_code == 200:
                            data = r.json()
                            # 兼容多种返回
                            if isinstance(data, list):
                                return [{"id": v.get("id") or v.get("voice_id") or str(v), "name": v.get("name") or str(v)} for v in data[:50]]
                            if isinstance(data, dict) and "voices" in data:
                                return [{"id": v.get("id"), "name": v.get("name")} for v in data["voices"][:50]]
                    except Exception:
                        continue
        except Exception:
            pass
        # 返回常见预设
        return [
            {"id": "中文女", "name": "中文女 (默认)"},
            {"id": "中文男", "name": "中文男 (默认)"},
            {"id": "英文女", "name": "英文女"},
        ]

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        if not req.text or not req.text.strip():
            return AudioGenerateResult(audio_url="", local_path="", voice_id=req.voice_id, text=req.text, emotion=req.emotion, duration=0.0, provider=self.id, engine="cosyvoice", status="empty")

        base = settings.COSYVOICE_URL.rstrip("/")
        # 尝试多种API形态，逐一回退
        attempts = [
            # 1. OpenAI兼容
            {
                "url": f"{base}/v1/audio/speech",
                "method": "POST",
                "json": {"model": "cosyvoice", "input": req.text, "voice": req.voice_id, "speed": req.speed, "response_format": "mp3"},
                "headers": {"Content-Type": "application/json"},
            },
            # 2. 常见 /tts POST
            {
                "url": f"{base}/tts",
                "method": "POST",
                "json": {"text": req.text, "voice": req.voice_id, "speed": req.speed, "emotion": req.emotion},
                "headers": {"Content-Type": "application/json"},
            },
            # 3. GET 方式
            {
                "url": f"{base}/tts",
                "method": "GET",
                "params": {"text": req.text, "voice": req.voice_id, "speed": req.speed},
            },
        ]

        audio_bytes = None
        last_err = ""
        async with httpx.AsyncClient(timeout=30.0) as client:
            for att in attempts:
                try:
                    if att["method"] == "POST":
                        resp = await client.post(att["url"], headers=att.get("headers", {}), json=att.get("json"))
                    else:
                        resp = await client.get(att["url"], params=att.get("params"))
                    if resp.status_code == 200:
                        # 判断是音频还是JSON
                        ct = resp.headers.get("content-type", "")
                        if "audio" in ct or "octet" in ct or len(resp.content) > 1000 and resp.content[:4] in [b"ID3", b"\xff\xfb", b"RIFF"]:
                            audio_bytes = resp.content
                            break
                        # 可能是JSON包含url或base64
                        try:
                            data = resp.json()
                            if "audio" in data:
                                import base64
                                # 可能是base64
                                b64 = data["audio"]
                                if isinstance(b64, str) and len(b64) > 100:
                                    try:
                                        audio_bytes = base64.b64decode(b64)
                                        break
                                    except Exception:
                                        pass
                            if "url" in data:
                                # 下载
                                r2 = await client.get(data["url"], timeout=20.0)
                                if r2.status_code == 200:
                                    audio_bytes = r2.content
                                    break
                        except Exception:
                            # 非JSON但可能是音频
                            if len(resp.content) > 500:
                                audio_bytes = resp.content
                                break
                    last_err = f"{att['url']} HTTP {resp.status_code}: {resp.text[:200]}"
                except Exception as e:
                    last_err = str(e)
                    continue
            if not audio_bytes:
                raise RuntimeError(f"CosyVoice 生成失败，已尝试多种接口均失败: {last_err} (服务地址 {base})")

        filename = f"cosy_{uuidlib.uuid4().hex[:8]}.mp3"
        filepath = os.path.join(settings.STORAGE_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(audio_bytes)
        duration = round(len(audio_bytes) * 8 / 128000, 2) if audio_bytes else 2.0
        return AudioGenerateResult(
            audio_url=f"/storage/{filename}",
            local_path=filepath,
            voice_id=req.voice_id,
            text=req.text,
            emotion=req.emotion,
            duration=duration,
            provider=self.id,
            engine="cosyvoice",
            status="ready",
        )
