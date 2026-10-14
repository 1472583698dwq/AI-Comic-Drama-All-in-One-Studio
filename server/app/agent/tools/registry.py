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
    # 拆解=大 JSON LLM 生成（角色+场景+逐镜），慢在模型侧；300s 会把长文本拆解中途掐死
    "split_novel_script": 900,
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

INTERNAL_TOOL_NAMES = {"todo_write", "view_media", "job_start", "job_list", "job_status", "job_cancel",
                       "subagent_run", "subagent_wait", "subagent_list", "subagent_status", "subagent_cancel", "subagent_steer",
                       "batch_run", "task_status", "task_wait", "task_cancel",
                       "onekey_split", "onekey_style_lock", "onekey_scene_image", "onekey_role_image", "onekey_shot_image",
                       "onekey_shot_video", "onekey_shot_voice", "onekey_export", "onekey_summary", "onekey_review"}


def _internal_schema(name: str, desc: str, props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props, "required": required},
    }}


# 媒体查看（只读）：把画布节点产物 / 素材库资源 / URL 作为多模态附件交给模型"亲眼看"
_VIEW_MEDIA_SCHEMA = _internal_schema(
    "view_media",
    "查看图片/视频/音频的实际内容（多模态）：把画布节点产物、素材库资源或 URL 作为附件加载后，"
    "你就能直接看到画面（图片）或拿到媒体引用（视频/音频）。改图、参考图、质检成片前先看再动手。",
    {"node_id": {"type": "string", "description": "画布节点 id（自动取其 image_url/video_url/audio_url/首尾帧/参考图）"},
     "node_ids": {"type": "array", "items": {"type": "string"}, "description": "一次查看多个画布节点"},
     "asset_id": {"type": "string", "description": "素材库资源 id"},
     "url": {"type": "string", "description": "直接给媒体 URL（/storage/... 或 http(s)）"},
     "kind": {"type": "string", "enum": ["image", "video", "audio"], "description": "可选：指定媒体类型"},
     "project_id": {"type": "string", "description": "画布归属项目（不传用上下文项目）"}},
    [],
)


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
    "关键节点用 subagent_wait 阻塞等待）。同质任务用 batch 数组一次扇出并行。",
    {"agent": {"type": "string", "description": "专家角色名（默认 generalist=全工具通用）"},
     "task": {"type": "string", "description": "清晰、自包含的子任务描述（带上全部必要上下文，如 draft_id/镜头号）"},
     "context": {"type": "object", "description": "随任务下发的上下文键值对（如 {\"draft_id\": \"ok_xxx\"}），会注入子代理提示词，子代理无需再传"},
     "background": {"type": "boolean", "description": "缺省=按角色默认（多数同步阻塞）；true=后台执行立即返回；false=强制同步阻塞"},
     "batch": {"type": "array", "items": {"type": "object"},
               "description": "同质任务批量扇出：[{task, context?}, ...]，并行执行并汇总（与 task 二选一）"},
     "max_steps": {"type": "integer", "description": "子代理最大步数（默认按角色画像）"},
     "timeout_s": {"type": "integer", "description": "子代理超时秒数（默认 1200；长任务显式调大）"}},
    ["agent"],
)


def _subagent_schema_dynamic() -> Dict[str, Any]:
    """动态角色名单：内置 + 外部导演组扩展（storage/agent_profiles + 插件贡献）。"""
    roles = "generalist/screenwriter/scene_designer/character_designer/storyboard_artist/video_operator/voice_operator/editor/qa_reviewer"
    extra = ""
    try:
        from app.agent.runtime.agents import list_profiles
        builtin = "generalist/screenwriter/scene_designer/character_designer/storyboard_artist/video_operator/voice_operator/editor/qa_reviewer"
        custom = [p.name for p in list_profiles() if p.name not in builtin.split("/")]
        if custom:
            extra = "；自定义导演组角色：" + "/".join(custom)
    except Exception:
        pass
    schema = dict(_SUBAGENT_SCHEMA)
    fn = dict(_SUBAGENT_SCHEMA["function"])
    fn["description"] = f"{fn['description']}可用角色：{roles}{extra}。"
    schema["function"] = fn
    return schema

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
_ONEKEY_STYLE_LOCK_SCHEMA = _internal_schema(
    "onekey_style_lock",
    "[一键成片] 用大模型生成本片统一风格规范（画风/线条/色彩/光影/镜头语言）。之后所有生图/生视频会自动附加该规范；"
    "这是保证全片资产风格一致的关键步骤。已有规范则直接复用，force=true 可重写。",
    {"draft_id": {"type": "string"},
     "force": {"type": "boolean", "description": "已有规范时也强制重新生成（默认 false）"}},
    ["draft_id"])
