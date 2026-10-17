import os
import json
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query

from app.models.asset import Asset, AssetCreateRequest, AssetUpdateRequest
from app.providers.asset.manager import asset_manager

router = APIRouter()

def _project_exists(project_id: str) -> bool:
    """目标项目是否存在（用于共享/复制的目标校验）。"""
    try:
        from app.providers.project.manager import PROJECTS_ROOT, _resolve_id
        rid = _resolve_id(project_id)
        return os.path.isdir(os.path.join(PROJECTS_ROOT, rid))
    except Exception:
        return False

def _parse_json_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(x) for x in parsed]
        return [str(parsed)]
    except Exception:
        return [t.strip() for t in raw.split(",") if t.strip()]

@router.get("/assets/stats")
async def get_asset_stats(project_id: Optional[str] = Query(None, description="项目口径统计（默认全局）")):
    return asset_manager.get_stats(project_id=project_id)

@router.get("/assets/tags")
async def get_asset_tags(q: Optional[str] = None, project_id: Optional[str] = Query(None)):
    return {"tags": asset_manager.search_tags(q, project_id=project_id)}

@router.get("/assets")
async def list_assets(
    category: Optional[str] = Query(None, description="character|scene|prop|background|effect|ui|other"),
    status: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="关键词搜索 名称/描述/提示词/标签"),
    project_id: Optional[str] = Query(None),
    scope: Optional[str] = Query(None, description="project|global|shared|all（shared=别人共享给我的）"),
    include_shared: bool = Query(True, description="是否包含共享到当前项目的资产"),
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=100),
    sort: str = Query("updated_at", description="updated_at|created_at|name"),
    group: Optional[str] = Query(None, description="分组过滤：分组路径（含子级）或 __none__=未分组"),
):
    # scope=all 时不传 scope 过滤
    eff_scope = None if (not scope or scope == "all") else scope
    return asset_manager.list_assets(category=category, status=status, tag=tag, q=q, project_id=project_id, page=page, limit=limit, sort=sort, scope=eff_scope, include_shared=include_shared, group=group)


# ── 素材分组（L2 分级）────────────────────────────────────────
# 注意：必须注册在 /assets/{asset_id} 之前，否则 "groups" 会被当成素材 id

@router.get("/assets/groups")
async def list_asset_groups(project_id: Optional[str] = Query(None)):
    from app.providers.asset.groups import list_groups, group_counts
    res = list_groups(project_id)
    res["counts"] = group_counts(project_id)
    return res

@router.post("/assets/groups")
async def create_asset_group(body: dict):
    from app.providers.asset.groups import create_group
    scope = body.get("scope") or "project"
    if scope not in ("project", "global"):
        raise HTTPException(status_code=400, detail="scope 仅支持 project/global")
    try:
        return create_group(body.get("path", ""), project_id=body.get("project_id"), scope=scope)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.put("/assets/groups")
async def rename_asset_group(body: dict):
    from app.providers.asset.groups import rename_group
    scope = body.get("scope") or "project"
    if scope not in ("project", "global"):
        raise HTTPException(status_code=400, detail="scope 仅支持 project/global")
    try:
        return rename_group(body.get("old_path", ""), body.get("new_path", ""), project_id=body.get("project_id"), scope=scope)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/assets/groups")
