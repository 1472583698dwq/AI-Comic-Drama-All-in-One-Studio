"""
IndexTTS-2.5 音频 Provider（本机 / 自建 Gradio 服务）

与 CosyVoice / GPT-SoVITS 那种"一个 HTTP 打完收工"不同，IndexTTS 走 Gradio 的三步式：

  1. POST {base}/gradio_api/upload            上传参考音频，拿服务端路径
  2. POST {base}/gradio_api/call/gen_single   提交 26 个**位置参数**，拿 event_id
  3. GET  {base}/gradio_api/call/gen_single/{event_id}   读 SSE 流等结果 URL

两个实测坑（见 ~/project/tts/tts_api.sh）：
  - num_beams 必须是 int：webui.py 原样透传不做 int()，发 3.0 会被 transformers 拒绝；
    也别设成 1，实测比默认 3 慢 2.5 倍。
  - 合成很慢，SSE 要给足超时。

音色 = 参考音频（零样本克隆）。voice_id 传本地 wav 路径即可；留空用 INDEXTTS_REF_AUDIO。
"""
import json
import os
import time
import uuid as uuidlib
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings
from app.providers.audio.base import AudioProvider, AudioGenerateRequest, AudioGenerateResult

# 情感向量 8 维：喜 怒 哀 惧 厌恶 低落 惊喜 平静
_EMO_VECTORS: Dict[str, List[float]] = {
    "neutral":    [0, 0, 0, 0, 0, 0, 0, 0],
    "excited":    [0.8, 0, 0, 0, 0, 0, 0.4, 0],
    "intense":    [0, 0.8, 0, 0, 0, 0, 0, 0],
    "sorrow":     [0, 0, 0.8, 0, 0, 0.4, 0, 0],
    "fearful":    [0, 0, 0, 0.8, 0, 0, 0, 0],
    "whispering": [0, 0, 0, 0, 0, 0.3, 0, 0.6],
}

_LANGS = ("ZH", "EN", "JA", "KO")


def _lang_of(req: AudioGenerateRequest) -> str:
    raw = ""
    if req.extra and isinstance(req.extra, dict):
        raw = str(req.extra.get("lang") or req.extra.get("language") or "")
    raw = (raw or getattr(settings, "INDEXTTS_LANG", "") or "ZH").upper()
    return raw if raw in _LANGS else "ZH"


