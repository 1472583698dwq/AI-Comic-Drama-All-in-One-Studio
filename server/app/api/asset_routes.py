import os
import json
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query

from app.models.asset import Asset, AssetCreateRequest, AssetUpdateRequest
from app.providers.asset.manager import asset_manager

router = APIRouter()

@router.get("/assets/stats")
async def get_asset_stats():
    return asset_manager.get_stats()

@router.get("/assets/tags")
async def get_asset_tags(q: Optional[str] = None):
    return {"tags": asset_manager.search_tags(q)}

@router.get("/assets")
async def list_assets(
    category: Optional[str] = Query(None, description="character|scene|prop|background|effect|ui|other"),
    status: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="关键词搜索 名称/描述/提示词/标签"),
    project_id: Optional[str] = Query(None),
    scope: Optional[str] = Query(None, description="project|global|all"),
    include_shared: bool = Query(True, description="是否包含共享到当前项目的资产"),
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=100),
    sort: str = Query("updated_at", description="updated_at|created_at|name"),
):
    # scope=all 时不传 scope 过滤
    eff_scope = None if (not scope or scope == "all") else scope
    return asset_manager.list_assets(category=category, status=status, tag=tag, q=q, project_id=project_id, page=page, limit=limit, sort=sort, scope=eff_scope, include_shared=include_shared)

@router.post("/assets/batch")
async def batch_create_assets(
    category: str = Form("other"),
    tags: Optional[str] = Form(None),
    visual_prompt: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    scope: str = Form("project"),
    files: List[UploadFile] = File(...),
):
    tag_list = []
    if tags:
        try:
            parsed = json.loads(tags)
            tag_list = parsed if isinstance(parsed, list) else [str(parsed)]
        except Exception:
            tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    if not files:
        raise HTTPException(status_code=400, detail="请至少选择一个文件")
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="批量导入最多20个文件")
    created = []
    errors: List[str] = []
    for uf in files:
        try:
            data_bytes = await uf.read()
            if not data_bytes:
                errors.append(f"{uf.filename}: 文件为空")
                continue
            fname = uf.filename or "upload.png"
            base_name = os.path.splitext(fname)[0] or "素材"
            eff_scope = scope if scope in ("project","global") else "project"
            eff_proj = None if eff_scope=="global" else project_id
            data = {
                "name": base_name,
                "category": category,
                "description": "",
                "tags": tag_list,
                "visual_prompt": visual_prompt or "",
                "source": "upload",
                "project_id": eff_proj,
                "scope": eff_scope,
            }
            # REQ-toonflow-canvas 带上 content-type：文件名没有可用扩展名时据此保留真实格式
            asset = asset_manager.create_asset(data, file_bytes=data_bytes, filename=fname, content_type=uf.content_type)
            created.append(asset.model_dump())
        except Exception as e:
            errors.append(f"{uf.filename}: {e}")
    return {"imported": len(created), "total": len(files), "assets": created, "errors": errors}


@router.post("/assets/clean-missing")
async def clean_missing_assets():
    """手动清理「文件已删、记录还在」的悬空素材（删除前先备份清单到 .missing_backup.jsonl）"""
    report = asset_manager.cleanup_missing()
    return {"status": "ok", **report}


