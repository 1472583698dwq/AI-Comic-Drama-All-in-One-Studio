"""
通用素材库管理器 - 覆盖 人物/场景/道具/背景/特效 等
存储：storage/assets/{id}/meta.json + original 文件
索引：内存 + 文件系统扫描，无需DB，支持搜索/标签/分类/状态/分页
"""
import os
import json
import time
import uuid
import shutil
from typing import Dict, Any, List, Optional
from pathlib import Path

from app.core.config import settings
from app.models.asset import Asset, ASSET_CATEGORIES, ASSET_STATUS

ASSETS_ROOT = os.path.join(settings.STORAGE_DIR, "assets")
os.makedirs(ASSETS_ROOT, exist_ok=True)

# 兼容旧角色库：若 assets 为空，可从 project 迁移的占位
MIGRATED_MARKER = os.path.join(ASSETS_ROOT, ".migrated")

def _asset_dir(asset_id: str) -> str:
    return os.path.join(ASSETS_ROOT, asset_id)

def _meta_path(asset_id: str) -> str:
    return os.path.join(_asset_dir(asset_id), "meta.json")

def _load_asset(asset_id: str) -> Optional[Asset]:
    mp = _meta_path(asset_id)
    if not os.path.exists(mp):
        return None
    try:
        with open(mp, "r", encoding="utf-8") as f:
            data = json.load(f)
        return Asset.model_validate(data)
    except Exception:
        return None

def _save_asset(asset: Asset):
    d = _asset_dir(asset.id)
    os.makedirs(d, exist_ok=True)
    asset.touch()
    with open(_meta_path(asset.id), "w", encoding="utf-8") as f:
        json.dump(asset.model_dump(), f, ensure_ascii=False, indent=2)

