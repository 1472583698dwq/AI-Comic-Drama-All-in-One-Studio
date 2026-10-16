# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas 分组节点（group）的画布结构维护：成组、解组、包围盒计算。

约定（与前端 React Flow 一致）：
- 分组节点 ``{"id", "type": "group", "position", "width", "height", "style": {width, height}, "data": {"label"}}``，
  无端口，执行器跳过；
- 子节点写 ``parentId = 分组 id``，``position`` 改为**相对分组左上角**；
- React Flow 要求父节点在数组里排在子节点之前，成组时把分组插到第一个子节点之前；
- 包围盒内边距：左右 24、上 40（给框外标题留位）、下 24。
"""
from typing import Any, Dict, List, Optional, Tuple

GROUP_TYPE = "group"
GROUP_PADDING = {"left": 24, "right": 24, "top": 40, "bottom": 24}
DEFAULT_NODE_SIZE = (220.0, 240.0)
DEFAULT_GROUP_SIZE = (400.0, 300.0)


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().lower().removesuffix("px").strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def node_size(node: Dict[str, Any]) -> Tuple[float, float]:
    """节点尺寸：width/height → measured → style；都没有用默认 220×240。不读 data.width（那是媒体像素）。"""
    w = _num(node.get("width"))
    h = _num(node.get("height"))
    measured = node.get("measured") if isinstance(node.get("measured"), dict) else {}
    style = node.get("style") if isinstance(node.get("style"), dict) else {}
    w = w or _num(measured.get("width")) or _num(style.get("width")) or DEFAULT_NODE_SIZE[0]
    h = h or _num(measured.get("height")) or _num(style.get("height")) or DEFAULT_NODE_SIZE[1]
    return w, h


def _pos(node: Dict[str, Any]) -> Tuple[float, float]:
    p = node.get("position") if isinstance(node.get("position"), dict) else {}
    return (_num(p.get("x")) or 0.0, _num(p.get("y")) or 0.0)


def abs_position(node: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Tuple[float, float]:
    """沿 parentId 链累加得到画布绝对坐标（防环）。"""
    x, y = _pos(node)
    seen = {node.get("id")}
    parent = by_id.get(node.get("parentId")) if node.get("parentId") else None
    while parent is not None and parent.get("id") not in seen:
        seen.add(parent.get("id"))
        px, py = _pos(parent)
        x, y = x + px, y + py
        parent = by_id.get(parent.get("parentId")) if parent.get("parentId") else None
    return x, y


def create_group(nodes: List[Dict[str, Any]], group_id: str, child_ids: List[str], label: str = "分组",
                 position: Optional[Dict[str, Any]] = None, size: Optional[Tuple[float, float]] = None,
                 extra_data: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], List[str]]:
    """把 child_ids 收进新分组（原地修改 nodes，返回 (分组节点, 未找到的 id)）。

    有子节点时位置与尺寸由子节点包围盒 + 内边距决定（忽略 position/size）；没有子节点时用传入值或默认 400×300。
    子节点若都在同一个父分组里，新分组也放进该父分组（嵌套）。
    """
    by_id = {n.get("id"): n for n in nodes if isinstance(n, dict)}
    picked: List[Dict[str, Any]] = []
    missing: List[str] = []
    for cid in child_ids or []:
        n = by_id.get(cid)
        if n is None or cid == group_id:
            missing.append(cid)
        elif n not in picked:
            picked.append(n)
    data = {"label": label or "分组"}
    data.update(extra_data or {})
    group: Dict[str, Any] = {"id": group_id, "type": GROUP_TYPE, "data": data}
    if picked:
        rects = []
        for n in picked:
            ax, ay = abs_position(n, by_id)
            w, h = node_size(n)
            rects.append((ax, ay, ax + w, ay + h))
        min_x = min(r[0] for r in rects) - GROUP_PADDING["left"]
        min_y = min(r[1] for r in rects) - GROUP_PADDING["top"]
        max_x = max(r[2] for r in rects) + GROUP_PADDING["right"]
        max_y = max(r[3] for r in rects) + GROUP_PADDING["bottom"]
        gw, gh = max_x - min_x, max_y - min_y
        parents = {n.get("parentId") or None for n in picked}
        common_parent = parents.pop() if len(parents) == 1 else None
        if common_parent and common_parent in by_id:
            pax, pay = abs_position(by_id[common_parent], by_id)
            group["parentId"] = common_parent
            group["position"] = {"x": round(min_x - pax, 2), "y": round(min_y - pay, 2)}
        else:
            group["position"] = {"x": round(min_x, 2), "y": round(min_y, 2)}
        for n, r in zip(picked, rects):
            n["parentId"] = group_id
            n.pop("extent", None)
            n["position"] = {"x": round(r[0] - min_x, 2), "y": round(r[1] - min_y, 2)}
        insert_at = min(nodes.index(n) for n in picked)
    else:
        p = position if isinstance(position, dict) else {}
        group["position"] = {"x": _num(p.get("x")) or 0.0, "y": _num(p.get("y")) or 0.0}
        gw, gh = size or DEFAULT_GROUP_SIZE
        insert_at = len(nodes)
    gw, gh = round(float(gw), 2), round(float(gh), 2)
    group["width"], group["height"] = gw, gh
    group["style"] = {"width": gw, "height": gh}
    nodes.insert(insert_at, group)
    return group, missing


def release_children(nodes: List[Dict[str, Any]], group_id: str) -> List[str]:
    """分组被删前调用：子节点回到分组的父级（或画布顶层），位置换算回去；返回被释放的子节点 id。"""
    by_id = {n.get("id"): n for n in nodes if isinstance(n, dict)}
    group = by_id.get(group_id)
    if group is None:
        return []
    gx, gy = _pos(group)
    grand = group.get("parentId")
    released = []
    for n in nodes:
        if isinstance(n, dict) and n.get("parentId") == group_id:
            x, y = _pos(n)
            n["position"] = {"x": round(x + gx, 2), "y": round(y + gy, 2)}
            n.pop("extent", None)
            if grand:
                n["parentId"] = grand
            else:
                n.pop("parentId", None)
            released.append(n.get("id"))
    return released
