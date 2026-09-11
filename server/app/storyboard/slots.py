# -*- coding: utf-8 -*-
"""分镜工作台槽存储：内置目录 + 插件 slots/*.json + 裸件 custom/*.json + 项目覆盖。

槽声明（slots/*.json）契约：
{
  "slot": "shot.tabs" | "shot.anchors" | "shot.actions" | "shot.modes",
  "id": "my-note-tab", "label": "批注", "icon": "📝", "color": "text-teal-400",
  "order": 50,
  "when": {"mode": ["image_to_video"]},          # 可选：仅指定制作模式可见
  # --- 按 slot 的渲染体（P1 通用渲染器消费，见前端 slots/PluginRender） ---
  "blocks": [                                     # shot.tabs
    {"kind": "info", "text": "说明"},
    {"kind": "shot_field", "field": "action_desc", "label": "动作"},
    {"kind": "buttons", "buttons": [{"label": "合成", "run": {"store_action": "synthesizeShotPrompt"}}]}
  ],
  "field": "lighting_prompt", "category": "prop",  # shot.anchors：分镜字段 + 素材类目
  "run": {"extension": "provider:kling", "args": {"prompt": "{{shot.image_prompt}}"}},  # shot.actions
  "caps": {...}, "inherit_render": "image_to_video"  # shot.modes：能力位 + 复用内置渲染
}

有效列表 = 内置目录 → 插件包内（enabled 插件）→ 裸件 custom/，
再叠加项目覆盖（disabled 过滤 + order 改写）。同 id 包内优先。
"""
import glob
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

SLOT_CONTAINERS = ("shot.tabs", "shot.anchors", "shot.actions", "shot.modes")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,47}$")
_VALID_MODES = ("comic", "motion_comic", "image_to_video")
_STORE_ACTIONS = (
    "synthesizeShotPrompt", "autoFitShotDuration", "autoFitAllDurations",
    "selectCandidate",
)

# 内置目录：与前端 slots/builtin.tsx 同构（后端目录只做管理面展示与校验基准）
BUILTIN_SLOT_CATALOG: List[Dict[str, Any]] = [
    {"slot": "shot.modes", "id": "comic", "label": "漫画制作", "order": 10, "source": "builtin",
     "caps": {"canImage": True, "canVideo": False, "canTts": False, "direct": False,
              "needsFirstFrame": False, "lockPreview": "image"}},
    {"slot": "shot.modes", "id": "motion_comic", "label": "漫剧制作", "order": 20, "source": "builtin",
     "caps": {"canImage": False, "canVideo": True, "canTts": True, "direct": True,
              "needsFirstFrame": False, "lockPreview": "video"}},
    {"slot": "shot.modes", "id": "image_to_video", "label": "图生视频", "order": 30, "source": "builtin",
     "caps": {"canImage": True, "canVideo": True, "canTts": True, "direct": False,
              "needsFirstFrame": True, "lockPreview": None}},
    {"slot": "shot.tabs", "id": "visual", "label": "画面与角色", "order": 10, "source": "builtin"},
    {"slot": "shot.tabs", "id": "dialogue", "label": "台词与配音", "order": 20, "source": "builtin"},
    {"slot": "shot.tabs", "id": "motion", "label": "运镜动态", "order": 30, "source": "builtin",
     "when": {"not_mode": ["comic"]}},
    {"slot": "shot.anchors", "id": "character", "label": "角色锚定", "order": 10, "source": "builtin"},
    {"slot": "shot.anchors", "id": "scene", "label": "场景空间", "order": 20, "source": "builtin"},
    {"slot": "shot.anchors", "id": "prop", "label": "道具法宝", "order": 30, "source": "builtin"},
    {"slot": "shot.actions", "id": "batch-image", "label": "批量生图", "order": 10, "source": "builtin"},
    {"slot": "shot.actions", "id": "batch-tts", "label": "批量配音", "order": 20, "source": "builtin"},
    {"slot": "shot.actions", "id": "batch-video", "label": "批量视频", "order": 30, "source": "builtin"},
]


