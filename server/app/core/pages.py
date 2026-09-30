# -*- coding: utf-8 -*-
"""功能页（page）运行时开关 —— 把每个前端页签变成可运行时开关的扩展。

设计（L1 框架层，只做「开关」不做「卸载」）：

- 页面清单内置在本模块（``PAGE_DEFS``）：顺序即侧栏顺序，``group`` 供前端分组，
  ``host`` 是前端路由/宿主组件标识，``api_families`` 是该页对应的后端路由族前缀
  （仅作说明与前端提示，真正的 404 由各 route 模块的 ``require(pid)`` 守卫负责）。
- 开关状态**不另造存储**：复用扩展覆盖层 ``app.extensions.state``，
  以 ``page:<pid>`` 为 id 进/出 ``state.json`` 的 ``global.disabled``。
- 首次运行由 ``seed_defaults()`` 把 ``default=False`` 的页面写进全局停用集，
  并在 state.json **顶层**打 ``pages_seeded`` 标记（幂等；不改既有 schema）。
- ``require(pid)`` 返回路由级依赖：页面关闭（或未知 id）→ 404，无需重启。
- ``config`` 页 ``locked=True``：入口本身被 registry 拦截，不可关闭。

``is_enabled`` 对未知 id 一律返回 False（不兜底放行）。
"""
from typing import Any, Callable, Dict, List

from fastapi import HTTPException

from app.extensions import state

# 顶层幂等标记键（只加键，不改既有 schema：{"global":{...},"projects":{...}}）
SEED_MARKER = "pages_seeded"

#: 内置页面清单；顺序即侧栏顺序。
PAGE_DEFS: List[Dict[str, Any]] = [
    {
        "id": "home", "label": "首页", "icon": "Home", "group": "工作区",
        "order": 10, "default": True, "locked": False, "host": "home",
        "description": "工作台首页：概览当前工程与最近产物",
    },
    {
        "id": "projects", "label": "项目看板", "icon": "FolderKanban", "group": "工作区",
        "order": 20, "default": False, "locked": False, "host": "projects",
        "description": "项目看板：管理全部工程与制作进度",
    },
    {
        "id": "assets", "label": "素材库", "icon": "Library", "group": "工作区",
        "order": 30, "default": True, "locked": False, "host": "assets",
        "description": "素材库：图片 / 视频 / 音频统一归档",
    },
    {
        "id": "characters", "label": "角色设定", "icon": "Users", "group": "工作区",
        "order": 40, "default": True, "locked": False, "host": "characters",
        "description": "角色设定：人设卡与参考图管理",
    },
    {
        "id": "studio", "label": "分镜台", "icon": "Layers", "group": "漫剧工坊",
        "order": 50, "default": False, "locked": False, "host": "studio",
        "description": "分镜台：逐镜脚本、分镜槽与一键成片",
        "api_families": ["/storyboard/slots", "/onekey"],
    },
    {
        "id": "director3d", "label": "3D 片场", "icon": "Compass", "group": "漫剧工坊",
        "order": 60, "default": False, "locked": False, "host": "director3d",
        "description": "3D 片场：导演包场景、道具与运镜预演",
        "api_families": ["/director-packs"],
    },
    {
        "id": "timeline", "label": "多轨剪辑", "icon": "Video", "group": "漫剧工坊",
        "order": 70, "default": False, "locked": False, "host": "timeline",
        "description": "多轨剪辑：时间线剪辑与成片导出",
    },
    {
        "id": "agent", "label": "AI 导演", "icon": "Bot", "group": "创意工坊",
        "order": 80, "default": True, "locked": False, "host": "agent",
        "description": "AI 导演：全流程智能体对话编排",
    },
    {
        "id": "canvas", "label": "创意画布", "icon": "Sparkles", "group": "创意工坊",
        "order": 90, "default": True, "locked": False, "host": "canvas",
        "description": "创意画布：节点式自由创作与执行",
        "api_families": ["/canvas", "/custom-nodes", "/canvas-nodes"],
    },
    {
        "id": "config", "label": "设置", "icon": "Settings", "group": "系统",
        "order": 100, "default": True, "locked": True, "host": "config",
        "description": "设置：模型、生成源与功能开关",
    },
]

_BY_ID: Dict[str, Dict[str, Any]] = {str(p["id"]): p for p in PAGE_DEFS}


def page_ext_id(pid: str) -> str:
    """页面 id → 扩展 id（``page:<pid>``）。"""
    return f"page:{pid}"


def is_locked(pid: str) -> bool:
    """该页是否 locked（locked 页不可关闭；未知 id 返回 False）。"""
    d = _BY_ID.get(str(pid or ""))
    return bool(d and d.get("locked"))


def _label(pid: str) -> str:
    d = _BY_ID.get(str(pid or ""))
    return str(d.get("label") or pid) if d else str(pid or "")


def seed_defaults() -> Dict[str, Any]:
    """幂等播种：首次运行把 ``default=False`` 的页面写进全局停用集。

    - 已在 state.json 顶层见到 ``pages_seeded=True`` → 直接返回，不动任何既有键；
    - 否则逐个 ``state.set_disabled``（走既有覆盖层 API），再补顶层标记键；
    - 不修改既有 schema，不清理/覆盖他人写入的 disabled 项。
    """
    with state._LOCK:  # RLock：内部 set_disabled/_save 再取锁是安全的、整体原子
        data = state._load()
        if data.get(SEED_MARKER) is True:
            return {"seeded": False, "pages_seeded": True, "disabled": []}
        known = state.disabled_ids("")
        added: List[str] = []
        for d in PAGE_DEFS:
            if d.get("default", False):
                continue
            eid = page_ext_id(d["id"])
            if eid not in known:
                added.append(eid)
            state.set_disabled(eid, True)
        data = state._load()
        data[SEED_MARKER] = True
        state._save(data)
        return {"seeded": True, "pages_seeded": True, "disabled": added}


def is_enabled(pid: str) -> bool:
    """页面是否启用：未知 id 一律 False；locked 页也按停用集判断（不特殊放行）。"""
    pid = str(pid or "")
    if pid not in _BY_ID:
        return False
    return not state.is_disabled(page_ext_id(pid))


def enabled_ids() -> List[str]:
    """当前启用的页面 id（顺序同 ``PAGE_DEFS``）。"""
    return [str(d["id"]) for d in PAGE_DEFS if is_enabled(str(d["id"]))]


def snapshot() -> Dict[str, Any]:
    """清单 + 启停状态快照（前端侧栏与设置页功能开关共用）。"""
    pages: List[Dict[str, Any]] = []
    values: Dict[str, bool] = {}
    groups: List[str] = []
    for d in PAGE_DEFS:
        pid = str(d["id"])
        ok = is_enabled(pid)
        values[pid] = ok
        item = dict(d)
        item["locked"] = bool(d.get("locked", False))
        item["enabled"] = ok
        pages.append(item)
        g = str(d.get("group") or "")
        if g and g not in groups:
            groups.append(g)
    return {
        "pages": pages,
        "values": values,
        "groups": groups,
        "file": str(state._state_path()),
    }


def require(pid: str) -> Callable[[], None]:
    """返回该页的路由级依赖：页面关闭或未知 → 404。"""

    def _guard() -> None:
        if not is_enabled(pid):
            raise HTTPException(
                status_code=404,
                detail=f"{_label(pid)} 已关闭（设置 → 功能开关）",
            )

    return _guard