async def delete_asset_group(
    path: str = Query(...),
    project_id: Optional[str] = Query(None),
    scope: str = Query("project"),
):
    from app.providers.asset.groups import delete_group
    if scope not in ("project", "global"):
        raise HTTPException(status_code=400, detail="scope 仅支持 project/global")
    try:
        return delete_group(path, project_id=project_id, scope=scope)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

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
            data = {
                "name": base_name,
                "category": category,
                "description": "",
                "tags": tag_list,
                "visual_prompt": visual_prompt or "",
                "source": "upload",
                "project_id": project_id,
                "scope": scope,
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
        data = {
            "name": name,
            "category": category,
            "description": prompt[:200],
            "tags": tag_list,
            "visual_prompt": prompt,
            "style_preset": style_preset,
            "project_id": project_id,
            "scope": scope,
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
    # scope/shared_to 解析（归属不变式由 manager 统一收口）
    parsed_shared = _parse_json_list(shared_to)
    data = {
        "name": name,
        "category": category,
        "subcategory": subcategory,
        "description": description or "",
        "tags": tag_list,
        "visual_prompt": visual_prompt or "",
        "content": content or "",
        "style_preset": style_preset,
        "project_id": project_id,
        "scope": scope,
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
    group_path: Optional[str] = Form(None, description="项目内分组路径，如 角色/主角；空字符串=移出分组"),
    file: Optional[UploadFile] = File(None),
    actor_project_id: Optional[str] = Form(None, description="操作者项目上下文（写防护）"),
):
    existing = asset_manager.get_asset(asset_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    actor = actor_project_id or project_id
    if not asset_manager.writable_by(existing, actor):
        raise HTTPException(status_code=403, detail="该素材属于其他项目（或为他人共享给你），请先复制到本项目再修改")
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
        updates["tags"] = _parse_json_list(tags)
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
    if group_path is not None:
        updates["group_path"] = group_path or None
    if scope is not None:
        updates["scope"] = scope
    if shared_to is not None:
        updates["shared_to"] = _parse_json_list(shared_to)
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

@router.post("/assets/{asset_id}/publish")
async def publish_asset(asset_id: str, body: dict = None):
    """发布共享：项目素材原地提升为全局（URL 不变，已引用方零影响）。"""
    body = body or {}
    actor = body.get("project_id") or body.get("actor_project_id")
    try:
        updated = asset_manager.publish_asset(asset_id, actor_project_id=actor)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    return updated

@router.post("/assets/{asset_id}/unpublish")
async def unpublish_asset(asset_id: str, body: dict = None):
    """收回共享：全局素材退回出生项目。force=false 时若有其他项目引用，返回 409 + 引用清单。"""
    body = body or {}
    actor = body.get("project_id") or body.get("actor_project_id")
    force = bool(body.get("force"))
    asset = asset_manager.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    origin = asset.origin_project_id
    refs = [r for r in asset_manager.find_references(asset_id) if r.get("project_id") != origin]
    if refs and not force:
        raise HTTPException(status_code=409, detail={
            "code": "asset_referenced",
            "message": "该素材已被其他项目引用，回收共享会让对方引用失效。可先复制到那些项目，或强制收回。",
            "references": refs,
        })
    try:
        updated = asset_manager.unpublish_asset(asset_id, actor_project_id=actor)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return updated

@router.post("/assets/{asset_id}/share")
async def share_asset(asset_id: str, body: dict):
    """共享管理：
    - scope=global → 发布到全局（等价 /publish）
    - scope=project → 收回共享（等价 /unpublish，退回出生项目）
    - target_project_ids → 定向共享给指定项目（接收方只读可见）
    """
    asset = asset_manager.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    actor = body.get("project_id") or body.get("actor_project_id")
    target_ids = body.get("target_project_ids") or body.get("shared_to")
    scope = body.get("scope")
    if scope == "global":
        try:
            updated = asset_manager.publish_asset(asset_id, actor_project_id=actor)
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e))
        return updated
    if scope == "project":
        try:
            updated = asset_manager.unpublish_asset(asset_id, actor_project_id=actor)
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e))
    elif not asset_manager.writable_by(asset, actor):
        raise HTTPException(status_code=403, detail="该素材属于其他项目（或为他人共享给你），请先复制到本项目再共享")
    if target_ids is not None:
        if isinstance(target_ids, str):
            target_ids = _parse_json_list(target_ids)
        if not isinstance(target_ids, list):
            raise HTTPException(status_code=400, detail="target_project_ids 需为数组")
        # 目标项目校验 + 归一
        from app.providers.asset.manager import _resolve_shared_targets
        resolved = _resolve_shared_targets(target_ids)
        invalid = [t for t in target_ids if not _project_exists(str(t))]
        if invalid:
            raise HTTPException(status_code=400, detail={"code": "invalid_targets", "message": "以下目标项目不存在", "invalid": invalid})
        # 不能共享给自己；全局素材无需定向共享
        cur_asset = asset_manager.get_asset(asset_id)
        if cur_asset and (cur_asset.scope or "project") == "global":
            raise HTTPException(status_code=400, detail="全局素材对所有项目可见，无需定向共享")
        own_pid = cur_asset.project_id if cur_asset else None
        resolved = [t for t in resolved if t != own_pid]
        updated = asset_manager.update_asset(asset_id, {"shared_to": resolved})
        return updated
    if scope is None:
        raise HTTPException(status_code=400, detail="无可更新字段（scope / target_project_ids 至少一项）")
    return asset_manager.get_asset(asset_id)