def _base_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "storyboard_slots"
    except Exception:
        base = Path("storage") / "storyboard_slots"
    base.mkdir(parents=True, exist_ok=True)
    (base / "custom").mkdir(parents=True, exist_ok=True)
    return base


def _overrides_path() -> Path:
    return _base_dir() / "overrides.json"


def validate_slot_doc(doc: Dict[str, Any]) -> Optional[str]:
    """返回 None 表示通过，否则返回错误信息（中文）。"""
    if not isinstance(doc, dict):
        return "槽声明必须是 JSON 对象"
    slot = doc.get("slot")
    if slot not in SLOT_CONTAINERS:
        return f"slot 非法: {slot}，支持 {list(SLOT_CONTAINERS)}"
    sid = str(doc.get("id") or "")
    if not _ID_RE.match(sid):
        return f"id 非法: {sid}（小写字母数字/_/-，2-48 字符）"
    if not str(doc.get("label") or "").strip():
        return "label 不能为空"
    try:
        order = int(doc.get("order", 50))
    except Exception:
        return "order 必须是整数"
    if not -1000 <= order <= 1000:
        return "order 超出范围（-1000~1000）"
    when = doc.get("when") or {}
    if not isinstance(when, dict):
        return "when 必须是对象"
    for k in ("mode", "not_mode"):
        if k in when:
            modes = when[k]
            if not isinstance(modes, list) or not modes or any(m not in _VALID_MODES for m in modes):
                return f"when.{k} 非法，需为制作模式数组的子集"
    if slot == "shot.tabs":
        blocks = doc.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            return "shot.tabs 需提供非空 blocks"
        for b in blocks:
            if not isinstance(b, dict) or b.get("kind") not in ("info", "shot_field", "buttons"):
                return f"block 非法: {str(b)[:80]}"
            if b.get("kind") == "shot_field" and not b.get("field"):
                return "shot_field block 需提供 field"
            if b.get("kind") == "buttons":
                btns = b.get("buttons")
                if not isinstance(btns, list) or not btns:
                    return "buttons block 需提供非空 buttons"
                for btn in btns:
                    err = _validate_run(btn.get("run"), "button.run")
                    if err:
                        return err
    elif slot == "shot.anchors":
        if not str(doc.get("field") or "").strip():
            return "shot.anchors 需提供 field（分镜字段名）"
    elif slot == "shot.actions":
        err = _validate_run(doc.get("run"), "run")
        if err:
            return err
    elif slot == "shot.modes":
        caps = doc.get("caps")
        if not isinstance(caps, dict):
            return "shot.modes 需提供 caps"
        for k in ("canImage", "canVideo", "canTts", "direct", "needsFirstFrame"):
            if not isinstance(caps.get(k), bool):
                return f"caps.{k} 必须是布尔值"
        if caps.get("lockPreview") not in (None, "image", "video"):
            return "caps.lockPreview 仅支持 null/image/video"
        ir = doc.get("inherit_render")
        if ir not in _VALID_MODES:
            return "inherit_render 非法，需为内置模式之一"
    return None


def _validate_run(run: Any, where: str) -> Optional[str]:
    if not isinstance(run, dict):
        return f"{where} 必须是对象"
    if "extension" in run:
        if not str(run["extension"]).strip():
            return f"{where}.extension 不能为空"
        if not isinstance(run.get("args", {}), dict):
            return f"{where}.args 必须是对象"
        return None
    if "store_action" in run:
        if run["store_action"] not in _STORE_ACTIONS:
            return f"{where}.store_action 非法，支持 {list(_STORE_ACTIONS)}"
        return None
    return f"{where} 需包含 extension 或 store_action"


