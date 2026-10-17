# -*- coding: utf-8 -*-
"""Agent runtime 事件模型 — append-only 会话日志的唯一词汇表。

约定（对标 DeepSeek Harness）：
- 模型可见 ⟺ 已记录：任何进入模型请求的内容都必须能从会话日志重建。
- 事件是不可变事实；读取方按类型纯折叠，遇到未知类型直接拒绝重建。
"""
import json
from typing import Any, Dict, List

SESSION_FORMAT_VERSION = 1

# ── 轮次/步骤边界 ─────────────────────────────────────────
TURN_START = "turn/start"
TURN_END = "turn/end"            # data: {reason}
STEP_START = "step/start"        # data: {index}
STEP_END = "step/end"            # data: {index}

TURN_END_REASONS = (
    "completed",     # 模型不再调用工具且无待办输入
    "aborted",       # 用户/系统取消
    "blocked",       # 输入被拒绝或为空
    "error",         # 模型/管线不可恢复错误
    "max-steps",     # 达到安全轮次上限
    "max-tokens",    # 模型输出被截断
    "interrupted",   # 进程崩溃后恢复时补写
)

# ── 模型可见消息（surface）────────────────────────────────
USER_MESSAGE = "user/message"            # data: {text, source, form}
SYSTEM_MESSAGE = "system/message"        # data: {text}
ASSISTANT_MESSAGE = "assistant/message"  # data: {text, thinking, tool_calls, usage}
ASSISTANT_ATTEMPT = "assistant/attempt"  # data: {error, attempt}
TOOL_CALL = "tool/call"                  # data: {call_id, name, arguments}
TOOL_RESULT = "tool/result"              # data: {call_id, name, status, result, model_content, error, meta}

# ── 请求元数据 ────────────────────────────────────────────
REQUEST_HEADER = "request/header"        # data: {provider, model, tools_count, purpose}

# ── 人审 ──────────────────────────────────────────────────
APPROVAL_ASKED = "approval/asked"        # data: {approval_id, tool_name, arguments}
APPROVAL_DECIDED = "approval/decided"    # data: {approval_id, approved, reason}

# ── 协作状态（P4）────────────────────────────────────────
PLAN_MODE = "plan/mode"                  # data: {active}
GOAL_CHANGE = "goal/change"              # data: {goal}
TODO_WRITE = "todo/write"                # data: {items}

# ── 后台任务（P5）────────────────────────────────────────
JOB_STARTED = "job/started"              # data: {job_id, kind, label}
JOB_SETTLED = "job/settled"              # data: {job_id, status, result_summary}

# ── 子代理集群（P6）──────────────────────────────────────
SUBAGENT_STARTED = "subagent/started"    # data: {subagent_id, agent, task, background, batch_id}
SUBAGENT_PROGRESS = "subagent/progress"  # data: {subagent_id, tool_name, status}
SUBAGENT_SETTLED = "subagent/settled"    # data: {subagent_id, status, elapsed_ms, result_summary, error}
SUBAGENT_METRICS = "subagent/metrics"    # data: {batch_id, total, success, failed, critical_steps_ms, parallel_width}

# ── 上下文压缩（P3）──────────────────────────────────────
COMPACTION_SUMMARY = "compaction/summary"  # data: {text, shadowed_seqs}
COMPACTION_PRUNE = "compaction/prune"      # data: {shadowed_seqs, replacements}

# ── 对齐 dsh 的扩展事件（全部 log-only，不进模型历史）─────
# LLM 重试等待留账：等待前先落账，崩溃后可见"已排定的重试等待"
LLM_RETRY = "llm/retry"                    # data: {attempt, delay_ms, provider, model, code, error}
# Inbox 持久化：每次队列变更落账（durable inbox，重启回放）
INBOX_MUTATION = "inbox/spliced"           # data: {target, removed, inserted, outcome}
# 子代理委派策略钉柱（SEC 契约：权限在派生时固定，审计可见）
DELEGATION_POLICY = "delegation/policy"    # data: {run_mode, agent, subagent_id, source}
# 计划批准审计（计划模式产出 → 用户批准执行）
PLAN_APPROVED = "plan/approved"            # data: {source, plan_chars}
# 压缩事务：start 即 durable 锁（到 end 释放），success/error 都必须有配对的 end
COMPACTION_START = "compaction/start"      # data: {compaction_id, trigger}
COMPACTION_END = "compaction/end"          # data: {compaction_id, status, error}
# 模型面向用户的结构化问询（fail-closed：无交互通道/超时 = no_answer）
QUESTION_ASKED = "question/asked"          # data: {question_id, question, options, multi_select}
QUESTION_ANSWERED = "question/answered"    # data: {question_id, selections, custom, outcome}

