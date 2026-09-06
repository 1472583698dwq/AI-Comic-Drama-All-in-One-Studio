# -*- coding: utf-8 -*-
"""
一键成片 Agent 任务 API（异步 + 轮询）
POST /api/v1/onekey/run   提交长文本 → 后台跑 6 阶段编排（拆解/角色/生图/视频/配音/导出）
GET  /api/v1/onekey/tasks/{task_id}  轮询进度与结果
长任务不阻塞 HTTP，前端 3s 轮询一次即可。
"""
import asyncio
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from app.models.schemas import PipelineRunRequest
from app.pipelines.unified_orchestrator import unified_orchestrator

router = APIRouter()

TASKS: Dict[str, Dict[str, Any]] = {}
MAX_LOGS = 200
HARD_CAP_SHOTS = 30


class OneKeyRunRequest(PipelineRunRequest):
    title: str = "一键成片"


def _progress_of(stage: str) -> int:
    if "Stage 1" in stage:
        return 10
    if "Stage 2" in stage:
        return 25
    if "Stage 3" in stage:
        return 50
    if "Stage 4" in stage:
        return 70
    if "Stage 5" in stage:
        return 85
    if "Stage 6" in stage:
        return 95
    return 5


async def _run_task(task_id: str, req: OneKeyRunRequest) -> None:
    task = TASKS.get(task_id)
    if not task:
        return
    task["status"] = "running"

    async def cb(entry: Dict[str, Any]) -> None:
        try:
            task["logs"].append(entry)
            if len(task["logs"]) > MAX_LOGS:
                task["logs"] = task["logs"][-MAX_LOGS:]
            task["progress"] = max(task.get("progress", 0), _progress_of(str(entry.get("stage", ""))))
            task["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    try:
        res = await unified_orchestrator.execute_full_pipeline(
            novel_text=req.text,
            style_preset=req.style_preset,
            aspect_ratio=req.aspect_ratio,
            custom_instructions=req.custom_instructions or "",
            max_images=max(1, min(req.max_images, HARD_CAP_SHOTS)),
            image_provider=req.image_provider,
            image_workflow_id=req.image_workflow_id,
            audio_provider=req.audio_provider,
            video_provider=req.video_provider,
            video_workflow_id=req.video_workflow_id,
            enable_video=req.enable_video,
            max_videos=max(0, min(req.max_videos, HARD_CAP_SHOTS)),
            gen_roles=req.gen_roles,
            max_roles=max(1, min(req.max_roles, 8)),
            progress_cb=cb,
        )
        task["status"] = "success" if res.get("status") == "success" else "partial"
        task["progress"] = 100
        task["result"] = {
            "summary": res.get("summary", {}),
            "project": res.get("project"),
            "jianyin_draft": res.get("jianyin_draft"),
            "image_errors": res.get("image_errors", []),
            "video_errors": res.get("video_errors", []),
            "videos_pending": res.get("videos_pending", []),
        }
    except Exception as e:
        task["status"] = "failed"
        task["error"] = str(e)[:500]
    task["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")


@router.post("/onekey/run")
async def onekey_run(req: OneKeyRunRequest):
    text = (req.text or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="文本太短（至少20字），请粘贴小说章节或故事梗概")
    task_id = f"onekey_{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    TASKS[task_id] = {
        "task_id": task_id,
        "title": req.title or "一键成片",
        "status": "queued",
        "progress": 0,
        "logs": [],
        "result": None,
        "error": None,
        "created_at": now,
        "updated_at": now,
    }
    asyncio.create_task(_run_task(task_id, req))
    return {"task_id": task_id, "status": "queued"}


@router.get("/onekey/tasks/{task_id}")
async def onekey_status(task_id: str, include_project: bool = True):
    task = TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")
    if not include_project and task.get("result"):
        shallow = {k: v for k, v in task.items() if k != "result"}
        shallow["result"] = {k: v for k, v in (task["result"] or {}).items() if k != "project"}
        return shallow
    return task


@router.get("/onekey/tasks")
async def onekey_list(limit: int = 20):
    items = sorted(TASKS.values(), key=lambda t: t.get("created_at", ""), reverse=True)[: max(1, min(limit, 50))]
    return {"tasks": [{k: v for k, v in t.items() if k not in ("result",)} for t in items]}
