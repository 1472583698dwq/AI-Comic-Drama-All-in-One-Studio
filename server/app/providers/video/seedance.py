# -*- coding: utf-8 -*-
"""
Seedance 默认视频生成源 (内置, 字节火山引擎 Ark)
官方文档: https://www.volcengine.com/product/ark (Seedance 2.x 视频生成 API)
  - 创建: POST {BASE}/contents/generations/tasks -> {"id": ...}
  - 查询: GET  {BASE}/contents/generations/tasks/{id} -> {"id","status":"queued|running|succeeded|failed|expired","content":{"video_url":...}}
模型: 填模型名 (doubao-seedance-2-0-260128 / -fast-260128 / doubao-seedance-2-5-260628)
      或推理接入点 id (ep-xxxxxxxxxxxxxx-xxxxx)，两者都接受
参数分层 (照已验证的 sd25pe 口径): generate_audio/return_last_frame/draft 走 JSON 顶层，
      resolution/ratio/duration/watermark 必须拼成 --xxx 追加在 prompt 尾部；
      有参考素材时不传 ratio；有参考视频时 duration 强制 -1 且带 omni_reference_task_type=edit
鉴权: Bearer SEEDANCE_API_KEY (火山 Ark API Key)
缺 Key 时 is_configured()=False, 注册表自动跳过。
注意: 输入含真人脸会被上游审核拒绝, 请用模型生成/非写实素材。
"""
import os
import time
import asyncio
import uuid as uuidlib
from typing import Dict, Any, Optional

import httpx

from app.core.config import settings
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

