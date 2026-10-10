# -*- coding: utf-8 -*-
"""自定义节点 HTTP API — 列表 / 详情 / 单次执行 / 代码模板。

节点创作统一走插件包（custom_nodes/*.json，随包安装启用）；
本路由仅读与执行，不设独立增删改。
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core import features, pages
from app.custom_nodes.manager import custom_node_manager, run_custom_node
from app.custom_nodes.models import CustomNodeDefinition, PY_RUN_TEMPLATE, JS_RUN_TEMPLATE

# 路由级守卫：创意画布（canvas）关闭时整族 404（运行期开关，路由始终挂载）。
# ⚠️ 路由级守卫**必须保持唯一**（tests/test_pages.py::TestRouteGuardOwnership 会断言
# `len(router.dependencies) == 1`），所以页内能力闸放在**端点级**（见下方 `_feature_guard`），
# 不放这里：一个族只有一个「页面级」准入，页内能力是族内部某几个端点的附加条件。
router = APIRouter(dependencies=[Depends(pages.require("canvas"))])


def _feature_guard() -> List[Depends]:
    """页内能力闸：自定义代码节点被单独关掉（设置 → 功能开关）时，本族的端点各自 404。

    与「画布开着但不要自定义代码节点」这条口径一致（设计 §2.3.2）；
    每次返回新列表，避免同一批 Depends 实例被多条路由共用。
    """
    return [Depends(features.require("canvas_custom_nodes"))]


class CustomNodeRunRequest(BaseModel):
    model_config = {"extra": "allow"}
    custom_node_id: str = ""
    inputs: Dict[str, Any] = {}
    params: Dict[str, Any] = {}
    project_id: Optional[str] = None


def _to_info(d: CustomNodeDefinition) -> Dict[str, Any]:
    info = d.model_dump()
    info["has_code"] = bool(d.code)
    return info


@router.get("/custom-nodes", dependencies=_feature_guard())
async def list_custom_nodes(kind: Optional[str] = None):
    nodes = custom_node_manager.list_nodes(kind=kind)
    try:
        from app.mcp.server import mcp_registry
        tool_names = {t.name for t in mcp_registry.get_all_tools()}
    except Exception:
        tool_names = set()
    out = []
    for n in nodes:
        info = _to_info(n)
        info["mcp_tool"] = f"customnode_{n.id}" if f"customnode_{n.id}" in tool_names else None
        out.append(info)
    return {"nodes": out, "total": len(out)}


@router.get("/custom-nodes/templates", dependencies=_feature_guard())
async def custom_node_templates():
    return {
        "python": PY_RUN_TEMPLATE,
        "javascript": JS_RUN_TEMPLATE,
        "contract": "async def run(inputs, params, ctx) -> dict；返回 image_url/video_url/audio_url/text",
    }


@router.get("/custom-nodes/{nid}", dependencies=_feature_guard())
async def get_custom_node(nid: str):
    d = custom_node_manager.get(nid)
    if not d:
        raise HTTPException(status_code=404, detail=f"自定义节点不存在: {nid}")
    return {"node": _to_info(d)}


@router.post("/custom-nodes/run", dependencies=_feature_guard())
async def run_custom_node_once(req: CustomNodeRunRequest):
    """单次执行（节点内按钮/测试）：收集好的 inputs + params 直调。"""
    d = custom_node_manager.get(req.custom_node_id)
    if not d:
        raise HTTPException(status_code=404, detail=f"自定义节点不存在: {req.custom_node_id}")
    if not d.enabled:
        raise HTTPException(status_code=400, detail="该节点已禁用")
    try:
        result = await run_custom_node(d, req.inputs or {}, req.params or {}, {"project_id": req.project_id})
        if not isinstance(result, dict):
            raise ValueError("节点代码须返回dict")
        return {"status": "success", "custom_node_id": d.id, "kind": d.kind, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"自定义节点执行失败: {e}")
