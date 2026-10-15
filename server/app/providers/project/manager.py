"""
项目管理器 — ProjectMeta 索引 + ProjectContent 文件存储
存储结构：
  storage/projects/index.json  # ProjectMeta[]
  storage/projects/{id}/content.json  # Project (schemas.Project)
  storage/projects/{id}/canvas.json   # tldraw snapshot (预留 P1)
  storage/projects/{id}/cover.*       # 封面
"""
import os
import json
import time
import uuid
from typing import List, Optional, Dict, Any
from datetime import datetime

from app.core.config import settings
from app.models.project_meta import ProjectMeta
from app.models.schemas import Project

PROJECTS_ROOT = os.path.join(settings.STORAGE_DIR, "projects")
INDEX_PATH = os.path.join(PROJECTS_ROOT, "index.json")
os.makedirs(PROJECTS_ROOT, exist_ok=True)


def _load_index() -> List[Dict[str, Any]]:
    if not os.path.exists(INDEX_PATH):
        return []
    try:
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_index(items: List[Dict[str, Any]]):
    os.makedirs(PROJECTS_ROOT, exist_ok=True)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def _content_path(project_id: str) -> str:
    return os.path.join(PROJECTS_ROOT, project_id, "content.json")


def _canvas_path(project_id: str) -> str:
    return os.path.join(PROJECTS_ROOT, project_id, "canvas.json")


def _agent_sessions_path(project_id: str) -> str:
    return os.path.join(PROJECTS_ROOT, project_id, "agent_sessions.json")


# ===== 双 ID 兼容层 =====
# 存储目录/index.json 用目录名 id（proj_xxx），但 split_novel_script 生成的 content.json 内部
# project.id 是另一个 UUID。前端（及导演 Agent 的 context.project_id）常把内部 UUID 当 project_id 传入，
# 导致 canvas_create_node/save_canvas 等写路径报"项目不存在"。此处把任意传入 id 统一解析到真实目录名。
_UUID_ID_MAP: Dict[str, str] = {}
_UUID_MAP_BUILT = False


