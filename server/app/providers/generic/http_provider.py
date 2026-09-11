"""
Generic HTTP Provider - 支持任意 HTTP API 的通用生成源
通过 ProviderDefinition 的 request_template / response_mappings 动态渲染请求并解析响应
复用现有存储与落盘逻辑
"""
import os
import time
import json
import uuid as uuidlib
import re
import asyncio
from typing import Dict, Any, Optional, List
import httpx

from app.models.provider_definition import ProviderDefinition
from app.providers.image.base import ImageProvider, ImageGenerateRequest, ImageGenerateResult
from app.providers.audio.base import AudioProvider, AudioGenerateRequest, AudioGenerateResult
from app.providers.video.base import VideoProvider, VideoGenerateRequest, VideoGenerateResult


def _get_api_key_for_provider(provider_id: str, definition: ProviderDefinition) -> str:
    """从多种来源解析 API Key：环境变量 / config_store.json / definition.auth"""
    # 1. 优先从环境变量 key_env 指向
    if definition.auth.key_env:
        val = os.getenv(definition.auth.key_env, "")
        if val:
            return val
    # 2. 尝试从 STORAGE_DIR/config_store.json 中按 provider_id 读取
    try:
        from app.core.config import settings
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                # 约定 key 为 CUSTOM_PROVIDER_{id} 或 provider_id
                for k in [f"CUSTOM_PROVIDER_{provider_id}", provider_id, definition.auth.key_env or ""]:
                    if k and data.get(k):
                        return str(data[k])
                # 尝试在 custom_providers 字段
                cp = data.get("custom_providers", {})
                if isinstance(cp, dict) and provider_id in cp:
                    entry = cp[provider_id]
                    if isinstance(entry, dict) and entry.get("api_key"):
                        return str(entry["api_key"])
                    if isinstance(entry, str):
                        return entry
    except Exception:
        pass
    # 3. 尝试从 headers/query 模板中已填的明文提取（仅用于兼容旧数据）
    return ""


def _render_template(obj: Any, context: Dict[str, Any], api_key: str = "") -> Any:
    """递归渲染模板：支持 {prompt} {negative_prompt} {width} {height} {seed} {model} {api_key} 等"""
    if isinstance(obj, str):
        # 替换 {var} 占位
        def repl(m):
            key = m.group(1).strip()
            if key == "api_key":
                return api_key or ""
            return str(context.get(key, m.group(0)))
        # 支持 {{var}} 和 {var}
        rendered = re.sub(r"\{\{\s*(\w+)\s*\}\}", repl, obj)
        rendered = re.sub(r"\{\s*(\w+)\s*\}", repl, rendered)
        return rendered
    elif isinstance(obj, dict):
        return {k: _render_template(v, context, api_key) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_render_template(x, context, api_key) for x in obj]
    else:
        return obj


def _extract_by_path(data: Any, path: str) -> Any:
    """简化 JSONPath：支持 a.b.c, a[0].b, a[0][1] 等"""
    if not path:
        return None
    cur = data
    # 分割 by '.' 但保留 [index]
    parts = re.split(r"\.", path)
    for part in parts:
        # 处理 a[0][1]
        m = re.match(r"^(\w+)((?:\[\d+\])*)$", part)
        if m:
            key = m.group(1)
            indices = re.findall(r"\[(\d+)\]", m.group(2) or "")
            if isinstance(cur, dict):
                cur = cur.get(key)
            else:
                return None
            for idx in indices:
                if isinstance(cur, list):
                    try:
                        cur = cur[int(idx)]
                    except Exception:
                        return None
                else:
                    return None
        elif part.startswith("[") and part.endswith("]"):
            # [0]
            try:
                idx = int(part[1:-1])
                if isinstance(cur, list):
                    cur = cur[idx]
                else:
                    return None
            except Exception:
                return None
        else:
            # 纯 key 或数字索引
            if isinstance(cur, dict):
                cur = cur.get(part)
            elif isinstance(cur, list):
                try:
                    cur = cur[int(part)]
                except Exception:
                    return None
            else:
                return None
        if cur is None:
            return None
    return cur


def _resolve_storage_url(url: str, local_path: Optional[str] = None) -> str:
    return url


# ---------- 通用下载落盘 ----------

GENERATED_DIR = None
_CUSTOM_VIDEO_TASKS: Dict[str, Dict[str, Any]] = {}

def _get_generated_dir():
    global GENERATED_DIR
    if GENERATED_DIR is None:
        from app.core.config import settings
        GENERATED_DIR = os.path.join(settings.STORAGE_DIR, "generated")
        os.makedirs(GENERATED_DIR, exist_ok=True)
    return GENERATED_DIR


