# -*- coding: utf-8 -*-
"""声明式画布节点管理器 — 文件即仓库：storage/canvas_nodes/<id>.json

职责：
- CRUD（插件贡献与裸件统一落此处，插件禁用时按追踪 id 精确回滚）；
- `build_run_args`：按声明把输入/参数/静态参数/显式 map 装配为扩展执行参数；
- `run_canvas_node`：guard 审计 → 统一执行口 → 输出端口映射 → 视频任务阻塞到终态。

执行入口与画布引擎（canvas/engine.py ext-node 分支）共用同一实现，保证
「单节点运行」与「DAG 运行」结果口径一致。
"""
import json
import os
import time
from typing import Any, Dict, List, Optional

from app.canvas_nodes.models import CanvasNodeSpec

_ROOT_NAME = "canvas_nodes"


def _root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, _ROOT_NAME)
    os.makedirs(root, exist_ok=True)
    return root


def _path(nid: str) -> str:
    return os.path.join(_root(), f"{nid}.json")


class CanvasNodeManager:
    def list_nodes(self) -> List[CanvasNodeSpec]:
        out: List[CanvasNodeSpec] = []
        try:
            for fn in sorted(os.listdir(_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_root(), fn), "r", encoding="utf-8") as f:
                        out.append(CanvasNodeSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out

    def get(self, nid: str) -> Optional[CanvasNodeSpec]:
        try:
            with open(_path(nid), "r", encoding="utf-8") as f:
                return CanvasNodeSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save(self, spec: CanvasNodeSpec) -> CanvasNodeSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        tmp = _path(spec.id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(spec.model_dump(by_alias=True), f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(spec.id))
        return spec

    def delete(self, nid: str) -> bool:
        try:
            if os.path.isfile(_path(nid)):
                os.remove(_path(nid))
                return True
        except Exception:
            pass
        return False


canvas_node_manager = CanvasNodeManager()


def _is_ext_disabled(nid: str, disabled_ids: set) -> bool:
    """扩展中心停用集匹配：兼容 `canvas_node:<id>` 与 `canvas_node:<publisher>/<id>`。"""
    if not disabled_ids:
        return False
    if f"canvas_node:{nid}" in disabled_ids:
        return True
    return any(i.startswith("canvas_node:") and i.endswith(f"/{nid}")
               for i in disabled_ids)


def list_effective_nodes(project_id: str = "", include_disabled: bool = False) -> List[CanvasNodeSpec]:
    """运行时有效节点列表（默认过滤扩展中心停用项；管理面可 include_disabled）。"""
    nodes = canvas_node_manager.list_nodes()
    if include_disabled:
        return nodes
    try:
        from app.extensions import state
        disabled = state.effective_disabled(project_id or "")
    except Exception:
        disabled = set()
    return [n for n in nodes if not _is_ext_disabled(n.id, disabled)]


def build_run_args(spec: CanvasNodeSpec,
                   inputs: Optional[Dict[str, Any]] = None,
                   params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """装配扩展执行参数：静态 args → 同名输入/参数 → 显式 map（后者优先）。"""
    inputs = dict(inputs or {})
    params = dict(params or {})
    args: Dict[str, Any] = {}

    for k, v in (spec.run.args or {}).items():
        if v not in (None, ""):
            args[k] = v
    # 同名默认映射：声明端口/未显式 map 的参数可直接透传
    for port in spec.inputs:
        v = inputs.get(port.id)
        if v not in (None, "", []):
            args[port.id] = v
    for k, v in params.items():
        if v not in (None, "", []) and k not in (spec.run.map or {}):
            args[k] = v
    # 显式装配（支持 $in.<端口> / $param.<键> / 字面量）
    for target, expr in (spec.run.map or {}).items():
        raw = str(expr or "")
        if raw.startswith("$in."):
            v = inputs.get(raw[4:])
        elif raw.startswith("$param."):
            v = params.get(raw[7:])
        else:
            v = raw
        if v not in (None, "", []):
            args[target] = v
    return args


def _map_outputs(spec: CanvasNodeSpec, result: Dict[str, Any]) -> Dict[str, Any]:
    outputs: Dict[str, Any] = {}
    for port in spec.outputs:
        key = port.from_key or port.id
        if key in result and result.get(key) not in (None, ""):
            outputs[port.id] = result.get(key)
    return outputs


async def run_canvas_node(spec: CanvasNodeSpec,
                          inputs: Optional[Dict[str, Any]] = None,
                          params: Optional[Dict[str, Any]] = None,
                          project_id: Optional[str] = None) -> Dict[str, Any]:
    """执行声明式节点：返回 `{status, canvas_node_id, outputs, ...原始结果}`。"""
    from app.extensions import guard
    guard.ensure_enabled("canvas_node", spec.id, project_id)

    args = build_run_args(spec, inputs, params)
    from app.extensions.registry import extension_registry
    result = await extension_registry.execute(
        spec.run.extension, args=args,
        entry=(spec.run.entry or "generate"), scope=(project_id or ""))
    if not isinstance(result, dict):
        result = {"result": result}

    out: Dict[str, Any] = {
        "status": "success",
        "canvas_node_id": spec.id,
        "extension": spec.run.extension,
    }
    out.update({k: v for k, v in result.items()
                if k not in ("status", "extension", "elapsed_ms", "outputs")})
    out["outputs"] = _map_outputs(spec, result)

    # 视频异步任务：仅返回 task_id 时经 TaskCenter 阻塞到终态（与画布视频节点同口径）
    if out.get("task_id") and not out.get("video_url"):
        try:
            from app.providers.tasks import task_center
            task_center.register(str(out["task_id"]), str(out.get("provider") or ""), "video")
            rec = await task_center.wait(str(out["task_id"]))
            if getattr(rec, "status", "") == "SUCCESS" and getattr(rec, "video_url", None):
                out["video_url"] = rec.video_url
                out["outputs"] = _map_outputs(spec, out)
            elif getattr(rec, "status", "") == "FAILED":
                return {"status": "error", "error": getattr(rec, "error", "") or "视频任务失败",
                        "canvas_node_id": spec.id}
        except Exception as e:
            out["note"] = f"视频任务仍在生成中（task_id={out.get('task_id')}）：{e}"
    return out
