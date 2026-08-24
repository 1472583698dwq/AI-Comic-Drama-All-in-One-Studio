"""
ComfyUI Video Provider (本地)
支持:
- I2V: 首帧图 + prompt → 视频 (SVD/AnimateDiff/HunyuanVideo)
- R2V: 多参考图/视频 + prompt → 视频
- 工作流直读: 若提供 workflow_id 则注入首帧并提交，否则走 mock/fallback

若 ComfyUI 未配置视频工作流或无可用节点，自动 fallback 为 Mock（将首帧循环 5s 生成占位视频，便于全链路演示）
"""
import os
import time
import uuid as uuidlib
import shutil
import asyncio
from typing import Dict, Any, Optional

import httpx

from app.core.config import settings
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

VIDEOS_DIR = os.path.join(settings.STORAGE_DIR, "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

def _has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None

async def _download_to_temp(url: str, dest: str):
    # 支持 /storage/... 本地映射
    if url.startswith("/storage/"):
        local = os.path.join(settings.STORAGE_DIR, url[len("/storage/"):])
        if os.path.exists(local):
            shutil.copy2(local, dest)
            return dest
        raise FileNotFoundError(f"本地素材不存在: {url}")
    # http
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url)
        r.raise_for_status()
        with open(dest, "wb") as f:
            f.write(r.content)
    return dest

def _create_mock_video_from_image(image_path: str, out_path: str, duration: int = 5) -> bool:
    """尝试用 ffmpeg 将单图循环为视频，失败则直接复制图片为占位"""
    if _has_ffmpeg():
        try:
            import subprocess
            # -loop 1 -i image -c:v libx264 -t duration -pix_fmt yuv420p
            cmd = [
                "ffmpeg", "-y",
                "-loop", "1",
                "-i", image_path,
                "-c:v", "libx264",
                "-t", str(duration),
                "-pix_fmt", "yuv420p",
                "-vf", "scale=832:1216:force_original_aspect_ratio=decrease,pad=832:1216:(ow-iw)/2:(oh-ih)/2",
                out_path
            ]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
                return True
        except Exception:
            pass
    # fallback: 复制图片为 .mp4 占位（前端会降级显示为图片）
    try:
        shutil.copy2(image_path, out_path)
        return False
    except Exception:
        return False

