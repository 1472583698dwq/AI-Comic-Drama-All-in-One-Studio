"""
ComfyUI 图片 Provider
支持两种模式：
1. 内置简易工作流（无workflow_id时，动态构建SDXL txt2img）
2. 自定义工作流（指定workflow_id，加载 storage/workflows/*.json 并注入参数）
"""
import asyncio
import os
import time
import uuid as uuidlib
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings
from .base import ImageProvider, ImageGenerateRequest, ImageGenerateResult
from ..workflow.manager import workflow_manager

STYLE_SUFFIX = {
    "donghua_xianxia": "chinese donghua anime style, xianxia fantasy, cinematic lighting, ethereal atmosphere, highly detailed illustration, masterpiece, best quality",
    "japanese_anime": "japanese anime style, makoto shinkai inspired, vibrant colors, ultra-detailed background, 4k anime visual, masterpiece, best quality",
    "modern_webtoon": "korean webtoon manhwa style, sharp clean line art, modern urban aesthetic, high contrast shading, masterpiece, best quality",
    "cinematic_3d": "unreal engine 5 render, pixar disney 3d animation quality, ray tracing, cinematic movie still, vivid expressions, masterpiece, best quality",
    "dark_comic": "dark graphic novel style, high contrast noir ink, moody shadows, gritty comic aesthetic, masterpiece, best quality",
}

DEFAULT_NEGATIVE = (
    "lowres, worst quality, low quality, blurry, bad anatomy, bad hands, "
    "extra fingers, missing fingers, watermark, signature, text, jpeg artifacts"
)

ASPECT_SIZES: Dict[str, tuple] = {
    "9:16": (832, 1216),
    "16:9": (1216, 832),
    "1:1": (1024, 1024),
}