_ONEKEY_SCENE_SCHEMA = _internal_schema(
    "onekey_scene_image",
    "[一键成片] 场景资产：为该场景生成无人的空镜参考图（含关键道具，自动附加全片风格规范）。"
    "分镜生图/生视频会自动把场景参考图连同角色多视图一起装配成多参考，保证跨镜空间一致。已有则直接复用。",
    {"draft_id": {"type": "string"}, "scene_index": {"type": "integer", "description": "场景号（onekey_split 返回的 scenes[].scene_index）"},
     "force": {"type": "boolean", "description": "已有场景参考也强制重生成（默认 false=复用）"}},
    ["draft_id", "scene_index"])
_ONEKEY_ROLE_SCHEMA = _internal_schema(
    "onekey_role_image",
    "[一键成片] 角色资产：已有三视图/形象直接复用（不重复定妆）；缺失时才生成角色表（正面+侧面+3/4 三视图同图，"
    "自动附加全片风格规范并写回角色资产，供后续多参考生成）。",
    {"draft_id": {"type": "string"}, "character": {"type": "string", "description": "角色名"},
     "force": {"type": "boolean", "description": "已有资产也强制重做定妆（默认 false=直接复用）"}},
    ["draft_id", "character"])
_ONEKEY_SHOT_IMAGE_SCHEMA = _internal_schema(
    "onekey_shot_image",
    "[一键成片] 为指定分镜生成关键帧画面（**可选，默认流程不用**：默认直接把资产参考生视频）。"
    "自动装配该镜出场角色的多个视图参考图与运镜/风格规范并写回。",
    {"draft_id": {"type": "string"}, "shot_index": {"type": "integer"},
     "prompt_override": {"type": "string", "description": "可选：替换该镜生图提示词"}},
    ["draft_id", "shot_index"])
_ONEKEY_SHOT_VIDEO_SCHEMA = _internal_schema(
    "onekey_shot_video",
    "[一键成片] 为分镜生成视频：该镜有画面→首帧 i2v + 参考；无画面→直接用角色多视图 + 场景参考生成（r2v，默认流程）。"
    "写/改视频提示词前先 read_skill('minimax-h3-prompt')（H3 三字段结构/对齐行/运镜规则），成稿用 prompt_override 传入。"
    "返回 video_url 或异步 task_id。",
    {"draft_id": {"type": "string"}, "shot_index": {"type": "integer"},
     "prompt_override": {"type": "string",
                         "description": "可选：Agent 自写/改写后的视频提示词（建议按 minimax-h3-prompt 技能结构；原样使用，不再自动拼后缀）"}},
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
    "[一键成片] 草稿进度速览（角色/场景/分镜/视频/配音/导出计数 + 告警），供编排者调度用。",
    {"draft_id": {"type": "string"}}, ["draft_id"])
_ONEKEY_REVIEW_SCHEMA = _internal_schema(
    "onekey_review",
    "[一键成片] 产物验收清单（**生成后必做检查**）：列出角色/场景/分镜产物的 URL、验收要点（requirement/criteria）"
    "与对比参考图 refs。配合 view_media 逐项观看判定 pass/fail（视频自动抽帧成图片），不合格调整 prompt 重做，"
    "并把验收结果纳入总结。",
    {"draft_id": {"type": "string"},
     "scope": {"type": "string", "enum": ["all", "characters", "scenes", "shots"],
               "description": "验收范围（默认 all）"},
     "limit": {"type": "integer", "description": "最多返回条目（默认 10，≤30；抽检用）"}},
    ["draft_id"])
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


