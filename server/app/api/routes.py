import os
import json
import asyncio
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool
from app.models.schemas import (
    Project, ScriptParseRequest, TTSGenerateRequest,
    ImageGenerateRequest, Character3ViewsRequest, PipelineRunRequest,
    VideoGenerateRequestPayload,
    MCPToolDefinition, MCPToolCallRequest, MCPToolCallResponse
)
from app.pipelines.script_agent import script_agent
from app.pipelines.llm_service import llm_service, LLMServiceError
from app.pipelines.jianyin_exporter import jianyin_exporter
from app.pipelines.consistency_engine import consistency_engine
from app.pipelines.unified_orchestrator import unified_orchestrator
from app.mcp.server import mcp_registry
from app.skills.engine import skill_engine, SkillDefinition, SkillExecutionResult
from app.core.config import settings, read_env_file, write_env_file, MANAGED_KEYS
from pydantic import BaseModel, Field
import httpx
# LangChain Agent 引擎（带记忆、循环、流式）
try:
    from app.pipelines.agent.langchain_engine import run_agent_with_langchain, clear_session, get_history, SESSION_MEMORY
    HAS_LANGCHAIN_AGENT = True
except Exception as e:
    HAS_LANGCHAIN_AGENT = False
    print(f"[Agent] LangChain engine not available: {e}")

# 延迟初始化 providers（避免循环导入）
def get_image_registry():
    from app.providers.image.registry import image_registry
    if not image_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return image_registry

def get_audio_registry():
    from app.providers.audio.registry import audio_registry
    if not audio_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return audio_registry

def get_video_registry():
    from app.providers.video.registry import video_registry
    if not video_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return video_registry

def get_workflow_manager():
    from app.providers.workflow.manager import workflow_manager
    return workflow_manager

class SkillExecuteRequest(BaseModel):
    skill_name: str
    context: Dict[str, Any] = {}
    user_prompt: str = ""

router = APIRouter()

# ============================================================
# Skills 技能工坊
# ============================================================

@router.get("/skills", response_model=List[SkillDefinition])
async def list_skills():
    """获取所有已加载的技能 (Skills)"""
    return skill_engine.list_skills()

@router.post("/skills/execute", response_model=SkillExecutionResult)
async def execute_skill(req: SkillExecuteRequest):
    """执行指定 Skill 并自动触发其声明的 MCP 工具链与系统能力"""
    return await skill_engine.execute_skill(req.skill_name, req.context, req.user_prompt)

# ============================================================
# 剧本拆解（真实 MiniMax LLM）
# ============================================================

@router.post("/projects/parse-script", response_model=Project)
async def parse_script(req: ScriptParseRequest):
    """
    [长文小说拆解] 调用 MiniMax LLM 将小说章节拆解为结构化角色与分镜剧本。
    未配置 MINIMAX_API_KEY 时返回 503，不产出任何假数据。
    """
    try:
        return await script_agent.parse_novel_to_project(
            novel_text=req.text,
            style_preset=req.style_preset,
            aspect_ratio=req.aspect_ratio,
            custom_instructions=req.custom_instructions or ""
        )
    except LLMServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"剧本拆解失败: {e}")

# ============================================================
# TTS 配音（动态Provider）
# ============================================================

@router.get("/tts/providers")
async def list_tts_providers():
    """列出所有音频Providers及健康状态"""
    reg = get_audio_registry()
    providers = reg.list_providers()
    health = await reg.check_health_all()
    for p in providers:
        p["health"] = health.get(p["id"], {})
    return {"providers": providers}

@router.get("/tts/voices")
async def list_voices(provider: Optional[str] = None):
    """获取音色库：若指定provider则返回该provider音色，否则返回minimax预设"""
    reg = get_audio_registry()
    if provider:
        prov = reg.get(provider)
        if not prov:
            raise HTTPException(status_code=404, detail=f"未知音频Provider: {provider}")
        voices = await prov.list_voices()
        return {"provider": provider, "voices": voices}
    # 默认返回所有provider的 voices 聚合，或 minimax
    prov = reg.get("minimax")
    if prov:
        voices = await prov.list_voices()
        return {"provider": "minimax", "voices": voices}
    return {"voices": []}

@router.get("/tts/voices/{provider_id}")
async def list_voices_by_provider(provider_id: str):
    reg = get_audio_registry()
    prov = reg.get(provider_id)
    if not prov:
        raise HTTPException(status_code=404, detail=f"未知音频Provider: {provider_id}")
    voices = await prov.list_voices()
    return {"provider": provider_id, "voices": voices, "is_configured": prov.is_configured(), "health": await prov.check_health()}

@router.post("/tts/generate")
async def generate_speech(req: TTSGenerateRequest):
    """[TTS] 动态Provider生成配音（返回可播放的 /storage mp3 地址）"""
    try:
        from app.providers.audio.base import AudioGenerateRequest
        reg = get_audio_registry()
        audio_req = AudioGenerateRequest(
            text=req.text,
            voice_id=req.voice_id,
            emotion=req.emotion,
            speed=req.speed,
            pitch=req.pitch,
            ref_audio_path=req.ref_audio_path,
            ref_text=req.ref_text,
            model=req.model,
        )
        prov_id = req.provider or settings.TTS_PROVIDER
        res = await reg.generate(audio_req, provider_id=prov_id)
        return {
            "audio_url": res.audio_url,
            "local_path": res.local_path,
            "voice_id": res.voice_id,
            "text": res.text,
            "emotion": res.emotion,
            "duration": res.duration,
            "status": res.status,
            "provider": res.provider,
            "engine": res.engine,
        }
    except RuntimeError as e:
        msg = str(e)
        if "未配置" in msg or "API_KEY" in msg:
            raise HTTPException(status_code=503, detail=msg)
        raise HTTPException(status_code=502, detail=f"TTS 生成失败: {e}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS 生成失败: {e}")

# ============================================================
# 图片生成（动态Provider + 工作流）
# ============================================================

@router.get("/images/providers")
async def list_image_providers():
    """列出所有图片Providers及健康状态"""
    reg = get_image_registry()
    providers = reg.list_providers()
    health = await reg.check_health_all()
    for p in providers:
        p["health"] = health.get(p["id"], {})
    return {"providers": providers}

@router.get("/images/health")
async def images_health(provider: Optional[str] = None):
    """检测图片服务可用性：不带参数返回全部，带provider返回单个"""
    reg = get_image_registry()
    if provider:
        prov = reg.get(provider)
        if not prov:
            raise HTTPException(status_code=404, detail=f"未知图片Provider: {provider}")
        online = await prov.check_health()
        return {"provider": provider, "online": online, "is_configured": prov.is_configured(), "capabilities": prov.get_capabilities()}
    # 兼容旧前端：返回 comfyui 状态 + 全部
    health = await reg.check_health_all()
    # 保持旧字段 server_url
    comfy = reg.get("comfyui")
    comfy_online = False
    comfy_url = ""
    if comfy:
        from app.providers.image.comfyui import ComfyUIProvider
        if isinstance(comfy, ComfyUIProvider):
            comfy_online = health.get("comfyui", {}).get("ok", False)
            comfy_url = comfy.server_url
    return {"online": comfy_online, "server_url": comfy_url, "providers": health}

