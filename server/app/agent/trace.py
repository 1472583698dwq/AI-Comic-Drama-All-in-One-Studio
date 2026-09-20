# -*- coding: utf-8 -*-
"""Agent trace落盘 — JSONL per run，可回放、可审计。路径: storage/agent_traces/{run_id}.jsonl"""
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List

# run_id 会被拼进文件名：必须过一遍围栏，否则带路径分隔符/上跳的 id 能越出 trace 目录
_SAFE_RUN_ID_RE = re.compile(r"[^A-Za-z0-9_.\-]")


def safe_run_id(run_id: str) -> str:
    s = _SAFE_RUN_ID_RE.sub("_", str(run_id or "").strip())[:160]
    return s or "run"


def _trace_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_traces"
    except Exception:
        base = Path("storage") / "agent_traces"
    base.mkdir(parents=True, exist_ok=True)
    return base


def log_event(run_id: str, event: str, data: Dict[str, Any] | None = None) -> None:
    rid = safe_run_id(run_id)
    try:
        p = _trace_dir() / f"{rid}.jsonl"
        rec = {"ts": time.time(), "run_id": rid, "event": event, "data": data or {}}
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


def get_trace(run_id: str, limit: int = 500) -> List[Dict[str, Any]]:
    p = _trace_dir() / f"{safe_run_id(run_id)}.jsonl"
    if not p.exists():
        return []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()[-limit:]
        return [json.loads(l) for l in lines if l.strip()]
    except Exception:
        return []


def list_runs(limit: int = 30) -> List[Dict[str, Any]]:
    d = _trace_dir()
    try:
        files = sorted(d.glob("*.jsonl"), key=lambda x: x.stat().st_mtime, reverse=True)[:limit]
        out = []
        for f in files:
            try:
                st = f.stat()
                # 首行取意图
                first = ""
                try:
                    first = f.read_text(encoding="utf-8").splitlines()[0][:300]
                except Exception:
                    pass
                out.append({"run_id": f.stem, "mtime": st.st_mtime, "size": st.st_size, "preview": first})
            except Exception:
                continue
        return out
    except Exception:
        return []