@router.post("/assets/generate")
async def generate_asset(
    name: str = Form(...),
    prompt: str = Form(...),
    category: str = Form("character"),
    style_preset: Optional[str] = Form(None),
    provider: Optional[str] = Form(None),
    workflow_id: Optional[str] = Form(None),
    negative_prompt: Optional[str] = Form(None),
    aspect_ratio: str = Form("1:1"),
    seed: Optional[int] = Form(None),
    tags: Optional[str] = Form(None),
    dynamic_inputs: Optional[str] = Form(None),
    params: Optional[str] = Form(None, description="生成源参数 JSON（steps/resolution/cfg/model 及源自定义参数）"),
    project_id: Optional[str] = Form(None, description="归属项目"),
    scope: str = Form("project"),
):
    """
    直接通过生图Provider生成并入库为素材
    复用现有动态Provider能力
    """
    from app.providers.image.base import ImageGenerateRequest
    from app.providers.image.registry import image_registry
    from app.providers.init_providers import init_all_providers
    if not image_registry.list_ids():
        init_all_providers()
    tag_list = []
    if tags:
        try:
            tag_list = json.loads(tags)
            if not isinstance(tag_list, list):
                tag_list = [str(tag_list)]
        except Exception:
            tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    
    parsed_dynamic_inputs = None
    if dynamic_inputs:
        try:
            parsed_dynamic_inputs = json.loads(dynamic_inputs)
        except Exception:
            pass

    # 生成源参数：已知字段进 ImageGenerateRequest，其余进 extra + dynamic_inputs（代码源经 merge_user_params 读取）
    parsed_params: Dict[str, Any] = {}
    if params:
        try:
            _pp = json.loads(params)
            if isinstance(_pp, dict):
                parsed_params = _pp
        except Exception:
            pass
    req_kw: Dict[str, Any] = {}
    for _k in ("resolution", "steps", "cfg", "width", "height", "fps", "duration", "model"):
        _v = parsed_params.pop(_k, None)
        if _v not in (None, ""):
            req_kw[_k] = _v
    merged_dyn = dict(parsed_dynamic_inputs or {})
    for _k, _v in parsed_params.items():
        if _v in (None, ""):
            continue
        merged_dyn.setdefault(_k, _v)

    effective_provider = provider
    if not effective_provider and workflow_id:
        effective_provider = "comfyui"

    req = ImageGenerateRequest(
        prompt=prompt,
        negative_prompt=negative_prompt or "",
        aspect_ratio=aspect_ratio,
        style_preset=style_preset,
        seed=seed,
        workflow_id=workflow_id or None,
        dynamic_inputs=merged_dyn or None,
        extra=(parsed_params or None),
        **req_kw,
    )
    try:
        res = await image_registry.generate(req, provider_id=effective_provider)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"生成失败: {e}")
    try:
        src_path = res.local_path
        with open(src_path, "rb") as f:
            file_bytes = f.read()
        filename = os.path.basename(src_path)
        eff_scope = scope if scope in ("project","global") else "project"
        eff_proj = None if eff_scope=="global" else project_id
        data = {
            "name": name,
            "category": category,
            "description": prompt[:200],
            "tags": tag_list,
            "visual_prompt": prompt,
            "style_preset": style_preset,
            "project_id": eff_proj,
            "scope": eff_scope,
            "source": "generate",
            "extra": {"provider": res.provider, "engine": res.engine, "seed": res.seed, "workflow_id": workflow_id},
        }
        asset = asset_manager.create_asset(data, file_bytes=file_bytes, filename=filename)
        asset.extra.update({"generated_url": res.image_url, "generated_engine": res.engine})
        from app.providers.asset.manager import _save_asset
        _save_asset(asset)
        return {"asset": asset, "generation": {"image_url": res.image_url, "provider": res.provider, "engine": res.engine, "seed": res.seed}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成成功但入库失败: {e}")

@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str):
    asset = asset_manager.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    return asset