GENERATED_DIR = os.path.join(settings.STORAGE_DIR, "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)


class ComfyUIUnavailableError(RuntimeError):
    pass


class ComfyUIProvider(ImageProvider):
    id = "comfyui"
    display_name = "ComfyUI (本地/云端)"
    description = "通过 ComfyUI HTTP API 执行工作流，支持自定义工作流导入"
    icon = "Cpu"
    category = "ai_generation"

    def __init__(self):
        self.client_id = str(uuidlib.uuid4())

    @property
    def server_url(self) -> str:
        return settings.COMFYUI_SERVER_URL.rstrip("/")

    async def check_health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.server_url}/system_stats")
                return resp.status_code == 200
        except Exception:
            return False

    def is_configured(self) -> bool:
        return bool(self.server_url)

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "supports_workflow": True,
            "supports_negative_prompt": True,
            "supports_seed": True,
            "supports_aspect_ratio": ["9:16", "16:9", "1:1"],
            "is_configured": self.is_configured(),
            "server_url": self.server_url,
        })
        return base

    async def _resolve_checkpoint(self, client: httpx.AsyncClient) -> str:
        if settings.COMFYUI_CHECKPOINT:
            return settings.COMFYUI_CHECKPOINT
        resp = await client.get(f"{self.server_url}/object_info/CheckpointLoaderSimple")
        resp.raise_for_status()
        choices: List[str] = resp.json()["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
        for name in choices:
            lowered = name.lower()
            if "xl" in lowered or "illustrious" in lowered:
                return name
        if choices:
            return choices[0]
        raise RuntimeError("ComfyUI 未安装任何 checkpoint 模型，请在 models/checkpoints 放入模型后重启")

    def _build_txt2img_workflow(
        self,
        checkpoint: str,
        positive_prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        seed: int,
        steps: int,
        cfg: float,
    ) -> Dict[str, Any]:
        return {
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive_prompt, "clip": ["4", 1]}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["4", 1]}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": "dpmpp_2m",
                    "scheduler": "karras",
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {
                "class_type": "SaveImage",
                "inputs": {"filename_prefix": f"storyboard/{self.client_id[:8]}", "images": ["8", 0]},
            },
        }

    async def _poll_for_output(self, client: httpx.AsyncClient, prompt_id: str, timeout_seconds: int) -> Dict[str, Any]:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            await asyncio.sleep(1.2)
            history_resp = await client.get(f"{self.server_url}/history/{prompt_id}")
            history_resp.raise_for_status()
            history = history_resp.json()
            entry = history.get(prompt_id)
            if not entry:
                continue
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                messages = status.get("messages", [])
                detail = str(messages[-1]) if messages else "未知执行错误"
                raise RuntimeError(f"ComfyUI 工作流执行失败: {detail}")
            outputs = entry.get("outputs", {})
            for node_output in outputs.values():
                images = node_output.get("images")
                if images:
                    return images[0]
        raise TimeoutError(f"ComfyUI 生图超时（>{timeout_seconds}s），任务可能仍在队列中: {prompt_id}")

    async def _download_image(self, client: httpx.AsyncClient, image_meta: Dict[str, Any]) -> bytes:
        params = {
            "filename": image_meta["filename"],
            "subfolder": image_meta.get("subfolder", ""),
            "type": image_meta.get("type", "output"),
        }
        view_resp = await client.get(f"{self.server_url}/view", params=params)
        view_resp.raise_for_status()
        return view_resp.content

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("生图提示词不能为空")

        # 归一化尺寸
        if req.width and req.height:
            width, height = req.width, req.height
        else:
            width, height = ASPECT_SIZES.get(req.aspect_ratio, ASPECT_SIZES["9:16"])

        final_seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little")
        timeout_seconds = settings.COMFYUI_TIMEOUT_SECONDS
        steps = max(8, min(50, req.steps or 24))
        cfg = max(1.0, min(12.0, req.cfg or 5.0))

        if not await self.check_health():
            raise ComfyUIUnavailableError(
                f"无法连接 ComfyUI 服务 ({self.server_url})。请确认 ComfyUI 已启动，或通过 COMFYUI_SERVER_URL 环境变量指定地址。"
            )

        started = time.time()
        async with httpx.AsyncClient(timeout=15.0) as client:
            # 决定工作流来源
            if req.workflow_id:
                # 自定义工作流模式：自动注入提示词/尺寸/随机种子，并智能处理 checkpoint
                wf = workflow_manager.get_workflow(req.workflow_id)
                meta = workflow_manager.get_meta(req.workflow_id)
                if not wf:
                    raise FileNotFoundError(f"工作流不存在: {req.workflow_id}")
                mapping = (meta or {}).get("mapping", {})
                style_suffix = STYLE_SUFFIX.get(req.style_preset, "") if req.style_preset else ""
                # 若用户未指定checkpoint且配置也为空，则自动探测可用checkpoint并注入
                checkpoint_to_inject = settings.COMFYUI_CHECKPOINT or req.model
                if not checkpoint_to_inject:
                    try:
                        checkpoint_to_inject = await self._resolve_checkpoint(client)
                    except Exception:
                        checkpoint_to_inject = None
                injected = workflow_manager.inject_params(wf, mapping, {
                    "prompt": req.prompt.strip(),
                    "negative_prompt": req.negative_prompt or DEFAULT_NEGATIVE,
                    "seed": final_seed,
                    "width": width,
                    "height": height,
                    "checkpoint": checkpoint_to_inject,
                    "steps": steps,
                    "cfg": cfg,
                    "style_suffix": style_suffix,
                })
                workflow = injected
                checkpoint_name = checkpoint_to_inject or settings.COMFYUI_CHECKPOINT or "custom-workflow"
            else:
                # 内置简易工作流
                checkpoint = await self._resolve_checkpoint(client)
                checkpoint_name = checkpoint
                positive = req.prompt.strip()
                if req.style_preset and req.style_preset in STYLE_SUFFIX:
                    positive = f"{positive}, {STYLE_SUFFIX[req.style_preset]}"
                workflow = self._build_txt2img_workflow(
                    checkpoint=checkpoint,
                    positive_prompt=positive,
                    negative_prompt=req.negative_prompt or DEFAULT_NEGATIVE,
                    width=width,
                    height=height,
                    seed=final_seed,
                    steps=steps,
                    cfg=cfg,
                )

            # 提交
            submit_resp = await client.post(
                f"{self.server_url}/prompt",
                json={"prompt": workflow, "client_id": self.client_id},
            )
            # 详细错误透传
            if submit_resp.status_code != 200:
                try:
                    err = submit_resp.json()
                    detail = err.get("error") or err.get("node_errors") or submit_resp.text
                except Exception:
                    detail = submit_resp.text
                raise RuntimeError(f"ComfyUI 提交失败 HTTP {submit_resp.status_code}: {detail}")

            prompt_id = submit_resp.json()["prompt_id"]
            image_meta = await self._poll_for_output(client, prompt_id, timeout_seconds)
            image_bytes = await self._download_image(client, image_meta)

        filename = f"gen_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
        filepath = os.path.join(GENERATED_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(image_bytes)

        return ImageGenerateResult(
            image_url=f"/storage/generated/{filename}",
            local_path=filepath,
            provider=self.id,
            seed=final_seed,
            width=width,
            height=height,
            elapsed_ms=int((time.time() - started) * 1000),
            engine=f"comfyui ({checkpoint_name})",
            prompt_id=prompt_id,
            checkpoint=checkpoint_name,
        )
