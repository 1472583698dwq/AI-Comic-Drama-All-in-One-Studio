from typing import Optional, List, Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.canvas.engine import canvas_engine

router = APIRouter()

class CanvasExecuteRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    target_ids: Optional[List[str]] = None
    project_id: Optional[str] = None

@router.post("/canvas/execute")
async def execute_canvas(req: CanvasExecuteRequest):
    """
    执行画布 DAG，返回各节点执行结果
    前端可传入完整 nodes/edges + 可选 target_ids（仅执行选中及其下游）
    """
    if not req.nodes:
        raise HTTPException(status_code=400, detail="nodes 为空")
    try:
        result = await canvas_engine.execute_dag(req.nodes, req.edges, project_id=req.project_id, target_ids=req.target_ids)
        return {"status":"success", **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"画布执行失败: {e}")

@router.post("/projects/{project_id}/canvas/execute")
async def execute_project_canvas(project_id: str, body: Dict[str, Any]):
    """兼容按项目维度执行（nodes/edges 在 body 或存储中）"""
    nodes = body.get("nodes")
    edges = body.get("edges")
    target_ids = body.get("target_ids")
    # 若未传则尝试从存储加载
    if not nodes or not edges:
        from app.providers.project.manager import project_manager
        snap = project_manager.get_canvas(project_id)
        if not snap:
            raise HTTPException(status_code=404, detail="画布快照不存在，请先保存")
        nodes = snap.get("nodes") or []
        edges = snap.get("edges") or []
    if not nodes:
        raise HTTPException(status_code=400, detail="画布节点为空")
    try:
        result = await canvas_engine.execute_dag(nodes, edges, project_id=project_id, target_ids=target_ids)
        return {"status":"success", "project_id": project_id, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"画布执行失败: {e}")