def _load_plugin_slot_docs() -> List[Dict[str, Any]]:
    """读取已启用插件包内的 slots/*.json（失败隔离到包）。"""
    docs: List[Dict[str, Any]] = []
    try:
        from app.plugins import manager as pm
        idx = pm._load_index() or {}
        records = (idx.get("plugins") or {}) if isinstance(idx, dict) else {}
        for pid, rec in records.items():
            if not isinstance(rec, dict) or not rec.get("enabled"):
                continue
            try:
                pdir = os.path.join(pm._plugins_root(), str(pid))
                mf_path = os.path.join(pdir, "plugin.json")
                if not os.path.isfile(mf_path):
                    continue
                with open(mf_path, "r", encoding="utf-8") as f:
                    mf = json.load(f)
                patterns = ((mf.get("extensionPoints") or {}).get("storyboard_slots") or [])
                for pat in patterns:
                    pat = str(pat).replace("\\", "/").lstrip("/")
                    if ".." in pat or pat.startswith("/"):
                        continue
                    for fp in glob.glob(os.path.join(pdir, pat), recursive=True):
                        try:
                            if os.path.getsize(fp) > 200_000:
                                continue
                            with open(fp, "r", encoding="utf-8") as f:
                                doc = json.load(f)
                            err = validate_slot_doc(doc)
                            docs.append({"doc": doc, "source": "plugin", "source_detail": str(pid),
                                         "path": fp, "valid": err is None, "error": err})
                        except Exception as e:
                            docs.append({"doc": {}, "source": "plugin", "source_detail": str(pid),
                                         "path": fp, "valid": False, "error": f"解析失败: {e}"[:200]})
            except Exception:
                continue
    except Exception:
        pass
    return docs


def _load_custom_slot_docs() -> List[Dict[str, Any]]:
    docs: List[Dict[str, Any]] = []
    cdir = _base_dir() / "custom"
    for fp in sorted(cdir.glob("*.json")):
        try:
            with open(fp, "r", encoding="utf-8") as f:
                doc = json.load(f)
            err = validate_slot_doc(doc)
            docs.append({"doc": doc, "source": "standalone", "source_detail": "",
                         "path": str(fp), "valid": err is None, "error": err})
        except Exception as e:
            docs.append({"doc": {}, "source": "standalone", "source_detail": "",
                         "path": str(fp), "valid": False, "error": f"解析失败: {e}"[:200]})
    return docs


