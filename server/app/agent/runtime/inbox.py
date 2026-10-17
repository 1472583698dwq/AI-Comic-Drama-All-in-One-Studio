# -*- coding: utf-8 -*-
"""Inbox — 轮次输入队列（对标 dsh 的 followup / steer / inject 三通道 + durable 化）。

- followup: 唤醒驱动、进入"下一轮"（用户新指令）。
- steer:    唤醒驱动、进入"当前轮的下一步"（运行中插话纠偏）。
- inject:   不唤醒驱动、进入下一步的静默上下文（插件/后台任务通知）。
- claim():  取走全部 next_step + 一条 next_turn（轮边界），纯删除。

durable（对齐 dsh agent/inbox/spliced）：
- 传入 session 时，所有队列变更（push/claim/clear）都以 INBOX_MUTATION 事件落账，
  崩溃重开后由 Session.pending_inbox_snapshot() 折叠回放未消费输入；
- 跨列表 message.id 去重：同一条消息不得同时/重复排队（同 id 再次入队为幂等 no-op）。
"""
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from app.agent.runtime import events as E


@dataclass
class InboxMessage:
    text: str
    source: str = "user"      # user | plugin | goal | job | system
    form: str = "message"     # message | notice | context
    id: str = field(default_factory=lambda: f"imsg_{uuid.uuid4().hex[:10]}")
    meta: Dict = field(default_factory=dict)

    def to_event_data(self) -> Dict:
        return {"text": self.text, "source": self.source, "form": self.form, "id": self.id, **({"meta": self.meta} if self.meta else {})}

    @classmethod
    def from_event_data(cls, d: Dict[str, Any]) -> "InboxMessage":
        return cls(
            text=str((d or {}).get("text") or ""),
            source=str((d or {}).get("source") or "user"),
            form=str((d or {}).get("form") or "message"),
            id=str((d or {}).get("id") or f"imsg_{uuid.uuid4().hex[:10]}"),
            meta=dict((d or {}).get("meta") or {}),
        )


class Inbox:
    def __init__(self, on_wake: Optional[Callable[[], None]] = None,
                 session: Any = None,
                 restore: Optional[List[Dict[str, Any]]] = None):
        self.next_turn: List[InboxMessage] = []
        self.next_step: List[InboxMessage] = []
        self._on_wake = on_wake
        self._session = session  # 有 session → 每次变更落 INBOX_MUTATION（durable）
        if restore:
            self._restore(restore)

    # ── 回放（重启恢复；不再落账，事件已在历史里）──────────
    def _restore(self, snapshot: List[Dict[str, Any]]) -> None:
        for item in snapshot or []:
            try:
                target = str((item or {}).get("target") or "next-turn")
                msg = InboxMessage.from_event_data((item or {}).get("message") or {})
                lst = self.next_step if target == "next-step" else self.next_turn
                if any(m.id == msg.id for m in (self.next_turn + self.next_step)):
                    continue  # 去重：同一 id 不二次排队
                lst.append(msg)
            except Exception:
                continue

    # ── 持久化（best-effort：落账失败不阻断入队语义，但显式告警）──
    def _persist(self, target: str, inserted: Optional[List[Dict]] = None,
                 removed: Optional[List[str]] = None, outcome: Optional[str] = None) -> None:
        if self._session is None:
            return
        try:
            data: Dict[str, Any] = {"target": target}
            if inserted:
                data["inserted"] = inserted
            if removed:
                data["removed"] = removed
            if outcome:
                data["outcome"] = outcome
            self._session.append(E.INBOX_MUTATION, data)
        except Exception as e:
            try:
                print(f"[Inbox] persist failed: {e}")
            except Exception:
                pass

    def _is_pending(self, mid: str) -> bool:
        return any(m.id == mid for m in self.next_turn) or any(m.id == mid for m in self.next_step)

    # ── 入队 ─────────────────────────────────────────────
    def followup(self, text: str, source: str = "user", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form="message", meta=meta or {})
        if not self._is_pending(m.id):  # 跨列表去重（id 防重入）
            self.next_turn.append(m)
            self._persist("next-turn", inserted=[m.to_event_data()])
        self._wake()
        return m

    def steer(self, text: str, source: str = "user", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form="message", meta=meta or {})
        if not self._is_pending(m.id):
            self.next_step.append(m)
            self._persist("next-step", inserted=[m.to_event_data()])
        self._wake()
        return m

    def inject(self, text: str, source: str = "plugin", form: str = "notice", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form=form, meta=meta or {})
        if not self._is_pending(m.id):
            self.next_step.append(m)
            self._persist("next-step", inserted=[m.to_event_data()])
        return m

    # ── 领取 ─────────────────────────────────────────────
    def claim(self, include_next_turn: bool = True) -> List[InboxMessage]:
        claimed = list(self.next_step)
        self.next_step.clear()
        removed: List[str] = [m.id for m in claimed]
        if include_next_turn:
            while self.next_turn:
                m = self.next_turn.pop(0)
                claimed.append(m)
                removed.append(m.id)
                break  # 一轮只开一条 followup，其余留待下一轮
        if removed:
            self._persist("next-step", removed=removed)
        return claimed

    def claim_step(self) -> List[InboxMessage]:
        return self.claim(include_next_turn=False)

    # ── 查询 ─────────────────────────────────────────────
    def has_pending(self) -> bool:
        return bool(self.next_turn or self.next_step)

    def pending_count(self) -> int:
        return len(self.next_turn) + len(self.next_step)

    def clear(self) -> None:
        removed = [m.id for m in self.next_step] + [m.id for m in self.next_turn]
        self.next_turn.clear()
        self.next_step.clear()
        if removed:
            # 两队列分别落 canceled（折叠时整列清空），保留 removed 供审计
            self._persist("next-step", removed=[m for m in removed], outcome="canceled")
            self._persist("next-turn", removed=[m for m in removed], outcome="canceled")

    def __len__(self) -> int:
        return self.pending_count()

    def _wake(self) -> None:
        if self._on_wake:
            try:
                self._on_wake()
            except Exception:
                pass
