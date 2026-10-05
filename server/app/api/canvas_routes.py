# -*- coding: utf-8 -*-
"""
Canvas API Routes - 画布 DAG 执行与动态技能调度
"""
import os
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.canvas.engine import canvas_engine, execute_node, collect_upstream_data
from app.core import pages

# 路由级守卫：创意画布（canvas）关闭时整族 404（运行期开关，路由始终挂载）
router = APIRouter(dependencies=[Depends(pages.require("canvas"))])

class CanvasExecuteRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    target_ids: Optional[List[str]] = None
    project_id: Optional[str] = None

class CanvasNodeExecuteRequest(BaseModel):
    node: Dict[str, Any]
    upstream: Optional[Dict[str, Any]] = None
    project_id: Optional[str] = None
    custom_data: Optional[Dict[str, Any]] = None

class CanvasSkillDispatchRequest(BaseModel):
    skill_id: str
    prompt: Optional[str] = ""
    node_id: Optional[str] = None
    provider_id: Optional[str] = None
    model: Optional[str] = None
    first_frame_url: Optional[str] = None
    last_frame_url: Optional[str] = None
    reference_images: Optional[List[str]] = None
    project_id: Optional[str] = None
    dynamic_inputs: Optional[Dict[str, Any]] = None

class CanvasAgentGenerateRequest(BaseModel):
    node_type: str  # image / video / audio
    idea: str
    provider_id: Optional[str] = ""   # 空=Agent 自动选源
    skill_id: Optional[str] = ""  # 用户在顶部选的 skill，Agent 将按此 skill 润色提示词
    slots: Optional[Dict[str, Any]] = None
    params: Optional[Dict[str, Any]] = None  # 用户在高级面板覆写的异构参数（如 aspect_ratio/resolution/steps 等）
    extra_hint: Optional[str] = ""
    node_id: Optional[str] = None
    project_id: Optional[str] = None


@router.post("/canvas/agent/generate")
async def canvas_agent_generate(req: CanvasAgentGenerateRequest):
    """
    节点 Agent 一体化执行：用户自然语言需求 → LLM 规划(选skill/选源/转prompt/组参数)
    → 调用 provider_* Tool(含异步轮询) → 返回 plan + 结果 URL。LLM 不可用时规则降级。
    """
    node_type = (req.node_type or "").lower()
    if node_type not in ("image", "video", "audio"):
        raise HTTPException(status_code=400, detail="node_type 需为 image/video/audio")
    if not (req.idea or "").strip():
        raise HTTPException(status_code=400, detail="idea 不能为空")
    from app.canvas.agent_plan import plan_node_agent
    from app.mcp.server import mcp_registry

    slots = req.slots or {}
    plan = await plan_node_agent(node_type, req.idea.strip(), (req.provider_id or "").strip(), slots, req.extra_hint or "", (req.skill_id or "").strip())
    # 透传 node_id/project_id 供任务表隔离与日志追踪（每个 node 独立异步任务）
    if req.node_id:
        plan["_node_id"] = req.node_id
    # 若用户显式选了 skill，以用户选择为准（Agent 仅负责润色提示词风格）
    if (req.skill_id or "").strip():
        plan["skill_id"] = (req.skill_id or "").strip()
    pid = plan.get("provider_id") or ""
    if not pid:
        raise HTTPException(status_code=500, detail=f"无可用 {node_type} 生成源，请先注册生成源")

    final_prompt = (plan.get("prompt") or req.idea).strip()
    args: Dict[str, Any] = {"prompt": final_prompt, "text": final_prompt}
    if req.node_id:
        args["_node_id"] = req.node_id
    if req.project_id:
        args["_project_id"] = req.project_id
    if plan.get("model"):
        args["model"] = plan["model"]
    # 插槽零映射：前端已按该源 input_schema 声明的键（归一键+源原始键）打包，这里原样透传给 provider Tool
    def _is_media_val(v: Any) -> bool:
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return False
            if s.startswith(("http://", "https://", "data:", "/storage", "storage", "/")):
                return True
            if os.path.isabs(s) or os.path.exists(s):
                return True
            low = s.lower()
            if any(low.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".avi", ".wav", ".mp3", ".flac", ".ogg")):
                return True
            return False
        if isinstance(v, list):
            return bool(v) and all(_is_media_val(x) for x in v)
        return False
    for k, v in slots.items():
        if v is None or v == "" or (isinstance(v, list) and len(v) == 0):
            continue
        if _is_media_val(v):
            args[k] = v
    # Agent 规划的参数为初值，用户在高级面板覆写的异构参数优先
    merged_params: Dict[str, Any] = {**(plan.get("params") or {})}
    if req.params:
        for k, v in req.params.items():
            if v not in (None, "", {}):
                merged_params[k] = v
    args.update({k: v for k, v in merged_params.items() if v not in (None, "", {})})
    # 同步回 plan 便于前端回显
    plan["params"] = merged_params
    plan["params_source"] = "user_override" if req.params else "agent"
    if node_type == "video":
        # mode 推断：有首/尾帧类媒体键 → i2v；有参考图 → r2v；否则 t2v（按值语义，不锁死键名）
        has_frame = any(_is_media_val(v) and ("frame" in k.lower()) for k, v in slots.items() if v)
        has_ref = any(_is_media_val(v) and ("reference" in k.lower() or "ref" in k.lower()) and "audio" not in k.lower() for k, v in slots.items() if v)
        args.setdefault("mode", "i2v" if has_frame else "r2v" if has_ref else "t2v")
    args = {k: v for k, v in args.items() if v not in (None, "", [])}

    res = await mcp_registry.execute_tool(f"provider_{pid}", args)
    if res.status != "success":
        return {"status": "error", "plan": {**plan, "final_args": args}, "error": res.error or "生成失败"}
    # 视频异步 task 兜底：非代码（JSON 模板）模式已删除，代码源由后台 TaskCenter 轮询接管，
    # 前端统一经 /videos/status 轮询，这里不再阻塞等待。
    result = res.result or {}
    return {"status": "success", "plan": {**plan, "final_args": args}, "result": result, "elapsed_ms": res.execution_time_ms}


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
        return {"status": "success", **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"画布执行失败: {e}")


