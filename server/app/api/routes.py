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
from app.pipelines.jianyin_exporter import jianyin_exporter, DraftExportError, engine_status as jianyin_engine_status
from app.pipelines.consistency_engine import consistency_engine
from app.pipelines.unified_orchestrator import unified_orchestrator
from app.mcp.server import mcp_registry
from app.skills.engine import skill_engine, SkillDefinition, SkillExecutionResult
from app.core.config import settings, read_env_file, write_env_file, MANAGED_KEYS, get_primary_env_file, JSON_CONFIG_FILE
from pydantic import BaseModel, Field
import httpx

# ── Agent 内核选择：v2 = runtime/ 单一状态机（默认），v1 = 旧 langchain_engine ──
AGENT_ENGINE = (os.getenv("AGENT_ENGINE") or "v2").strip().lower()
HAS_AGENT_RUNTIME = False
try:
    from app.agent.runtime.manager import agent_manager
    from app.agent.runtime import events as agent_events
    HAS_AGENT_RUNTIME = True
except Exception as _agent_rt_err:
    print(f"[Agent] runtime v2 加载失败（将按 AGENT_ENGINE 回退 v1）: {_agent_rt_err}")

try:
    from app.pipelines.agent.langchain_engine import run_agent_with_langchain, clear_session, get_history, SESSION_MEMORY
    HAS_LANGCHAIN_AGENT = True
except Exception as _lc_err:
    print(f"[Agent] langchain_engine 加载失败: {_lc_err}")
    HAS_LANGCHAIN_AGENT = False

AGENT_V2 = AGENT_ENGINE == "v2" and HAS_AGENT_RUNTIME

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
async def list_skills(all: bool = False):
    """获取已加载的技能 (Skills)。默认只给可执行的：润色按钮/技能工作室拿到的列表就该能跑。

    all=true 才返回被关闭或在扩展中心停用的技能（界面要能看见它们才知道怎么恢复）。
    """
    return skill_engine.list_skills() if all else skill_engine.active_skills()

@router.post("/skills/execute", response_model=SkillExecutionResult)
async def execute_skill(req: SkillExecuteRequest):
    """执行指定 Skill 并自动触发其声明的 MCP 工具链与系统能力"""
    from app.extensions import guard
    _pid = (req.context or {}).get("project_id")
    _tok = guard.set_project_context(_pid) if _pid else None
    try:
        return await skill_engine.execute_skill(req.skill_name, req.context, req.user_prompt)
    finally:
        if _tok is not None:
            guard.reset_project_context(_tok)

@router.get("/skills/{skill_name}/raw")
async def get_skill_raw(skill_name: str):
    """读取技能的原始 SKILL.md 全文，供编辑器无损往返（改完用 /skills/import 覆盖保存）。"""
    sk = skill_engine.get_skill(skill_name)
    if not sk or not getattr(sk, "file_path", ""):
        raise HTTPException(status_code=404, detail=f"未找到技能: {skill_name}")
    fp = sk.file_path
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail=f"技能文件不存在: {fp}")
    try:
        with open(fp, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取失败: {e}")
    return {"name": skill_name, "file_path": fp, "content": content}


@router.post("/skills/import")
async def import_skill(
    file: UploadFile = File(None),
    content: str = Form(None),
    name_overwrite: str = Form(None),
):
    """导入 Skill：支持上传 SKILL.md / .zip 或直接粘贴内容"""
    import os, re, zipfile, io, yaml
    from app.skills.engine import SKILLS_ROOT_DIR

    raw_content = None
    filename = ""

    if file and file.filename:
        filename = file.filename.lower()
        data = await file.read()
        if not data or len(data) == 0:
            raise HTTPException(status_code=400, detail="上传文件为空")
        if filename.endswith(".zip"):
            # 解压 zip，寻找 SKILL.md
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    # 寻找 SKILL.md
                    skill_md_name = None
                    for n in zf.namelist():
                        if n.endswith("SKILL.md") or n.endswith(".skill.md"):
                            skill_md_name = n
                            break
                    if not skill_md_name:
                        raise ValueError("zip 包内未找到 SKILL.md")
                    raw_content = zf.read(skill_md_name).decode("utf-8")
                    filename = skill_md_name
            except zipfile.BadZipFile as e:
                raise HTTPException(status_code=400, detail=f"zip 解析失败: {e}")
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))
        elif filename.endswith(".md"):
            try:
                raw_content = data.decode("utf-8")
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"文件解码失败: {e}")
        else:
            raise HTTPException(status_code=400, detail="仅支持 .md 或 .zip 文件")
    elif content and content.strip():
        raw_content = content.strip()
        filename = "pasted_skill.md"
    else:
        raise HTTPException(status_code=400, detail="请上传 SKILL.md/.zip 文件或粘贴 SKILL.md 内容")

    # 校验 frontmatter
    if not raw_content or not raw_content.strip().startswith("---"):
        raise HTTPException(status_code=400, detail="SKILL.md 需以 YAML frontmatter (---) 开头")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", raw_content, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="SKILL.md frontmatter 解析失败，需为 --- 包裹的 YAML")
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"YAML 解析失败: {e}")
    skill_name = (name_overwrite or meta.get("name") or "").strip()
    if not skill_name:
        # 尝试从文件名推断
        skill_name = os.path.splitext(os.path.basename(filename))[0] if filename else "imported-skill"
        skill_name = re.sub(r"[^a-zA-Z0-9_-]", "-", skill_name).strip("-") or "imported-skill"
    # 规范化
    skill_name = re.sub(r"[^a-zA-Z0-9_-]", "-", skill_name)
    if not skill_name:
        raise HTTPException(status_code=400, detail="技能名称无效")

    # 保存到 skills/{name}/SKILL.md
    dest_dir = os.path.join(SKILLS_ROOT_DIR, skill_name)
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, "SKILL.md")
    # 若已存在，先备份到版本库再覆盖（版本 diff 可回溯）
    overwritten = os.path.exists(dest_path)
    if overwritten:
        try:
            from app.agent.creator import backup_skill_version
            with open(dest_path, "r", encoding="utf-8") as _f:
                backup_skill_version(skill_name, _f.read(), "import-overwrite")
        except Exception as e:
            print(f"[Skills] 导入前备份失败: {e}")
    with open(dest_path, "w", encoding="utf-8") as f:
        f.write(raw_content)

    # 重载
    try:
        skill_engine.reload_skills()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重载失败: {e}")

    imported = skill_engine.get_skill(skill_name)
    if not imported:
        raise HTTPException(status_code=500, detail="导入后未找到技能，请检查 SKILL.md 格式")

    return {"status": "imported", "overwritten": overwritten, "skill": imported.model_dump(), "total": len(skill_engine.list_skills())}

@router.delete("/skills/{skill_name}")
async def delete_skill(skill_name: str):
    """删除指定 Skill（仅删除文件系统）"""
    import os, shutil
    from app.skills.engine import SKILLS_ROOT_DIR
    skill = skill_engine.get_skill(skill_name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_name}")
    # 防止误删内置关键技能？允许删除所有，由用户负责
    dest_dir = os.path.join(SKILLS_ROOT_DIR, skill_name)
    if os.path.exists(dest_dir):
        try:
            shutil.rmtree(dest_dir)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"删除失败: {e}")
    else:
        # 可能是单文件
        fp = skill.file_path
        if fp and os.path.exists(fp):
            try:
                os.remove(fp)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"删除失败: {e}")
    skill_engine.reload_skills()
    return {"status": "deleted", "skill_name": skill_name}

