# -*- coding: utf-8 -*-
"""
MiniMax / Kling / Vidu 等云端视频 Provider 通用实现
支持:
- i2v: 首帧驱动图生视频 (Image-to-Video)
- r2v: 多参考图一致性生成视频 (Reference-to-Video)
- t2v: 纯文本生成视频 (Text-to-Video)
具备异步任务提交、任务状态轮询与视频自动落盘功能。
"""
import os
import time
import uuid as uuidlib
import asyncio
from typing import Dict, Any, Optional

import httpx

from app.core.config import settings
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

VIDEOS_DIR = os.path.join(settings.STORAGE_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

# 内存任务状态缓存
_TASK_STORE: Dict[str, Dict[str, Any]] = {}


class CloudVideoProvider(VideoProvider):
    id = "minimax_video"
    display_name = "云端视频 (MiniMax H3 / Kling)"
    description = "MiniMax H3 / 快手可灵云端视频模型，支持参考生视频 (R2V) 与图生视频 (I2V)"
    icon = "CloudLightning"

    def is_configured(self) -> bool:
        return bool(
            getattr(settings, "MINIMAX_API_KEY", "")
            or getattr(settings, "KLING_API_KEY", "")
            or getattr(settings, "VIDU_API_KEY", "")
        )

    async def check_health(self) -> bool:
        return self.is_configured()

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        if not self.is_configured():
            raise RuntimeError(
                "云端视频未配置密钥：请在「系统配置」中填入 MINIMAX_API_KEY 或 KLING_API_KEY，或切换为「ComfyUI 视频 (本地)」"
            )
        started = time.time()

        # 优先 MiniMax H3
        if getattr(settings, "MINIMAX_API_KEY", ""):
            try:
                return await self._generate_minimax(req, started)
            except Exception as e:
                print(f"[CloudVideo] MiniMax 调用异常: {e}")
                if not getattr(settings, "KLING_API_KEY", ""):
                    raise

        if getattr(settings, "KLING_API_KEY", ""):
            return await self._generate_kling(req, started)

        raise RuntimeError("云端视频调用失败，且无可用的回退通道")

    async def _generate_minimax(self, req: VideoGenerateRequest, started: float) -> VideoGenerateResult:
        base = getattr(settings, "MINIMAX_BASE_URL", "https://api.minimax.chat/v1").rstrip("/")
        url = f"{base}/video_generation" if "video" not in base else base
        if "hailuo" not in url and "minimax" in url:
            url = "https://api.minimax.chat/v1/video_generation"

        headers = {
            "Authorization": f"Bearer {settings.MINIMAX_API_KEY}",
            "Content-Type": "application/json",
        }
        content = [{"type": "text", "text": req.prompt}]

        if req.mode == "i2v" and req.first_frame_url:
            img_url = req.first_frame_url
            if img_url.startswith("/"):
                img_url = f"http://127.0.0.1:8000{img_url}"
            content.append({"type": "image_url", "image_url": {"url": img_url}, "role": "first_frame"})
        elif req.mode == "r2v" and req.reference_images:
            for img in req.reference_images[:9]:
                u = img if not img.startswith("/") else f"http://127.0.0.1:8000{img}"
                content.append({"type": "image_url", "image_url": {"url": u}, "role": "reference_image"})

        payload = {
            "model": getattr(settings, "VIDEO_MODEL", "video-01") or "video-01",
            "content": content,
            "duration": max(3, min(10, req.duration)),
            "resolution": req.resolution or "720p",
        }

        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code not in (200, 201):
                raise RuntimeError(f"MiniMax 视频提交失败 HTTP {r.status_code}: {r.text[:400]}")
            data = r.json()
            task_id = str(data.get("task_id") or data.get("id") or uuidlib.uuid4().hex[:12])

            _TASK_STORE[task_id] = {
                "status": "processing",
                "task_id": task_id,
                "created_at": time.time(),
                "mode": req.mode,
                "first_frame_url": req.first_frame_url,
                "provider": self.id,
            }

            # 启动后台轮询下载协程
            asyncio.create_task(self._poll_and_download_minimax(task_id, settings.MINIMAX_API_KEY))

            out_filename = f"minimax_{task_id}.mp4"
            out_path = os.path.join(VIDEOS_DIR, out_filename)
            rel_url = f"/storage/videos/{out_filename}"

            return VideoGenerateResult(
                video_url=rel_url,
                local_path=out_path,
                provider=self.id,
                engine="minimax_video (h3-async)",
                duration=req.duration,
                elapsed_ms=int((time.time() - started) * 1000),
                task_id=task_id,
                first_frame_url=req.first_frame_url,
                raw=data,
            )

    async def _poll_and_download_minimax(self, task_id: str, api_key: str):
        """后台轮询 MiniMax 视频生成进度，完成后自动下载到 storage/videos/"""
        query_url = f"https://api.minimax.chat/v1/query/video_generation?task_id={task_id}"
        headers = {"Authorization": f"Bearer {api_key}"}
        out_filename = f"minimax_{task_id}.mp4"
        out_path = os.path.join(VIDEOS_DIR, out_filename)

        max_attempts = 60  # 最多轮询 5 分钟
        for _ in range(max_attempts):
            await asyncio.sleep(5.0)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.get(query_url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    info = resp.json()
                    status = info.get("status")

                    if status == "Success":
                        file_id = info.get("file_id")
                        download_url = info.get("download_url")
                        if download_url:
                            # 下载视频
                            dl_resp = await client.get(download_url, timeout=60.0)
                            if dl_resp.status_code == 200:
                                with open(out_path, "wb") as f:
                                    f.write(dl_resp.content)
                                _TASK_STORE[task_id] = {
                                    "status": "completed",
                                    "video_url": f"/storage/videos/{out_filename}",
                                    "local_path": out_path,
                                }
                                print(f"[CloudVideo] MiniMax 视频任务 {task_id} 下载完成 -> {out_path}")
                                return
                    elif status in ("Fail", "Failed", "Error"):
                        _TASK_STORE[task_id] = {
                            "status": "failed",
                            "error": info.get("base_resp", {}).get("status_msg", "生成失败"),
                        }
                        return
            except Exception as e:
                print(f"[CloudVideo] 轮询任务 {task_id} 异常: {e}")

    async def _generate_kling(self, req: VideoGenerateRequest, started: float) -> VideoGenerateResult:
        # 快手可灵占位实现
        raise RuntimeError("快手可灵视频接口尚未配置，请切换为 MiniMax H3 或 ComfyUI 本地视频")

    @classmethod
    def get_task_status(cls, task_id: str) -> Dict[str, Any]:
        """获取异步任务当前状态"""
        return _TASK_STORE.get(task_id, {"status": "not_found", "task_id": task_id})
