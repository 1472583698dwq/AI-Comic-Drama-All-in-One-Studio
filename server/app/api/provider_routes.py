"""
Provider 管理路由 - 解耦后每个生成源为独立可扩展节点
提供 CRUD、测试连接、从 API 文档自动生成 definition（含导演自动扩展）
"""
import os
import json
import re
import httpx
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field

from app.models.provider_definition import ProviderDefinition
from app.providers.custom.manager import custom_provider_manager
from app.core.config import settings

router = APIRouter()


def _sanitize_for_frontend(pd: ProviderDefinition) -> Dict[str, Any]:
    info = pd.to_provider_info()
    # 脱敏：不返回 key_env 对应的真实 key，仅返回 has_key
    # 同时隐藏 raw_api_doc 过长内容，截断
    if info.get("doc_text") and len(info["doc_text"]) > 2000:
        info["doc_text"] = info["doc_text"][:2000] + "...(truncated)"
    return info


def _infer_kind_from_doc(doc: str, url: str = "") -> Optional[str]:
    low = f"{doc or ''} {url or ''}".lower()
    if any(k in low for k in ["video", "minimax_h3", "lightx2v", "kling", "vidu", "hailuo", "wanx", "r2v", "i2v", "t2v", "comfyui_workflow"]):
        # 若同时含 image 且明确为 image 则保留 image，否则推断 video
        if "image" in low and "video" not in low:
            return "image"
        if any(v in low for v in ["video", "h3", "lightx2v", "kling"]):
            return "video"
    if any(k in low for k in ["audio", "tts", "voice", "speech", "sovits", "cosyvoice"]):
        return "audio"
    return None

def _default_input_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"画面提示词（文生图必填）","x-handle":"text"},
            "negative_prompt":{"type":"string","description":"负向提示词","x-handle":"text"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考图（多图）","x-handle":"image"},
        },"required":["prompt"]}
    elif kind == "video":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"运动/运镜描述","x-handle":"text"},
            "first_frame":{"type":"string","format":"uri","description":"首帧图像","x-handle":"image"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考图像集（R2V 多图）","x-handle":"image"},
            "reference_audios":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考音频","x-handle":"audio"},
            "reference_videos":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考视频","x-handle":"video"},
        },"required":["prompt"]}
    elif kind == "audio":
        return {"type":"object","properties":{
            "text":{"type":"string","description":"合成文本","x-handle":"text"},
            "reference_audio":{"type":"string","format":"uri","description":"参考音频（克隆）","x-handle":"audio"},
        },"required":["text"]}
    else:
        return {"type":"object","properties":{"prompt":{"type":"string","x-handle":"text"}},"required":["prompt"]}

def _default_output_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type":"object","properties":{"image_url":{"type":"string","format":"uri","description":"生成图像URL","x-handle":"image"}},"required":["image_url"]}
    elif kind == "video":
        return {"type":"object","properties":{"video_url":{"type":"string","format":"uri","description":"生成视频URL","x-handle":"video"}},"required":["video_url"]}
    elif kind == "audio":
        return {"type":"object","properties":{"audio_url":{"type":"string","format":"uri","description":"生成音频URL","x-handle":"audio"}},"required":["audio_url"]}
    else:
        return {"type":"object","properties":{"output":{"type":"string","x-handle":"text"}}}

def _default_params_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {
            "type": "object",
            "properties": {
                "steps": {"type": "integer", "description": "采样步数 8-50", "default": 20},
                "cfg": {"type": "number", "description": "CFG 1-15", "default": 7},
                "width": {"type": "integer", "description": "宽度 (覆盖 aspect_ratio)"},
                "height": {"type": "integer", "description": "高度"},
                "seed": {"type": "integer", "description": "随机种子，-1 随机"},
            },
        }
    elif kind == "video":
        return {
            "type": "object",
            "properties": {
                "duration": {"type": "integer", "description": "时长秒 3-15", "default": 5},
                "resolution": {"type": "string", "description": "分辨率 720p/1080p", "default": "720p"},
                "fps": {"type": "integer", "description": "帧率"},
            },
        }
    elif kind == "audio":
        return {
            "type": "object",
            "properties": {
                "speed": {"type": "number", "description": "语速 0.5-2.0", "default": 1.0},
                "pitch": {"type": "number", "description": "音调 -12~12", "default": 0},
                "volume": {"type": "number", "description": "音量"},
            },
        }
    else:
        return {"type": "object", "properties": {}}


