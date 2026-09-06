# -*- coding: utf-8 -*-
"""
媒体引用解析 — 本地 /storage 引用转为云端可发送格式。

背景：节点上传/资产库/画布产出的图片音频以 `/storage/...` 本地 URL 存在，
云端 API（如 AutoDL H3）无法回拉本机地址，旧代码静默丢弃导致“参考无法使用”。
本模块把本地引用内联为 `data:` URI（AutoDL 官方支持 HTTP(S)/data URI/本地路径，
内联上限 50MB），超限或缺失时给出明确 reason，不再静默丢弃。
"""

import base64
import mimetypes
import os
from typing import Dict, List, Optional, Tuple

# 单文件内联上限（AutoDL 内联媒体上限 50MB，此处留余量）
MAX_INLINE_BYTES = 20 * 1024 * 1024


def local_path_for_ref(ref: str) -> Optional[str]:
    """把引用字符串映射为本机文件路径；非本地引用返回 None。"""
    if not isinstance(ref, str) or not ref.strip():
        return None
    s = ref.strip()
    if s.startswith(("http://", "https://", "data:")):
        return None
    # file:// 前缀
    if s.startswith("file://"):
        s = s[len("file://"):]
    try:
        from app.core.config import settings
        storage_dir = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        storage_dir = None
    # /storage/... 或 storage/... → STORAGE_DIR 下
    if s.startswith("/storage/"):
        rel = s[len("/storage/"):]
        base = storage_dir or os.path.abspath("storage")
        return os.path.abspath(os.path.join(base, rel))
    if s.startswith("storage/"):
        base = storage_dir or os.path.abspath("storage")
        return os.path.abspath(os.path.join(base, s[len("storage/"):]))
    # 绝对路径 / 相对路径：存在即视为本地文件
    if os.path.isabs(s) and os.path.exists(s):
        return s
    if os.path.exists(s):
        return os.path.abspath(s)
    return None


def ref_to_sendable(ref: str, kind: str = "image") -> Tuple[Optional[str], Optional[str]]:
    """
    单条引用 → (可发送值, 丢弃原因)。
    http(s)/data 原样透传；本地文件转 data URI；缺失/超限返回 (None, reason)。
    """
    if not isinstance(ref, str) or not ref.strip():
        return None, "空引用"
    s = ref.strip()
    if s.startswith(("http://", "https://", "data:")):
        return s, None
    local = local_path_for_ref(s)
    if not local or not os.path.isfile(local):
        return None, f"本地文件不存在: {s[:80]}"
    try:
        size = os.path.getsize(local)
    except Exception as e:
        return None, f"读取失败: {e}"
    if size <= 0:
        return None, "文件为空"
    if size > MAX_INLINE_BYTES:
        return None, f"文件 {size // 1024 // 1024}MB 超过内联上限 20MB，请改用公网 http(s) 链接"
    mime, _ = mimetypes.guess_type(local)
    if not mime:
        mime = "audio/mpeg" if kind == "audio" else "image/png"
    try:
        with open(local, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return f"data:{mime};base64,{b64}", None
    except Exception as e:
        return None, f"内联编码失败: {e}"


def resolve_media_refs(
    refs: Optional[List[str]], kind: str = "image"
) -> Tuple[List[str], List[Dict[str, str]]]:
    """
    批量解析引用列表 → (kept, dropped)。
    kept 保序去重；dropped 每项 {ref, reason} 供调用方回显（不再静默丢弃）。
    """
    kept: List[str] = []
    dropped: List[Dict[str, str]] = []
    seen = set()
    for r in refs or []:
        if not isinstance(r, str) or not r.strip():
            continue
        sendable, reason = ref_to_sendable(r, kind=kind)
        if sendable and sendable not in seen:
            seen.add(sendable)
            kept.append(sendable)
        elif not sendable:
            label = r if len(r) < 120 else r[:120] + "…(data内联已省略)"
            dropped.append({"ref": label, "reason": reason or "未知原因"})
    return kept, dropped


def resolve_single_ref(ref: Optional[str], kind: str = "image") -> Tuple[Optional[str], Optional[Dict[str, str]]]:
    """单引用解析 → (sendable_or_None, dropped_or_None)。"""
    if not isinstance(ref, str) or not ref.strip():
        return None, None
    sendable, reason = ref_to_sendable(ref, kind=kind)
    if sendable:
        return sendable, None
    label = ref if len(ref) < 120 else ref[:120] + "…"
    return None, {"ref": label, "reason": reason or "未知原因"}
