# -*- coding: utf-8 -*-
"""Session — append-only 事件日志的读模型。

职责：
- append(type, data)：分配 seq/time、校验、写内存、落盘；返回落盘事件。
- derive_messages()：从事件日志纯函数投影出 OpenAI 兼容的历史消息（模型输入的唯一来源）。
- snapshot()：给传输层/前端的一致性快照。
- usage_totals()：token 计量投影（P3）。
"""
import json
import time
from typing import Any, Dict, List, Optional

from app.agent.runtime import events as E
from app.agent.runtime.store import store as default_store, SessionStore

# 配对修复用合成结果：缺失的 tool 响应（中断/剪裁）以错误态占位，禁止模型臆测结果
_ORPHAN_FILL = json.dumps(
    {"error": "工具结果不可用（会话中断或上下文已剪裁）；禁止假设其结果，如需请重新调用。"},
    ensure_ascii=False,
)


def _sanitize_tool_pairing(msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把投影结果修成对 LLM 合法的 tool 配对（防 400）：

    - 孤儿 tool 消息（无父级 assistant.tool_calls）：丢弃；
      典型来源：早先 prune 的替换预览 + 后续 summary 把父级 assistant 一并遮蔽（遮蔽集重叠）。
    - assistant.tool_calls 缺少响应：补合成错误结果，保证每个 tool_call 紧跟响应；
      典型来源：中断/异常时后续工具未执行、剪裁遮蔽了原响应。
    """
    out: List[Dict[str, Any]] = []
    pending: List[str] = []

    def flush_pending() -> None:
        nonlocal pending
        for cid in pending:
            out.append({"role": "tool", "tool_call_id": cid, "content": _ORPHAN_FILL})
        pending = []

    for m in msgs:
        role = m.get("role")
        if role == "assistant":
            flush_pending()
            pending = [str((tc or {}).get("id") or "") for tc in (m.get("tool_calls") or [])]
            out.append(m)
        elif role == "tool":
            cid = str(m.get("tool_call_id") or "")
            if cid in pending:
                pending.remove(cid)
                out.append(m)
            # 无匹配父级的孤儿：直接丢弃
        else:
            flush_pending()
            out.append(m)
    flush_pending()
    return out


def _safe_tool_arguments(args: Any) -> str:
    """历史回放给上游的 tool 参数必须是合法 JSON：截断/非法一律回落 {}。

    模型输出超长被 max_tokens 截断时 arguments 是不完整 JSON，若原样回传，
    上游会 400 并把整段会话历史毒化（此后每次请求都失败）。
    """
    if not isinstance(args, str):
        return json.dumps(args or {}, ensure_ascii=False)
    s = args.strip()
    if not s:
        return "{}"
    try:
        json.loads(s)
        return s
    except Exception:
        return "{}"


class Session:
    def __init__(self, session_id: str, events: Optional[List[Dict[str, Any]]] = None,
                 store: Optional[SessionStore] = None, strict: bool = False):
        self.id = session_id
        self.store = store or default_store
        self.strict = bool(strict)  # strict=True（AgentLoop）→ 提交时强制 invariant
        self._events: List[Dict[str, Any]] = list(events or [])
        self._next_seq = (self._events[-1]["seq"] + 1) if self._events else 1
        self._messages_cache: Optional[List[Dict[str, Any]]] = None
        self._messages_cache_key: Any = None
        # invariant 状态机缓存（对标 dsh session invariant：提交时校验，拒绝坏写入）
        self._rebuild_invariant_state()

    # ── invariant（提交时拒绝而非事后修复）────────────────
    def _rebuild_invariant_state(self) -> None:
        """从历史事件重建校验游标：open turn/step 与未结算 tool calls。"""
        self._open_turn = False
        self._open_step = False
        self._pending_calls: set = set()
        for ev in self._events:
            t = ev.get("type")
            d = ev.get("data") or {}
            if t == E.TURN_START:
                self._open_turn, self._open_step = True, False
            elif t == E.TURN_END:
                self._open_turn, self._open_step = False, False
            elif t == E.STEP_START:
                self._open_step = True
            elif t == E.STEP_END:
                self._open_step = False
            elif t == E.TOOL_CALL:
                cid = str(d.get("call_id") or "")
                if cid:
                    self._pending_calls.add(cid)
            elif t == E.TOOL_RESULT:
                self._pending_calls.discard(str(d.get("call_id") or ""))

    def _check_transition(self, event_type: str, data: Dict[str, Any]) -> None:
        """append 前的纯校验：不变量失败即抛（可见历史永不 partly-invalid）。"""
        if event_type == E.TURN_START:
            if self._open_turn:
                raise RuntimeError(f"会话 {self.id} 已有未闭合 turn，拒绝嵌套 turn/start")
            if self._open_step:
                raise RuntimeError(f"会话 {self.id} step 未闭合就开新 turn")
        elif event_type == E.TURN_END:
            if not self._open_turn:
                if not self._events:
                    return  # 空 seed 会话从不该直接 close；此处容忍历史迁移
                raise RuntimeError(f"会话 {self.id} 无开放 turn 却写入 turn/end")
        elif event_type == E.STEP_START:
            if not self._open_turn:
                raise RuntimeError(f"会话 {self.id} 无开放 turn 就写入 step/start")
            if self._open_step:
                raise RuntimeError(f"会话 {self.id} 已有开放 step，拒绝嵌套 step/start")
        elif event_type == E.STEP_END:
            if not self._open_step:
                raise RuntimeError(f"会话 {self.id} 无开放 step 却写入 step/end")
        elif event_type == E.TOOL_CALL:
            if not self._open_turn:
                raise RuntimeError(f"会话 {self.id} 工具调用必须在开放 turn 内")
        elif event_type == E.TOOL_RESULT:
            if not self._open_turn:
                raise RuntimeError(f"会话 {self.id} 工具结果必须在开放 turn 内")
            cid = str(data.get("call_id") or "")
            # 合成错误结果（中断补账/跳过占位）允许无前导 tool/call；成功结果必须配对
            if cid and cid not in self._pending_calls and data.get("status") != "error":
                raise RuntimeError(f"会话 {self.id} 工具结果无配对调用（call_id={cid}）")

    def _apply_transition(self, event_type: str, data: Dict[str, Any]) -> None:
        if event_type == E.TURN_START:
            self._open_turn, self._open_step = True, False
        elif event_type == E.TURN_END:
            self._open_turn, self._open_step = False, False
            if self._pending_calls:
                self._pending_calls.clear()
        elif event_type == E.STEP_START:
            self._open_step = True
        elif event_type == E.STEP_END:
            self._open_step = False
        elif event_type == E.TOOL_CALL:
            cid = str(data.get("call_id") or "")
            if cid:
                self._pending_calls.add(cid)
        elif event_type == E.TOOL_RESULT:
            self._pending_calls.discard(str(data.get("call_id") or ""))

    # ── 生命周期 ──────────────────────────────────────────
    @classmethod
    def open(cls, session_id: str, store: Optional[SessionStore] = None, repair: bool = True,
             strict: bool = False) -> "Session":
        st = store or default_store
        events = [ev for ev in st.read(session_id) if ev.get("type") != "session/header"]
        s = cls(session_id, events, st, strict=strict)
        if repair:
            s.repair_interrupted()
        return s

    def repair_interrupted(self) -> None:
        """崩溃恢复：为悬挂工具调用补结果、补 step/end 与 turn/end(interrupted)。"""
        pending = E.interrupted_tool_calls(self._events)
        if pending:
            for tc in pending:
                self.append(E.TOOL_RESULT, {
                    "call_id": tc.get("call_id"),
                    "name": tc.get("name"),
                    "status": "error",
                    "result": None,
                    "error": "进程中断，工具结果未知，禁止盲目重试；请先检查外部状态。",
                })
        seq = E.open_turn_seq(self._events)
        if seq is not None:
            # 补闭合（step/end 允许缺失；turn/end 必须有）
            self.append(E.TURN_END, {"reason": "interrupted"})

    # ── 写入 ─────────────────────────────────────────────
    def append(self, event_type: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = data or {}
        E.validate_event({"type": event_type, "data": data})
        # invariant 在校验通过后才入 log：失败时什么都不会改变（strict 会话强制）
        if self.strict:
            self._check_transition(event_type, data)
        ev = {"type": event_type, "seq": self._next_seq, "time": time.time(), "data": data}
        self._next_seq += 1
        self._events.append(ev)
        self._apply_transition(event_type, data)
        self._messages_cache = None
        try:
            self.store.append(self.id, [ev])
        except Exception as e:
            # 落盘失败必须显式暴露：模型可见的东西没能记下来，历史不再可信
            raise RuntimeError(f"会话日志写入失败({self.id}): {e}") from e
        return ev

    # ── 幂等 append（稳定 KV-cache 前缀，对标 dsh 投影去重）──
    def last_system_text(self) -> str:
        for ev in reversed(self._events):
            if ev.get("type") == E.SYSTEM_MESSAGE:
                return str((ev.get("data") or {}).get("text") or "")
        return ""

    def append_system_if_changed(self, text: str) -> Optional[Dict[str, Any]]:
        """系统提示词只在变化时落账（历史里永远指向最后一条）。"""
        if text == self.last_system_text():
            return None
        return self.append(E.SYSTEM_MESSAGE, {"text": text})

    def last_context_text(self) -> str:
        """最后一条运行时上下文 user 消息（form=context，非用户直发）。"""
        for ev in reversed(self._events):
            if ev.get("type") != E.USER_MESSAGE:
                continue
            d = ev.get("data") or {}
            if d.get("form") == "context" and d.get("source") != "user":
                return str(d.get("text") or "")
        return ""

    def append_context_if_changed(self, text: str) -> Optional[Dict[str, Any]]:
        """运行时上下文与上一次完全一致时不重复落账（幂等快照）。"""
        if text and text == self.last_context_text():
            return None
        return self.append(E.USER_MESSAGE, {"text": text, "source": "system", "form": "context"})

    # ── durable inbox 回放（重启恢复排队输入）─────────────
    def pending_inbox_snapshot(self) -> List[Dict[str, Any]]:
        """折叠 INBOX_MUTATION 事件，重建重启前的排队输入。

        返回 ``[{"target": "next-step"|"next-turn", "message": {...}}]``，
        顺序与 claim 优先序一致（next-step 先于 next-turn）。
        """
        queues: Dict[str, List[Dict[str, Any]]] = {"next-turn": [], "next-step": []}
        for ev in self._events:
            if ev.get("type") != E.INBOX_MUTATION:
                continue
            d = ev.get("data") or {}
            target = str(d.get("target") or "")
            if target not in queues:
                continue
            if d.get("outcome") == "canceled":
                queues[target].clear()
            for mid in (d.get("removed") or []):
                for lst in queues.values():
                    lst[:] = [m for m in lst if m.get("id") != mid]
            for msg in (d.get("inserted") or []):
                if isinstance(msg, dict) and msg.get("id"):
                    if not any(m.get("id") == msg.get("id") for m in queues[target]):
                        queues[target].append(msg)
        out: List[Dict[str, Any]] = []
        for target in ("next-step", "next-turn"):
            for m in queues[target]:
                out.append({"target": target, "message": dict(m)})
        return out

    # ── 读取 ─────────────────────────────────────────────
    @property
    def events(self) -> List[Dict[str, Any]]:
        return list(self._events)

    @property
    def seq(self) -> int:
        return self._next_seq - 1

    def is_empty(self) -> bool:
        return not any(ev.get("type") in E.SURFACE_EVENT_TYPES for ev in self._events)

    def last_surface(self, event_type: str) -> Optional[Dict[str, Any]]:
        for ev in reversed(self._events):
            if ev.get("type") == event_type:
                return ev
        return None

    def last_assistant_text(self) -> str:
        ev = self.last_surface(E.ASSISTANT_MESSAGE)
        return str((ev or {}).get("data", {}).get("text") or "")

    # ── 模型历史投影 ─────────────────────────────────────
    def derive_messages(self, system_text: Optional[str] = None) -> List[Dict[str, Any]]:
        """从日志投影模型消息；纯函数，结果缓存到下次 append。

        规则：
        - compaction/summary 遮蔽（shadowed_seqs）内的事件不进入历史，摘要文本作为 user 消息插入。
        - assistant/attempt、边界事件、审批事件等非 surface 事件不进入历史。
        - system_text 显式传入时优先（来自请求装配），否则用日志中最后一条 system/message。
        """
        cache_key = (self._next_seq, system_text)
        if self._messages_cache is not None and self._messages_cache_key == cache_key:
            return [dict(m) for m in self._messages_cache]

        shadowed: set = set()
        replacements: Dict[int, str] = {}
        for ev in self._events:
            if ev.get("type") == E.COMPACTION_SUMMARY:
                d = ev.get("data") or {}
                shadowed.update(int(x) for x in (d.get("shadowed_seqs") or []) if str(x).isdigit())
            elif ev.get("type") == E.COMPACTION_PRUNE:
                d = ev.get("data") or {}
                shadowed.update(int(x) for x in (d.get("shadowed_seqs") or []) if str(x).isdigit())
                for k, v in (d.get("replacements") or {}).items():
                    if str(k).isdigit():
                        replacements[int(k)] = str(v)

        logged_system = ""
        msgs: List[Dict[str, Any]] = []
        for ev in self._events:
            seq = int(ev.get("seq") or 0)
            if seq in shadowed:
                # 剪裁替换：被遮蔽的 tool/result 用头尾预览代替，避免 tool_calls 配对断裂
                if ev.get("type") == E.TOOL_RESULT and seq in replacements:
                    d = ev.get("data") or {}
                    msgs.append({
                        "role": "tool",
                        "tool_call_id": d.get("call_id") or "",
                        "content": replacements[seq],
                    })
                continue
            t = ev.get("type")
            d = ev.get("data") or {}
            if t == E.SYSTEM_MESSAGE:
                logged_system = str(d.get("text") or "")
            elif t == E.USER_MESSAGE:
                text = str(d.get("text") or "")
                atts = ((d.get("meta") or {}).get("attachments") or []) if isinstance(d.get("meta"), dict) else []
                content: Any = text
                if atts:
                    # 多模态附件：图片（视觉可用时）转 content parts；其余降级为文本行
                    try:
                        from app.agent.runtime.attachments import build_user_content
                        content = build_user_content(text, atts)
                    except Exception:
                        content = text
                elif d.get("source") == "user" and len(text) > 2000:
                    # 复制粘贴的长文：模型历史折成 头+尾+locator（全文落盘，fs_read 可取）
                    try:
                        from app.agent.runtime.compaction import maybe_fold_user_text
                        content = maybe_fold_user_text(self.id, seq, text)
                    except Exception:
                        content = text
                if content:
                    msgs.append({"role": "user", "content": content})
            elif t == E.ASSISTANT_MESSAGE:
                text = str(d.get("text") or "")
                tcs = d.get("tool_calls") or []
                m: Dict[str, Any] = {"role": "assistant", "content": text or ""}
                if tcs:
                    m["tool_calls"] = []
                    for tc in tcs:
                        m["tool_calls"].append({
                            "id": tc.get("id") or tc.get("call_id") or "",
                            "type": "function",
                            "function": {"name": tc.get("name") or "", "arguments": _safe_tool_arguments(tc.get("arguments"))},
                        })
                msgs.append(m)
            elif t == E.TOOL_RESULT:
                msgs.append({
                    "role": "tool",
                    "tool_call_id": d.get("call_id") or "",
                    "content": E.tool_result_content_text(d),
                })
            elif t == E.COMPACTION_SUMMARY and seq not in shadowed:
                text = str(d.get("text") or "")
                if text:
                    msgs.append({"role": "user", "content": text})

        system = system_text if system_text is not None else logged_system
        if system:
            msgs.insert(0, {"role": "system", "content": system})
        msgs = _sanitize_tool_pairing(msgs)
        self._messages_cache = msgs
        self._messages_cache_key = cache_key
        return [dict(m) for m in msgs]

    # ── 计量 ─────────────────────────────────────────────
    def usage_totals(self) -> Dict[str, int]:
        total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        for ev in self._events:
            if ev.get("type") != E.ASSISTANT_MESSAGE:
                continue
            u = (ev.get("data") or {}).get("usage") or {}
            for k in total:
                try:
                    total[k] += int(u.get(k) or 0)
                except Exception:
                    pass
        return total

    def had_assistant_output(self) -> bool:
        return any(ev.get("type") == E.ASSISTANT_MESSAGE for ev in self._events)

    # ── 快照 ─────────────────────────────────────────────
    def snapshot(self, tail: int = 200) -> Dict[str, Any]:
        events = self._events[-max(1, int(tail)):]
        return {
            "session_id": self.id,
            "as_of_seq": self.seq,
            "format": E.SESSION_FORMAT_VERSION,
            "events": events,
            "usage": self.usage_totals(),
        }
