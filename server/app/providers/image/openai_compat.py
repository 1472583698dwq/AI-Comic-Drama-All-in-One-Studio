"""
OpenAI 兼容图片 Provider（设置中心「生图 → 自定义（OpenAI 兼容）」通道）
适用于任意支持 /v1/images/generations 的服务（OpenAI / Azure / 中转站 / 自建代理）

Key 独立：优先用 OPENAI_IMAGE_API_KEY；只有它为空时才回退复用文本大模型的 OPENAI_API_KEY
（旧配置兼容）。地址与模型分别由 OPENAI_IMAGE_BASE_URL / OPENAI_IMAGE_MODEL 指定，
地址留空才回退文本大模型的 OPENAI_BASE_URL。
"""
import os
import time
import uuid as uuidlib
import httpx
from typing import Dict, Any

from app.core.config import settings
from .base import ImageProvider, ImageGenerateRequest, ImageGenerateResult

GENERATED_DIR = os.path.join(settings.STORAGE_DIR, "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)


def image_api_key() -> str:
    """生图专用 Key 优先；留空回退文本大模型的 Key（旧配置兼容）。"""
    return (
        getattr(settings, "OPENAI_IMAGE_API_KEY", "")
        or getattr(settings, "OPENAI_API_KEY", "")
        or ""
    ).strip()


def image_base_url() -> str:
    """生图接口地址：OPENAI_IMAGE_BASE_URL 优先，留空回退文本大模型的地址。"""
    return (
        getattr(settings, "OPENAI_IMAGE_BASE_URL", "")
        or getattr(settings, "OPENAI_BASE_URL", "")
        or ""
    ).strip().rstrip("/")


class OpenAICompatProvider(ImageProvider):
    id = "openai_compat"
    display_name = "自定义 (OpenAI 兼容生图)"
    description = "兼容 OpenAI /v1/images/generations 协议的任意生图服务，独立 Key / 地址 / 模型"
    icon = "Globe"
    category = "ai_generation"

    def is_configured(self) -> bool:
        return bool(image_api_key() and image_base_url())

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            base = image_base_url()
            probe = base if base.endswith("/v1") else f"{base}/v1"
            # 尝试 /models 接口
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(
                    f"{probe}/models",
                    headers={"Authorization": f"Bearer {image_api_key()}"},
                )
                return r.status_code in (200, 404)  # 404也说明服务在线只是无此接口
        except Exception:
            return False

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("提示词不能为空")
        api_key = image_api_key()
        if not api_key:
            raise RuntimeError(
                "生图 Key 未配置：请在「设置 → 能力配置 → 生图 → 自定义（OpenAI 兼容）」里填 OPENAI_IMAGE_API_KEY"
            )

        started = time.time()
        base = image_base_url()
        if not base:
            raise RuntimeError(
                "生图接口地址未配置：请填 OPENAI_IMAGE_BASE_URL（或给文本大模型配一个 OPENAI_BASE_URL 作为回退）"
            )
        # 兼容 base 已包含 /v1 或误填到具体端点的情况
        if base.endswith("/chat/completions"):
            base = base.replace("/chat/completions", "")
        if base.endswith("/images/generations"):
            url = base
        elif base.endswith("/v1"):
            url = f"{base}/images/generations"
        else:
            url = f"{base}/v1/images/generations"
        model = req.model or getattr(settings, "OPENAI_IMAGE_MODEL", "") or "dall-e-3"
        # 尺寸映射：dall-e-3 支持 1024x1024, 1792x1024, 1024x1792
        size_map = {
            "1:1": "1024x1024",
            "16:9": "1792x1024",
            "9:16": "1024x1792",
        }
        size = size_map.get(req.aspect_ratio, "1024x1024")
        if req.width and req.height:
            size = f"{req.width}x{req.height}"

        payload: Dict[str, Any] = {
            "model": model,
            "prompt": req.prompt.strip(),
            "n": 1,
            "size": size,
        }
        # dall-e-3 支持 response_format；gpt-image-1 等新模型只返回 b64，不认该字段
        if "dall-e" in model.lower():
            payload["response_format"] = "url"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=1200.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"OpenAI兼容生图失败 HTTP {resp.status_code}: {resp.text[:500]}")
            data = resp.json()
            # 标准响应 {data:[{url}]}
            if "data" not in data or not data["data"]:
                raise RuntimeError(f"未返回图片: {str(data)[:300]}")
            item = data["data"][0]
            image_url = item.get("url")
            b64 = item.get("b64_json")
            if b64:
                import base64
                image_bytes = base64.b64decode(b64)
            elif image_url:
                img_resp = await client.get(image_url, timeout=30.0)
                img_resp.raise_for_status()
                image_bytes = img_resp.content
            else:
                raise RuntimeError(f"响应无url/b64_json: {str(data)[:300]}")

        # 解析尺寸
        try:
            w_str, h_str = size.split("x")
            width, height = int(w_str), int(h_str)
        except Exception:
            width, height = 1024, 1024

        seed = req.seed or 0
        filename = f"oai_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
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
            engine=f"openai_compat ({model})",
            raw=data,
        )