class AssetManager:
    def list_assets(self, category: Optional[str] = None, status: Optional[str] = None, tag: Optional[str] = None, q: Optional[str] = None, project_id: Optional[str] = None, page: int = 1, limit: int = 24, sort: str = "updated_at", scope: Optional[str] = None, include_shared: bool = True) -> Dict[str, Any]:
        assets: List[Asset] = []
        if not os.path.exists(ASSETS_ROOT):
            return {"assets": [], "total": 0, "page": page, "limit": limit}
        for entry in os.listdir(ASSETS_ROOT):
            adir = os.path.join(ASSETS_ROOT, entry)
            if not os.path.isdir(adir):
                continue
            mp = os.path.join(adir, "meta.json")
            if not os.path.exists(mp):
                continue
            asset = _load_asset(entry)
            if not asset:
                continue
            # 兼容旧数据：无 scope 视为 project，无 shared_to 视为 []
            if not getattr(asset, "scope", None):
                asset.scope = "global" if not asset.project_id else "project"
            # 旧数据迁移：project 作用域但 project_id 为空 视为全局（磁盘默认 scope=project 导致旧全局资产被误判）
            if getattr(asset, "scope", "project") == "project" and not asset.project_id:
                asset.scope = "global"
            if not getattr(asset, "shared_to", None):
                asset.shared_to = []
            # 过滤
            if category and asset.category != category:
                continue
            if status and asset.status != status:
                continue
            if scope and getattr(asset, "scope", "project") != scope:
                continue
            if project_id:
                # 资产可见性：全局 或 归属当前项目 或 已共享到当前项目
                # 当 project_id 过滤时，scope==global 的资产始终可见（除非 scope 过滤已限制）
                if include_shared:
                    visible = (
                        getattr(asset, "scope", "project") == "global"
                        or asset.project_id == project_id
                        or project_id in (getattr(asset, "shared_to", []) or [])
                        or (not asset.project_id and getattr(asset, "scope", "project") == "global")
                    )
                    if not visible:
                        continue
                else:
                    # 严格模式：仅归属该 project 的且非全局
                    if asset.project_id != project_id:
                        continue
            if tag and tag not in (asset.tags or []):
                continue
            if q:
                ql = q.lower()
                hay = f"{asset.name} {asset.description} {asset.visual_prompt} {' '.join(asset.tags or [])}".lower()
                if ql not in hay:
                    continue
            assets.append(asset)
        # 排序
        if sort == "created_at":
            assets.sort(key=lambda a: a.created_at, reverse=True)
        elif sort == "name":
            assets.sort(key=lambda a: a.name.lower())
        else:
            assets.sort(key=lambda a: a.updated_at, reverse=True)
        total = len(assets)
        # 分页
        start = (page - 1) * limit
        end = start + limit
        page_items = assets[start:end]
        return {
            "assets": [a.model_dump() for a in page_items],
            "total": total,
            "page": page,
            "limit": limit,
            "has_more": end < total,
        }

    def get_asset(self, asset_id: str) -> Optional[Asset]:
        return _load_asset(asset_id)

    def create_asset(self, data: Dict[str, Any], file_bytes: Optional[bytes] = None, filename: Optional[str] = None) -> Asset:
        # 校验 category
        cat = data.get("category", "other")
        if cat not in ASSET_CATEGORIES:
            cat = "other"
        st = data.get("status", "approved")
        if st not in ASSET_STATUS:
            st = "approved"
        # P0: scope/shared_to
        scope_val = data.get("scope", "project")
        if scope_val not in ("project", "global"):
            scope_val = "project"
        shared = data.get("shared_to", []) or []
        # 若 scope==global 则强制 project_id=None
        proj_id_val = data.get("project_id")
        if scope_val == "global":
            proj_id_val = None
        asset = Asset(
            id=f"ast_{uuid.uuid4().hex[:8]}",
            name=data.get("name", "未命名素材"),
            category=cat,
            subcategory=data.get("subcategory"),
            status=st,
            description=data.get("description", ""),
            tags=data.get("tags", []) or [],
            visual_prompt=data.get("visual_prompt", "") or "",
            negative_prompt=data.get("negative_prompt"),
            style_preset=data.get("style_preset"),
            project_id=proj_id_val,
            scope=scope_val,
            shared_to=shared,
            style_anchor_id=data.get("style_anchor_id"),
            lora_trigger=data.get("lora_trigger"),
            voice_id=data.get("voice_id"),
            voice_name=data.get("voice_name"),
            source=data.get("source", "upload"),
            extra=data.get("extra", {}) or {},
        )
        # 处理文件
        if file_bytes and filename:
            asset = self._attach_file(asset, file_bytes, filename)
        elif data.get("file_url"):
            # 直接引用已有URL（如 /storage/generated/xxx.png 或 http）
            asset.file_url = data["file_url"]
            asset.thumb_url = data["file_url"]
        _save_asset(asset)
        return asset

    def _attach_file(self, asset: Asset, file_bytes: bytes, filename: str) -> Asset:
        d = _asset_dir(asset.id)
        os.makedirs(d, exist_ok=True)
        # 清理旧文件
        ext = os.path.splitext(filename)[1] or ".png"
        if ext.lower() not in [".png",".jpg",".jpeg",".webp",".mp3",".wav",".mp4",".glb",".fbx"]:
            ext = ".png"
        out_name = f"original{ext}"
        out_path = os.path.join(d, out_name)
        with open(out_path, "wb") as f:
            f.write(file_bytes)
        # 生成 file_url（通过 /storage 挂载）
        rel = os.path.relpath(out_path, settings.STORAGE_DIR).replace("\\", "/")
        asset.file_url = f"/storage/{rel}"
        asset.thumb_url = asset.file_url
        asset.file_path = out_path
        # 尝试获取宽高（图片）
        try:
            from PIL import Image
            from io import BytesIO
            im = Image.open(BytesIO(file_bytes))
            asset.width, asset.height = im.size
        except Exception:
            pass
        return asset

    def update_asset(self, asset_id: str, updates: Dict[str, Any], file_bytes: Optional[bytes] = None, filename: Optional[str] = None) -> Optional[Asset]:
        asset = _load_asset(asset_id)
        if not asset:
            return None
        # 允许更新的字段
        for k in ["name","category","subcategory","description","tags","visual_prompt","negative_prompt","style_preset","status","style_anchor_id","lora_trigger","voice_id","voice_name","three_views","extra","project_id","scope","shared_to"]:
            if k in updates and updates[k] is not None:
                if k == "category" and updates[k] not in ASSET_CATEGORIES:
                    continue
                if k == "status" and updates[k] not in ASSET_STATUS:
                    continue
                if k == "scope" and updates[k] not in ("project","global"):
                    continue
                setattr(asset, k, updates[k])
        # 若改为 global，清空 project_id
        if updates.get("scope") == "global":
            asset.project_id = None
        if "file_url" in updates and updates["file_url"]:
            asset.file_url = updates["file_url"]
            asset.thumb_url = updates["file_url"]
        if file_bytes and filename:
            asset = self._attach_file(asset, file_bytes, filename)
        _save_asset(asset)
        return asset

    def delete_asset(self, asset_id: str) -> bool:
        d = _asset_dir(asset_id)
        if not os.path.exists(d):
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def duplicate_asset(self, asset_id: str) -> Optional[Asset]:
        src = _load_asset(asset_id)
        if not src:
            return None
        data = src.model_dump()
        data.pop("id", None)
        data["name"] = f"{src.name}_副本"
        # 复制文件
        src_dir = _asset_dir(asset_id)
        new_asset = Asset.model_validate({**data, "id": f"ast_{uuid.uuid4().hex[:8]}"})
        # 复制原始文件
        for fname in os.listdir(src_dir):
            if fname == "meta.json":
                continue
            src_path = os.path.join(src_dir, fname)
            if os.path.isfile(src_path):
                new_dir = _asset_dir(new_asset.id)
                os.makedirs(new_dir, exist_ok=True)
                shutil.copy2(src_path, os.path.join(new_dir, fname))
                rel = os.path.relpath(os.path.join(new_dir, fname), settings.STORAGE_DIR).replace("\\", "/")
                new_asset.file_url = f"/storage/{rel}"
                new_asset.thumb_url = new_asset.file_url
                new_asset.file_path = os.path.join(new_dir, fname)
                break
        _save_asset(new_asset)
        return new_asset

    def get_stats(self) -> Dict[str, Any]:
        counts: Dict[str, int] = {c: 0 for c in ASSET_CATEGORIES}
        status_counts: Dict[str, int] = {s: 0 for s in ASSET_STATUS}
        scope_counts: Dict[str, int] = {"project": 0, "global": 0}
        total = 0
        tags: Dict[str, int] = {}
        if os.path.exists(ASSETS_ROOT):
            for entry in os.listdir(ASSETS_ROOT):
                adir = os.path.join(ASSETS_ROOT, entry)
                if not os.path.isdir(adir):
                    continue
                a = _load_asset(entry)
                if not a:
                    continue
                total += 1
                counts[a.category] = counts.get(a.category, 0) + 1
                status_counts[a.status] = status_counts.get(a.status, 0) + 1
                scope_counts[getattr(a, "scope", "project")] = scope_counts.get(getattr(a, "scope", "project"), 0) + 1
                for t in (a.tags or []):
                    tags[t] = tags.get(t, 0) + 1
        return {"total": total, "by_category": counts, "by_status": status_counts, "by_scope": scope_counts, "tags": tags}

    def search_tags(self, q: Optional[str] = None) -> List[str]:
        stats = self.get_stats()
        all_tags = list(stats["tags"].keys())
        if q:
            ql = q.lower()
            all_tags = [t for t in all_tags if ql in t.lower()]
        return sorted(all_tags)

asset_manager = AssetManager()
