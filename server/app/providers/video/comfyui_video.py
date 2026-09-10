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

    def get_capabilities(self) -> Dict[str, Any]:
        cap = super().get_capabilities()
        cap["supports_workflow"] = True
        return cap

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

        # 若提供了 workflow_id 或配置了系统默认视频工作流，尝试走真实 ComfyUI 视频工作流
        target_wf_id = req.workflow_id or getattr(settings, "COMFYUI_DEFAULT_VIDEO_WORKFLOW", "")
        if target_wf_id:
            try:
                req_copy = VideoGenerateRequest(
                    prompt=req.prompt,
                    mode=req.mode,
                    first_frame_url=req.first_frame_url,
                    last_frame_url=req.last_frame_url,
                    reference_images=req.reference_images,
                    reference_videos=req.reference_videos,
                    reference_audios=req.reference_audios,
                    duration=req.duration,
                    resolution=req.resolution,
                    aspect_ratio=req.aspect_ratio,
                    seed=req.seed,
                    workflow_id=target_wf_id,
                    provider=req.provider,
                    dynamic_inputs=req.dynamic_inputs,
                    extra=req.extra
                )
                return await self._generate_via_workflow(req_copy, started)
            except Exception as e:
                # 降级到 Mock 并附带警告
                print(f"[ComfyUIVideo] workflow {target_wf_id} 执行失败，降级 Mock: {e}")
                # fallthrough to mock

        # Mock 生成：首帧循环为视频
        return await self._generate_mock(req, started)

    async def _generate_via_workflow(self, req: VideoGenerateRequest, started: float) -> VideoGenerateResult:
        from app.providers.workflow.manager import workflow_manager, upload_image_to_comfyui
        # 支持视频工作流同样存储在 workflows 目录（复用 manager）
        wf, meta = workflow_manager.get_workflow_with_meta(req.workflow_id) if hasattr(workflow_manager, "get_workflow_with_meta") else (workflow_manager.get_workflow(req.workflow_id), workflow_manager.get_meta(req.workflow_id))
        if not wf:
            raise FileNotFoundError(f"视频工作流不存在: {req.workflow_id}")
        server_url = getattr(settings, "COMFYUI_SERVER_URL", "http://127.0.0.1:8188").rstrip("/")

        # 1. 上传所有输入图像/视频/音频到 ComfyUI，获取内部文件名
        uploaded_first = ""
        uploaded_last = ""
        uploaded_refs: list[str] = []
        uploaded_vids: list[str] = []
        uploaded_auds: list[str] = []

        async def _upload_one(src: str) -> str:
            if not src:
                return ""
            # 复用 manager 的上传工具，自动处理 /storage, http, base64, 本地路径并保留文件类型
            return await upload_image_to_comfyui(src, server_url)

        try:
            if req.first_frame_url:
                uploaded_first = await _upload_one(req.first_frame_url)
            if req.last_frame_url:
                uploaded_last = await _upload_one(req.last_frame_url)
            if req.reference_images:
                for ref in req.reference_images:
                    if ref:
                        uploaded_refs.append(await _upload_one(ref))
            if getattr(req, "reference_videos", None):
                for vid in req.reference_videos:
                    if vid:
                        uploaded_vids.append(await _upload_one(vid))
            if getattr(req, "reference_audios", None):
                for aud in req.reference_audios:
                    if aud:
                        uploaded_auds.append(await _upload_one(aud))
            # 若 R2V 模式下未提供 first_frame 但有参考，取首张参考作为首帧兜底（兼容旧前端）
            if not uploaded_first and uploaded_refs and req.mode == "r2v":
                uploaded_first = uploaded_refs[0]
        except Exception as e:
            raise RuntimeError(f"上传参考媒体到 ComfyUI 失败: {e}")

        # 处理外部表单动态输入的图片/视频/音频上传
        import copy
        processed_dynamic_inputs = copy.deepcopy(req.dynamic_inputs or {})
        for k, v in list(processed_dynamic_inputs.items()):
            if isinstance(v, list):
                new_list = []
                for item in v:
                    if isinstance(item, str) and (item.startswith("data:") or item.startswith("/storage/") or item.startswith("http") or os.path.isabs(item)):
                        try:
                            new_list.append(await _upload_one(item))
                        except Exception as upload_err:
                            print(f"[ComfyUIVideo] 自动上传动态输入列表项失败: {upload_err}")
                            new_list.append(item)
                    else:
                        new_list.append(item)
                processed_dynamic_inputs[k] = new_list
            elif isinstance(v, dict):
                for sub_k, sub_v in list(v.items()):
                    if isinstance(sub_v, str) and (sub_v.startswith("data:") or sub_v.startswith("/storage/") or sub_v.startswith("http") or os.path.isabs(sub_v)):
                        try:
                            v[sub_k] = await _upload_one(sub_v)
                        except Exception as upload_err:
                            print(f"[ComfyUIVideo] 自动上传动态输入字典项失败: {upload_err}")
            elif isinstance(v, str) and (str(k).startswith(("img_", "aud_", "vid_")) or "image" in str(k).lower() or "video" in str(k).lower() or "audio" in str(k).lower() or v.startswith("data:") or v.startswith("/storage/")):
                if v.startswith("data:") or v.startswith("/storage/") or v.startswith("http") or os.path.isabs(v):
                    try:
                        processed_dynamic_inputs[k] = await _upload_one(v)
                    except Exception as upload_err:
                        print(f"[ComfyUIVideo] 自动上传动态输入媒体失败: {upload_err}")

        # 2. 判断节俭模式 vs 全量覆盖
        #    - API 原生工作流（auto_converted=False）保持节俭，仅注入 mapping 指向节点
        #    - UI 转换工作流（auto_converted=True）全量覆盖，页面参数覆盖原值
        is_api_frugally = False
        if meta:
            # meta 来自 manager，已包含 is_api_format / auto_converted
            auto_conv = meta.get("auto_converted", False)
            # 内部 API 格式且未经过转换，则节俭；外部/转换后则全量以保证 I2V/R2V 适配
            is_api_frugally = not auto_conv and meta.get("is_api_format", True) is not False

        # 3. 准备注入参数
        # 分辨率 -> 宽高
        width = height = None
        if req.resolution or req.aspect_ratio:
            RES_MAP = {
                "720p": {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)},
                "1080p": {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)},
                "480p": {"9:16": (480, 832), "16:9": (832, 480), "1:1": (480, 480)},
            }
            if req.resolution in RES_MAP and req.aspect_ratio in RES_MAP[req.resolution]:
                width, height = RES_MAP[req.resolution][req.aspect_ratio]

        mapping = (meta or {}).get("mapping", {})
        node_overrides = (meta or {}).get("node_overrides", {})

        video_params = {
            "prompt": req.prompt or "",
            "negative_prompt": "",  # 视频通常无单独负向，若需要可从 dynamic_inputs 取
            "first_frame_url": uploaded_first,
            "last_frame_url": uploaded_last,
            "reference_images": uploaded_refs,
            "reference_videos": uploaded_vids,
            "reference_audios": uploaded_auds,
            "width": width,
            "height": height,
            "resolution": req.resolution,
            "aspect_ratio": req.aspect_ratio,
            "duration": req.duration,
            "seed": req.seed,
            "mode": req.mode,
        }

        # 4. 通过 manager 的视频注入器生成最终工作流
        injected_wf = workflow_manager.inject_video_params(
            wf,
            mapping,
            video_params,
            node_overrides=node_overrides,
            dynamic_inputs=processed_dynamic_inputs,
            is_api_frugally=is_api_frugally,
        )

        # 5. 提交到 ComfyUI（已完成 I2V/R2V 图像上传与参数注入，支持节俭/API 与全量/UI 双模式）
        if True:
            async with httpx.AsyncClient(timeout=20.0) as client:
                # 提交前最后一道防线：剥离装饰/孤立未知节点；真实缺插件则提前抛友好错误
                try:
                    injected_wf, _stripped = workflow_manager.strip_unsupported_nodes(injected_wf)
                    if _stripped:
                        print(f"[ComfyUIVideo] 提交前已自动剥离 {len(_stripped)} 个装饰/无效节点: " + ", ".join(f"{s['class_type']}#{s['id']}" for s in _stripped[:8]))
                except RuntimeError:
                    raise
                except Exception as pre_e:
                    print(f"[ComfyUIVideo] 提交前检查跳过: {pre_e}")
                payload = {"prompt": injected_wf, "client_id": str(uuidlib.uuid4())}
                r = await client.post(f"{server_url}/prompt", json=payload)
                if r.status_code != 200:
                    try:
                        err = r.json()
                        err_type = err.get("type") or (err.get("error", {}).get("type") if isinstance(err.get("error"), dict) else "")
                        if err_type == "missing_node_type" or "missing_node_type" in str(err):
                            extra = err.get("extra_info", {})
                            cls_name = extra.get("class_type") or err.get("message", "")
                            node_title = extra.get("node_title", "")
                            node_id = extra.get("node_id", "") or err.get("details", "")
                            raise RuntimeError(
                                f"ComfyUI 缺少运行此视频工作流所需的自定义插件节点 [{cls_name}] (节点: '{node_title}', ID #{node_id})。\n"
                                f"💡 解决方法：\n"
                                f"1. 请在 ComfyUI Manager 中搜索并安装包含 '{cls_name}' 的插件包；\n"
                                f"2. 或在 ComfyUI 画布中移除或替换此节点后重新导出 API Format。"
                            )
                        detail = err.get("error") or err.get("node_errors") or r.text
                    except RuntimeError:
                        raise
                    except Exception:
                        detail = r.text
                    raise RuntimeError(f"ComfyUI 视频工作流提交失败 HTTP {r.status_code}: {detail}")

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