async def _download_to_storage(url: str, prefix: str = "gen") -> tuple[str, str]:
    """下载远程 url 到 storage/generated，返回 (storage_url, local_path)"""
    from app.core.config import settings
    gen_dir = _get_generated_dir()
    async with httpx.AsyncClient(timeout=40.0) as client:
        resp = await client.get(url, timeout=40.0)
        resp.raise_for_status()
        content = resp.content
        # 猜扩展名
        ct = resp.headers.get("content-type", "")
        ext = ".png"
        if "jpeg" in ct or "jpg" in ct:
            ext = ".jpg"
        elif "webp" in ct:
            ext = ".webp"
        elif "mp3" in ct or "mpeg" in ct:
            ext = ".mp3"
        elif "mp4" in ct:
            ext = ".mp4"
        elif "wav" in ct:
            ext = ".wav"
        elif url.endswith(".mp3"):
            ext = ".mp3"
        elif url.endswith(".mp4"):
            ext = ".mp4"
        filename = f"{prefix}_{int(time.time())}_{uuidlib.uuid4().hex[:8]}{ext}"
        # 视频与音频直接落 storage 视频目录，图片落 generated
        if ext in (".mp4", ".mov", ".webm"):
            videos_dir = os.path.join(settings.STORAGE_DIR, "videos")
            os.makedirs(videos_dir, exist_ok=True)
            local_path = os.path.join(videos_dir, filename)
            storage_url = f"/storage/videos/{filename}"
        else:
            local_path = os.path.join(gen_dir if ext in (".png",".jpg",".webp") else settings.STORAGE_DIR, filename)
            storage_url = f"/storage/generated/{filename}" if ext in (".png",".jpg",".webp") else f"/storage/{filename}"
            if ext in (".mp3",".wav"):
                storage_url = f"/storage/{filename}"
        with open(local_path, "wb") as f:
            f.write(content)
        return storage_url, local_path


async def _autodl_poll_and_download(task_id: str, poll_url: str, headers: Dict[str, str], provider_id: str):
    """后台轮询 AutoDL 异步任务，完成後下载并更新 _CUSTOM_VIDEO_TASKS"""
    from app.core.config import settings
    videos_dir = os.path.join(settings.STORAGE_DIR, "videos")
    os.makedirs(videos_dir, exist_ok=True)
    # 初始化状态（保留 node 上下文便于按节点隔离查询）
    _CUSTOM_VIDEO_TASKS[task_id] = {"status": "QUEUED", "task_id": task_id, "provider": provider_id, "created_at": time.time(), "node_id": None, "project_id": None}
    max_attempts = 300  # 最多 25 分钟 (300*5s)
    for _ in range(max_attempts):
        await asyncio.sleep(5.0)
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(poll_url, headers=headers, timeout=15)
                if resp.status_code != 200:
                    continue
                poll_data = resp.json()
                # 提取 status
                status = None
                for spath in ["data.status", "status"]:
                    v = _extract_by_path(poll_data, spath)
                    if v and isinstance(v, str):
                        status = v.upper()
                        break
                if status == "SUCCESS":
                    results = _extract_by_path(poll_data, "data.results") or _extract_by_path(poll_data, "results")
                    video_url = None
                    if isinstance(results, list) and results:
                        video_url = results[0] if isinstance(results[0], str) else None
                    if not video_url:
                        txt = json.dumps(poll_data, ensure_ascii=False)
                        m = re.search(r"https?://[^\s\"']+\.(mp4|mov|webm)", txt)
                        if m:
                            video_url = m.group(0)
                    if video_url:
                        try:
                            storage_url, local_path = await _download_to_storage(video_url, prefix="vid")
                            # 若下载到 generated，移动到 videos 目录保持一致
                            _CUSTOM_VIDEO_TASKS[task_id] = {"status": "SUCCESS", "task_id": task_id, "video_url": storage_url, "local_path": local_path, "provider": provider_id}
                            print(f"[CustomVideo] Task {task_id} SUCCESS -> {storage_url}")
                            return
                        except Exception as e:
                            print(f"[CustomVideo] download failed {task_id}: {e}")
                            _CUSTOM_VIDEO_TASKS[task_id] = {"status": "FAILED", "error": f"下载失败: {e}", "task_id": task_id}
                            return
                elif status == "FAILED":
                    err = _extract_by_path(poll_data, "data.error") or poll_data.get("msg") or "任务失败"
                    _CUSTOM_VIDEO_TASKS[task_id] = {"status": "FAILED", "error": str(err), "task_id": task_id}
                    print(f"[CustomVideo] Task {task_id} FAILED: {err}")
                    return
                else:
                    # 更新排队状态
                    _CUSTOM_VIDEO_TASKS[task_id].update({"status": status or "QUEUED", "last_poll": time.time()})
        except Exception as e:
            print(f"[CustomVideo] poll {task_id} exception: {e}")
    # 超时
    _CUSTOM_VIDEO_TASKS[task_id].update({"status": "TIMEOUT", "error": "轮询超时，请稍后重试"})


