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


# ── 提示词技能门（执行口硬门控）──────────────────────────────
# 动机：模型写提示词偷懒（一句话动作词）就直调生成源。这里定死：
# 本管线内未成功 read_skill(<具名技能>) 之前，生成/写提示词类调用一律拒绝并指路。
# 单一出口：主循环、job_start、batch_run、子代理都走本管线；读技能后本会话解锁。
PROMPT_SKILL_GATE_TOOLS = frozenset({
    "generate_image", "generate_video", "comfyui_render_node",
    "canvas_execute", "canvas_dispatch_skill",
    "onekey_style_lock", "onekey_shot_image", "onekey_shot_video",
})
PROMPT_SKILL_GATE_PREFIXES = ("provider_", "customnode_", "plugin_")
_PROMPT_SKILL_SUGGEST_VIDEO = ("minimax-h3-prompt", "prompt-basics")
_PROMPT_SKILL_SUGGEST_IMAGE = ("prompt-basics", "prompt-anime-optimizer", "prompt-guofeng-xianxia")


def prompt_gate_enabled() -> bool:
    raw = str(os.environ.get("STUDIO_PROMPT_SKILL_GATE", "1")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _prompt_gate_target(name: str, args: Dict[str, Any]) -> str:
    """包装工具透传到内层目标工具名（job_start / batch_run）。"""
    if name in ("job_start", "batch_run"):
        return str((args or {}).get("tool") or "").strip()
    return name


def _tool_has_prompt_input(name: str) -> Optional[bool]:
    """动态工具（provider_/customnode_/plugin_）按 schema 是否含 prompt 参数判定；查不到返回 None。"""
    try:
        from app.agent.tools.registry import tool_view
        t = tool_view.get(name)
        if t is None:
            return None
        props = ((getattr(t, "input_schema", None) or {}).get("properties") or {})
        return "prompt" in props
    except Exception:
        return None


def is_prompt_gate_tool(name: str) -> bool:
    if not name:
        return False
    if name in PROMPT_SKILL_GATE_TOOLS:
        return True
    if name.startswith(PROMPT_SKILL_GATE_PREFIXES):
        has_prompt = _tool_has_prompt_input(name)
        if has_prompt is not None:
            return has_prompt
        return name.startswith(("provider_", "customnode_"))
    return False


def _prompt_skill_suggestions(tool_name: str) -> List[str]:
    base = _PROMPT_SKILL_SUGGEST_VIDEO if "video" in tool_name else _PROMPT_SKILL_SUGGEST_IMAGE
    try:
        from app.skills.engine import skill_engine
        usable = {s.name for s in skill_engine.active_skills()}
        picked = [n for n in base if n in usable]
        if picked:
            return picked
    except Exception:
        pass
    return list(base)


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
        self.guard = RepeatToolGuard()
        # 已成功读取的技能名（提示词技能门：读一个即解锁本会话生成/写提示词调用）
        self.skills_read: set = set()

    def resolve_approval(self, approval_id: str, approved: bool) -> bool:
        return self.approvals.resolve(approval_id, approved)

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

        # ①.5 子代理角色裁剪：执行口二次拒绝越权工具（角色约束靠代码，不靠提示词）
        _profile = getattr(self, "agent_profile", None)
        if _profile is not None and not _profile.allows(name):
            msg = f"工具 {name} 不在子代理角色（{_profile.name}）的能力范围内，已拒绝"
            return ToolOutcome(call_id, name, "denied", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))

        # ①.6 提示词技能门：写提示词/调生成源前，本会话必须先成功读一个技能 SOP（防敷衍成稿）
        if prompt_gate_enabled():
            _target = _prompt_gate_target(name, args)
            if is_prompt_gate_tool(_target) and not self.skills_read:
                _sugg = _prompt_skill_suggestions(_target)
                _first = _sugg[0] if _sugg else "prompt-basics"
                msg = (
                    f"执行口拦截：调用 {_target} 前必须先读取提示词技能——本会话尚未成功 read_skill 任何技能。"
                    f"写提示词必须按技能 SOP 成稿，不允许一句话敷衍。"
                    f"下一步：先 read_skill(\"{_first}\")"
                    + (f"（或 read_skill(\"{_sugg[1]}\")）" if len(_sugg) > 1 else "")
                    + f"，按其规范写好后重试 {name}（本次参数可复用）。"
                )
                denied = json.dumps(
                    {"error": msg, "required_action": "read_skill", "suggested_skills": _sugg},
                    ensure_ascii=False)
                return ToolOutcome(call_id, name, "denied", error=msg,
                                   meta={"prompt_skill_gate": True, "suggested_skills": _sugg},
                                   model_content=denied)

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
            if isinstance(batch, list) and batch:
                result = await subagent_pool.spawn_batch(
                    parent, agent, batch, background=background, context=ctx_arg,
                    max_steps=ms, timeout_s=to)
            else:
                task = str(args.get("task") or "").strip()
                if not task:
                    msg = "subagent_run 需要 task（或 batch 数组）"
                    return ToolOutcome(call_id, name, "error", error=msg, model_content=json.dumps({"error": msg}, ensure_ascii=False))
                result = await subagent_pool.spawn(
                    parent, agent, task, context=ctx_arg, background=background,
                    max_steps=ms, timeout_s=to, auto_bg_ok=auto_bg_ok)
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
            if len(items) > 3 and _execution != "auto" and not auto_approved:
                verdict = await self.approvals.request("batch_run", {"tool": tool, "count": len(items)},
                                                       reason=f"批量执行 {len(items)} 项 {tool}")
                if verdict != "approved":
                    msg = f"已跳过批量执行 {tool}（{APPROVAL_VERDICT_TEXT.get(verdict, verdict)}）"
                    return ToolOutcome(call_id, name, "denied", error=msg, meta={"approval": verdict},
                                       model_content=json.dumps({"error": msg}, ensure_ascii=False))
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
            verdict = await self.approvals.request(name, args, reason=f"risk={_risk(name)} mode={run_mode}")
            if verdict != "approved":
                msg = f"已跳过需确认的工具 {name}（{APPROVAL_VERDICT_TEXT.get(verdict, verdict)}）"
                return ToolOutcome(call_id, name, "denied", error=msg, meta={"approval": verdict},
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
                mcp_registry.execute_tool(name, args, project_context=project_context, on_progress=_on_tool_progress),
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
        # ⑤ 哨兵提醒（只建议不拦截）
        note = self.guard.observe(name, args, status)
        if note:
            outcome.additional_context = note
        return outcome