class IndexTTSProvider(AudioProvider):
    id = "indextts"
    display_name = "IndexTTS (本地)"
    description = "本机 IndexTTS-2.5，零样本音色克隆；音色由参考音频决定"
    icon = "Mic"

    def _base(self) -> str:
        return (getattr(settings, "INDEXTTS_URL", "") or "").rstrip("/")

    def is_configured(self) -> bool:
        return bool(self._base())

    async def check_health(self) -> bool:
        base = self._base()
        if not base:
            return False
        try:
            async with httpx.AsyncClient(timeout=6.0) as c:
                r = await c.get(base + "/")
                return r.status_code < 500
        except Exception:
            return False

    async def list_voices(self) -> List[Dict[str, Any]]:
        """音色即参考音频。列出默认参考音频与它同目录下的其它 wav。"""
        out: List[Dict[str, Any]] = []
        ref = getattr(settings, "INDEXTTS_REF_AUDIO", "") or ""
        if ref:
            out.append({"id": ref, "name": f"默认参考音频 · {os.path.basename(ref)}"})
            d = os.path.dirname(ref)
            try:
                for f in sorted(os.listdir(d)):
                    if not f.lower().endswith((".wav", ".mp3", ".flac", ".m4a")):
                        continue
                    p = os.path.join(d, f)
                    if p != ref:
                        out.append({"id": p, "name": f})
            except Exception:
                pass
        if not out:
            out.append({"id": "", "name": "未配置参考音频（在设置里填一个 wav 路径）"})
        return out

    def get_capabilities(self) -> Dict[str, Any]:
        cap = super().get_capabilities()
        cap.update({"supports_clone": True, "supports_pitch": False})
        return cap

    # ── 三步式调用 ──────────────────────────────────────────
    async def _upload_ref(self, c: httpx.AsyncClient, base: str, path: str) -> str:
        with open(path, "rb") as f:
            r = await c.post(f"{base}/gradio_api/upload", files={"files": (os.path.basename(path), f)})
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, list) or not data:
            raise RuntimeError(f"IndexTTS 上传参考音频失败: {str(data)[:200]}")
        return str(data[0])

    def _payload(self, srv_path: str, text: str, lang: str, emotion: str, speed: float) -> Dict[str, Any]:
        emo = _EMO_VECTORS.get((emotion or "").strip().lower(), _EMO_VECTORS["neutral"])
        # 时长系数：speed 越大语速越快 → duration_factor 取倒数
        dur = 1.0 / speed if speed and speed > 0 else 1.0
        data = [
            "Same as the voice reference",                                    # 0  情感控制方式
            {"path": srv_path, "meta": {"_type": "gradio.FileData"}},         # 1  音色参考音频
            text,                                                             # 2  文本
            lang,                                                             # 3  语言
            None,                                                             # 4  情感参考音频
            0.65,                                                             # 5  情感权重
            *emo,                                                             # 6-13 情感向量
            "",                                                               # 14 情感描述文本
            False,                                                            # 15 情感随机采样
            int(getattr(settings, "INDEXTTS_SEG_TOKENS", 120) or 120),        # 16 分句最大 Token
            float(round(dur, 3)),                                             # 17 时长系数
            True,                                                             # 18 do_sample
            0.8,                                                              # 19 top_p
            30,                                                               # 20 top_k
            0.8,                                                              # 21 temperature
            0.0,                                                              # 22 length_penalty
            int(getattr(settings, "INDEXTTS_NUM_BEAMS", 3) or 3),             # 23 num_beams ← 必须 int
            10.0,                                                             # 24 repetition_penalty
            1500,                                                             # 25 max_mel_tokens
        ]
        return {"data": data}

    @staticmethod
    def _url_from_sse(chunk: str) -> Optional[str]:
        for line in chunk.splitlines():
            if not line.startswith("data: "):
                continue
            body = line[6:].strip()
            if body in ("null", ""):
                continue
            try:
                obj = json.loads(body)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, list) and obj and isinstance(obj[0], dict):
                v = obj[0].get("value")
                if isinstance(v, dict) and v.get("url"):
                    return str(v["url"])
        return None

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        base = self._base()
        if not base:
            raise RuntimeError("IndexTTS 未配置：请在设置 → 能力配置 → 配音 里填服务地址")
        if not (req.text or "").strip():
            return AudioGenerateResult(
                audio_url="", local_path="", voice_id=req.voice_id, text=req.text,
                emotion=req.emotion, duration=0.0, provider=self.id, engine="indextts", status="empty",
            )

        ref = req.ref_audio_path or ""
        if not ref and req.voice_id and ("/" in req.voice_id or "\\" in req.voice_id):
            ref = req.voice_id
        if not ref:
            ref = getattr(settings, "INDEXTTS_REF_AUDIO", "") or ""
        if not ref or not os.path.exists(ref):
            raise RuntimeError(
                f"IndexTTS 需要参考音频（零样本克隆）。当前路径无效: {ref or '(空)'}。"
                "请在设置里填「默认参考音频」，或给角色绑定一个 wav 路径当音色。"
            )

        started = time.time()
        timeout = float(getattr(settings, "INDEXTTS_TIMEOUT", 1800) or 1800)
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0)) as c:
            srv = await self._upload_ref(c, base, ref)

            body = self._payload(srv, req.text, _lang_of(req), req.emotion, req.speed)
            r = await c.post(f"{base}/gradio_api/call/gen_single", json=body,
                             headers={"Content-Type": "application/json"})
            r.raise_for_status()
            eid = (r.json() or {}).get("event_id")
            if not eid:
                raise RuntimeError(f"IndexTTS 未返回 event_id: {r.text[:200]}")

            url: Optional[str] = None
            async with c.stream("GET", f"{base}/gradio_api/call/gen_single/{eid}") as resp:
                resp.raise_for_status()
                buf = ""
                async for chunk in resp.aiter_text():
                    buf += chunk
                    url = self._url_from_sse(buf)
                    if url:
                        break
            if not url:
                raise RuntimeError("IndexTTS 合成未返回音频（服务端可能报错，查它自己的日志）")

            audio = await c.get(url)
            audio.raise_for_status()
            content = audio.content

        filename = f"indextts_{uuidlib.uuid4().hex[:10]}.wav"
        filepath = os.path.join(settings.STORAGE_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(content)

        return AudioGenerateResult(
            audio_url=f"/storage/{filename}",
            local_path=filepath,
            voice_id=ref,
            text=req.text,
            emotion=req.emotion,
            duration=0.0,
            provider=self.id,
            engine="indextts-2.5",
            raw={"ref_audio": ref, "elapsed_ms": int((time.time() - started) * 1000)},
        )
