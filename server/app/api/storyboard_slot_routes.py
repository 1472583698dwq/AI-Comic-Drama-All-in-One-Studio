# -*- coding: utf-8 -*-
"""分镜槽 API：聚合查看 + 项目覆盖 + 裸件 CRUD（创造模式 persist 落点）。

- GET    /storyboard/slots?project_id=   有效槽聚合（含项目覆盖）
- GET    /storyboard/slots/catalog       内置目录（管理面对照基准）
- PUT    /storyboard/slots/project       {project_id, disabled[], order{}} 项目覆盖
- POST   /storyboard/slots/custom        保存裸件槽（校验 + 去重）
- DELETE /storyboard/slots/custom/{slot}/{sid}  删除裸件槽
"""
from typing import Any, Dict, List
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core import pages
from app.storyboard import slots as slot_store

# 路由级守卫：分镜台（studio）关闭时整族 404（运行期开关，路由始终挂载）
router = APIRouter(dependencies=[Depends(pages.require("studio"))])


@router.get("/storyboard/slots")
async def list_slots(project_id: str = Query(default="")):
    return slot_store.list_effective_slots(project_id or "")


@router.get("/storyboard/slots/catalog")
async def slot_catalog():
    return {"slots": slot_store.BUILTIN_SLOT_CATALOG,
            "total": len(slot_store.BUILTIN_SLOT_CATALOG),
            "containers": list(slot_store.SLOT_CONTAINERS)}


class ProjectOverridesRequest(BaseModel):
    project_id: str = Field(description="项目 id")
    disabled: List[str] = Field(default_factory=list, description="禁用的槽 key（slot:id）")
    order: Dict[str, int] = Field(default_factory=dict, description="槽 key → order 改写")


@router.put("/storyboard/slots/project")
async def save_project_overrides(req: ProjectOverridesRequest):
    if not req.project_id:
        raise HTTPException(status_code=400, detail="project_id 不能为空")
    try:
        saved = slot_store.set_project_overrides(req.project_id, req.disabled, req.order)
        return {"status": "success", "project_id": req.project_id, "overrides": saved}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败: {e}")


@router.post("/storyboard/slots/custom")
async def create_custom_slot(body: Dict[str, Any] = Body(...)):
    try:
        return {"status": "success", **slot_store.save_custom_slot(body)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/storyboard/slots/custom/{slot}/{sid}")
async def remove_custom_slot(slot: str, sid: str):
    ok = slot_store.delete_custom_slot(slot, sid)
    if not ok:
        raise HTTPException(status_code=404, detail=f"裸件槽不存在: {slot}:{sid}")
    return {"status": "deleted", "slot": slot, "id": sid}