@router.post("/images/generate")
async def generate_image(req: ImageGenerateRequest):
    """[动态生图] 通过指定Provider生成漫剧分镜图像，返回落盘后的本地图片 URL。支持 provider/workflow_id/model/steps/cfg"""
    try:
        from app.providers.image.base import ImageGenerateRequest as ImgReq
        reg = get_image_registry()
        img_req = ImgReq(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or "",
            aspect_ratio=req.aspect_ratio,
            style_preset=req.style_preset,
            seed=req.seed,
            workflow_id=req.workflow_id,
            model=req.model,
            width=req.width,
            height=req.height,
            steps=req.steps,
            cfg=req.cfg,
            dynamic_inputs=req.dynamic_inputs,
        )
        prov_id = req.provider
        if req.workflow_id and not prov_id:
            prov_id = "comfyui"
        res = await reg.generate(img_req, provider_id=prov_id)
        return {
            "image_url": res.image_url,
            "local_path": res.local_path,
            "provider": res.provider,
            "engine": res.engine,
            "seed": res.seed,
            "width": res.width,
            "height": res.height,
            "elapsed_ms": res.elapsed_ms,
            "prompt_id": res.prompt_id,
            "checkpoint": res.checkpoint,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        msg = str(e)
        status = 503 if any(x in msg for x in ["无法连接", "未配置", "ComfyUI", "SiliconFlow", "DashScope"]) else (400 if isinstance(e, ValueError) else 500)
        raise HTTPException(status_code=status, detail=msg)

@router.post("/images/character-3views")
async def generate_character_3views(req: Character3ViewsRequest):
    """为角色生成三视图（正面/侧面/3-4 动态），基于一致性提示词引擎 + 动态生图"""
    class _CharLike:
        pass
    char = _CharLike()
    char.name = req.name
    char.visual_prompt = req.visual_prompt
    char.description = req.description

    prompts = consistency_engine.build_character_3views_prompts(char, req.style_preset)
    views: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    from app.providers.image.base import ImageGenerateRequest as ImgReq
    reg = get_image_registry()
    for view_key, prompt in prompts.items():
        try:
            img_req = ImgReq(prompt=prompt, aspect_ratio="1:1", style_preset=req.style_preset)
            res = await reg.generate(img_req)
            views[view_key] = res.image_url
        except Exception as e:
            errors[view_key] = str(e)

    if not views and errors:
        detail = "; ".join(errors.values())
        status = 503 if "无法连接" in detail else 500
        raise HTTPException(status_code=status, detail=detail)

    return {
        "name": req.name,
        "three_views": views,
        "errors": errors,
        "status": "success" if not errors else "partial",
    }

# --- ComfyUI 工作流管理（支持外部目录直读）---
@router.get("/images/workflows")
async def list_workflows(source: str = "all"):
    """
    列出所有ComfyUI工作流
    source: all | internal | external
    - internal: 仅 storage/workflows 中导入的
    - external: 仅 COMFYUI_WORKFLOWS_DIR 目录直读的
    - all: 合并两者，Agent/前端可直接用 workflow_id 生成（外部id为 ext_xxx）
    """
    mgr = get_workflow_manager()
    if source not in ("all", "internal", "external"):
        source = "all"
    workflows = mgr.list_workflows(source=source)
    return {
        "workflows": workflows,
        "source": source,
        "external_dir": mgr.get_external_dir(),
        "counts": {
            "total": len(workflows),
            "internal": len([w for w in workflows if w.get("source") == "internal"]),
            "external": len([w for w in workflows if w.get("source") == "external"]),
        }
    }

@router.get("/images/workflows/external/dir")
async def get_external_workflows_dir():
    mgr = get_workflow_manager()
    ext_dir = mgr.get_external_dir()
    cfg_dir = getattr(settings, "COMFYUI_WORKFLOWS_DIR", "")
    return {
        "configured_dir": cfg_dir,
        "resolved_dir": ext_dir,
        "exists": bool(ext_dir and os.path.exists(ext_dir)),
        "is_configured": bool(cfg_dir),
    }

@router.get("/images/workflows/{workflow_id}")
async def get_workflow(workflow_id: str):
    mgr = get_workflow_manager()
    wf, meta = mgr.get_workflow_with_meta(workflow_id) if hasattr(mgr, "get_workflow_with_meta") else (mgr.get_workflow(workflow_id), mgr.get_meta(workflow_id))
    if not wf:
        raise HTTPException(status_code=404, detail=f"工作流不存在: {workflow_id}")
    return {"workflow_id": workflow_id, "meta": meta, "workflow": wf}

@router.delete("/images/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str):
    mgr = get_workflow_manager()
    if workflow_id.startswith("ext_"):
        raise HTTPException(status_code=400, detail="外部工作流为只读，不能删除。请直接在文件系统中删除对应JSON文件，或先导入为内部工作流")
    wf = mgr.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail=f"工作流不存在: {workflow_id}")
    mgr.delete_workflow(workflow_id)
    return {"status": "deleted", "workflow_id": workflow_id}

@router.post("/images/workflows/import/{external_id}")
async def import_external_workflow(external_id: str, new_name: Optional[str] = None):
    """将外部目录中的工作流导入为内部持久化工作流（可编辑映射）"""
    mgr = get_workflow_manager()
    try:
        meta = mgr.import_external_workflow(external_id, new_name=new_name)
        return {"status": "imported", "workflow": meta}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/images/workflows/upload")
async def upload_workflow(
    file: UploadFile = File(None),
    workflow_json: Optional[str] = Form(None),
    name: str = Form(""),
    description: str = Form(""),
    mapping: Optional[str] = Form(None),
):
    """
    导入ComfyUI工作流 (API Format JSON)
    支持两种上传方式：
    1. file: 上传 .json 文件
    2. workflow_json: 直接贴 JSON 文本
    可选 mapping: JSON字符串 {"prompt_node":"6", ...}
    """
    mgr = get_workflow_manager()
    data = None
    if file and file.filename:
        content = await file.read()
        try:
            data = json.loads(content.decode("utf-8"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"JSON 文件解析失败: {e}")
    elif workflow_json:
        try:
            data = json.loads(workflow_json)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"JSON 文本解析失败: {e}")
    else:
        raise HTTPException(status_code=400, detail="请上传 .json 文件或提供 workflow_json 文本")

    # mapping 解析
    map_dict = None
    if mapping:
        try:
            map_dict = json.loads(mapping)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"mapping JSON 解析失败: {e}")

    try:
        meta = mgr.save_workflow(name=name or (file.filename if file else "workflow"), workflow_json=data, mapping=map_dict, description=description)
        return {"status": "success", "workflow": meta}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存工作流失败: {e}")

@router.put("/images/workflows/{workflow_id}/mapping")
async def update_workflow_mapping(workflow_id: str, body: Dict[str, Any]):
    mgr = get_workflow_manager()
    mapping = body.get("mapping")
    if not mapping or not isinstance(mapping, dict):
        raise HTTPException(status_code=400, detail="需提供 mapping 对象 {prompt_node: id, ...}")
    try:
        meta = mgr.update_mapping(workflow_id, mapping)
        return {"status": "success", "meta": meta}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/images/workflows/{workflow_id}/inspect")
async def inspect_workflow_parameters(workflow_id: str):
    """深度解析工作流的所有可配置节点、参数类型与 ComfyUI 可用模型选项"""
    mgr = get_workflow_manager()
    try:
        data = mgr.inspect_workflow_nodes(workflow_id)
        return {"status": "success", "data": data}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"解析工作流参数失败: {e}")

