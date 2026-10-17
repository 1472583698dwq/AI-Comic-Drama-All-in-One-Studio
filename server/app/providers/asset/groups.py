"""
素材分组（L2 分级）—— storage/assets/groups.json

结构（与 extensions/state.json 同型：全局桶 + 项目分桶）::

    {"version": 1,
     "global": ["角色", "角色/主角", "场景"],
     "projects": {"proj_xxx": ["道具"]}}

- 分组是路径字符串（最多两级，如 "角色/主角"）；
- 项目桶只对归属项目可见/可改；全局桶对所有项目可见（组织全局素材）；
- 删除分组 = 解绑素材（把 group_path 清空），不删除素材本身。
"""
import os
import json
import threading
from typing import Any, Dict, List, Optional

from app.providers.asset.manager import _load_asset, _save_asset

GROUPS_VERSION = 1
MAX_DEPTH = 2

_lock = threading.RLock()


def _groups_path() -> str:
    # 动态取 ASSETS_ROOT：测试会整体重指到临时目录
    from app.providers.asset import manager as _mgr
    return os.path.join(_mgr.ASSETS_ROOT, "groups.json")


def _norm_path(raw: Optional[str]) -> str:
    """归一化分组路径；非法（空 / 超过两级 / ..）抛 ValueError。"""
    p = (raw or "").strip().strip("/").replace("\\", "/")
    p = "/".join(seg.strip() for seg in p.split("/") if seg.strip())
    if not p:
        raise ValueError("分组名不能为空")
    segs = p.split("/")
    if len(segs) > MAX_DEPTH:
        raise ValueError(f"分组最多 {MAX_DEPTH} 级")
    for seg in segs:
        if seg in (".", "..") or any(c in seg for c in "\r\n\t"):
            raise ValueError("分组名包含非法字符")
    return p


def _load() -> Dict[str, Any]:
    data: Dict[str, Any] = {}
    try:
        with open(_groups_path(), "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", GROUPS_VERSION)
    if not isinstance(data.get("global"), list):
        data["global"] = []
    if not isinstance(data.get("projects"), dict):
        data["projects"] = {}
    return data


def _save(data: Dict[str, Any]) -> None:
    path = _groups_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _bucket(data: Dict[str, Any], project_id: Optional[str], scope: str) -> List[str]:
    if scope == "global":
        return data["global"]
    if not project_id:
        raise ValueError("项目分组需要 project_id")
    return data["projects"].setdefault(project_id, [])


def list_groups(project_id: Optional[str] = None) -> Dict[str, Any]:
    """可见分组：全局桶 + 当前项目桶。"""
    with _lock:
        data = _load()
    out = {"scope": "global+project" if project_id else "global"}
    out["global"] = sorted(set(data["global"]))
    out["project"] = sorted(set(data["projects"].get(project_id, []))) if project_id else []
    return out


def create_group(path: str, project_id: Optional[str] = None, scope: str = "project") -> Dict[str, Any]:
    p = _norm_path(path)
    with _lock:
        data = _load()
        bucket = _bucket(data, project_id, scope)
        if p not in bucket:
            bucket.append(p)
            _save(data)
    return list_groups(project_id)


def rename_group(old_path: str, new_path: str, project_id: Optional[str] = None, scope: str = "project") -> Dict[str, Any]:
    """重命名/移动分组：级联子分组路径，并同步所有素材的 group_path 前缀。"""
    old = _norm_path(old_path)
    new = _norm_path(new_path)
    if old == new:
        return list_groups(project_id)
    with _lock:
        data = _load()
        bucket = _bucket(data, project_id, scope)
        if new in bucket:
            raise ValueError(f"分组已存在：{new}")
        changed = [g for g in bucket if g == old or g.startswith(old + "/")]
        if not changed:
            raise ValueError(f"分组不存在：{old}")
        for i, g in enumerate(bucket):
            if g == old:
                bucket[i] = new
            elif g.startswith(old + "/"):
                bucket[i] = new + g[len(old):]
        # 去重（new 可能与既有子路径冲突）
        seen = set()
        dedup: List[str] = []
        for g in bucket:
            if g not in seen:
                seen.add(g)
                dedup.append(g)
        if scope == "global":
            data["global"] = dedup
        else:
            data["projects"][project_id] = dedup
        _save(data)
        moved = _rebind_assets(old, new)
    out = list_groups(project_id)
    out["assets_moved"] = moved
    return out


