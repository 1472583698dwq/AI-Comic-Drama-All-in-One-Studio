# -*- coding: utf-8 -*-
"""扩展启用审计切面 —— 把注册表层的停用/作用域治理下沉到各引擎入口。

引擎在真正执行前调用 ``ensure_enabled`` / ``ensure_provider_enabled``；
命中停用（全局或项目）即拒绝执行。

项目作用域传播：
- 入口显式传 ``project_id``（推荐，如 canvas / skill 路由）；
- 否则读 contextvar（由 ``set_project_context`` 设置，如 HTTP 中间件）。

这样「扩展中心」里的停用/项目停用不再是 UI 提示，而是全链路强制。
"""
import contextvars
from typing import Optional, Tuple

_project_ctx: contextvars.ContextVar = contextvars.ContextVar(
    "studio_project_id", default="")


class ExtensionDisabledError(ValueError):
    """扩展被停用（可安全展示给用户）。"""


def set_project_context(project_id: str):
    return _project_ctx.set(str(project_id or ""))


def reset_project_context(token) -> None:
    try:
        _project_ctx.reset(token)
    except Exception:
        pass


def current_project_id() -> str:
    try:
        return _project_ctx.get() or ""
    except Exception:
        return ""


def _resolve_pid(project_id: Optional[str]) -> str:
    return current_project_id() if project_id is None else str(project_id or "")


def is_enabled(kind: str, local_id: str, project_id: Optional[str] = None) -> bool:
    from . import state
    return state.match_disabled(kind, local_id, _resolve_pid(project_id)) is None


def disabled_reason(kind: str, local_id: str,
                    project_id: Optional[str] = None) -> Optional[str]:
    """命中停用则返回可读原因，否则 None。"""
    from . import state
    hit = state.match_disabled(kind, local_id, _resolve_pid(project_id))
    if hit:
        return f"扩展已被停用，拒绝执行：{hit}（可在设置中心·扩展中心启用）"
    return None


def ensure_enabled(kind: str, local_id: str, project_id: Optional[str] = None,
                   label: str = "") -> None:
    from . import state
    hit = state.match_disabled(kind, local_id, _resolve_pid(project_id))
    if hit:
        who = label or hit
        raise ExtensionDisabledError(
            f"扩展已被停用，拒绝执行：{who}（可在设置中心·扩展中心启用）")


def _workflow_id_candidates(provider_id: str) -> Tuple[str, ...]:
    """由工作流同步出的 provider id 反推可能的工作流 id（用于连带停用检查）。"""
    pid = str(provider_id or "")
    if not pid.startswith("comfyui_"):
        return ()
    rest = pid[len("comfyui_"):]
    cands = []
    if rest.startswith("wf_") or rest.startswith("ext_"):
        cands.append(rest)
        # 兼容无前缀原始 id 被映射成 comfyui_wf_<id> 的情况
        cands.append(rest.split("_", 1)[1] if "_" in rest else rest)
    elif rest:
        cands.append(rest)
    # 去重保序
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return tuple(out)


def ensure_provider_enabled(provider_id: str, project_id: Optional[str] = None) -> None:
    """provider 审计：连带覆盖其来源工作流（comfyui_* 映射）的停用。"""
    ensure_enabled("provider", provider_id, project_id, label=f"provider:{provider_id}")
    for wid in _workflow_id_candidates(provider_id):
        from . import state
        if state.match_disabled("workflow", wid, _resolve_pid(project_id)):
            raise ExtensionDisabledError(
                f"工作流已被停用，拒绝执行：workflow:{wid}（可在扩展中心启用）")
