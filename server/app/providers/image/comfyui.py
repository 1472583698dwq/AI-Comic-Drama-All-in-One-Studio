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
import copy
from ..workflow.manager import workflow_manager, upload_image_to_comfyui

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
            # 优先查找真正的图像输出（SaveImage/PreviewImage 等），兼容任意输出键
            for node_id, node_output in outputs.items():
                if not isinstance(node_output, dict):
                    continue
                # 标准 ComfyUI 输出为 images / gifs / videos 列表
                for key in ("images", "gifs", "videos"):
                    lst = node_output.get(key)
                    if isinstance(lst, list) and lst:
                        first = lst[0]
                        if isinstance(first, dict) and "filename" in first:
                            return first
                # 兜底：任意包含 filename 的列表
                for v in node_output.values():
                    if isinstance(v, list) and v and isinstance(v[0], dict) and "filename" in v[0]:
                        return v[0]
            if status.get("completed"):
                # 完成但未找到图像，尝试把 Preview 图像也视为有效（兼容 PreviewAny）
                node_keys = list(outputs.keys())
                # 打印详细输出供调试
                try:
                    import json as _json
                    print(f"[ComfyUI] 未捕获图像，完整 outputs: {_json.dumps(outputs, ensure_ascii=False)[:800]}")
                except Exception:
                    pass
                raise RuntimeError(f"ComfyUI 工作流已完成，但未捕获到图像输出 (已生成输出节点: {node_keys})，请确认工作流中包含有效且连通的 SaveImage/PreviewImage 节点。若工作流仅含 PreviewAny，请在 ComfyUI 中将 PreviewAny 替换为 SaveImage 或 PreviewImage 后重新导出")
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
            # 决定工作流来源：优先显式指定，否则使用系统默认配置的工作流
            target_wf_id = req.workflow_id or getattr(settings, "COMFYUI_DEFAULT_IMAGE_WORKFLOW", "")
            if target_wf_id:
                # 自定义工作流模式：支持内部+外部目录直读（外部id为 ext_*）
                if hasattr(workflow_manager, "get_workflow_with_meta"):
                    wf, meta = workflow_manager.get_workflow_with_meta(target_wf_id)
                else:
                    wf = workflow_manager.get_workflow(target_wf_id)
                    meta = workflow_manager.get_meta(target_wf_id)
                if not wf:
                    raise FileNotFoundError(f"工作流不存在: {target_wf_id}（若为外部工作流，请确认 COMFYUI_WORKFLOWS_DIR 配置正确）")
                if meta and not meta.get("is_api_format", True):
                    err = meta.get("error") or "自动转换失败"
                    hint = meta.get("hint") or "请在 ComfyUI 中用 File→Export (API Format) 重新导出"
                    raise ValueError(f"该工作流无法自动转换: {err} hint: {hint}")
                mapping = (meta or {}).get("mapping", {})
                style_suffix = STYLE_SUFFIX.get(req.style_preset, "") if req.style_preset else ""
                # 仅当用户明确指定了 model 或配置了全局 COMFYUI_CHECKPOINT 时才覆写自定义工作流中的模型
                checkpoint_to_inject = req.model or settings.COMFYUI_CHECKPOINT or None
                node_overrides = (meta or {}).get("node_overrides", {})
                # 节俭模式判定：API 原生（未经过 UI 转换）保持节俭，仅注入 mapping 指向节点；UI 转换后则全量覆盖原值
                is_api_frugally = False
                if meta:
                    auto_conv = meta.get("auto_converted", False)
                    is_api = meta.get("is_api_format", True)
                    # 若工作流本身为 API 格式且未经过自动转换，则视为节俭；否则（UI 转换而来）全量
                    is_api_frugally = (not auto_conv) and bool(is_api)

                # 处理外部表单动态输入的图片上传
                processed_dynamic_inputs = copy.deepcopy(req.dynamic_inputs or {})
                for k, v in list(processed_dynamic_inputs.items()):
                    if isinstance(v, dict):
                        for sub_k, sub_v in list(v.items()):
                            if sub_k == "image" and isinstance(sub_v, str) and (sub_v.startswith("data:image/") or sub_v.startswith("/storage/") or sub_v.startswith("http") or os.path.isabs(sub_v)):
                                try:
                                    uploaded_name = await upload_image_to_comfyui(sub_v, self.server_url)
                                    v[sub_k] = uploaded_name
                                except Exception as upload_err:
                                    print(f"[ComfyUI] 自动上传垫图失败: {upload_err}")
                    elif isinstance(v, str) and (str(k).startswith("img_") or "image" in str(k).lower()):
                        if v.startswith("data:image/") or v.startswith("/storage/") or v.startswith("http") or os.path.isabs(v):
                            try:
                                uploaded_name = await upload_image_to_comfyui(v, self.server_url)
                                processed_dynamic_inputs[k] = uploaded_name
                            except Exception as upload_err:
                                print(f"[ComfyUI] 自动上传垫图失败: {upload_err}")

                custom_steps = req.steps if req.steps is not None else None
                custom_cfg = req.cfg if req.cfg is not None else None

                injected = workflow_manager.inject_params(
                    wf,
                    mapping,
                    {
                        "prompt": req.prompt.strip(),
                        "negative_prompt": req.negative_prompt or DEFAULT_NEGATIVE,
                        "seed": final_seed,
                        "width": width,
                        "height": height,
                        "checkpoint": checkpoint_to_inject,
                        "steps": custom_steps,
                        "cfg": custom_cfg,
                        "style_suffix": style_suffix,
                    },
                    node_overrides=node_overrides,
                    dynamic_inputs=processed_dynamic_inputs,
                    is_api_frugally=is_api_frugally,
                )
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
            # 详细错误透传与友好诊断引导
            if submit_resp.status_code != 200:
                try:
                    err = submit_resp.json()
                    err_type = err.get("type") or (err.get("error", {}).get("type") if isinstance(err.get("error"), dict) else "")
                    if err_type == "missing_node_type" or "missing_node_type" in str(err):
                        extra = err.get("extra_info", {})
                        cls_name = extra.get("class_type") or err.get("message", "")
                        node_title = extra.get("node_title", "")
                        node_id = extra.get("node_id", "") or err.get("details", "")
                        raise RuntimeError(
                            f"ComfyUI 缺少运行此工作流所需的自定义插件节点 [{cls_name}] (节点: '{node_title}', ID #{node_id})。\n"
                            f"💡 解决方法：\n"
                            f"1. 请在 ComfyUI Manager (插件管理器) 中搜索并安装包含 '{cls_name}' 的插件包后重启 ComfyUI；\n"
                            f"2. 或在 ComfyUI 画布中移除或替换此节点后重新导出 API Format。"
                        )
                    detail = err.get("error") or err.get("node_errors") or submit_resp.text
                except RuntimeError:
                    raise
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
