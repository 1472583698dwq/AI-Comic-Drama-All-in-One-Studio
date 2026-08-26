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
        for m in _load_index():
            if m.get("id") == project_id:
                return m
        return None

    def get_content(self, project_id: str) -> Optional[Dict[str, Any]]:
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

    def save_canvas(self, project_id: str, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        if not self.get_meta(project_id):
            raise FileNotFoundError(f"项目不存在: {project_id}")
        os.makedirs(os.path.join(PROJECTS_ROOT, project_id), exist_ok=True)
        with open(_canvas_path(project_id), "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
        return snapshot

    def get_canvas(self, project_id: str) -> Optional[Dict[str, Any]]:
        p = _canvas_path(project_id)
        if not os.path.exists(p):
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None


project_manager = ProjectManager()
