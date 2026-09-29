# -*- coding: utf-8 -*-
"""用户消息多模态附件 — 校验、落盘与模型 content parts 组装。

设计约束：
- 会话日志只存 **引用**（ref/name/kind/size），不存 base64 —— 日志保真但轻量，
  云同步与回放都不会被大图拖垮；到模型请求时才按需转 sendable（data URI / 公网 URL）。
- 视觉能力是**模型属性**：AGENT_MM_IMAGE=auto 时按模型名试探，不支持的模型自动
  退化为「文本 + URL」描述，不报错、不中断。
- 超限/缺失的引用显式降级为文本说明（模型知道"这里有东西但没给到"），
  绝不静默丢弃。
"""
from __future__ import annotations

import base64
import mimetypes
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

ALLOWED_KINDS = ("image", "video", "audio")
MAX_ATTACHMENTS = 8
MAX_LOCAL_BYTES = int(os.environ.get("AGENT_MM_MAX_BYTES") or 8 * 1024 * 1024)
UPLOAD_ROOT = "agent_uploads"

# ── 视觉能力判定 ────────────────────────────────────────────
_VISION_HINTS = (
    "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5", "o1", "o3", "o4",
    "gemini", "claude", "vl", "vision", "omni", "glm-4v", "qvq",
    "internvl", "minicpm-v", "step-1v", "yi-vision", "qwen-vl", "qwen2.5-vl",
    "qwen3-vl", "minimax-vl", "abab-vl",
)


def _flag(name: str, default: str = "auto") -> str:
    v = (os.environ.get(name) or default).strip().lower()
    return v or default


def _truthy_flag(v: str) -> Optional[bool]:
    if v in ("1", "on", "true", "yes", "y"):
        return True
    if v in ("0", "off", "false", "no", "n"):
        return False
    return None


def _current_model() -> str:
    try:
        from app.agent.llm.adapter import adapter
        return str((adapter.resolve() or {}).get("model") or "")
    except Exception:
        return ""


def vision_enabled(model: Optional[str] = None) -> bool:
    """图片是否可作为 image_url content part 发给主模型。

    AGENT_MM_IMAGE=1 强制开 / 0 强制关 / auto（默认）按模型名试探。
    """
    forced = _truthy_flag(_flag("AGENT_MM_IMAGE"))
    if forced is not None:
        return forced
    m = (model if model is not None else _current_model()).lower()
    if not m:
        return False
    return any(h in m for h in _VISION_HINTS)


def kind_enabled(kind: str) -> bool:
    """按 kind 判断是否允许作为 content part（默认仅图片；视频/音频走文本描述）。"""
    if kind == "image":
        return vision_enabled()
    if kind == "video":
        return bool(_truthy_flag(_flag("AGENT_MM_VIDEO", "0")))
    if kind == "audio":
        return bool(_truthy_flag(_flag("AGENT_MM_AUDIO", "0")))
    return False


# ── 引用校验 ────────────────────────────────────────────────
def _ext_of(ref: str) -> str:
    try:
        base = ref.split("?")[0].split("#")[0]
        return os.path.splitext(base)[1].lower().lstrip(".")
    except Exception:
        return ""


def _guess_kind(ref: str, kind: str) -> str:
    if kind in ALLOWED_KINDS:
        return kind
    ext = _ext_of(ref)
    if ext in ("png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"):
        return "image"
    if ext in ("mp4", "mov", "webm", "mkv", "avi", "m4v"):
        return "video"
    if ext in ("mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"):
        return "audio"
    return "image"


def _ref_scheme_ok(ref: str) -> bool:
    return ref.startswith((
        "/storage/", "storage/", "http://", "https://", "data:", "file://",
    )) or os.path.isabs(ref)


def sanitize_attachments(raw: Any) -> List[Dict[str, Any]]:
    """把前端传来的附件列表归一化；非法项直接丢弃（调用方可另做提示）。"""
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        ref = str(item.get("ref") or item.get("url") or "").strip()
        if not ref or ref in seen or not _ref_scheme_ok(ref):
            continue
        kind = _guess_kind(ref, str(item.get("kind") or "").strip().lower())
        if kind not in ALLOWED_KINDS:
            continue
        name = str(item.get("name") or os.path.basename(ref.split("?")[0]) or kind)[:200]
        try:
            size = int(item.get("size") or 0)
        except Exception:
            size = 0
        entry: Dict[str, Any] = {
            "id": str(item.get("id") or f"att_{uuid.uuid4().hex[:8]}")[:64],
            "kind": kind,
            "name": name,
            "ref": ref[:2000],
            "source": str(item.get("source") or "user")[:20],
        }
        if size > 0:
            entry["size"] = size
        mime = str(item.get("mime") or "").strip()
        if mime:
            entry["mime"] = mime[:120]
        meta = item.get("meta")
        if isinstance(meta, dict) and meta:
            entry["meta"] = {str(k)[:40]: str(v)[:200] for k, v in list(meta.items())[:8]}
        seen.add(ref)
        out.append(entry)
        if len(out) >= MAX_ATTACHMENTS:
            break
    return out


