# -*- coding: utf-8 -*-
"""工具执行管线 — pre(审批/门控) → execute(超时) → post(裁剪/溢写/哨兵)。

对标 dsh 的分层：审批、超时、结果裁剪、重复提醒都是管线内的独立环节，
循环本身不写任何工具特判。所有结果先落 tool/result 事件再进入模型历史。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.agent.tools.registry import tool_timeout, PLAN_READONLY_TOOLS
from app.agent.runtime import events as E

logger = logging.getLogger(__name__)


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


# ── 提示词技能：只做建议，不做执行口拦截 ─────────────────────
# 历史上有「未读技能一律拒绝生成调用」的硬门控，会卡住正常的生成流程；
# 现已解除：技能阅读由提示词引导（read_skill 可随时调用），生成工具不再因未读技能被拒。


def _spill_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_spills"
    except Exception:
        base = Path("storage") / "agent_spills"
    base.mkdir(parents=True, exist_ok=True)
    return base


# 审批裁决 → 归因文案（进日志、进模型错误、进 meta，缺一就没法事后复盘"谁拒的"）
APPROVAL_VERDICT_TEXT = {
    "rejected": "用户在确认框点了拒绝",
    "timeout": "确认框无人应答已超时",
    "non_interactive": "当前通道无交互（fail-closed 一律按拒绝）",
    "disabled": "审批策略已关闭（policy=never）",
}


# ── 扩展缝：pre/post tool hooks（对标 dsh tools/pre-execute、tools/post-execute）──
# 内置管线保持开箱即用；hooks 让外部（插件/用户脚本）在工具执行前后叠加决策：
#   PreToolUse：deny（拒绝执行）；PostToolUse：deny（把成功结果替换为失败/反馈）。
# 两个来源：storage/agent_hooks/hooks.json（外部命令，与 CC hooks 同形）与进程内注册函数。
_GLOBAL_PRE_HOOKS: List[Any] = []
_GLOBAL_POST_HOOKS: List[Any] = []
_CONFIG_HOOKS_CACHE: Dict[str, Any] = {"mtime": -1.0, "data": {}}


def register_pre_hook(fn: Any) -> None:
    """注册进程内 pre-tool hook：async fn(name, args, pipeline) -> {"decision": "deny", "reason": str} | None。"""
    if callable(fn) and fn not in _GLOBAL_PRE_HOOKS:
        _GLOBAL_PRE_HOOKS.append(fn)


def unregister_pre_hook(fn: Any) -> None:
    try:
        _GLOBAL_PRE_HOOKS.remove(fn)
    except ValueError:
        pass


def register_post_hook(fn: Any) -> None:
    """注册进程内 post-tool hook：async fn(name, args, outcome) -> {"decision": "deny", "reason": str, "additional_context": str} | None。"""
    if callable(fn) and fn not in _GLOBAL_POST_HOOKS:
        _GLOBAL_POST_HOOKS.append(fn)


def unregister_post_hook(fn: Any) -> None:
    try:
        _GLOBAL_POST_HOOKS.remove(fn)
    except ValueError:
        pass


def _hooks_config_path() -> Optional[str]:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_hooks"
    except Exception:
        base = Path("storage") / "agent_hooks"
    p = base / "hooks.json"
    try:
        return str(p) if p.exists() else None
    except Exception:
        return None


def _load_config_hooks() -> Dict[str, List[Dict[str, Any]]]:
    """读取 hooks.json（mtime 缓存）：{"PreToolUse": [{"matcher","command","timeout_s"}], "PostToolUse": [...]}。

    文件不存在 → {}（零成本、零风险）；读取/解析失败 → 空表并告警一次（fail-open 不阻断生成链）。
    """
    p = _hooks_config_path()
    if not p:
        return {}
    try:
        mtime = os.path.getmtime(p)
    except Exception:
        return {}
    cached = _CONFIG_HOOKS_CACHE.get("data") or {}
    if _CONFIG_HOOKS_CACHE.get("mtime") == mtime:
        return cached
    data: Dict[str, List[Dict[str, Any]]] = {}
    try:
        raw = json.loads(Path(p).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for key in ("PreToolUse", "PostToolUse"):
                items = raw.get(key)
                if isinstance(items, list):
                    data[key] = [it for it in items if isinstance(it, dict) and str(it.get("command") or "").strip()]
    except Exception as e:
        try:
            print(f"[AgentHooks] hooks.json 解析失败（本次忽略）: {e}")
        except Exception:
            pass
        data = {}
    _CONFIG_HOOKS_CACHE["mtime"] = mtime
    _CONFIG_HOOKS_CACHE["data"] = data
    return data


def _matcher_ok(matcher: Any, name: str) -> bool:
    m = str(matcher or "*").strip()
    if not m or m == "*":
        return True
    try:
        import fnmatch
        return fnmatch.fnmatchcase(name, m)
    except Exception:
        return False


class QuestionService:
    """模型面向用户的结构化问询（对齐 dsh user-questions）——不是审批，是"多选项提问"。

    fail-closed：无交互通道 / 超时 → no_answer（调用方据此引导模型按假设继续或改文本提问）。
    事件：question/asked + question/answered 落账；实时 event=question_required 供前端出选项卡。
    """

    def __init__(self, session_id: str, emit, interactive: bool = True,
                 timeout_s: Optional[float] = None, session: Any = None):
        self.session_id = session_id
        self.emit = emit
        self.interactive = bool(interactive)
        self.session = session
        try:
            self.timeout_s = float(timeout_s or os.environ.get("AGENT_QUESTION_TIMEOUT") or 300)
        except Exception:
            self.timeout_s = 300.0
        self._pending: Dict[str, asyncio.Future] = {}

    def _log(self, event_type: str, data: Dict[str, Any]) -> None:
        if self.session is None:
            return
        try:
            self.session.append(event_type, data)
        except Exception:
            pass

    async def request(self, question: str, options: Optional[List[str]] = None,
                      multi_select: bool = False, detail: str = "") -> Dict[str, Any]:
        qid = f"q_{uuid.uuid4().hex[:8]}"
        options = [str(o)[:200] for o in (options or []) if str(o).strip()][:8]
        self._log(E.QUESTION_ASKED, {
            "question_id": qid, "question": str(question)[:2000],
            "options": options, "multi_select": bool(multi_select),
        })
        result: Dict[str, Any] = {"question_id": qid, "outcome": "no_answer",
                                  "selections": [], "custom": ""}
        if not self.interactive:
            result["outcome"] = "no_interactive"
        else:
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._pending[qid] = fut
            try:
                await self.emit({
                    "event": "question_required",
                    "question_id": qid,
                    "question": str(question)[:2000],
                    "options": options,
                    "multi_select": bool(multi_select),
                    "detail": str(detail or "")[:1000],
                })
                try:
                    ans = await asyncio.wait_for(fut, timeout=self.timeout_s)
                except asyncio.TimeoutError:
                    ans = None
            finally:
                self._pending.pop(qid, None)
            if isinstance(ans, dict):
                result["outcome"] = "answered"
                result["selections"] = [str(s)[:200] for s in (ans.get("selections") or [])][:8]
                result["custom"] = str(ans.get("custom") or "")[:2000]
            else:
                result["outcome"] = "timeout"
        self._log(E.QUESTION_ANSWERED, {
            "question_id": qid, "outcome": result["outcome"],
            "selections": result["selections"], "custom": result["custom"],
        })
        return result

    def resolve(self, question_id: str, selections: Optional[List[str]] = None,
                custom: str = "") -> bool:
        fut = self._pending.get(question_id)
        if fut is None or fut.done():
            return False
        try:
            fut.set_result({"selections": list(selections or []), "custom": custom or ""})
            return True
        except Exception:
            return False


class ApprovalService:
    """人审接缝：ask/never 策略 + fail-closed。无交互通道时 ask=拒绝。"""

    def __init__(self, session_id: str, emit, policy: str = "ask", interactive: bool = True,
                 timeout_s: Optional[float] = None, session=None):
        self.session_id = session_id
        self.emit = emit
        self.policy = policy if policy in ("ask", "never") else "ask"
        self.interactive = bool(interactive)
        self.session = session
        try:
            self.timeout_s = float(timeout_s or os.environ.get("AGENT_APPROVAL_TIMEOUT") or 120)
        except Exception:
            self.timeout_s = 120.0
        self._pending: Dict[str, asyncio.Future] = {}

    def _log(self, event_type: str, data: Dict[str, Any]) -> None:
        """审批留痕：仅 emit 不落账就无法区分"人拒了"和"没人答"。记账失败绝不阻断执行。"""
        if self.session is None:
            return
        try:
            self.session.append(event_type, data)
        except Exception:
            pass

    async def request(self, tool_name: str, arguments: Dict[str, Any], reason: str = "") -> str:
        """请求人审，返回裁决：approved | rejected | timeout | non_interactive | disabled。"""
        aid = f"appr_{uuid.uuid4().hex[:8]}"
        if self.policy == "never":
            verdict = "disabled"
        elif not self.interactive:
            verdict = "non_interactive"
        else:
            verdict = ""
        self._log(E.APPROVAL_ASKED, {
            "approval_id": aid, "tool_name": tool_name, "arguments": arguments or {}, "reason": reason,
        })
        if verdict:
            self._log(E.APPROVAL_DECIDED, {
                "approval_id": aid, "approved": False, "reason": verdict,
            })
            return verdict
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
                ok = bool(await asyncio.wait_for(fut, timeout=self.timeout_s))
            except asyncio.TimeoutError:
                verdict = "timeout"
            else:
                verdict = "approved" if ok else "rejected"
        finally:
            self._pending.pop(aid, None)
        self._log(E.APPROVAL_DECIDED, {
            "approval_id": aid, "approved": verdict == "approved", "reason": verdict,
        })
        return verdict

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
                 approval_policy: str = "ask", interactive: bool = True, session=None,
                 agent_profile=None):
        self.session_id = session_id
        self.emit = emit
        self.plan_mode = bool(plan_mode)
        self.session = session
        self.agent_profile = agent_profile
        self.approvals = ApprovalService(session_id, emit, policy=approval_policy,
                                         interactive=interactive, session=session)
        self.questions = QuestionService(session_id, emit, interactive=interactive, session=session)
        self.guard = RepeatToolGuard()
        # 已成功读取的技能名（提示词技能门：读一个即解锁本会话生成/写提示词调用）
        self.skills_read: set = set()
        # 扩展缝（实例级 hooks；与模块级 _GLOBAL_* 合并执行）
        self._pre_hooks: List[Any] = []
        self._post_hooks: List[Any] = []

    def resolve_approval(self, approval_id: str, approved: bool) -> bool:
        return self.approvals.resolve(approval_id, approved)

    def resolve_question(self, question_id: str, selections: Optional[List[str]] = None,
                         custom: str = "") -> bool:
        return self.questions.resolve(question_id, selections, custom)

    async def _ask_user(self, call_id: str, args: Dict[str, Any]) -> "ToolOutcome":
        """ask_user_question 内置工具：结构化多选项问询（fail-closed，不阻塞主流程）。"""
        q = str(args.get("question") or "").strip()
        if not q:
            msg = "ask_user_question 需要非空 question"
            return ToolOutcome(call_id, "ask_user_question", "error", error=msg,
                               model_content=json.dumps({"error": msg}, ensure_ascii=False))
        raw_opts = args.get("options")
        options = [str(o).strip()[:200] for o in raw_opts if str(o).strip()][:8] if isinstance(raw_opts, list) else []
        self.questions.interactive = bool(getattr(self.approvals, "interactive", True))
        res = await self.questions.request(
            q, options, multi_select=bool(args.get("multi_select")), detail=str(args.get("detail") or ""),
        )
        if res.get("outcome") != "answered":
            note = {
                "no_interactive": "当前通道无交互，无法等待用户回答。不要重复提问；按最合理解读继续，并在结论里说明假设。",
                "timeout": "用户未在时限内回答。不要重复等待；按最合理默认继续，并在结论里说明假设。",
            }.get(str(res.get("outcome")), "用户未回答。不要重复提问；按最合理解读继续。")
            payload = {**res, "note": note}
            return ToolOutcome(call_id, "ask_user_question", "success", result=payload,
                               model_content=json.dumps(payload, ensure_ascii=False))
        return ToolOutcome(call_id, "ask_user_question", "success", result=res,
                           model_content=json.dumps(res, ensure_ascii=False))

    # ── 扩展缝：pre/post hook 执行 ─────────────────────────
    async def _run_command_hook(self, phase: str, hk: Dict[str, Any], name: str,
                                args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """运行一个外部命令 hook：stdin 收 JSON 事件，exit 2 = 拦截；stdout JSON 可给决策。

        fail-open：命令执行失败/超时一律放行（外部脚本错误不得阻断生成链）。
        """
        try:
            payload = json.dumps({
                "event": phase, "tool_name": name,
                "arguments": args if isinstance(args, dict) else {},
                "session_id": self.session_id,
            }, ensure_ascii=False)
            proc = await asyncio.create_subprocess_shell(
                str(hk.get("command")),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                out_b, err_b = await asyncio.wait_for(
                    proc.communicate(payload.encode("utf-8")),
                    timeout=float(hk.get("timeout_s") or 30),
                )
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                return None
            out = (out_b or b"").decode(errors="ignore").strip()
            err = (err_b or b"").decode(errors="ignore").strip()
            if proc.returncode == 2:
                return {"deny": True, "reason": err or out or "hook 拦截"}
            if out.startswith("{"):
                try:
                    d = json.loads(out)
                    dec = str(d.get("decision") or "").lower()
                    return {
                        "deny": dec in ("deny", "block", "reject"),
                        "reason": str(d.get("reason") or err or ""),
                        "additional_context": d.get("additional_context") or d.get("additionalContext") or None,
                    }
                except Exception:
                    return None
            return None
        except Exception:
            return None

    async def _run_pre_hooks(self, name: str, args: Dict[str, Any]) -> Optional[str]:
        """返回拒绝原因（None = 放行）。"""
        for hk in _load_config_hooks().get("PreToolUse", []):
            if not _matcher_ok(hk.get("matcher"), name):
                continue
            verdict = await self._run_command_hook("PreToolUse", hk, name, args)
            if verdict and verdict.get("deny"):
                return str(verdict.get("reason") or "pre-hook 拒绝")[:300]
        for fn in list(_GLOBAL_PRE_HOOKS) + list(self._pre_hooks):
            try:
                r = fn(name, args, self)
                if asyncio.iscoroutine(r):
                    r = await r
                if isinstance(r, dict) and str(r.get("decision") or "") == "deny":
                    return str(r.get("reason") or "pre-hook 拒绝")[:300]
            except Exception:
                continue
        return None

    async def _apply_post_hooks(self, name: str, args: Dict[str, Any],
                                outcome: "ToolOutcome") -> "ToolOutcome":
        """post-hook：deny → 把结果改写为失败反馈；additional_context 合并注入。"""
        contexts: List[str] = []
        blocked_reason = ""
        for hk in _load_config_hooks().get("PostToolUse", []):
            if not _matcher_ok(hk.get("matcher"), name):
                continue
            verdict = await self._run_command_hook("PostToolUse", hk, name, args)
            if not verdict:
                continue
            if verdict.get("additional_context"):
                contexts.append(str(verdict["additional_context"])[:2000])
            if verdict.get("deny"):
                blocked_reason = str(verdict.get("reason") or "post-hook 拦截")[:300]
                break
        if not blocked_reason:
            for fn in list(_GLOBAL_POST_HOOKS) + list(self._post_hooks):
                try:
                    r = fn(name, args, outcome)
                    if asyncio.iscoroutine(r):
                        r = await r
                    if not isinstance(r, dict):
                        continue
                    if r.get("additional_context"):
                        contexts.append(str(r["additional_context"])[:2000])
                    if str(r.get("decision") or "") == "deny":
                        blocked_reason = str(r.get("reason") or "post-hook 拦截")[:300]
                        break
                except Exception:
                    continue
        if blocked_reason:
            msg = f"工具 {name} 的结果被 hook 拦截：{blocked_reason}"
            blocked = ToolOutcome(name=name, call_id=outcome.call_id, status="error",
                                  error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            if contexts:
                blocked.additional_context = "\n".join(contexts)
            return blocked
        if contexts:
            note = "\n".join(contexts)
            outcome.additional_context = (f"{outcome.additional_context}\n{note}" if outcome.additional_context else note)
        return outcome

    async def execute(self, call_id: str, name: str, args: Dict[str, Any],
                      project_context: Any = None, run_mode: str = "approve",
                      auto_approved: bool = False) -> ToolOutcome:
        args = args if isinstance(args, dict) else {}
        # 运行模式两维：行为（standard/create/plan）× 执行（approve/auto）
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

        # ①.2 项目级权限：模式只决定自动程度，具体 allow/ask/deny 由 ProjectPolicy 决定
        try:
            from app.agent.policy import permission_decision, policy_from_context
            _policy = policy_from_context(project_context)
            _decision = permission_decision(name, args, run_mode, _policy)
        except Exception:
            _policy = {}
            _decision = "ask" if _risk(name) in ("medium", "high", "catastrophic") else "allow"
        if _decision == "deny":
            msg = f"项目权限禁止工具 {name}（项目设置 → 模型与权限）"
            return ToolOutcome(call_id, name, "denied", error=msg,
                               meta={"permission": "deny", "group": "policy"},
                               model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ①.5 子代理角色裁剪：执行口二次拒绝越权工具（角色约束靠代码，不靠提示词）
        _profile = getattr(self, "agent_profile", None)
        if _profile is not None and not _profile.allows(name):
            msg = f"工具 {name} 不在子代理角色（{_profile.name}）的能力范围内，已拒绝"
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
            # 推送给前端渲染待办清单（页面版/悬浮窗版按 session_id 自行分流）
            try:
                r = self.emit({"event": "todo_write", "items": normalized, "counts": counts})
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                pass
            return ToolOutcome(call_id, name, "success", result=counts,
                               model_content=json.dumps(counts, ensure_ascii=False))

        # ③ 内置工具：结构化问询（模型面向用户的选项卡提问，非审批）
        if name == "ask_user_question":
            return await self._ask_user(call_id, args)

        # ③ 内置工具：媒体查看（只读）——把画布节点产物/素材/URL 变成多模态附件
        if name == "view_media":
            from app.agent.runtime.attachments import sanitize_attachments
            collected: List[Dict[str, Any]] = []
            kind_hint = str(args.get("kind") or "").strip().lower()
            urls = args.get("urls") if isinstance(args.get("urls"), list) else []
            if args.get("url"):
                urls = [args["url"], *urls]
            for u in urls[:6]:
                if isinstance(u, str) and u.strip():
                    collected.append({"kind": kind_hint, "ref": u.strip(),
                                      "name": os.path.basename(u.split("?")[0]) or "media", "source": "url"})
            node_ids = args.get("node_ids") if isinstance(args.get("node_ids"), list) else []
            if args.get("node_id"):
                node_ids = [args["node_id"], *node_ids]
            if node_ids:
                pid = args.get("project_id") or (
                    (project_context or {}).get("id") if isinstance(project_context, dict) else None
                )
                try:
                    from app.providers.project.manager import project_manager as _pm
                    if not pid:
                        lst = _pm.list_projects()
                        if lst:
                            pid = lst[0].get("id")
                    snap = _pm.get_canvas(pid) if pid else None
                except Exception:
                    snap = None
                nodes = (snap or {}).get("nodes") or []
                by_id = {str(n.get("id")): n for n in nodes if isinstance(n, dict)}
                for nid in node_ids[:6]:
                    n = by_id.get(str(nid))
                    if not n:
                        continue
                    d = n.get("data") or {}
                    media_map = [
                        ("image", d.get("image_url") or d.get("result_url")),
                        ("image", d.get("first_frame") or d.get("first_frame_url")),
                        ("image", d.get("last_frame") or d.get("last_frame_url")),
                        ("video", d.get("video_url")),
                        ("audio", d.get("audio_url")),
                    ]
                    for kind, ref in media_map:
                        if isinstance(ref, str) and ref.strip():
                            collected.append({"kind": kind_hint or kind, "ref": ref.strip(),
                                              "name": f"{n.get('type') or '节点'}#{str(nid)[-4]}", "source": "canvas",
                                              "meta": {"node_id": str(nid)}})
                    for ref in (d.get("reference_images") or [])[:3] if isinstance(d.get("reference_images"), list) else []:
                        if isinstance(ref, str) and ref.strip():
                            collected.append({"kind": "image", "ref": ref.strip(),
                                              "name": f"参考图#{str(nid)[-4]}", "source": "canvas",
                                              "meta": {"node_id": str(nid)}})
            asset_ids = args.get("asset_ids") if isinstance(args.get("asset_ids"), list) else []
            if args.get("asset_id"):
                asset_ids = [args["asset_id"], *asset_ids]
            for aid in asset_ids[:6]:
                try:
                    from app.providers.asset.manager import asset_manager
                    a = asset_manager.get_asset(str(aid))
                    ref = getattr(a, "file_url", None) or getattr(a, "image_url", None) or getattr(a, "thumb_url", None)
                    if ref:
                        collected.append({"kind": kind_hint, "ref": str(ref),
                                          "name": getattr(a, "name", None) or str(aid), "source": "asset",
                                          "meta": {"asset_id": str(aid)}})
                except Exception:
                    continue
            try:
                from app.agent.runtime.attachments import expand_video_frames, sanitize_attachments
                collected = await asyncio.to_thread(expand_video_frames, collected)
            except Exception:
                from app.agent.runtime.attachments import sanitize_attachments
            atts = sanitize_attachments(collected)
            if not atts:
                msg = "view_media 未找到可用媒体（检查 node_id/asset_id/url；画布节点需已产出图/视频/音频）"
                return ToolOutcome(call_id, name, "error", error=msg,
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))
            brief = {"count": len(atts),
                     "items": [{k: a.get(k) for k in ("kind", "name", "ref")} for a in atts]}
            return ToolOutcome(
                call_id, name, "success", result=brief,
                meta={"media_attachments": atts},
                model_content=json.dumps(
                    {"loaded": brief["count"], "items": brief["items"],
                     "note": "媒体已作为多模态附件注入，下一步即可直接查看内容"},
                    ensure_ascii=False)[:2000],
            )

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
            if parent is None:
                msg = "子代理服务未就绪"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            agent = str(args.get("agent") or "generalist").strip().lower()
            from app.agent.runtime.agents import get_profile
            prof = get_profile(agent)
            batch = args.get("batch")
            # 三态背景：显式 background=true/false 优先；缺省按角色画像默认（多数同步阻塞）
            explicit_bg = "background" in args
            if explicit_bg:
                background = bool(args.get("background"))
            else:
                background = bool(getattr(prof, "background_default", False))
            auto_bg_ok = not (explicit_bg and not background)  # 显式要同步 → 禁止自动转后台
            try:
                ms = max(5, min(int(args.get("max_steps") or 0), 200)) or None
            except Exception:
                ms = None
            try:
                to = float(args.get("timeout_s") or 0) or None
            except Exception:
                to = None
            from app.agent.runtime.subagent import subagent_pool
            ctx_arg = args.get("context") if isinstance(args.get("context"), dict) else None
            out_schema = args.get("output_schema") if isinstance(args.get("output_schema"), dict) else None
            if isinstance(batch, list) and batch:
                result = await subagent_pool.spawn_batch(
                    parent, agent, batch, background=background, context=ctx_arg,
                    max_steps=ms, timeout_s=to, output_schema=out_schema)
            else:
                task = str(args.get("task") or "").strip()
                if not task:
                    msg = "subagent_run 需要 task（或 batch 数组）"
                    return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
                result = await subagent_pool.spawn(
                    parent, agent, task, context=ctx_arg, background=background,
                    max_steps=ms, timeout_s=to, auto_bg_ok=auto_bg_ok, output_schema=out_schema)
            if result.get("status") in ("error",):
                return ToolOutcome(call_id, name, "error", error=str(result.get("error") or "子代理失败"),
                                   result=result, model_content=json.dumps(result, ensure_ascii=False)[:4000])
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(result, ensure_ascii=False, default=str)[:6000])

        if name in ("subagent_status", "subagent_list", "subagent_cancel", "subagent_steer", "subagent_wait"):
            parent = getattr(self, "subagent_parent", None)
            from app.agent.runtime.subagent import subagent_pool
            if name == "subagent_list":
                result = {"subagents": subagent_pool.list(parent=parent, limit=int(args.get("limit") or 50))}
            elif name == "subagent_status":
                sid = str(args.get("subagent_id") or "")
                h = subagent_pool.get(sid)
                if h is None:
                    msg = f"子代理不存在: {sid}"
                    return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
                result = {**h.brief(), "result": (h.result[:3000] if h.status == "success" else None),
                          "error": h.error or None}
            elif name == "subagent_cancel":
                result = await subagent_pool.cancel(str(args.get("subagent_id") or ""))
                if result.get("status") == "error":
                    return ToolOutcome(call_id, name, "error", error=str(result.get("error")),
                                       result=result, model_content=json.dumps(result, ensure_ascii=False))
            elif name == "subagent_wait":
                try:
                    _wto = float(args.get("timeout_s") or 0) or None
                except Exception:
                    _wto = None
                result = await subagent_pool.wait(
                    subagent_id=str(args.get("subagent_id") or ""),
                    batch_id=str(args.get("batch_id") or ""),
                    timeout_s=_wto,
                )
                if result.get("status") == "error":
                    return ToolOutcome(call_id, name, "error", error=str(result.get("error")),
                                       result=result, model_content=json.dumps(result, ensure_ascii=False))
            else:
                result = await subagent_pool.steer(str(args.get("subagent_id") or ""), str(args.get("text") or ""))
                if result.get("status") == "error":
                    return ToolOutcome(call_id, name, "error", error=str(result.get("error")),
                                       result=result, model_content=json.dumps(result, ensure_ascii=False))
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(result, ensure_ascii=False, default=str)[:4000])

        if name.startswith("onekey_"):
            try:
                from app.pipelines.onekey_agent import handle_onekey_tool
            except Exception as e:
                msg = f"一键成片工具加载失败: {e}"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            result = await handle_onekey_tool(name, args)
            if not isinstance(result, dict):
                result = {"result": result}
            if result.get("error"):
                return ToolOutcome(call_id, name, "error", error=str(result.get("error")),
                                   result=result, model_content=json.dumps(result, ensure_ascii=False, default=str)[:4000])
            return ToolOutcome(call_id, name, "success", result=result,
                               model_content=json.dumps(result, ensure_ascii=False, default=str)[:6000])

        if name == "batch_run":
            tool = str(args.get("tool") or "").strip()
            items = args.get("items") or []
            if not tool or not isinstance(items, list) or not items:
                msg = "batch_run 需要 tool 与非空 items"
                return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
            if len(items) > 3 and not auto_approved:
                verdict = await self.approvals.request("batch_run", {"tool": tool, "count": len(items)},
                                                       reason=f"批量执行 {len(items)} 项 {tool}")
                if verdict != "approved":
                    msg = f"已跳过批量执行 {tool}（{APPROVAL_VERDICT_TEXT.get(verdict, verdict)}）"
                    return ToolOutcome(call_id, name, "denied", error=msg, meta={"approval": verdict},
                                       model_content=json.dumps({"error": msg}, ensure_ascii=False))
            from app.agent.runtime.batch import run_batch

            async def _one(cid, t, a, ctx, rm):
                return await self.execute(cid, t, a, ctx, rm, auto_approved=False)

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

        # ③.9 扩展缝：外部 pre-tool hooks（hooks.json 命令 + 进程内注册）；命中 deny 直接拒绝
        _hook_reason = await self._run_pre_hooks(name, args)
        if _hook_reason:
            msg = f"已拦截 {name}（pre-hook: {_hook_reason}）"
            return ToolOutcome(call_id, name, "denied", error=msg,
                               model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ④ 人审：破坏性调用 / 项目策略要求确认的调用；auto 不再无条件放行
        need_confirm = is_destructive(name, args) or _decision == "ask"
        if need_confirm and not auto_approved:
            verdict = await self.approvals.request(
                name, args, reason=f"permission={_decision} risk={_risk(name)} mode={run_mode}")
            if verdict != "approved":
                msg = f"已跳过需确认的工具 {name}（{APPROVAL_VERDICT_TEXT.get(verdict, verdict)}）"
                return ToolOutcome(call_id, name, "denied", error=msg, meta={"approval": verdict},
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # 模式切换：create 已在上面走用户审批；plan/auto 属于降级/安全切换
        if name == "request_mode_switch":
            from app.agent.mode_policy import normalize_run_mode
            target = normalize_run_mode(str(args.get("target") or "auto"))
            callback = getattr(self, "mode_switch_callback", None)
            if callback is None:
                msg = "当前会话不支持模式切换"
                return ToolOutcome(call_id, name, "error", error=msg,
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))
            try:
                callback(target)
            except Exception as e:
                msg = f"模式切换失败: {e}"
                return ToolOutcome(call_id, name, "error", error=msg,
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))
            payload = {"status": "success", "run_mode": target,
                       "note": "已切换执行模式" if target != "create" else "用户已批准进入创造模式"}
            try:
                r = self.emit({"event": "run_mode_set", "run_mode": target, "source": "agent"})
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                pass
            return ToolOutcome(call_id, name, "success", result=payload,
                               model_content=json.dumps(payload, ensure_ascii=False))

        if name in ("creator_propose_change_set", "creator_test_change_set",
                    "creator_apply_change_set", "creator_rollback_change_set"):
            from app.agent import change_sets
            pid = str((project_context or {}).get("project_id") or "") if isinstance(project_context, dict) else ""
            ctx = {"project_id": pid} if pid else {}
            try:
                if name == "creator_propose_change_set":
                    result = change_sets.propose_change_set(str(args.get("goal") or ""), ctx)
                elif name == "creator_test_change_set":
                    result = await change_sets.test_change_set(str(args.get("change_set_id") or ""), ctx)
                elif name == "creator_apply_change_set":
                    result = await change_sets.apply_change_set(str(args.get("change_set_id") or ""), ctx)
                else:
                    result = await change_sets.rollback_change_set(str(args.get("change_set_id") or ""), ctx)
                return ToolOutcome(call_id, name, "success", result=result,
                                   model_content=json.dumps(result, ensure_ascii=False, default=str)[:8000])
            except Exception as e:
                msg = f"ChangeSet 操作失败: {e}"
                return ToolOutcome(call_id, name, "error", error=msg,
                                   model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ⑤ 执行（带 per-tool 超时）
        timeout = tool_timeout(name)

        def _on_tool_progress(msg: str) -> None:
            """工具阶段进度（如 register_custom_provider 的 LLM 生成中）→ SSE tool_progress 透出到前端。"""
            try:
                asyncio.create_task(self.emit({
                    "event": "tool_progress", "call_id": call_id, "tool": name, "text": str(msg)[:200],
                }))
            except Exception:
                pass

        try:
            from app.mcp.server import mcp_registry
            res = await asyncio.wait_for(
                mcp_registry.execute_tool(name, args, project_context=project_context,
                                          on_progress=_on_tool_progress, session_id=self.session_id),
                timeout=timeout,
            )
            status = getattr(res, "status", "error")
            result = getattr(res, "result", None)
            error = getattr(res, "error", None)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            status, result, error = "error", None, f"工具 {name} 执行超时（{timeout}s）"
            logger.error("工具超时 %s (%ds) session=%s", name, timeout, self.session_id)
        except Exception as e:
            status, result, error = "error", None, str(e)
            logger.exception("工具执行异常 %s session=%s", name, self.session_id)

        # 技能闭环：具名 read_skill 成功 → 记录并解锁后续生成/写提示词调用（只列清单不算读）
        if status == "success" and name == "read_skill":
            _read_name = str(args.get("name") or "").strip()
            if _read_name:
                self.skills_read.add(_read_name)

        # ④ 裁剪 / 溢写
        meta: Dict[str, Any] = {}
        if status == "success":
            raw = _summarize_result(name, result, self.SPILL_CHARS)
            model_content = raw
            if len(raw) >= self.SPILL_CHARS:
                full = _spill_full(self.session_id, call_id, name, json.dumps(result, ensure_ascii=False, default=str))
                if full:
                    meta["spill_path"] = full
                    model_content = raw + f"\n[全文溢写: {full}（用 fs_read 分页读取，无需可信模式）]"
        else:
            model_content = json.dumps({"error": error or "工具执行失败"}, ensure_ascii=False)

        outcome = ToolOutcome(
            call_id=call_id, name=name, status=status, result=result, error=error,
            meta=meta, model_content=model_content,
        )
        # ⑤.5 扩展缝：post-tool hooks（deny → 结果改写为失败；additional_context 合并）
        try:
            outcome = await self._apply_post_hooks(name, args, outcome)
        except Exception:
            pass
        # ⑤ 哨兵提醒（只建议不拦截）
        note = self.guard.observe(name, args, status)
        if note:
            outcome.additional_context = (
                f"{outcome.additional_context}\n{note}" if outcome.additional_context else note
            )
        return outcome
