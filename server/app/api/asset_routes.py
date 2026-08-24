import os
import json
from typing import Optional, List
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
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=100),
    sort: str = Query("updated_at", description="updated_at|created_at|name"),
):
    return asset_manager.list_assets(category=category, status=status, tag=tag, q=q, project_id=project_id, page=page, limit=limit, sort=sort)

@router.post("/assets/batch")
async def batch_create_assets(
    category: str = Form("other"),
    tags: Optional[str] = Form(None),
    visual_prompt: Optional[str] = Form(None),
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
            data = {
                "name": base_name,
                "category": category,
                "description": "",
                "tags": tag_list,
                "visual_prompt": visual_prompt or "",
                "source": "upload",
            }
            asset = asset_manager.create_asset(data, file_bytes=data_bytes, filename=fname)
            created.append(asset.model_dump())
        except Exception as e:
            errors.append(f"{uf.filename}: {e}")
    return {"imported": len(created), "total": len(files), "assets": created, "errors": errors}


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
    req = ImageGenerateRequest(
        prompt=prompt,
        negative_prompt=negative_prompt or "",
        aspect_ratio=aspect_ratio,
        style_preset=style_preset,
        seed=seed,
        workflow_id=workflow_id,
    )
    try:
        res = await image_registry.generate(req, provider_id=provider)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"生成失败: {e}")
    try:
        src_path = res.local_path
        with open(src_path, "rb") as f:
            file_bytes = f.read()
        filename = os.path.basename(src_path)
        data = {
            "name": name,
            "category": category,
            "description": prompt[:200],
            "tags": tag_list,
            "visual_prompt": prompt,
            "style_preset": style_preset,
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
    style_preset: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
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
    data = {
        "name": name,
        "category": category,
        "subcategory": subcategory,
        "description": description or "",
        "tags": tag_list,
        "visual_prompt": visual_prompt or "",
        "style_preset": style_preset,
        "project_id": project_id,
        "status": status,
        "file_url": file_url,
        "style_anchor_id": style_anchor_id,
        "lora_trigger": lora_trigger,
        "voice_id": voice_id,
        "source": "upload" if file else ("external" if file_url and file_url.startswith("http") else "upload"),
    }
    file_bytes = None
    filename = None
    if file:
        file_bytes = await file.read()
        filename = file.filename or "upload.png"
        if not file_bytes:
            raise HTTPException(status_code=400, detail="上传文件为空")
    asset = asset_manager.create_asset(data, file_bytes=file_bytes, filename=filename)
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
    style_preset: Optional[str] = Form(None),
    status: Optional[str] = Form(None),
    file_url: Optional[str] = Form(None),
    style_anchor_id: Optional[str] = Form(None),
    lora_trigger: Optional[str] = Form(None),
    voice_id: Optional[str] = Form(None),
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
    file_bytes = None
    filename = None
    if file:
        file_bytes = await file.read()
        filename = file.filename or "upload.png"
    updated = asset_manager.update_asset(asset_id, updates, file_bytes=file_bytes, filename=filename)
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