@router.post("/assets")
async def create_asset(
    name: str = Form(...),
    category: str = Form("character"),
    subcategory: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None, description="JSON数组或逗号分隔"),
    visual_prompt: Optional[str] = Form(None),
    content: Optional[str] = Form(None, description="文本/提示词素材正文（category=text）"),
    style_preset: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    scope: str = Form("project", description="project|global"),
    shared_to: Optional[str] = Form(None, description="JSON数组 project_ids"),
    status: Optional[str] = Form("approved"),
    file_url: Optional[str] = Form(None),
    style_anchor_id: Optional[str] = Form(None),
    lora_trigger: Optional[str] = Form(None),
    voice_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
):
    # 解析 tags
    tag_list = []
    if tags:
        try:
            parsed = json.loads(tags)
            if isinstance(parsed, list):
                tag_list = parsed
            else:
                tag_list = [str(parsed)]
        except Exception:
            tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    # P0: scope/shared_to 解析
    parsed_shared = []
    if shared_to:
        try:
            parsed = json.loads(shared_to)
            parsed_shared = parsed if isinstance(parsed, list) else [str(parsed)]
        except Exception:
            parsed_shared = [s.strip() for s in shared_to.split(",") if s.strip()]
    # scope校验与 project_id 联动
    eff_scope = scope if scope in ("project", "global") else "project"
    eff_project_id = None if eff_scope == "global" else project_id
    data = {
        "name": name,
        "category": category,
        "subcategory": subcategory,
        "description": description or "",
        "tags": tag_list,
        "visual_prompt": visual_prompt or "",
        "content": content or "",
        "style_preset": style_preset,
        "project_id": eff_project_id,
        "scope": eff_scope,
        "shared_to": parsed_shared,
        "status": status,
        "file_url": file_url,
        "style_anchor_id": style_anchor_id,
        "lora_trigger": lora_trigger,
        "voice_id": voice_id,
        "source": "upload" if file else ("external" if file_url and file_url.startswith("http") else "upload"),
    }
    file_bytes = None
    filename = None
    content_type = None
    if file:
        file_bytes = await file.read()
        filename = file.filename or "upload.png"
        content_type = file.content_type  # REQ-toonflow-canvas 文件名给不出扩展名时按 content-type 保留真实格式
        if not file_bytes:
            raise HTTPException(status_code=400, detail="上传文件为空")
    asset = asset_manager.create_asset(data, file_bytes=file_bytes, filename=filename, content_type=content_type)
    return asset