@router.post("/assets/share/batch")
async def batch_share_assets(body: dict):
    """批量共享：{asset_ids, scope?: 'global'|'project', target_project_ids?: [], project_id?: actor}"""
    asset_ids = body.get("asset_ids") or []
    if not isinstance(asset_ids, list) or not asset_ids:
        raise HTTPException(status_code=400, detail="asset_ids 不能为空")
    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for aid in asset_ids:
        try:
            cur = asset_manager.get_asset(aid)
            if not cur:
                errors.append({"asset_id": aid, "error": "素材不存在"})
                continue
            if body.get("scope") == "global":
                results.append(asset_manager.publish_asset(aid, actor_project_id=body.get("project_id")).model_dump())
            else:
                target_ids = body.get("target_project_ids")
                if target_ids is None:
                    errors.append({"asset_id": aid, "error": "缺少 target_project_ids"})
                    continue
                updated = await share_asset(aid, {"target_project_ids": target_ids, "project_id": body.get("project_id")})
                results.append(updated.model_dump() if hasattr(updated, "model_dump") else updated)
        except PermissionError as e:
            errors.append({"asset_id": aid, "error": str(e)})
        except HTTPException as e:
            errors.append({"asset_id": aid, "error": e.detail})
        except Exception as e:
            errors.append({"asset_id": aid, "error": str(e)})
    return {"shared": len(results), "failed": len(errors), "assets": results, "errors": errors}

@router.post("/assets/{asset_id}/copy")
async def copy_asset(asset_id: str, body: dict):
    """复制素材到目标项目（文件级拷贝；副本不继承共享关系与发布状态）"""
    target_project_id = body.get("target_project_id") or body.get("project_id")
    if not target_project_id:
        raise HTTPException(status_code=400, detail="需提供 target_project_id")
    if not _project_exists(target_project_id):
        raise HTTPException(status_code=400, detail=f"目标项目不存在: {target_project_id}")
    src = asset_manager.get_asset(asset_id)
    if not src:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    dup = asset_manager.duplicate_asset(asset_id)
    if not dup:
        raise HTTPException(status_code=500, detail="复制失败")
    # 修正为目标项目归属（出生项目=目标项目）
    updated = asset_manager.update_asset(dup.id, {"project_id": target_project_id, "scope": "project", "origin_project_id": target_project_id, "shared_to": []})
    return updated

@router.delete("/assets/{asset_id}")
async def delete_asset(
    asset_id: str,
    project_id: Optional[str] = Query(None, description="操作者项目上下文（写防护）"),
    force: bool = Query(False, description="跳过引用检查强制删除"),
):
    asset = asset_manager.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail=f"素材不存在: {asset_id}")
    if not asset_manager.writable_by(asset, project_id):
        raise HTTPException(status_code=403, detail="该素材属于其他项目（或为他人共享给你），无法删除")
    refs = asset_manager.find_references(asset_id)
    if refs and not force:
        raise HTTPException(status_code=409, detail={
            "code": "asset_referenced",
            "message": "该素材仍被以下项目/画布引用，删除后引用会失效。确认删除请加 force=true。",
            "references": refs,
        })
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
