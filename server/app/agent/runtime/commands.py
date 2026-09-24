# -*- coding: utf-8 -*-
"""免模型命令 — / 开头的人用指令，不产生模型轮次（对标 dsh commands）。

在 AgentLoop.prompt 入口拦截；未匹配的命令返回 None，照常交给模型。
"""
from __future__ import annotations

from typing import Optional

HELP_TEXT = """可用命令：
/status —— 查看当前会话状态（模式/目标/轮次/token 用量）
/plan —— 切换到计划模式（只读侦察+出计划）
/plan off —— 退出计划模式
/goal <目标描述> —— 设定长期目标（整集批量/一键成片），完成后自动停止
/goal —— 查看当前目标；/goal off 取消目标
/compact —— 立即压缩上下文
/cancel —— 取消当前任务与排队输入
/help —— 显示本帮助"""


async def execute_command(loop, text: str) -> Optional[str]:
    t = (text or "").strip()
    if not t.startswith("/"):
        return None
    parts = t.split(maxsplit=1)
    cmd = parts[0].lower()
    arg = (parts[1].strip() if len(parts) > 1 else "")

    if cmd == "/help":
        return HELP_TEXT

    if cmd == "/status":
        from app.agent.runtime.token_meter import pressure_of
        try:
            from app.agent.mode_policy import behavior_of, execution_of
            _beh, _exe = behavior_of(loop.run_mode), execution_of(loop.run_mode)
        except Exception:
            _beh = "plan" if loop.plan_mode else "standard"
            _exe = "auto" if str(loop.run_mode).endswith("auto") else "approve"
        _beh_label = {"standard": "标准", "create": "创造", "plan": "计划（只读）"}.get(_beh, _beh)
        _exe_label = {"approve": "审批", "auto": "自动"} .get(_exe, _exe)
        p = pressure_of(loop.session)
        goal = loop.goal
        goal_line = (f"目标: {goal.objective}（轮次 {goal.rounds_started}/{goal.max_rounds}，{goal.phase}）"
                     if goal else "目标: 无")
        return (
            f"会话: {loop.session.id}\n"
            f"模式: 行为={_beh_label} · 执行={_exe_label} · {loop.mode}\n"
            f"{goal_line}\n"
            f"事件数: {loop.session.seq} · 估算输入: {p['estimated_input']} tokens / 窗口 {p['window']}\n"
            f"排队输入: {loop.inbox.pending_count()} · 运行中: {'是' if loop.is_running() else '否'}"
        )

    if cmd == "/plan":
        if arg.strip().lower() == "off":
            loop.set_run_mode(getattr(loop, "_pre_plan_run_mode", "approve") or "approve")
            return "已退出计划模式，恢复进入前的行为模式。"
        loop.set_run_mode("plan")
        return "已进入计划模式：我只会只读侦察并输出计划，不会执行任何变更。"

    if cmd == "/goal":
        if not arg or arg.strip().lower() == "off":
            loop.clear_goal()
            return "目标已清除。"
        g = loop.set_goal(arg)
        # 立即启动第一轮
        loop.inbox.followup(g.reminder(), source="goal")
        return f"目标已设定（最多 {g.max_rounds} 轮）：{g.objective}\n我会自动续跑，完成后停止。"

    if cmd == "/compact":
        from app.agent.runtime.compaction import maybe_compact, maybe_prune_tool_results
        n = maybe_prune_tool_results(loop.session)
        ev = await maybe_compact(loop.session, emit=loop._emit)
        if ev:
            return f"上下文已压缩（剪裁 {n} 条工具结果，摘要已写入会话日志）。"
        return f"当前压力未达压缩阈值（剪裁 {n} 条超大工具结果）。"

    if cmd == "/cancel":
        await loop.abort("user")
        return "⏹️ 已取消当前任务与排队输入。"

    return None