@router.put("/assets/{asset_id}")
async def update_asset(
    asset_id: str,
    name: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    subcategory: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),
    visual_prompt: Optional[str] = Form(None),
    content: Optional[str] = Form(None, description="文本/提示词素材正文"),
    style_preset: Optional[str] = Form(None),
    status: Optional[str] = Form(None),
    file_url: Optional[str] = Form(None),
    style_anchor_id: Optional[str] = Form(None),
    lora_trigger: Optional[str] = Form(None),
    voice_id: Optional[str] = Form(None),
    scope: Optional[str] = Form(None, description="project|global"),
    shared_to: Optional[str] = Form(None, description="JSON数组"),
    project_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
):
    existing = asset_manager.get_asset(asset_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    updates = {}
    if name is not None:
        updates["name"] = name
    if category is not None:
        updates["category"] = category
    if subcategory is not None:
        updates["subcategory"] = subcategory
    if description is not None:
        updates["description"] = description
    if tags is not None:
        try:
            parsed = json.loads(tags)
            tag_list = parsed if isinstance(parsed, list) else [str(parsed)]
        except Exception:
            tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        updates["tags"] = tag_list
    if visual_prompt is not None:
        updates["visual_prompt"] = visual_prompt
    if content is not None:
        updates["content"] = content
    if style_preset is not None:
        updates["style_preset"] = style_preset
    if status is not None:
        updates["status"] = status
    if file_url is not None:
        updates["file_url"] = file_url
    if style_anchor_id is not None:
        updates["style_anchor_id"] = style_anchor_id
    if lora_trigger is not None:
        updates["lora_trigger"] = lora_trigger
    if voice_id is not None:
        updates["voice_id"] = voice_id
    if scope is not None:
        updates["scope"] = scope
    if shared_to is not None:
        try:
            parsed = json.loads(shared_to)
            updates["shared_to"] = parsed if isinstance(parsed, list) else [str(parsed)]
        except Exception:
            updates["shared_to"] = [s.strip() for s in shared_to.split(",") if s.strip()]
    if project_id is not None:
        updates["project_id"] = project_id
    file_bytes = None
    filename = None
    content_type = None
    if file:
        file_bytes = await file.read()
        filename = file.filename or "upload.png"
        content_type = file.content_type  # REQ-toonflow-canvas 同 create_asset
    updated = asset_manager.update_asset(asset_id, updates, file_bytes=file_bytes, filename=filename, content_type=content_type)
    return updated

@router.post("/assets/{asset_id}/share")
async def share_asset(asset_id: str, body: dict):
    """设为全局或共享到指定项目"""
    asset = asset_manager.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    scope = body.get("scope")  # project | global
    target_ids = body.get("target_project_ids") or body.get("shared_to") or []
    updates: dict = {}
    if scope:
        if scope not in ("project", "global"):
            raise HTTPException(status_code=400, detail="scope 仅支持 project/global")
        updates["scope"] = scope
        if scope == "global":
            updates["project_id"] = None
    if target_ids is not None:
        if isinstance(target_ids, str):
            try:
                target_ids = json.loads(target_ids)
            except Exception:
                target_ids = [t.strip() for t in target_ids.split(",") if t.strip()]
        updates["shared_to"] = target_ids if isinstance(target_ids, list) else []
    if not updates:
        raise HTTPException(status_code=400, detail="无可更新字段")
    updated = asset_manager.update_asset(asset_id, updates)
    return updated

@router.post("/assets/{asset_id}/copy")
async def copy_asset(asset_id: str, body: dict):
    """复制素材到目标项目（文件级拷贝）"""
    target_project_id = body.get("target_project_id") or body.get("project_id")
    if not target_project_id:
        raise HTTPException(status_code=400, detail="需提供 target_project_id")
    src = asset_manager.get_asset(asset_id)
    if not src:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    dup = asset_manager.duplicate_asset(asset_id)
    if not dup:
        raise HTTPException(status_code=500, detail="复制失败")
    # 修正为目标项目归属
    updated = asset_manager.update_asset(dup.id, {"project_id": target_project_id, "scope": "project"})
    return updated

@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str):
    ok = asset_manager.delete_asset(asset_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    return {"status": "deleted", "id": asset_id}

@router.post("/assets/{asset_id}/duplicate")
async def duplicate_asset(asset_id: str):
    dup = asset_manager.duplicate_asset(asset_id)
    if not dup:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    return dup

from pydantic import BaseModel

class MigrateRequest(BaseModel):
    project_id: Optional[str] = None
    characters: List[dict] = []

@router.post("/assets/migrate/characters")
async def migrate_characters(req: MigrateRequest):
    """
    将现有Project的characters迁移为素材库条目（person类）
    """
    chars = req.characters
    if not chars:
        raise HTTPException(status_code=400, detail="source_project.characters 为空")
    created = []
    for c in chars:
        # 检查是否已存在同名同visual_prompt
        name = c.get("name", "未命名角色")
        existing = asset_manager.list_assets(category="character", q=name, limit=100)
        # 简单去重：同名且同visual_prompt跳过
        dup = any(a["visual_prompt"] == c.get("visual_prompt", "") and a["name"] == name for a in existing["assets"])
        if dup:
            continue
        data = {
            "name": name,
            "category": "character",
            "subcategory": c.get("role", "supporting"),
            "description": c.get("description", ""),
            "tags": [c.get("role", "character")],
            "visual_prompt": c.get("visual_prompt", ""),
            "style_preset": None,
            "project_id": req.project_id,
            "voice_id": c.get("voice_id"),
            "voice_name": c.get("voice_name"),
            "source": "migrate",
            "extra": {"origin_id": c.get("id"), "gender": c.get("gender"), "age_group": c.get("age_group")},
        }
        # 处理头像
        file_bytes = None
        filename = None
        avatar_url = c.get("avatar_url")
        # 若有三视图，取front作为代表
        three = c.get("three_views", {})
        rep_url = three.get("front") or avatar_url
        # 如果是 /storage/... 尝试读取本地文件
        if rep_url and rep_url.startswith("/storage/"):
            from app.core.config import settings
            local = os.path.join(settings.STORAGE_DIR, rep_url[len("/storage/"):])
            if os.path.exists(local):
                with open(local, "rb") as f:
                    file_bytes = f.read()
                filename = os.path.basename(local)
        asset = asset_manager.create_asset(data, file_bytes=file_bytes, filename=filename)
        # 补充三视图
        if three:
            asset.three_views = three
            from app.providers.asset.manager import _save_asset
            _save_asset(asset)
        created.append(asset.model_dump())
    return {"migrated": len(created), "assets": created}