@router.post("/skills/reload")
async def reload_skills():
    """重载所有 Skills"""
    skill_engine.reload_skills()
    return {"status": "reloaded", "total": len(skill_engine.list_skills()), "skills": [s.model_dump() for s in skill_engine.list_skills()]}

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
async def list_tts_providers(production_only: bool = False):
    """列出所有音频Providers及健康状态"""
    reg = get_audio_registry()
    providers = reg.list_providers()
    health = await reg.check_health_all()
    from app.providers import verification
    for p in providers:
        p["health"] = health.get(p["id"], {})
        p["verified"] = verification.is_verified(p["id"])
        # 生产可用口径：已配置即上架（代码源=有代码；内置=已填 Key），不再强制测试
        p["production_ready"] = bool(p.get("is_configured", True))
    if production_only:
        providers = [p for p in providers if p.get("production_ready")]
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
async def list_image_providers(production_only: bool = False):
    """列出所有图片Providers及健康状态"""
    reg = get_image_registry()
    providers = reg.list_providers()
    health = await reg.check_health_all()
    from app.providers import verification
    for p in providers:
        p["health"] = health.get(p["id"], {})
        p["verified"] = verification.is_verified(p["id"])
        # 生产可用口径：已配置即上架（代码源=有代码；内置=已填 Key），不再强制测试
        p["production_ready"] = bool(p.get("is_configured", True))
    if production_only:
        providers = [p for p in providers if p.get("production_ready")]
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
    """[动态生图] 通过指定Provider生成漫剧分镜图像，返回落盘后的本地图片 URL。支持 provider/workflow_id/model/独立控件(steps/cfg/resolution/aspect_ratio/fps)"""
    try:
        from app.providers.image.base import ImageGenerateRequest as ImgReq
        reg = get_image_registry()
        # 收集独立控件透传的额外字段（非标准字段经 extra='allow' 进入 model_extra）
        extra = {}
        try:
            if hasattr(req, 'model_extra') and req.model_extra:
                extra = dict(req.model_extra)
            elif hasattr(req, '__pydantic_extra__') and req.__pydantic_extra__:
                extra = dict(req.__pydantic_extra__)
        except Exception:
            extra = {}
        img_req = ImgReq(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or "",
            aspect_ratio=req.aspect_ratio,
            resolution=getattr(req, 'resolution', None) or extra.get('resolution'),
            style_preset=req.style_preset,
            seed=req.seed,
            workflow_id=req.workflow_id,
            model=req.model,
            width=req.width,
            height=req.height,
            steps=req.steps if req.steps is not None else extra.get('steps'),
            cfg=req.cfg if req.cfg is not None else extra.get('cfg'),
            fps=getattr(req, 'fps', None) or extra.get('fps'),
            duration=getattr(req, 'duration', None) or extra.get('duration'),
            reference_images=getattr(req, 'reference_images', None),
            dynamic_inputs=req.dynamic_inputs,
            extra=extra or None,
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
    import asyncio
    try:
        workflows = await asyncio.to_thread(mgr.list_workflows, source)
    except Exception:
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

@router.post("/images/workflows/{workflow_id}/refresh-app-contract")
async def refresh_workflow_app_contract(workflow_id: str):
    """
    重新读取该工作流的 ComfyUI 官方 App Mode 契约（extra.linearData）。
    用户在 ComfyUI App Builder 里勾选输入/输出并保存后调用，生成源的表单随即按契约重建。
    """
    mgr = get_workflow_manager()
    try:
        return {"status": "success", "data": mgr.refresh_app_contract(workflow_id)}
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
async def list_video_providers(production_only: bool = False):
    """获取所有已注册的视频 Provider 列表及其特性 (I2V/R2V/T2V)"""
    reg = get_video_registry()
    providers = reg.list_providers()
    from app.providers import verification
    for p in providers:
        p["verified"] = verification.is_verified(p.get("id"))
        # 生产可用口径：已配置即上架（代码源=有代码；内置=已填 Key），不再强制测试
        p["production_ready"] = bool(p.get("is_configured", True))
    if production_only:
        providers = [p for p in providers if p.get("production_ready")]
    return providers

@router.get("/videos/health")
async def check_videos_health():
    """检查视频生成服务可用性与配置状态"""
    reg = get_video_registry()
    return await reg.check_health_all()

@router.get("/videos/status/{task_id}")
async def get_video_task_status(task_id: str):
    """查询异步视频生成任务状态（TaskCenter 统一口径 + 旧表兼容）"""
    # TaskCenter 统一口径优先（提交即返的源都会登记在此）
    try:
        from app.providers.tasks import task_center
        rec = task_center.status(task_id)
        if rec is not None:
            return rec.to_dict()
    except Exception:
        pass
    # 代码视频源任务表兜底（非代码模式已删除，仅代码源会登记任务）
    try:
        from app.providers.generic.code_provider import get_code_video_task
        custom = get_code_video_task(task_id)
        if custom is not None:
            return custom
    except Exception:
        pass
    # 聚合查询全部已注册视频源 (h3/seedance/kling/wan3/comfyui/旧通道)
    try:
        reg = get_video_registry()
        for pid in reg.list_ids():
            prov = reg.get(pid)
            if prov and hasattr(prov, "get_task_status"):
                try:
                    st = prov.get_task_status(task_id)
                    if isinstance(st, dict) and st.get("status") not in (None, "not_found"):
                        return st
                except Exception:
                    continue
            # classmethod 兜底 (按类名)
            try:
                cls = prov.__class__ if prov else None
                if cls and hasattr(cls, "get_task_status"):
                    st = cls.get_task_status(task_id)
                    if isinstance(st, dict) and st.get("status") not in (None, "not_found"):
                        return st
            except Exception:
                continue
    except Exception:
        pass
    from app.providers.video.minimax_video import CloudVideoProvider
    return CloudVideoProvider.get_task_status(task_id)

@router.post("/videos/generate")
async def generate_video(req: VideoGenerateRequestPayload):
    """[动态视频生成] 支持图生视频(i2v) / 参考生视频(r2v) / 文生视频(t2v) + 独立控件(fps/steps/cfg/resolution/aspect_ratio 均为下拉)"""
    try:
        from app.providers.video.base import VideoGenerateRequest as VidReq
        reg = get_video_registry()
        extra = {}
        try:
            if hasattr(req, 'model_extra') and req.model_extra:
                extra = dict(req.model_extra)
            elif hasattr(req, '__pydantic_extra__') and req.__pydantic_extra__:
                extra = dict(req.__pydantic_extra__)
        except Exception:
            extra = {}
        # dynamic_inputs 合并 provider 独立参数的透传（若前端未走 dynamic_inputs 而直接平铺）
        dyn = dict(req.dynamic_inputs or {})
        for k in ("fps","steps","cfg","aspect_ratio","resolution"):
            if k in extra and k not in dyn:
                dyn[k] = extra[k]
        # 白模动态预演自动作为视频参考：前端把 previz_video_url 放在 dynamic_inputs，
        # 这里统一提升为 reference_videos（只有声明了视频参考槽的源才会消费）。
        ref_videos = list(req.reference_videos or [])
        if not ref_videos:
            pv = dyn.get("previz_video_url") or dyn.get("previz_videos") or extra.get("previz_video_url")
            if isinstance(pv, str) and pv.strip():
                ref_videos = [pv.strip()]
            elif isinstance(pv, (list, tuple)):
                ref_videos = [str(x).strip() for x in pv if str(x).strip()]
        vid_req = VidReq(
            prompt=req.prompt,
            mode=req.mode or "i2v",
            first_frame_url=req.first_frame_url,
            last_frame_url=req.last_frame_url,
            reference_images=req.reference_images,
            reference_videos=ref_videos or None,
            reference_audios=getattr(req, 'reference_audios', None),
            duration=req.duration or 5,
            resolution=req.resolution or extra.get("resolution") or "720p",
            aspect_ratio=req.aspect_ratio or extra.get("aspect_ratio") or "9:16",
            fps=getattr(req, 'fps', None) or extra.get('fps'),
            seed=req.seed,
            provider=req.provider,
            workflow_id=req.workflow_id,
            dynamic_inputs=dyn or None,
            extra=extra or None,
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

@router.get("/projects/export-jianyin/engine")
async def export_jianyin_engine():
    """导出引擎自检：前端在点击导出之前就能知道 pyJianYingDraft 是否就绪"""
    return jianyin_engine_status()


@router.post("/projects/export-jianyin")
async def export_jianyin_draft(project: Project):
    """一键导出剪映 / CapCut 官方草稿工程文件（含画面轨、配音轨、字幕轨、可选 BGM 轨）"""
    try:
        return await jianyin_exporter.export_project_to_jianyin_draft_async(project)
    except DraftExportError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"剪映草稿导出失败: {type(e).__name__}: {e}")

# ============================================================
# 全链路编排（LLM 拆解 → 生图 → 配音 → 导出）
# ============================================================

@router.post("/pipeline/full-run")
async def pipeline_full_run(req: PipelineRunRequest):
    """全链路真实编排：小说 → 拆解 → 角色资产 → 批量生图 → 图生视频 → TTS → 剪映草稿"""
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
            video_provider=getattr(req, "video_provider", None),
            video_workflow_id=getattr(req, "video_workflow_id", None),
            enable_video=getattr(req, "enable_video", True),
            max_videos=getattr(req, "max_videos", 6),
            gen_roles=getattr(req, "gen_roles", True),
            max_roles=getattr(req, "max_roles", 4),
        )
    except LLMServiceError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"全链路执行失败: {e}")