# ── sendable 转换（带小缓存：同一 ref 跨请求不重复读盘/编码）──
_SENDABLE_CACHE: Dict[Tuple[str, str], Tuple[Optional[str], Optional[str], float]] = {}


def _to_sendable(ref: str, kind: str) -> Tuple[Optional[str], Optional[str]]:
    key = (ref, kind)
    hit = _SENDABLE_CACHE.get(key)
    if hit is not None:
        return hit[0], hit[1]
    try:
        from app.providers.media_refs import ref_to_sendable
        sendable, reason = ref_to_sendable(ref, kind=kind)
    except Exception as e:
        sendable, reason = None, f"解析失败: {e}"
    if len(_SENDABLE_CACHE) > 256:
        _SENDABLE_CACHE.clear()
    _SENDABLE_CACHE[key] = (sendable, reason, time.time())
    return sendable, reason


def attachment_brief(a: Dict[str, Any]) -> str:
    """无视觉/非图片类附件给模型的文本行（保留 URL，模型可交给生成链复用）。"""
    kind_label = {"image": "图片", "video": "视频", "audio": "音频"}.get(a.get("kind"), "附件")
    return f"[{kind_label}附件] {a.get('name') or ''} → {a.get('ref') or ''}".strip()


def build_user_content(text: str, attachments: Optional[List[Dict[str, Any]]]) -> Any:
    """USER_MESSAGE → OpenAI content（str 或 parts 数组）。

    - 图片且视觉可用：image_url part（本地引用转 data URI，超限则降级文本）
    - 视频/音频/视觉不可用：文本行（带 URL）
    - 若最终没有任何 media part，返回单条字符串（保持旧历史格式，压缩/缓存更友好）
    """
    if not attachments:
        return text
    parts: List[Dict[str, Any]] = []
    extras: List[str] = []
    if (text or "").strip():
        parts.append({"type": "text", "text": text})
    media_used = False
    for a in attachments:
        if not isinstance(a, dict):
            continue
        kind = str(a.get("kind") or "image")
        ref = str(a.get("ref") or "")
        if not ref:
            continue
        if kind == "image" and vision_enabled():
            sendable, reason = _to_sendable(ref, kind="image")
            if sendable:
                parts.append({"type": "image_url", "image_url": {"url": sendable}})
                media_used = True
                continue
            extras.append(f"{attachment_brief(a)}（未能内联：{reason or '未知原因'}）")
            continue
        if kind in ("video", "audio") and kind_enabled(kind):
            sendable, reason = _to_sendable(ref, kind=kind)
            if sendable:
                parts.append({"type": f"{kind}_url", f"{kind}_url": {"url": sendable}})
                media_used = True
                continue
            extras.append(f"{attachment_brief(a)}（未能内联：{reason or '未知原因'}）")
            continue
        extras.append(attachment_brief(a))
    if not media_used:
        # 无任何可内联媒体 → 退回纯文本（正文 + 附件说明行），历史格式保持简单
        return "\n".join([t for t in [text, *extras] if t])
    if extras:
        parts.append({"type": "text", "text": "\n".join(extras)})
    return parts


