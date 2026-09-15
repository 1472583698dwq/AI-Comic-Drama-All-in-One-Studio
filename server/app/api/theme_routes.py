# -*- coding: utf-8 -*-
"""主题包 HTTP API — 列表 / 声明模板 / 保存 / 删除 / 详情。"""
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException, Query

from app.themes.manager import theme_manager, list_effective_themes
from app.themes.models import ThemeSpec, MANIFEST_TEMPLATE

router = APIRouter()


@router.get("/themes")
async def list_themes(project_id: str = Query(default=""),
                      include_disabled: bool = Query(default=False)):
    themes = (theme_manager.list_themes() if include_disabled
              else list_effective_themes(project_id or "", include_disabled=False))
    return {"themes": [t.model_dump() for t in themes], "total": len(themes)}


@router.get("/themes/spec")
async def theme_spec():
    return {"template": MANIFEST_TEMPLATE,
            "contract": "CSS 变量包：vars 键须为 --xxx；mode=all|dark|light；前端 apply 到 :root"}


@router.post("/themes")
async def save_theme(payload: Dict[str, Any] = Body(...)):
    try:
        spec = ThemeSpec.model_validate(payload)
        saved = theme_manager.save(spec)
        return {"status": "success", "theme": saved.model_dump()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"主题声明非法: {e}")


@router.delete("/themes/{tid}")
async def delete_theme(tid: str):
    if not theme_manager.delete(tid):
        raise HTTPException(status_code=404, detail=f"主题不存在: {tid}")
    return {"status": "deleted", "id": tid}


@router.get("/themes/{tid}")
async def get_theme(tid: str):
    spec = theme_manager.get(tid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"主题不存在: {tid}")
    return {"theme": spec.model_dump()}