# ============================================================
# 导演 Agent 实时通道（真 LLM 决策，暴露全部生成能力）
# ============================================================

AGENT_SYSTEM_PROMPT_BODY = """你是「AI漫剧导演 Agent」，运行在 MiniMax AI漫剧 Studio 中。
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

**生成源扩展 v2（解耦独立节点 + x-* 分组与人机分工，与画布/分镜完全同源）：**
15. register_custom_provider —— [核心] 用户提供 API 文档/cURL/OpenAPI 时自动注册新生成源（v2 标准）。参数：kind(image/video/audio/llm), name, doc_text, doc_url, curl, openapi_url, api_key, language(python/javascript), trusted(可信开关，需全局总闸), input_schema(文件插槽,含prompt首帧参考图), params_schema(非文件参数,*必须带 x-category/x-visibility/x-agent/x-priority*), code(可选完整 async def generate(ctx,api))。非代码（JSON/transport）模式已删除，必须产出代码，否则直接报错。v2 示例：{"kind":"image","name":"我的FLUX","doc_text":"POST https://api.xxx.com/v1/images/generations ...","language":"python","input_schema":{"prompt":{"type":"string","x-handle":"text"},"reference_images":{"type":"array","items":{"format":"uri"},"x-handle":"image","maxItems":2}},"params_schema":{"aspect_ratio":{"type":"string","enum":["9:16","16:9"],"default":"9:16","x-category":"layout","x-visibility":"basic","x-agent":"auto","x-priority":10},"steps":{"type":"integer","default":20,"x-category":"quality","x-visibility":"advanced","x-agent":"suggest","x-priority":40}},"api_key":"sk-..."}。必须把文件插槽放 input_schema，可量化参数放 params_schema 并标注 x-*，导演应自动解析并注册，成功后提示可在画布看到新 Provider 节点（基础参数常显，高级需点⚙）。需任意代码（os/subprocess/curl/ffmpeg）时传 trusted:true 并确认全局 STUDIO_TRUSTED_MODE=1。
16. list_custom_providers —— 列出所有自定义 Provider。参数：kind,q。可先查询已有。
17. test_custom_provider —— 测试 Provider 连通性。参数：provider_id
18. delete_custom_provider —— 删除自定义 Provider。参数：provider_id
19. get_provider_code —— 查看源代码与完整 Schema。参数：provider_id/name/q。用于定位未暴露参数后增量修复。
20. update_custom_provider —— 增量补丁已有源。参数：provider_id, params_schema/input_schema 的补丁，修复分组或人机分工错误时用；可传 trusted(true/false) 开关可信模式（需全局 STUDIO_TRUSTED_MODE=1 否则执行明错）。
19. generate_video —— 通用视频生成。参数：prompt, mode(i2v/r2v/t2v), first_frame_url, reference_images, duration, provider

**可信模式双工具（A档，需 STUDIO_TRUSTED_MODE=1，否则明错提示开启方式）：**
25. fs_file —— 文件编辑。参数：action(list/read/write/append/delete), path(围栏 storage/exports/工作区根，禁.git等), content, encoding。示例：{"action":"read","path":"storage/providers/custom/prov_xxx.json"} / {"action":"write","path":"storage/tmp_task.txt","content":"task_id=..."}
26. shell_exec —— 命令执行（Win走PowerShell）。参数：command, cwd(围栏内), timeout(5-1200s，默认1200=20分钟)。示例：{"command":"curl -s https://api.../query?task_id=xxx","timeout":15}
**长任务（视频等）：** 框架已统一处理"提交→轮询→落盘"：provider_* 视频工具默认阻塞到成片并直接返回 video_url（本地 /storage 路径），无需你手动轮询。若工具返回「仍在生成中」或只有 task_id，用 task_wait 继续等待、task_status 查询进度、task_cancel 取消；只有确实需要并行多任务时才用 job_start 后台化。

**无限画布（Canvas DAG，可视化编排）：**
20. canvas_query —— 查询画布摘要与节点清单，感知当前画布状态
21. canvas_create_node —— 创建节点。参数：type(prompt/image/video/audio/director3d/export/custom/brief/script-split/shot-card/comfy-workflow/provider-image/provider-video/provider-audio/tts/load-image/load-image-batch/load-video/load-audio/text-prompt/timeline-export), position{x,y}, params(可选内部参数；type=custom 时 params 必带 custom_node_id，即 customnode_<id> 工具去掉前缀的 id，可直接调该工具执行)
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

**多轮执行策略（循环模式专用-防一步即停）：**
- 把用户目标拆解为步骤清单，逐轮执行：每轮基于上一轮工具结果决定下一个动作
- 只有当所有步骤都完成、或确认无法继续时，才停止调用工具并输出最终总结
- 严禁在目标未完成时提前汇报；每轮自问："用户的目标全部达成了吗？还有哪一步没做？"
- 工具返回 error 时，分析原因并尝试修正参数重试，或改用其它工具达成同一目标
- 单轮可并行调用多个相互独立的工具以提高效率（按需而定，无硬性上限）
- 每轮输出前强制自检：列出"目标步骤清单→已完成→下一步"，清单未清零就必须继续 tool_calls，只有清单全完成才允许纯文本 reply
- 【思考推演规范】在做出任何动作决策或输出答复前，请务必先展开深度、专业的导演推演（分析用户核心意图、当前分镜镜头景别与运镜节拍、为何选择特定工具及参数推导逻辑）。若支持思维链或标签，请优先使用 <think> ... </think> 完整呈现思考链，系统会将其无缝呈现在导演思考卡片中。"""


# 单轮 JSON 兜底模式（llm_service.chat_json，无 LangChain/ainvoke 失败时）使用的提示词：保留 JSON 输出约束
AGENT_SYSTEM_PROMPT = AGENT_SYSTEM_PROMPT_BODY + """

请严格输出 JSON（无 markdown 杂质）：
{
  "reply": "给用户的简短中文回复",
  "tool_calls": [{"tool": "工具名", "arguments": {...}}],
  "suggested_actions": ["建议用户下一步的中文操作"]
}
不需要调用工具时 tool_calls 为空数组。最多调用 2 个工具。"""

# LangChain 多轮循环模式使用的提示词：原生 tool calling，多步持续执行不再被 JSON 约束压制
AGENT_LOOP_SYSTEM_PROMPT = AGENT_SYSTEM_PROMPT_BODY


def _provider_tools_brief() -> str:
    """动态拼接全部 provider_* 生成源工具（v2 携带 x-visibility/x-agent 分组与人机分工）"""
    try:
        from app.mcp.server import mcp_registry
        lines = []
        for t in mcp_registry.get_all_tools():
            if not t.name.startswith("provider_"):
                continue
            try:
                props = (t.input_schema or {}).get("properties", {}) or {}
                # 区分基础/高级便于导演只自动填 basic/auto 项
                basic = []
                adv = []
                for k, v in props.items():
                    if not isinstance(v, dict):
                        continue
                    # 非 uri 文件插槽与 prompt 视为输入，不计入参数分组
                    if v.get("format") == "uri" or v.get("x-handle") in ("image","audio","video"):
                        continue
                    if k in ("prompt","text"):
                        continue
                    vis = v.get("x-visibility", "advanced")
                    if vis == "basic":
                        basic.append(k)
                    elif vis == "hidden":
                        continue
                    else:
                        adv.append(k)
                keys = ",".join(list(props.keys())[:14])
                grp = f"基础:{','.join(basic) or '无'}|高级:{','.join(adv) or '无'}"
            except Exception:
                keys = ""
                grp = ""
            desc = str(t.description or "")[:110].replace("\n"," ")
            lines.append(f"- {t.name} — {desc} | {grp} | 参数: {keys}")
        if not lines:
            return ""
        return (
            "\n\n**动态生成源 Tools v2（当前已注册 " + str(len(lines)) + " 个，一源一Tool，基础常显 高级需点⚙ auto可自动 suggest需确认 manual仅手填）：**\n"
            + "\n".join(lines[:90])
            + "\n\n**编排画布时：** 用 canvas_create_node 创建 prompt/image/video/audio 节点，data 内直接写 provider_id(即Tool名去掉provider_前缀)、prompt/idea、skill_id 与挂载的 first_frame/reference_images/ref_audio；"
            "canvas_connect 按句柄(prompt/image/first_frame/last_frame/reference_images/ref_audio/text)连线后 canvas_execute 一键执行。"
            "生成源参数异构一律按该 provider_* Tool 自己的 schema 填写，含 x-visibility/x-agent：basic/auto 可由你自动按项目画幅推断，advanced/suggest 仅在用户提及时填写，hidden/manual 绝不填。"
            "\n**生成源选择铁律：** 需要首帧/参考图/尾帧/参考音频时，必须选择输入参数里含对应插槽(first_frame/reference_images/last_frame/ref_audio)的源；"
            "输入参数只有 prompt 的纯文本源不接受任何图像/音频，禁止把参考图挂给它（否则外部 API 会报参数错误）。选源前可先调 get_provider_code 查看其 input_schema 确认。"
            "\n**自定义能力调用：** 自定义代码节点注册为 customnode_<id> 工具，可直接调用；画布编排用 canvas_create_node(type=custom, params={custom_node_id:'<id>', ...})。"
            "插件工具名为 plugin_<插件id>_<name>，同样可直接调用。以上全部已绑定，不存在调用盲区。\n"
        )
    except Exception as e:
        print(f"[Agent] provider_tools_brief failed: {e}")
        return ""