@router.post("/images/workflows/{workflow_id}/preview")
async def preview_workflow_injection(workflow_id: str, body: Dict[str, Any]):
    """预览工作流参数注入后的最终 JSON（不实际提交至 ComfyUI），用于调试暴露输入是否生效"""
    mgr = get_workflow_manager()
    try:
        wf, meta = mgr.get_workflow_with_meta(workflow_id)
        if not wf:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        mapping = (meta or {}).get("mapping", {})
        node_overrides = (meta or {}).get("node_overrides", {})
        is_api_frugally = False
        if meta:
            is_api_frugally = (not meta.get("auto_converted", False)) and bool(meta.get("is_api_format", True))
        injected = mgr.inject_params(
            wf,
            mapping,
            {
                "prompt": body.get("prompt") or body.get("image_prompt") or "test prompt",
                "negative_prompt": body.get("negative_prompt") or "",
                "seed": body.get("seed") or 123,
                "width": body.get("width") or 1024,
                "height": body.get("height") or 1024,
                "style_suffix": body.get("style_suffix") or "",
                "checkpoint": body.get("checkpoint"),
                "steps": body.get("steps"),
                "cfg": body.get("cfg"),
            },
            node_overrides=node_overrides,
            dynamic_inputs=body.get("dynamic_inputs"),
            is_api_frugally=is_api_frugally,
        )
        # 标注哪些节点被 dynamic 覆盖
        dyn = body.get("dynamic_inputs") or {}
        annotated = {}
        for nid, node in injected.items():
            ann = dict(node)
            # 检查该节点是否被 dynamic 命中
            hit = []
            for k in dyn.keys():
                if str(k) in nid or str(k).endswith(f"_{nid}") or str(k) == f"txt_{nid}" or str(k) == f"img_{nid}" or str(k) == f"exp_{nid}_text" or str(k) == f"exp_{nid}_image":
                    hit.append(k)
            if hit:
                ann["_dynamic_hit"] = hit
            annotated[nid] = ann
        return {"status": "success", "workflow_id": workflow_id, "is_api_frugally": is_api_frugally, "mapping": mapping, "injected": annotated, "dynamic_inputs_received": dyn}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"预览注入失败: {e}")

@router.post("/images/workflows/{workflow_id}/overrides")
async def save_workflow_node_overrides(workflow_id: str, body: Dict[str, Any]):
    """保存工作流的槽位映射、节点参数默认覆写值与外部暴露字段"""
    mgr = get_workflow_manager()
    mapping = body.get("mapping")
    node_overrides = body.get("node_overrides")
    exposed_inputs = body.get("exposed_inputs")
    auto_import = body.get("auto_import_if_ext", True)
    try:
        meta = mgr.save_workflow_overrides(
            workflow_id=workflow_id,
            mapping=mapping,
            node_overrides=node_overrides,
            exposed_inputs=exposed_inputs,
            auto_import_if_ext=auto_import
        )
        return {"status": "success", "meta": meta}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存参数覆写失败: {e}")

@router.post("/images/comfyui/upload")
async def upload_image_to_comfyui_route(file: UploadFile = File(...)):
    """上传本地图片到 ComfyUI input 目录"""
    from app.providers.workflow.manager import upload_image_to_comfyui
    contents = await file.read()
    import base64
    b64 = f"data:image/png;base64,{base64.b64encode(contents).decode('utf-8')}"
    try:
        uploaded_name = await upload_image_to_comfyui(b64)
        return {"status": "success", "name": uploaded_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"上传到 ComfyUI 失败: {e}")

@router.post("/images/workflows/{workflow_id}/validate")
async def validate_workflow_with_comfyui(workflow_id: str):
    """向本地/远程 ComfyUI 发起真实校验探测"""
    mgr = get_workflow_manager()
    try:
        result = await mgr.validate_workflow_against_comfyui(workflow_id)
        return {"status": "success", "data": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"校验探测失败: {e}")

@router.get("/images/workflows/{workflow_id}/slots")
async def list_workflow_slots(workflow_id: str):
    """[兼容 CLI] 列出工作流中所有可编辑槽位（等价于 `comfy workflow slots`）"""
    mgr = get_workflow_manager()
    try:
        slots = mgr.list_workflow_slots(workflow_id)
        return {"status": "success", "workflow_id": workflow_id, "slots": slots, "count": len(slots)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取槽位失败: {e}")

@router.put("/images/workflows/{workflow_id}/node/{node_id}/{param_name}")
async def set_workflow_node_param(workflow_id: str, node_id: str, param_name: str, body: Dict[str, Any]):
    """[兼容 CLI] 直接编辑指定节点的参数（等价于 `comfy workflow set-slot`）"""
    mgr = get_workflow_manager()
    if "value" not in body:
        raise HTTPException(status_code=400, detail="需提供 body.value")
    try:
        result = mgr.set_workflow_node_param(workflow_id, node_id, param_name, body["value"])
        return {"status": "success", "data": result}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"设置参数失败: {e}")

@router.post("/images/workflows/compose")
async def compose_workflow_from_fragments(body: Dict[str, Any]):
    """[兼容 CLI] 将多个工作流片段组合为新工作流（等价于 `comfy workflow compose`）"""
    mgr = get_workflow_manager()
    fragments = body.get("fragments") or []
    name = body.get("name") or "composed_workflow"
    if not fragments:
        raise HTTPException(status_code=400, detail="需提供 fragments: [{workflow_id, prefix}]")
    try:
        composed = mgr.compose_workflow_from_fragments(fragments)
        meta = mgr.save_workflow(name=name, workflow_json=composed, description=f"由 {len(fragments)} 个片段组合")
        return {"status": "success", "workflow_id": meta["id"], "meta": meta, "node_count": len(composed)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"组合失败: {e}")

# ============================================================
# 动态视频生成 (I2V 图生视频 / R2V 参考生视频 / T2V 文生视频)
# ============================================================

@router.get("/videos/providers")
async def list_video_providers():
    """获取所有已注册的视频 Provider 列表及其特性 (I2V/R2V/T2V)"""
    reg = get_video_registry()
    return reg.list_providers()

@router.get("/videos/health")
async def check_videos_health():
    """检查视频生成服务可用性与配置状态"""
    reg = get_video_registry()
    return await reg.check_health_all()

@router.get("/videos/status/{task_id}")
async def get_video_task_status(task_id: str):
    """查询异步视频生成任务状态"""
    from app.providers.video.minimax_video import CloudVideoProvider
    return CloudVideoProvider.get_task_status(task_id)

