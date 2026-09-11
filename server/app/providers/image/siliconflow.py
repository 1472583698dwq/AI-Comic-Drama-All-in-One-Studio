"""
SiliconFlow 图片 Provider
API: https://api.siliconflow.cn/v1/images/generations
支持 Flux 等模型，URL 1小时有效需立即下载落盘
"""
import os
import time
import uuid as uuidlib
import httpx
from typing import Dict, Any

from app.core.config import settings
from .base import ImageProvider, ImageGenerateRequest, ImageGenerateResult

ASPECT_TO_SIZE = {
    "9:16": "576x1024",
    "16:9": "1024x576",
    "1:1": "1024x1024",
    # 额外支持 3:4 /4:3 也映射
    "3:4": "768x1024",
    "4:3": "1024x768",
}

GENERATED_DIR = os.path.join(settings.STORAGE_DIR, "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)


class SiliconFlowProvider(ImageProvider):
    id = "siliconflow"
    display_name = "硅基流动 SiliconFlow"
    description = "硅基流动云端生图，支持 FLUX/Qwen-Image 等，高速低成本"
    icon = "Cloud"
    category = "ai_generation"

    def is_configured(self) -> bool:
        return bool(settings.SILICONFLOW_API_KEY)

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(
                    "https://api.siliconflow.cn/v1/user/info",
                    headers={"Authorization": f"Bearer {settings.SILICONFLOW_API_KEY}"},
                )
                return r.status_code == 200
        except Exception:
            return False

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "supports_workflow": False,
            "supports_negative_prompt": True,
            "supports_aspect_ratio": list(ASPECT_TO_SIZE.keys()),
            "is_configured": self.is_configured(),
            "default_model": settings.SILICONFLOW_IMAGE_MODEL,
        })
        return base

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("提示词不能为空")
        if not settings.SILICONFLOW_API_KEY:
            raise RuntimeError("SILICONFLOW_API_KEY 未配置，请在系统配置中填入")

        started = time.time()
        model = req.model or settings.SILICONFLOW_IMAGE_MODEL or "black-forest-labs/FLUX.1-schnell"
        # 尺寸映射
        image_size = ASPECT_TO_SIZE.get(req.aspect_ratio, "1024x1024")
        # 允许覆盖 width/height 但需映射到枚举
        if req.width and req.height:
            # 找最接近的枚举
            candidate = f"{req.width}x{req.height}"
            if candidate in ASPECT_TO_SIZE.values():
                image_size = candidate

        seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little") % 9999999999

        payload: Dict[str, Any] = {
            "model": model,
            "prompt": req.prompt.strip(),
            "image_size": image_size,
            "seed": seed,
        }
        if req.negative_prompt:
            # 部分模型支持 negative_prompt
            payload["negative_prompt"] = req.negative_prompt
        # steps/cfg 部分模型支持
        if req.steps:
            payload["num_inference_steps"] = max(1, min(50, req.steps))
        if req.cfg:
            payload["cfg"] = float(req.cfg)

        headers = {
            "Authorization": f"Bearer {settings.SILICONFLOW_API_KEY}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=1200.0) as client:
            resp = await client.post(
                "https://api.siliconflow.cn/v1/images/generations",
                headers=headers,
                json=payload,
            )
            if resp.status_code != 200:
                detail = resp.text[:500]
                raise RuntimeError(f"SiliconFlow 生图失败 HTTP {resp.status_code}: {detail}")
            data = resp.json()
            # 响应格式：{images: [{url}], ...} 或 {data: [{url}]}
            image_url = None
            if "images" in data and data["images"]:
                image_url = data["images"][0].get("url")
            elif "data" in data and data["data"]:
                image_url = data["data"][0].get("url")
            elif "image" in data:
                image_url = data["image"]
            if not image_url:
                raise RuntimeError(f"SiliconFlow 未返回图片URL: {str(data)[:300]}")

            # 下载落盘（URL 1h过期）
            img_resp = await client.get(image_url, timeout=30.0)
            img_resp.raise_for_status()
            image_bytes = img_resp.content

        # 解析尺寸
        try:
            w_str, h_str = image_size.split("x")
            width, height = int(w_str), int(h_str)
        except Exception:
            width, height = 1024, 1024

        filename = f"sf_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
        filepath = os.path.join(GENERATED_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(image_bytes)

        return ImageGenerateResult(
            image_url=f"/storage/generated/{filename}",
            local_path=filepath,
            provider=self.id,
            seed=seed,
            width=width,
            height=height,
            elapsed_ms=int((time.time() - started) * 1000),
            engine=f"siliconflow ({model})",
            prompt_id=None,
            raw=data,
        )
