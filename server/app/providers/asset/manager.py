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
import mimetypes
from typing import Dict, Any, List, Optional
from pathlib import Path

from app.core.config import settings
from app.models.asset import Asset, ASSET_CATEGORIES, ASSET_STATUS

ASSETS_ROOT = os.path.join(settings.STORAGE_DIR, "assets")
os.makedirs(ASSETS_ROOT, exist_ok=True)

# 兼容旧角色库：若 assets 为空，可从 project 迁移的占位
MIGRATED_MARKER = os.path.join(ASSETS_ROOT, ".migrated")

# 悬空素材清理前的备份清单（jsonl，逐条追加，可人工找回）
MISSING_BACKUP = os.path.join(ASSETS_ROOT, ".missing_backup.jsonl")

# REQ-toonflow-canvas 素材文件保留真实扩展名（图片 / 视频 / 音频 / 3D 模型）。
# 以前白名单只有 png/jpg/jpeg/webp/mp3/wav/mp4/glb/fbx，其余（webm/m4a/mov/ogg/flac/aac/gif…）一律存成 original.png，
# 浏览器拿到 image/png 的音视频播不了，画布节点只能先转码或绕道附件上传。
# 不在白名单里的（html/svg/js 等同源可执行内容、未知格式）仍按旧规则落成 .png，不对外以原类型提供。
ASSET_FILE_EXTS = {
    # 图片
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
    # 视频
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ogv",
    # 音频
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".weba",
    # 3D 模型
    ".glb", ".fbx",
}

# 上传时浏览器给的 content-type → 扩展名（文件名没有可用扩展名时用）
_MIME_TO_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/pjpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/x-ms-bmp": ".bmp", "image/avif": ".avif",
    "video/mp4": ".mp4", "video/x-m4v": ".m4v", "video/quicktime": ".mov", "video/webm": ".webm",
    "video/x-matroska": ".mkv", "video/x-msvideo": ".avi", "video/avi": ".avi", "video/ogg": ".ogv",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
    "audio/vnd.wave": ".wav", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".aac",
    "audio/x-aac": ".aac", "audio/aacp": ".aac", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac",
    "audio/x-flac": ".flac", "audio/webm": ".weba",
    "model/gltf-binary": ".glb",
}

# 落盘后 /storage 静态服务按扩展名回 content-type（Starlette 用 mimetypes.guess_type）：
# 系统 mime.types 因平台而异（macOS 把 .m4a 报成 audio/mp4a-latm、.glb 没有登记会回 text/plain），这里统一成浏览器认的标准类型
ASSET_CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".bmp": "image/bmp", ".avif": "image/avif",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
    ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".weba": "audio/webm",
    ".glb": "model/gltf-binary", ".fbx": "application/octet-stream",
}


def register_asset_content_types() -> None:
    """REQ-toonflow-canvas 把素材扩展名的标准 content-type 登记进 mimetypes（幂等，模块导入时自动调用）"""
    for ext, ctype in ASSET_CONTENT_TYPES.items():
        mimetypes.add_type(ctype, ext)


register_asset_content_types()


def _sniff_ext(head: bytes) -> Optional[str]:
    """REQ-toonflow-canvas 按文件头认常见媒体格式（文件名 / content-type 都给不出扩展名时兜底）"""
    if not head:
        return None
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if head[:4] == b"RIFF" and len(head) >= 12:
        return {b"WEBP": ".webp", b"WAVE": ".wav", b"AVI ": ".avi"}.get(head[8:12])
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return ".mov"
        if brand in (b"M4A ", b"M4B ", b"M4P "):
            return ".m4a"
        if brand in (b"avif", b"avis"):
            return ".avif"
        if brand == b"M4V ":
            return ".m4v"
        return ".mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm" if b"webm" in head[:64] else ".mkv"
    if head.startswith(b"OggS"):
        return ".ogg"
    if head.startswith(b"fLaC"):
        return ".flac"
    if head.startswith(b"ID3"):
        return ".mp3"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xF6) == 0xF0:
        return ".aac"  # ADTS
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return ".mp3"  # MPEG audio frame sync
    if head.startswith(b"glTF"):
        return ".glb"
    if head.startswith(b"Kaydara FBX Binary"):
        return ".fbx"
    return None