def get_project_overrides(project_id: str) -> Dict[str, Any]:
    try:
        with open(_overrides_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        projs = (data.get("projects") or {}) if isinstance(data, dict) else {}
        ov = projs.get(project_id or "") or {}
        return {"disabled": list(ov.get("disabled") or []), "order": dict(ov.get("order") or {})}
    except Exception:
        return {"disabled": [], "order": {}}


def _valid_keys() -> set:
    """当前实际存在的槽 key 集合（内置 + 有效插件 + 有效裸件）。"""
    keys = {f"{b['slot']}:{b['id']}" for b in BUILTIN_SLOT_CATALOG}
    for item in _load_plugin_slot_docs() + _load_custom_slot_docs():
        if item["valid"]:
            d = item["doc"]
            keys.add(f"{d['slot']}:{d['id']}")
    return keys


def _prune_overrides(data: Dict[str, Any]) -> int:
    """清理 overrides 中已不存在的槽引用（悬空 id）。返回清理条数。"""
    valid = _valid_keys()
    removed = 0
    for ov in (data.get("projects") or {}).values():
        if not isinstance(ov, dict):
            continue
        old_disabled = list(ov.get("disabled") or [])
        ov["disabled"] = [k for k in old_disabled if k in valid]
        removed += len(old_disabled) - len(ov["disabled"])
        order = ov.get("order") or {}
        if isinstance(order, dict):
            new_order = {k: v for k, v in order.items() if k in valid}
            removed += len(order) - len(new_order)
            ov["order"] = new_order
    return removed


def set_project_overrides(project_id: str, disabled: List[str], order: Dict[str, int]) -> Dict[str, Any]:
    _base_dir()
    try:
        with open(_overrides_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    valid = _valid_keys()
    projs = data.setdefault("projects", {})
    projs[project_id] = {
        "disabled": [str(x) for x in (disabled or []) if str(x) in valid][:200],
        "order": {str(k): int(v) for k, v in (order or {}).items() if str(k) in valid},
    }
    _prune_overrides(data)
    tmp = _overrides_path().with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _overrides_path())
    return projs[project_id]


def list_effective_slots(project_id: str = "") -> Dict[str, Any]:
    """合并内置 + 插件 + 裸件，叠加项目覆盖。key 为 slot:id，全局唯一。"""
    merged: Dict[str, Dict[str, Any]] = {}
    for b in BUILTIN_SLOT_CATALOG:
        merged[f"{b['slot']}:{b['id']}"] = {**b, "valid": True, "error": None,
                                            "source_detail": "", "path": ""}
    for item in _load_plugin_slot_docs() + _load_custom_slot_docs():
        doc = item["doc"]
        if not item["valid"]:
            merged[f"invalid:{os.path.basename(item['path'])}"] = {
                "slot": str(doc.get("slot") or "?"), "id": str(doc.get("id") or "?"),
                "label": "（无效槽声明）", "order": 9999, "source": item["source"],
                "source_detail": item["source_detail"], "path": item["path"],
                "valid": False, "error": item["error"]}
            continue
        merged[f"{doc['slot']}:{doc['id']}"] = {
            **doc, "source": item["source"], "source_detail": item["source_detail"],
            "path": item["path"], "valid": True, "error": None}
    ov = get_project_overrides(project_id) if project_id else {"disabled": [], "order": {}}
    disabled = set(ov.get("disabled") or [])
    order_ov = ov.get("order") or {}
    items = []
    for key, d in merged.items():
        if key in disabled:
            continue
        if key in order_ov:
            d = {**d, "order": order_ov[key]}
        items.append({"key": key, **d})
    items.sort(key=lambda e: (e.get("slot", ""), e.get("order", 50), e.get("id", "")))
    return {"slots": items, "total": len(items),
            "overrides": ov if project_id else {"disabled": [], "order": {}}}


def save_custom_slot(doc: Dict[str, Any]) -> Dict[str, Any]:
    err = validate_slot_doc(doc)
    if err:
        raise ValueError(err)
    sid = str(doc["id"])
    # 去重：内置 / 插件 / 裸件同 slot:id 不可重复
    existing = list_effective_slots().get("slots") or []
    for e in existing:
        if e.get("slot") == doc["slot"] and e.get("id") == sid and e.get("valid"):
            raise ValueError(f"槽已存在: {doc['slot']}:{sid}（来源 {e.get('source')}/{e.get('source_detail') or '内置'}）")
    path = _base_dir() / "custom" / f"{doc['slot'].replace('.', '_')}__{sid}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    return {"slot": doc["slot"], "id": sid, "path": str(path)}


def delete_custom_slot(slot: str, sid: str) -> bool:
    path = _base_dir() / "custom" / f"{slot.replace('.', '_')}__{sid}.json"
    try:
        if path.exists():
            path.unlink()
            _remove_key_from_overrides(f"{slot}:{sid}")
            return True
    except Exception:
        pass
    return False


def _remove_key_from_overrides(key: str) -> None:
    """删除某个槽后，从所有项目覆盖里移除它的悬空引用。"""
    try:
        with open(_overrides_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        changed = False
        for ov in (data.get("projects") or {}).values():
            if not isinstance(ov, dict):
                continue
            if key in (ov.get("disabled") or []):
                ov["disabled"] = [x for x in ov["disabled"] if x != key]
                changed = True
            order = ov.get("order") or {}
            if isinstance(order, dict) and key in order:
                order.pop(key, None)
                changed = True
        if changed:
            tmp = _overrides_path().with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, _overrides_path())
    except Exception:
        pass