@router.post("/videos/generate")
async def generate_video(req: VideoGenerateRequestPayload):
    """[动态视频生成] 支持图生视频(i2v) / 参考生视频(r2v) / 文生视频(t2v)"""
    try:
        from app.providers.video.base import VideoGenerateRequest as VidReq
        reg = get_video_registry()
        vid_req = VidReq(
            prompt=req.prompt,
            mode=req.mode or "i2v",
            first_frame_url=req.first_frame_url,
            last_frame_url=req.last_frame_url,
            reference_images=req.reference_images,
            reference_videos=req.reference_videos,
            duration=req.duration or 5,
            resolution=req.resolution or "720p",
            aspect_ratio=req.aspect_ratio or "9:16",
            seed=req.seed,
            provider=req.provider,
            workflow_id=req.workflow_id,
        )
        res = await reg.generate(vid_req, provider_id=req.provider)
        return {
            "video_url": res.video_url,
            "local_path": res.local_path,
            "provider": res.provider,
            "engine": res.engine,
            "duration": res.duration,
            "elapsed_ms": res.elapsed_ms,
            "task_id": res.task_id,
            "first_frame_url": res.first_frame_url,
            "shot_id": req.shot_id,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        msg = str(e)
        status = 503 if any(x in msg for x in ["无法连接", "未配置", "ComfyUI", "MiniMax", "Kling"]) else 500
        raise HTTPException(status_code=status, detail=msg)

# ============================================================
# MCP 统一协议
# ============================================================

@router.get("/mcp/tools", response_model=List[MCPToolDefinition])
async def list_mcp_tools():
    """[MCP 统一协议] 获取所有已注册的漫剧 Agent 工具（动态Provider已全部暴露）"""
    return mcp_registry.get_all_tools()

@router.post("/mcp/call", response_model=MCPToolCallResponse)
async def call_mcp_tool(req: MCPToolCallRequest):
    """[MCP 统一协议] 远程执行指定 MCP 工具"""
    return await mcp_registry.execute_tool(req.tool_name, req.arguments)

# ============================================================
# 剪映草稿导出（pyJianYingDraft 真实工程）
# ============================================================

@router.post("/projects/export-jianyin")
async def export_jianyin_draft(project: Project):
    """一键导出剪映 / CapCut 官方草稿工程文件（含画面轨、配音轨、字幕轨）"""
    try:
        return await jianyin_exporter.export_project_to_jianyin_draft_async(project)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"剪映草稿导出失败: {e}")

# ============================================================
# 全链路编排（LLM 拆解 → 生图 → 配音 → 导出）
# ============================================================

@router.post("/pipeline/full-run")
async def pipeline_full_run(req: PipelineRunRequest):
    """全链路真实编排：小说 → 分镜 → 批量生图（动态Provider） → TTS → 剪映草稿"""
    try:
        return await unified_orchestrator.execute_full_pipeline(
            novel_text=req.text,
            style_preset=req.style_preset,
            aspect_ratio=req.aspect_ratio,
            custom_instructions=req.custom_instructions or "",
            max_images=req.max_images,
            image_provider=getattr(req, "image_provider", None),
            image_workflow_id=getattr(req, "image_workflow_id", None),
            audio_provider=getattr(req, "audio_provider", None),
        )
    except LLMServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"全链路执行失败: {e}")

# ============================================================
# 导演 Agent 实时通道（真 LLM 决策，暴露全部生成能力）
# ============================================================

AGENT_SYSTEM_PROMPT = """你是「AI漫剧导演 Agent」，运行在 MiniMax AI漫剧 Studio 中。
用户会用自然语言向你下达导演指令。你可以调用以下 MCP 工具（已全部动态注册，所有生成能力均对你开放）：

**图片生成（动态Provider）：**
1. generate_image —— 通用生图。参数：prompt(必填,英文画面描述), provider(comfyui/siliconflow/dashscope/openai_compat), workflow_id(仅comfyui, 通过list_comfyui_workflows查询可用工作流), aspect_ratio(9:16/16:9/1:1), style_preset(donghua_xianxia/japanese_anime/modern_webtoon/cinematic_3d/dark_comic), negative_prompt, seed, model, steps, cfg
   - 示例：{"prompt": "a boy with glowing eyes, ancient robes", "provider": "siliconflow", "aspect_ratio": "9:16"}
   - 若指定 workflow_id 则使用该ComfyUI自定义工作流 + 提示词注入
2. comfyui_render_node —— ComfyUI专用生图（兼容generate_image provider=comfyui）参数：prompt, aspect_ratio, style_preset, workflow_id, seed
3. list_image_providers —— 查询所有图片Providers健康状态
4. list_comfyui_workflows —— 查询已导入的ComfyUI工作流列表（含ID和描述），生成前可先查询

**音频生成（动态Provider）：**
5. generate_voice —— 通用配音。参数：text(必填), provider(minimax/elevenlabs/cosyvoice/gpt_sovits), voice_id, emotion(neutral/intense/sorrow/excited/fearful/whispering), speed, pitch, ref_audio_path(克隆用)
   - 示例：{"text": "这一世，我命由我不由天！", "provider": "elevenlabs", "voice_id": "21m00Tcm4TlvDq8ikWAM", "emotion": "intense"}
6. generate_minimax_voice —— MiniMax专用配音（兼容generate_voice provider=minimax）参数：text, voice_id(如 male-qn-qingse/female-shaonv/male-badao/male-pangbai), emotion
7. list_voice_providers —— 查询所有音频Providers
8. list_voices —— 查询指定Provider的音色列表，参数：provider

**素材库（Asset Library）：**
9. list_assets —— 搜索素材库。参数：category(character/scene/prop/background/effect/ui)、tag、q(关键词)、page/limit。示例：{"category":"scene","q":"雪山"} 
10. get_asset —— 获取素材详情。参数：asset_id
11. create_asset —— 创建素材固化生成结果。参数：name, category, visual_prompt

**剧本/导演：**
12. split_novel_script —— 小说拆解。参数：novel_text, style_preset, aspect_ratio
13. director_3d_stage_plan —— 3D导演台相机规划。参数：framing(extreme_close_up/close_up/medium/full/long/bird_eye/low_angle), motion(static/push_in/pull_out/pan_left/pan_right/tilt_up/tilt_down/orbit/shake), pose(stand/fight/look_back/run)
14. export_jianyin_draft —— 剪映草稿导出。参数：project(完整Project JSON)

**生成源扩展（解耦后每个生成源为独立节点，可多源并存）：**
15. register_custom_provider —— [核心] 用户提供 API 文档/cURL/OpenAPI 时自动注册新生成源。参数：kind(image/video/audio/llm), name, doc_text, doc_url, curl, openapi_url, api_key, definition(可选完整JSON)。示例：{"kind":"image","name":"我的FLUX","doc_text":"POST https://api.xxx.com/v1/images/generations ...", "api_key":"sk-..."}。导演应自动解析并注册，成功后提示可在画布看到新 Provider 节点。
16. list_custom_providers —— 列出所有自定义 Provider。参数：kind。可先查询已有。
17. test_custom_provider —— 测试 Provider 连通性。参数：provider_id
18. delete_custom_provider —— 删除自定义 Provider。参数：provider_id
19. generate_video —— 通用视频生成。参数：prompt, mode(i2v/r2v/t2v), first_frame_url, reference_images, duration, provider

**无限画布（Canvas DAG，可视化编排）：**
20. canvas_query —— 查询画布摘要与节点清单，感知当前画布状态
21. canvas_create_node —— 创建节点。参数：type(brief/script-split/shot-card/comfy-workflow/provider-image/provider-video/provider-audio/video/tts/load-image/load-image-batch/load-video/load-audio/text-prompt/director3d/timeline-export), position{x,y}, params(可选内部参数)
22. canvas_update_node —— 更新节点。参数：node_id, patch(要更新的 data 字段)
23. canvas_connect —— 连线。参数：source, sourceHandle, target, targetHandle（类型需匹配 image/video/audio/text/provider）
24. canvas_execute —— 执行画布 DAG。参数：target_ids(可选，仅执行选中), project_id

**策略指引：**
- 用户说“生成图片/换图/重绘” → 优先 generate_image，可先 list_assets 查找可复用的 scene/prop 风格锚点；若用户指定“用XX生成源/用我的XX模型”，则用对应 provider
- 用户说“配音/换声线/生成语音” → 优先 generate_voice，根据角色/情绪选 provider 和 voice_id
- 用户说“找素材/素材库/场景/道具” → 优先 list_assets / get_asset
- 用户说“接入/添加/注册/扩展 生成源/模型/API/接口”或贴了 API 文档/cURL/OpenAPI → 必须调用 register_custom_provider，自动解析并注册。先用 doc_text/curl/doc_url 透传；若用户给了文档+key 则一并传入 api_key。成功后告知 Provider 节点已出现在画布仓库。
- 如需确认可用 provider/工作流/音色/素材，先调用对应的 list_* 查询工具再决策
- 可组合调用：例如“生成战斗画面并配怒吼”可同时调用 generate_image + generate_voice
- 多生成源：画布中每个 Provider 节点可独立存在，生图/视频/TTS 节点通过连线绑定具体 Provider，不再全局单选
- 用户说“画布/无限画布/连线/节点/批量生成/参考图/用工作流/让画布执行” → 优先 canvas_query 感知画布，再用 canvas_create_node/canvas_connect 编排，最后 canvas_execute 触发。参考图场景必须创建 load-image/load-image-batch 并连到 video.reference_images 或 comfy-workflow 的 image 输入

请严格输出 JSON（无 markdown 杂质）：
{
  "reply": "给用户的简短中文回复",
  "tool_calls": [{"tool": "工具名", "arguments": {...}}],
  "suggested_actions": ["建议用户下一步的中文操作"]
}
不需要调用工具时 tool_calls 为空数组。最多调用 2 个工具。"""