def get_custom_video_task(task_id: str) -> Optional[Dict[str, Any]]:
    hit = _CUSTOM_VIDEO_TASKS.get(task_id)
    if hit is not None:
        return hit
    # 穿透：代码视频源（H3 等提交即返 task_id 型）的任务落在 code_provider 表，前端 /videos/status
    # 与 MCP/canvas 轮询统一经此口径查询，无需各处重复兼容。
    try:
        from app.providers.generic.code_provider import get_code_video_task
        return get_code_video_task(task_id)
    except Exception:
        return None


# ---------- Generic Image Provider ----------

class GenericHttpImageProvider(ImageProvider):
    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.display_name = definition.get_display_name()
        self.description = definition.description or f"自定义 HTTP 生图：{definition.id}"
        self.icon = definition.icon or "Globe"
        self.category = "ai_generation"

    def is_configured(self) -> bool:
        # 若需要 auth 且无 key 则视为未配置
        if self.definition.auth.type != "none":
            key = _get_api_key_for_provider(self.id, self.definition)
            return bool(key)
        return bool(self.definition.transport.url)

    async def check_health(self) -> bool:
        # 若配置了 health_check.url 则请求，否则尝试 transport.url 的连通性
        hc = self.definition.health_check
        url = hc.url or self.definition.transport.url
        if not url:
            return False
        # 对于 API 生成类 health，无 key 则直接返回 is_configured
        if not self.is_configured():
            return False
        # 简单探测：GET health url，若无则返回 True（视为已配置即可）
        if hc.url:
            try:
                method = (hc.method or "GET").upper()
                async with httpx.AsyncClient(timeout=6.0) as client:
                    if method == "GET":
                        r = await client.get(url, timeout=6.0)
                    else:
                        r = await client.request(method, url, json=hc.test_payload or {}, timeout=6.0)
                    return r.status_code == hc.expect_status or 200 <= r.status_code < 300
            except Exception:
                return False
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "id": self.id,
            "display_name": self.display_name,
            "description": self.description,
            "provider_type": "http",
            "kind": "image",
            "supports_workflow": False,
            "is_configured": self.is_configured(),
            "models": self.definition.models,
            "default_model": self.definition.default_model,
            "params_schema": self.definition.params_schema,
            "default_params": self.definition.default_params,
            "transport": self.definition.transport.model_dump(),
            "builtin": self.definition.builtin,
        })
        return base

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("提示词不能为空")
        definition = self.definition
        if not definition.transport.url:
            raise RuntimeError(f"Provider {self.id} 未配置请求地址")
        api_key = _get_api_key_for_provider(self.id, definition)
        if definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} 未配置 API Key，请在 Provider 配置中填入")

        # 构建上下文
        # 尺寸映射
        aspect_sizes = {"9:16": (832, 1216), "16:9": (1216, 832), "1:1": (1024, 1024)}
        width, height = aspect_sizes.get(req.aspect_ratio, (1024, 1024))
        if req.width and req.height:
            width, height = req.width, req.height
        # 合并 style_preset 风格后缀（若有）
        prompt = req.prompt.strip()
        # 若 params_schema 中模型为空则使用 default_model
        model = req.model or definition.default_model or (definition.models[0] if definition.models else "")

        seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little") % 9999999999

        context: Dict[str, Any] = {
            "prompt": prompt,
            "negative_prompt": req.negative_prompt or "",
            "width": width,
            "height": height,
            "size": f"{width}x{height}",
            "aspect_ratio": req.aspect_ratio or "9:16",
            "seed": seed,
            "model": model,
            "steps": req.steps or 20,
            "cfg": req.cfg or 7.0,
            "style_preset": req.style_preset or "",
            "api_key": api_key,
        }
        # 合并 dynamic_inputs 到 context 供模板使用
        if req.dynamic_inputs:
            for k, v in req.dynamic_inputs.items():
                # dynamic_inputs 里的 image 等特殊处理跳过模板直接透传？
                context[k] = v

        # 渲染 headers / query
        merged_hdrs = {**(definition.transport.headers or {}), **(getattr(definition, "headers", {}) or {})}
        headers = _render_template(merged_hdrs, context, api_key)
        query = _render_template(definition.transport.query or {}, context, api_key)
        # 渲染 auth 头
        if definition.auth.type == "bearer":
            headers["Authorization"] = f"{definition.auth.prefix}{api_key}"
        elif definition.auth.type == "apikey_header":
            headers[definition.auth.header_name or "X-API-Key"] = api_key
        elif definition.auth.type == "apikey_query":
            query[definition.auth.query_name or "api_key"] = api_key

        # 渲染 body
        if definition.mapping.request_template:
            body = _render_template(definition.mapping.request_template, context, api_key)
        else:
            # 默认模板：常见 OpenAI 兼容
            body = {
                "model": model,
                "prompt": prompt,
                "size": f"{width}x{height}",
                "n": 1,
            }
            if req.negative_prompt:
                body["negative_prompt"] = req.negative_prompt
            body["seed"] = seed
            # 合并 default_params
            if definition.default_params:
                for k, v in definition.default_params.items():
                    if k not in body:
                        body[k] = _render_template(v, context, api_key)

        # 去除空值 model
        if not body.get("model"):
            body.pop("model", None)

        url = _render_template(definition.transport.url, context, api_key)
        method = (definition.transport.method or "POST").upper()
        timeout = max(1200, definition.transport.timeout or 1200)

        started = time.time()
        async with httpx.AsyncClient(timeout=timeout + 5.0) as client:
            try:
                if method == "GET":
                    resp = await client.get(url, headers=headers, params=query, timeout=timeout)
                else:
                    # 若 body 中包含文件上传等暂不支持，仅 JSON
                    resp = await client.request(method, url, headers=headers, params=query, json=body, timeout=timeout)
            except httpx.HTTPError as e:
                raise RuntimeError(f"请求 Provider {self.id} 失败: {e}") from e

            if resp.status_code < 200 or resp.status_code >= 300:
                detail = resp.text[:800]
                raise RuntimeError(f"Provider {self.id} 返回错误 HTTP {resp.status_code}: {detail}")

            # 解析响应
            try:
                data = resp.json()
            except Exception:
                # 非 JSON，尝试文本中提取 URL
                text = resp.text
                # 查找 http url
                m = re.search(r"https?://[^\s\"']+\.(png|jpg|jpeg|webp|mp4)", text)
                if m:
                    image_url = m.group(0)
                    storage_url, local_path = await _download_to_storage(image_url, prefix="custom")
                    return ImageGenerateResult(
                        image_url=storage_url, local_path=local_path, provider=self.id,
                        seed=seed, width=width, height=height,
                        elapsed_ms=int((time.time() - started) * 1000),
                        engine=f"custom:{self.id}", raw={"raw_text": text[:500]}
                    )
                raise RuntimeError(f"Provider 返回非 JSON 且未找到图片 URL: {text[:500]}")

            # 按 response_mappings 提取图片 URL
            image_url = None
            mappings = definition.mapping.response_mappings or {}
            # 常见候选路径
            candidates = []
            if "image_url" in mappings:
                candidates.append(mappings["image_url"])
            if mappings.get("image"):
                candidates.append(mappings["image"])
            # 默认候选
            candidates.extend([
                "data[0].url", "images[0].url", "image", "url", "data.url",
                "result.url", "output.url", "data[0].b64_json", "images[0].b64_json"
            ])
            for path in candidates:
                val = _extract_by_path(data, path)
                if val and isinstance(val, str) and (val.startswith("http") or len(val) > 500):
                    # b64 情况
                    if len(val) > 500 and not val.startswith("http"):
                        # 视为 b64
                        try:
                            import base64
                            # 可能带 data:image/ 前缀
                            b64_data = val.split(",")[-1]
                            img_bytes = base64.b64decode(b64_data)
                            # 落盘
                            gen_dir = _get_generated_dir()
                            filename = f"custom_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
                            local_path = os.path.join(gen_dir, filename)
                            with open(local_path, "wb") as f:
                                f.write(img_bytes)
                            storage_url = f"/storage/generated/{filename}"
                            return ImageGenerateResult(
                                image_url=storage_url, local_path=local_path, provider=self.id,
                                seed=seed, width=width, height=height,
                                elapsed_ms=int((time.time() - started) * 1000),
                                engine=f"custom:{self.id}", raw=data
                            )
                        except Exception:
                            continue
                    image_url = val
                    break
            if not image_url:
                # 兜底全局搜索第一个 http url
                def find_url(obj):
                    if isinstance(obj, str) and obj.startswith("http") and any(obj.endswith(ext) for ext in (".png",".jpg",".jpeg",".webp")) or (obj.startswith("http") and "image" in str(data)[:2000].lower()):
                        return obj
                    if isinstance(obj, dict):
                        for v in obj.values():
                            r = find_url(v)
                            if r:
                                return r
                    if isinstance(obj, list):
                        for v in obj:
                            r = find_url(v)
                            if r:
                                return r
                    return None
                # 简单正则兜底
                text = json.dumps(data, ensure_ascii=False)
                m = re.search(r"https?://[^\s\"']+\.(png|jpg|jpeg|webp)", text)
                if m:
                    image_url = m.group(0)
                else:
                    m2 = re.search(r"https?://[^\s\"']+", text)
                    if m2 and "http" in text.lower():
                        # 取第一个 url
                        image_url = m2.group(0).strip('"').strip("'").strip(",")
                if not image_url:
                    raise RuntimeError(f"未能从 Provider 响应中提取图片 URL，响应: {str(data)[:600]}")

            # 下载落盘
            # b64 已处理，此处仅 http
            if image_url.startswith("http"):
                storage_url, local_path = await _download_to_storage(image_url, prefix="custom")
            else:
                raise RuntimeError(f"提取的图片 URL 非 http: {image_url[:200]}")

            return ImageGenerateResult(
                image_url=storage_url,
                local_path=local_path,
                provider=self.id,
                seed=seed,
                width=width,
                height=height,
                elapsed_ms=int((time.time() - started) * 1000),
                engine=f"custom:{self.id} ({model})" if model else f"custom:{self.id}",
                raw=data,
            )


