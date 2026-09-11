"""
ComfyUI 真实生图管线
通过 ComfyUI HTTP API (POST /prompt + /history 轮询 + /view 下载) 提交 SDXL 工作流，
生成漫剧分镜图与角色三视图，落盘到 storage/generated/ 并返回可访问的本地 URL。
"""
import asyncio
import os
import time
import uuid as uuidlib
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

STYLE_SUFFIX = {
    "donghua_xianxia": "chinese donghua anime style, xianxia fantasy, cinematic lighting, ethereal atmosphere, highly detailed illustration, masterpiece, best quality",
    "japanese_anime": "japanese anime style, makoto shinkai inspired, vibrant colors, ultra-detailed background, 4k anime visual, masterpiece, best quality",
    "modern_webtoon": "korean webtoon manhwa style, sharp clean line art, modern urban aesthetic, high contrast shading, masterpiece, best quality",
    "cinematic_3d": "unreal engine 5 render, pixar disney 3d animation quality, ray tracing, cinematic movie still, vivid expressions, masterpiece, best quality",
    "dark_comic": "dark graphic novel style, high contrast noir ink, moody shadows, gritty comic aesthetic, masterpiece, best quality",
    "pure_white_aesthetic": "pure white aesthetic, high-key lighting, clean white minimalist anime style, bright ethereal atmosphere, soft subtle shadows, delicate elegant linework, pristine studio clean lighting, masterpiece, ultra-detailed, 8k resolution",
    "white_minimalist": "pure white aesthetic, high-key lighting, clean white minimalist anime style, bright ethereal atmosphere, soft subtle shadows, delicate elegant linework, pristine studio clean lighting, masterpiece, ultra-detailed, 8k resolution",
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
    """ComfyUI 服务不可达"""


class ComfyUIImagePipeline:
    def __init__(self):
        self.server_url = settings.COMFYUI_SERVER_URL.rstrip("/")
        self.client_id = str(uuidlib.uuid4())

    # ---------- health & discovery ----------

    async def check_health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.server_url}/system_stats")
                return resp.status_code == 200
        except Exception:
            return False

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

    # ---------- workflow ----------

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

    # ---------- generation ----------

    async def generate_image(
        self,
        prompt: str,
        negative_prompt: str = DEFAULT_NEGATIVE,
        aspect_ratio: str = "9:16",
        style_preset: Optional[str] = None,
        steps: int = 24,
        cfg: float = 5.0,
        seed: Optional[int] = None,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not prompt or not prompt.strip():
            raise ValueError("生图提示词不能为空")

        width, height = ASPECT_SIZES.get(aspect_ratio, ASPECT_SIZES["9:16"])
        final_seed = seed if seed is not None else int.from_bytes(os.urandom(4), "little")
        timeout_seconds = timeout_seconds or settings.COMFYUI_TIMEOUT_SECONDS

        if not await self.check_health():
            raise ComfyUIUnavailableError(
                f"无法连接 ComfyUI 服务 ({self.server_url})。请确认 ComfyUI 已启动，或通过 COMFYUI_SERVER_URL 环境变量指定地址。"
            )

        started = time.time()
        async with httpx.AsyncClient(timeout=1200.0) as client:
            checkpoint = await self._resolve_checkpoint(client)
            positive = prompt.strip()
            if style_preset and style_preset in STYLE_SUFFIX:
                positive = f"{positive}, {STYLE_SUFFIX[style_preset]}"

            workflow = self._build_txt2img_workflow(
                checkpoint=checkpoint,
                positive_prompt=positive,
                negative_prompt=negative_prompt or DEFAULT_NEGATIVE,
                width=width,
                height=height,
                seed=final_seed,
                steps=max(8, min(50, steps)),
                cfg=max(1.0, min(12.0, cfg)),
            )

            submit_resp = await client.post(
                f"{self.server_url}/prompt",
                json={"prompt": workflow, "client_id": self.client_id},
            )
            submit_resp.raise_for_status()
            prompt_id = submit_resp.json()["prompt_id"]

            image_meta = await self._poll_for_output(client, prompt_id, timeout_seconds)
            image_bytes = await self._download_image(client, image_meta)

        filename = f"gen_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
        filepath = os.path.join(GENERATED_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(image_bytes)

        return {
            "image_url": f"/storage/generated/{filename}",
            "local_path": filepath,
            "prompt_id": prompt_id,
            "checkpoint": checkpoint,
            "seed": final_seed,
            "width": width,
            "height": height,
            "elapsed_ms": int((time.time() - started) * 1000),
            "engine": f"comfyui ({checkpoint})",
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


comfyui_pipeline = ComfyUIImagePipeline()
