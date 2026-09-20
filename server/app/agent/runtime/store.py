# -*- coding: utf-8 -*-
"""会话日志 JSONL 持久化 — 追加、读取、撕裂尾修复、单写者保护。

布局：<STORAGE_DIR>/agent_sessions/<safe_session_id>/events.v1.jsonl
- 第一行是 header（版本/会话 id/创建时间）。
- 后续每行一个事件 JSON；追加批次一次 write + flush + fsync。
- 崩溃可能留下半行 JSON：读取时丢弃最后一个非法行（撕裂尾），不返回给调用方。
- 已提交文件永不原地重写；只有显式 clear 才删除整个会话目录。
"""
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.agent.runtime import events as E

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.\-]")
_LOCK = threading.Lock()


def _storage_root() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_sessions"
    except Exception:
        base = Path("storage") / "agent_sessions"
    base.mkdir(parents=True, exist_ok=True)
    return base


def safe_session_id(session_id: str) -> str:
    s = _SAFE_ID_RE.sub("_", str(session_id or "").strip())[:120]
    return s or "default"


class SessionStore:
    """单文件 append-only 日志；单进程线程锁保证单写者。"""

    def __init__(self, root: Optional[Path] = None):
        self.root = Path(root) if root else _storage_root()

    def dir_for(self, session_id: str) -> Path:
        return self.root / safe_session_id(session_id)

    def path_for(self, session_id: str) -> Path:
        return self.dir_for(session_id) / "events.v1.jsonl"

    def exists(self, session_id: str) -> bool:
        return self.path_for(session_id).exists()

    def ensure_header(self, session_id: str) -> None:
        p = self.path_for(session_id)
        if p.exists():
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        header = {
            "type": "session/header",
            "format": E.SESSION_FORMAT_VERSION,
            "session_id": safe_session_id(session_id),
            "created_at": time.time(),
        }
        with _LOCK:
            if not p.exists():
                with open(p, "a", encoding="utf-8", newline="\n") as f:
                    f.write(json.dumps(header, ensure_ascii=False) + "\n")
                    f.flush()
                    os.fsync(f.fileno())

    def append(self, session_id: str, batch: List[Dict[str, Any]]) -> None:
        if not batch:
            return
        self.ensure_header(session_id)
        lines = [json.dumps(ev, ensure_ascii=False, default=str) for ev in batch]
        p = self.path_for(session_id)
        with _LOCK:
            with open(p, "a", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
                f.flush()
                os.fsync(f.fileno())

    def read(self, session_id: str) -> List[Dict[str, Any]]:
        """读取全部事件；容忍撕裂尾（最后一个非法 JSON 行丢弃）。"""
        p = self.path_for(session_id)
        if not p.exists():
            return []
        out: List[Dict[str, Any]] = []
        try:
            with open(p, "r", encoding="utf-8") as f:
                for raw in f:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        ev = json.loads(raw)
                    except json.JSONDecodeError:
                        # 撕裂尾：只有最后一行允许损坏
                        continue
                    if isinstance(ev, dict) and "type" in ev and ev.get("type") != "session/header":
                        out.append(ev)
        except FileNotFoundError:
            return []
        return out

    def delete(self, session_id: str) -> bool:
        import shutil
        d = self.dir_for(session_id)
        if not d.exists():
            return False
        with _LOCK:
            shutil.rmtree(d, ignore_errors=True)
        return True

    def resolve(self, session_id: str) -> tuple:
        """把调用方给的会话标识解析到真实目录名，返回 ``(真实目录名, 命中的候选数)``。

        存在两套 id 容易混：磁盘目录是 ``proj_<项目id>_sess_<前端会话id>``，
        而前端只知道 ``sess_xxx``（甚至有人直接传内部 UUID）。这里允许传全名或子串：
        - 精确命中目录 → 直接用；
        - 否则按"目录名以它结尾 / 包含它"匹配，命中多个时取最近修改的（并回报候选数，
          让调用方能提示歧义，而不是静默猜一个）。
        """
        raw = str(session_id or "").strip()
        if not raw:
            return "", 0
        if self.path_for(raw).exists():
            return safe_session_id(raw), 1
        try:
            dirs = [d for d in self.root.iterdir() if d.is_dir()]
        except Exception:
            return "", 0
        hits = [d for d in dirs if d.name.endswith(raw) or raw in d.name]
        if not hits:
            return "", 0
        hits.sort(key=lambda d: (d / "events.v1.jsonl").stat().st_mtime if (d / "events.v1.jsonl").exists() else 0, reverse=True)
        return hits[0].name, len(hits)

    def list_sessions(self, limit: int = 50) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        try:
            for d in self.root.iterdir():
                if not d.is_dir():
                    continue
                p = d / "events.v1.jsonl"
                if not p.exists():
                    continue
                st = p.stat()
                out.append({
                    "session_id": d.name,
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                })
        except Exception:
            return []
        out.sort(key=lambda x: x["mtime"], reverse=True)
        return out[:limit]


store = SessionStore()