@router.websocket("/ws/agent")
async def websocket_agent_endpoint(websocket: WebSocket):
    """导演 Agent WebSocket：LangChain 多轮循环 + 记忆 + 真实流式"""
    await websocket.accept()
    # 会话隔离：使用连接id + 项目id 作为 session
    session_id = f"ws_{id(websocket)}"
    try:
        while True:
            data_str = await websocket.receive_text()
            data = json.loads(data_str)

            if data.get("action") not in ("agent_prompt", "clear_history"):
                await websocket.send_json({"event": "error", "message": f"未知 action: {data.get('action')}"})
                continue

            if data.get("action") == "clear_history":
                if HAS_LANGCHAIN_AGENT:
                    await clear_session(session_id)
                else:
                    # 兼容：清空时不做处理
                    pass
                await websocket.send_json({"event": "agent_response", "message": "已清空对话历史", "suggested_actions": []})
                continue

            prompt_text = (data.get("prompt") or "").strip()
            context = data.get("context") or {}
            # 支持前端传入 session_id 实现跨连接记忆
            if data.get("session_id"):
                session_id = str(data.get("session_id"))
            elif context.get("project_id"):
                session_id = f"proj_{context.get('project_id')}"

            if not prompt_text:
                await websocket.send_json({"event": "error", "message": "指令不能为空"})
                continue

            # 优先使用 LangChain 引擎（带记忆、循环、流式）
            if HAS_LANGCHAIN_AGENT:
                try:
                    # 发送 thinking 由引擎内部发送，这里先发送一个占位
                    await websocket.send_json({"event": "agent_thinking", "message": f"正在解析导演指令: 「{prompt_text[:40]}」..."})
                    # 流式标记：引擎会自行发送 agent_stream_chunk / tool_calling / tool_result
                    # 先发送 stream_start 占位，引擎内部的 astream 会持续发送 chunk
                    await websocket.send_json({"event": "agent_stream_start"})
                    result = await run_agent_with_langchain(
                        prompt=prompt_text,
                        context=context,
                        session_id=session_id,
                        websocket=websocket,
                        max_iterations=6,
                        streaming=True,
                    )
                    await websocket.send_json({
                        "event": "agent_response",
                        "message": result.get("reply", "指令已执行。"),
                        "suggested_actions": result.get("suggested_actions") or [],
                        "executed_tools": result.get("executed_tools") or [],
                    })
                except LLMServiceError as e:
                    await websocket.send_json({"event": "error", "message": str(e)})
                except Exception as e:
                    await websocket.send_json({"event": "error", "message": f"Agent 执行失败: {e}"})
                continue

            # 回退：原有单轮逻辑（无 LangChain 时）
            await websocket.send_json({"event": "agent_thinking", "message": f"正在解析导演指令: 「{prompt_text[:40]}」..."})

            try:
                decision = await llm_service.chat_json(
                    system_prompt=AGENT_SYSTEM_PROMPT,
                    user_prompt=json.dumps({
                        "instruction": prompt_text,
                        "context": {
                            "project_title": context.get("project_title"),
                            "active_shot": context.get("active_shot"),
                            "platform": context.get("platform"),
                        },
                    }, ensure_ascii=False),
                    temperature=0.2,
                )
            except LLMServiceError as e:
                await websocket.send_json({"event": "error", "message": str(e)})
                continue
            except Exception as e:
                await websocket.send_json({"event": "error", "message": f"Agent 决策失败: {e}"})
                continue

            for call in (decision.get("tool_calls") or [])[:3]:
                tool_name = call.get("tool", "")
                arguments = call.get("arguments") or {}
                await websocket.send_json({
                    "event": "tool_calling",
                    "tool_name": tool_name,
                    "arguments": arguments,
                    "status": "executing",
                })
                result = await mcp_registry.execute_tool(tool_name, arguments)
                payload = {
                    "event": "tool_result",
                    "tool_name": tool_name,
                    "status": result.status,
                }
                if result.status == "success":
                    payload["result"] = result.result
                else:
                    payload["error"] = result.error
                await websocket.send_json(payload)

            reply_text = decision.get("reply", "指令已执行。")
            await websocket.send_json({"event": "agent_stream_start"})
            chunk_size = 3
            for i in range(0, len(reply_text), chunk_size):
                await websocket.send_json({
                    "event": "agent_stream_chunk",
                    "delta": reply_text[i:i+chunk_size]
                })

            await websocket.send_json({
                "event": "agent_response",
                "message": reply_text,
                "suggested_actions": decision.get("suggested_actions") or [],
            })
    except WebSocketDisconnect:
        pass
    except json.JSONDecodeError:
        try:
            await websocket.send_json({"event": "error", "message": "消息格式错误（需 JSON）"})
        except Exception:
            pass

# ============================================================
# 系统配置（读写 .env + 连通性测试）
# ============================================================