# ── 从画布焦点节点 / 工具结果自动收集媒体引用 ───────────────
def _entry(ref: str, kind: str, name: str, source: str, meta: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return {
        "id": f"att_{uuid.uuid4().hex[:8]}",
        "kind": kind, "name": name, "ref": ref, "source": source,
        **({"meta": meta} if meta else {}),
    }


def attachments_from_focus_nodes(context: Optional[Dict[str, Any]], limit: int = 4) -> List[Dict[str, Any]]:
    """画布「加入会话」节点已有产出 → 自动附件（让模型直接看到画面）。

    图片始终收集（无视觉时 build_user_content 会降级为文本说明）；
    视频/音频仅在对应 AGENT_MM_* 开关打开时收集，避免每轮噪音。
    """
    try:
        if (os.environ.get("AGENT_FOCUS_MEDIA") or "1").strip().lower() in ("0", "off", "false"):
            return []
    except Exception:
        pass
    nodes = (context or {}).get("agent_focus_nodes")
    if not isinstance(nodes, list):
        return []
    out: List[Dict[str, Any]] = []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        label = str(n.get("label") or n.get("type") or "节点")
        nid = str(n.get("id") or "")
        meta = {"node_id": nid} if nid else None
        img = str(n.get("image_url") or "").strip()
        if img:
            out.append(_entry(img, "image", f"{label} · 画面", "canvas", meta))
        if kind_enabled("video"):
            vid = str(n.get("video_url") or "").strip()
            if vid:
                out.append(_entry(vid, "video", f"{label} · 视频", "canvas", meta))
        if kind_enabled("audio"):
            aud = str(n.get("audio_url") or "").strip()
            if aud:
                out.append(_entry(aud, "audio", f"{label} · 音频", "canvas", meta))
        if len(out) >= max(1, int(limit)):
            return out[: max(1, int(limit))]
    return out


# 会产生媒体产物的工具（前缀 + 显式名单）；只有这些工具的结果值得回投给模型"看"
MEDIA_TOOL_PREFIXES = ("generate_", "comfyui_", "customnode_", "provider_", "onekey_shot_", "onekey_role_")
MEDIA_TOOL_NAMES = {"canvas_execute", "canvas_dispatch_skill", "task_wait", "view_media"}


def attachments_from_tool_result(name: str, result: Any, limit: int = 2) -> List[Dict[str, Any]]:
    """工具成功结果里的媒体产物 → 自动附件（改图后让模型看一眼再决定下一步）。"""
    try:
        if (os.environ.get("AGENT_TOOL_MEDIA") or "1").strip().lower() in ("0", "off", "false"):
            return []
    except Exception:
        pass
    if not name or not (name.startswith(MEDIA_TOOL_PREFIXES) or name in MEDIA_TOOL_NAMES):
        return []
    if not isinstance(result, dict):
        return []
    out: List[Dict[str, Any]] = []
    img = result.get("image_url") or result.get("result_url")
    if isinstance(img, str) and img.strip():
        out.append(_entry(img.strip(), "image", f"{name} · 画面", "tool"))
    if kind_enabled("video"):
        vid = result.get("video_url")
        if isinstance(vid, str) and vid.strip():
            out.append(_entry(vid.strip(), "video", f"{name} · 视频", "tool"))
    if kind_enabled("audio"):
        aud = result.get("audio_url")
        if isinstance(aud, str) and aud.strip():
            out.append(_entry(aud.strip(), "audio", f"{name} · 音频", "tool"))
    return out[: max(1, int(limit))]


# ── 上传落盘（附件专用目录，不进入素材库）────────────────────
_MIME_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
    "audio/aac": "aac", "audio/flac": "flac", "audio/ogg": "ogg",
}


def _storage_root() -> str:
    try:
        from app.core.config import settings
        return os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        return os.path.abspath("storage")


def save_upload(filename: str, mime: str, data: bytes) -> Dict[str, Any]:
    """保存附件字节到 storage/agent_uploads/<yyyymm>/，返回可引用的 /storage URL。"""
    if not data:
        raise ValueError("文件为空")
    if len(data) > MAX_LOCAL_BYTES:
        raise ValueError(f"文件 {len(data) // 1024 // 1024}MB 超过附件上限 {MAX_LOCAL_BYTES // 1024 // 1024}MB")
    name = str(filename or "attachment")
    ext = os.path.splitext(name)[1].lower().lstrip(".")
    if not ext:
        ext = _MIME_EXT.get(str(mime or "").lower()) or (mimetypes.guess_extension(mime or "") or ".bin").lstrip(".").lower()
    if not ext or len(ext) > 8:
        ext = "bin"
    kind = "image"
    m = str(mime or "").lower()
    if m.startswith("video/"):
        kind = "video"
    elif m.startswith("audio/"):
        kind = "audio"
    elif m.startswith("image/"):
        kind = "image"
    else:
        kind = _guess_kind(name, "")
    sub = time.strftime("%Y%m")
    root = os.path.join(_storage_root(), UPLOAD_ROOT, sub)
    os.makedirs(root, exist_ok=True)
    fn = f"{uuid.uuid4().hex[:16]}.{ext}"
    path = os.path.join(root, fn)
    with open(path, "wb") as f:
        f.write(data)
    ref = f"/storage/{UPLOAD_ROOT}/{sub}/{fn}"
    return {"kind": kind, "name": name[:200], "ref": ref, "size": len(data), "mime": mime or ""}


def load_data_uri(ref: str, kind: str = "image") -> Tuple[Optional[str], Optional[str]]:
    """把任意引用转 data URI（供工具/后端内部使用）。"""
    return _to_sendable(ref, kind=kind)
