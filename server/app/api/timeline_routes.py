# -*- coding: utf-8 -*-
"""画布时间线节点 API：引擎自检 / 合片 MP4（长任务）/ 降级剪映草稿。

契约要点：
- 提交口**先校验后排队**：片段非法当场 400（含可读原因），不把校验错误塞进异步任务；
- ffmpeg 未就绪 → 503 + 安装指引（前端据此把导出项降级为「剪映草稿」）；
- 合成是长任务：`POST /timeline/merge` 立即返回 task_id，前端轮询 `/timeline/tasks/{id}`，
  HTTP 全程不阻塞（与一键成片/视频任务同一套「提交-轮询」模式）。
"""
from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core import pages
from app.core.config import settings
from app.media.timeline_draft import export_clips_to_draft
from app.media.timeline_merge import (
    TimelineMergeError,
    engine_status,
    merge_clips,
    normalize_clips,
)

# 路由级守卫：创意画布（canvas）关闭时整族 404（运行期开关，路由始终挂载）
router = APIRouter(dependencies=[Depends(pages.require("canvas"))])

# 内存任务表：合片产物是转瞬即逝的中间文件，跨重启无续跑价值，故不落盘。
_TASKS: Dict[str, Dict[str, Any]] = {}
_MAX_TASKS = 40
_TASK_TTL_SECONDS = 6 * 3600

# 并发闸门：合片是满 CPU 的 ffmpeg 重编码，绝不能按请求数无界拉起进程。
# 同时最多 _MERGE_CONCURRENCY 个真正在编码，其余在任务内排队；在途（编码 + 排队）
# 超过 _MERGE_CONCURRENCY + _MERGE_QUEUE_LIMIT 时提交口直接 429，避免「狂点导出把机器打满」。
# 用纯计数器而不是 asyncio.Semaphore：后者首次竞争时会用 get_running_loop() 绑死事件循环，
# 而模块级对象要跨 TestClient / 多 loop 复用，绑循环后会抛「bound to a different event loop」。
_MERGE_CONCURRENCY = 2
_MERGE_QUEUE_LIMIT = 8
_QUEUE_POLL_SECONDS = 0.2
_merge_running = 0   # 正在编码的任务数
_merge_inflight = 0  # 已受理但未结束的任务数（编码中 + 排队中）

# 同名输出最多避让出多少个序号：同一秒内被占满到这个数说明提交口已被滥用。
_MAX_NAME_RETRY = 100


class TimelineMergeRequest(BaseModel):
    model_config = {"extra": "allow"}
    project_id: Optional[str] = None
    clips: List[Dict[str, Any]]
    title: Optional[str] = None
    output_name: Optional[str] = None
    aspect_ratio: Optional[str] = None


class TimelineDraftRequest(BaseModel):
    model_config = {"extra": "allow"}
    project_id: Optional[str] = None
    clips: List[Dict[str, Any]]
    title: Optional[str] = None
    aspect_ratio: Optional[str] = None


def _safe_name(name: Optional[str], title: Optional[str]) -> str:
    base = (name or "").strip() or f"{(title or 'timeline').strip()}_成片"
    base = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", base)[:80].strip(" ._") or "timeline"
    return base if base.lower().endswith(".mp4") else f"{base}.mp4"


def _reserve_output_path(name: Optional[str], title: Optional[str]) -> str:
    """在 exports/timeline 下独占一个输出文件名。

    文件名是「秒级时间戳 + 项目名」，同一秒内重复提交（或同一项目反复导出）**必然撞名**。
    这里用 `(1)`、`(2)`… 追加序号避让，并且必须用 `O_CREAT|O_EXCL` 真正占位：
    只做 `os.path.exists` 检查会在「检查」与「写盘」之间留出竞态窗口，
    两个并发任务会拿到同一路径，后完成者还会把先完成者的成品连同占位一起删掉。
    """
    out_dir = os.path.join(settings.EXPORTS_DIR, "timeline")
    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    stem, ext = os.path.splitext(_safe_name(name, title))
    for i in range(_MAX_NAME_RETRY):
        suffix = "" if i == 0 else f"({i})"
        candidate = os.path.join(out_dir, f"{stamp}_{stem}{suffix}{ext}")
        try:
            fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        except OSError as e:
            raise TimelineMergeError(f"无法在导出目录创建产物文件：{e}")
        os.close(fd)
        return candidate
    raise TimelineMergeError(
        f"同一秒内的同名导出过多（已占满 {_MAX_NAME_RETRY} 个序号），请稍后重试"
    )