class ConfigUpdateRequest(BaseModel):
    # MiniMax
    MINIMAX_API_KEY: Optional[str] = Field(default="")
    MINIMAX_GROUP_ID: Optional[str] = Field(default="")
    MINIMAX_BASE_URL: Optional[str] = Field(default="https://api.minimax.chat/v1")
    LLM_MODEL: Optional[str] = Field(default="abab6.5s-chat")
    TTS_MODEL: Optional[str] = Field(default="speech-01-turbo")
    VIDEO_MODEL: Optional[str] = Field(default="video-01")

    # LLM Provider & OpenAI / Responses API / DeepSeek
    LLM_PROVIDER: Optional[str] = Field(default="openai_compatible")
    LLM_API_TYPE: Optional[str] = Field(default="chat_completions")
    OPENAI_API_KEY: Optional[str] = Field(default="")
    OPENAI_BASE_URL: Optional[str] = Field(default="https://api.deepseek.com/v1")
    OPENAI_MODEL: Optional[str] = Field(default="deepseek-chat")
    RESPONSES_API_URL: Optional[str] = Field(default="https://api.openai.com/v1/responses")
    RESPONSES_API_KEY: Optional[str] = Field(default="")
    RESPONSES_MODEL: Optional[str] = Field(default="gpt-4o")

    # Image Generation
    IMAGE_PROVIDER: Optional[str] = Field(default="comfyui")
    COMFYUI_SERVER_URL: Optional[str] = Field(default="http://127.0.0.1:8188")
    COMFYUI_CHECKPOINT: Optional[str] = Field(default="")
    COMFYUI_TIMEOUT_SECONDS: Optional[str] = Field(default="240")
    COMFYUI_WORKFLOWS_DIR: Optional[str] = Field(default="")
    SILICONFLOW_API_KEY: Optional[str] = Field(default="")
    SILICONFLOW_IMAGE_MODEL: Optional[str] = Field(default="black-forest-labs/FLUX.1-schnell")
    DASHSCOPE_API_KEY: Optional[str] = Field(default="")
    DASHSCOPE_IMAGE_MODEL: Optional[str] = Field(default="wanx2.1-t2i-turbo")
    OPENAI_IMAGE_MODEL: Optional[str] = Field(default="dall-e-3")
    OPENAI_IMAGE_BASE_URL: Optional[str] = Field(default="")

    # Voice & TTS
    TTS_PROVIDER: Optional[str] = Field(default="minimax")
    COSYVOICE_URL: Optional[str] = Field(default="http://127.0.0.1:9233")
    GPTSOVITS_URL: Optional[str] = Field(default="http://127.0.0.1:9880")
    ELEVENLABS_API_KEY: Optional[str] = Field(default="")
    ELEVENLABS_MODEL: Optional[str] = Field(default="eleven_multilingual_v2")

    # Video Generation
    VIDEO_PROVIDER: Optional[str] = Field(default="minimax")
    KLING_API_KEY: Optional[str] = Field(default="")
    VIDU_API_KEY: Optional[str] = Field(default="")

    # JianYing Draft Custom Location
    JIANYIN_DRAFT_PATH: Optional[str] = Field(default="")

class ConfigTestRequest(BaseModel):
    target: str = Field(description="openai | responses_api | deepseek | qwen | minimax | comfyui | siliconflow | dashscope | elevenlabs | cosyvoice | gpt_sovits | jianyin | openai_compat")
    config: Dict[str, Any] | None = None

class AgentChatRequest(BaseModel):
    prompt: str
    context: Dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = Field(default=None, description="会话ID，用于多轮记忆隔离")
    stream: bool = Field(default=False, description="是否流式返回")

def _is_masked_placeholder(v: str) -> bool:
    return "****" in v

@router.get("/config")
async def get_config(unmask: bool = True):
    """返回当前生效配置。本地桌面端默认提供明文供用户编辑查看，可通过 unmask=false 脱敏。"""
    from app.core.config import get_primary_env_file, JSON_CONFIG_FILE
    primary_env = get_primary_env_file()
    raw_configs = read_env_file(unmask=True)
    masked_configs = read_env_file(unmask=False)

    return {
        "config": raw_configs if unmask else masked_configs,
        "masked_config": masked_configs,
        "has_env_file": primary_env.exists(),
        "env_file": str(primary_env),
        "json_backup_file": str(JSON_CONFIG_FILE),
        "checks": {
            "minimax_configured": bool(settings.MINIMAX_API_KEY),
            "openai_configured": bool(settings.OPENAI_API_KEY),
            "responses_configured": bool(settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY),
            "comfyui_url": settings.COMFYUI_SERVER_URL,
            "siliconflow_configured": bool(settings.SILICONFLOW_API_KEY),
            "dashscope_configured": bool(settings.DASHSCOPE_API_KEY),
            "elevenlabs_configured": bool(settings.ELEVENLABS_API_KEY),
            "jianyin_path_valid": bool(settings.JIANYIN_DRAFT_PATH and os.path.exists(settings.JIANYIN_DRAFT_PATH)),
        },
    }

@router.put("/config")
async def save_config(req: ConfigUpdateRequest):
    """保存配置到 .env 及 storage/config_store.json 并热重载。"""
    raw_existing = read_env_file(unmask=True)
    updates: Dict[str, str] = {}
    incoming = req.model_dump(exclude_unset=False)

    for k in MANAGED_KEYS:
        new_val = incoming.get(k)
        if new_val is None:
            continue
        new_val_str = str(new_val).strip()
        # 若传入脱敏占位符则保留已有真实密钥
        if (k.endswith("_API_KEY") or k == "MINIMAX_API_KEY") and _is_masked_placeholder(new_val_str):
            updates[k] = raw_existing.get(k, "")
        else:
            updates[k] = new_val_str

    if "COMFYUI_TIMEOUT_SECONDS" in updates and updates["COMFYUI_TIMEOUT_SECONDS"]:
        try:
            int(updates["COMFYUI_TIMEOUT_SECONDS"])
        except ValueError:
            raise HTTPException(status_code=400, detail="COMFYUI_TIMEOUT_SECONDS 必须为整数")

    write_env_file(updates)
    return {
        "status": "saved",
        "message": "配置已成功持久化至 .env 和 storage/config_store.json",
        "config": read_env_file(unmask=True),
        "env_file": str(get_primary_env_file()),
    }

