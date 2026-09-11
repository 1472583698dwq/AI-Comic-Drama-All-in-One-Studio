# -*- coding: utf-8 -*-
"""
可灵 Kling / 柯灵 默认视频生成源 (内置, 快手)
官方文档: https://app.klingai.com/cn/dev/document-api/apiReference/model/textToVideo
  - 文生: POST {BASE}/v1/videos/text2video -> {"code":0,"data":{"task_id":...}}
  - 图生: POST {BASE}/v1/videos/image2video -> 同上 (image首帧, image_tail尾帧需mode=pro)
  - 多图: POST {BASE}/v1/videos/multi-image2video (多参考)
  - 查询: GET  {BASE}/v1/videos/text2video/{task_id} (或对应endpoint/{task_id})
          -> {"code":0,"data":{"task_status":"submitted|processing|succeed|failed","task_result":{"videos":[{"url":...}]}}}
模型: kling-v3 (旗舰) / kling-v2-6 / kling-video-o1 (推理) 等, 时长仅 5/10s
鉴权: 官方为 AK/SK 签发 JWT; 本项目支持 Bearer KLING_API_KEY 直连 (官网/中转网关均可, BASE_URL 可覆盖)
缺 Key 时 is_configured()=False, 注册表自动跳过。
"""
import os
import time
import asyncio
import uuid as uuidlib
from typing import Dict, Any, Optional, Tuple

import httpx

from app.core.config import settings
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

