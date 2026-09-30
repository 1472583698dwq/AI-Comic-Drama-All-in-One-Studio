# -*- coding: utf-8 -*-
"""功能级（feature）运行时开关 —— 管理「页面关不掉」的进阶能力。

与 L1「功能页开关」（``app.core.pages``）的分工：

- ``pages``：整页可开关，状态落在扩展覆盖层 ``storage/extensions/state.json``，
  关掉即整族路由 404；
- ``features``（本模块）：**非页面级**的进阶能力（多模态附件、子代理委派、导演组），
  这些能力混在「AI 导演」等页里，没法靠关页面来关，故单独一层开关，
  **出厂默认全关**，在 设置 → 功能开关 里逐个打开。

设计：

- 存储 ``storage/features.json``：扁平 ``{"<id>": true/false}``，无嵌套、无 schema 版本号；
  文件缺失 = 全部取 ``FEATURE_DEFS`` 的 ``default``（当前全 False=关闭）。
- 原子写：先写 ``features.json.tmp`` 再 ``os.replace``，外部读到的永远是完整 JSON。
- 读带 mtime/size 缓存：外部直接改文件（手改、云同步回拉、另一个进程写）即时生效，
  无需重启、无需显式刷新。
- ``id`` 一旦发布即契约：前端开关、存储文件、路由守卫都按 id 索引，
  **不可改名/不可复用意**（要下线就保留定义并把 default 置 False）。
- ``is_enabled`` 对未知 id 一律返回 False（不兜底放行），未知 id 写入口直接 ``ValueError``
  （不静默忽略：静默忽略会让"设置里打开了却没生效"变成无从排查的悬案）。

本模块不注册任何全局副作用（不建目录、不写文件、不 seed），
文件只在第一次 ``set_values`` 时创建。
"""
import json
import os
import threading
from typing import Any, Callable, Dict, List

from fastapi import HTTPException

#: 存储文件名（位于 ``settings.STORAGE_DIR`` 下）
FILE_NAME = "features.json"

#: 内置功能清单；``default`` 一律 False（出厂全关），``group``/``order`` 供前端开关页分组排序。
FEATURE_DEFS: List[Dict[str, Any]] = [
    {
        "id": "agent_multimodal", "label": "多模态附件与看图",
        "group": "AI 导演", "order": 10, "default": False,
        # description 前端按「关闭后：<description>」展示，故写成「受影响的能力」口吻
        "description": "AI 导演的图片/视频附件、生成产物自动回投与《看画布产物》view_media 均不可用（纯文本对话不受影响）",
    },
    {
        "id": "agent_subagent", "label": "子代理委派",
        "group": "AI 导演", "order": 20, "default": False,
        "description": "同步 / 异步 / 批量委派子代理与集群并行执行均不可用（主代理单进程照常工作）",
    },
    {
        "id": "agent_teams", "label": "导演组",
        "group": "扩展能力", "order": 30, "default": False,
        "description": "导演组成员 / 团队（/api/v1/agent-teams）与插件贡献的 agent_profile / agent_team 接口均返回 404",
    },
]

_BY_ID: Dict[str, Dict[str, Any]] = {str(f["id"]): f for f in FEATURE_DEFS}

_LOCK = threading.RLock()
#: mtime 缓存：{"key": (path, mtime_ns, size), "values": {id: bool}}
_CACHE: Dict[str, Any] = {"key": None, "values": {}}


# ── 路径与读写 ──────────────────────────────────────────────
def _path() -> str:
    """功能开关文件路径（跟随 ``settings.STORAGE_DIR``，测试可换 storage 根）。"""
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath("storage")
    return os.path.join(base, FILE_NAME)


def _stat_key() -> Any:
    """(path, mtime_ns, size)——重读判据；文件不存在时 mtime/size 为 None。"""
    p = _path()
    try:
        st = os.stat(p)
        return (p, st.st_mtime_ns, st.st_size)
    except OSError:
        return (p, None, None)