@router.get("/providers")
async def list_providers(kind: Optional[str] = None, scope: Optional[str] = None, include_builtin: bool = True, project_id: Optional[str] = None):
    """列出所有 Provider（内置 + 自定义）"""
    result: List[Dict[str, Any]] = []
    # 内置：从 registries 读取
    if include_builtin:
        try:
            from app.providers.image.registry import image_registry
            from app.providers.audio.registry import audio_registry
            from app.providers.video.registry import video_registry
            # 确保初始化
            if not image_registry.list_ids():
                from app.providers.init_providers import init_all_providers
                try:
                    init_all_providers()
                except Exception:
                    pass
            for reg, reg_kind in [(image_registry, "image"), (audio_registry, "audio"), (video_registry, "video")]:
                if kind and kind != reg_kind:
                    continue
                for pid in reg.list_ids():
                    prov = reg.get(pid)
                    if not prov:
                        continue
                    # 若是自定义则跳过，后面统一从 custom_manager 读取（避免重复）
                    if hasattr(reg, "is_custom") and reg.is_custom(pid):
                        continue
                    info = prov.to_provider_info() if hasattr(prov, "to_provider_info") else {"id": pid, "display_name": getattr(prov, "display_name", pid)}
                    info["kind"] = reg_kind
                    info["builtin"] = True
                    info["provider_type"] = "builtin"
                    info["enabled"] = True
                    result.append(info)
        except Exception as e:
            print(f"[ProviderRoutes] builtin list failed: {e}")

    # 自定义：从 custom_manager 读取
    try:
        customs = custom_provider_manager.list_definitions(kind=kind, scope=scope, project_id=project_id)
        for pd in customs:
            # scope 过滤：global 对所有 project 可见
            if scope and pd.scope != scope:
                continue
            # 若指定 project_id，global + 对应 project 的都可见（调用方自行过滤，这里放行）
            result.append(_sanitize_for_frontend(pd))
    except Exception as e:
        print(f"[ProviderRoutes] custom list failed: {e}")

    # 按 kind 排序：image, video, audio, llm
    order = {"image": 0, "video": 1, "audio": 2, "llm": 3}
    result.sort(key=lambda x: (order.get(x.get("kind", "image"), 99), x.get("id", "")))

    return {"providers": result, "total": len(result)}


@router.get("/providers/{provider_id}")
async def get_provider(provider_id: str):
    # 先查内置
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        from app.providers.video.registry import video_registry
        for reg in (image_registry, audio_registry, video_registry):
            prov = reg.get(provider_id)
            if prov and not (hasattr(reg, "is_custom") and reg.is_custom(provider_id)):
                info = prov.to_provider_info() if hasattr(prov, "to_provider_info") else {"id": provider_id}
                info["builtin"] = True
                return {"provider": info}
    except Exception:
        pass
    # 查自定义
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    return {"provider": _sanitize_for_frontend(pd), "raw": pd.model_dump()}


class ProviderCreateRequest(BaseModel):
    id: Optional[str] = None
    name: str
    kind: str = "image"  # image/video/audio/llm
    provider_type: str = "http"
    description: Optional[str] = ""
    icon: Optional[str] = "Zap"
    scope: Optional[str] = "global"
    project_id: Optional[str] = None
    transport: Dict[str, Any] = Field(default_factory=dict)
    auth: Dict[str, Any] = Field(default_factory=dict)
    mapping: Dict[str, Any] = Field(default_factory=dict)
    health_check: Dict[str, Any] = Field(default_factory=dict)
    models: List[str] = Field(default_factory=list)
    default_model: Optional[str] = None
    params_schema: Optional[Dict[str, Any]] = None
    default_params: Dict[str, Any] = Field(default_factory=dict)
    doc_url: Optional[str] = None
    doc_text: Optional[str] = None
    raw_api_doc: Optional[str] = None
    enabled: bool = True
    api_key: Optional[str] = None  # 明文传入，服务端落盘到 config_store