def get_agent_system_prompt(loop: bool = False) -> str:
    base = AGENT_LOOP_SYSTEM_PROMPT if loop else AGENT_SYSTEM_PROMPT
    return base + _provider_tools_brief()


class PromptExpandRequest(BaseModel):
    prompt: str
    kind: str = "image"  # image / video / dialogue


@router.post("/llm/expand")
async def expand_prompt(req: PromptExpandRequest):
    """电影级提示词扩写：短描述 → 专业影视分镜提示词（导演 Agent 技能后端）"""
    from app.pipelines.llm_service import llm_service, LLMServiceError
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")
    kind_hint = {
        "image": "生图提示词（主体、构图、景别、光线、材质风格、画质词，英文逗号短语）",
        "video": "视频运动提示词（主体动作、运镜轨迹、节奏、光影变化，中文一句到三句）",
        "dialogue": "角色台词与情绪标注（中文，带情绪标签）",
    }.get(req.kind, "生图提示词")
    try:
        text = await llm_service.chat_completion(
            messages=[
                {"role": "system", "content": f"你是漫剧影视级提示词扩写引擎。把用户的简短画面构思扩写为专业{kind_hint}。只输出提示词本身，不要解释、不要引号、不要 markdown。"},
                {"role": "user", "content": req.prompt.strip()[:2000]},
            ],
            temperature=0.7,
            max_tokens=600,
        )
        return {"status": "success", "expanded": (text or "").strip()[:1200]}
    except LLMServiceError as e:
        raise HTTPException(status_code=502, detail=f"LLM 扩写失败: {e}")



