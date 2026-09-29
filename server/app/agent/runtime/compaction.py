# -*- coding: utf-8 -*-
"""上下文治理 — 工具结果剪裁 + 会话压缩（对标 dsh compaction）。

- 剪裁：超过阈值的 tool/result 以 replace 语义追加 compaction/prune（原文保留在日志，模型只看到头尾）。
- 压缩：压力达到窗口 80% 时，把较早的 surface 事件摘要成一条 user 消息，
  以 shadowed_seqs 遮蔽旧事件（日志不删改，derive_messages 折叠）。
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Set

from app.agent.runtime import events as E
from app.agent.runtime.token_meter import (
    context_window, estimate_messages, estimate_text, should_compact,
)

_SUMMARY_SYSTEM = (
    "你是漫剧制作会话的压缩器。把给定的历史对话压缩成一段高保真中文摘要，供后续继续工作使用。"
    "必须保留：用户所有明确要求与约束、当前项目/镜头状态、已执行的工具及其关键结果（含 URL/ID/参数）、"
    "失败原因与未完成事项、下一步待办。不要编造。只输出摘要正文。"
)

# 上游"上下文超限"类错误特征：命中则强制压缩历史后重试本步（与配额/限流错误区分开）
_CONTEXT_OVERFLOW_PHRASES = (
    "context length", "context_length", "maximum context", "max context",
    "context limit", "too many tokens", "tokens in the messages", "prompt is too long",
    "input is too long", "reduce the length", "maximum number of tokens",
    "上下文长度", "上下文超限", "输入过长", "长度超限",
)


def is_context_overflow_error(err: Any) -> bool:
    """判断异常是否为"上下文超限"（强制压缩后重试的触发条件）。"""
    s = f"{type(err).__name__}: {err}".lower()
    if any(p in s for p in _CONTEXT_OVERFLOW_PHRASES):
        return True
    # 兜底：必须同时提到 context/上下文 且带超限语义，避免把配额/限流误判为超限
    if ("context" in s or "上下文" in s):
        return any(w in s for w in ("exceed", "too long", "limit", "length", "超", "过长"))
    return False


def _shadow_info(session) -> tuple[Set[int], Dict[int, str]]:
    shadowed: Set[int] = set()
    replacements: Dict[int, str] = {}
    for ev in session.events:
        t = ev.get("type")
        d = ev.get("data") or {}
        if t == E.COMPACTION_SUMMARY:
            shadowed.update(int(x) for x in (d.get("shadowed_seqs") or []) if str(x).isdigit())
        elif t == E.COMPACTION_PRUNE:
            shadowed.update(int(x) for x in (d.get("shadowed_seqs") or []) if str(x).isdigit())
            for k, v in (d.get("replacements") or {}).items():
                if str(k).isdigit():
                    replacements[int(k)] = str(v)
    return shadowed, replacements


def _prune_max_chars() -> int:
    """剪裁兜底阈值：留出余量给管线已压好的结果（pipeline.SPILL_CHARS=8000），避免二次盲剪。"""
    try:
        return max(1000, int(os.environ.get("AGENT_PRUNE_MAX_CHARS") or 9000))
    except Exception:
        return 9000


def maybe_prune_tool_results(session, max_chars: Optional[int] = None) -> int:
    """把过大的 tool/result 替换为头尾预览（append-only，原文仍在日志）。"""
    max_chars = _prune_max_chars() if max_chars is None else int(max_chars)
    shadowed, _ = _shadow_info(session)
    replacements: Dict[str, str] = {}
    seqs: List[int] = []
    for ev in session.events:
        if ev.get("type") != E.TOOL_RESULT:
            continue
        seq = int(ev.get("seq") or 0)
        if seq in shadowed:
            continue
        content = E.tool_result_content_text(ev.get("data") or {})
        if len(content) <= max_chars:
            continue
        half = max_chars // 2
        replacements[str(seq)] = content[:half] + f"\n…(已剪裁，原文 {len(content)} 字符)…\n" + content[-half:]
        seqs.append(seq)
    if not seqs:
        return 0
    session.append(E.COMPACTION_PRUNE, {"shadowed_seqs": seqs, "replacements": replacements})
    return len(seqs)


def _surface_sequence(session) -> List[Dict[str, Any]]:
    """按事件顺序列出 surface 项：{seq, role, tokens, ev}（已遮蔽的不计入）。"""
    shadowed, _ = _shadow_info(session)
    out: List[Dict[str, Any]] = []
    for ev in session.events:
        seq = int(ev.get("seq") or 0)
        if seq in shadowed:
            continue
        t = ev.get("type")
        d = ev.get("data") or {}
        if t == E.USER_MESSAGE:
            out.append({"seq": seq, "role": "user", "tokens": estimate_text(str(d.get("text") or "")), "type": t})
        elif t == E.ASSISTANT_MESSAGE:
            tok = estimate_text(str(d.get("text") or "")) + estimate_text(str(d.get("tool_calls") or ""))
            out.append({"seq": seq, "role": "assistant", "tokens": tok, "type": t})
        elif t == E.TOOL_RESULT:
            out.append({"seq": seq, "role": "tool",
                        "tokens": estimate_text(E.tool_result_content_text(d)), "type": t})
        elif t == E.SYSTEM_MESSAGE:
            out.append({"seq": seq, "role": "system", "tokens": estimate_text(str(d.get("text") or "")), "type": t})
    return out


def select_shadow_range(surface: List[Dict[str, Any]], keep_tokens: int) -> Optional[int]:
    """返回 cut 下标：surface[:cut] 被遮蔽，surface[cut:] 保留。无法安全压缩返回 None。"""
    if len(surface) <= 4:
        return None
    total = 0
    cut = len(surface)
    for i in range(len(surface) - 1, -1, -1):
        total += surface[i]["tokens"]
        cut = i
        if total >= keep_tokens:
            break
    # 绝不能从 tool 结果中间开始保留（其 assistant tool_calls 已被遮蔽会配对断裂）
    while cut < len(surface) and surface[cut]["role"] == "tool":
        cut += 1
    if cut <= 1 or cut >= len(surface):
        return None
    shadowed_tokens = sum(x["tokens"] for x in surface[:cut])
    if shadowed_tokens < 1500:
        return None
    return cut


def _transcript_of(session, surface: List[Dict[str, Any]], cut: int, limit_chars: int = 12000) -> str:
    by_seq = {int(ev.get("seq") or 0): ev for ev in session.events}
    lines: List[str] = []
    for item in surface[:cut]:
        ev = by_seq.get(item["seq"]) or {}
        d = ev.get("data") or {}
        if item["type"] == E.USER_MESSAGE:
            lines.append(f"[用户] {str(d.get('text') or '')[:1500]}")
        elif item["type"] == E.ASSISTANT_MESSAGE:
            text = str(d.get("text") or "")[:800]
            tcs = d.get("tool_calls") or []
            names = ",".join((tc or {}).get("name") or "" for tc in tcs)
            lines.append(f"[导演] {text}" + (f"（调用工具: {names}）" if names else ""))
        elif item["type"] == E.TOOL_RESULT:
            c = E.tool_result_content_text(d)
            status = d.get("status") or ""
            err = d.get("error") or ""
            lines.append(f"[工具 {d.get('name') or ''} {status}] {(err if status != 'success' else c)[:1200]}")
    text = "\n".join(lines)
    return text[:limit_chars]


async def maybe_compact(session, emit=None, force: bool = False) -> Optional[Dict[str, Any]]:
    """压力超阈值时摘要旧历史；force=True 时跳过阈值检查（上游报上下文超限后的应急压缩）。
    失败不阻塞主流程（返回 None）。"""
    try:
        if not force and not should_compact(session):
            return None
        window = context_window()
        try:
            keep_ratio = float(os.environ.get("AGENT_COMPACT_KEEP_RATIO") or 0.2)
        except Exception:
            keep_ratio = 0.2
        surface = _surface_sequence(session)
        cut = select_shadow_range(surface, keep_tokens=int(window * keep_ratio))
        if cut is None:
            return None
        transcript = _transcript_of(session, surface, cut)
        if not transcript.strip():
            return None
        from app.agent.llm.adapter import adapter
        reply = await adapter.complete(
            messages=[
                {"role": "system", "content": _SUMMARY_SYSTEM},
                {"role": "user", "content": transcript},
            ],
            tools=None, temperature=0.2, max_tokens=1200, timeout=120,
        )
        text = (reply.content or "").strip()
        if not text:
            return None
        shadowed_seqs = [x["seq"] for x in surface[:cut]]
        ev = session.append(E.COMPACTION_SUMMARY, {"text": text, "shadowed_seqs": shadowed_seqs})
        if emit is not None:
            try:
                await emit({
                    "event": "agent_thinking",
                    "message": f"上下文压缩完成（遮蔽 {len(shadowed_seqs)} 条旧消息）",
                })
            except Exception:
                pass
        return ev
    except Exception as e:
        try:
            print(f"[AgentCompaction] failed: {e}")
        except Exception:
            pass
        return None


async def maintain_context(session, emit=None) -> None:
    """每步请求前的例行动作：先剪裁超大工具结果，再按压力压缩。"""
    try:
        maybe_prune_tool_results(session)
    except Exception:
        pass
    if should_compact(session):
        await maybe_compact(session, emit=emit)
