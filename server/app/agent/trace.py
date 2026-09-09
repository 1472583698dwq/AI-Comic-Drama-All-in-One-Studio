# -*- coding: utf-8 -*-
"""Agent trace落盘 — JSONL per run，可回放、可审计。路径: storage/agent_traces/{run_id}.jsonl"""
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

def _trace_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_traces"
    except Exception:
        base = Path("storage") / "agent_traces"
    base.mkdir(parents=True, exist_ok=True)
    return base


def log_event(run_id: str, event: str, data: Dict[str, Any] | None = None) -> None:
    try:
        p = _trace_dir() / f"{run_id}.jsonl"
        rec = {"ts": time.time(), "run_id": run_id, "event": event, "data": data or {}}
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


def get_trace(run_id: str, limit: int = 500) -> List[Dict[str, Any]]:
    p = _trace_dir() / f"{run_id}.jsonl"
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