def _read_raw() -> Dict[str, Any]:
    """读原始 JSON（缺失/损坏/非对象 → 空 dict，全部回落默认值）。"""
    p = _path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _values() -> Dict[str, bool]:
    """生效值：磁盘布尔优先，缺失/类型不对回落 ``default``（缓存按 mtime+size 失效）。"""
    key = _stat_key()
    with _LOCK:
        if _CACHE.get("key") == key:
            return dict(_CACHE.get("values") or {})
    raw = _read_raw()
    values: Dict[str, bool] = {}
    for fid, d in _BY_ID.items():
        v = raw.get(fid)
        values[fid] = bool(v) if isinstance(v, bool) else bool(d.get("default", False))
    with _LOCK:
        _CACHE["key"] = key
        _CACHE["values"] = values
    return dict(values)


def _write(values: Dict[str, bool]) -> None:
    """原子写：``.tmp`` + ``os.replace``（半截 JSON 永远不会被读到）。"""
    p = _path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(values, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)
    with _LOCK:
        _CACHE["key"] = None  # 下次读取重新 stat → 立刻拿到新内容


# ── 查询 ────────────────────────────────────────────────────
def _label(fid: str) -> str:
    d = _BY_ID.get(str(fid or ""))
    return str(d.get("label") or fid) if d else str(fid or "")


def is_enabled(fid: str) -> bool:
    """功能是否开启：未知 id 一律 False（引擎侧非 HTTP 便捷判断就用它）。"""
    fid = str(fid or "")
    if fid not in _BY_ID:
        return False
    return bool(_values().get(fid, False))


def enabled_ids() -> List[str]:
    """当前开启的功能 id（顺序同 ``FEATURE_DEFS``）。"""
    vals = _values()
    return [str(d["id"]) for d in FEATURE_DEFS if vals.get(str(d["id"]))]


def values() -> Dict[str, bool]:
    """全部功能的生效值（``{id: bool}``，顺序同 ``FEATURE_DEFS``）。"""
    vals = _values()
    return {str(d["id"]): bool(vals.get(str(d["id"]), False)) for d in FEATURE_DEFS}


def snapshot() -> Dict[str, Any]:
    """清单 + 启停状态快照（设置 → 功能开关 页面的唯一数据源）。"""
    vals = _values()
    features: List[Dict[str, Any]] = []
    groups: List[str] = []
    for d in FEATURE_DEFS:
        fid = str(d["id"])
        item = dict(d)
        item["default"] = bool(d.get("default", False))
        item["enabled"] = bool(vals.get(fid, False))
        features.append(item)
        g = str(d.get("group") or "")
        if g and g not in groups:
            groups.append(g)
    return {
        "features": features,
        "values": {str(d["id"]): bool(vals.get(str(d["id"]), False)) for d in FEATURE_DEFS},
        "groups": groups,
        "file": _path(),
    }


# ── 写入 ────────────────────────────────────────────────────
def set_values(new_values: Dict[str, bool]) -> Dict[str, Any]:
    """批量写开关（合并语义）。未知 id / 非布尔 → ``ValueError``，且**不写坏文件**。

    校验全部通过后才落盘：一处非法则整批拒绝，磁盘保持原样。
    """
    if not isinstance(new_values, dict):
        raise ValueError("values 必须是 {feature_id: bool} 对象")
    clean: Dict[str, bool] = {}
    unknown: List[str] = []
    bad_type: List[str] = []
    for k, v in new_values.items():
        fid = str(k)
        if fid not in _BY_ID:
            unknown.append(fid)
        elif not isinstance(v, bool):
            bad_type.append(fid)
        else:
            clean[fid] = v
    if unknown or bad_type:
        parts: List[str] = []
        if unknown:
            parts.append(f"未知功能 id: {', '.join(sorted(unknown))}")
        if bad_type:
            parts.append(f"开关值必须为布尔: {', '.join(sorted(bad_type))}")
        raise ValueError("；".join(parts))
    with _LOCK:
        cur = _values()
        changed = [fid for fid, v in clean.items() if cur.get(fid) != v]
        merged = {str(d["id"]): bool(clean.get(str(d["id"]), cur.get(str(d["id"]), False)))
                  for d in FEATURE_DEFS}
        if changed or not os.path.exists(_path()):
            _write(merged)
    return {"values": merged, "changed": changed, "file": _path()}


# ── FastAPI 依赖 ────────────────────────────────────────────
def require(fid: str) -> Callable[[], None]:
    """返回该功能的路由级依赖：功能关闭或未知 → 404。"""

    def _guard() -> None:
        if not is_enabled(fid):
            raise HTTPException(
                status_code=404,
                detail=f"{_label(fid)} 已关闭（设置 → 功能开关）",
            )

    return _guard