@router.post("/config/test")
async def test_config_connection(req: ConfigTestRequest):
    """对指定目标做连通性测试。可传入临时 config 覆盖当前配置进行测试。"""
    target = req.target.lower()
    cfg = req.config or {}

    if target == "comfyui":
        url = (cfg.get("COMFYUI_SERVER_URL") or settings.COMFYUI_SERVER_URL).rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(f"{url}/system_stats")
                r.raise_for_status()
                data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                version = data.get("system", {}).get("comfyui_version") if isinstance(data, dict) else "online"
                return {"target": "comfyui", "ok": True, "url": url, "detail": f"ComfyUI 在线（{url}）", "data": {"version": version}}
        except Exception as e:
            return {"target": "comfyui", "ok": False, "url": url, "detail": f"无法连接 ComfyUI：{e}"}

    if target == "minimax":
        api_key = cfg.get("MINIMAX_API_KEY") or settings.MINIMAX_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.MINIMAX_API_KEY
        base_url = (cfg.get("MINIMAX_BASE_URL") or settings.MINIMAX_BASE_URL).rstrip("/")
        if not api_key:
            return {"target": "minimax", "ok": False, "detail": "MINIMAX_API_KEY 未配置"}
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.post(
                    f"{base_url}/text/chatcompletion_v2",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": cfg.get("LLM_MODEL") or settings.LLM_MODEL,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                )
                if r.status_code == 401:
                    return {"target": "minimax", "ok": False, "detail": "MiniMax 鉴权失败（401）：请检查 API Key"}
                r.raise_for_status()
                return {"target": "minimax", "ok": True, "detail": "MiniMax API 连通正常"}
        except httpx.HTTPStatusError as e:
            return {"target": "minimax", "ok": False, "detail": f"MiniMax 返回 {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"target": "minimax", "ok": False, "detail": f"MiniMax 连接失败：{e}"}

    if target in ["openai", "deepseek", "qwen", "openai_compatible"]:
        api_key = cfg.get("OPENAI_API_KEY") or settings.OPENAI_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.OPENAI_API_KEY
        base_url = (cfg.get("OPENAI_BASE_URL") or settings.OPENAI_BASE_URL).rstrip("/")
        model = cfg.get("OPENAI_MODEL") or settings.OPENAI_MODEL or "deepseek-chat"
        if not api_key:
            return {"target": "openai", "ok": False, "detail": "OPENAI_API_KEY 未配置"}
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                )
                if r.status_code == 401:
                    return {"target": "openai", "ok": False, "detail": "鉴权失败（401）：请检查 API Key"}
                r.raise_for_status()
                return {"target": "openai", "ok": True, "detail": f"模型接口连通正常（{model}）"}
        except httpx.HTTPStatusError as e:
            return {"target": "openai", "ok": False, "detail": f"接口返回 {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"target": "openai", "ok": False, "detail": f"连接失败：{e}"}

    if target == "responses_api":
        api_key = cfg.get("RESPONSES_API_KEY") or cfg.get("OPENAI_API_KEY") or settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.RESPONSES_API_KEY or settings.OPENAI_API_KEY
        url = (cfg.get("RESPONSES_API_URL") or settings.RESPONSES_API_URL).rstrip("/")
        if not url.endswith("/responses"):
            url = f"{url}/responses"
        model = cfg.get("RESPONSES_MODEL") or cfg.get("OPENAI_MODEL") or settings.RESPONSES_MODEL or "gpt-4o"
        if not api_key:
            return {"target": "responses_api", "ok": False, "detail": "RESPONSES_API_KEY / OPENAI_API_KEY 未配置"}
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": model,
                        "input": "hi",
                    },
                )
                if r.status_code == 401:
                    return {"target": "responses_api", "ok": False, "detail": "Responses API 鉴权失败（401）：请检查 API Key"}
                r.raise_for_status()
                return {"target": "responses_api", "ok": True, "detail": f"Responses API 连通正常（{model}）"}
        except httpx.HTTPStatusError as e:
            return {"target": "responses_api", "ok": False, "detail": f"Responses API 返回 {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"target": "responses_api", "ok": False, "detail": f"Responses API 连接失败：{e}"}

    if target == "siliconflow":
        api_key = cfg.get("SILICONFLOW_API_KEY") or settings.SILICONFLOW_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.SILICONFLOW_API_KEY
        if not api_key:
            return {"target": "siliconflow", "ok": False, "detail": "SILICONFLOW_API_KEY 未配置"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    "https://api.siliconflow.cn/v1/user/info",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if r.status_code == 401:
                    return {"target": "siliconflow", "ok": False, "detail": "硅基流动鉴权失败（401）：请检查 API Key"}
                r.raise_for_status()
                return {"target": "siliconflow", "ok": True, "detail": "硅基流动 (SiliconFlow) API 连通正常"}
        except Exception as e:
            return {"target": "siliconflow", "ok": False, "detail": f"硅基流动连接失败：{e}"}

    if target == "dashscope":
        api_key = cfg.get("DASHSCOPE_API_KEY") or settings.DASHSCOPE_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.DASHSCOPE_API_KEY
        if not api_key:
            return {"target": "dashscope", "ok": False, "detail": "DASHSCOPE_API_KEY 未配置"}
        return {"target": "dashscope", "ok": True, "detail": "DashScope API Key 已配置（需实际生图验证）"}

    if target in ["elevenlabs", "eleven_labs"]:
        api_key = cfg.get("ELEVENLABS_API_KEY") or settings.ELEVENLABS_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.ELEVENLABS_API_KEY
        if not api_key:
            return {"target": "elevenlabs", "ok": False, "detail": "ELEVENLABS_API_KEY 未配置"}
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": api_key})
                if r.status_code == 401:
                    return {"target": "elevenlabs", "ok": False, "detail": "ElevenLabs 鉴权失败（401）"}
                r.raise_for_status()
                return {"target": "elevenlabs", "ok": True, "detail": "ElevenLabs API 连通正常"}
        except Exception as e:
            return {"target": "elevenlabs", "ok": False, "detail": f"ElevenLabs 连接失败: {e}"}

    if target in ["cosyvoice", "cosy_voice"]:
        url = (cfg.get("COSYVOICE_URL") or settings.COSYVOICE_URL).rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                return {"target": "cosyvoice", "ok": r.status_code < 500, "url": url, "detail": f"CosyVoice 响应 HTTP {r.status_code}"}
        except Exception as e:
            return {"target": "cosyvoice", "ok": False, "url": url, "detail": f"无法连接 CosyVoice: {e}"}

    if target in ["gptsovits", "gpt_sovits"]:
        url = (cfg.get("GPTSOVITS_URL") or settings.GPTSOVITS_URL).rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                return {"target": "gpt_sovits", "ok": r.status_code < 500, "url": url, "detail": f"GPT-SoVITS 响应 HTTP {r.status_code}"}
        except Exception as e:
            return {"target": "gpt_sovits", "ok": False, "url": url, "detail": f"无法连接 GPT-SoVITS: {e}"}

    if target == "jianyin":
        jy_path = cfg.get("JIANYIN_DRAFT_PATH") or settings.JIANYIN_DRAFT_PATH
        if not jy_path:
            return {"target": "jianyin", "ok": False, "detail": "未配置剪映草稿目录"}
        if os.path.exists(jy_path):
            return {"target": "jianyin", "ok": True, "detail": f"剪映草稿目录有效：{jy_path}"}
        return {"target": "jianyin", "ok": False, "detail": f"路径不存在或不可读：{jy_path}"}

    raise HTTPException(status_code=400, detail="target 不支持，支持: openai | responses_api | deepseek | qwen | minimax | comfyui | siliconflow | dashscope | elevenlabs | cosyvoice | gpt_sovits | jianyin")

@router.post("/agent/chat")
async def http_agent_chat(req: AgentChatRequest):
    """导演 Agent HTTP 问答 — LangChain 多轮循环 + 记忆（兼容旧接口）"""
    prompt_text = (req.prompt or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="指令不能为空")

    session_id = req.session_id or (req.context.get("project_id") if isinstance(req.context, dict) and req.context.get("project_id") else "http_default")
    # 若请求要求流式，则走 SSE
    if req.stream:
        # 复用流式端点逻辑，但此处返回错误提示引导使用 /agent/chat/stream
        raise HTTPException(status_code=400, detail="请使用 POST /api/v1/agent/chat/stream 获取 SSE 流式响应（stream=true 已废弃）")

    if HAS_LANGCHAIN_AGENT:
        try:
            result = await run_agent_with_langchain(
                prompt=prompt_text,
                context=req.context or {},
                session_id=session_id,
                websocket=None,
                max_iterations=6,
                streaming=False,
            )
            return {
                "reply": result.get("reply", "指令已执行。"),
                "suggested_actions": result.get("suggested_actions") or [],
                "executed_tools": result.get("executed_tools") or [],
            }
        except LLMServiceError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Agent 执行失败: {e}")

    # 回退：原单轮逻辑
    try:
        decision = await llm_service.chat_json(
            system_prompt=AGENT_SYSTEM_PROMPT,
            user_prompt=json.dumps({
                "instruction": prompt_text,
                "context": req.context or {},
            }, ensure_ascii=False),
            temperature=0.2,
        )
    except LLMServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent 决策失败: {e}")

    executed_tools = []
    for call in (decision.get("tool_calls") or [])[:3]:
        tool_name = call.get("tool", "")
        arguments = call.get("arguments") or {}
        result = await mcp_registry.execute_tool(tool_name, arguments)
        executed_tools.append({
            "tool_name": tool_name,
            "arguments": arguments,
            "status": result.status,
            "result": result.result if result.status == "success" else None,
            "error": result.error if result.status != "success" else None,
        })

    return {
        "reply": decision.get("reply", "指令已执行。"),
        "suggested_actions": decision.get("suggested_actions") or [],
        "executed_tools": executed_tools,
    }


@router.post("/agent/chat/stream")
async def http_agent_chat_stream(req: AgentChatRequest):
    """导演 Agent 流式问答 (SSE)：实时推送 agent_stream_chunk / tool_calling / tool_result"""
    prompt_text = (req.prompt or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="指令不能为空")
    session_id = req.session_id or (req.context.get("project_id") if isinstance(req.context, dict) and req.context.get("project_id") else "http_stream")

    async def event_generator():
        # 辅助发送函数
        async def send_event(event: str, data: Dict[str, Any]):
            # SSE 格式：data: json\n\n
            payload = json.dumps({"event": event, **data}, ensure_ascii=False)
            yield f"data: {payload}\n\n"

        # 若无 LangChain，回退为模拟流式
        if not HAS_LANGCHAIN_AGENT:
            try:
                decision = await llm_service.chat_json(
                    system_prompt=AGENT_SYSTEM_PROMPT,
                    user_prompt=json.dumps({"instruction": prompt_text, "context": req.context or {}}, ensure_ascii=False),
                    temperature=0.2,
                )
                for call in (decision.get("tool_calls") or [])[:3]:
                    tool_name = call.get("tool", "")
                    args = call.get("arguments") or {}
                    yield f"data: {json.dumps({'event':'tool_calling','tool_name':tool_name,'arguments':args}, ensure_ascii=False)}\n\n"
                    result = await mcp_registry.execute_tool(tool_name, args)
                    yield f"data: {json.dumps({'event':'tool_result','tool_name':tool_name,'status':result.status,'result':result.result if result.status=='success' else None,'error':result.error}, ensure_ascii=False)}\n\n"
                reply = decision.get("reply", "指令已执行。")
                yield f"data: {json.dumps({'event':'agent_stream_start'}, ensure_ascii=False)}\n\n"
                chunk_size = 6
                for i in range(0, len(reply), chunk_size):
                    yield f"data: {json.dumps({'event':'agent_stream_chunk','delta':reply[i:i+chunk_size]}, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0.02)
                yield f"data: {json.dumps({'event':'agent_response','message':reply,'suggested_actions':decision.get('suggested_actions') or []}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'event':'error','message':str(e)}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            return

        # LangChain 流式：通过队列桥接 websocket 风格回调到 SSE
        queue: asyncio.Queue = asyncio.Queue()

        class SSEBridge:
            async def send_json(self, data: Dict[str, Any]):
                await queue.put(data)

        bridge = SSEBridge()
        # 启动后台任务执行 agent
        task = asyncio.create_task(run_agent_with_langchain(
            prompt=prompt_text,
            context=req.context or {},
            session_id=session_id,
            websocket=bridge,  # 复用 websocket 接口（send_json）
            max_iterations=6,
            streaming=True,
        ))

        # 消费者：从队列取事件并转为 SSE
        try:
            while True:
                try:
                    # 等待队列或任务完成
                    done, pending = await asyncio.wait(
                        [asyncio.create_task(queue.get()), task],
                        return_when=asyncio.FIRST_COMPLETED,
                        timeout=0.5,
                    )
                    # 检查任务是否完成
                    if task.done():
                        # 任务结束，排空队列
                        while not queue.empty():
                            ev = await queue.get()
                            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        # 任务结果已通过队列发送了 agent_response，若未发送则补一个
                        try:
                            result = task.result()
                            # 若队列中未有 agent_response，前面 run_agent 已通过 bridge 发送了
                        except Exception as e:
                            yield f"data: {json.dumps({'event':'error','message':str(e)}, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        break
                    # 有新事件
                    for d in done:
                        if d is task:
                            continue
                        try:
                            ev = d.result()
                            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        except Exception:
                            pass
                except asyncio.TimeoutError:
                    if task.done():
                        break
                    continue
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/agent/history")
async def get_agent_history(session_id: str = "http_default"):
    """获取指定会话的 LangChain 记忆历史"""
    if not HAS_LANGCHAIN_AGENT:
        return {"session_id": session_id, "history": [], "has_langchain": False}
    history = get_history(session_id)
    # 序列化为简洁格式
    serialized = []
    for m in history:
        try:
            serialized.append({"type": m.__class__.__name__, "content": getattr(m, "content", str(m))[:2000], "tool_calls": getattr(m, "tool_calls", None)})
        except Exception:
            serialized.append({"type": "unknown", "content": str(m)[:500]})
    return {"session_id": session_id, "history": serialized, "count": len(serialized), "has_langchain": True}


@router.post("/agent/clear")
async def clear_agent_history(body: Dict[str, Any] = {}):
    """清空指定会话的记忆"""
    session_id = body.get("session_id") or "http_default"
    if HAS_LANGCHAIN_AGENT:
        await clear_session(session_id)
        return {"status": "cleared", "session_id": session_id}
    return {"status": "ok", "session_id": session_id, "has_langchain": False}

# ============================================================
# 系统原生文件夹选择器与资源管理器集成
# ============================================================

class BrowseFolderRequest(BaseModel):
    initial_dir: Optional[str] = None
    title: Optional[str] = "请选择文件夹"

class OpenFolderRequest(BaseModel):
    folder_path: str

def _sync_pick_folder(initial_dir: Optional[str] = None, title: str = "请选择文件夹") -> str:
    """在工作线程中调用系统原生文件夹选择对话框"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        root.update()
        selected = filedialog.askdirectory(parent=root, initialdir=initial_dir or None, title=title)
        root.destroy()
        if selected:
            return selected.replace("\\", "/")
    except Exception as e:
        print(f"[System] Tkinter folder dialog fallback: {e}")

    try:
        import subprocess
        ps_cmd = (
            f"[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null; "
            f"$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
            f"$f.Description = '{title}'; "
            f"if($f.ShowDialog() -eq 'OK'){{ $f.SelectedPath }}"
        )
        res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], capture_output=True, text=True, timeout=120)
        return res.stdout.strip().replace("\\", "/")
    except Exception as e:
        print(f"[System] PowerShell folder dialog failed: {e}")
        return ""

@router.post("/system/browse-folder")
async def browse_folder(req: BrowseFolderRequest):
    """弹出系统原生文件夹选择对话框，返回选中的绝对目录路径"""
    selected = await run_in_threadpool(_sync_pick_folder, req.initial_dir, req.title or "请选择文件夹")
    return {
        "selected_path": selected,
        "cancelled": not bool(selected),
    }

@router.post("/system/open-folder")
async def open_system_folder(req: OpenFolderRequest):
    """在操作系统文件资源管理器中打开指定目录"""
    import sys
    path = req.folder_path.strip()
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"文件夹路径不存在: {path}")
    try:
        if sys.platform == "win32":
            os.startfile(os.path.abspath(path))
        else:
            import subprocess
            subprocess.run(["xdg-open", os.path.abspath(path)])
        return {"status": "ok", "opened": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"打开文件夹失败: {e}")
