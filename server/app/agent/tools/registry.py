# -*- coding: utf-8 -*-
"""工具注册视图 — MCP 注册表 → 模型 tool schema 的唯一转换点。

- schema 数组按注册表内容哈希缓存，避免每次 run 重建（旧实现每次都造 pydantic 模型）。
- PLAN_READONLY_TOOLS 白名单硬门控（与 planner 同源）。
"""
import hashlib
import json
from typing import Any, Dict, List, Optional, Set

# 计划模式只读白名单（硬门控；与 app.agent.planner.PLAN_READONLY_TOOLS 同源）
PLAN_READONLY_TOOLS: Set[str] = {
    "search_tools",
    "canvas_query", "canvas_query_assets",
    "list_assets", "get_asset",
    "list_image_providers", "list_video_providers", "list_voice_providers",
    "list_voices", "list_comfyui_workflows", "list_custom_providers",
    "get_provider_code",
    "director_3d_stage_plan",
    "split_novel_script",
    "creator_inspect_runtime",
    "list_custom_nodes",
    "todo_write",
    "job_list", "job_status",
    "task_status",
}

# 每个工具的执行超时（秒）；未列出的用 default。视频类生成较慢。
_DEFAULT_TIMEOUT_S = 900
_VIDEO_TIMEOUT_S = 1800
_TOOL_TIMEOUTS: Dict[str, int] = {
    "generate_video": _VIDEO_TIMEOUT_S,
    "export_jianyin_draft": 600,
    "shell_exec": 1200,
    "split_novel_script": 300,
    "comfyui_render_node": 1500,
}


# 内置工具（不来自 MCP：由 runtime 直接处理）
_TODO_TOOL_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "todo_write",
        "description": "写入/更新当前任务清单（整表快照，last-write-wins）。用于多步骤制作任务跟踪进度：每次提交完整清单。",
        "parameters": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "description": "任务内容"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                        },
                        "required": ["content", "status"],
                    },
                },
            },
            "required": ["items"],
        },
    },
}

INTERNAL_TOOL_NAMES = {"todo_write", "job_start", "job_list", "job_status", "job_cancel",
                       "subagent_run", "batch_run", "task_status", "task_wait", "task_cancel"}


def _internal_schema(name: str, desc: str, props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props, "required": required},
    }}


_JOB_START_SCHEMA = _internal_schema(
    "job_start",
    "把长耗时工具调用提交为后台任务，立即返回 job_id（适合并行多任务/批量）；单次视频生成默认已阻塞返回，无需后台化。完成后会自动通知。",
    {"tool": {"type": "string", "description": "要执行的工具名（如 generate_video / provider_xxx / batch_run）"},
     "arguments": {"type": "object", "description": "该工具的完整参数"}},
    ["tool"],
)
_JOB_LIST_SCHEMA = _internal_schema("job_list", "列出当前会话的后台任务及状态。", {}, [])
_JOB_STATUS_SCHEMA = _internal_schema("job_status", "查询单个后台任务的详细结果。",
                                      {"job_id": {"type": "string"}}, ["job_id"])
_JOB_CANCEL_SCHEMA = _internal_schema("job_cancel", "取消一个运行中的后台任务。",
                                      {"job_id": {"type": "string"}}, ["job_id"])
_SUBAGENT_SCHEMA = _internal_schema(
    "subagent_run",
    "委派一个独立子任务给子代理（新上下文，只回最终结果）。适合资料侦察、多方案分析；不支持嵌套委派。",
    {"task": {"type": "string", "description": "清晰、自包含的子任务描述"},
     "max_steps": {"type": "integer", "description": "子代理最大步数，默认 40"}},
    ["task"],
)
_BATCH_SCHEMA = _internal_schema(
    "batch_run",
    "同一工具的参数矩阵批量执行（如 20 个镜头批量生图）。只回传每条状态与产物；条目多时并发受控。",
    {"tool": {"type": "string", "description": "要批量执行的工具名"},
     "items": {"type": "array", "items": {"type": "object"}, "description": "参数对象数组，每项即一次工具调用参数"},
     "concurrency": {"type": "integer", "description": "并发数（默认 3，最大 8）"}},
    ["tool", "items"],
)
_TASK_STATUS_SCHEMA = _internal_schema(
    "task_status",
    "查询异步生成任务（视频等）的状态与结果：排队/生成中/成功（含 video_url）/失败原因。",
    {"task_id": {"type": "string", "description": "任务ID（provider 工具或 job 返回的 task_id）"}},
    ["task_id"],
)
_TASK_WAIT_SCHEMA = _internal_schema(
    "task_wait",
    "等待异步生成任务完成并返回成片结果（默认最多等待 20 分钟）。仅当工具提示“仍在生成中”需要续等时使用。",
    {"task_id": {"type": "string"},
     "timeout_s": {"type": "integer", "description": "本次等待上限秒数，默认 1200"}},
    ["task_id"],
)
_TASK_CANCEL_SCHEMA = _internal_schema("task_cancel", "取消一个还在生成中的异步任务。",
                                       {"task_id": {"type": "string"}}, ["task_id"])