def _rebuild_uuid_map():
    global _UUID_MAP_BUILT
    _UUID_ID_MAP.clear()
    try:
        for entry in os.listdir(PROJECTS_ROOT):
            cp = _content_path(entry)
            if not os.path.isdir(os.path.join(PROJECTS_ROOT, entry)) or not os.path.exists(cp):
                continue
            try:
                with open(cp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                cid = str((data or {}).get("id") or "")
                if cid and cid != entry:
                    _UUID_ID_MAP[cid] = entry
            except Exception:
                continue
    except Exception:
        pass
    _UUID_MAP_BUILT = True


def _resolve_id(project_id: str) -> str:
    if not project_id:
        return project_id
    if os.path.isdir(os.path.join(PROJECTS_ROOT, project_id)):
        return project_id
    if not _UUID_MAP_BUILT:
        _rebuild_uuid_map()
    resolved = _UUID_ID_MAP.get(project_id, project_id)
    if resolved != project_id:
        return resolved
    # 目录可能新建：强制重建一次映射再试
    _rebuild_uuid_map()
    return _UUID_ID_MAP.get(project_id, project_id)


# REQ-toonflow-canvas 画布条目除 name/nodes/edges/updated_at 外的顶层键（schema_version、viewport…）原样落盘；
# 下面这些属于容器/路由层（画布 id、存储结构版本、请求包装），不进画布条目
_CANVAS_RESERVED_KEYS = frozenset({
    "canvas_id", "name", "nodes", "edges", "updated_at",
    "project_id", "version", "active_canvas_id", "canvases", "snapshot",
})


def _canvas_extras(src: Any) -> Dict[str, Any]:
    if not isinstance(src, dict):
        return {}
    return {k: v for k, v in src.items() if k not in _CANVAS_RESERVED_KEYS}


class ProjectManager:
    def list_projects(self, q: Optional[str] = None, status: Optional[str] = None, sort: str = "updated_at") -> List[Dict[str, Any]]:
        items = _load_index()
        # 过滤
        filtered = []
        for m in items:
            if status and status != "all" and m.get("status") != status:
                continue
            if q:
                ql = q.lower()
                hay = f"{m.get('title','')} {m.get('description','')} {m.get('style_preset','')}".lower()
                if ql not in hay:
                    continue
            filtered.append(m)
        # 排序
        if sort == "created_at":
            filtered.sort(key=lambda x: x.get("created_at",""), reverse=True)
        elif sort == "name":
            filtered.sort(key=lambda x: x.get("title","").lower())
        elif sort == "last_opened_at":
            filtered.sort(key=lambda x: x.get("last_opened_at",""), reverse=True)
        else:  # updated_at
            filtered.sort(key=lambda x: x.get("updated_at",""), reverse=True)
        return filtered

    def get_meta(self, project_id: str) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        for m in _load_index():
            if m.get("id") == project_id:
                return m
        return None

    def get_content(self, project_id: str) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        p = _content_path(project_id)
        if not os.path.exists(p):
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def get_combined(self, project_id: str) -> Optional[Dict[str, Any]]:
        meta = self.get_meta(project_id)
        if not meta:
            return None
        content = self.get_content(project_id)
        return {"meta": meta, "content": content}

    def create_project(self, title: str, style_preset: str = "donghua_xianxia", aspect_ratio: str = "9:16", description: str = "", source: str = "blank", cover_url: Optional[str] = None, initial_content: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        meta = ProjectMeta(
            id=f"proj_{uuid.uuid4().hex[:8]}",
            title=title.strip() or "未命名项目",
            style_preset=style_preset or "donghua_xianxia",
            aspect_ratio=aspect_ratio or "9:16",
            description=description or "",
            source=source,
            cover_url=cover_url,
            stats={"shots": 0, "duration": 0, "characters": 0},
        )
        # 写入索引
        items = _load_index()
        items.append(meta.model_dump())
        _save_index(items)
        # 创建目录与空白内容
        os.makedirs(os.path.join(PROJECTS_ROOT, meta.id), exist_ok=True)
        if initial_content:
            # 尝试适配 Project schema
            try:
                from app.models.schemas import Project as ProjModel
                proj = ProjModel.model_validate(initial_content)
                # 确保 id 与 meta 一致
                proj.id = meta.id
                with open(_content_path(meta.id), "w", encoding="utf-8") as f:
                    json.dump(proj.model_dump(), f, ensure_ascii=False, indent=2)
                meta.stats = {"shots": sum(len(s.shots) for s in proj.scenes), "duration": sum(s.duration for sc in proj.scenes for s in sc.shots), "characters": len(proj.characters)}
                # 更新 stats
                self._update_meta_in_index(meta)
            except Exception as e:
                with open(_content_path(meta.id), "w", encoding="utf-8") as f:
                    json.dump(initial_content, f, ensure_ascii=False, indent=2)
        else:
            # 空白内容（不强制创建 content.json，前端进入时按需创建）
            pass
        return meta.model_dump()

    def _update_meta_in_index(self, meta: ProjectMeta):
        items = _load_index()
        for i, m in enumerate(items):
            if m.get("id") == meta.id:
                items[i] = meta.model_dump()
                break
        _save_index(items)

    def update_meta(self, project_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        items = _load_index()
        for i, m in enumerate(items):
            if m.get("id") == project_id:
                meta = ProjectMeta.model_validate(m)
                for k in ["title","style_preset","aspect_ratio","status","cover_url","description"]:
                    if k in updates and updates[k] is not None:
                        setattr(meta, k, updates[k])
                # 校验 status
                if meta.status not in ("draft","producing","done","archived"):
                    meta.status = "draft"
                meta.touch()
                items[i] = meta.model_dump()
                _save_index(items)
                return meta.model_dump()
        return None

    def delete_project(self, project_id: str) -> bool:
        project_id = _resolve_id(project_id)
        items = _load_index()
        new_items = [m for m in items if m.get("id") != project_id]
        if len(new_items) == len(items):
            return False
        _save_index(new_items)
        # 删除目录
        import shutil
        d = os.path.join(PROJECTS_ROOT, project_id)
        if os.path.exists(d):
            shutil.rmtree(d, ignore_errors=True)
        return True

    def duplicate_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        meta_dict = self.get_meta(project_id)
        if not meta_dict:
            return None
        new_id = f"proj_{uuid.uuid4().hex[:8]}"
        new_meta = ProjectMeta.model_validate({**meta_dict, "id": new_id, "title": meta_dict.get("title","") + "_副本", "created_at": datetime.now().isoformat(), "updated_at": datetime.now().isoformat(), "last_opened_at": datetime.now().isoformat()})
        items = _load_index()
        items.append(new_meta.model_dump())
        _save_index(items)
        # 复制目录
        import shutil
        src = os.path.join(PROJECTS_ROOT, project_id)
        dst = os.path.join(PROJECTS_ROOT, new_id)
        if os.path.exists(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
            # 修正 content.json 内的 id
            cp = _content_path(new_id)
            if os.path.exists(cp):
                try:
                    with open(cp, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if isinstance(data, dict) and "id" in data:
                        data["id"] = new_id
                        data["title"] = new_meta.title
                        with open(cp, "w", encoding="utf-8") as f:
                            json.dump(data, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass
        else:
            os.makedirs(dst, exist_ok=True)
        return new_meta.model_dump()

    def open_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        items = _load_index()
        for i, m in enumerate(items):
            if m.get("id") == project_id:
                meta = ProjectMeta.model_validate(m)
                meta.open()
                items[i] = meta.model_dump()
                _save_index(items)
                return meta.model_dump()
        return None

    def save_content(self, project_id: str, content: Dict[str, Any]) -> Dict[str, Any]:
        project_id = _resolve_id(project_id)
        # 确保 meta 存在
        meta_dict = self.get_meta(project_id)
        if not meta_dict:
            raise FileNotFoundError(f"项目不存在: {project_id}")
        # 校验 content 可为 Project
        try:
            from app.models.schemas import Project as ProjModel
            proj = ProjModel.model_validate(content)
            content = proj.model_dump()
        except Exception:
            # 允许原始 dict 透传
            pass
        os.makedirs(os.path.join(PROJECTS_ROOT, project_id), exist_ok=True)
        with open(_content_path(project_id), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False, indent=2)
        # 更新 meta stats
        try:
            shots = 0
            duration = 0
            chars = 0
            if isinstance(content, dict):
                chars = len(content.get("characters", []))
                for sc in content.get("scenes", []):
                    shots += len(sc.get("shots", []))
                    for sh in sc.get("shots", []):
                        duration += float(sh.get("duration", 0) or 0)
            meta = ProjectMeta.model_validate(meta_dict)
            meta.stats = {"shots": shots, "duration": round(duration, 1), "characters": chars}
            meta.touch()
            self._update_meta_in_index(meta)
        except Exception:
            pass
        return content

    def save_canvas(self, project_id: str, snapshot: Dict[str, Any], canvas_id: Optional[str] = None, name: Optional[str] = None) -> Dict[str, Any]:
        project_id = _resolve_id(project_id)
        if not self.get_meta(project_id):
            raise FileNotFoundError(f"项目不存在: {project_id}")
        snap = snapshot if isinstance(snapshot, dict) else {}
        # REQ-toonflow-canvas 未显式指定画布时沿用快照自带的 canvas_id（get_canvas 读出的就是当前画布），
        # 否则「读当前画布 → 改 → save_canvas(pid, snap)」会把别的画布内容写进 default
        canvas_id = canvas_id or str(snap.get("canvas_id") or "") or "default"
        os.makedirs(os.path.join(PROJECTS_ROOT, project_id), exist_ok=True)
        # 归一化为多画布结构（兼容存量单画布文件，原样迁移为 default）
        store: Dict[str, Any] = {"version": 2, "active_canvas_id": canvas_id, "canvases": {}}
        p = _canvas_path(project_id)
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    old = json.load(f)
                if isinstance(old, dict) and isinstance(old.get("canvases"), dict):
                    store = old
                elif isinstance(old, dict):
                    store["canvases"]["default"] = {
                        **_canvas_extras(old),
                        "name": "默认画布",
                        "nodes": old.get("nodes", []),
                        "edges": old.get("edges", []),
                        "updated_at": old.get("updated_at", ""),
                    }
            except Exception:
                pass
        nodes = snap.get("nodes", [])
        edges = snap.get("edges", [])
        prev = store["canvases"].get(canvas_id) or {}
        entry = {
            # 已存的未知键先垫底、本次快照覆盖：保存时没带 viewport/schema_version 也不会把它们丢掉
            **_canvas_extras(prev),
            **_canvas_extras(snap),
            "name": name or prev.get("name") or ("默认画布" if canvas_id == "default" else canvas_id),
            "nodes": nodes,
            "edges": edges,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        store["canvases"][canvas_id] = entry
        store["active_canvas_id"] = canvas_id
        with open(p, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False, indent=2)
        saved = {"canvas_id": canvas_id, "name": entry["name"]}
        if "schema_version" in entry:
            saved["schema_version"] = entry["schema_version"]
        return saved

    def get_canvas(self, project_id: str, canvas_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        p = _canvas_path(project_id)
        if not os.path.exists(p):
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        # 存量单画布文件：原样返回
        if not isinstance(data.get("canvases"), dict):
            return data
        # 显式请求的画布不存在 → 返回 None（绝不回退，避免“新画布”载入默认画布内容）
        if canvas_id:
            cur = data["canvases"].get(canvas_id)
            if not cur:
                return None
            return {**_canvas_extras(cur), "canvas_id": canvas_id, "name": cur.get("name", canvas_id), "nodes": cur.get("nodes", []), "edges": cur.get("edges", [])}
        cid = data.get("active_canvas_id") or "default"
        cur = data["canvases"].get(cid) or data["canvases"].get("default")
        if not cur:
            return None
        return {**_canvas_extras(cur), "canvas_id": cid, "name": cur.get("name", cid), "nodes": cur.get("nodes", []), "edges": cur.get("edges", [])}

    def list_canvases(self, project_id: str) -> List[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        p = _canvas_path(project_id)
        if not os.path.exists(p):
            return []
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return []
        if not isinstance(data, dict):
            return []
        if not isinstance(data.get("canvases"), dict):
            legacy = data if isinstance(data.get("nodes"), list) else None
            if legacy is None:
                return []
            return [{"id": "default", "name": "默认画布", "updated_at": "", "node_count": len(legacy.get("nodes", [])),
                     "schema_version": legacy.get("schema_version")}]
        out = []
        for cid, c in data["canvases"].items():
            out.append({"id": cid, "name": (c or {}).get("name", cid), "updated_at": (c or {}).get("updated_at", ""), "node_count": len((c or {}).get("nodes", [])),
                        "schema_version": (c or {}).get("schema_version")})
        return out

    def rename_canvas(self, project_id: str, canvas_id: str, name: str) -> Dict[str, Any]:
        project_id = _resolve_id(project_id)
        p = _canvas_path(project_id)
        if not os.path.exists(p):
            raise FileNotFoundError(f"项目不存在或无画布: {project_id}")
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            raise ValueError(f"画布文件损坏: {e}")
        if not isinstance(data, dict) or not isinstance(data.get("canvases"), dict):
            raise ValueError("存量单画布暂不支持重命名，请先打开画布触发迁移")
        if canvas_id not in data["canvases"]:
            raise FileNotFoundError(f"画布不存在: {canvas_id}")
        data["canvases"][canvas_id]["name"] = name or canvas_id
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"id": canvas_id, "name": data["canvases"][canvas_id]["name"]}

    def delete_canvas(self, project_id: str, canvas_id: str) -> Dict[str, Any]:
        project_id = _resolve_id(project_id)
        p = _canvas_path(project_id)
        if not os.path.exists(p):
            raise FileNotFoundError(f"项目不存在或无画布: {project_id}")
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            raise ValueError(f"画布文件损坏: {e}")
        if not isinstance(data, dict) or not isinstance(data.get("canvases"), dict):
            raise ValueError("存量单画布不可删除（仅 default）")
        if canvas_id not in data["canvases"]:
            raise FileNotFoundError(f"画布不存在: {canvas_id}")
        if len(data["canvases"]) <= 1:
            raise ValueError("至少保留一个画布")
        del data["canvases"][canvas_id]
        if data.get("active_canvas_id") == canvas_id:
            data["active_canvas_id"] = "default" if "default" in data["canvases"] else next(iter(data["canvases"]))
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"deleted": canvas_id, "active_canvas_id": data.get("active_canvas_id")}

    def get_agent_sessions(self, project_id: str, scope: str = "all") -> List[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        p = _agent_sessions_path(project_id)
        if not os.path.exists(p):
            return []
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                return []
            # 清洗流式瞬态标记：断连/中止后遗留的 isThinkingStreaming=true 会让 UI 永久转圈
            for s in data:
                if not isinstance(s, dict):
                    continue
                for m in (s.get("messages") or []):
                    if not isinstance(m, dict):
                        continue
                    if m.get("isThinkingStreaming"):
                        m["isThinkingStreaming"] = False
                    if m.get("isStreaming"):
                        m["isStreaming"] = False
            # scope 隔离：页面版(page)与悬浮窗版(float)各自读写自己的会话；无 scope 的历史会话归 page
            scope = (scope or "all").strip()
            if scope and scope != "all":
                return [s for s in data if isinstance(s, dict) and (s.get("scope") or "page") == scope]
            return data
        except Exception:
            return []

    def save_agent_sessions(self, project_id: str, sessions: List[Dict[str, Any]], scope: Optional[str] = None) -> List[Dict[str, Any]]:
        project_id = _resolve_id(project_id)
        proj_dir = os.path.join(PROJECTS_ROOT, project_id)
        if not os.path.exists(proj_dir):
            raise FileNotFoundError(f"项目不存在: {project_id}")
        # scope 隔离写：只替换该 scope 的会话，保留另一端的会话不被覆盖
        scope = (scope or "").strip() or None
        if scope:
            try:
                existing = self.get_agent_sessions(project_id, scope="all")
            except Exception:
                existing = []
            keep = [s for s in existing if isinstance(s, dict) and (s.get("scope") or "page") != scope]
            stamped = []
            for s in (sessions or []):
                if isinstance(s, dict):
                    s = {**s, "scope": scope}
                stamped.append(s)
            sessions = keep + stamped
        p = _agent_sessions_path(project_id)
        temp_p = p + f".tmp.{os.getpid()}"
        with open(temp_p, "w", encoding="utf-8") as f:
            json.dump(sessions, f, ensure_ascii=False, indent=2)
        if os.path.exists(p):
            try:
                os.replace(temp_p, p)
            except Exception:
                try:
                    os.remove(p)
                except Exception:
                    pass
                os.rename(temp_p, p)
        else:
            os.rename(temp_p, p)
        return sessions

    def delete_agent_session(self, project_id: str, session_id: str) -> Dict[str, Any]:
        sessions = self.get_agent_sessions(project_id)
        filtered = [s for s in sessions if s.get("id") != session_id]
        self.save_agent_sessions(project_id, filtered)
        return {"deleted": session_id, "remaining_count": len(filtered)}


project_manager = ProjectManager()