def _save_api_key(provider_id: str, api_key: str):
    """将自定义 provider 的 api_key 持久化到 storage/config_store.json 的 custom_providers 段，避免明文落 definition.json"""
    if not api_key:
        return
    try:
        import json as _json
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        data: Dict[str, Any] = {}
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                try:
                    data = _json.load(f)
                except Exception:
                    data = {}
        if "custom_providers" not in data or not isinstance(data["custom_providers"], dict):
            data["custom_providers"] = {}
        data["custom_providers"][provider_id] = {"api_key": api_key}
        # 同时以 CUSTOM_PROVIDER_{id} 形式写入便于 _get_api_key_for_provider 命中
        data[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
        with open(cfg_path, "w", encoding="utf-8") as f:
            _json.dump(data, f, ensure_ascii=False, indent=2)
        # 同步到环境变量
        os.environ[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
        # 若 definition.auth.key_env 未设置，补上
        # 不在此处改 definition，由调用方设置 auth.key_env
    except Exception as e:
        print(f"[ProviderRoutes] save api_key failed: {e}")


@router.post("/providers")
async def create_provider(req: ProviderCreateRequest):
    # 校验 kind
    if req.kind not in ("image", "video", "audio", "llm"):
        raise HTTPException(status_code=400, detail="kind 必须为 image/video/audio/llm")
    # 构建 ProviderDefinition
    data: Dict[str, Any] = req.model_dump(exclude={"api_key"})
    # 处理 id
    if not data.get("id"):
        import uuid
        data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
    else:
        # 防内置冲突
        if data["id"] in ("comfyui", "siliconflow", "dashscope", "openai_compat", "minimax", "elevenlabs", "cosyvoice", "gpt_sovits", "comfyui_video", "minimax_video"):
            raise HTTPException(status_code=400, detail=f"id {data['id']} 与内置 Provider 冲突")
    # 检查已存在
    if custom_provider_manager.get_definition(data["id"]):
        raise HTTPException(status_code=409, detail=f"Provider 已存在: {data['id']}")

    # 标准化 transport/mapping 等
    # 若 transport.url 缺失则报错（comfyui 除外但此处为 http）
    if data.get("provider_type") == "http" and not (data.get("transport") or {}).get("url"):
        raise HTTPException(status_code=400, detail="HTTP Provider 必须提供 transport.url")

    # 设置 auth.key_env 若提供了 api_key
    if req.api_key:
        data.setdefault("auth", {})["key_env"] = f"CUSTOM_PROVIDER_{data['id']}"

    try:
        pd = ProviderDefinition.model_validate(data)
        # 若未提供参数/输入输出 schema，补默认
        if not pd.params_schema or not pd.params_schema.get("properties"):
            pd.params_schema = _default_params_schema(pd.kind)
        if not pd.input_schema or not pd.input_schema.get("properties"):
            pd.input_schema = _default_input_schema(pd.kind)
        if not pd.output_schema or not pd.output_schema.get("properties"):
            pd.output_schema = _default_output_schema(pd.kind)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Provider 定义校验失败: {e}")

    # 保存
    try:
        saved = custom_provider_manager.save_definition(pd)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 保存 api_key
    if req.api_key:
        _save_api_key(saved.id, req.api_key)
        # 确保 definition 已更新 key_env
        if not saved.auth.key_env:
            saved.auth.key_env = f"CUSTOM_PROVIDER_{saved.id}"
            custom_provider_manager.save_definition(saved)

    # 热注册
    try:
        from app.providers.init_providers import register_single_custom_provider
        register_single_custom_provider(saved)
    except Exception as e:
        print(f"[ProviderRoutes] hot register failed: {e}")

    return {"status": "success", "provider": _sanitize_for_frontend(saved)}


@router.put("/providers/{provider_id}")
async def update_provider(provider_id: str, body: Dict[str, Any] = Body(...)):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if pd.builtin:
        raise HTTPException(status_code=403, detail="内置 Provider 不可编辑")

    # 提取 api_key 特殊字段
    api_key = body.pop("api_key", None)
    # 若提供了新 api_key，更新存储
    if api_key is not None:
        if api_key == "":
            # 清空 key
            try:
                import json as _json
                cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
                if os.path.exists(cfg_path):
                    with open(cfg_path, "r", encoding="utf-8") as f:
                        data = _json.load(f)
                    if "custom_providers" in data and provider_id in data["custom_providers"]:
                        data["custom_providers"].pop(provider_id, None)
                    data.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
                    with open(cfg_path, "w", encoding="utf-8") as f:
                        _json.dump(data, f, ensure_ascii=False, indent=2)
                    os.environ.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
            except Exception as e:
                print(f"[ProviderRoutes] clear api_key failed: {e}")
        else:
            _save_api_key(provider_id, api_key)
            body.setdefault("auth", {})["key_env"] = f"CUSTOM_PROVIDER_{provider_id}"
            # 合并已有 auth
            if "auth" in body and isinstance(body["auth"], dict):
                # 保留现有 key_env
                pass
            else:
                body["auth"] = {"key_env": f"CUSTOM_PROVIDER_{provider_id}", **(body.get("auth") or {})}

    # 合并更新
    current = pd.model_dump()
    # 深度合并：简单 shallow + nested for transport/auth/mapping
    for k, v in body.items():
        if k in ("transport", "auth", "mapping", "health_check", "default_params") and isinstance(v, dict):
            current[k] = {**(current.get(k) or {}), **v}
        else:
            current[k] = v

    try:
        updated = ProviderDefinition.model_validate(current)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校验失败: {e}")

    try:
        saved = custom_provider_manager.save_definition(updated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 热重载：先注销旧，再注册新
    try:
        from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
        unregister_single_custom_provider(provider_id, kind=pd.kind)
        # 更新后 kind 可能变
        register_single_custom_provider(saved)
    except Exception as e:
        print(f"[ProviderRoutes] hot reload failed: {e}")

    return {"status": "success", "provider": _sanitize_for_frontend(saved)}


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if pd.builtin:
        raise HTTPException(status_code=403, detail="内置 Provider 不可删除")
    kind = pd.kind
    try:
        custom_provider_manager.delete_definition(provider_id)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    # 清理 api_key
    try:
        import json as _json
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = _json.load(f)
            if "custom_providers" in data and provider_id in data["custom_providers"]:
                data["custom_providers"].pop(provider_id, None)
            data.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
            with open(cfg_path, "w", encoding="utf-8") as f:
                _json.dump(data, f, ensure_ascii=False, indent=2)
            os.environ.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
    except Exception:
        pass
    # 注销注册表
    try:
        from app.providers.init_providers import unregister_single_custom_provider
        unregister_single_custom_provider(provider_id, kind=kind)
    except Exception as e:
        print(f"[ProviderRoutes] unregister failed: {e}")

    return {"status": "deleted", "provider_id": provider_id}


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: str, body: Optional[Dict[str, Any]] = Body(None)):
    """测试 Provider 连通性"""
    # 先尝试自定义
    pd = custom_provider_manager.get_definition(provider_id)
    prov = None
    kind = None
    if pd:
        kind = pd.kind
        # 创建临时 provider 实例用于测试
        try:
            from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
            if kind == "image":
                prov = GenericHttpImageProvider(pd)
            elif kind == "audio":
                prov = GenericHttpAudioProvider(pd)
            elif kind == "video":
                prov = GenericHttpVideoProvider(pd)
            else:
                prov = GenericHttpImageProvider(pd)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"创建 Provider 实例失败: {e}")
    else:
        # 尝试内置
        try:
            from app.providers.image.registry import image_registry
            from app.providers.audio.registry import audio_registry
            from app.providers.video.registry import video_registry
            for reg in (image_registry, audio_registry, video_registry):
                p = reg.get(provider_id)
                if p:
                    prov = p
                    break
        except Exception:
            pass
        if not prov:
            raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")

    try:
        ok = await prov.check_health()
        is_configured = prov.is_configured() if hasattr(prov, "is_configured") else True
        return {
            "provider_id": provider_id,
            "ok": ok,
            "is_configured": is_configured,
            "kind": kind or getattr(prov, "kind", "unknown"),
            "detail": "连通正常" if ok else "检测未通过（可能未配置 Key 或服务不可达）",
        }
    except Exception as e:
        return {"provider_id": provider_id, "ok": False, "detail": f"检测异常: {e}"}


class ProviderImportRequest(BaseModel):
    kind: str = "image"  # image/video/audio
    name: Optional[str] = None
    doc_text: Optional[str] = None
    doc_url: Optional[str] = None
    curl: Optional[str] = None
    openapi_url: Optional[str] = None
    api_key: Optional[str] = None
    # 允许直接提供完整 definition 透传
    definition: Optional[Dict[str, Any]] = None


@router.post("/providers/import")
async def import_provider_from_doc(req: ProviderImportRequest):
    """从 API 文档/cURL/OpenAPI URL 导入（可由导演自动调用，LLM 解析）"""
    # 若直接提供了 definition，则直接创建
    if req.definition:
        # 复用 create 逻辑
        try:
            data = req.definition
            if not data.get("id"):
                import uuid
                data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
            data["kind"] = req.kind or data.get("kind", "image")
            if req.name:
                data["name"] = req.name
            pd = ProviderDefinition.model_validate(data)
            if not pd.params_schema or not pd.params_schema.get("properties"):
                pd.params_schema = _default_params_schema(pd.kind)
            if not pd.input_schema or not pd.input_schema.get("properties"):
                pd.input_schema = _default_input_schema(pd.kind)
            if not pd.output_schema or not pd.output_schema.get("properties"):
                pd.output_schema = _default_output_schema(pd.kind)
            saved = custom_provider_manager.save_definition(pd)
            if req.api_key:
                _save_api_key(saved.id, req.api_key)
                saved.auth.key_env = f"CUSTOM_PROVIDER_{saved.id}"
                custom_provider_manager.save_definition(saved)
            from app.providers.init_providers import register_single_custom_provider
            register_single_custom_provider(saved)
            return {"status": "success", "provider": _sanitize_for_frontend(saved), "mode": "direct_definition"}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"definition 导入失败: {e}")

    # 否则走 LLM 解析
    doc_content = req.doc_text or ""
    if req.curl:
        doc_content += f"\n\nCURL:\n{req.curl}"
    if req.doc_url and not doc_content:
        # 尝试拉取 doc_url 内容
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(req.doc_url, timeout=10.0)
                if r.status_code == 200:
                    # 截断
                    doc_content = r.text[:8000]
                    if len(r.text) > 8000:
                        doc_content += "\n...(truncated)"
                else:
                    doc_content = f"doc_url: {req.doc_url} (fetch HTTP {r.status_code})"
        except Exception as e:
            doc_content = f"doc_url: {req.doc_url} (fetch failed: {e})"
    if req.openapi_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(req.openapi_url, timeout=10.0)
                if r.status_code == 200:
                    doc_content += f"\n\nOpenAPI:\n{r.text[:8000]}"
        except Exception as e:
            doc_content += f"\nOpenAPI fetch failed: {e}"

    if not doc_content or len(doc_content.strip()) < 10:
        raise HTTPException(status_code=400, detail="请提供 doc_text / doc_url / curl / openapi_url 或 definition")

    # 调用 LLM 解析
    try:
        from app.pipelines.llm_service import llm_service
        system_prompt = """你是一个 API 集成专家。用户提供了某生成类 API（生图/生视频/语音合成）的文档、cURL 或 OpenAPI 片段。
请解析并输出一个 ProviderDefinition JSON，用于通用 HTTP Provider 执行。

必须严格输出 JSON（无 markdown），结构如下：
{
  "name": "展示名",
  "description": "一句话描述",
  "transport": {"method": "POST", "url": "https://api.xxx.com/v1/images/generations", "headers": {"Content-Type": "application/json"}, "timeout": 60},
  "auth": {"type": "bearer|apikey_header|apikey_query|none", "header_name": "X-API-Key", "query_name": "api_key", "prefix": "Bearer "},
  "mapping": {
    "request_template": {"model": "{model}", "prompt": "{prompt}", "negative_prompt": "{negative_prompt}", "size": "{size}", "seed": "{seed}"},
    "response_mappings": {"image_url": "data[0].url", "video_url": "data.video_url", "audio_url": "data.audio_url"}
  },
  "health_check": {"url": "https://api.xxx.com/v1/user/info", "method": "GET"},
  "models": ["model-a", "model-b"],
  "default_model": "model-a",
  "params_schema": {"type":"object","properties":{"steps":{"type":"integer"},"cfg":{"type":"number"}}},
  "default_params": {},
  "input_schema": {"type":"object","properties":{"prompt":{"type":"string","description":"提示词","x-handle":"text"},"reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考图","x-handle":"image"}},"required":["prompt"]},
  "output_schema": {"type":"object","properties":{"image_url":{"type":"string","format":"uri","x-handle":"image"}}}
}
规则：
- transport.url 必须为完整 https URL，从文档中提取
- auth.type 根据文档鉴权方式判断：Authorization Bearer 为 bearer；X-API-Key 头为 apikey_header；query api_key 为 apikey_query
- mapping.request_template 使用 {prompt} {negative_prompt} {width} {height} {size} {seed} {model} {api_key} 占位
- mapping.response_mappings 的 path 使用简化 JSONPath：如 data[0].url 或 images[0].url
- 若文档未提及则合理推断常见路径
- input_schema 必须用 x-handle 标注句柄：image→image, video→video, audio→audio, text/prompt→text；video 需含 prompt:text, first_frame:image, reference_images:image[]（多图）, reference_audios:audio[]；image 需含 prompt:text, reference_images:image[]
- output_schema 对应 kind：image→image_url x-handle:image, video→video_url x-handle:video, audio→audio_url x-handle:audio
 只输出 JSON，不要解释。
"""
        user_prompt = f"kind: {req.kind}\nname_hint: {req.name or ''}\n\nAPI 文档/示例:\n{doc_content[:6000]}"
        parsed = await llm_service.chat_json(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.2)
        # llm_service.chat_json 已提取最外层 JSON
        if not isinstance(parsed, dict):
            raise ValueError(f"LLM 返回非对象: {parsed}")
        # 合并
        merged: Dict[str, Any] = {}
        merged.update(parsed)
        # 智能推断 kind：若 LLM 返回的 kind 与文档明显不符（如 H3 误判为 image），以文档为准
        inferred = _infer_kind_from_doc(doc_content, parsed.get("transport", {}).get("url","") if isinstance(parsed.get("transport"), dict) else "")
        if inferred and inferred != (req.kind or merged.get("kind", "image")):
            # 若请求显式指定 kind 且与推断冲突，优先推断（避免 H3 归为 image）
            if req.kind in (None, "", "image") and inferred == "video":
                merged["kind"] = inferred
            elif req.kind and inferred != req.kind:
                # 记录但仍尊重 LLM 的 transport.url 证据，若 LLM 说 image 但 URL 含 video 则纠正
                if "video" in (parsed.get("transport", {}).get("url","") if isinstance(parsed.get("transport"), dict) else "").lower():
                    merged["kind"] = "video"
                else:
                    merged["kind"] = req.kind or merged.get("kind", "image")
            else:
                merged["kind"] = req.kind or merged.get("kind", "image")
        else:
            merged["kind"] = req.kind or merged.get("kind", "image")
        if req.name:
            merged["name"] = req.name
        elif not merged.get("name"):
            merged["name"] = f"自定义{req.kind}源"
        merged["provider_type"] = "http"
        merged["scope"] = "global"
        merged["enabled"] = True
        merged["doc_text"] = doc_content[:4000]
        merged["raw_api_doc"] = doc_content[:4000]
        if req.doc_url:
            merged["doc_url"] = req.doc_url
        if req.openapi_url and not merged.get("doc_url"):
            merged["doc_url"] = req.openapi_url
        # 生成 id
        import uuid
        pid = f"prov_{uuid.uuid4().hex[:8]}"
        merged["id"] = pid
        if req.api_key:
            merged.setdefault("auth", {})["key_env"] = f"CUSTOM_PROVIDER_{pid}"

        pd = ProviderDefinition.model_validate(merged)
        if not pd.params_schema or not pd.params_schema.get("properties"):
            pd.params_schema = _default_params_schema(pd.kind)
        if not pd.input_schema or not pd.input_schema.get("properties"):
            pd.input_schema = _default_input_schema(pd.kind)
        if not pd.output_schema or not pd.output_schema.get("properties"):
            pd.output_schema = _default_output_schema(pd.kind)
        saved = custom_provider_manager.save_definition(pd)
        if req.api_key:
            _save_api_key(saved.id, req.api_key)
        from app.providers.init_providers import register_single_custom_provider
        register_single_custom_provider(saved)
        return {"status": "success", "provider": _sanitize_for_frontend(saved), "mode": "llm_parsed", "llm_raw": parsed}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM 解析失败: {e}")


@router.post("/providers/{provider_id}/api-key")
async def set_provider_api_key(provider_id: str, body: Dict[str, Any] = Body(...)):
    """单独设置/更新 Provider 的 API Key"""
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    api_key = body.get("api_key", "")
    if not api_key or not str(api_key).strip():
        raise HTTPException(status_code=400, detail="api_key 不能为空")
    _save_api_key(provider_id, str(api_key).strip())
    # 更新 definition 的 key_env
    if not pd.auth.key_env:
        pd.auth.key_env = f"CUSTOM_PROVIDER_{provider_id}"
        custom_provider_manager.save_definition(pd)
    return {"status": "success", "provider_id": provider_id, "has_key": True}


@router.get("/providers/custom/stats")
async def custom_provider_stats():
    customs = custom_provider_manager.list_definitions()
    by_kind: Dict[str, int] = {}
    for pd in customs:
        by_kind[pd.kind] = by_kind.get(pd.kind, 0) + 1
    return {"total": len(customs), "by_kind": by_kind}