def delete_group(path: str, project_id: Optional[str] = None, scope: str = "project") -> Dict[str, Any]:
    """删除分组（含子分组），并解绑组内素材（group_path 清空，不删素材）。"""
    p = _norm_path(path)
    with _lock:
        data = _load()
        bucket = _bucket(data, project_id, scope)
        removed = [g for g in bucket if g == p or g.startswith(p + "/")]
        if not removed:
            raise ValueError(f"分组不存在：{p}")
        kept = [g for g in bucket if g not in removed]
        if scope == "global":
            data["global"] = kept
        else:
            data["projects"][project_id] = kept
        _save(data)
        unbound = _unbind_assets(removed)
    out = list_groups(project_id)
    out["removed_groups"] = removed
    out["unbound_assets"] = unbound
    return out


def _rebind_assets(old: str, new: str) -> int:
    """把素材 group_path 从 old 前缀迁到 new 前缀。"""
    moved = 0
    try:
        from app.providers.asset import manager as _mgr
        for entry in os.listdir(_mgr.ASSETS_ROOT):
            adir = os.path.join(_mgr.ASSETS_ROOT, entry)
            if not os.path.isdir(adir):
                continue
            a = _load_asset(entry)
            if not a or not a.group_path:
                continue
            gp = a.group_path
            if gp == old or gp.startswith(old + "/"):
                a.group_path = new + gp[len(old):]
                _save_asset(a)
                moved += 1
    except Exception:
        pass
    return moved


def _unbind_assets(paths: List[str]) -> int:
    """把落在这些分组（含子级）内的素材 group_path 清空。"""
    unbound = 0
    try:
        from app.providers.asset import manager as _mgr
        for entry in os.listdir(_mgr.ASSETS_ROOT):
            adir = os.path.join(_mgr.ASSETS_ROOT, entry)
            if not os.path.isdir(adir):
                continue
            a = _load_asset(entry)
            if not a or not a.group_path:
                continue
            gp = a.group_path
            if any(gp == p or gp.startswith(p + "/") for p in paths):
                a.group_path = None
                _save_asset(a)
                unbound += 1
    except Exception:
        pass
    return unbound


def group_counts(project_id: Optional[str] = None) -> Dict[str, int]:
    """每个分组的素材数（含子级聚合；__none__=未分组）—— 供前端分组树显示计数。"""
    counts: Dict[str, int] = {}
    try:
        from app.providers.asset import manager as _mgr
        groups = list_groups(project_id)
        all_paths = set(groups["global"]) | set(groups["project"])
        for entry in os.listdir(_mgr.ASSETS_ROOT):
            adir = os.path.join(_mgr.ASSETS_ROOT, entry)
            if not os.path.isdir(adir):
                continue
            a = _load_asset(entry)
            if not a:
                continue
            if project_id and not _mgr.AssetManager.visible_to(a, project_id, include_shared=True):
                continue
            gp = a.group_path or ""
            if not gp:
                counts["__none__"] = counts.get("__none__", 0) + 1
                continue
            # 精确计入本身；同时给所有祖先路径各计一次（树聚合）
            segs = gp.split("/")
            for i in range(1, len(segs) + 1):
                ancestor = "/".join(segs[:i])
                if ancestor in all_paths:
                    counts[ancestor] = counts.get(ancestor, 0) + 1
    except Exception:
        pass
    return counts