@router.websocket("/ws/agent")
async def websocket_agent_endpoint(websocket: WebSocket):
    """导演 Agent WebSocket：支持并发 abort 暂停"""
    await websocket.accept()
    session_id = f"ws_{id(websocket)}"
    active_task: Optional[asyncio.Task] = None
    _v2_attached: set = set()

    async def _v2_sink(ev: Dict[str, Any]):
        try:
            await websocket.send_json(ev)
        except Exception:
            pass

    async def _v2_attach(sid: str) -> None:
        if sid in _v2_attached:
            return
        await agent_manager.attach(sid, _v2_sink, interactive=True)
        _v2_attached.add(sid)
    try:
        while True:
            data_str = await websocket.receive_text()
            try:
                data = json.loads(data_str)
            except Exception:
                await websocket.send_json({"event": "error", "message": "消息格式错误（需 JSON）"})
                continue

            action = data.get("action")

            # ── 暂停 abort ──
            if action == "abort":
                target_sid = str(data.get("session_id") or session_id)
                if AGENT_V2:
                    stopped = await agent_manager.abort(target_sid)
                    if not stopped:
                        await websocket.send_json({"event": "agent_response", "message": "⏹️ 已暂停", "suggested_actions": [], "executed_tools": []})
                    continue
                if active_task and not active_task.done():
                    active_task.cancel()
                    try:
                        await asyncio.wait_for(active_task, timeout=2)
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        pass
                    # 清理由回调处理，此处再补发暂停回执
                    try:
                        await websocket.send_json({"event": "agent_response", "message": "⏹️ 已暂停", "suggested_actions": ["继续", "换个思路"], "executed_tools": []})
                    except Exception:
                        pass
                else:
                    # 无任务时也回暂停，避免前端一直转圈
                    try:
                        await websocket.send_json({"event": "agent_response", "message": "⏹️ 已暂停", "suggested_actions": [], "executed_tools": []})
                    except Exception:
                        pass
                continue

            # ── P1 HITL审批回执 ──
            if action == "approve_tool":
                _aid = str(data.get("approval_id") or "")
                _ok = bool(data.get("approved", False))
                if AGENT_V2:
                    _sid = str(data.get("session_id") or session_id)
                    _resolved = await agent_manager.resolve_approval(_sid, _aid, _ok)
                    await websocket.send_json({"event": "approval_ack", "approval_id": _aid, "approved": _ok, "resolved": _resolved})
                    continue
                try:
                    from app.pipelines.agent.langchain_engine import resolve_approval
                    _ok2 = resolve_approval(_aid, _ok)
                    await websocket.send_json({"event": "approval_ack", "approval_id": _aid, "approved": _ok, "resolved": _ok2})
                except Exception as e:
                    await websocket.send_json({"event": "error", "message": f"审批回执失败: {e}"})
                continue

            # ── v2 重连挂载：把本 socket 挂到已有会话，补发快照并续播实时事件 ──
            if action == "attach_session":
                if AGENT_V2:
                    _sid = str(data.get("session_id") or session_id)
                    session_id = _sid
                    try:
                        await _v2_attach(_sid)
                        lp = agent_manager.get(_sid)
                        if lp is not None:
                            snap = lp.session.snapshot(tail=int(data.get("tail") or 100))
                        else:
                            from app.agent.runtime.session import Session as _RuntimeSession
                            snap = _RuntimeSession.open(_sid, repair=False).snapshot(tail=int(data.get("tail") or 100))
                        await websocket.send_json({"event": "session_snapshot", **snap})
                    except Exception as e:
                        try:
                            await websocket.send_json({"event": "error", "message": f"attach 失败: {e}"})
                        except Exception:
                            pass
                continue

            if action not in ("agent_prompt", "clear_history", "abort"):
                await websocket.send_json({"event": "error", "message": f"未知 action: {data.get('action')}"})
                continue

            if action == "clear_history":
                # 若有运行中任务先取消
                if active_task and not active_task.done():
                    active_task.cancel()
                    try:
                        await active_task
                    except Exception:
                        pass
                if AGENT_V2:
                    await agent_manager.clear(session_id)
                    await websocket.send_json({"event": "agent_response", "message": "已清空对话历史", "suggested_actions": []})
                    continue
                if HAS_LANGCHAIN_AGENT:
                    await clear_session(session_id)
                await websocket.send_json({"event": "agent_response", "message": "已清空对话历史", "suggested_actions": []})
                continue

            prompt_text = (data.get("prompt") or "").strip()
            context = data.get("context") or {}
            # 运行模式透传到引擎（plan=只读规划模式）
            try:
                from app.agent.mode_policy import normalize_run_mode as _nrm, behavior_of as _beh
                _rm = _nrm(str(data.get("run_mode") or (context.get("run_mode") if isinstance(context, dict) else "") or "approve"))
            except Exception:
                _rm = "approve"
                _beh = lambda m: "plan" if str(m).startswith("plan") else "standard"  # noqa: E731
            if isinstance(context, dict):
                context["run_mode"] = _rm
                context["plan_mode"] = (_beh(_rm) == "plan")
            if data.get("session_id"):
                session_id = str(data.get("session_id"))
            elif context.get("project_id"):
                session_id = f"proj_{context.get('project_id')}"

            if not prompt_text:
                await websocket.send_json({"event": "error", "message": "指令不能为空"})
                continue

            # Agent双模式：chat纯问答 / execute调工具（P0）
            try:
                from app.agent.loop import normalize_mode as _nmode
                _wmode = _nmode(data.get("mode"))
            except Exception:
                _wmode = "execute"

            # ── v2 单一内核：Inbox 排队 + 事件订阅，同一会话并发输入自动 followup/steer ──
            if AGENT_V2:
                try:
                    await _v2_attach(session_id)
                    await agent_manager.prompt(
                        session_id, prompt_text,
                        context=context if isinstance(context, dict) else {},
                        mode=_wmode, run_mode=_rm,
                        interactive=True, sink=None,
                    )
                except Exception as e:
                    try:
                        await websocket.send_json({"event": "error", "message": f"Agent 启动失败: {e}"})
                    except Exception:
                        pass
                continue

            if active_task and not active_task.done():
                await websocket.send_json({"event": "error", "message": "已有任务运行中，请先暂停再发新指令"})
                continue

            if _wmode == "chat":
                try:
                    await websocket.send_json({"event": "agent_thinking", "message": "正在深入思考问答推演…"})
                    reply = await llm_service.chat_completion(
                        messages=[
                            {"role": "system", "content": "你是AI漫剧导演顾问，只做问答讲解，不调用任何工具。请先展现思考推演过程，再用中文回答。"},
                            {"role": "user", "content": prompt_text[:4000]},
                        ],
                        temperature=0.5,
                    )
                    from app.pipelines.llm_service import extract_think_tags, strip_think_tags
                    th = extract_think_tags(reply or "").strip()
                    clean_reply = strip_think_tags(reply or "").strip()
                    if not th:
                        th = f"【导演顾问思考推演】\n- 意图分析：用户询问「{prompt_text[:60]}」\n- 解答路径：梳理漫剧影视创作知识库，输出条理清晰的专业指导建议。"
                    await websocket.send_json({"event": "agent_thinking_start"})
                    for i in range(0, len(th), 8):
                        await websocket.send_json({"event": "agent_thinking_chunk", "delta": th[i:i+8]})
                        await asyncio.sleep(0.005)
                    await websocket.send_json({"event": "agent_thinking_end"})
                    if clean_reply:
                        await websocket.send_json({"event": "agent_stream_start"})
                        for i in range(0, len(clean_reply), 6):
                            await websocket.send_json({"event": "agent_stream_chunk", "delta": clean_reply[i:i+6]})
                            await asyncio.sleep(0.015)
                    await websocket.send_json({
                        "event": "agent_response",
                        "message": clean_reply,
                        "thinking": th,
                        "suggested_actions": ["切换到执行模式让我直接做"],
                        "executed_tools": [],
                        "mode": "chat"
                    })
                except Exception as e:
                    await websocket.send_json({"event": "error", "message": str(e)})
                continue

            # 优先使用 LangChain 引擎（带记忆、循环、流式）— 后台任务化以支持 abort
            if HAS_LANGCHAIN_AGENT:
                # 捕获外层变量供闭包使用
                _prompt = prompt_text
                _context = context
                _sid = session_id

                async def _run_agent_task():
                    try:
                        await websocket.send_json({"event": "agent_thinking", "message": f"正在解析导演指令: 「{_prompt[:40]}」..."})
                        result = await run_agent_with_langchain(
                            prompt=_prompt,
                            context=_context,
                            session_id=_sid,
                            websocket=websocket,
                            streaming=True,
                            mode="execute",
                        )
                        await websocket.send_json({
                            "event": "agent_response",
                            "message": result.get("reply", "指令已执行。"),
                            "thinking": result.get("thinking"),
                            "suggested_actions": result.get("suggested_actions") or [],
                            "executed_tools": result.get("executed_tools") or [],
                            "mode": "execute",
                        })
                    except asyncio.CancelledError:
                        # 任务被 abort 取消，静默结束（外层已发暂停回执）
                        raise
                    except LLMServiceError as e:
                        try:
                            await websocket.send_json({"event": "error", "message": str(e) or "大模型接口异常"})
                        except Exception:
                            pass
                    except Exception as e:
                        err_text = str(e)
                        if not err_text and isinstance(e, asyncio.TimeoutError):
                            err_text = "等待大模型响应超时（90s），请检查网络或模型服务状态"
                        elif not err_text:
                            err_text = type(e).__name__
                        try:
                            await websocket.send_json({"event": "error", "message": f"Agent 执行失败: {err_text}"})
                        except Exception:
                            pass

                active_task = asyncio.create_task(_run_agent_task())

                def _clear_done(t: asyncio.Task):
                    nonlocal active_task
                    if active_task is t:
                        active_task = None
                active_task.add_done_callback(_clear_done)
                # 不在此处 await，立即回到 receive 循环以接收 abort
                continue

            # 回退：原有单轮逻辑（无 LangChain 时）
            await websocket.send_json({"event": "agent_thinking", "message": f"正在解析导演指令: 「{prompt_text[:40]}」..."})

            try:
                decision = await llm_service.chat_json(
                    system_prompt=get_agent_system_prompt(),
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
        if 'active_task' in locals() and active_task and not active_task.done():
            active_task.cancel()
        for _sid in _v2_attached:
            agent_manager.detach(_sid, _v2_sink)
    except asyncio.CancelledError:
        if 'active_task' in locals() and active_task and not active_task.done():
            active_task.cancel()
        for _sid in _v2_attached:
            agent_manager.detach(_sid, _v2_sink)
    except json.JSONDecodeError:
        try:
            await websocket.send_json({"event": "error", "message": "消息格式错误（需 JSON）"})
        except Exception:
            pass

# ============================================================
# 系统配置（读写 .env + 连通性测试）
# ============================================================

class ConfigUpdateRequest(BaseModel):
    model_config = {"extra": "allow"}

    # MiniMax
    MINIMAX_API_KEY: Optional[str] = Field(default="")
    MINIMAX_GROUP_ID: Optional[str] = Field(default="")
    MINIMAX_BASE_URL: Optional[str] = Field(default="https://api.minimaxi.com/v1")
    LLM_MODEL: Optional[str] = Field(default="MiniMax-M2.5")
    TTS_MODEL: Optional[str] = Field(default="speech-2.8-turbo")
    VIDEO_MODEL: Optional[str] = Field(default="MiniMax-Hailuo-02")

    # LLM Provider & OpenAI / Responses API / DeepSeek
    LLM_PROVIDER: Optional[str] = Field(default="openai_compatible")
    LLM_API_TYPE: Optional[str] = Field(default="chat_completions")
    OPENAI_API_KEY: Optional[str] = Field(default="")
    OPENAI_BASE_URL: Optional[str] = Field(default="https://api.deepseek.com/v1")
    OPENAI_MODEL: Optional[str] = Field(default="deepseek-v4-flash")
    OPENAI_CUSTOM_HEADERS: Optional[str] = Field(default="")
    RESPONSES_API_URL: Optional[str] = Field(default="https://api.openai.com/v1/responses")
    RESPONSES_API_KEY: Optional[str] = Field(default="")
    RESPONSES_MODEL: Optional[str] = Field(default="gpt-5.2")

    # Image Generation
    IMAGE_PROVIDER: Optional[str] = Field(default="openai_compat")
    COMFYUI_SERVER_URL: Optional[str] = Field(default="http://127.0.0.1:8188")
    COMFYUI_CHECKPOINT: Optional[str] = Field(default="")
    COMFYUI_TIMEOUT_SECONDS: Optional[str] = Field(default="1200")
    COMFYUI_WORKFLOWS_DIR: Optional[str] = Field(default="")
    COMFYUI_DEFAULT_IMAGE_WORKFLOW: Optional[str] = Field(default="")
    SILICONFLOW_API_KEY: Optional[str] = Field(default="")
    SILICONFLOW_IMAGE_MODEL: Optional[str] = Field(default="black-forest-labs/FLUX.1-schnell")
    DASHSCOPE_API_KEY: Optional[str] = Field(default="")
    DASHSCOPE_IMAGE_MODEL: Optional[str] = Field(default="wan2.6-t2i")
    OPENAI_IMAGE_MODEL: Optional[str] = Field(default="gpt-image-2.5-flare")
    OPENAI_IMAGE_BASE_URL: Optional[str] = Field(default="")
    OPENAI_IMAGE_API_KEY: Optional[str] = Field(default="")

    # Voice & TTS
    TTS_PROVIDER: Optional[str] = Field(default="minimax")
    COSYVOICE_URL: Optional[str] = Field(default="http://127.0.0.1:9233")
    GPTSOVITS_URL: Optional[str] = Field(default="http://127.0.0.1:9880")
    ELEVENLABS_API_KEY: Optional[str] = Field(default="")
    ELEVENLABS_MODEL: Optional[str] = Field(default="eleven_multilingual_v2")

    # Video Generation
    VIDEO_PROVIDER: Optional[str] = Field(default="comfyui_video")
    COMFYUI_DEFAULT_VIDEO_WORKFLOW: Optional[str] = Field(default="")
    KLING_API_KEY: Optional[str] = Field(default="")
    KLING_BASE_URL: Optional[str] = Field(default="https://api-beijing.klingai.com")
    KLING_MODEL: Optional[str] = Field(default="kling-v3")
    VIDU_API_KEY: Optional[str] = Field(default="")
    MINIMAX_H3_MODEL: Optional[str] = Field(default="MiniMax-H3")
    MINIMAX_H3_BASE_URL: Optional[str] = Field(default="https://api.minimaxi.com")
    SEEDANCE_API_KEY: Optional[str] = Field(default="")
    SEEDANCE_BASE_URL: Optional[str] = Field(default="https://ark.cn-beijing.volces.com/api/v3")
    SEEDANCE_MODEL: Optional[str] = Field(default="doubao-seedance-2-0-260128")
    WAN3_MODEL: Optional[str] = Field(default="wan3.0-video")
    WAN3_BASE_URL: Optional[str] = Field(default="https://dashscope.aliyuncs.com")

    # JianYing Draft Custom Location
    JIANYIN_DRAFT_PATH: Optional[str] = Field(default="")

    # Trusted Mode 总闸（A档）
    STUDIO_TRUSTED_MODE: Optional[str] = Field(default="0")

class ConfigTestRequest(BaseModel):
    target: str = Field(description="openai | responses_api | minimax | minimax_h3 | wan3 | seedance | kling | comfyui | siliconflow | dashscope | openai_image | elevenlabs | cosyvoice | gpt_sovits | jianyin")
    config: Dict[str, Any] | None = None

class AgentChatRequest(BaseModel):
    prompt: str
    context: Dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = Field(default=None, description="会话ID，用于多轮记忆隔离")
    stream: bool = Field(default=False, description="是否流式返回")
    mode: str = Field(default="execute", description="Agent模式：chat问答（不调工具）| execute执行（ReAct调工具生成）")
    run_mode: str = Field(default="approve", description="运行模式：approve审批 / auto自动 / create创造")

def _is_masked_placeholder(v: str) -> bool:
    return "****" in v

@router.get("/config")
async def get_config(unmask: bool = True):
    """返回当前生效配置。本地桌面端默认提供明文供用户编辑查看，可通过 unmask=false 脱敏。"""
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
    # 只写客户端显式提交的键：exclude_unset=False 会把模型里的默认值当"用户输入"，
    # 保存任意一项都会把其余配置重置回默认值（旧版 bug）。
    incoming = req.model_dump(exclude_unset=True)

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
                # M 系列（MiniMax-M3/M2.5…）走 OpenAI 兼容的 /chat/completions；
                # 旧版 /text/chatcompletion_v2 仅 abab 时代使用，已随域名一起弃用。
                r = await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": cfg.get("LLM_MODEL") or settings.LLM_MODEL or "MiniMax-M2.5",
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
        model = cfg.get("OPENAI_MODEL") or settings.OPENAI_MODEL or "deepseek-v4-flash"
        if not api_key:
            return {"target": "openai", "ok": False, "detail": "OPENAI_API_KEY 未配置"}
        try:
            req_headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            custom_raw = cfg.get("OPENAI_CUSTOM_HEADERS") or getattr(settings, "OPENAI_CUSTOM_HEADERS", "")
            if custom_raw:
                try:
                    import json
                    parsed_headers = json.loads(custom_raw) if isinstance(custom_raw, str) else custom_raw
                    if isinstance(parsed_headers, dict):
                        for k, v in parsed_headers.items():
                            req_headers[str(k).strip()] = str(v).strip()
                except Exception:
                    pass

            # 兼容 OpenCode 等网关：若缺少 x-opencode-session 则自动补充默认 session 标识避免 400
            if "opencode.ai" in base_url.lower():
                if not any(k.lower() == "x-opencode-session" for k in req_headers):
                    import uuid
                    req_headers["x-opencode-session"] = f"session_{uuid.uuid4().hex[:12]}"

            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.post(
                    f"{base_url}/chat/completions",
                    headers=req_headers,
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
        model = cfg.get("RESPONSES_MODEL") or cfg.get("OPENAI_MODEL") or settings.RESPONSES_MODEL or "gpt-5.2"
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

    if target in ["openai_image", "openai_compat_image"]:
        api_key = (cfg.get("OPENAI_IMAGE_API_KEY") or cfg.get("OPENAI_API_KEY")
                   or getattr(settings, "OPENAI_IMAGE_API_KEY", "") or settings.OPENAI_API_KEY)
        if _is_masked_placeholder(api_key):
            api_key = getattr(settings, "OPENAI_IMAGE_API_KEY", "") or settings.OPENAI_API_KEY
        base = (cfg.get("OPENAI_IMAGE_BASE_URL") or cfg.get("OPENAI_BASE_URL")
                or getattr(settings, "OPENAI_IMAGE_BASE_URL", "") or settings.OPENAI_BASE_URL or "").rstrip("/")
        model = cfg.get("OPENAI_IMAGE_MODEL") or getattr(settings, "OPENAI_IMAGE_MODEL", "") or "gpt-image-2.5-flare"
        if not api_key:
            return {"target": "openai_image", "ok": False, "detail": "OPENAI_IMAGE_API_KEY / OPENAI_API_KEY 未配置"}
        if not base:
            return {"target": "openai_image", "ok": False, "detail": "OPENAI_IMAGE_BASE_URL / OPENAI_BASE_URL 未配置"}
        url = f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
                if r.status_code == 401:
                    return {"target": "openai_image", "ok": False, "detail": "生图网关鉴权失败（401）：请检查 API Key"}
                if r.status_code == 404:
                    return {"target": "openai_image", "ok": True, "detail": f"网关可达（不支持 /models 列表，模型 {model} 将在生成时校验）"}
                r.raise_for_status()
                ids = []
                try:
                    ids = [str(m.get("id")) for m in (r.json().get("data") or []) if isinstance(m, dict)]
                except Exception:
                    ids = []
                if ids and model not in ids:
                    return {"target": "openai_image", "ok": True,
                            "detail": f"网关可达，但模型列表里没有 {model}（示例：{', '.join(ids[:3])}…）"}
                return {"target": "openai_image", "ok": True, "detail": f"生图网关连通正常（{model}）"}
        except httpx.HTTPStatusError as e:
            return {"target": "openai_image", "ok": False, "detail": f"生图网关返回 {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"target": "openai_image", "ok": False, "detail": f"生图网关连接失败：{e}"}

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

    if target in ["minimax_h3", "h3"]:
        api_key = cfg.get("MINIMAX_API_KEY") or settings.MINIMAX_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.MINIMAX_API_KEY
        if not api_key:
            return {"target": "minimax_h3", "ok": False, "detail": "MINIMAX_API_KEY 未配置 (H3 与 MiniMax 同Key, 需按量计费)"}
        return {"target": "minimax_h3", "ok": True, "detail": "MiniMax H3 Key 已配置 (MiniMax-H3, 768P/2K 4-15s, 真实生成时校验)"}

    if target == "seedance":
        api_key = cfg.get("SEEDANCE_API_KEY") or settings.SEEDANCE_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.SEEDANCE_API_KEY
        if not api_key:
            return {"target": "seedance", "ok": False, "detail": "SEEDANCE_API_KEY 未配置 (火山引擎Ark)"}
        return {"target": "seedance", "ok": True, "detail": "Seedance Key 已配置 (真实生成时校验模型/配额)"}

    if target == "kling":
        api_key = cfg.get("KLING_API_KEY") or settings.KLING_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.KLING_API_KEY
        if not api_key:
            return {"target": "kling", "ok": False, "detail": "KLING_API_KEY 未配置"}
        return {"target": "kling", "ok": True, "detail": "可灵 Kling Key 已配置 (真实生成时校验)"}

    if target in ["wan3", "wan"]:
        api_key = cfg.get("DASHSCOPE_API_KEY") or settings.DASHSCOPE_API_KEY
        if _is_masked_placeholder(api_key):
            api_key = settings.DASHSCOPE_API_KEY
        if not api_key:
            return {"target": "wan3", "ok": False, "detail": "DASHSCOPE_API_KEY 未配置 (Wan3.0 复用此Key)"}
        return {"target": "wan3", "ok": True, "detail": "Wan3.0 Key 已配置 (wan3.0-video, 真实生成时校验)"}

    raise HTTPException(status_code=400, detail="target 不支持，支持: openai | responses_api | deepseek | qwen | minimax | minimax_h3 | seedance | kling | wan3 | comfyui | siliconflow | dashscope | elevenlabs | cosyvoice | gpt_sovits | jianyin")

@router.post("/agent/chat")
async def http_agent_chat(req: AgentChatRequest):
    """导演 Agent HTTP 问答 — LangChain 多轮循环 + 记忆（兼容旧接口）

    mode=chat：纯问答，不调任何工具；mode=execute：ReAct调工具生成。
    """
    prompt_text = (req.prompt or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="指令不能为空")

    session_id = req.session_id or (req.context.get("project_id") if isinstance(req.context, dict) and req.context.get("project_id") else "http_default")
    try:
        from app.agent.loop import normalize_mode
        _mode = normalize_mode(getattr(req, "mode", "execute"))
    except Exception:
        _mode = "execute"

    # ── v2 单一内核（无交互通道：审批 fail-closed 自动拒绝）──
    if AGENT_V2:
        try:
            from app.agent.mode_policy import normalize_run_mode as _nrm_v2
            _rm_v2 = _nrm_v2(getattr(req, "run_mode", "approve"))
        except Exception:
            _rm_v2 = "approve"
        events: List[Dict[str, Any]] = []
        done = asyncio.Event()

        async def _sink(ev: Dict[str, Any]):
            events.append(ev)
            if ev.get("event") in ("agent_response", "error"):
                done.set()

        try:
            await agent_manager.prompt(
                session_id, prompt_text, context=dict(req.context or {}),
                mode=_mode, run_mode=_rm_v2, interactive=False, sink=_sink,
            )
            try:
                await asyncio.wait_for(done.wait(), timeout=float(os.environ.get("AGENT_HTTP_TIMEOUT") or 900))
            except asyncio.TimeoutError:
                pass
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Agent 执行失败: {e}")
        finally:
            agent_manager.detach(session_id, _sink)

        reply = next((e.get("message") for e in reversed(events) if e.get("event") == "agent_response"), "") or "指令已执行。"
        executed: List[Dict[str, Any]] = []
        for ev in events:
            if ev.get("event") == "tool_calling":
                executed.append({"tool_name": ev.get("tool_name"), "arguments": ev.get("arguments") or {},
                                 "status": "running", "result": None, "error": None})
            elif ev.get("event") == "tool_result":
                for item in reversed(executed):
                    if item["tool_name"] == ev.get("tool_name") and item["status"] == "running":
                        item["status"] = ev.get("status") or "error"
                        item["result"] = ev.get("result")
                        item["error"] = ev.get("error")
                        break
        return {"reply": reply, "thinking": None, "suggested_actions": [], "executed_tools": executed, "mode": _mode}

    if _mode == "chat":
        try:
            reply = await llm_service.chat_completion(
                messages=[
                    {"role": "system", "content": "你是AI漫剧导演顾问，只做问答讲解，不调用任何工具。请在 <think> ... </think> 标签内展示专业导演的思考推演过程，再用中文回答。"},
                    {"role": "user", "content": prompt_text[:4000]},
                ],
                temperature=0.5,
            )
            from app.pipelines.llm_service import extract_think_tags, strip_think_tags
            th = extract_think_tags(reply or "").strip()
            clean_reply = strip_think_tags(reply or "").strip()
            if not th:
                th = f"【导演顾问思考推演】\n- 意图分析：用户询问「{prompt_text[:60]}」\n- 解答路径：梳理漫剧影视创作知识库，输出条理清晰的专业指导建议。"
            return {"reply": clean_reply, "thinking": th, "suggested_actions": ["切换到执行模式让我直接做", "继续追问细节"], "executed_tools": [], "mode": "chat"}
        except LLMServiceError as e:
            raise HTTPException(status_code=503, detail=str(e))
    # 若请求要求流式，则走 SSE
    if req.stream:
        # 复用流式端点逻辑，但此处返回错误提示引导使用 /agent/chat/stream
        raise HTTPException(status_code=400, detail="请使用 POST /api/v1/agent/chat/stream 获取 SSE 流式响应（stream=true 已废弃）")

    if HAS_LANGCHAIN_AGENT:
        try:
            _ctx = dict(req.context or {})
            try:
                from app.agent.mode_policy import normalize_run_mode as _nrm2, behavior_of as _beh2
                _rm2 = _nrm2(getattr(req, "run_mode", "approve"))
            except Exception:
                _rm2 = "approve"
                _beh2 = lambda m: "plan" if str(m).startswith("plan") else "standard"  # noqa: E731
            _ctx["run_mode"] = _rm2
            _ctx["plan_mode"] = (_beh2(_rm2) == "plan")
            result = await run_agent_with_langchain(
                prompt=prompt_text,
                context=_ctx,
                session_id=session_id,
                websocket=None,
                streaming=False,
            )
            return {
                "reply": result.get("reply", "指令已执行。"),
                "thinking": result.get("thinking"),
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
            system_prompt=get_agent_system_prompt(),
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
    try:
        from app.agent.loop import normalize_mode as _nm
        _smode = _nm(getattr(req, "mode", "execute"))
    except Exception:
        _smode = "execute"
    try:
        from app.agent.mode_policy import normalize_run_mode as _nrm_sse
        _rmode_sse = _nrm_sse(getattr(req, "run_mode", "approve"))
    except Exception:
        _rmode_sse = "approve"

    async def event_generator():
        # ── v2 单一内核：队列桥接 loop 事件（无交互通道，审批 fail-closed）──
        if AGENT_V2:
            queue: asyncio.Queue = asyncio.Queue()

            async def _sink(ev: Dict[str, Any]):
                await queue.put(ev)

            try:
                await agent_manager.prompt(
                    session_id, prompt_text, context=dict(req.context or {}),
                    mode=_smode, run_mode=_rmode_sse, interactive=False, sink=_sink,
                )
            except Exception as e:
                yield f"data: {json.dumps({'event': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return
            try:
                idle_deadline = float(os.environ.get("AGENT_SSE_IDLE_TIMEOUT") or 1800)
                while True:
                    try:
                        ev = await asyncio.wait_for(queue.get(), timeout=idle_deadline)
                    except asyncio.TimeoutError:
                        yield f"data: {json.dumps({'event': 'error', 'message': '等待 Agent 事件超时'}, ensure_ascii=False)}\n\n"
                        break
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    if ev.get("event") in ("agent_response", "error"):
                        break
            finally:
                agent_manager.detach(session_id, _sink)
            yield "data: [DONE]\n\n"
            return

        if _smode == "chat":
            try:
                reply = await llm_service.chat_completion(
                    messages=[
                        {"role": "system", "content": "你是AI漫剧导演顾问，只做问答讲解，不调用任何工具。请在 <think> ... </think> 标签内展示专业导演的思考推演过程，再用中文回答。"},
                        {"role": "user", "content": prompt_text[:4000]},
                    ],
                    temperature=0.5,
                )
                from app.pipelines.llm_service import extract_think_tags, strip_think_tags
                th = extract_think_tags(reply or "").strip()
                clean_reply = strip_think_tags(reply or "").strip()
                if not th:
                    th = f"【导演顾问思考推演】\n- 意图分析：用户询问「{prompt_text[:60]}」\n- 解答路径：梳理漫剧影视创作知识库，输出条理清晰的专业指导建议。"
                yield f"data: {json.dumps({'event':'agent_thinking_start'}, ensure_ascii=False)}\n\n"
                for i in range(0, len(th), 8):
                    yield f"data: {json.dumps({'event':'agent_thinking_chunk','delta':th[i:i+8]}, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0.005)
                yield f"data: {json.dumps({'event':'agent_thinking_end'}, ensure_ascii=False)}\n\n"
                if clean_reply:
                    yield f"data: {json.dumps({'event':'agent_stream_start'}, ensure_ascii=False)}\n\n"
                    for i in range(0, len(clean_reply), 6):
                        yield f"data: {json.dumps({'event':'agent_stream_chunk','delta':clean_reply[i:i+6]}, ensure_ascii=False)}\n\n"
                        await asyncio.sleep(0.015)
                yield f"data: {json.dumps({'event':'agent_response','message':clean_reply,'thinking':th,'suggested_actions':['切换到执行模式让我直接做'],'mode':'chat'}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'event':'error','message':str(e)}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
            return
        # 辅助发送函数
        async def send_event(event: str, data: Dict[str, Any]):
            # SSE 格式：data: json\n\n
            payload = json.dumps({"event": event, **data}, ensure_ascii=False)
            yield f"data: {payload}\n\n"

        # 若无 LangChain，回退为模拟流式
        if not HAS_LANGCHAIN_AGENT:
            try:
                decision = await llm_service.chat_json(
                    system_prompt=get_agent_system_prompt(),
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

        # LangChain 流式：通过队列桥接 websocket 风格回调到 SSE（修复旧版 asyncio.wait 泄漏）
        queue: asyncio.Queue = asyncio.Queue()

        class SSEBridge:
            async def send_json(self, data: Dict[str, Any]):
                await queue.put(data)

        bridge = SSEBridge()
        # 运行模式透传（plan=只读规划模式）
        _ctx_s = dict(req.context or {})
        try:
            from app.agent.mode_policy import normalize_run_mode as _nrm3, behavior_of as _beh3
            _rm3 = _nrm3(getattr(req, "run_mode", "approve"))
        except Exception:
            _rm3 = "approve"
            _beh3 = lambda m: "plan" if str(m).startswith("plan") else "standard"  # noqa: E731
        _ctx_s["run_mode"] = _rm3
        _ctx_s["plan_mode"] = (_beh3(_rm3) == "plan")
        # 启动后台任务执行 agent
        task = asyncio.create_task(run_agent_with_langchain(
            prompt=prompt_text,
            context=_ctx_s,
            session_id=session_id,
            websocket=bridge,  # 复用 websocket 接口（send_json）
            streaming=True,
        ))

        # 消费者：从队列取事件并转为 SSE（无泄漏版：wait_for 替代 wait+超时丢弃）
        try:
            while not task.done() or not queue.empty():
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=0.5)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    # 超时仅用于检查 task 是否已完成，避免永久阻塞；无事件则继续轮询
                    if task.done():
                        # 任务已结束且队列已空（while 条件保证），排空残余
                        while not queue.empty():
                            ev = await queue.get()
                            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        break
                    continue
            # 任务结束，检查异常并推送最终 agent_response
            if task.done():
                try:
                    res = task.result()
                    if isinstance(res, dict):
                        final_reply = res.get("reply", "指令已执行。")
                        final_thinking = res.get("thinking")
                        final_tools = res.get("executed_tools") or []
                        final_actions = res.get("suggested_actions") or []
                        yield f"data: {json.dumps({'event':'agent_response','message':final_reply,'thinking':final_thinking,'executed_tools':final_tools,'suggested_actions':final_actions,'mode':_smode}, ensure_ascii=False)}\n\n"
                except Exception as e:
                    yield f"data: {json.dumps({'event':'error','message':str(e)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/agent/history")
async def get_agent_history(session_id: str = "http_default"):
    """获取指定会话的历史（v2：从事件日志投影；v1：LangChain 记忆）"""
    if AGENT_V2:
        lp = agent_manager.get(session_id)
        if lp is not None:
            return {"session_id": session_id, "history": lp.session.derive_messages(), "has_langchain": False, "engine": "v2", "seq": lp.session.seq}
        try:
            from app.agent.runtime.session import Session
            s = Session.open(session_id)
            return {"session_id": session_id, "history": s.derive_messages(), "has_langchain": False, "engine": "v2", "seq": s.seq}
        except Exception as e:
            return {"session_id": session_id, "history": [], "has_langchain": False, "engine": "v2", "error": str(e)[:200]}
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


@router.post("/agent/session/{session_id}/steer")
async def agent_session_steer(session_id: str, req: AgentChatRequest):
    """运行中插话：进入当前轮的下一步（v2）。"""
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持 steer")
    ok = await agent_manager.steer(session_id, req.prompt or "")
    return {"status": "accepted" if ok else "no_session", "session_id": session_id}


@router.get("/agent/session/{session_id}/snapshot")
async def agent_session_snapshot(session_id: str, tail: int = 200):
    """一致性快照：断线重连后按 as_of_seq 续播（v2）。"""
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持 snapshot")
    lp = agent_manager.get(session_id)
    if lp is not None:
        return lp.session.snapshot(tail=tail)
    from app.agent.runtime.session import Session
    return Session.open(session_id, repair=False).snapshot(tail=tail)


@router.post("/agent/approve")
async def agent_approve_http(body: Dict[str, Any] = {}):
    """HTTP/SSE 传输的审批回执入口（交互通道缺失时审批默认 fail-closed）。"""
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持")
    ok = await agent_manager.resolve_approval(
        str(body.get("session_id") or ""),
        str(body.get("approval_id") or ""),
        bool(body.get("approved", False)),
    )
    return {"resolved": ok}


class AgentGoalRequest(BaseModel):
    objective: str = ""
    max_rounds: Optional[int] = None


@router.post("/agent/session/{session_id}/goal")
async def agent_set_goal(session_id: str, req: AgentGoalRequest):
    """设定长期目标（整集批量/一键成片）：自动按轮次续跑，完成后停止。"""
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持")
    if not (req.objective or "").strip():
        raise HTTPException(status_code=400, detail="objective 不能为空")
    goal = await agent_manager.set_goal(session_id, req.objective, req.max_rounds)
    return {"status": "accepted", "goal": goal}


@router.get("/agent/session/{session_id}/goal")
async def agent_get_goal(session_id: str):
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持")
    return {"goal": await agent_manager.get_goal(session_id)}


@router.delete("/agent/session/{session_id}/goal")
async def agent_clear_goal(session_id: str):
    if not AGENT_V2:
        raise HTTPException(status_code=400, detail="仅 v2 内核支持")
    ok = await agent_manager.clear_goal(session_id)
    return {"cleared": ok}


@router.post("/agent/clear")
async def clear_agent_history(body: Dict[str, Any] = {}):
    """清空指定会话的记忆"""
    session_id = body.get("session_id") or "http_default"
    if AGENT_V2:
        await agent_manager.clear(session_id)
        return {"status": "cleared", "session_id": session_id, "engine": "v2"}
    if HAS_LANGCHAIN_AGENT:
        await clear_session(session_id)
        return {"status": "cleared", "session_id": session_id}
    return {"status": "ok", "session_id": session_id, "has_langchain": False}


class CreatorProposeRequest(BaseModel):
    goal: str = ""
    context: Dict[str, Any] = Field(default_factory=dict)


@router.post("/agent/creator/propose")
async def creator_propose(req: CreatorProposeRequest):
    from app.agent import creator as _creator
    if not (req.goal or "").strip():
        raise HTTPException(status_code=400, detail="goal 不能为空")
    return _creator.propose_capability(req.goal, req.context or {})


@router.post("/agent/creator/{proposal_id}/start")
async def creator_start(proposal_id: str):
    from app.agent import creator as _creator
    try:
        return await _creator.start_test(proposal_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


class CreatorFinalizeRequest(BaseModel):
    action: str = "persist"


@router.post("/agent/creator/{proposal_id}/finalize")
async def creator_finalize(proposal_id: str, req: CreatorFinalizeRequest):
    from app.agent import creator as _creator
    act = (req.action or "persist").strip().lower()
    if act not in ("persist", "discard", "rollback"):
        raise HTTPException(status_code=400, detail="action 仅支持 persist/discard/rollback")
    try:
        return await _creator.finalize(proposal_id, act)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/agent/creator/proposals")
async def creator_list(limit: int = 20):
    from app.agent import creator as _creator
    return {"proposals": _creator.list_proposals(limit=limit)}


@router.get("/agent/creator/templates")
async def creator_template_list():
    """Creator 画布模板列表（画布“从模板新建”消费）。"""
    from app.agent import creator as _creator
    return {"templates": _creator.list_templates()}


@router.get("/agent/creator/templates/{tid}")
async def creator_template_get(tid: str):
    from app.agent import creator as _creator
    try:
        return _creator.get_template(tid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/skills/{skill_name}/versions")
async def skill_version_list(skill_name: str):
    """Skill 版本历史：current + 快照（导入覆盖/Creator 备份自动留档）。"""
    from app.agent import creator as _creator
    return {"skill": skill_name, "versions": _creator.list_skill_versions(skill_name)}


@router.get("/skills/{skill_name}/versions/{vid}")
async def skill_version_get(skill_name: str, vid: str):
    from app.agent import creator as _creator
    try:
        return {"skill": skill_name, "vid": vid, "content": _creator.get_skill_version(skill_name, vid)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/agent/mode/policy")
async def agent_mode_policy():
    from app.agent.mode_policy import RUN_MODES, MODE_BUDGETS, TOOL_RISK
    return {"modes": list(RUN_MODES), "budgets": MODE_BUDGETS, "tool_risk_sample": dict(list(TOOL_RISK.items())[:24])}


@router.get("/agent/traces")
async def list_agent_traces(limit: int = 30):
    from app.agent.trace import list_runs
    return {"runs": list_runs(limit=limit)}


@router.get("/agent/traces/{run_id}")
async def get_agent_trace(run_id: str, limit: int = 500):
    from app.agent.trace import get_trace
    return {"run_id": run_id, "events": get_trace(run_id, limit=limit)}

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
