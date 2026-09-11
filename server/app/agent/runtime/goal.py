# -*- coding: utf-8 -*-
"""Goal 轮驱动 — 同会话目标的持久状态与续跑（对标 dsh goal-round-driver）。

- 目标状态以 goal/change 全量快照事件落账，纯折叠读取（最后一条胜出）。
- 只有模型回复包含完成标记或轮次用尽才停止；用户 abort 不清除目标（可 /goal off 显式关闭）。
- 每轮以 followup 入队，附目标提醒；预占计数只在轮次真正开跑时递增。
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

from app.agent.runtime import events as E

GOAL_DONE_MARKER = "[GOAL_DONE]"
DEFAULT_MAX_ROUNDS = 5


@dataclass
class GoalState:
    id: str
    objective: str
    phase: str = "active"          # active | complete | paused
    max_rounds: int = DEFAULT_MAX_ROUNDS
    rounds_started: int = 0
    updated_at: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GoalState":
        return cls(
            id=str(d.get("id") or ""),
            objective=str(d.get("objective") or ""),
            phase=str(d.get("phase") or "active"),
            max_rounds=int(d.get("max_rounds") or DEFAULT_MAX_ROUNDS),
            rounds_started=int(d.get("rounds_started") or 0),
            updated_at=float(d.get("updated_at") or 0.0),
        )

    def can_continue(self) -> bool:
        return self.phase == "active" and self.rounds_started < self.max_rounds

    def reminder(self) -> str:
        return (
            f"【目标轮次 {self.rounds_started + 1}/{self.max_rounds}】正在执行长期目标：{self.objective}\n"
            "请基于已有进展继续推进；若目标已全部完成，在回复末尾输出 [GOAL_DONE]；"
            "若被外部条件阻塞（缺 Key/素材等），说明阻塞点并停止。"
        )


def load_goal(session) -> Optional[GoalState]:
    last: Optional[Dict[str, Any]] = None
    for ev in session.events:
        if ev.get("type") == E.GOAL_CHANGE:
            last = ev.get("data") or {}
    if not last or last.get("cleared"):
        return None
    g = GoalState.from_dict(last)
    return g if g.id else None


def save_goal(session, goal: Optional[GoalState]) -> None:
    if goal is None:
        session.append(E.GOAL_CHANGE, {"cleared": True})
    else:
        session.append(E.GOAL_CHANGE, goal.to_dict())