VIDEOS_DIR = os.path.join(settings.STORAGE_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

_TASK_STORE: Dict[str, Dict[str, Any]] = {}

DOC_URL = "https://www.volcengine.com/product/ark"


def _abs_url(url: str) -> str:
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:")):
        return url
    if url.startswith("/"):
        return f"http://127.0.0.1:8000{url}"
    return url


# 方舟只有这三个参数走 JSON 顶层，其余一律拼进 prompt 尾部当 --xxx。
# 口径来自已验证可用的 sd25pe（server/providers.js 的 ark()），不是猜的。
_ARK_JSON_KEYS = ("generate_audio", "return_last_frame", "draft")


def _norm_base(base: str) -> str:
    """填 https://ark.cn-beijing.volces.com 或带 /api/v3 都能用。"""
    b = (base or "").strip().rstrip("/")
    if not b:
        b = "https://ark.cn-beijing.volces.com"
    if b.endswith("/api/v3"):
        return b
    return b + "/api/v3"


def _map_resolution(res: Optional[str]) -> str:
    r = (res or "").strip().lower()
    if r in ("480p", "720p", "1080p"):
        return r
    if "1080" in r or "2k" in r:
        return "1080p"
    if "480" in r:
        return "480p"
    return "720p"


def _map_ratio(ar: Optional[str]) -> str:
    a = (ar or "").strip()
    valid = {"16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"}
    return a if a in valid else "adaptive"


class SeedanceVideoProvider(VideoProvider):
    id = "seedance"
    display_name = "Seedance (火山引擎)"
    description = "字节 Seedance 2.x: 文生/首尾帧/多模态参考+原生有声, 需配置 SEEDANCE_API_KEY(火山Ark)"
    icon = "Zap"

    def is_configured(self) -> bool:
        return bool(getattr(settings, "SEEDANCE_API_KEY", ""))

    async def check_health(self) -> bool:
        return self.is_configured()

    def get_capabilities(self) -> Dict[str, Any]:
        cap = super().get_capabilities()
        cap.update({
            "display_name": self.display_name,
            "description": self.description,
            "modes": ["t2v", "i2v", "r2v"],
            "supports_first_frame": True,
            "supports_last_frame": True,
            "supports_reference": True,
            "supports_reference_video": True,
            "supports_reference_audio": True,
            "max_duration": 15,
            "min_duration": 4,
            "resolutions": ["480p", "720p", "1080p"],
            "doc_url": DOC_URL,
            "is_configured": self.is_configured(),
            "models": ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615", "doubao-seedance-2-5-260628"],
            "default_model": getattr(settings, "SEEDANCE_MODEL", "doubao-seedance-2-0-260128") or "doubao-seedance-2-0-260128",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "文本提示词(中≤500字/英≤1000词)", "x-handle": "text", "x-role": "prompt"},
                    "first_frame": {"type": "string", "format": "uri", "description": "首帧图", "x-handle": "image", "x-slot": "first_frame"},
                    "last_frame": {"type": "string", "format": "uri", "description": "尾帧图(需配首帧)", "x-handle": "image", "x-slot": "last_frame"},
                    "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图≤9, 单张≤30MB", "x-handle": "image", "x-slot": "reference_images", "maxItems": 9, "minItems": 0},
                    "reference_videos": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考视频≤3, 单段2-15s", "x-handle": "video", "x-slot": "reference_videos", "maxItems": 3, "minItems": 0},
                    "reference_audios": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考音频≤3 (需配图文)", "x-handle": "audio", "x-slot": "ref_audio", "maxItems": 3, "minItems": 0},
                },
                "required": ["prompt"],
            },
            "params_schema": {
                "type": "object",
                "properties": {
                    "resolution": {"type": "string", "title": "分辨率", "enum": ["480p", "720p", "1080p"], "default": "720p", "description": "fast/mini最高720p, 标准版可用1080p", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
                    "ratio": {"type": "string", "title": "宽高比", "enum": ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "default": "adaptive", "description": "首尾帧建议adaptive", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
                    "duration": {"type": "integer", "title": "时长(秒)", "default": 5, "minimum": 4, "maximum": 15, "description": "4-15整数秒", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
                    "generate_audio": {"type": "boolean", "title": "原生有声", "default": True, "description": "音画联合生成台词/音效/BGM", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 11},
                    "watermark": {"type": "boolean", "title": "AI水印", "default": False, "description": "右下角AI生成水印", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 60},
                },
            },
        })
        return cap

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = getattr(settings, "SEEDANCE_API_KEY", "")
        if not api_key:
            raise RuntimeError("Seedance 未配置: 请在「设置中心→基础设施→云端视频」填入 SEEDANCE_API_KEY(火山引擎Ark) 后再使用")
        if not (req.prompt or "").strip():
            raise ValueError("提示词不能为空")
        started = time.time()
        base = _norm_base(getattr(settings, "SEEDANCE_BASE_URL", ""))
        dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        extra = req.extra if isinstance(req.extra, dict) else {}
        model = (dyn.get("model") or extra.get("model") or getattr(settings, "SEEDANCE_MODEL", "") or "doubao-seedance-2-0-260128").strip()

        first = req.first_frame_url or dyn.get("first_frame") or dyn.get("first_frame_url")
        last = req.last_frame_url or dyn.get("last_frame") or dyn.get("last_frame_url")
        ref_imgs = req.reference_images or dyn.get("reference_images") or []
        ref_vids = req.reference_videos or dyn.get("reference_videos") or []
        ref_auds = req.reference_audios or dyn.get("reference_audios") or []
        if isinstance(ref_imgs, str):
            ref_imgs = [ref_imgs]
        if isinstance(ref_vids, str):
            ref_vids = [ref_vids]
        if isinstance(ref_auds, str):
            ref_auds = [ref_auds]

        content = [{"type": "text", "text": req.prompt.strip()}]
        if first:
            content.append({"type": "image_url", "image_url": {"url": _abs_url(first)}, "role": "first_frame"})
        if last:
            if not first:
                raise ValueError("尾帧必须与首帧配对使用")
            content.append({"type": "image_url", "image_url": {"url": _abs_url(last)}, "role": "last_frame"})
        for u in (ref_imgs or [])[:9]:
            if u:
                content.append({"type": "image_url", "role": "reference_image", "image_url": {"url": _abs_url(u)}})
        for u in (ref_vids or [])[:3]:
            if u:
                content.append({"type": "video_url", "role": "reference_video", "video_url": {"url": _abs_url(u)}})
        for u in (ref_auds or [])[:3]:
            if u:
                content.append({"type": "audio_url", "audio_url": {"url": _abs_url(u)}})
        if ref_auds and not (first or ref_imgs or ref_vids):
            raise ValueError("Seedance 参考音频不可单独使用, 需至少配一张图或一段视频")

        resolution = _map_resolution(req.resolution or dyn.get("resolution") or extra.get("resolution"))
        if "fast" in model or "mini" in model:
            resolution = "720p" if resolution == "1080p" else resolution
        ratio = _map_ratio(dyn.get("ratio") or extra.get("ratio") or req.aspect_ratio)
        try:
            duration = int(req.duration or dyn.get("duration") or 5)
        except Exception:
            duration = 5
        duration = max(4, min(15, duration))
        gen_audio = dyn.get("generate_audio", extra.get("generate_audio", True))
        if isinstance(gen_audio, str):
            gen_audio = gen_audio.strip().lower() in ("1", "true", "yes", "on")
        watermark = bool(dyn.get("watermark", extra.get("watermark", False)))

        # 方舟的参数分两层：generate_audio 这类走 JSON 顶层，resolution/ratio/duration/watermark
        # 这类必须拼成 --xxx 追加到 prompt 文本尾部。放错层不会报错，但参数会被静默忽略。
        has_ref = bool(first or last or ref_imgs or ref_vids)
        flags = [f"--resolution {resolution}", f"--watermark {'true' if watermark else 'false'}"]
        if not has_ref:
            # 有参考素材时画幅由素材决定，传了反而冲突
            flags.insert(0, f"--ratio {ratio}")
        top: Dict[str, Any] = {"generate_audio": bool(gen_audio)}
        if ref_vids:
            # 带参考视频＝编辑类任务：时长跟随原片，覆盖调用方传进来的值
            flags.append("--duration -1")
            top["omni_reference_task_type"] = "edit"
        else:
            flags.append(f"--duration {duration}")
        content[0]["text"] = f"{content[0]['text']} {' '.join(flags)}".strip()
        payload = {"model": model, **top, "content": content}
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        url = f"{base}/contents/generations/tasks"
        async with httpx.AsyncClient(timeout=1200.0) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Seedance 提交失败 HTTP {r.status_code}: {r.text[:500]}")
            data = r.json()
            task_id = str(data.get("id") or data.get("task_id") or data.get("task", {}).get("id") or uuidlib.uuid4().hex[:12])

        _TASK_STORE[task_id] = {"status": "processing", "task_id": task_id, "created_at": time.time(),
                                "mode": req.mode, "first_frame_url": first, "provider": self.id}
        asyncio.create_task(self._poll_and_download(task_id, api_key, base))
        out_filename = f"seedance_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        return VideoGenerateResult(
            video_url=f"/storage/videos/{out_filename}", local_path=out_path, provider=self.id,
            engine=f"seedance ({model} {resolution} {duration}s)", duration=duration,
            elapsed_ms=int((time.time() - started) * 1000), task_id=task_id,
            first_frame_url=first, raw=data,
        )

    async def _poll_and_download(self, task_id: str, api_key: str, base: str):
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"seedance_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        query_url = f"{base}/contents/generations/tasks/{task_id}"
        for _ in range(150):
            await asyncio.sleep(10.0)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(query_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    data = resp.json() or {}
                    status = str(data.get("status") or "").lower()
                    if status == "succeeded":
                        dl = ((data.get("content") or {}).get("video_url")) or data.get("video_url")
                        if dl:
                            d = await client.get(dl, timeout=120.0)
                            if d.status_code == 200:
                                with open(out_path, "wb") as f:
                                    f.write(d.content)
                                _TASK_STORE[task_id] = {"status": "completed", "task_id": task_id,
                                                        "video_url": f"/storage/videos/{out_filename}",
                                                        "local_path": out_path}
                                print(f"[Seedance] 任务 {task_id} 完成 -> {out_path}")
                                return
                    elif status in ("failed", "expired", "cancelled"):
                        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id,
                                                "error": str(data.get("error") or data.get("fail_reason") or status)}
                        return
            except Exception as e:
                print(f"[Seedance] 轮询 {task_id} 异常: {e}")
        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id, "error": "轮询超时(25min)"}

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
