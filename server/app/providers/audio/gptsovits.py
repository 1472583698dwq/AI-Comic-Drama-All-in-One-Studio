"""
GPT-SoVITS TTS Provider (本地)
常见API：GET /tts?text=&text_lang=&ref_audio_path=&prompt_text=&prompt_lang=&text_split_method=
或 POST /tts
通过 GPTSOVITS_URL 配置
"""
import os
import uuid as uuidlib
import httpx
from typing import Dict, Any, List
import urllib.parse

from app.core.config import settings
from .base import AudioProvider, AudioGenerateRequest, AudioGenerateResult


class GPTSoVITSProvider(AudioProvider):
    id = "gpt_sovits"
    display_name = "GPT-SoVITS (本地)"
    description = "GPT-SoVITS 本地克隆 TTS，支持参考音频与多语言"
    icon = "AudioLines"

    def is_configured(self) -> bool:
        return bool(settings.GPTSOVITS_URL)

    async def check_health(self) -> bool:
        url = settings.GPTSOVITS_URL.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                # GPT-SoVITS 通常无health，尝试根路径
                r = await client.get(url)
                return r.status_code < 500
        except Exception:
            return False

    async def list_voices(self) -> List[Dict[str, Any]]:
        # GPT-SoVITS 依赖参考音频，无固定音色列表，返回示例
        return [
            {"id": "default", "name": "默认参考音频 (需配置 ref_audio_path)"},
        ]

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        if not req.text or not req.text.strip():
            return AudioGenerateResult(audio_url="", local_path="", voice_id=req.voice_id, text=req.text, emotion=req.emotion, duration=0.0, provider=self.id, engine="gpt_sovits", status="empty")

        base = settings.GPTSOVITS_URL.rstrip("/")
        # 构造参数
        # GPT-SoVITS 常用参数：
        # text, text_lang(zh/en/ja), ref_audio_path, prompt_text, prompt_lang, text_split_method, batch_size, speed_factor, etc.
        # 我们尽量兼容
        text_lang = "zh"
        # 简单语言检测
        if any("\u4e00" <= c <= "\u9fff" for c in req.text):
            text_lang = "zh"
        else:
            text_lang = "en"

        # ref_audio_path 优先 req.ref_audio_path，其次 req.voice_id 若为路径
        ref_audio = req.ref_audio_path or ""
        # 若 voice_id 是路径且文件存在，直接用
        if not ref_audio and req.voice_id and ("/" in req.voice_id or "\\" in req.voice_id):
            ref_audio = req.voice_id

        # prompt_text：若有额外提供则用，否则空
        prompt_text = req.ref_text or ""
        params = {
            "text": req.text,
            "text_lang": text_lang,
            "ref_audio_path": ref_audio,
            "prompt_text": prompt_text,
            "prompt_lang": text_lang,
            "text_split_method": "cut5",
            "batch_size": 1,
            "speed_factor": float(req.speed) if req.speed else 1.0,
        }
        # 若无ref_audio，尝试不带ref的简化调用（部分版本支持）
        # 先尝试GET
        audio_bytes = None
        last_err = ""
        async with httpx.AsyncClient(timeout=1200.0) as client:
            # 尝试1: GET /tts
            try:
                qs = urllib.parse.urlencode(params)
                url = f"{base}/tts?{qs}"
                # 若启用额外参数，URL可能过长，必要时改POST
                resp = await client.get(url, timeout=1200.0)
                if resp.status_code == 200:
                    ct = resp.headers.get("content-type", "")
                    if "audio" in ct or "wav" in ct or "mpeg" in ct or len(resp.content) > 500:
                        audio_bytes = resp.content
                    else:
                        # 可能是JSON错误
                        try:
                            j = resp.json()
                            last_err = str(j)[:300]
                        except Exception:
                            last_err = resp.text[:300]
                else:
                    last_err = f"GET /tts HTTP {resp.status_code}: {resp.text[:200]}"
            except Exception as e:
                last_err = str(e)

            # 尝试2: POST /tts (JSON)
            if not audio_bytes:
                try:
                    resp = await client.post(f"{base}/tts", json=params, timeout=1200.0)
                    if resp.status_code == 200:
                        ct = resp.headers.get("content-type", "")
                        if "audio" in ct or len(resp.content) > 500:
                            audio_bytes = resp.content
                        else:
                            try:
                                j = resp.json()
                                if "audio" in j:
                                    import base64
                                    audio_bytes = base64.b64decode(j["audio"])
                            except Exception:
                                pass
                    if not audio_bytes:
                        last_err = f"POST /tts HTTP {resp.status_code}: {resp.text[:200]}"
                except Exception as e:
                    last_err = str(e)

            # 尝试3: POST / (部分版本根路径即tts)
            if not audio_bytes:
                try:
                    resp = await client.post(base, json=params, timeout=1200.0)
                    if resp.status_code == 200 and len(resp.content) > 500:
                        audio_bytes = resp.content
                except Exception:
                    pass

        if not audio_bytes:
            raise RuntimeError(f"GPT-SoVITS 生成失败 (服务 {base}): {last_err or '无音频返回'} 提示：需确保服务已启动且参考音频路径在服务端可访问")

        # GPT-SoVITS 通常返回wav
        ext = ".wav" if audio_bytes[:4] == b"RIFF" else ".mp3"
        filename = f"gsv_{uuidlib.uuid4().hex[:8]}{ext}"
        filepath = os.path.join(settings.STORAGE_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(audio_bytes)

        # 时长估算：wav 16k采样需不同计算，这里简单按大小
        if ext == ".wav":
            # wav 16bit mono 16k 约 32KB/s
            duration = round(len(audio_bytes) / 32000, 2) if len(audio_bytes) > 44 else 2.0
        else:
            duration = round(len(audio_bytes) * 8 / 128000, 2)

        return AudioGenerateResult(
            audio_url=f"/storage/{filename}",
            local_path=filepath,
            voice_id=req.voice_id,
            text=req.text,
            emotion=req.emotion,
            duration=duration,
            provider=self.id,
            engine="gpt_sovits",
            status="ready",
        )