@router.post("/canvas/node/execute")
async def execute_canvas_single_node(req: CanvasNodeExecuteRequest):
    """
    单节点独立执行接口（带动态参数注入与上游数据）
    """
    try:
        node = dict(req.node)
        if req.custom_data:
            node_data = dict(node.get("data") or {})
            node_data.update(req.custom_data)
            node["data"] = node_data
        upstream = dict(req.upstream or {})
        from app.extensions import guard
        _tok = guard.set_project_context(req.project_id) if req.project_id else None
        try:
            result = await execute_node(node, upstream, project_id=req.project_id)
        finally:
            if _tok is not None:
                guard.reset_project_context(_tok)
        return {"status": "success", "node_id": node.get("id"), "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"节点执行失败: {e}")


@router.post("/canvas/dispatch-skill")
async def dispatch_canvas_skill(req: CanvasSkillDispatchRequest):
    """
    技能与动态 Provider 调度入口
    """
    from app.mcp.server import mcp_registry
    res = await mcp_registry.execute_tool("canvas_dispatch_skill", {
        "skill_id": req.skill_id,
        "prompt": req.prompt,
        "node_id": req.node_id,
        "first_frame_url": req.first_frame_url,
        "last_frame_url": req.last_frame_url,
        "reference_images": req.reference_images,
        "project_id": req.project_id,
    })
    if res.status == "success":
        return {"status": "success", **res.result}
    else:
        raise HTTPException(status_code=500, detail=res.error or "技能调度失败")


@router.get("/canvas/assets")
async def query_canvas_assets(project_id: Optional[str] = Query(None)):
    """
    查询画布已生成的资产池
    """
    from app.mcp.server import mcp_registry
    res = await mcp_registry.execute_tool("canvas_query_assets", {"project_id": project_id})
    if res.status == "success":
        return res.result
    return {"assets": [], "total_assets": 0}


@router.post("/projects/{project_id}/canvas/execute")
async def execute_project_canvas(project_id: str, body: Dict[str, Any]):
    """兼容按项目维度执行（nodes/edges 在 body 或存储中）"""
    nodes = body.get("nodes")
    edges = body.get("edges")
    target_ids = body.get("target_ids")
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
        return {"status": "success", "project_id": project_id, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"画布执行失败: {e}")