def _feature_on(fid: str) -> bool:
    """功能开关判断（懒导入，异常视为关闭：宁可少给工具，不炸工具清单）。"""
    try:
        from app.core import features
        return features.is_enabled(fid)
    except Exception:
        return False


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
        extra = ""
        try:
            from app.agent.runtime.agents import refresh_external_profiles
            refresh_external_profiles()
            from app.agent_teams.manager import signature as _team_sig
            extra = _team_sig()
        except Exception:
            extra = ""
        h = hashlib.md5(("|".join(names) + "||" + extra).encode("utf-8")).hexdigest()
        return f"{len(names)}:{h}"

    def schemas(self, plan_mode: bool = False) -> List[Dict[str, Any]]:
        # 功能开关（多模态）进缓存键：运行期开关变化必须立刻重建清单，不吃旧缓存
        multimodal = _feature_on("agent_multimodal")
        key = (self._fingerprint() + ("|plan" if plan_mode else "")
               + ("|mm" if multimodal else "|nomm"))
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
        if multimodal:
            # 多模态功能关闭 → view_media 不出现在工具清单（提示词里的说明仍是无害的软描述）
            internal.append(_VIEW_MEDIA_SCHEMA)
        if plan_mode:
            internal += [_JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _TASK_STATUS_SCHEMA,
                         _SUBAGENT_LIST_SCHEMA, _SUBAGENT_STATUS_SCHEMA,
                         _ONEKEY_SUMMARY_SCHEMA, _ONEKEY_REVIEW_SCHEMA]
        else:
            internal += [_JOB_START_SCHEMA, _JOB_LIST_SCHEMA, _JOB_STATUS_SCHEMA, _JOB_CANCEL_SCHEMA,
                         _subagent_schema_dynamic(), _SUBAGENT_WAIT_SCHEMA, _SUBAGENT_LIST_SCHEMA, _SUBAGENT_STATUS_SCHEMA,
                         _SUBAGENT_CANCEL_SCHEMA, _SUBAGENT_STEER_SCHEMA,
                         _BATCH_SCHEMA,
                         _TASK_STATUS_SCHEMA, _TASK_WAIT_SCHEMA, _TASK_CANCEL_SCHEMA,
                         _ONEKEY_SPLIT_SCHEMA, _ONEKEY_STYLE_LOCK_SCHEMA, _ONEKEY_SCENE_SCHEMA, _ONEKEY_ROLE_SCHEMA, _ONEKEY_SHOT_IMAGE_SCHEMA,
                         _ONEKEY_SHOT_VIDEO_SCHEMA, _ONEKEY_SHOT_VOICE_SCHEMA,
                         _ONEKEY_EXPORT_SCHEMA, _ONEKEY_SUMMARY_SCHEMA, _ONEKEY_REVIEW_SCHEMA]
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
        """动态 provider_* 工具速览（基础/高级分组 + Key 状态标记），替代旧 90 行硬编码简介。

        Key 状态常驻可见：🔑=配置存储已配 / ⚠️=明文写在代码（建议迁移）/ ❌=未配置（去设置→生成源）。
        这样 Agent 无需读码就能知道"该源能不能跑、缺 Key 时要引导用户去哪里填"。
        """
        lines: List[str] = []
        try:
            for t in self._registry().get_all_tools():
                if not t.name.startswith("provider_") or t.name == "provider_key_status":
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
                key_mark = self._provider_key_mark(t.name)
                lines.append(f"- {t.name} — {desc} | 插槽:{','.join(slots) or '无'} | 基础:{','.join(basic) or '无'} 高级:{','.join(adv) or '无'}"
                             + (f" | {key_mark}" if key_mark else ""))
                if len(lines) >= limit:
                    break
        except Exception as e:
            print(f"[RuntimeTools] provider_brief failed: {e}")
        return "\n".join(lines)

    @staticmethod
    def _provider_key_mark(tool_name: str) -> str:
        """自定义代码源的 Key 状态标记（内置源不做判断，避免误报）。"""
        try:
            pid = tool_name[len("provider_"):]
            from app.providers.custom.manager import custom_provider_manager
            pd = custom_provider_manager.get_definition(pid)
            if pd is None:
                return ""
            from app.providers.custom.inline_config import key_status
            st = key_status(pd)
            return {
                "stored": "🔑Key已配(设置→生成源可改)",
                "inline": "⚠️Key明文写在代码(建议 migrate_provider_inline_key 迁移)",
                "none": "❌未配Key(去设置→生成源填)",
            }.get(st.get("key_source", ""), "")
        except Exception:
            return ""


tool_view = ToolRegistryView()