def tool_timeout(name: str) -> int:
    import os
    if name in _TOOL_TIMEOUTS:
        return _TOOL_TIMEOUTS[name]
    if name.startswith("provider_"):
        return _VIDEO_TIMEOUT_S
    try:
        return int(os.environ.get("AGENT_TOOL_TIMEOUT_S") or _DEFAULT_TIMEOUT_S)
    except Exception:
        return _DEFAULT_TIMEOUT_S


class ToolRegistryView:
    """对 mcp_registry 的只读视图 + 缓存。"""

    def __init__(self):
        self._schema_cache: Optional[List[Dict[str, Any]]] = None
        self._schema_key: str = ""

    def _registry(self):
        from app.mcp.server import mcp_registry
        return mcp_registry

    def _fingerprint(self) -> str:
        try:
            names = sorted(t.name for t in self._registry().get_all_tools() if getattr(t, "is_enabled", True))
        except Exception:
            names = []
        h = hashlib.md5(("|".join(names)).encode("utf-8")).hexdigest()
        return f"{len(names)}:{h}"

    def schemas(self, plan_mode: bool = False) -> List[Dict[str, Any]]:
        key = self._fingerprint() + ("|plan" if plan_mode else "")
        if self._schema_cache is not None and self._schema_key == key:
            return self._schema_cache
        out: List[Dict[str, Any]] = []
        try:
            for t in self._registry().get_all_tools():
                if not getattr(t, "is_enabled", True):
                    continue
                if plan_mode and t.name not in PLAN_READONLY_TOOLS:
                    continue
                schema = t.input_schema if isinstance(t.input_schema, dict) else {"type": "object", "properties": {}}
                schema = dict(schema)
                schema.setdefault("type", "object")
                schema.setdefault("properties", {})
                out.append({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": (t.description or "")[:1024],
                        "parameters": schema,
                    },
                })
        except Exception as e:
            print(f"[RuntimeTools] schemas failed: {e}")
        internal = [_TODO_TOOL_SCHEMA]
        if plan_mode:
            internal += [_JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _TASK_STATUS_SCHEMA]
        else:
            internal += [_JOB_START_SCHEMA, _JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _JOB_CANCEL_SCHEMA,
                         _SUBAGENT_SCHEMA, _BATCH_SCHEMA,
                         _TASK_STATUS_SCHEMA, _TASK_WAIT_SCHEMA, _TASK_CANCEL_SCHEMA]
        out.extend(internal)
        self._schema_cache = out
        self._schema_key = key
        return out

    def names(self) -> List[str]:
        try:
            return [t.name for t in self._registry().get_all_tools()]
        except Exception:
            return []

    def get(self, name: str):
        try:
            return self._registry().tools.get(name)
        except Exception:
            return None

    def provider_brief(self, limit: int = 40) -> str:
        """动态 provider_* 工具速览（基础/高级分组），替代旧 90 行硬编码简介。"""
        lines: List[str] = []
        try:
            for t in self._registry().get_all_tools():
                if not t.name.startswith("provider_"):
                    continue
                props = ((t.input_schema or {}).get("properties") or {})
                basic, adv = [], []
                for k, v in props.items():
                    if not isinstance(v, dict):
                        continue
                    if v.get("format") == "uri" or v.get("x-handle") in ("image", "audio", "video"):
                        continue
                    if k in ("prompt", "text"):
                        continue
                    if v.get("x-visibility") == "basic":
                        basic.append(k)
                    elif v.get("x-visibility") == "hidden":
                        continue
                    else:
                        adv.append(k)
                slots = [k for k, v in props.items() if isinstance(v, dict) and (
                    v.get("format") == "uri" or v.get("x-handle") in ("image", "audio", "video"))]
                desc = str(t.description or "")[:80].replace("\n", " ")
                lines.append(f"- {t.name} — {desc} | 插槽:{','.join(slots) or '无'} | 基础:{','.join(basic) or '无'} 高级:{','.join(adv) or '无'}")
                if len(lines) >= limit:
                    break
        except Exception as e:
            print(f"[RuntimeTools] provider_brief failed: {e}")
        return "\n".join(lines)


tool_view = ToolRegistryView()
