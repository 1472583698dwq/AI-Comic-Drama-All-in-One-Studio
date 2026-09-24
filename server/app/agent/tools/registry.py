# -*- coding: utf-8 -*-
"""工具注册视图 — MCP 注册表 → 模型 tool schema 的唯一转换点。

- schema 数组按注册表内容哈希缓存，避免每次 run 重建（旧实现每次都造 pydantic 模型）。
- plan 模式的只读白名单来自 app.agent.mode_policy（单一来源，代码硬门控）。
"""
import hashlib
import json
from typing import Any, Dict, List, Optional

from app.agent.mode_policy import PLAN_READONLY_TOOLS  # noqa: F401  (对外保持同名导出)

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
                       "subagent_run", "subagent_wait", "subagent_list", "subagent_status", "subagent_cancel", "subagent_steer",
                       "batch_run", "task_status", "task_wait", "task_cancel"}


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
    "委派子任务给专家子代理（独立上下文，只回最终结果）。默认同步阻塞直到结果返回；background=true 立即返回句柄（完成自动通知，"
    "关键节点用 subagent_wait 阻塞等待）。同质任务用 batch 数组一次扇出并行。"
    "可用角色：generalist/screenwriter/character_designer/storyboard_artist/video_operator/voice_operator/editor/qa_reviewer。",
    {"agent": {"type": "string", "description": "专家角色名（默认 generalist=全工具通用）"},
     "task": {"type": "string", "description": "清晰、自包含的子任务描述（带上全部必要上下文，如 draft_id/镜头号）"},
     "background": {"type": "boolean", "description": "缺省=按角色默认（多数同步阻塞）；true=后台执行立即返回；false=强制同步阻塞"},
     "batch": {"type": "array", "items": {"type": "object"},
               "description": "同质任务批量扇出：[{task, context?}, ...]，并行执行并汇总（与 task 二选一）"},
     "max_steps": {"type": "integer", "description": "子代理最大步数（默认按角色画像）"},
     "timeout_s": {"type": "integer", "description": "子代理超时秒数（默认 600）"}},
    ["agent"],
)
_SUBAGENT_WAIT_SCHEMA = _internal_schema(
    "subagent_wait",
    "阻塞等待子代理（或整批）完成并回收结果——用于后台提交后的同步收口（如导出前等全部视频完成）。"
    "已结束的立即返回；超时仅返回快照，不取消任务。",
    {"subagent_id": {"type": "string", "description": "等待单个子代理（与 batch_id 二选一）"},
     "batch_id": {"type": "string", "description": "等待一个批次的全部子代理"},
     "timeout_s": {"type": "integer", "description": "等待上限秒数（默认 1800）"}},
    [])
_SUBAGENT_LIST_SCHEMA = _internal_schema(
    "subagent_list",
    "列出本会话的子代理（角色/任务/状态/耗时），用于跟踪并行集群进度。",
    {"limit": {"type": "integer", "description": "最多返回条数，默认 50"}}, [])
_SUBAGENT_STATUS_SCHEMA = _internal_schema(
    "subagent_status",
    "查询单个子代理的状态与结果（后台子代理完成后用此读取结果）。",
    {"subagent_id": {"type": "string"}}, ["subagent_id"])
_SUBAGENT_CANCEL_SCHEMA = _internal_schema(
    "subagent_cancel",
    "取消一个运行中的子代理（其内部工具调用一并中止）。",
    {"subagent_id": {"type": "string"}}, ["subagent_id"])
_SUBAGENT_STEER_SCHEMA = _internal_schema(
    "subagent_steer",
    "给运行中的子代理插话纠偏（进入其当前轮的下一步）。",
    {"subagent_id": {"type": "string"}, "text": {"type": "string"}}, ["subagent_id", "text"])

# ── 一键成片原子工具（导演/专家子代理共用；draft_id 由 onekey 任务创建）──
_ONEKEY_SPLIT_SCHEMA = _internal_schema(
    "onekey_split",
    "[一键成片] 把草稿的小说文本拆解为角色与分镜脚本（Stage1）。返回角色清单与分镜概要。",
    {"draft_id": {"type": "string"}}, ["draft_id"])
_ONEKEY_ROLE_SCHEMA = _internal_schema(
    "onekey_role_image",
    "[一键成片] 为草稿中的单个角色生成三视图正面定妆图并写回（Stage2）。",
    {"draft_id": {"type": "string"}, "character": {"type": "string", "description": "角色名"}},
    ["draft_id", "character"])
_ONEKEY_SHOT_IMAGE_SCHEMA = _internal_schema(
    "onekey_shot_image",
    "[一键成片] 为指定分镜生成画面（自动装配角色参考图与运镜提示）并写回（Stage3）。",
    {"draft_id": {"type": "string"}, "shot_index": {"type": "integer"},
     "prompt_override": {"type": "string", "description": "可选：替换该镜生图提示词"}},
    ["draft_id", "shot_index"])
_ONEKEY_SHOT_VIDEO_SCHEMA = _internal_schema(
    "onekey_shot_video",
    "[一键成片] 为已有画面的分镜做图生视频（首帧+角色参考+运镜）并写回（Stage4）。返回 video_url 或异步 task_id。",
    {"draft_id": {"type": "string"}, "shot_index": {"type": "integer"}},
    ["draft_id", "shot_index"])
_ONEKEY_SHOT_VOICE_SCHEMA = _internal_schema(
    "onekey_shot_voice",
    "[一键成片] 为指定分镜的台词/旁白生成配音并写回（Stage5）。",
    {"draft_id": {"type": "string"}, "shot_index": {"type": "integer"}},
    ["draft_id", "shot_index"])
_ONEKEY_EXPORT_SCHEMA = _internal_schema(
    "onekey_export",
    "[一键成片] 把草稿导出为剪映工程草稿（Stage6）。",
    {"draft_id": {"type": "string"}}, ["draft_id"])
_ONEKEY_SUMMARY_SCHEMA = _internal_schema(
    "onekey_summary",
    "[一键成片] 查询草稿进度：各镜产图/视频/配音完成与缺失清单（只读，用于调度与质检）。",
    {"draft_id": {"type": "string"}}, ["draft_id"])
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
            internal += [_JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _TASK_STATUS_SCHEMA,
                         _SUBAGENT_LIST_SCHEMA, _SUBAGENT_STATUS_SCHEMA, _ONEKEY_SUMMARY_SCHEMA]
        else:
            internal += [_JOB_START_SCHEMA, _JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _JOB_CANCEL_SCHEMA,
                         _SUBAGENT_SCHEMA, _SUBAGENT_WAIT_SCHEMA, _SUBAGENT_LIST_SCHEMA, _SUBAGENT_STATUS_SCHEMA,
                         _SUBAGENT_CANCEL_SCHEMA, _SUBAGENT_STEER_SCHEMA,
                         _BATCH_SCHEMA,
                         _TASK_STATUS_SCHEMA, _TASK_WAIT_SCHEMA, _TASK_CANCEL_SCHEMA,
                         _ONEKEY_SPLIT_SCHEMA, _ONEKEY_ROLE_SCHEMA, _ONEKEY_SHOT_IMAGE_SCHEMA,
                         _ONEKEY_SHOT_VIDEO_SCHEMA, _ONEKEY_SHOT_VOICE_SCHEMA,
                         _ONEKEY_EXPORT_SCHEMA, _ONEKEY_SUMMARY_SCHEMA]
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
