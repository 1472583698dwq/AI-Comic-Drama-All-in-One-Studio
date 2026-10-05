"""
OpenAI 兼容图片 Provider
适用于任意支持 /v1/images/generations 的服务（OpenAI / Azure / 自建代理）
通过环境变量 OPENAI_IMAGE_BASE_URL / OPENAI_IMAGE_MODEL 配置
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


class OpenAICompatProvider(ImageProvider):
    id = "openai_compat"
    display_name = "OpenAI 兼容 (DALL·E / 代理)"
    description = "兼容 OpenAI /v1/images/generations 协议的任意生图服务"
    icon = "Globe"
    category = "ai_generation"

    def _api_key(self) -> str:
        """生图专用 Key 优先（OPENAI_IMAGE_API_KEY）；留空回退文本网关的 OPENAI_API_KEY。"""
        return (getattr(settings, "OPENAI_IMAGE_API_KEY", "") or getattr(settings, "OPENAI_API_KEY", "") or "").strip()

    def _base_url(self) -> str:
        """生图专用地址优先（OPENAI_IMAGE_BASE_URL）；留空回退 OPENAI_BASE_URL。"""
        return (getattr(settings, "OPENAI_IMAGE_BASE_URL", "") or getattr(settings, "OPENAI_BASE_URL", "") or "").strip().rstrip("/")

    def is_configured(self) -> bool:
        return bool(self._api_key() and self._base_url())

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            base = self._base_url()
            url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(url, headers={"Authorization": f"Bearer {self._api_key()}"})
                return r.status_code in (200, 404)  # 404也说明服务在线只是无此接口
        except Exception:
            return False

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("提示词不能为空")
        api_key = self._api_key()
        if not api_key:
            raise RuntimeError("OPENAI_IMAGE_API_KEY / OPENAI_API_KEY 未配置")

        started = time.time()
        base = self._base_url()
        # 兼容 base 已包含 /v1 的情况
        if base.endswith("/chat/completions"):
            base = base.replace("/chat/completions", "")
        if base.endswith("/v1"):
            url = f"{base}/images/generations"
        else:
            url = f"{base}/v1/images/generations"
        model = (req.model or getattr(settings, "OPENAI_IMAGE_MODEL", "") or "gpt-image-2.5-flare").strip()
        # 模型族不同，尺寸/返回格式都不同：
        # - gpt-image-1 / 1.5 / 2 只接受 1024x1024 / 1536x1024 / 1024x1536，且恒返回 b64_json（不支持 response_format）
        # - dall-e-3 支持 1792x1024 / 1024x1792，且必须显式 response_format=url
        is_gpt_image = model.startswith("gpt-image") or model.startswith("chatgpt-image")
        if is_gpt_image:
            size_map = {"1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536",
                        "4:3": "1536x1024", "3:4": "1024x1536"}
        else:
            size_map = {"1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792",
                        "4:3": "1792x1024", "3:4": "1024x1792"}
        size = size_map.get(req.aspect_ratio, "1024x1024")
        if req.width and req.height:
            size = f"{req.width}x{req.height}"

        payload: Dict[str, Any] = {
            "model": model,
            "prompt": req.prompt.strip(),
            "n": 1,
            "size": size,
        }
        if not is_gpt_image:
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