def resolve_asset_ext(filename: Optional[str], content_type: Optional[str] = None, head: bytes = b"") -> str:
    """
    REQ-toonflow-canvas 素材落盘扩展名：文件名扩展名（白名单内）→ 上传 content-type → 文件头 → 旧规则 .png。
    返回小写、带点的扩展名，一定在 ASSET_FILE_EXTS 内。
    """
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in ASSET_FILE_EXTS:
        return ext
    ctype = (content_type or "").split(";")[0].strip().lower()
    by_type = _MIME_TO_EXT.get(ctype)
    if by_type:
        return by_type
    return _sniff_ext(head[:64]) or ".png"

# 删除素材的墓碑清单（jsonl，供云同步不复活 / 审计）
TOMBSTONES = os.path.join(ASSETS_ROOT, ".tombstones.jsonl")

# 墓碑 id 缓存（带 mtime 失效）：mirror 回拉 / 静态兜底用它挡住"复活"
_TOMBSTONE_CACHE: Dict[str, Any] = {"key": None, "ids": set()}

def load_tombstone_ids() -> set:
    """读取墓碑 id 集合（mtime 缓存，重复读零开销）。"""
    try:
        st = os.stat(TOMBSTONES)
        key = (st.st_mtime_ns, st.st_size)
    except Exception:
        _TOMBSTONE_CACHE["key"] = None
        _TOMBSTONE_CACHE["ids"] = set()
        return _TOMBSTONE_CACHE["ids"]
    if _TOMBSTONE_CACHE["key"] == key:
        return _TOMBSTONE_CACHE["ids"]
    ids = set()
    try:
        with open(TOMBSTONES, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    aid = (json.loads(line) or {}).get("id")
                    if aid:
                        ids.add(str(aid))
                except Exception:
                    continue
    except Exception:
        pass
    _TOMBSTONE_CACHE["key"] = key
    _TOMBSTONE_CACHE["ids"] = ids
    return ids

def is_tombstoned(asset_id: str) -> bool:
    return asset_id in load_tombstone_ids()

def _append_tombstone(asset: Asset, reason: str = "delete"):
    try:
        with open(TOMBSTONES, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": asset.id, "name": asset.name, "project_id": asset.project_id, "scope": asset.scope, "reason": reason, "deleted_at": _now()}, ensure_ascii=False) + "\n")
    except Exception:
        pass

def _asset_dir(asset_id: str) -> str:
    return os.path.join(ASSETS_ROOT, asset_id)

def _resolve_project_id(project_id: Optional[str]) -> Optional[str]:
    """把 content UUID 归一为项目目录名 proj_xxx（复用 ProjectManager 的双 ID 映射）。"""
    if not project_id:
        return project_id
    try:
        from app.providers.project.manager import _resolve_id as _proj_resolve
        return _proj_resolve(project_id)
    except Exception:
        return project_id

def _resolve_shared_targets(targets) -> List[str]:
    """归一 shared_to 目标项目 id 并去重（保持传入顺序）。"""
    out: List[str] = []
    if not isinstance(targets, list):
        return out
    for t in targets:
        if not isinstance(t, str) or not t.strip():
            continue
        rid = _resolve_project_id(t.strip()) or t.strip()
        if rid not in out:
            out.append(rid)
    return out

def _now() -> str:
    from datetime import datetime
    return datetime.now().isoformat()

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
    # 悬空记录懒校验：每进程只在首次 list_assets 时清扫一次，避免每次列表都全量 stat
    _missing_swept = False

    @staticmethod
    def visible_to(asset: Asset, project_id: Optional[str], include_shared: bool = True) -> bool:
        """可见性：全局 ∪ 归属本项目 ∪ 共享给本项目；无归属的历史数据按全局兼容可见。"""
        if not project_id:
            return True
        scope = getattr(asset, "scope", None) or "project"
        if scope == "global":
            return True
        if asset.project_id == project_id:
            return True
        if include_shared:
            if not asset.project_id:
                return True  # 历史悬空数据（project 无归属）按全局兼容
            if project_id in (getattr(asset, "shared_to", None) or []):
                return True
        return False

    @staticmethod
    def writable_by(asset: Asset, actor_project_id: Optional[str]) -> bool:
        """写防护：无上下文（actor=None）兼容放行；有上下文则校验归属。
        共享给本项目的素材（shared_to）对接收方只读——想改请先复制到项目。"""
        if not actor_project_id:
            return True
        scope = getattr(asset, "scope", None) or "project"
        if scope == "global":
            origin = getattr(asset, "origin_project_id", None)
            return (not origin) or origin == actor_project_id
        if asset.project_id:
            return asset.project_id == actor_project_id
        return True

    def list_assets(self, category: Optional[str] = None, status: Optional[str] = None, tag: Optional[str] = None, q: Optional[str] = None, project_id: Optional[str] = None, page: int = 1, limit: int = 24, sort: str = "updated_at", scope: Optional[str] = None, include_shared: bool = True, group: Optional[str] = None) -> Dict[str, Any]:
        assets: List[Asset] = []
        if not os.path.exists(ASSETS_ROOT):
            return {"assets": [], "total": 0, "page": page, "limit": limit}
        if not AssetManager._missing_swept:
            AssetManager._missing_swept = True
            try:
                self.cleanup_missing()
            except Exception:
                pass
        project_id = _resolve_project_id(project_id)
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
            # 旧数据兼容：缺 scope 按有无归属推断；非法 scope 归一为 project
            _mutated = False
            if not getattr(asset, "scope", None):
                asset.scope = "global" if not asset.project_id else "project"
                _mutated = True
            elif asset.scope not in ("project", "global"):
                asset.scope = "project"
                _mutated = True
            if not getattr(asset, "shared_to", None):
                asset.shared_to = []
                # shared_to 缺失不算脏，不强行写盘以保持静默
            if _mutated:
                try:
                    _save_asset(asset)
                except Exception:
                    pass
            # 过滤
            if category and asset.category != category:
                continue
            if status and asset.status != status:
                continue
            # L2 分组过滤：__none__=未分组；其余按路径前缀（父分组含子级）
            if group:
                gp = (getattr(asset, "group_path", None) or "")
                if group == "__none__":
                    if gp:
                        continue
                elif not (gp == group or gp.startswith(group + "/")):
                    continue
            # scope 语义：all/None=不筛；project/global=按隔离域筛；shared=别人共享给我的
            if scope:
                if scope == "shared":
                    if not project_id or project_id not in (getattr(asset, "shared_to", None) or []):
                        continue
                elif scope in ("project", "global"):
                    if (getattr(asset, "scope", None) or "project") != scope:
                        continue
            if project_id:
                if include_shared:
                    if not self.visible_to(asset, project_id, include_shared=True):
                        continue
                else:
                    # 严格模式：仅归属该 project 的资产（不含全局、不含共享给我）
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

    def _is_file_missing(self, asset: Asset) -> bool:
        """本地 /storage 引用做存在性校验；http(s)/data: 外链不校验"""
        for u in (getattr(asset, "file_url", None), getattr(asset, "thumb_url", None)):
            if isinstance(u, str) and u.startswith("/storage/"):
                local = os.path.join(settings.STORAGE_DIR, u[len("/storage/"):])
                if not os.path.exists(local):
                    return True
        return False

    def cleanup_missing(self) -> Dict[str, Any]:
        """
        清理「文件已删、记录还在」的悬空素材（P3-2）。
        删除前把清单追加备份到 storage/assets/.missing_backup.jsonl，可人工找回。
        """
        removed: List[Dict[str, Any]] = []
        kept = 0
        if not os.path.exists(ASSETS_ROOT):
            return {"removed": removed, "count": 0, "kept": kept}
        for entry in os.listdir(ASSETS_ROOT):
            adir = os.path.join(ASSETS_ROOT, entry)
            if not os.path.isdir(adir):
                continue
            a = _load_asset(entry)
            if not a:
                continue
            if self._is_file_missing(a):
                removed.append({"id": a.id, "name": a.name, "file_url": a.file_url, "cleaned_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
                shutil.rmtree(adir, ignore_errors=True)
                # 清理结果也写墓碑：否则下次启动云同步会把 meta.json 拉回来，形成"清理→复活→再清理"循环
                _append_tombstone(a, reason="cleanup")
            else:
                kept += 1
        if removed:
            try:
                with open(MISSING_BACKUP, "a", encoding="utf-8") as f:
                    for r in removed:
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
            except Exception:
                pass
        return {"removed": removed, "count": len(removed), "kept": kept}

    def create_asset(self, data: Dict[str, Any], file_bytes: Optional[bytes] = None, filename: Optional[str] = None, content_type: Optional[str] = None) -> Asset:
        # 校验 category
        cat = data.get("category", "other")
        if cat not in ASSET_CATEGORIES:
            cat = "other"
        st = data.get("status", "approved")
        if st not in ASSET_STATUS:
            st = "approved"
        # P0: scope/shared_to（分级：owner 与可见性分离）
        scope_val = data.get("scope", "project")
        if scope_val not in ("project", "global"):
            scope_val = "project"
        shared = _resolve_shared_targets(data.get("shared_to", []) or [])
        requested_pid = _resolve_project_id(data.get("project_id"))
        # 不变式：project 必须有归属；无归属的"项目素材"确定性视为全局（不再留待读路径静默迁移）
        if scope_val == "project" and not requested_pid:
            scope_val = "global"
        proj_id_val = None if scope_val == "global" else requested_pid
        # 出生项目：项目素材=归属项目；由项目发布/创建为全局时记录来源
        origin_val = _resolve_project_id(data.get("origin_project_id"))
        if not origin_val:
            origin_val = requested_pid or None
        asset = Asset(
            id=f"ast_{uuid.uuid4().hex[:8]}",
            name=data.get("name", "未命名素材"),
            category=cat,
            subcategory=data.get("subcategory"),
            status=st,
            description=data.get("description", ""),
            tags=data.get("tags", []) or [],
            visual_prompt=data.get("visual_prompt", "") or "",
            content=data.get("content", "") or "",
            negative_prompt=data.get("negative_prompt"),
            style_preset=data.get("style_preset"),
            project_id=proj_id_val,
            scope=scope_val,
            shared_to=shared,
            origin_project_id=origin_val,
            group_path=(data.get("group_path") or None),
            published_at=data.get("published_at"),
            style_anchor_id=data.get("style_anchor_id"),
            lora_trigger=data.get("lora_trigger"),
            voice_id=data.get("voice_id"),
            voice_name=data.get("voice_name"),
            source=data.get("source", "upload"),
            extra=data.get("extra", {}) or {},
        )
        # 处理文件
        if file_bytes and filename:
            asset = self._attach_file(asset, file_bytes, filename, content_type)
        elif data.get("file_url"):
            # 直接引用已有URL（如 /storage/generated/xxx.png 或 http）
            asset.file_url = data["file_url"]
            asset.thumb_url = data["file_url"]
        _save_asset(asset)
        return asset

    def _attach_file(self, asset: Asset, file_bytes: bytes, filename: str, content_type: Optional[str] = None) -> Asset:
        d = _asset_dir(asset.id)
        os.makedirs(d, exist_ok=True)
        # REQ-toonflow-canvas 保留真实扩展名（文件名 → content-type → 文件头），不再把音视频存成 .png
        ext = resolve_asset_ext(filename, content_type, file_bytes[:64])
        out_name = f"original{ext}"
        out_path = os.path.join(d, out_name)
        with open(out_path, "wb") as f:
            f.write(file_bytes)
        # 生成 file_url（通过 /storage 挂载）
        rel = os.path.relpath(out_path, settings.STORAGE_DIR).replace("\\", "/")
        asset.file_url = f"/storage/{rel}"
        asset.thumb_url = asset.file_url
        asset.file_path = out_path
        # 排进云端同步队列：只是入队，不等它传完，素材立刻就能用
        try:
            from app.storage_sync.mirror import mirror
            mirror.enqueue(rel)
        except Exception:
            pass
        # 尝试获取宽高（图片）
        try:
            from PIL import Image
            from io import BytesIO
            im = Image.open(BytesIO(file_bytes))
            asset.width, asset.height = im.size
        except Exception:
            pass
        return asset

    def update_asset(self, asset_id: str, updates: Dict[str, Any], file_bytes: Optional[bytes] = None, filename: Optional[str] = None, content_type: Optional[str] = None) -> Optional[Asset]:
        asset = _load_asset(asset_id)
        if not asset:
            return None
        # 允许更新的字段
        for k in ["name","category","subcategory","description","tags","visual_prompt","content","negative_prompt","style_preset","status","style_anchor_id","lora_trigger","voice_id","voice_name","three_views","extra","project_id","scope","shared_to","group_path","origin_project_id"]:
            if k in updates and updates[k] is not None:
                if k == "category" and updates[k] not in ASSET_CATEGORIES:
                    continue
                if k == "status" and updates[k] not in ASSET_STATUS:
                    continue
                if k == "scope" and updates[k] not in ("project","global"):
                    continue
                if k == "project_id":
                    updates[k] = _resolve_project_id(updates[k])
                if k == "origin_project_id":
                    updates[k] = _resolve_project_id(updates[k])
                if k == "shared_to":
                    updates[k] = _resolve_shared_targets(updates[k])
                setattr(asset, k, updates[k])
        # 归属不变式：global 不带归属；project 必须有归属（归属被显式清空时确定性提升为全局）
        _explicit_clear_owner = ("project_id" in updates and updates.get("project_id") is None)
        if asset.scope == "global":
            asset.project_id = None
        elif not asset.project_id or _explicit_clear_owner:
            asset.scope = "global"
            asset.project_id = None
        # 项目素材的出生项目跟随归属（仅当尚未记录或归属变更时纠偏）
        if asset.scope == "project" and asset.project_id and not asset.origin_project_id:
            asset.origin_project_id = asset.project_id
        if "file_url" in updates and updates["file_url"]:
            asset.file_url = updates["file_url"]
            asset.thumb_url = updates["file_url"]
        if file_bytes and filename:
            asset = self._attach_file(asset, file_bytes, filename, content_type)
        _save_asset(asset)
        return asset

    def publish_asset(self, asset_id: str, actor_project_id: Optional[str] = None) -> Optional[Asset]:
        """发布共享：项目素材原地提升为全局（文件不动、URL 不变，已引用方零影响）。"""
        asset = _load_asset(asset_id)
        if not asset:
            return None
        if asset.scope == "global":
            return asset
        actor = _resolve_project_id(actor_project_id)
        if actor and asset.project_id and asset.project_id != actor:
            raise PermissionError("只能发布本项目的素材到全局")
        asset.origin_project_id = asset.project_id or asset.origin_project_id
        asset.scope = "global"
        asset.project_id = None
        asset.shared_to = []
        asset.published_at = _now()
        _save_asset(asset)
        return asset

    def unpublish_asset(self, asset_id: str, actor_project_id: Optional[str] = None) -> Optional[Asset]:
        """收回共享：全局素材退回出生项目（需出生项目有权，且无其他项目绑定引用）。"""
        asset = _load_asset(asset_id)
        if not asset:
            return None
        if asset.scope != "global":
            return asset
        actor = _resolve_project_id(actor_project_id)
        origin = asset.origin_project_id
        if not origin:
            raise PermissionError("该全局素材没有记录出生项目，无法收回共享")
        if actor and actor != origin:
            raise PermissionError("只有出生项目可以收回全局共享")
        asset.scope = "project"
        asset.project_id = origin
        asset.published_at = None
        _save_asset(asset)
        return asset

    def find_references(self, asset_id: str) -> List[Dict[str, Any]]:
        """扫描项目内容/画布，找出跨项目引用（删除与收回共享前的安全检查）。"""
        refs: List[Dict[str, Any]] = []
        try:
            from app.providers.project.manager import PROJECTS_ROOT
        except Exception:
            return refs
        if not os.path.isdir(PROJECTS_ROOT):
            return refs
        for entry in os.listdir(PROJECTS_ROOT):
            pdir = os.path.join(PROJECTS_ROOT, entry)
            if not os.path.isdir(pdir):
                continue
            for fname in ("content.json", "canvas.json"):
                fpath = os.path.join(pdir, fname)
                if not os.path.exists(fpath):
                    continue
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        text = f.read()
                except Exception:
                    continue
                if asset_id in text:
                    refs.append({"project_id": entry, "file": fname})
        return refs

    def delete_asset(self, asset_id: str) -> bool:
        d = _asset_dir(asset_id)
        if not os.path.exists(d):
            return False
        a = _load_asset(asset_id)
        if a:
            _append_tombstone(a, reason="delete")
        shutil.rmtree(d, ignore_errors=True)
        return True

    def duplicate_asset(self, asset_id: str) -> Optional[Asset]:
        src = _load_asset(asset_id)
        if not src:
            return None
        data = src.model_dump()
        data.pop("id", None)
        data["name"] = f"{src.name}_副本"
        # 副本不继承共享关系与发布状态，只记录派生来源
        data["shared_to"] = []
        data["published_at"] = None
        extra = dict(data.get("extra") or {})
        extra["derived_from"] = src.id
        data["extra"] = extra
        # 复制文件
        src_dir = _asset_dir(asset_id)
        new_asset = Asset.model_validate({**data, "id": f"ast_{uuid.uuid4().hex[:8]}"})
        # 复制原始文件（REQ-toonflow-canvas 换过不同扩展名的文件后目录里可能有多个 original.*，优先复制当前 file_url 指向的那个）
        current = os.path.basename(src.file_url or "") if (src.file_url or "").startswith("/storage/") else ""
        names = sorted(os.listdir(src_dir), key=lambda n: n != current)
        for fname in names:
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

    def get_stats(self, project_id: Optional[str] = None) -> Dict[str, Any]:
        counts: Dict[str, int] = {c: 0 for c in ASSET_CATEGORIES}
        status_counts: Dict[str, int] = {s: 0 for s in ASSET_STATUS}
        scope_counts: Dict[str, int] = {"project": 0, "global": 0}
        total = 0
        owned = 0
        shared_to_me = 0
        tags: Dict[str, int] = {}
        project_id = _resolve_project_id(project_id)
        if os.path.exists(ASSETS_ROOT):
            for entry in os.listdir(ASSETS_ROOT):
                adir = os.path.join(ASSETS_ROOT, entry)
                if not os.path.isdir(adir):
                    continue
                a = _load_asset(entry)
                if not a:
                    continue
                if project_id and not self.visible_to(a, project_id, include_shared=True):
                    continue
                total += 1
                counts[a.category] = counts.get(a.category, 0) + 1
                status_counts[a.status] = status_counts.get(a.status, 0) + 1
                scope_counts[getattr(a, "scope", "project")] = scope_counts.get(getattr(a, "scope", "project"), 0) + 1
                if project_id:
                    if a.project_id == project_id:
                        owned += 1
                    if project_id in (getattr(a, "shared_to", None) or []):
                        shared_to_me += 1
                for t in (a.tags or []):
                    tags[t] = tags.get(t, 0) + 1
        return {"total": total, "by_category": counts, "by_status": status_counts, "by_scope": scope_counts, "tags": tags, "owned": owned, "shared_to_me": shared_to_me}

    def search_tags(self, q: Optional[str] = None, project_id: Optional[str] = None) -> List[str]:
        stats = self.get_stats(project_id=project_id)
        all_tags = list(stats["tags"].keys())
        if q:
            ql = q.lower()
            all_tags = [t for t in all_tags if ql in t.lower()]
        return sorted(all_tags)

asset_manager = AssetManager()