# ---------- Generic Audio Provider ----------

class GenericHttpAudioProvider(AudioProvider):
    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.display_name = definition.get_display_name()
        self.description = definition.description or f"自定义语音：{definition.id}"
        self.icon = definition.icon or "Mic"

    def is_configured(self) -> bool:
        if self.definition.auth.type != "none":
            key = _get_api_key_for_provider(self.id, self.definition)
            return bool(key)
        return bool(self.definition.transport.url)

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        hc = self.definition.health_check
        if hc.url:
            try:
                async with httpx.AsyncClient(timeout=6.0) as client:
                    r = await client.get(hc.url, timeout=6.0)
                    return 200 <= r.status_code < 300
            except Exception:
                return False
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "id": self.id,
            "display_name": self.display_name,
            "kind": "audio",
            "provider_type": "http",
            "is_configured": self.is_configured(),
            "models": self.definition.models,
            "default_model": self.definition.default_model,
        })
        return base

    async def list_voices(self) -> List[Dict[str, Any]]:
        # 若 params_schema 中有 voices 列举则返回，否则空
        if self.definition.models:
            return [{"id": m, "name": m} for m in self.definition.models]
        return []

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        definition = self.definition
        if not definition.transport.url:
            raise RuntimeError(f"Provider {self.id} 未配置地址")
        api_key = _get_api_key_for_provider(self.id, definition)
        if definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} 未配置 API Key")
        context = {
            "text": req.text,
            "voice_id": req.voice_id,
            "emotion": req.emotion,
            "speed": req.speed,
            "pitch": req.pitch,
            "model": req.model or definition.default_model or "",
            "api_key": api_key,
        }
        merged_hdrs = {**(definition.transport.headers or {}), **(getattr(definition, "headers", {}) or {})}
        headers = _render_template(merged_hdrs, context, api_key)
        query = _render_template(definition.transport.query or {}, context, api_key)
        if definition.auth.type == "bearer":
            headers["Authorization"] = f"{definition.auth.prefix}{api_key}"
        elif definition.auth.type == "apikey_header":
            headers[definition.auth.header_name or "X-API-Key"] = api_key
        elif definition.auth.type == "apikey_query":
            query[definition.auth.query_name or "api_key"] = api_key

        if definition.mapping.request_template:
            body = _render_template(definition.mapping.request_template, context, api_key)
        else:
            body = {"text": req.text, "voice_id": req.voice_id, "model": context["model"] or "default"}

        url = _render_template(definition.transport.url, context, api_key)
        method = (definition.transport.method or "POST").upper()
        timeout = max(1200, definition.transport.timeout or 1200)

        async with httpx.AsyncClient(timeout=timeout+5) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers, params=query, timeout=timeout)
            else:
                resp = await client.request(method, url, headers=headers, params=query, json=body, timeout=timeout)
            if resp.status_code < 200 or resp.status_code >= 300:
                raise RuntimeError(f"Audio Provider {self.id} 错误 HTTP {resp.status_code}: {resp.text[:600]}")
            # 尝试解析：可能是 JSON 含 url/b64 或直接二进制
            ct = resp.headers.get("content-type","")
            if "audio" in ct or "octet-stream" in ct:
                # 直接二进制
                from app.core.config import settings
                filename = f"tts_{uuidlib.uuid4().hex[:8]}.mp3"
                local_path = os.path.join(settings.STORAGE_DIR, filename)
                with open(local_path, "wb") as f:
                    f.write(resp.content)
                return AudioGenerateResult(
                    audio_url=f"/storage/{filename}", local_path=local_path,
                    voice_id=req.voice_id, text=req.text, emotion=req.emotion,
                    duration=1.0, provider=self.id, engine=f"custom:{self.id}", status="ready"
                )
            try:
                data = resp.json()
            except Exception:
                raise RuntimeError(f"Audio Provider 非 JSON 响应: {resp.text[:500]}")
            # 提取 audio_url
            audio_url = None
            mappings = definition.mapping.response_mappings or {}
            for key in ["audio_url", "audio", "url", "data.audio", "data.url"]:
                path = mappings.get(key) or (mappings.get("audio_url") if key=="audio_url" else None) or key
                val = _extract_by_path(data, path)
                if val and isinstance(val, str):
                    if val.startswith("http"):
                        audio_url = val
                        break
                    if len(val) > 500:  # b64
                        try:
                            import base64
                            b64 = val.split(",")[-1]
                            b = base64.b64decode(b64)
                            from app.core.config import settings
                            filename = f"tts_{uuidlib.uuid4().hex[:8]}.mp3"
                            local_path = os.path.join(settings.STORAGE_DIR, filename)
                            with open(local_path, "wb") as f:
                                f.write(b)
                            return AudioGenerateResult(
                                audio_url=f"/storage/{filename}", local_path=local_path,
                                voice_id=req.voice_id, text=req.text, emotion=req.emotion,
                                duration=1.0, provider=self.id, engine=f"custom:{self.id}", status="ready", raw=data
                            )
                        except Exception:
                            continue
            if not audio_url:
                # 正则兜底
                text = json.dumps(data, ensure_ascii=False)
                m = re.search(r"https?://[^\s\"']+\.(mp3|wav|m4a|ogg)", text)
                if m:
                    audio_url = m.group(0)
                else:
                    m2 = re.search(r"https?://[^\s\"']+", text)
                    if m2:
                        audio_url = m2.group(0)
            if not audio_url:
                raise RuntimeError(f"未能提取音频 URL: {str(data)[:600]}")
            storage_url, local_path = await _download_to_storage(audio_url, prefix="tts")
            # tts 下载会放 generated，需移到 storage 根
            # _download 已处理
            return AudioGenerateResult(
                audio_url=storage_url, local_path=local_path,
                voice_id=req.voice_id, text=req.text, emotion=req.emotion,
                duration=1.0, provider=self.id, engine=f"custom:{self.id}", status="ready", raw=data
            )


