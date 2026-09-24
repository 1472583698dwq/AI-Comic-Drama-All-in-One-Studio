# -*- coding: utf-8 -*-
"""
一键成片 Agent 任务 API（异步 + 轮询）

POST /api/v1/onekey/run   提交长文本 → 后台跑编排（拆解/角色/生图/视频/配音/导出）
  - engine="pipeline"（默认）：经典确定性流水线（unified_orchestrator）
  - engine="agent"：总导演 Agent + 子代理集群（SubAgentPool 并行委派，参考 Kimi Agent Swarm）
GET  /api/v1/onekey/tasks/{task_id}  轮询进度与结果
长任务不阻塞 HTTP，前端 3s 轮询一次即可。
"""
import asyncio
import os
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.models.schemas import PipelineRunRequest
from app.pipelines.unified_orchestrator import unified_orchestrator

router = APIRouter()

TASKS: Dict[str, Dict[str, Any]] = {}
MAX_LOGS = 200
HARD_CAP_SHOTS = 30


class OneKeyRunRequest(PipelineRunRequest):
    title: str = "一键成片"
    engine: str = Field(default="pipeline", description="编排引擎：pipeline 经典流水线 / agent 智能体集群")


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


# ── Agent 集群模式（总导演 + 子代理并行）────────────────────────
_AGENT_STAGE = {
    "onekey_split": ("Stage 1 · 剧本拆解", 10),
    "onekey_role_image": ("Stage 2 · 角色资产", 25),
    "onekey_shot_image": ("Stage 3 · 生图", 50),
    "onekey_shot_video": ("Stage 4 · 视频", 70),
    "onekey_shot_voice": ("Stage 5 · TTS 配音", 85),
    "onekey_export": ("Stage 6 · 剪映导出", 95),
}


def _director_prompt(draft_id: str, req: "OneKeyRunRequest") -> str:
    roles_line = (
        "2. 用 subagent_run(agent=\"character_designer\", batch=[每角色一项]) 同步并行为全部角色定妆（阻塞等待结果）；\n"
        if req.gen_roles else "2. 本任务关闭角色定妆，跳过；\n"
    )
    if req.enable_video:
        video_block = (
            "4. 用 subagent_run(agent=\"video_operator\", batch=[每镜一项], background=true) 后台提交图生视频，记下返回的 batch_id；\n"
            "5. 用 subagent_run(agent=\"voice_operator\", batch=[每镜一项]) 同步并行为有台词分镜配音（阻塞等待结果）；\n"
            "6. 用 subagent_wait(batch_id=视频批次) 阻塞等待全部视频完成/超时快照后，再进入导出；\n"
        )
        export_no = 7
        summary_no = 8
    else:
        video_block = (
            "4. 本任务关闭视频，跳过；\n"
            "5. 用 subagent_run(agent=\"voice_operator\", batch=[每镜一项]) 同步并行为有台词分镜配音（阻塞等待结果）；\n"
        )
        export_no = 6
        summary_no = 7
    return (
        f"执行一键成片任务（Agent 集群模式）。draft_id={draft_id}；标题：{req.title or '一键成片'}；画幅 {req.aspect_ratio}。\n"
        "严格按阶段推进，同质任务必须用 subagent_run 的 batch 并行委派；需要结果才能继续的用同步阻塞，长耗时独立的用后台+收口：\n"
        f"1. 你自己先调用 onekey_split(draft_id=\"{draft_id}\") 拆解，拿到角色与分镜清单；\n"
        f"{roles_line}"
        "3. 用 subagent_run(agent=\"storyboard_artist\", batch=[每镜一项]) 同步并行生成全部分镜画面（每项 task 含 draft_id 和 shot_index）；\n"
        f"{video_block}"
        f"{export_no}. 用 subagent_run(agent=\"editor\", task=\"把 draft_id={draft_id} 的草稿导出剪映\") 同步导出；\n"
        f"{summary_no}. 调用 onekey_summary(draft_id) 核对结果，最后输出中文制作总结（角色/分镜/成图/成片/配音/导出数量与失败待补项）。\n"
        "约束：单批不超过 30 项；单项失败不阻塞整体（记录后继续），最终总结必须如实汇报失败项。"
    )


def _track_subagent(task: Dict[str, Any], sid: str, rec: Dict[str, Any]) -> None:
    """一键成片任务内的子代理花名册（前端轮询渲染集群视图）。"""
    if not sid:
        return
    subs = task.setdefault("subagents", {})
    subs[sid] = {"id": sid, **rec}
    if len(subs) > 100:
        for k in list(subs.keys())[:-100]:
            subs.pop(k, None)


