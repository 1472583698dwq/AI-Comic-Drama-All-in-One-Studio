# -*- coding: utf-8 -*-
"""导演包 HTTP API — 列表 / 声明模板 / 保存 / 删除 / 详情。"""
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException, Query

from app.director_packs.manager import director_pack_manager, list_effective_packs
from app.director_packs.models import DirectorPackSpec, MANIFEST_TEMPLATE

router = APIRouter()


@router.get("/director-packs")
async def list_director_packs(project_id: str = Query(default=""),
                              include_disabled: bool = Query(default=False)):
    packs = (director_pack_manager.list_packs() if include_disabled
             else list_effective_packs(project_id or "", include_disabled=False))
    return {"packs": [p.model_dump() for p in packs], "total": len(packs)}


@router.get("/director-packs/spec")
async def director_pack_spec():
    return {"template": MANIFEST_TEMPLATE,
            "contract": "导演台扩展：presets(framing/motion/pose/cast) + environments(背景底图) + props(GLB)"}


@router.post("/director-packs")
async def save_director_pack(payload: Dict[str, Any] = Body(...)):
    try:
        spec = DirectorPackSpec.model_validate(payload)
        saved = director_pack_manager.save(spec)
        return {"status": "success", "pack": saved.model_dump()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"导演包声明非法: {e}")


@router.delete("/director-packs/{pid}")
async def delete_director_pack(pid: str):
    if not director_pack_manager.delete(pid):
        raise HTTPException(status_code=404, detail=f"导演包不存在: {pid}")
    return {"status": "deleted", "id": pid}


@router.get("/director-packs/{pid}")
async def get_director_pack(pid: str):
    spec = director_pack_manager.get(pid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"导演包不存在: {pid}")
    return {"pack": spec.model_dump()}