# 所有已声明类型（未知类型拒绝重建）
KNOWN_EVENT_TYPES = {
    TURN_START, TURN_END, STEP_START, STEP_END,
    USER_MESSAGE, SYSTEM_MESSAGE, ASSISTANT_MESSAGE, ASSISTANT_ATTEMPT,
    TOOL_CALL, TOOL_RESULT, REQUEST_HEADER,
    APPROVAL_ASKED, APPROVAL_DECIDED,
    PLAN_MODE, GOAL_CHANGE, TODO_WRITE,
    JOB_STARTED, JOB_SETTLED,
    SUBAGENT_STARTED, SUBAGENT_PROGRESS, SUBAGENT_SETTLED, SUBAGENT_METRICS,
    COMPACTION_SUMMARY, COMPACTION_PRUNE,
    LLM_RETRY, INBOX_MUTATION, DELEGATION_POLICY, PLAN_APPROVED,
    COMPACTION_START, COMPACTION_END, QUESTION_ASKED, QUESTION_ANSWERED,
}

# 模型可见事件（derive_messages 的输入面）
SURFACE_EVENT_TYPES = {USER_MESSAGE, SYSTEM_MESSAGE, ASSISTANT_MESSAGE, TOOL_RESULT}


def make_event(event_type: str, data: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """构造事件（seq/time 由 Session.append 填充）。"""
    return {"type": event_type, "data": data or {}}


def validate_event(ev: Dict[str, Any]) -> None:
    """拒绝未知类型/结构损坏的事件，避免静默跳过导致历史不可信。"""
    if not isinstance(ev, dict):
        raise ValueError(f"事件必须是 dict，实际 {type(ev).__name__}")
    t = ev.get("type")
    if not isinstance(t, str) or not t:
        raise ValueError("事件缺少 type")
    if t not in KNOWN_EVENT_TYPES:
        raise ValueError(f"未知事件类型: {t}（当前格式 v{SESSION_FORMAT_VERSION}，拒绝重建）")
    if "seq" in ev and not isinstance(ev["seq"], int):
        raise ValueError("事件 seq 必须为 int")


def tool_result_content_text(data: Dict[str, Any]) -> str:
    """工具结果进入模型历史的唯一口径。

    管线已按工具语义压好的 model_content 优先（保留分页窗口、剔除 code 全文、附溢写定位）；
    缺失时回落到原始 result 序列化。失败态统一只回错误，禁止模型臆测成功结果。
    日志里 result 原文永不动，前端渲染与复盘仍拿全量。
    """
    if data.get("status") != "success":
        return json.dumps({"error": data.get("error") or "工具执行失败"}, ensure_ascii=False)
    mc = data.get("model_content")
    if isinstance(mc, str) and mc.strip():
        return mc
    result = data.get("result")
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        return str(result)


def open_turn_seq(events: List[Dict[str, Any]]) -> int | None:
    """返回最后一个未闭合 turn/start 的 seq；无开启轮次返回 None。"""
    depth: int | None = None
    for ev in events:
        if ev.get("type") == TURN_START and depth is None:
            depth = int(ev.get("seq") or 0)
        elif ev.get("type") == TURN_END:
            depth = None
    return depth


def interrupted_tool_calls(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """找出已发起但无结果的工具调用（崩溃恢复补账用）。"""
    called: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        t = ev.get("type")
        if t == TOOL_CALL:
            cid = str((ev.get("data") or {}).get("call_id") or "")
            if cid:
                called[cid] = ev.get("data") or {}
        elif t == TOOL_RESULT:
            cid = str((ev.get("data") or {}).get("call_id") or "")
            called.pop(cid, None)
    return list(called.values())