# ---------- Generic Video Provider ----------

class GenericHttpVideoProvider(VideoProvider):
    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.display_name = definition.get_display_name()
        self.description = definition.description or f"自定义视频：{definition.id}"
        self.icon = definition.icon or "Video"

    def is_configured(self) -> bool:
        if self.definition.auth.type != "none":
            return bool(_get_api_key_for_provider(self.id, self.definition))
        return bool(self.definition.transport.url)

    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        hc = self.definition.health_check
        if hc.url:
            try:
                async with httpx.AsyncClient(timeout=6.0) as client:
                    r = await client.get(hc.url, timeout=6.0)
                    return 200 <= r.status_code < 300
            except Exception:
                return False
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({
            "id": self.id,
            "display_name": self.display_name,
            "kind": "video",
            "provider_type": "http",
            "is_configured": self.is_configured(),
        })
        return base

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        definition = self.definition
        if not definition.transport.url:
            raise RuntimeError(f"Provider {self.id} 未配置地址")
        api_key = _get_api_key_for_provider(self.id, definition)
        if definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} 未配置 API Key")
        # resolution 推断：优先使用 dynamic_inputs.resolution > req.resolution > 定义默认 > 回退
        raw_resolution = None
        if req.dynamic_inputs and isinstance(req.dynamic_inputs, dict) and req.dynamic_inputs.get("resolution"):
            raw_resolution = req.dynamic_inputs.get("resolution")
        elif getattr(req, 'resolution', None):
            raw_resolution = getattr(req, 'resolution')
        elif definition.default_params.get("resolution"):
            raw_resolution = definition.default_params.get("resolution")
        else:
            raw_resolution = "480p竖" if "9:16" in (req.aspect_ratio or "") else "720p"
        # 校验是否在 params_schema 允许枚举中，否则回退到默认
        allowed = None
        try:
            allowed = (definition.params_schema or {}).get("properties", {}).get("resolution", {}).get("enum")
        except Exception:
            allowed = None
        if allowed and raw_resolution not in allowed:
            # 尝试兼容：若提供的是 720p 但仅允许 480p竖，则回退
            raw_resolution = definition.default_params.get("resolution") or (allowed[0] if allowed else raw_resolution)
        resolution = raw_resolution
        # duration 同样优先 dynamic_inputs
        raw_duration = None
        if req.dynamic_inputs and isinstance(req.dynamic_inputs, dict) and req.dynamic_inputs.get("duration") is not None:
            raw_duration = req.dynamic_inputs.get("duration")
        else:
            raw_duration = req.duration or definition.default_params.get("duration") or 5
        try:
            raw_duration = int(raw_duration)
        except Exception:
            raw_duration = 5
        context = {
            "prompt": req.prompt,
            "mode": req.mode,
            "first_frame_url": req.first_frame_url or "",
            "duration": raw_duration,
            "aspect_ratio": req.aspect_ratio or "9:16",
            "resolution": resolution,
            "seed": req.seed or 0,
            "model": req.provider or definition.default_model or "",
            "api_key": api_key,
        }
        # 合并剩余 dynamic_inputs 到 context（供模板占位，已处理的 resolution/duration 跳过）
        if req.dynamic_inputs:
            for k, v in req.dynamic_inputs.items():
                if k in ("resolution", "duration"):
                    continue
                if k not in context:
                    context[k] = v
        merged_hdrs = {**(definition.transport.headers or {}), **(getattr(definition, "headers", {}) or {})}
        headers = _render_template(merged_hdrs, context, api_key)
        query = _render_template(definition.transport.query or {}, context, api_key)
        if definition.auth.type == "bearer":
            headers["Authorization"] = f"{definition.auth.prefix}{api_key}"
        elif definition.auth.type == "apikey_header":
            headers[definition.auth.header_name or "X-API-Key"] = api_key
        elif definition.auth.type == "apikey_query":
            query[definition.auth.query_name or "api_key"] = api_key
        if definition.mapping.request_template:
            body = _render_template(definition.mapping.request_template, context, api_key)
            # 将纯数字字符串尝试转回数值（AutoDL 要求 duration 为整数）
            for k, v in list(body.items()):
                if isinstance(v, str) and v.isdigit():
                    try:
                        body[k] = int(v)
                    except Exception:
                        pass
                elif isinstance(v, str) and re.match(r"^\d+\.\d+$", v):
                    try:
                        body[k] = float(v)
                    except Exception:
                        pass
        else:
            body = {"prompt": req.prompt, "duration": req.duration, "resolution": resolution}
            if req.first_frame_url:
                # 对于 T2V 工作流，first_frame_url 仅在模板需要时发送；避免无关参数污染
                pass
            if context["model"]:
                body["model"] = context["model"]
            if not body.get("model"):
                body.pop("model", None)

        url = _render_template(definition.transport.url, context, api_key)
        method = (definition.transport.method or "POST").upper()
        timeout = max(1200, definition.transport.timeout or 1200)
        started = time.time()
        async with httpx.AsyncClient(timeout=timeout+5) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers, params=query, timeout=timeout)
            else:
                resp = await client.request(method, url, headers=headers, params=query, json=body, timeout=timeout)
            if resp.status_code < 200 or resp.status_code >= 300:
                raise RuntimeError(f"Video Provider {self.id} 错误 HTTP {resp.status_code}: {resp.text[:800]}")
            try:
                data = resp.json()
            except Exception:
                # 直接返回文本中的 url
                m = re.search(r"https?://[^\s\"']+\.(mp4|mov|webm)", resp.text)
                if m:
                    video_url = m.group(0)
                    storage_url, local_path = await _download_to_storage(video_url, prefix="vid")
                    return VideoGenerateResult(video_url=storage_url, local_path=local_path, provider=self.id, engine=f"custom:{self.id}", duration=req.duration, elapsed_ms=int((time.time()-started)*1000))
                raise RuntimeError(f"Video Provider 非 JSON: {resp.text[:600]}")
            # 尝试直接提取 video_url（同步接口）
            video_url = None
            mappings = definition.mapping.response_mappings or {}
            # 优先按 mapping 指定的 video_url 路径
            for key in ["video_url", "video", "url", "data.video_url", "data.url", "data.results[0]", "data.results"]:
                path = mappings.get(key) or (mappings.get("video_url") if key=="video_url" else None) or key
                val = _extract_by_path(data, path)
                if val:
                    if isinstance(val, list) and val and isinstance(val[0], str) and val[0].startswith("http"):
                        video_url = val[0]
                        break
                    if isinstance(val, str) and val.startswith("http"):
                        video_url = val
                        break
            # 若未直接获得，检查是否为异步任务（AutoDL 模式：data.task_id）
            task_id = None
            if not video_url:
                for tpath in ["data.task_id", "task_id", "data.taskId", "taskId", "id", "data.id"]:
                    # 也尝试 mapping 中 task_id
                    cand = mappings.get("task_id") if "task_id" in mappings else None
                    path = cand if tpath == "data.task_id" and cand else tpath
                    val = _extract_by_path(data, path)
                    if val and isinstance(val, str) and len(val) > 4:
                        task_id = val
                        break
            if video_url:
                # 同步成功
                pass
            elif task_id:
                # 异步轮询 — AutoDL 模式
                # 推断轮询 URL：https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}
                poll_url = None
                if "comfyui_workflow" in url:
                    base = url.split("/comfyui_workflow/")[0]
                    poll_url = f"{base}/comfyui_workflow/result/{task_id}"
                else:
                    poll_url = f"{url.rstrip('/')}/result/{task_id}"
                # 轮询：先同步尝试 30s，若仍排队则转后台异步并返回 task_id 供前端轮询
                poll_interval = 3.0
                short_timeout = 30
                poll_deadline = time.time() + short_timeout
                last_status = "PENDING"
                while time.time() < poll_deadline:
                    await asyncio.sleep(poll_interval)
                    try:
                        poll_resp = await client.get(poll_url, headers=headers, params=query, timeout=15)
                    except Exception as e:
                        print(f"[VideoProvider {self.id}] poll error, retry: {e}")
                        continue
                    if poll_resp.status_code < 200 or poll_resp.status_code >= 300:
                        print(f"[VideoProvider {self.id}] poll HTTP {poll_resp.status_code}: {poll_resp.text[:300]}")
                        continue
                    try:
                        poll_data = poll_resp.json()
                    except Exception:
                        continue
                    status = None
                    for spath in ["data.status", "status", "data.state", "state"]:
                        cand = mappings.get("status") if "status" in mappings else None
                        p = cand if spath == "data.status" and cand else spath
                        v = _extract_by_path(poll_data, p)
                        if v and isinstance(v, str):
                            status = v.upper()
                            break
                    last_status = status or last_status
                    if status == "SUCCESS":
                        results = None
                        for rpath in ["data.results", "results", "data.result", "data.video_url", "data.url"]:
                            v = _extract_by_path(poll_data, rpath)
                            if v:
                                results = v
                                break
                        if isinstance(results, list) and results:
                            video_url = results[0] if isinstance(results[0], str) else None
                        elif isinstance(results, str) and results.startswith("http"):
                            video_url = results
                        if not video_url:
                            txt = json.dumps(poll_data, ensure_ascii=False)
                            m = re.search(r"https?://[^\s\"']+\.(mp4|mov|webm)", txt)
                            if m:
                                video_url = m.group(0)
                        if video_url:
                            data = poll_data
                            break
                        else:
                            raise RuntimeError(f"轮询成功但未找到视频URL: {str(poll_data)[:600]}")
                    elif status == "FAILED":
                        err = poll_data.get("data", {}).get("error") if isinstance(poll_data.get("data"), dict) else poll_data.get("error")
                        raise RuntimeError(f"视频生成任务失败 (task_id={task_id}): {err or poll_data}")
                    else:
                        continue
                if not video_url:
                    # 30s 内未完成，转后台轮询并立即返回 task_id，前端可通过 /videos/status/{task_id} 查询
                    print(f"[VideoProvider {self.id}] task {task_id} still {last_status} after {short_timeout}s, switch to background polling")
                    # 注册后台任务（按 node 隔离，带 node_id/project_id 便于追踪）
                    _node_id = getattr(req, "_node_id", None) if hasattr(req, "_node_id") else (req.extra.get("_node_id") if isinstance(getattr(req, "extra", None), dict) else None)
                    _proj_id = getattr(req, "_project_id", None) if hasattr(req, "_project_id") else (req.extra.get("_project_id") if isinstance(getattr(req, "extra", None), dict) else None)
                    if not _node_id and isinstance(getattr(req, "dynamic_inputs", None), dict):
                        _node_id = req.dynamic_inputs.get("_node_id")
                    _CUSTOM_VIDEO_TASKS[task_id] = {"status": last_status, "task_id": task_id, "provider": self.id, "poll_url": poll_url, "headers": headers, "created_at": time.time(), "node_id": _node_id, "project_id": _proj_id}
                    try:
                        asyncio.create_task(_autodl_poll_and_download(task_id, poll_url, headers, self.id))
                    except Exception as e:
                        print(f"[VideoProvider] create background task failed: {e}")
                    # 返回带 task_id 的结果，前端据此轮询
                    return VideoGenerateResult(
                        video_url="",  # 占位，待轮询完成後更新
                        local_path=None,
                        provider=self.id,
                        engine=f"custom:{self.id} (queued:{last_status})",
                        duration=req.duration,
                        elapsed_ms=int((time.time()-started)*1000),
                        task_id=task_id,
                        raw={"status": last_status, "task_id": task_id, "poll_url": poll_url, "queued": True, "data": data},
                    )
            if not video_url:
                text = json.dumps(data, ensure_ascii=False)
                m = re.search(r"https?://[^\s\"']+\.(mp4|mov|webm)", text)
                if m:
                    video_url = m.group(0)
                else:
                    m2 = re.search(r"https?://[^\s\"']+", text)
                    if m2:
                        video_url = m2.group(0)
            if not video_url:
                raise RuntimeError(f"未能提取视频 URL: {str(data)[:800]}")
            # 若是远程 url，尝试下载到本地 storage
            try:
                storage_url, local_path = await _download_to_storage(video_url, prefix="vid")
                video_url = storage_url
            except Exception:
                local_path = None
            return VideoGenerateResult(video_url=video_url, local_path=local_path, provider=self.id, engine=f"custom:{self.id}", duration=req.duration, elapsed_ms=int((time.time()-started)*1000), raw=data)
