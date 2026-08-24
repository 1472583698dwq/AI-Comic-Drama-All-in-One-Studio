import os
import json
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

**策略指引：**
- 用户说“生成图片/换图/重绘” → 优先 generate_image，可先 list_assets 查找可复用的 scene/prop 风格锚点
- 用户说“配音/换声线/生成语音” → 优先 generate_voice，根据角色/情绪选 provider 和 voice_id
- 用户说“找素材/素材库/场景/道具” → 优先 list_assets / get_asset
- 如需确认可用 provider/工作流/音色/素材，先调用对应的 list_* 查询工具再决策
- 可组合调用：例如“生成战斗画面并配怒吼”可同时调用 generate_image + generate_voice

请严格输出 JSON（无 markdown 杂质）：
{
  "reply": "给用户的简短中文回复",
  "tool_calls": [{"tool": "工具名", "arguments": {...}}],
  "suggested_actions": ["建议用户下一步的中文操作"]
}
不需要调用工具时 tool_calls 为空数组。最多调用 2 个工具。"""

@router.websocket("/ws/agent")
async def websocket_agent_endpoint(websocket: WebSocket):
    """导演 Agent WebSocket：接收自然语言指令，LLM 决策并真实调用 MCP 工具"""
    await websocket.accept()
    try:
        while True:
            data_str = await websocket.receive_text()
            data = json.loads(data_str)

            if data.get("action") != "agent_prompt":
                await websocket.send_json({"event": "error", "message": f"未知 action: {data.get('action')}"})
                continue

            prompt_text = (data.get("prompt") or "").strip()
            context = data.get("context") or {}
            if not prompt_text:
                await websocket.send_json({"event": "error", "message": "指令不能为空"})
                continue

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

            # 真实执行 LLM 决策的工具链（扩大到 3 个以支持组合生成）
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
    """导演 Agent HTTP 同步问答与决策接口（支持全部生成工具）"""
    prompt_text = (req.prompt or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="指令不能为空")

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
