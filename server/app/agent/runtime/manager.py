# -*- coding: utf-8 -*-
"""AgentManager — 会话级 AgentLoop 注册表与传输无关的入口。

所有传输（WS / SSE / HTTP）都走这里：
- prompt() 将输入投递进 Inbox，驱动在后台跑；传输层只订阅事件。
- 同一会话并发输入不会拒绝，而是排队（followup）或插话（steer）。
- 进程重启后从 JSONL 日志恢复会话（悬挂工具调用自动补账）。
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List, Optional

from app.agent.runtime.loop import AgentLoop

Sink = Callable[[Dict[str, Any]], Any]


class AgentManager:
    def __init__(self):
        self._loops: Dict[str, AgentLoop] = {}
        self._lock = asyncio.Lock()

    # ── 查询 ─────────────────────────────────────────────
    def get(self, session_id: str) -> Optional[AgentLoop]:
        return self._loops.get(session_id)

    def list_sessions(self) -> List[Dict[str, Any]]:
        return [
            {"session_id": sid, "running": lp.is_running(), "seq": lp.session.seq}
            for sid, lp in self._loops.items()
        ]

    # ── 创建/获取 ────────────────────────────────────────
    async def get_or_create(
        self,
        session_id: str,
        run_mode: str = "approve",
        mode: str = "execute",
        context: Optional[Dict[str, Any]] = None,
        interactive: bool = False,
        agent_profile: Any = None,
    ) -> AgentLoop:
        async with self._lock:
            lp = self._loops.get(session_id)
            if lp is None:
                lp = AgentLoop(session_id, run_mode=run_mode, mode=mode,
                               context=context or {}, interactive=interactive,
                               agent_profile=agent_profile)
                self._loops[session_id] = lp
            else:
                if context:
                    lp.context = dict(context)
                if agent_profile is not None:
                    # 会话已存在也允许热换角色（如重试时补上导演画像）
                    lp.agent_profile = agent_profile
                    try:
                        lp.pipeline.agent_profile = agent_profile
                    except Exception:
                        pass
            return lp

    # ── 订阅 ─────────────────────────────────────────────
    async def attach(self, session_id: str, sink: Sink, interactive: bool = False) -> AgentLoop:
        lp = await self.get_or_create(session_id, interactive=interactive)
        lp.attach(sink)
        if interactive:
            lp.pipeline.approvals.interactive = True
        return lp

    def detach(self, session_id: str, sink: Sink) -> None:
        lp = self._loops.get(session_id)
        if lp:
            lp.detach(sink)

    # ── 输入 ─────────────────────────────────────────────
    async def prompt(
        self,
        session_id: str,
        text: str,
        context: Optional[Dict[str, Any]] = None,
        mode: str = "execute",
        run_mode: str = "approve",
        interactive: bool = False,
        sink: Optional[Sink] = None,
        agent_profile: Any = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> AgentLoop:
        lp = await self.get_or_create(session_id, run_mode=run_mode, mode=mode,
                                      context=context, interactive=interactive,
                                      agent_profile=agent_profile)
        if sink is not None:
            lp.attach(sink)
        if interactive:
            lp.pipeline.approvals.interactive = True
        await lp.prompt(text, context=context, mode=mode, run_mode=run_mode, attachments=attachments)
        return lp

    async def steer(self, session_id: str, text: str,
                    attachments: Optional[List[Dict[str, Any]]] = None) -> bool:
        lp = self._loops.get(session_id)
        if lp is None:
            return False
        await lp.steer(text, attachments=attachments)
        return True

    async def set_run_mode(self, session_id: str, run_mode: str) -> Optional[str]:
        """热切换会话运行模式（审批/自动），对当前运行轮立即生效。

        loop 尚未创建时返回 None——调用方无需处理，下一条 prompt 会携带 run_mode。
        """
        lp = self._loops.get(session_id)
        if lp is None:
            return None
        return await lp.apply_run_mode(run_mode)

    # ── 目标（P4）────────────────────────────────────────
    async def set_goal(self, session_id: str, objective: str, max_rounds: Optional[int] = None) -> Dict[str, Any]:
        lp = await self.get_or_create(session_id)
        g = lp.set_goal(objective, max_rounds)
        lp.inbox.followup(g.reminder(), source="goal")
        return g.to_dict()

    async def get_goal(self, session_id: str) -> Optional[Dict[str, Any]]:
        lp = self._loops.get(session_id)
        if lp is not None:
            return lp.goal.to_dict() if lp.goal else None
        try:
            from app.agent.runtime.goal import load_goal
            from app.agent.runtime.session import Session
            g = load_goal(Session.open(session_id, repair=False))
            return g.to_dict() if g else None
        except Exception:
            return None

    async def clear_goal(self, session_id: str) -> bool:
        lp = self._loops.get(session_id)
        if lp is None:
            return False
        lp.clear_goal()
        return True

    # ── 控制 ─────────────────────────────────────────────
    async def resolve_approval(self, session_id: str, approval_id: str, approved: bool) -> bool:
        lp = self._loops.get(session_id)
        if lp is None:
            return False
        return lp.resolve_approval(approval_id, approved)

    async def abort(self, session_id: str, cause: str = "user") -> bool:
        lp = self._loops.get(session_id)
        if lp is None:
            return False
        await lp.abort(cause)
        return True

    async def clear(self, session_id: str) -> bool:
        async with self._lock:
            lp = self._loops.pop(session_id, None)
        if lp is not None:
            await lp.abort("clear")
            try:
                lp.session.store.delete(session_id)
            except Exception:
                pass
        else:
            try:
                from app.agent.runtime.store import store as default_store
                default_store.delete(session_id)
            except Exception:
                pass
        return True

    async def wait_idle(self, session_id: str, timeout: Optional[float] = None) -> bool:
        lp = self._loops.get(session_id)
        if lp is None:
            return True
        await lp.wait_idle(timeout=timeout)
        return not lp.is_running()


agent_manager = AgentManager()
