# -*- coding: utf-8 -*-
"""
OpenAI 兼容视频 Provider（设置中心「生视频 → 自定义（OpenAI 兼容）」通道）

按 OpenAI 官方 Video API（Sora 系）对接，任何实现了同一协议的中转站 / 自建网关都能直接用：

  创建: POST {base}/videos        multipart/form-data: model, prompt, size, seconds[, input_reference]
        -> {"id": "video_xxx", "status": "queued|in_progress|completed|failed"}
  查询: GET  {base}/videos/{id}   -> {"id": "...", "status": "...", "error": {...}}
  下载: GET  {base}/videos/{id}/content  -> 二进制 mp4

鉴权: Bearer OPENAI_VIDEO_API_KEY —— 生视频专用 Key，与文本大模型 / 生图的 Key 完全独立。
地址与模型: OPENAI_VIDEO_BASE_URL / OPENAI_VIDEO_MODEL。
缺 Key 时 is_configured()=False，注册表自动跳过，不会污染默认路由。
"""
import base64
import mimetypes
import os
import time
import asyncio
import uuid as uuidlib
from typing import Any, Dict, Optional, Tuple

import httpx

from app.core.config import settings
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

VIDEOS_DIR = os.path.join(settings.STORAGE_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

_TASK_STORE: Dict[str, Dict[str, Any]] = {}

DOC_URL = "https://platform.openai.com/docs/guides/video-generation"
DEFAULT_MODEL = "sora-2"


def video_api_key() -> str:
    return (getattr(settings, "OPENAI_VIDEO_API_KEY", "") or "").strip()


def video_base_url() -> str:
    """统一归一化到 .../v1，避免用户少填/多填一层。"""
    base = (getattr(settings, "OPENAI_VIDEO_BASE_URL", "") or "https://api.openai.com/v1").strip().rstrip("/")
    if base.endswith("/videos"):
        base = base[: -len("/videos")]
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def _map_size(aspect_ratio: Optional[str], resolution: Optional[str]) -> str:
    """宽高比 + 分辨率 → OpenAI 支持的像素尺寸。"""
    ar = (aspect_ratio or "9:16").strip()
    res = (resolution or "720p").strip().lower()
    hd = ("1080" in res) or ("2k" in res) or ("1792" in res)
    if ar in ("16:9", "4:3", "21:9"):
        return "1792x1024" if hd else "1280x720"
    if ar == "1:1":
        return "1024x1024"
    return "1024x1792" if hd else "720x1280"


def _snap_seconds(duration: Any) -> str:
    """OpenAI 只接受 4 / 8 / 12 秒，就近取整。"""
    try:
        d = int(float(duration or 4))
    except Exception:
        d = 4
    return str(min((4, 8, 12), key=lambda x: abs(x - d)))


async def _load_input_reference(client: httpx.AsyncClient, ref: Optional[str]) -> Optional[Tuple[str, bytes, str]]:
    """首帧/参考图 → multipart 文件段 (filename, bytes, mime)。取不到时返回 None（走纯文生视频）。"""
    if not ref or not isinstance(ref, str) or not ref.strip():
        return None
    s = ref.strip()
    # data URI
    if s.startswith("data:"):
        try:
            header, b64 = s.split(",", 1)
            mime = (header[5:].split(";")[0] or "image/png").strip()
            return ("input_reference.png", base64.b64decode(b64), mime)
        except Exception:
            return None
    # 本机 /storage 引用
    from app.providers.media_refs import local_path_for_ref
    local = local_path_for_ref(s)
    if local and os.path.isfile(local):
        mime = mimetypes.guess_type(local)[0] or "image/png"
        try:
            with open(local, "rb") as f:
                return (os.path.basename(local) or "input_reference.png", f.read(), mime)
        except Exception:
            return None
    # 公网图片：拉下来上传（内联上限 20MB）
    if s.startswith(("http://", "https://")):
        try:
            r = await client.get(s, timeout=60.0)
            if r.status_code == 200 and 0 < len(r.content) <= 20 * 1024 * 1024:
                mime = (r.headers.get("content-type") or "image/png").split(";")[0].strip()
                return ("input_reference.png", r.content, mime)
        except Exception:
            return None
    return None


class OpenAIVideoProvider(VideoProvider):
    id = "openai_video"
    display_name = "自定义 (OpenAI 兼容视频)"
    description = "按 OpenAI /v1/videos 协议（Sora 系）对接任意中转/自建网关，独立 Key / 地址 / 模型"
    icon = "Clapperboard"

    def is_configured(self) -> bool:
        return bool(video_api_key())

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(
                    f"{video_base_url()}/models",
                    headers={"Authorization": f"Bearer {video_api_key()}"},
                )
                return r.status_code < 500
        except Exception:
            return False

    def get_capabilities(self) -> Dict[str, Any]:
        cap = super().get_capabilities()
        cap.update({
            "display_name": self.display_name,
            "description": self.description,
            "modes": ["t2v", "i2v"],
            "supports_first_frame": True,
            "supports_last_frame": False,
            "supports_reference": True,
            "max_duration": 12,
            "min_duration": 4,
            "resolutions": ["720p", "1080p"],
            "doc_url": DOC_URL,
            "is_configured": self.is_configured(),
            "models": ["sora-2", "sora-2-pro"],
            "default_model": getattr(settings, "OPENAI_VIDEO_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL,
        })
        return cap

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = video_api_key()
        if not api_key:
            raise RuntimeError(
                "自定义视频未配置：请在「设置 → 能力配置 → 生视频 → 自定义（OpenAI 兼容）」里填 OPENAI_VIDEO_API_KEY"
            )
        if not (req.prompt or "").strip():
            raise ValueError("提示词不能为空")

        started = time.time()
        base = video_base_url()
        dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        extra = req.extra if isinstance(req.extra, dict) else {}
        model = str(dyn.get("model") or extra.get("model") or getattr(settings, "OPENAI_VIDEO_MODEL", "") or DEFAULT_MODEL).strip()
        size = str(dyn.get("size") or extra.get("size")
                   or _map_size(dyn.get("ratio") or extra.get("ratio") or req.aspect_ratio, req.resolution)).strip()
        seconds = str(dyn.get("seconds") or extra.get("seconds") or _snap_seconds(req.duration))

        # 首帧优先；R2V 场景退而取第一张参考图作为 input_reference
        first_ref = (req.first_frame_url
                     or dyn.get("first_frame") or dyn.get("first_frame_url"))
        if not first_ref:
            refs = req.reference_images or dyn.get("reference_images") or []
            if isinstance(refs, str):
                refs = [refs]
            first_ref = next((r for r in refs if r), None)

        headers = {"Authorization": f"Bearer {api_key}"}
        async with httpx.AsyncClient(timeout=600.0) as client:
            part = await _load_input_reference(client, first_ref)

            def _form(with_image: bool) -> Dict[str, Any]:
                files: Dict[str, Any] = {
                    "model": (None, model),
                    "prompt": (None, req.prompt.strip()),
                    "size": (None, size),
                    "seconds": (None, seconds),
                }
                if with_image and part:
                    files["input_reference"] = part
                return files

            r = await client.post(f"{base}/videos", headers=headers, files=_form(True))
            used_image = bool(part)
            # 部分中转不支持 input_reference：带图被拒时自动退回纯文生视频，而不是直接失败
            if used_image and r.status_code in (400, 415, 422):
                r = await client.post(f"{base}/videos", headers=headers, files=_form(False))
                used_image = False
            if r.status_code not in (200, 201):
                raise RuntimeError(f"自定义视频提交失败 HTTP {r.status_code}: {r.text[:500]}")
            data = r.json() or {}
            task_id = str(data.get("id") or data.get("task_id") or data.get("video_id") or uuidlib.uuid4().hex[:12])

        _TASK_STORE[task_id] = {
            "status": "processing", "task_id": task_id, "created_at": time.time(),
            "mode": req.mode, "first_frame_url": first_ref, "provider": self.id,
        }
        asyncio.create_task(self._poll_and_download(task_id, api_key, base))

        out_filename = f"oai_video_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        return VideoGenerateResult(
            video_url=f"/storage/videos/{out_filename}",
            local_path=out_path,
            provider=self.id,
            engine=f"openai_video ({model} {size} {seconds}s{' +首帧' if used_image else ''})",
            duration=int(seconds),
            elapsed_ms=int((time.time() - started) * 1000),
            task_id=task_id,
            first_frame_url=first_ref,
            raw=data,
        )

    async def _poll_and_download(self, task_id: str, api_key: str, base: str):
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"oai_video_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)
        status_url = f"{base}/videos/{task_id}"

        for _ in range(180):  # 最长约 30 分钟
            await asyncio.sleep(5.0)
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.get(status_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    info = resp.json() or {}
                    status = str(info.get("status") or "").lower()
                    if status in ("completed", "succeeded", "success"):
                        dl = (info.get("video_url")
                              or (info.get("content") or {}).get("video_url")
                              or (info.get("output") or {}).get("url"))
                        if dl:
                            d = await client.get(dl, timeout=300.0)
                        else:
                            d = await client.get(f"{base}/videos/{task_id}/content", headers=headers, timeout=300.0)
                        if d.status_code == 200 and d.content:
                            with open(out_path, "wb") as f:
                                f.write(d.content)
                            _TASK_STORE[task_id] = {
                                "status": "completed", "task_id": task_id,
                                "video_url": f"/storage/videos/{out_filename}",
                                "local_path": out_path,
                            }
                            print(f"[OpenAIVideo] 任务 {task_id} 完成 -> {out_path}")
                            return
                    elif status in ("failed", "error", "cancelled", "canceled"):
                        err = info.get("error") or {}
                        msg = err.get("message") if isinstance(err, dict) else str(err)
                        _TASK_STORE[task_id] = {
                            "status": "failed", "task_id": task_id,
                            "error": msg or info.get("fail_reason") or "生成失败",
                        }
                        return
            except Exception as e:
                print(f"[OpenAIVideo] 轮询 {task_id} 异常: {e}")
        _TASK_STORE[task_id] = {"status": "failed", "task_id": task_id, "error": "轮询超时(30min)"}

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
