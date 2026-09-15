# -*- coding: utf-8 -*-
"""声明式画布节点 HTTP API — 列表 / 详情 / 保存 / 删除 / 单次执行 / 声明模板。

节点声明统一落 storage/canvas_nodes/<id>.json：
- 插件贡献（extensionPoints.canvas_nodes）随包启用入库、禁用精确回滚；
- 裸件可由本路由保存（供创造模式/手工编写），执行与画布引擎同口径。
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from app.canvas_nodes.manager import canvas_node_manager, list_effective_nodes, run_canvas_node
from app.canvas_nodes.models import CanvasNodeSpec, MANIFEST_TEMPLATE

router = APIRouter()


class CanvasNodeRunRequest(BaseModel):
    model_config = {"extra": "allow"}
    canvas_node_id: str = ""
    inputs: Dict[str, Any] = {}
    params: Dict[str, Any] = {}
    project_id: Optional[str] = None


@router.get("/canvas-nodes")
async def list_canvas_nodes(project_id: str = Query(default=""),
                            include_disabled: bool = Query(default=False)):
    nodes = (canvas_node_manager.list_nodes() if include_disabled
             else list_effective_nodes(project_id or "", include_disabled=False))
    return {"nodes": [n.model_dump(by_alias=True) for n in nodes], "total": len(nodes)}


@router.get("/canvas-nodes/spec")
async def canvas_node_spec():
    return {
        "template": MANIFEST_TEMPLATE,
        "contract": "声明式节点：inputs/outputs/params_schema + run.extension（provider|skill|custom_node|mcp_tool）",
    }


@router.post("/canvas-nodes")
async def save_canvas_node(payload: Dict[str, Any] = Body(...)):
    try:
        spec = CanvasNodeSpec.model_validate(payload)
        saved = canvas_node_manager.save(spec)
        return {"status": "success", "node": saved.model_dump(by_alias=True)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"节点声明非法: {e}")


@router.delete("/canvas-nodes/{nid}")
async def delete_canvas_node(nid: str):
    ok = canvas_node_manager.delete(nid)
    if not ok:
        raise HTTPException(status_code=404, detail=f"扩展节点不存在: {nid}")
    return {"status": "deleted", "id": nid}


@router.get("/canvas-nodes/{nid}")
async def get_canvas_node(nid: str):
    spec = canvas_node_manager.get(nid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"扩展节点不存在: {nid}")
    return {"node": spec.model_dump(by_alias=True)}


@router.post("/canvas-nodes/run")
async def run_canvas_node_once(req: CanvasNodeRunRequest):
    """单次执行（节点内按钮/DAG 外调试）：与画布引擎 ext-node 分支同口径。"""
    spec = canvas_node_manager.get(req.canvas_node_id)
    if not spec:
        raise HTTPException(status_code=404, detail=f"扩展节点不存在: {req.canvas_node_id}")
    if not spec.enabled:
        raise HTTPException(status_code=400, detail="该扩展节点已禁用")
    try:
        result = await run_canvas_node(spec, req.inputs or {}, req.params or {}, project_id=req.project_id)
        if result.get("status") == "error":
            raise HTTPException(status_code=502, detail=result.get("error") or "执行失败")
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"扩展节点执行失败: {e}")