VIDEOS_DIR = os.path.join(settings.STORAGE_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

_TASK_STORE: Dict[str, Dict[str, Any]] = {}

DOC_URL = "https://app.klingai.com/cn/dev/document-api/apiReference/model/textToVideo"


def _abs_url(url: str) -> str:
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:")):
        return url
    if url.startswith("/"):
        return f"http://127.0.0.1:8000{url}"
    return url


def _map_duration(d: Any) -> Tuple[int, str]:
    try:
        v = int(d or 5)
    except Exception:
        v = 5
    v = 5 if v <= 7 else 10
    return v, str(v)


def _map_aspect(ar: Optional[str]) -> str:
    a = (ar or "").strip()
    return a if a in ("16:9", "9:16", "1:1") else "16:9"


def _extract_task_id(data: Any) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    for k in ("task_id", "id", "taskId"):
        if data.get(k):
            return str(data[k])
    d = data.get("data") or {}
    if isinstance(d, dict):
        for k in ("task_id", "id", "taskId"):
            if d.get(k):
                return str(d[k])
    return None


class KlingVideoProvider(VideoProvider):
    id = "kling"
    display_name = "可灵 Kling (快手)"
    description = "快手可灵: 文生/图生/首尾帧, 5/10s, 需配置 KLING_API_KEY (官网或中转Bearer均可)"
    icon = "Clapperboard"

    def is_configured(self) -> bool:
        return bool(getattr(settings, "KLING_API_KEY", ""))

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
            "max_duration": 10,
            "min_duration": 5,
            "resolutions": ["720P", "1080P"],
            "doc_url": DOC_URL,
            "is_configured": self.is_configured(),
            "models": ["kling-v3", "kling-v2-6", "kling-v2-5-turbo", "kling-video-o1"],
            "default_model": getattr(settings, "KLING_MODEL", "kling-v3") or "kling-v3",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "正向提示词(≤2500字符)", "x-handle": "text", "x-role": "prompt"},
                    "first_frame": {"type": "string", "format": "uri", "description": "首帧图(图生必填)", "x-handle": "image", "x-slot": "first_frame"},
                    "last_frame": {"type": "string", "format": "uri", "description": "尾帧图(需mode=pro)", "x-handle": "image", "x-slot": "last_frame"},
                    "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "多图参考(>1张走多图接口)", "x-handle": "image", "x-slot": "reference_images", "maxItems": 4, "minItems": 0},
                },
                "required": ["prompt"],
            },
            "params_schema": {
                "type": "object",
                "properties": {
                    "resolution": {"type": "string", "title": "清晰度", "enum": ["720P", "1080P"], "default": "720P", "description": "720P=std极速, 1080P=pro高清", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
                    "aspect_ratio": {"type": "string", "title": "画面比例", "enum": ["16:9", "9:16", "1:1"], "default": "9:16", "description": "仅文生生效, 图生跟随首帧", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
                    "duration": {"type": "integer", "title": "时长(秒)", "enum": [5, 10], "default": 5, "description": "仅支持5/10秒", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
                    "cfg_scale": {"type": "number", "title": "提示词相关度", "default": 0.5, "minimum": 0, "maximum": 1, "description": "越大越贴提示词", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
                    "generate_audio": {"type": "boolean", "title": "生成声音", "default": False, "description": "v2.6+/v3有声 (sound=on)", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 11},
                },
            },
        })
        return cap

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = getattr(settings, "KLING_API_KEY", "")
        if not api_key:
            raise RuntimeError("可灵 Kling 未配置: 请在「设置中心→基础设施→云端视频」填入 KLING_API_KEY 后再使用")
        if not (req.prompt or "").strip():
            raise ValueError("提示词不能为空")
        started = time.time()
        base = (getattr(settings, "KLING_BASE_URL", "") or "https://api-beijing.klingai.com").rstrip("/")
        dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        extra = req.extra if isinstance(req.extra, dict) else {}
        model = (dyn.get("model") or extra.get("model") or getattr(settings, "KLING_MODEL", "") or "kling-v3").strip()

        first = req.first_frame_url or dyn.get("first_frame") or dyn.get("image")
        last = req.last_frame_url or dyn.get("last_frame") or dyn.get("image_tail")
        ref_imgs = req.reference_images or dyn.get("reference_images") or []
        if isinstance(ref_imgs, str):
            ref_imgs = [ref_imgs]
        ref_imgs = [u for u in (ref_imgs or []) if u]
        if first and first not in ref_imgs:
            all_imgs = [first] + ref_imgs
        else:
            all_imgs = ref_imgs
        if last and last not in all_imgs:
            all_imgs = all_imgs + [last]

        duration_int, duration_str = _map_duration(req.duration or dyn.get("duration") or 5)
        aspect = _map_aspect(dyn.get("aspect_ratio") or extra.get("aspect_ratio") or req.aspect_ratio)
        res = (req.resolution or dyn.get("resolution") or extra.get("resolution") or "720P").strip().upper()
        mode = "pro" if res == "1080P" else "std"
        if last:
            mode = "pro"
        if isinstance(dyn.get("mode"), str) and dyn["mode"] in ("std", "pro"):
            mode = dyn["mode"]
        try:
            cfg = float(dyn.get("cfg_scale", extra.get("cfg_scale", 0.5)))
        except Exception:
            cfg = 0.5
        cfg = max(0.0, min(1.0, cfg))
        gen_audio = dyn.get("generate_audio", dyn.get("sound", extra.get("generate_audio", False)))
        sound = "on" if (gen_audio is True or str(gen_audio).lower() == "on") else "off"
        negative = dyn.get("negative_prompt") or extra.get("negative_prompt") or ""
        prompt = req.prompt.strip()[:2500]

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        common = {"model": model, "prompt": prompt, "negative_prompt": negative or "",
                  "mode": mode, "duration": duration_int, "duration_string": duration_str,
                  "seconds": duration_str, "cfg_scale": cfg, "sound": sound,
                  "aspect_ratio": aspect}
        if first and len(all_imgs) <= 2 and not req.reference_videos:
            endpoint = "image2video"
            payload = dict(common)
            payload["image"] = _abs_url(first)
            if last:
                payload["image_tail"] = _abs_url(last)
        elif len(all_imgs) >= 2:
            endpoint = "multi-image2video"
            payload = dict(common)
            payload["image_list"] = [{"image": _abs_url(u)} for u in all_imgs[:4]]
            payload["images"] = [_abs_url(u) for u in all_imgs[:4]]
        else:
            endpoint = "text2video"
            payload = dict(common)

        url = f"{base}/v1/videos/{endpoint}"
        async with httpx.AsyncClient(timeout=1200.0) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"可灵提交失败 HTTP {r.status_code}: {r.text[:500]}")
            try:
                data = r.json()
            except Exception:
                raise RuntimeError(f"可灵返回非JSON: {r.text[:300]}")
            if isinstance(data, dict) and data.get("code") not in (None, 0):
                raise RuntimeError(f"可灵提交失败 code={data.get('code')}: {str(data.get('message') or data)[:400]}")
            task_id = _extract_task_id(data) or uuidlib.uuid4().hex[:12]

        _TASK_STORE[task_id] = {"status": "processing", "task_id": task_id, "endpoint": endpoint,
                                "created_at": time.time(), "mode": req.mode,
                                "first_frame_url": first, "provider": self.id}
        asyncio.create_task(self._poll_and_download(task_id, endpoint, api_key, base))
        out_filename = f"kling_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        return VideoGenerateResult(
            video_url=f"/storage/videos/{out_filename}", local_path=out_path, provider=self.id,
            engine=f"kling ({model} {mode} {duration_int}s)", duration=duration_int,
            elapsed_ms=int((time.time() - started) * 1000), task_id=task_id,
            first_frame_url=first, raw=data if isinstance(data, dict) else {"raw": str(data)[:500]},
        )

    async def _poll_and_download(self, task_id: str, endpoint: str, api_key: str, base: str):
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"kling_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        query_url = f"{base}/v1/videos/{endpoint}/{task_id}"
        for _ in range(150):
            await asyncio.sleep(10.0)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(query_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    try:
                        body = resp.json()
                    except Exception:
                        continue
                    data = (body.get("data") if isinstance(body, dict) else None) or body or {}
                    status = str(data.get("task_status") or data.get("status") or "").lower()
                    if status == "succeed":
                        videos = ((data.get("task_result") or {}).get("videos")) or data.get("videos") or []
                        dl = (videos[0].get("url") if videos and isinstance(videos[0], dict) else None) or data.get("video_url")
                        if dl:
                            d = await client.get(dl, timeout=120.0)
                            if d.status_code == 200:
                                with open(out_path, "wb") as f:
                                    f.write(d.content)
                                _TASK_STORE[task_id] = {"status": "completed", "task_id": task_id,
                                                        "video_url": f"/storage/videos/{out_filename}",
                                                        "local_path": out_path}
                                print(f"[Kling] 任务 {task_id} 完成 -> {out_path}")
                                return
                    elif status == "failed":
                        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id,
                                                "error": str(data.get("task_status_msg") or data.get("fail_reason") or "failed")}
                        return
            except Exception as e:
                print(f"[Kling] 轮询 {task_id} 异常: {e}")
        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id, "error": "轮询超时(25min)"}

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
