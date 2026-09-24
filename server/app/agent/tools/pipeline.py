# -*- coding: utf-8 -*-
"""工具执行管线 — pre(审批/门控) → execute(超时) → post(裁剪/溢写/哨兵)。

对标 dsh 的分层：审批、超时、结果裁剪、重复提醒都是管线内的独立环节，
循环本身不写任何工具特判。所有结果先落 tool/result 事件再进入模型历史。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.agent.tools.registry import tool_timeout, PLAN_READONLY_TOOLS
from app.agent.runtime import events as E


@dataclass
class ToolOutcome:
    call_id: str
    name: str
    status: str  # success | error | denied | blocked
    result: Any = None
    error: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    model_content: str = ""
    additional_context: Optional[str] = None


def is_destructive(name: str, args: Dict[str, Any]) -> bool:
    """破坏性调用：删源 / 删画布节点 / 可信 fs 写操作 / shell 执行。

    注意：这里的判定与 `mode_policy.TOOL_RISK` 是**两道并联的门**（见下方 need_confirm），
    命中任一即需人审。删节点在风险表里已是 high，这里再列一次是刻意显式化
    「这是破坏性动作」的语义，方便后续给前端标 HITL 徽标时不必反查风险表。
    """
    if name in ("shell_exec", "delete_custom_provider", "canvas_delete_node"):
        return True
    if name == "fs_file":
        return str((args or {}).get("action", "")).lower() in ("write", "append", "delete")
    return False


def _risk(name: str) -> str:
    try:
        from app.agent.mode_policy import tool_risk
        return tool_risk(name)
    except Exception:
        return "medium"


def _spill_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_spills"
    except Exception:
        base = Path("storage") / "agent_spills"
    base.mkdir(parents=True, exist_ok=True)
    return base


class ApprovalService:
    """人审接缝：ask/never 策略 + fail-closed。无交互通道时 ask=拒绝。"""

    def __init__(self, session_id: str, emit, policy: str = "ask", interactive: bool = True,
                 timeout_s: Optional[float] = None):
        self.session_id = session_id
        self.emit = emit
        self.policy = policy if policy in ("ask", "never") else "ask"
        self.interactive = bool(interactive)
        try:
            self.timeout_s = float(timeout_s or os.environ.get("AGENT_APPROVAL_TIMEOUT") or 120)
        except Exception:
            self.timeout_s = 120.0
        self._pending: Dict[str, asyncio.Future] = {}

    async def request(self, tool_name: str, arguments: Dict[str, Any], reason: str = "") -> bool:
        if self.policy == "never":
            return False
        if not self.interactive:
            return False
        aid = f"appr_{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[aid] = fut
        try:
            await self.emit({
                "event": "approval_required",
                "approval_id": aid,
                "tool_name": tool_name,
                "arguments": arguments,
                "reason": reason,
            })
            try:
                return bool(await asyncio.wait_for(fut, timeout=self.timeout_s))
            except asyncio.TimeoutError:
                return False
        finally:
            self._pending.pop(aid, None)

    def resolve(self, approval_id: str, approved: bool) -> bool:
        fut = self._pending.get(approval_id)
        if fut is None or fut.done():
            return False
        try:
            fut.set_result(bool(approved))
            return True
        except Exception:
            return False

    def resolve_all(self, approved: bool) -> List[str]:
        """一次性裁决全部挂起审批（如切到自动执行时放行）。

        返回已成功裁决的 approval_id 列表；调用方负责补发 approval_ack 事件，
        否则前端行内审批卡会因收不到回执而残留。
        """
        resolved: List[str] = []
        for aid in list(self._pending.keys()):
            if self.resolve(aid, approved):
                resolved.append(aid)
        return resolved


class RepeatToolGuard:
    """重复调用/连续失败哨兵：只提醒不拦截（第 3/5/8 次注入 context）。"""

    def __init__(self, thresholds=(3, 5, 8)):
        self.thresholds = tuple(sorted(int(t) for t in thresholds))
        self._last_sig: Optional[str] = None
        self._count = 0
        self._fail_streak: Dict[str, int] = {}

    @staticmethod
    def _sig(name: str, args: Dict[str, Any]) -> str:
        try:
            return name + "|" + json.dumps(args or {}, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            return f"{name}|{args}"

    def observe(self, name: str, args: Dict[str, Any], status: str) -> Optional[str]:
        """返回需要注入下一步的提醒文本（或 None）。"""
        sig = self._sig(name, args)
        if sig == self._last_sig:
            self._count += 1
        else:
            self._last_sig = sig
            self._count = 1
        if status == "success":
            self._fail_streak[name] = 0
        else:
            self._fail_streak[name] = self._fail_streak.get(name, 0) + 1

        notes: List[str] = []
        if self._count in self.thresholds:
            notes.append(
                f"⚠️ 检测到工具 `{name}` 已连续第 {self._count} 次使用完全相同的参数。"
                "若结果未变化，请换源/换参数/换策略，不要重复提交同一调用。"
            )
        fs = self._fail_streak.get(name, 0)
        if fs in (3, 5):
            notes.append(
                f"⚠️ 工具 `{name}` 已连续失败 {fs} 次。请先用只读工具排查（get_provider_code / list_* / canvas_query），"
                "或改用其他工具达成同一目标；不要继续盲目重试。"
            )
        return "\n".join(notes) if notes else None

    def reset(self) -> None:
        self._last_sig = None
        self._count = 0
        self._fail_streak.clear()


def _summarize_result(name: str, result: Any, max_chars: int = 4000) -> str:
    """把工具结果压成模型可消化的文本；超大结果溢写磁盘后只留头尾+locator。"""
    try:
        raw = json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        raw = str(result)
    if len(raw) <= max_chars:
        return raw

    # list_custom_providers：剔除 code 全文
    if name == "list_custom_providers" and isinstance(result, dict) and "providers" in result:
        try:
            brief = []
            for p in result.get("providers") or []:
                if not isinstance(p, dict):
                    continue
                brief.append({
                    "id": p.get("id"), "name": p.get("name"), "kind": p.get("kind"),
                    "params": list((p.get("params_schema") or {}).get("properties", {}).keys()) if isinstance(p.get("params_schema"), dict) else [],
                    "input": list((p.get("input_schema") or {}).get("properties", {}).keys()) if isinstance(p.get("input_schema"), dict) else [],
                    "enabled": p.get("enabled"),
                    "description": (p.get("description") or "")[:80],
                })
            s = json.dumps({"total": result.get("total"), "providers_brief": brief,
                            "_note": "已剔除 code 全文；如需代码请调用 get_provider_code"}, ensure_ascii=False)
            return s[:max_chars] + "…(truncated)" if len(s) > max_chars else s
        except Exception:
            pass

    # get_provider_code：分页窗口请求保留完整窗口（limit≤6000）；未分页则压成预览
    if name == "get_provider_code" and isinstance(result, dict) and "code" in result:
        try:
            if "code_total_len" in result:
                s = json.dumps(result, ensure_ascii=False, default=str)
                return s[:7600] + ("…(truncated)" if len(s) > 7600 else "")
            code = result.get("code") or ""
            summarized = {k: v for k, v in result.items() if k != "code"}
            summarized["code_preview"] = code[:800] + (f"…(共{len(code)}字符)" if len(code) > 800 else "")
            s = json.dumps(summarized, ensure_ascii=False)
            return s[:max_chars] + "…(truncated)" if len(s) > max_chars else s
        except Exception:
            pass

    half = max(0, max_chars // 2)
    return raw[:half] + f"\n…(已截断，原文 {len(raw)} 字符，全文见溢写文件)…\n" + (raw[-half:] if half else "")


def _spill_full(session_id: str, call_id: str, name: str, payload: str) -> Optional[str]:
    try:
        d = _spill_dir() / re.sub(r"[^A-Za-z0-9_.\-]", "_", session_id or "default")
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{int(time.time())}_{name}_{call_id[:16]}.json"
        p.write_text(payload, encoding="utf-8")
        return str(p)
    except Exception:
        return None


class ToolPipeline:
    """单会话的工具执行器：计划模式门控 + 审批 + 超时 + 裁剪 + 哨兵。"""

    SPILL_CHARS = 8000

    def __init__(self, session_id: str, emit, plan_mode: bool = False,
                 approval_policy: str = "ask", interactive: bool = True, session=None):
        self.session_id = session_id
        self.emit = emit
        self.plan_mode = bool(plan_mode)
        self.session = session
        self.approvals = ApprovalService(session_id, emit, policy=approval_policy, interactive=interactive)
        self.guard = RepeatToolGuard()

    def resolve_approval(self, approval_id: str, approved: bool) -> bool:
        return self.approvals.resolve(approval_id, approved)

    async def execute(self, call_id: str, name: str, args: Dict[str, Any],
                      project_context: Any = None, run_mode: str = "approve",
                      auto_approved: bool = False) -> ToolOutcome:
        args = args if isinstance(args, dict) else {}
        # 运行模式两维：行为（standard/create/plan）× 执行（approve/auto），见 app.agent.mode_policy
        try:
            from app.agent.mode_policy import behavior_of as _behavior_of, execution_of as _execution_of
            _behavior, _execution = _behavior_of(run_mode), _execution_of(run_mode)
        except Exception:
            _behavior = "plan" if str(run_mode).startswith("plan") else ("create" if str(run_mode).startswith("create") else "standard")
            _execution = "auto" if str(run_mode).endswith("auto") else "approve"
        # ① 计划模式硬门控：只读白名单之外一律拒绝（含全部内部变更工具）
        if (self.plan_mode or _behavior == "plan") and name not in PLAN_READONLY_TOOLS:
            msg = f"计划模式只允许只读工具，已拦截 {name}（本轮不执行任何变更）"
            return ToolOutcome(call_id, name, "denied", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ② 内置工具：todo_write 直接写会话事件（不经过 MCP）
        if name == "todo_write":
            items = args.get("items") if isinstance(args, dict) else None
            if not isinstance(items, list) or not items:
                msg = "todo_write 需要非空 items 数组"
                return ToolOutcome(call_id, name, "error", error=msg,
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))
            normalized = []
            seen = set()
            for it in items[:50]:
                if not isinstance(it, dict):
                    continue
                content = str(it.get("content") or "").strip()
                status = str(it.get("status") or "pending")
                if not content or content in seen:
                    continue
                seen.add(content)
                if status not in ("pending", "in_progress", "completed"):
                    status = "pending"
                normalized.append({"content": content[:200], "status": status})
            if self.session is not None:
                self.session.append(E.TODO_WRITE, {"items": normalized})
            counts = {
                "total": len(normalized),
                "completed": sum(1 for x in normalized if x["status"] == "completed"),
                "in_progress": sum(1 for x in normalized if x["status"] == "in_progress"),
                "pending": sum(1 for x in normalized if x["status"] == "pending"),
            }
            return ToolOutcome(call_id, name, "success", result=counts,
                               model_content=json.dumps(counts, ensure_ascii=False))

        # ③ 内置工具：后台任务 / 子代理 / 批量流水线
        if name in ("job_start", "job_list", "job_status", "job_cancel"):
            jobs = getattr(self, "jobs", None)
            if jobs is None:
                msg = "后台任务服务未就绪"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            if name == "job_start":
                result = jobs.start(str(args.get("tool") or ""), args.get("arguments") or {}, project_context, run_mode)
            elif name == "job_list":
                result = jobs.list()
            elif name == "job_status":
                result = jobs.get(str(args.get("job_id") or ""))
            else:
                result = await jobs.cancel(str(args.get("job_id") or ""))
            if isinstance(result, dict) and result.get("error"):
                return ToolOutcome(call_id, name, "error", error=str(result["error"]),
                                   model_content=json.dumps(result, ensure_ascii=False))
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(result, ensure_ascii=False, default=str)[:4000])

        if name == "subagent_run":
            parent = getattr(self, "subagent_parent", None)
            task = str(args.get("task") or "").strip()
            if parent is None or not task:
                msg = "子代理服务未就绪或 task 为空"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            try:
                ms = max(5, min(int(args.get("max_steps") or 40), 120))
            except Exception:
                ms = 40
            from app.agent.runtime.subagent import run_subagent
            result = await run_subagent(parent, task, max_steps=ms)
            if result.get("status") != "success":
                return ToolOutcome(call_id, name, "error", error=str(result.get("error") or "子代理失败"),
                                   result=result, model_content=json.dumps(result, ensure_ascii=False)[:4000])
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(result, ensure_ascii=False)[:8000])

        if name == "batch_run":
            tool = str(args.get("tool") or "").strip()
            items = args.get("items") or []
            if not tool or not isinstance(items, list) or not items:
                msg = "batch_run 需要 tool 与非空 items"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            if len(items) > 3 and _execution != "auto" and not auto_approved:
                ok = await self.approvals.request("batch_run", {"tool": tool, "count": len(items)},
                                                  reason=f"批量执行 {len(items)} 项 {tool}")
                if not ok:
                    msg = f"用户拒绝或不可交互，已跳过批量执行 {tool}"
                    return ToolOutcome(call_id, name, "denied", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            from app.agent.runtime.batch import run_batch

            async def _one(cid, t, a, ctx, rm):
                return await self.execute(cid, t, a, ctx, rm, auto_approved=True)

            result = await run_batch(_one, tool, items, int(args.get("concurrency") or 3))
            if result.get("status") == "error":
                return ToolOutcome(call_id, name, "error", error=str(result.get("error")),
                                   model_content=json.dumps(result, ensure_ascii=False))
            brief = {k: result.get(k) for k in ("tool", "total", "success", "failed")}
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(brief, ensure_ascii=False) + "\n" +
                               json.dumps(result, ensure_ascii=False, default=str)[:6000])

        # ③.5 异步生成任务（TaskCenter）：状态 / 续等 / 取消
        if name in ("task_status", "task_wait", "task_cancel"):
            from app.providers.tasks import task_center
            tid = str(args.get("task_id") or "").strip()
            if not tid:
                msg = f"{name} 需要 task_id"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            if name == "task_status":
                rec = task_center.status(tid)
                if rec is None:
                    msg = f"任务不存在: {tid}"
                    return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
                data = rec.to_dict()
            elif name == "task_cancel":
                data = await task_center.cancel(tid)
                if isinstance(data, dict) and data.get("error"):
                    return ToolOutcome(call_id, name, "error", error=str(data["error"]),
                                       model_content=json.dumps(data, ensure_ascii=False))
            else:
                try:
                    to = max(5, min(int(args.get("timeout_s") or 1200), 1800))
                except Exception:
                    to = 1200
                rec = await task_center.wait(tid, timeout_s=to)
                data = rec.to_dict()
                if rec.status == "FAILED":
                    return ToolOutcome(call_id, name, "error", error=rec.error or "任务失败", result=data,
                                       model_content=json.dumps(data, ensure_ascii=False, default=str)[:4000])
            return ToolOutcome(call_id, name, "success", result=data,
                               model_content=json.dumps(data, ensure_ascii=False, default=str)[:6000])

        # ④ 人审：破坏性调用 / 模式策略要求的高风险调用
        need_confirm = is_destructive(name, args)
        if not need_confirm:
            try:
                from app.agent.mode_policy import requires_confirm as _rc
                need_confirm = _rc(name, run_mode, True)
            except Exception:
                need_confirm = _risk(name) in ("high", "catastrophic")
        # plan 只读 / auto 自动执行：不弹确认（两维各自硬门控；风险由前端危险态明示 + 随时暂停兜底）
        if need_confirm and _behavior != "plan" and _execution != "auto" and not auto_approved:
            ok = await self.approvals.request(name, args, reason=f"risk={_risk(name)} mode={run_mode}")
            if not ok:
                msg = f"用户拒绝或不可交互，已跳过需确认的工具 {name}"
                return ToolOutcome(call_id, name, "denied", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ⑤ 执行（带 per-tool 超时）
        timeout = tool_timeout(name)
        try:
            from app.mcp.server import mcp_registry
            res = await asyncio.wait_for(
                mcp_registry.execute_tool(name, args, project_context=project_context),
                timeout=timeout,
            )
            status = getattr(res, "status", "error")
            result = getattr(res, "result", None)
            error = getattr(res, "error", None)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            status, result, error = "error", None, f"工具 {name} 执行超时（{timeout}s）"
        except Exception as e:
            status, result, error = "error", None, str(e)

        # ④ 裁剪 / 溢写
        meta: Dict[str, Any] = {}
        if status == "success":
            raw = _summarize_result(name, result, self.SPILL_CHARS)
            model_content = raw
            if len(raw) >= self.SPILL_CHARS:
                full = _spill_full(self.session_id, call_id, name, json.dumps(result, ensure_ascii=False, default=str))
                if full:
                    meta["spill_path"] = full
                    model_content = raw + f"\n[全文溢写: {full}（可用 fs_file read 查看）]"
        else:
            model_content = json.dumps({"error": error or "工具执行失败"}, ensure_ascii=False)

        outcome = ToolOutcome(
            call_id=call_id, name=name, status=status, result=result, error=error,
            meta=meta, model_content=model_content,
        )
        # ⑤ 哨兵提醒（只建议不拦截）
        note = self.guard.observe(name, args, status)
        if note:
            outcome.additional_context = note
        return outcome