class ComfyUIVideoProvider(VideoProvider):
    id = "comfyui_video"
    display_name = "ComfyUI 视频 (本地)"
    description = "本地 ComfyUI 视频工作流 (SVD/AnimateDiff)，支持首帧/参考驱动；未配置时自动 Mock 便于演示"
    icon = "Film"

    def is_configured(self) -> bool:
        # 总是可用（Mock 兜底）
        return True

    async def check_health(self) -> bool:
        # 检查 ComfyUI 是否在线
        url = getattr(settings, "COMFYUI_SERVER_URL", "http://127.0.0.1:8188").rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                r = await client.get(f"{url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        started = time.time()
        # 校验
        if req.mode == "i2v" and not req.first_frame_url:
            raise ValueError("图生视频模式需要 first_frame_url (首帧图)")
        if req.mode == "r2v" and not req.reference_images and not req.first_frame_url:
            raise ValueError("参考生视频需要 reference_images 或 first_frame_url")

        # 若提供了 workflow_id，尝试走真实 ComfyUI 视频工作流
        if req.workflow_id:
            try:
                return await self._generate_via_workflow(req, started)
            except Exception as e:
                # 降级到 Mock 并附带警告
                print(f"[ComfyUIVideo] workflow {req.workflow_id} 执行失败，降级 Mock: {e}")
                # fallthrough to mock

        # Mock 生成：首帧循环为视频
        return await self._generate_mock(req, started)

    async def _generate_via_workflow(self, req: VideoGenerateRequest, started: float) -> VideoGenerateResult:
        from app.providers.workflow.manager import workflow_manager
        # 支持视频工作流同样存储在 workflows 目录（复用 manager）
        wf, meta = workflow_manager.get_workflow_with_meta(req.workflow_id) if hasattr(workflow_manager, "get_workflow_with_meta") else (workflow_manager.get_workflow(req.workflow_id), workflow_manager.get_meta(req.workflow_id))
        if not wf:
            raise FileNotFoundError(f"视频工作流不存在: {req.workflow_id}")
        # 注入首帧：寻找 LoadImage 节点
        # 简化：若工作流含 LoadImage，则替换其 image 为首帧文件名（需先上传首帧到 ComfyUI input）
        server_url = getattr(settings, "COMFYUI_SERVER_URL", "http://127.0.0.1:8188").rstrip("/")
        # 下载首帧到临时
        tmp_img = os.path.join(VIDEOS_DIR, f"tmp_{uuidlib.uuid4().hex[:6]}.png")
        if req.first_frame_url:
            await _download_to_temp(req.first_frame_url, tmp_img)
            # 上传到 ComfyUI /upload/image
            async with httpx.AsyncClient(timeout=20.0) as client:
                with open(tmp_img, "rb") as f:
                    files = {"image": (os.path.basename(tmp_img), f, "image/png")}
                    r = await client.post(f"{server_url}/upload/image", files=files)
                    r.raise_for_status()
                    upload_name = r.json().get("name", os.path.basename(tmp_img))
                # 注入到工作流：首个 LoadImage
                for nid, node in wf.items():
                    if node.get("class_type") == "LoadImage" and "image" in node.get("inputs", {}):
                        wf[nid]["inputs"]["image"] = upload_name
                        break
                # 注入 prompt / seed 等
                for nid, node in wf.items():
                    if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL"):
                        if req.prompt and "text" in node["inputs"]:
                            # 保留首个为正向
                            wf[nid]["inputs"]["text"] = req.prompt
                            break
                # 提交
                payload = {"prompt": wf, "client_id": str(uuidlib.uuid4())}
                r = await client.post(f"{server_url}/prompt", json=payload)
                r.raise_for_status()
                prompt_id = r.json()["prompt_id"]
                # 轮询 history
                deadline = time.time() + 120
                while time.time() < deadline:
                    await asyncio.sleep(1.5)
                    hr = await client.get(f"{server_url}/history/{prompt_id}")
                    hr.raise_for_status()
                    hist = hr.json()
                    entry = hist.get(prompt_id)
                    if not entry:
                        continue
                    status = entry.get("status", {})
                    if status.get("status_str") == "error":
                        raise RuntimeError(f"ComfyUI 视频工作流执行失败: {status}")
                    outputs = entry.get("outputs", {})
                    for out in outputs.values():
                        # 视频通常在 gifs 或 images
                        for key in ("gifs", "images", "videos"):
                            if key in out and out[key]:
                                meta = out[key][0]
                                # 下载
                                params = {"filename": meta["filename"], "subfolder": meta.get("subfolder", ""), "type": meta.get("type", "output")}
                                vr = await client.get(f"{server_url}/view", params=params)
                                vr.raise_for_status()
                                out_path = os.path.join(VIDEOS_DIR, f"vid_{uuidlib.uuid4().hex[:8]}.mp4")
                                with open(out_path, "wb") as f:
                                    f.write(vr.content)
                                rel = os.path.relpath(out_path, settings.STORAGE_DIR).replace("\\", "/")
                                return VideoGenerateResult(
                                    video_url=f"/storage/{rel}",
                                    local_path=out_path,
                                    provider=self.id,
                                    engine=f"comfyui_video ({req.workflow_id})",
                                    duration=req.duration,
                                    elapsed_ms=int((time.time()-started)*1000),
                                    task_id=prompt_id,
                                    first_frame_url=req.first_frame_url,
                                )
                raise TimeoutError("ComfyUI 视频生成超时")
        else:
            raise RuntimeError("首帧下载失败")

    async def _generate_mock(self, req: VideoGenerateRequest, started: float) -> VideoGenerateResult:
        # 下载首帧
        tmp_img = os.path.join(VIDEOS_DIR, f"tmp_first_{uuidlib.uuid4().hex[:6]}.png")
        first_url = req.first_frame_url or (req.reference_images[0] if req.reference_images else None)
        if not first_url:
            raise ValueError("Mock 模式也需要 first_frame_url")
        await _download_to_temp(first_url, tmp_img)
        out_path = os.path.join(VIDEOS_DIR, f"mock_{uuidlib.uuid4().hex[:8]}.mp4")
        is_real_video = _create_mock_video_from_image(tmp_img, out_path, duration=req.duration)
        # 清理临时
        try:
            os.remove(tmp_img)
        except Exception:
            pass
        rel = os.path.relpath(out_path, settings.STORAGE_DIR).replace("\\", "/")
        engine = "comfyui_video (mock-ffmpeg)" if is_real_video else "comfyui_video (mock-image-copy, 前端将降级显示首帧)"
        return VideoGenerateResult(
            video_url=f"/storage/{rel}",
            local_path=out_path,
            provider=self.id,
            engine=engine,
            duration=req.duration,
            elapsed_ms=int((time.time()-started)*1000),
            task_id=f"mock_{uuidlib.uuid4().hex[:6]}",
            first_frame_url=first_url,
            raw={"mock": True, "is_real_video": is_real_video},
        )
