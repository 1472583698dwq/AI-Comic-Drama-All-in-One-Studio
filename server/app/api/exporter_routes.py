# -*- coding: utf-8 -*-
"""导出器 HTTP API — 列表 / 声明模板 / 保存 / 删除 / 详情 / 单次执行。"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from app.exporters.manager import exporter_manager, list_effective_exporters, run_exporter
from app.exporters.models import ExporterSpec, MANIFEST_TEMPLATE

router = APIRouter()


class ExporterRunRequest(BaseModel):
    model_config = {"extra": "allow"}
    exporter_id: str = ""
    payload: Dict[str, Any] = {}
    project_id: Optional[str] = None


@router.get("/exporters")
async def list_exporters(project_id: str = Query(default=""),
                         include_disabled: bool = Query(default=False)):
    exporters = (exporter_manager.list_exporters() if include_disabled
                 else list_effective_exporters(project_id or "", include_disabled=False))
    return {"exporters": [e.model_dump() for e in exporters], "total": len(exporters)}


@router.get("/exporters/spec")
async def exporter_spec():
    return {"template": MANIFEST_TEMPLATE,
            "contract": "声明式导出器：accepts 载荷（project/shots/characters/assets/meta）+ run.extension"}


@router.post("/exporters")
async def save_exporter(payload: Dict[str, Any] = Body(...)):
    try:
        spec = ExporterSpec.model_validate(payload)
        saved = exporter_manager.save(spec)
        return {"status": "success", "exporter": saved.model_dump()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"导出器声明非法: {e}")


@router.delete("/exporters/{eid}")
async def delete_exporter(eid: str):
    if not exporter_manager.delete(eid):
        raise HTTPException(status_code=404, detail=f"导出器不存在: {eid}")
    return {"status": "deleted", "id": eid}


@router.get("/exporters/{eid}")
async def get_exporter(eid: str):
    spec = exporter_manager.get(eid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"导出器不存在: {eid}")
    return {"exporter": spec.model_dump()}


@router.post("/exporters/run")
async def run_exporter_once(req: ExporterRunRequest):
    spec = exporter_manager.get(req.exporter_id)
    if not spec:
        raise HTTPException(status_code=404, detail=f"导出器不存在: {req.exporter_id}")
    if not spec.enabled:
        raise HTTPException(status_code=400, detail="该导出器已禁用")
    try:
        result = await run_exporter(spec, req.payload or {}, project_id=req.project_id)
        if result.get("status") == "error":
            raise HTTPException(status_code=502, detail=result.get("error") or "执行失败")
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导出器执行失败: {e}")
