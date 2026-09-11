# -*- coding: utf-8 -*-
"""
万相 Wan3.0 默认视频生成源 (内置, 阿里百炼 DashScope)
官方文档: https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
  - 创建: POST {BASE}/api/v1/services/aigc/video-generation/video-synthesis (头 X-DashScope-Async: enable)
          -> {"output": {"task_id": ...}, "request_id": ...}
  - 查询: GET  {BASE}/api/v1/tasks/{task_id}
          -> {"output": {"task_status": "PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED", "video_url": ...}}
模型: wan3.0-video (标准) / wan3.0-video-prime (高速), All-in-One: 文生/首尾帧/全模态参考/编辑/延长, 最长30s/30fps/原生有声
鉴权: Bearer DASHSCOPE_API_KEY (复用生图同一Key), 地域 endpoint 注意与 Key 一致 (默认北京)
约束: first_frame/last_frame 族与 reference_*/file/link 族互斥, 不可混用。
缺 Key 时 is_configured()=False, 注册表自动跳过。
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

DOC_URL = "https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference"


def _abs_url(url: str) -> str:
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:", "oss://")):
        return url
    if url.startswith("/"):
        return f"http://127.0.0.1:8000{url}"
    return url


def _map_resolution(res: Optional[str]) -> str:
    r = (res or "").strip().upper()
    return r if r in ("480P", "720P", "1080P") else "720P"


def _map_ratio(ar: Optional[str]) -> str:
    a = (ar or "").strip()
    return a if a in ("adaptive", "16:9", "4:3", "1:1", "3:4", "9:16") else "adaptive"


class Wan3VideoProvider(VideoProvider):
    id = "wan3"
    display_name = "万相 Wan3.0 (阿里百炼)"
    description = "阿里万相3.0 All-in-One: 文生/首尾帧/多模态参考/编辑, 2-30s原生有声, 复用 DASHSCOPE_API_KEY"
    icon = "Wand2"

    def is_configured(self) -> bool:
        return bool(getattr(settings, "DASHSCOPE_API_KEY", ""))

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
            "max_duration": 30,
            "min_duration": 2,
            "resolutions": ["480P", "720P", "1080P"],
            "doc_url": DOC_URL,
            "is_configured": self.is_configured(),
            "models": ["wan3.0-video", "wan3.0-video-prime"],
            "default_model": getattr(settings, "WAN3_MODEL", "wan3.0-video") or "wan3.0-video",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "提示词(参考模式可用图1/视频1/音频1指代)", "x-handle": "text", "x-role": "prompt"},
                    "first_frame": {"type": "string", "format": "uri", "description": "首帧(与参考族互斥)", "x-handle": "image", "x-slot": "first_frame"},
                    "last_frame": {"type": "string", "format": "uri", "description": "尾帧(需配首帧)", "x-handle": "image", "x-slot": "last_frame"},
                    "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图≤10", "x-handle": "image", "x-slot": "reference_images", "maxItems": 10, "minItems": 0},
                    "reference_videos": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考视频≤5, 总≤15s", "x-handle": "video", "x-slot": "reference_videos", "maxItems": 5, "minItems": 0},
                    "reference_audios": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考音频≤5, 总≤15s", "x-handle": "audio", "x-slot": "ref_audio", "maxItems": 5, "minItems": 0},
                },
                "required": ["prompt"],
            },
            "params_schema": {
                "type": "object",
                "properties": {
                    "resolution": {"type": "string", "title": "分辨率", "enum": ["480P", "720P", "1080P"], "default": "720P", "description": "默认720P最省, 1080P最贵", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
                    "ratio": {"type": "string", "title": "宽高比", "enum": ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], "default": "adaptive", "description": "首尾帧/参考建议adaptive", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
                    "duration": {"type": "integer", "title": "时长(秒)", "default": 5, "minimum": -1, "maximum": 30, "description": "2-30指定, -1智能时长", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
                    "audio": {"type": "boolean", "title": "原生有声", "default": True, "description": "台词/BGM/音效, 开关同价", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 11},
                    "prompt_extend": {"type": "boolean", "title": "提示词改写", "default": True, "description": "短prompt效果提升但更慢", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 42},
                    "seed": {"type": "integer", "title": "随机种子", "description": "复现结果, 留空随机", "x-category": "quality", "x-visibility": "advanced", "x-agent": "manual", "x-priority": 99},
                    "watermark": {"type": "boolean", "title": "水印", "default": False, "description": "是否添加水印", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 60},
                },
            },
        })
        return cap

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = getattr(settings, "DASHSCOPE_API_KEY", "")
        if not api_key:
            raise RuntimeError("万相 Wan3.0 未配置: 请在「设置中心→基础设施→云端视频」填入 DASHSCOPE_API_KEY(阿里百炼) 后再使用")
        prompt = (req.prompt or "").strip()
        started = time.time()
        base = (getattr(settings, "WAN3_BASE_URL", "") or "https://dashscope.aliyuncs.com").rstrip("/")
        dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        extra = req.extra if isinstance(req.extra, dict) else {}
        model = (dyn.get("model") or extra.get("model") or getattr(settings, "WAN3_MODEL", "") or "wan3.0-video").strip()

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
        ref_imgs = [u for u in (ref_imgs or []) if u][:10]
        ref_vids = [u for u in (ref_vids or []) if u][:5]
        ref_auds = [u for u in (ref_auds or []) if u][:5]

        media = []
        if first or last:
            if ref_imgs or ref_vids or ref_auds or dyn.get("file_url") or dyn.get("link_url"):
                raise ValueError("Wan3.0 首尾帧族与参考族互斥, 不可混用 (first/last_frame vs reference_*)")
            if last and not first:
                raise ValueError("Wan3.0 尾帧必须与首帧配对使用")
            if first:
                media.append({"type": "first_frame", "url": _abs_url(first)})
            if last:
                media.append({"type": "last_frame", "url": _abs_url(last)})
        else:
            for u in ref_imgs:
                media.append({"type": "reference_image", "url": _abs_url(u)})
            for u in ref_vids:
                media.append({"type": "reference_video", "url": _abs_url(u)})
            for u in ref_auds:
                media.append({"type": "reference_audio", "url": _abs_url(u)})
            if dyn.get("file_url"):
                media.append({"type": "file", "url": _abs_url(str(dyn["file_url"]))})
            elif dyn.get("link_url"):
                media.append({"type": "link", "url": str(dyn["link_url"])})
        if not prompt and not media:
            raise ValueError("提示词与媒体素材至少提供其一")

        resolution = _map_resolution(req.resolution or dyn.get("resolution") or extra.get("resolution"))
        ratio = _map_ratio(dyn.get("ratio") or extra.get("ratio") or req.aspect_ratio)
        try:
            duration = int(req.duration if req.duration is not None else dyn.get("duration", 5))
        except Exception:
            duration = 5
        if duration != -1:
            duration = max(2, min(30, duration))
        audio = dyn.get("audio", extra.get("audio", True))
        if isinstance(audio, str):
            audio = audio.strip().lower() in ("1", "true", "yes", "on")
        prompt_extend = dyn.get("prompt_extend", extra.get("prompt_extend", True))
        if isinstance(prompt_extend, str):
            prompt_extend = prompt_extend.strip().lower() in ("1", "true", "yes", "on")
        watermark = bool(dyn.get("watermark", extra.get("watermark", False)))
        seed = req.seed if req.seed is not None else dyn.get("seed")
        try:
            seed = int(seed) if seed is not None and str(seed).strip() != "" else None
        except Exception:
            seed = None

        body: Dict[str, Any] = {"model": model, "input": {"prompt": prompt or "cinematic shot"},
                                "parameters": {"resolution": resolution, "ratio": ratio, "duration": duration,
                                               "audio": bool(audio), "prompt_extend": bool(prompt_extend),
                                               "watermark": bool(watermark)}}
        if media:
            body["input"]["media"] = media
        if seed is not None:
            body["parameters"]["seed"] = max(0, min(2147483647, seed))
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "X-DashScope-Async": "enable"}
        url = f"{base}/api/v1/services/aigc/video-generation/video-synthesis"
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.post(url, headers=headers, json=body)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"Wan3.0 提交失败 HTTP {r.status_code}: {r.text[:600]}")
            data = r.json()
            task_id = str(((data.get("output") or {}).get("task_id")) or data.get("task_id") or uuidlib.uuid4().hex[:12])

        _TASK_STORE[task_id] = {"status": "processing", "task_id": task_id, "created_at": time.time(),
                                "mode": req.mode, "first_frame_url": first, "provider": self.id}
        asyncio.create_task(self._poll_and_download(task_id, api_key, base))
        out_filename = f"wan3_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        return VideoGenerateResult(
            video_url=f"/storage/videos/{out_filename}", local_path=out_path, provider=self.id,
            engine=f"wan3 ({model} {resolution} {duration}s)", duration=(duration if duration != -1 else 5),
            elapsed_ms=int((time.time() - started) * 1000), task_id=task_id,
            first_frame_url=first, raw=data,
        )

    async def _poll_and_download(self, task_id: str, api_key: str, base: str):
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"wan3_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        query_url = f"{base}/api/v1/tasks/{task_id}"
        for _ in range(90):
            await asyncio.sleep(10.0)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(query_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    output = (resp.json().get("output") or {})
                    status = str(output.get("task_status") or "").upper()
                    if status == "SUCCEEDED":
                        dl = output.get("video_url")
                        if dl:
                            d = await client.get(dl, timeout=120.0)
                            if d.status_code == 200:
                                with open(out_path, "wb") as f:
                                    f.write(d.content)
                                _TASK_STORE[task_id] = {"status": "completed", "task_id": task_id,
                                                        "video_url": f"/storage/videos/{out_filename}",
                                                        "local_path": out_path}
                                print(f"[Wan3] 任务 {task_id} 完成 -> {out_path}")
                                return
                    elif status in ("FAILED", "CANCELED", "CANCELLED"):
                        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id,
                                                "error": str(output.get("message") or output.get("code") or status)}
                        return
            except Exception as e:
                print(f"[Wan3] 轮询 {task_id} 异常: {e}")
        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id, "error": "轮询超时(15min)"}

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
