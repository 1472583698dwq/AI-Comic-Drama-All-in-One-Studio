"""
DashScope (阿里通义万象) 图片 Provider
支持 wan2.7-image / wanx 等模型
API 文档：https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis
为简化，采用兼容的同步接口；若需异步轮询可扩展
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

ASPECT_TO_SIZE = {
    "9:16": "928x1664",
    "16:9": "1664x928",
    "1:1": "1328x1328",
    "3:4": "1140x1472",
    "4:3": "1472x1140",
}


class DashScopeProvider(ImageProvider):
    id = "dashscope"
    display_name = "阿里通义万象 DashScope"
    description = "阿里云 DashScope 视觉大模型，支持万相 wan2.7 文生图"
    icon = "Sparkles"
    category = "ai_generation"

    def is_configured(self) -> bool:
        return bool(settings.DASHSCOPE_API_KEY)

    async def check_health(self) -> bool:
        # DashScope 无简单健康检查，用key存在即认为可用，真实调用时校验
        return self.is_configured()

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "supports_workflow": False,
            "supports_negative_prompt": True,
            "supports_aspect_ratio": list(ASPECT_TO_SIZE.keys()),
            "is_configured": self.is_configured(),
        })
        return base

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("提示词不能为空")
        if not settings.DASHSCOPE_API_KEY:
            raise RuntimeError("DASHSCOPE_API_KEY 未配置，请在系统配置中填入")

        started = time.time()
        # 模型选择：优先 req.model，其次环境变量，最后默认
        model = req.model or getattr(settings, "DASHSCOPE_IMAGE_MODEL", "") or "wanx2.1-t2i-turbo"
        # DashScope 常见模型：wanx2.1-t2i-turbo / wan2.7-image 等
        size = ASPECT_TO_SIZE.get(req.aspect_ratio, "1328x1328")
        seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little") % 999999999

        # 尝试 OpenAI 兼容透传？DashScope 新版支持 /api/v1/services/aigc/text2image/image-synthesis
        # 为兼容多种模型，先尝试通用 DashScope 图像合成接口
        headers = {
            "Authorization": f"Bearer {settings.DASHSCOPE_API_KEY}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "disable",
        }
        # 负向提示词处理
        prompt = req.prompt.strip()
        if req.negative_prompt:
            # 部分模型支持 negative_prompt 字段
            pass

        payload = {
            "model": model,
            "input": {
                "prompt": prompt,
            },
            "parameters": {
                "size": size,
                "n": 1,
                "seed": seed,
            }
        }
        if req.negative_prompt:
            payload["parameters"]["negative_prompt"] = req.negative_prompt
        if req.steps:
            payload["parameters"]["steps"] = int(req.steps)

        # 兼容 siliconflow-like 的直接文本字段也尝试
        # 对于 wan 模型，可能需要 prompt_enhancement
        url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"

        async with httpx.AsyncClient(timeout=1200.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                # 尝试回退到 OpenAI 兼容图片接口（若用户配置了自定义模型）
                detail = resp.text[:800]
                raise RuntimeError(f"DashScope 生图失败 HTTP {resp.status_code}: {detail}")
            data = resp.json()
            # DashScope 返回结构：{output: {results: [{url}]}} 或 {output: {choices: [...]}} 或 {data: [...]}
            image_url = None
            # 常见结构1
            if "output" in data and isinstance(data["output"], dict):
                out = data["output"]
                if "results" in out and out["results"]:
                    image_url = out["results"][0].get("url")
                elif "choices" in out and out["choices"]:
                    image_url = out["choices"][0].get("message", {}).get("content", [{}])[0].get("image")
                elif "image_url" in out:
                    image_url = out["image_url"]
                elif "url" in out:
                    image_url = out["url"]
            if not image_url and "data" in data and data["data"]:
                image_url = data["data"][0].get("url")
            if not image_url and "images" in data and data["images"]:
                image_url = data["images"][0].get("url")
            if not image_url:
                # 可能是异步任务，需要轮询
                if "output" in data and "task_id" in data["output"]:
                    task_id = data["output"]["task_id"]
                    image_url = await self._poll_task(client, task_id, headers)
                else:
                    raise RuntimeError(f"DashScope 未返回图片URL: {str(data)[:500]}")

            # 下载
            img_resp = await client.get(image_url, timeout=30.0)
            img_resp.raise_for_status()
            image_bytes = img_resp.content

        try:
            w_str, h_str = size.split("x")
            width, height = int(w_str), int(h_str)
        except Exception:
            width, height = 1328, 1328

        filename = f"ds_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
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
            engine=f"dashscope ({model})",
            raw=data,
        )

    async def _poll_task(self, client: httpx.AsyncClient, task_id: str, headers: Dict[str, str]) -> str:
        import asyncio
        url = f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
        for _ in range(600):
            await asyncio.sleep(2)
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                continue
            data = resp.json()
            status = data.get("output", {}).get("task_status") or data.get("status")
            if status == "SUCCEEDED":
                results = data.get("output", {}).get("results", [])
                if results:
                    return results[0].get("url")
            elif status == "FAILED":
                raise RuntimeError(f"DashScope 任务失败: {data}")
        raise TimeoutError(f"DashScope 任务轮询超时: {task_id}")
