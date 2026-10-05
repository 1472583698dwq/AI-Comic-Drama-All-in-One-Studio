# -*- coding: utf-8 -*-
"""日志接口（调试用）：尾读 / 文件清单 / 下载 / 前端错误上报 / 运行期级别切换。

- GET  /system/logs/tail?lines=400&level=INFO&q=xx   尾部日志（最低级别过滤 + 关键词）
- GET  /system/logs/files                            日志文件清单（含滚动备份）
- GET  /system/logs/download                         下载主日志文件
- POST /system/logs/frontend                         前端错误上报（入同一日志，标 [frontend]）
- POST /system/logs/level                            运行期切换 DEBUG/INFO/WARNING（持久化）
"""
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse

from app.core.logging_config import (
    get_logger,
    log_files,
    main_log_path,
    resolve_level,
    set_level,
)

router = APIRouter()
_frontend_logger = get_logger("frontend")

_LEVEL_MIN = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}


def _letter_to_level(letter: str) -> int:
    return {"D": 10, "I": 20, "W": 30, "E": 40, "C": 50}.get((letter or "").upper(), 0)


def read_tail(lines: int = 400, level: str = "", q: str = "") -> List[str]:
    """读主日志尾部 N 行（先粗读后按过滤收缩；文件 <10MB 直接全量读，简单可靠）。"""
    path = main_log_path()
    if not path or not os.path.exists(path):
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > 10 * 1024 * 1024:
                f.seek(size - 10 * 1024 * 1024)
            raw = f.read()
        text = raw.decode("utf-8", errors="replace")
        if size > 10 * 1024 * 1024:
            text = text.split("\n", 1)[-1]
        all_lines = text.splitlines()
    except Exception:
        return []

    min_lvl = _LEVEL_MIN.get((level or "").strip().upper(), 0)
    needle = (q or "").strip().lower()
    out: List[str] = []
    for ln in all_lines:
        # 格式：2026-09-29 12:00:00 [I] module: msg
        if min_lvl:
            try:
                bracket = ln.split("[", 1)[1][:1] if "[" in ln else ""
                if _letter_to_level(bracket) < min_lvl:
                    continue
            except Exception:
                pass
        if needle and needle not in ln.lower():
            continue
        out.append(ln)
    return out[-max(1, min(lines, 5000)):]


@router.get("/system/logs/tail")
async def get_logs_tail(
    lines: int = Query(400, ge=1, le=5000),
    level: str = Query("", description="最低级别 DEBUG/INFO/WARNING/ERROR，空=全部"),
    q: str = Query("", description="关键词（不区分大小写）"),
):
    lines_out = read_tail(lines=lines, level=level, q=q)
    return {
        "lines": lines_out,
        "count": len(lines_out),
        "path": main_log_path(),
        "level": resolve_level(),
    }


@router.get("/system/logs/files")
async def get_logs_files():
    files = log_files()
    return {
        "files": files,
        "total": len(files),
        "main": main_log_path(),
        "level": resolve_level(),
    }


@router.get("/system/logs/download")
async def download_logs():
    path = main_log_path()
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="日志文件不存在")
    return FileResponse(path, filename=os.path.basename(path), media_type="text/plain; charset=utf-8")


@router.post("/system/logs/frontend")
async def report_frontend_logs(payload: Optional[Dict[str, Any]] = Body(None)):
    """前端错误上报：入同一日志文件（logger=frontend），与后端对同一时间线。"""
    entries = (payload or {}).get("entries") or []
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="entries 必须是数组")
    written = 0
    for e in entries[:50]:
        if not isinstance(e, dict):
            continue
        level = str(e.get("level") or "error").lower()
        msg = str(e.get("message") or "")[:2000]
        stack = str(e.get("stack") or "")[:4000]
        src = str(e.get("source") or "")[:80]
        if not msg and not stack:
            continue
        line = f"[frontend][{src}] {msg}"
        if stack:
            line += f"\n{stack}"
        log_fn = _frontend_logger.warning if level in ("warn", "warning") else _frontend_logger.error
        log_fn("%s", line)
        written += 1
    return {"status": "ok", "written": written}


@router.post("/system/logs/level")
async def change_log_level(payload: Optional[Dict[str, Any]] = Body(None)):
    name = str((payload or {}).get("level") or "").strip().upper()
    try:
        applied = set_level(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "level": applied}
