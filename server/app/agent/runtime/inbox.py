# -*- coding: utf-8 -*-
"""Inbox — 轮次输入队列（对标 dsh 的 followup / steer / inject 三通道）。

- followup: 唤醒驱动、进入"下一轮"（用户新指令）。
- steer:    唤醒驱动、进入"当前轮的下一步"（运行中插话纠偏）。
- inject:   不唤醒驱动、进入下一步的静默上下文（插件/后台任务通知）。
- claim():  取走全部 next_step + 一条 next_turn（轮边界），纯删除。
"""
import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional


@dataclass
class InboxMessage:
    text: str
    source: str = "user"      # user | plugin | goal | job | system
    form: str = "message"     # message | notice | context
    id: str = field(default_factory=lambda: f"imsg_{uuid.uuid4().hex[:10]}")
    meta: Dict = field(default_factory=dict)

    def to_event_data(self) -> Dict:
        return {"text": self.text, "source": self.source, "form": self.form, "id": self.id, **({"meta": self.meta} if self.meta else {})}


class Inbox:
    def __init__(self, on_wake: Optional[Callable[[], None]] = None):
        self.next_turn: List[InboxMessage] = []
        self.next_step: List[InboxMessage] = []
        self._on_wake = on_wake

    # ── 入队 ─────────────────────────────────────────────
    def followup(self, text: str, source: str = "user", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form="message", meta=meta or {})
        self.next_turn.append(m)
        self._wake()
        return m

    def steer(self, text: str, source: str = "user", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form="message", meta=meta or {})
        self.next_step.append(m)
        self._wake()
        return m

    def inject(self, text: str, source: str = "plugin", form: str = "notice", meta: Optional[Dict] = None) -> InboxMessage:
        m = InboxMessage(text=text, source=source, form=form, meta=meta or {})
        self.next_step.append(m)
        return m

    # ── 领取 ─────────────────────────────────────────────
    def claim(self, include_next_turn: bool = True) -> List[InboxMessage]:
        claimed = list(self.next_step)
        self.next_step.clear()
        if include_next_turn:
            while self.next_turn:
                claimed.append(self.next_turn.pop(0))
                break  # 一轮只开一条 followup，其余留待下一轮
        return claimed

    def claim_step(self) -> List[InboxMessage]:
        return self.claim(include_next_turn=False)

    # ── 查询 ─────────────────────────────────────────────
    def has_pending(self) -> bool:
        return bool(self.next_turn or self.next_step)

    def pending_count(self) -> int:
        return len(self.next_turn) + len(self.next_step)

    def clear(self) -> None:
        self.next_turn.clear()
        self.next_step.clear()

    def __len__(self) -> int:
        return self.pending_count()

    def _wake(self) -> None:
        if self._on_wake:
            try:
                self._on_wake()
            except Exception:
                pass
