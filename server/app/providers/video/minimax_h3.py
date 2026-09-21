# -*- coding: utf-8 -*-
"""
MiniMax H3 默认视频生成源 (内置)
官方文档: https://platform.minimax.io/docs/guides/video-generation
  - 创建: POST {BASE}/v2/video_generation -> {"task_id": ...}
  - 查询: GET  {BASE}/v2/query/video_generation/{task_id} -> {"task": {"status": "queued|running|succeeded|failed|cancelled|expired", "content": {"url": ...}}}
模型: MiniMax-H3 (多模态: t2v / i2v首尾帧 / r2v参考图+视频+音频, 768P/2K, 4-15s)
鉴权: Bearer MINIMAX_API_KEY (需按量计费 API, H3 不在免费版)
缺 Key 时 is_configured()=False, 注册表自动跳过, 前端显示未配置。
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

H3_DOC_URL = "https://platform.minimax.io/docs/guides/video-generation"


def _abs_url(url: str) -> str:
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:")):
        return url
    if url.startswith("/"):
        return f"http://127.0.0.1:8000{url}"
    return url


def _map_resolution(res: Optional[str]) -> str:
    r = (res or "").strip().upper()
    if r in ("768P", "2K"):
        return r
    if r in ("1080P", "2K "):
        return "2K"
    if "2K" in r:
        return "2K"
    return "768P"


def _map_ratio(ar: Optional[str], has_image_input: bool) -> str:
    a = (ar or "").strip()
    valid = {"adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"}
    if has_image_input:
        return "adaptive"
    return a if a in valid else "16:9"


class MiniMaxH3VideoProvider(VideoProvider):
    id = "minimax_h3"
    display_name = "MiniMax H3 (多模态视频)"
    description = "MiniMax-H3 官方 V2: 文生/首尾帧/多模态参考, 768P/2K, 4-15s, 需配置 MINIMAX_API_KEY(按量计费)"
    icon = "Sparkles"

    def is_configured(self) -> bool:
        return bool(getattr(settings, "MINIMAX_API_KEY", ""))

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
            "resolutions": ["768P", "2K"],
            "doc_url": H3_DOC_URL,
            "is_configured": self.is_configured(),
            "models": ["MiniMax-H3"],
            "default_model": getattr(settings, "MINIMAX_H3_MODEL", "MiniMax-H3") or "MiniMax-H3",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "运动/运镜描述(必填, ≤7000字符)", "x-handle": "text", "x-role": "prompt"},
                    "first_frame": {"type": "string", "format": "uri", "description": "首帧图(i2v)", "x-handle": "image", "x-slot": "first_frame"},
                    "last_frame": {"type": "string", "format": "uri", "description": "尾帧图(需配首帧)", "x-handle": "image", "x-slot": "last_frame"},
                    "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图≤9 (r2v)", "x-handle": "image", "x-slot": "reference_images", "maxItems": 9, "minItems": 0},
                    "reference_videos": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考视频≤3, 单段2-15s (r2v)", "x-handle": "video", "x-slot": "reference_videos", "maxItems": 3, "minItems": 0},
                    "reference_audios": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考音频≤3, 需配图文 (r2v)", "x-handle": "audio", "x-slot": "ref_audio", "maxItems": 3, "minItems": 0},
                },
                "required": ["prompt"],
            },
            "params_schema": {
                "type": "object",
                "properties": {
                    "resolution": {"type": "string", "title": "分辨率", "enum": ["768P", "2K"], "default": "768P", "description": "768P省钱/2K高清", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
                    "ratio": {"type": "string", "title": "宽高比", "enum": ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], "default": "adaptive", "description": "文生需指定具体比例, 图生固定adaptive", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
                    "duration": {"type": "integer", "title": "时长(秒)", "default": 5, "minimum": 4, "maximum": 15, "description": "4-15整数秒", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
                },
            },
        })
        return cap

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = getattr(settings, "MINIMAX_API_KEY", "")
        if not api_key:
            raise RuntimeError("MiniMax H3 未配置: 请在「设置中心→基础设施→云端视频」填入 MINIMAX_API_KEY(按量计费) 后再使用")
        if not (req.prompt or "").strip():
            raise ValueError("提示词不能为空 (H3 要求 content 内必须有非空 text)")
        started = time.time()
        base = (getattr(settings, "MINIMAX_H3_BASE_URL", "") or "https://api.minimaxi.com").rstrip("/")
        model = (getattr(settings, "MINIMAX_H3_MODEL", "") or "MiniMax-H3").strip() or "MiniMax-H3"
        dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        extra = req.extra if isinstance(req.extra, dict) else {}

        first = req.first_frame_url or dyn.get("first_frame") or dyn.get("first_frame_url")
        last = req.last_frame_url or dyn.get("last_frame") or dyn.get("last_frame_url")
        ref_imgs = list(req.reference_images or dyn.get("reference_images") or [])
        ref_vids = list(req.reference_videos or dyn.get("reference_videos") or dyn.get("reference_video") or [])
        ref_auds = list(req.reference_audios or dyn.get("reference_audios") or dyn.get("reference_audio") or [])
        if isinstance(ref_imgs, str):
            ref_imgs = [ref_imgs]
        if isinstance(ref_vids, str):
            ref_vids = [ref_vids]
        if isinstance(ref_auds, str):
            ref_auds = [ref_auds]

        content = [{"type": "text", "text": req.prompt.strip()[:7000]}]
        has_image_input = False
        if first:
            content.append({"type": "image_url", "image_url": {"url": _abs_url(first)}, "role": "first_frame"})
            has_image_input = True
        if last:
            if not first:
                raise ValueError("H3 尾帧必须与首帧配对使用")
            content.append({"type": "image_url", "image_url": {"url": _abs_url(last)}, "role": "last_frame"})
            has_image_input = True
        for u in (ref_imgs or [])[:9]:
            if u:
                content.append({"type": "image_url", "image_url": {"url": _abs_url(u)}, "role": "reference_image"})
                has_image_input = True
        for u in (ref_vids or [])[:3]:
            if u:
                content.append({"type": "video_url", "video_url": {"url": _abs_url(u)}, "role": "reference_video"})
                has_image_input = True
        for u in (ref_auds or [])[:3]:
            if u:
                content.append({"type": "audio_url", "audio_url": {"url": _abs_url(u)}, "role": "reference_audio"})
                has_image_input = True
        if ref_auds and not has_image_input:
            raise ValueError("H3 参考音频不可单独使用, 需至少配一张图或一段视频")

        resolution = _map_resolution(req.resolution or dyn.get("resolution") or extra.get("resolution"))
        ratio = dyn.get("ratio") or extra.get("ratio") or req.aspect_ratio
        ratio = _map_ratio(ratio, has_image_input)
        try:
            duration = int(req.duration or dyn.get("duration") or 5)
        except Exception:
            duration = 5
        duration = max(4, min(15, duration))

        payload = {"model": model, "content": content, "resolution": resolution, "duration": duration, "ratio": ratio}
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        url = f"{base}/v2/video_generation"
        async with httpx.AsyncClient(timeout=1200.0) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"MiniMax H3 提交失败 HTTP {r.status_code}: {r.text[:500]}")
            data = r.json()
            task_id = str(data.get("task_id") or data.get("id") or data.get("task", {}).get("id") or uuidlib.uuid4().hex[:12])

        _TASK_STORE[task_id] = {"status": "processing", "task_id": task_id, "created_at": time.time(),
                                "mode": req.mode, "first_frame_url": first, "provider": self.id}
        asyncio.create_task(self._poll_and_download(task_id, api_key, base))
        out_filename = f"h3_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        return VideoGenerateResult(
            video_url=f"/storage/videos/{out_filename}", local_path=out_path, provider=self.id,
            engine=f"minimax_h3 ({model} {resolution} {duration}s)", duration=duration,
            elapsed_ms=int((time.time() - started) * 1000), task_id=task_id,
            first_frame_url=first, raw=data,
        )

    async def _poll_and_download(self, task_id: str, api_key: str, base: str):
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"h3_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        query_url = f"{base}/v2/query/video_generation/{task_id}"
        for _ in range(150):  # ~25min
            await asyncio.sleep(10.0)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(query_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    task = (resp.json() or {}).get("task", {}) or {}
                    status = str(task.get("status") or "").lower()
                    if status == "succeeded":
                        dl = ((task.get("content") or {}).get("url")) or task.get("video_url")
                        if dl:
                            d = await client.get(dl, timeout=120.0)
                            if d.status_code == 200:
                                with open(out_path, "wb") as f:
                                    f.write(d.content)
                                _TASK_STORE[task_id] = {"status": "completed", "task_id": task_id,
                                                        "video_url": f"/storage/videos/{out_filename}",
                                                        "local_path": out_path}
                                print(f"[MiniMaxH3] 任务 {task_id} 完成 -> {out_path}")
                                return
                    elif status in ("failed", "cancelled", "expired"):
                        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id,
                                                "error": str(task.get("error") or task.get("fail_reason") or status)}
                        return
            except Exception as e:
                print(f"[MiniMaxH3] 轮询 {task_id} 异常: {e}")
        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id, "error": "轮询超时(25min)"}

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