async def _run_agent_task(task_id: str, req: "OneKeyRunRequest") -> None:
    """总导演 Agent 驱动 + 子代理并行：进度从父会话事件流映射。"""
    task = TASKS.get(task_id)
    if not task:
        return
    task["status"] = "running"
    from app.agent.runtime.manager import agent_manager
    from app.agent.runtime.agents import get_profile, team_brief
    from app.pipelines import onekey_agent as oka

    try:
        max_shots = max(1, min(req.max_images, HARD_CAP_SHOTS))
        draft = oka.create_draft(
            f"ok_{task_id}", req.title or "一键成片", req.text,
            style_preset=req.style_preset, aspect_ratio=req.aspect_ratio,
            custom_instructions=req.custom_instructions or "",
            image_provider=req.image_provider or "", video_provider=req.video_provider or "",
            audio_provider=req.audio_provider or "",
            image_workflow_id=req.image_workflow_id or "", video_workflow_id=req.video_workflow_id or "",
            max_images=max_shots, max_videos=max(0, min(req.max_videos, HARD_CAP_SHOTS)),
            gen_roles=req.gen_roles, enable_video=req.enable_video,
        )
    except Exception as e:
        task["status"] = "failed"
        task["error"] = f"创建草稿失败: {e}"
        return

    def _log(stage: str, message: str, progress: Optional[int] = None) -> None:
        try:
            task["logs"].append({"stage": stage, "message": message,
                                 "time_ms": int(time.time() * 1000)})
            if len(task["logs"]) > MAX_LOGS:
                task["logs"] = task["logs"][-MAX_LOGS:]
            if progress:
                task["progress"] = max(task.get("progress", 0), progress)
            task["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    session_id = f"onekey_{task_id}"
    done = asyncio.Event()

    async def sink(ev: Dict[str, Any]) -> None:
        try:
            et = str(ev.get("event") or "")
            name = str(ev.get("tool_name") or "")
            if et == "tool_calling" and name in _AGENT_STAGE:
                stage, prog = _AGENT_STAGE[name]
                _log(stage, f"执行 {name} …", prog)
            elif et == "tool_result" and name in _AGENT_STAGE:
                stage, prog = _AGENT_STAGE[name]
                ok = ev.get("status") == "success"
                detail = "" if ok else f"：{str(ev.get('error') or '')[:120]}"
                _log(stage, f"{name} {'完成' if ok else '失败'}{detail}", prog if ok else None)
            elif et == "subagent_started":
                _track_subagent(task, str(ev.get("subagent_id") or ""), {
                    "agent": ev.get("agent") or "", "task": str(ev.get("task") or "")[:80],
                    "status": "running", "batch_id": ev.get("batch_id") or "",
                    "started_at": time.time(),
                })
                _log("子代理集群", f"启动 [{ev.get('agent')}] {str(ev.get('task') or '')[:60]}")
            elif et == "subagent_progress":
                sid = str(ev.get("subagent_id") or "")
                rec = (task.get("subagents") or {}).get(sid)
                if rec is not None:
                    rec["tool"] = ev.get("tool_name") or ""
            elif et == "subagent_settled":
                sid = str(ev.get("subagent_id") or "")
                rec = (task.get("subagents") or {}).get(sid)
                if rec is not None:
                    rec["status"] = ev.get("status") or "success"
                    rec["elapsed_ms"] = ev.get("elapsed_ms") or 0
                    rec["error"] = ev.get("error") or ""
                _log("子代理集群", f"[{ev.get('agent')}] {ev.get('status')}（{ev.get('elapsed_ms') or 0}ms）"
                                   f"{(' ' + str(ev.get('error'))[:100]) if ev.get('error') else ''}")
            elif et == "subagent_metrics":
                _log("子代理集群", f"批次 {ev.get('batch_id')}：成功 {ev.get('success')}/{ev.get('total')}"
                                   f"，最慢子项 {ev.get('critical_steps_ms')}ms，并行宽度 {ev.get('parallel_width')}")
            elif et == "error":
                _log("错误", str(ev.get("message") or "")[:180])
            if et in ("agent_response", "error"):
                done.set()
        except Exception:
            pass

    try:
        _log("启动", "总导演 Agent 已就绪，开始拆解与并行委派…", 5)
        await agent_manager.prompt(
            session_id, f"{_director_prompt(draft.id, req)}\n\n{team_brief()}",
            context={"project_title": req.title or "一键成片", "onekey": True},
            mode="execute", run_mode="auto", interactive=False, sink=sink,
            agent_profile=get_profile("director"),
        )
        try:
            await asyncio.wait_for(done.wait(),
                                   timeout=float(os.environ.get("ONEKEY_AGENT_TIMEOUT") or 3600))
        except asyncio.TimeoutError:
            _log("超时", "Agent 集群超过总时限，已中止剩余任务", 90)
            try:
                await agent_manager.abort(session_id)
            except Exception:
                pass
    except Exception as e:
        task["status"] = "failed"
        task["error"] = str(e)[:500]
        task["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        return
    finally:
        try:
            agent_manager.detach(session_id, sink)
        except Exception:
            pass

    res = oka.draft_result(draft)
    summary = res.get("summary") or {}
    task["result"] = res
    task["progress"] = 100
    task["status"] = "success" if (res.get("project") and summary.get("draft_exported")) else "partial"
    if task["status"] == "partial" and not task.get("error"):
        task["error"] = "部分产物缺失/失败（详见 result.summary）"
    task["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")


async def _run_task(task_id: str, req: OneKeyRunRequest) -> None:
    task = TASKS.get(task_id)
    if not task:
        return
    task["status"] = "running"
    if (getattr(req, "engine", "") or "pipeline").strip().lower() == "agent":
        await _run_agent_task(task_id, req)
        return

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
        "subagents": {},
        "result": None,
        "error": None,
        "created_at": now,
        "updated_at": now,
    }
    asyncio.create_task(_run_task(task_id, req))
    return {"task_id": task_id, "status": "queued", "engine": (req.engine or "pipeline")}


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