def _prune_tasks() -> None:
    now = time.time()
    for tid in [k for k, v in _TASKS.items() if now - float(v.get("created_at") or 0) > _TASK_TTL_SECONDS]:
        _TASKS.pop(tid, None)
    if len(_TASKS) > _MAX_TASKS:
        for tid, _ in sorted(_TASKS.items(), key=lambda kv: float(kv[1].get("created_at") or 0))[: len(_TASKS) - _MAX_TASKS]:
            _TASKS.pop(tid, None)


def _patch(task_id: str, **fields: Any) -> None:
    task = _TASKS.get(task_id)
    if task is not None:
        task.update(fields)
        task["updated_at"] = time.time()


async def _run_merge(task_id: str, clips: List[Dict[str, Any]], out_path: str, aspect_ratio: Optional[str]) -> None:
    global _merge_running, _merge_inflight
    acquired = False
    try:
        # 排队：等一个空闲合成槽。等待期间 stage 保持「排队」，前端轮询看到的是「还没轮到」而非卡死。
        while _merge_running >= _MERGE_CONCURRENCY:
            _patch(task_id, stage="排队", progress=5)
            await asyncio.sleep(_QUEUE_POLL_SECONDS)
        _merge_running += 1
        acquired = True
        _patch(task_id, stage="合成", progress=30)
        try:
            result = await merge_clips(clips, out_path, aspect_ratio=aspect_ratio)
            _patch(
                task_id,
                status="success",
                stage="完成",
                progress=100,
                output_url=result["output_url"],
                output_path=result["output_path"],
                duration=result["duration"],
                size_bytes=result["size_bytes"],
                warnings=result["warnings"],
            )
        except TimelineMergeError as e:
            _patch(task_id, status="error", stage="失败", progress=100, error=str(e))
        except asyncio.CancelledError:
            _patch(task_id, status="error", stage="已取消", error="任务被取消")
            raise
        except Exception as e:  # 兜底：任何意外都要落进任务状态，前端轮询才拿得到原因
            _patch(task_id, status="error", stage="失败", progress=100, error=f"{type(e).__name__}: {e}")
    finally:
        if acquired:
            _merge_running -= 1
        _merge_inflight -= 1


@router.get("/timeline/engine")
async def timeline_engine_status():
    """引擎自检：ffmpeg 合片是否就绪 + 剪映草稿降级出口是否就绪（含安装指引）。"""
    return engine_status()


@router.post("/timeline/merge")
async def submit_timeline_merge(req: TimelineMergeRequest):
    """提交合片任务。片段校验同步完成，通过后返回 task_id 供轮询。"""
    global _merge_inflight
    status = engine_status()
    if not status.get("available"):
        raise HTTPException(
            status_code=503,
            detail=f"{status.get('ffmpeg_hint', '')} {status.get('draft_hint', '')}".strip(),
        )
    try:
        clips = normalize_clips(req.clips)
    except TimelineMergeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # 闸门放在校验之后：非法请求不该占坑。计数在同步段完成，不依赖后台任务是否已被调度。
    if _merge_inflight >= _MERGE_CONCURRENCY + _MERGE_QUEUE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"合片任务已排满（同时 {_MERGE_CONCURRENCY} 个合成 + {_MERGE_QUEUE_LIMIT} 个排队），"
                f"请等前面的任务完成后再试"
            ),
        )

    try:
        out_path = _reserve_output_path(req.output_name, req.title)
    except TimelineMergeError as e:
        raise HTTPException(status_code=429, detail=str(e))

    task_id = f"tl_{uuid.uuid4().hex[:12]}"
    _TASKS[task_id] = {
        "task_id": task_id,
        "status": "running",
        "stage": "排队",
        "progress": 5,
        "created_at": time.time(),
        "updated_at": time.time(),
        "project_id": req.project_id,
        "clips": len(clips),
        "duration": round(sum(float(c["span"]) for c in clips), 3),
        "output_name": os.path.basename(out_path),
        "engine": "ffmpeg",
    }
    _prune_tasks()
    # 占坑后才算在途：上面的校验/占位失败路径都不该泄漏计数。
    _merge_inflight += 1
    asyncio.create_task(_run_merge(task_id, clips, out_path, req.aspect_ratio))
    return {"status": "success", "task_id": task_id, "clips": len(clips),
            "duration": _TASKS[task_id]["duration"], "stage": "排队"}


@router.get("/timeline/tasks/{task_id}")
async def get_timeline_task(task_id: str):
    task = _TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期，请重新提交")
    return task


@router.post("/timeline/draft")
async def submit_timeline_draft(req: TimelineDraftRequest):
    """降级出口：不打 MP4，导出剪映/CapCut 官方草稿工程。"""
    try:
        clips = normalize_clips(req.clips)
    except TimelineMergeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        result = await export_clips_to_draft(
            clips, title=req.title or "时间线成片",
            aspect_ratio=req.aspect_ratio or "9:16", project_id=req.project_id,
        )
    except TimelineMergeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"status": "success", **result}
