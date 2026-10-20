# -*- coding: utf-8 -*-
"""
一键成片 Agent 任务 API（异步 + 轮询）

POST /api/v1/onekey/run   提交长文本 → 后台跑「总导演 Agent + 子代理集群」编排
                          （拆解/角色/生图/视频/配音/导出；可用 team_id 选择导演组）
GET  /api/v1/onekey/tasks/{task_id}  轮询进度与结果
长任务不阻塞 HTTP，前端 3s 轮询一次即可。
"""
import asyncio
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core import pages
from app.models.schemas import PipelineRunRequest

# 路由级守卫：分镜台（studio）关闭时整族 404（运行期开关，路由始终挂载）
router = APIRouter(dependencies=[Depends(pages.require_any(["studio", "onekey"]))])

TASKS: Dict[str, Dict[str, Any]] = {}
MAX_LOGS = 200
HARD_CAP_SHOTS = 30


class OneKeyRunRequest(PipelineRunRequest):
    title: str = "一键成片"
    team_id: str = Field(default="", description="导演组（agent_team）id；空=内置默认简化剧组")
    keyframe_mode: bool = Field(default=False, description="是否先生成分镜关键帧再图生视频；默认 false=用角色/场景资产直接参考生视频")
    prompt_skill: str = Field(default="", description="指定写提示词使用的技能名（如 minimax-h3-prompt / prompt-basics）；空=由导演自选")


def _resolve_team(team_id: str):
    """解析导演组：空/不存在/停用 → 内置默认「简化剧组」。"""
    tid = str(team_id or "").strip() or "studio-default"
    try:
        from app.agent_teams.manager import get_effective_team
        from app.extensions import state
        spec = get_effective_team(tid)
        if not spec or not spec.enabled:
            return None
        if state.match_disabled("agent_team", spec.id):
            return None
        return spec
    except Exception:
        return None


# ── Agent 集群模式（总导演 + 子代理自主编排）────────────────────
# 无固定流程/无阶段表：导演用 todo_write 做计划，日志只按"工具名"如实记录。


def _director_prompt(draft_id: str, req: "OneKeyRunRequest", team=None) -> str:
    """极简导演指令：只给目标与事实，其余全部由导演 Agent 用 todo_write 自主编排。"""
    members_line = ""
    if team is not None and team.members:
        members_line = f"本任务导演组成员约束：只能委派以下成员：{'、'.join(team.members)}；其他角色一律不允许。\n"
    qa_line = ""
    if team is not None and team.qa_gate:
        qa_line = ("本剧组要求导出前完成质检复核：用 subagent_run(agent=\"qa_reviewer\", "
                   f"task=\"抽检 draft_id={draft_id} 的产物：onekey_summary 看完整性 + onekey_review 拿验收要点，"
                   "用 view_media 看角色表/场景/视频抽帧（对照设定与风格）判定 pass/fail，"
                   "输出不合格清单（条目+一句话原因）\")，"
                   "质检结论（抽检结果与不合格清单）如实纳入总结。\n")
    body = ""
    if team is not None and (team.playbook or "").strip():
        try:
            from app.agent_teams.manager import render_playbook
            ctx = {"draft_id": draft_id, "title": req.title or "一键成片",
                   "aspect": req.aspect_ratio, "max_images": req.max_images,
                   "max_videos": req.max_videos}
            body = render_playbook(team, ctx) + "\n"
        except Exception:
            body = (team.playbook or "") + "\n"
    facts = []
    if not req.enable_video:
        facts.append("用户关闭了视频生成（草稿 enable_video=false）")
    if not req.gen_roles:
        facts.append("用户关闭了定妆补齐（是否补资产由你判断）")
    if getattr(req, "keyframe_mode", False):
        facts.append("用户选择：先生成分镜关键帧（多图参考由图像编辑源合成），再首帧 i2v 生成视频")
    else:
        facts.append("用户选择：**跳过分镜关键帧 / 图像编辑合成**，直接把角色多视图+场景参考喂给视频源"
                     "（r2v 多参考直出）——不要逐镜先生成分镜画面；只有某镜既无资产参考、视频源也不支持参考时才补关键帧")
    try:
        from app.pipelines.onekey_agent import _img_edit_provider as _edit_pid
        from app.pipelines import onekey_agent as _oka
        _d = _oka.get_draft(draft_id)
        if _d is not None and _edit_pid(_d) != _oka._img_provider(_d):
            facts.append(
                f"图像分工：定妆三视图/场景空镜＝生成模型（{_oka._img_provider(_d)}），"
                f"多图合成分镜＝图像编辑模型（{_edit_pid(_d)}）"
            )
        elif _d is not None:
            facts.append(
                f"图像分工：未单独配置图像编辑源，多图合成分镜与定妆共用（{_oka._img_provider(_d)}）；"
                f"若该源不支持图生图，分镜合成会退化为文生图"
            )
    except Exception:
        pass
    facts_line = ("已知事实：" + "；".join(facts) + "。\n") if facts else ""
    skill = str(getattr(req, "prompt_skill", "") or "").strip()
    skill_line = ""
    if skill:
        skill_line = (
            f"用户指定提示词技能：**{skill}**。写/改图片/视频提示词时建议先 read_skill(\"{skill}\") "
            f"并按其结构产出；视频成稿经 onekey_shot_video(prompt_override=...) 传入（工具默认兜底提示词只是基础版）。\n"
        )
    else:
        skill_line = (
            "写/改图片/视频提示词时建议先 read_skill（视频优先 minimax-h3-prompt，通用兜底 prompt-basics）："
            "技能阅读只是建议、不会拦截生成（读不到或没有合适技能时直接按经验写完整提示词即可）；"
            "成稿经 prompt_override 传入；不写则工具会用六要素兜底提示词。\n"
        )
    return (
        f"成片任务。draft_id={draft_id}；标题：{req.title or '一键成片'}；画幅 {req.aspect_ratio}；"
        f"导演组：{team.name if team else '默认简化剧组'}。\n"
        f"{members_line}{body}{facts_line}{skill_line}"
        "你是总导演，**流程完全由你决定**：先用 todo_write 写下你的计划（按内容量决定粒度）并随进展更新，"
        "然后自主选择工具与专家（subagent_run 可并行/后台委派）一步步完成。"
        "工具与团队成员都是自解释的；按工具实际返回行事，不要编造结果。\n"
        "目标：把用户文本做成可导出的成片（剪映工程），导出前自行核验产物质量；"
        "单项失败不阻塞整体，最后如实输出中文总结（关键决策、数量、失败与待补项）。\n"
        f"{qa_line}"
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


def _tool_detail(name: str, ok: bool, res: Dict[str, Any], ev: Dict[str, Any]) -> str:
    """工具结果的紧凑明细（不依赖任何固定流程/阶段表，纯展示）。"""
    if not ok:
        return f"：{str(ev.get('error') or '')[:120]}"
    if not res:
        return ""
    bits: List[str] = []
    if res.get("status") == "reused":
        bits.append("复用已有资产")
    if res.get("refs_used") is not None:
        rd = res.get("refs_detail") or {}
        names = "、".join([x for x in (rd.get("characters") or []) if x][:4])
        _sl = res.get("refs_slots")
        bits.append(f"参考图 {res['refs_used']} 张" + (f"/{_sl} 槽" if _sl else "") + (f"（场景+{names}）" if names else ""))
    if res.get("scene_index") is not None:
        bits.append(f"场景 #{res['scene_index']}")
    if res.get("shot_index") is not None:
        bits.append(f"分镜 #{res['shot_index']}" + (f" · {res.get('mode')}" if res.get("mode") else ""))
    if res.get("task_id") and res.get("status") == "submitted":
        bits.append("异步已提交")
    if name in ("subagent_run", "subagent_wait") and res.get("total") is not None:
        bits.append(f"子代理 {res.get('success')}/{res.get('total')} 成功"
                    + (f"，无产出 {res.get('no_output')}（需核对）" if res.get("no_output") else ""))
    if name == "onekey_summary" and isinstance(res.get("shots"), dict):
        sh = res["shots"]
        bits.append(f"成片 {sh.get('videos_done', 0)}/{sh.get('total', 0)}")
    if name == "onekey_review" and isinstance(res.get("counts"), dict):
        c = res["counts"]
        bits.append(f"验收清单：角色 {c.get('characters', 0)}/场景 {c.get('scenes', 0)}/视频 {c.get('shot_videos', 0)}")
    if res.get("draft_path") or res.get("export_path"):
        bits.append(str(res.get("draft_path") or res.get("export_path"))[:120])
    if res.get("note"):
        bits.append(str(res["note"])[:140])
    if res.get("warning"):
        bits.append(f"⚠️ {str(res['warning'])[:160]}")
    return ("（" + " · ".join(bits) + "）") if bits else ""


async def _run_agent_task(task_id: str, req: "OneKeyRunRequest") -> None:
    """总导演 Agent 驱动 + 子代理并行：进度从父会话事件流映射。"""
    task = TASKS.get(task_id)
    if not task:
        return
    task["status"] = "running"
    from app.agent.runtime.manager import agent_manager
    from app.agent.runtime.agents import get_profile, team_brief
    from app.pipelines import onekey_agent as oka

    team = _resolve_team(getattr(req, "team_id", "") or "")
    if team is not None:
        task["team_id"] = team.id
        task["team_name"] = team.name
    elif (getattr(req, "team_id", "") or "").strip():
        task["team_id"] = str(req.team_id)
        task["team_name"] = ""

    try:
        max_shots = max(1, min(req.max_images, HARD_CAP_SHOTS))
        draft = oka.create_draft(
            f"ok_{task_id}", req.title or "一键成片", req.text,
            style_preset=req.style_preset, aspect_ratio=req.aspect_ratio,
            custom_instructions=req.custom_instructions or "",
            image_provider=req.image_provider or "", video_provider=req.video_provider or "",
            image_edit_provider=req.image_edit_provider or "",
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
            if et == "todo_write":
                items = ev.get("items") if isinstance(ev.get("items"), list) else []
                counts = ev.get("counts") if isinstance(ev.get("counts"), dict) else {}
                if items:
                    task["todos"] = items
                total = int(counts.get("total") or 0)
                if total:
                    done_n = int(counts.get("completed") or 0)
                    _log("导演计划", f"计划 {total} 项 · 已完成 {done_n} · 进行中 {counts.get('in_progress', 0)}")
                    task["progress"] = max(task.get("progress", 0),
                                           min(92, 5 + int(done_n / max(1, total) * 90)))
            elif et == "tool_calling":
                if name and name != "todo_write":
                    _log(name, f"执行 {name} …")
            elif et == "tool_result":
                if name == "todo_write":
                    pass  # 由 todo_write 事件统一展示（导演计划）
                else:
                    ok = ev.get("status") == "success"
                    res = ev.get("result") if isinstance(ev.get("result"), dict) else {}
                    detail = _tool_detail(name, ok, res, ev)
                    _log(name or "工具", f"{name or '工具'} {'完成' if ok else '失败'}{detail}")
                    if ok and res.get("warning"):
                        _log("警告", str(res["warning"])[:200])
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
                    tool = str(ev.get("tool_name") or "")
                    rec["tool"] = tool
                    trail = rec.setdefault("trail", [])
                    trail.append({
                        "t": int(time.time() * 1000),
                        "tool": tool,
                        "phase": ev.get("phase") or "",
                        "status": ev.get("status") or "",
                        "detail": str(ev.get("detail") or "")[:160],
                    })
                    if len(trail) > 60:
                        del trail[:-60]
            elif et == "subagent_settled":
                sid = str(ev.get("subagent_id") or "")
                rec = (task.get("subagents") or {}).get(sid)
                if rec is not None:
                    rec["status"] = ev.get("status") or "success"
                    rec["elapsed_ms"] = ev.get("elapsed_ms") or 0
                    rec["error"] = ev.get("error") or ""
                    if ev.get("result_summary"):
                        rec["result"] = str(ev.get("result_summary"))[:300]
                _log("子代理集群", f"[{ev.get('agent')}] {ev.get('status')}（{ev.get('elapsed_ms') or 0}ms）"
                                   f"{(' ' + str(ev.get('error'))[:100]) if ev.get('error') else ''}")
            elif et == "subagent_metrics":
                _log("子代理集群", f"批次 {ev.get('batch_id')}：成功 {ev.get('success')}/{ev.get('total')}"
                                   f"，失败 {ev.get('failed', 0)}"
                                   + (f"，无产出 {ev.get('no_output')}（需核对产物）" if ev.get('no_output') else "")
                                   + f"，最慢子项 {ev.get('critical_steps_ms')}ms，并行宽度 {ev.get('parallel_width')}")
            elif et == "error":
                _log("错误", str(ev.get("message") or "")[:180])
            if et in ("agent_response", "error"):
                done.set()
        except Exception:
            pass

    try:
        _log("启动", f"总导演 Agent 已就绪（导演组：{team.name if team else '内置默认'}），由它自主制定计划并执行…", 5)
        # 预检：图片源允许文生图（资产生成/分镜）；**视频源**丢参考才是真实风险 → 分别告知
        try:
            from app.pipelines.onekey_agent import _provider_image_slots, _img_edit_provider
            from app.core.config import settings as _settings
            _ipid = (req.image_provider or "").strip() or str(getattr(_settings, "IMAGE_PROVIDER", "") or "")
            _islots = _provider_image_slots(_ipid) if _ipid else None
            if _islots == 0:
                _log("预检", f"生图源「{_ipid}」为文生图：定妆三视图/场景空镜按文本+风格生成（正常）。")
            elif _islots is not None and _islots > 0:
                _log("预检", f"生图源「{_ipid}」支持参考图（{_islots} 槽）✓")
            _epid = _img_edit_provider(draft) if draft is not None else ""
            if _epid and _epid != _ipid:
                _eslots = _provider_image_slots(_epid)
                _log("预检", f"图像编辑源「{_epid}」：多图合成分镜走该源"
                              + (f"（{_eslots} 槽）" if _eslots is not None else ""))
            elif _epid:
                _log("预检", f"未单独配置图像编辑源：多图合成分镜与生图共用「{_epid}」"
                              f"（若该源不支持图生图，可能退化为文生图）")
            if req.enable_video:
                _vpid = (req.video_provider or "").strip() or str(getattr(_settings, "VIDEO_PROVIDER", "") or "")
                _vslots = _provider_image_slots(_vpid) if _vpid else None
                if _vslots == 0:
                    _log("警告", f"视频源「{_vpid}」无参考图槽位：角色/场景资产无法参与视频生成，"
                                 f"成片一致性只能靠首帧；建议换支持参考图的视频源。")
                elif _vslots == 1:
                    _log("预检", f"视频源「{_vpid}」为单图片槽（首帧专用）：参考图不传，一致性依赖首帧画面。")
                elif _vslots is not None:
                    _log("预检", f"视频源「{_vpid}」支持参考图（{_vslots} 槽）：成片将用首帧+角色/场景多参考 ✓")
                if not getattr(req, "keyframe_mode", False) and _vslots is not None and _vslots <= 1:
                    _log("警告", f"当前是「直出」模式（跳过分镜画面），但视频源「{_vpid}」只有 {_vslots} 个图片槽，"
                                 f"无法多图参考；建议开启「先生成分镜画面」（i2v），或换支持多参考的视频源。")
        except Exception:
            pass
        await agent_manager.prompt(
            session_id,
            f"{_director_prompt(draft.id, req, team)}\n\n{team_brief(members=list(team.members) if (team and team.members) else None)}",
            context={"project_title": req.title or "一键成片", "onekey": True,
                     "team_id": team.id if team else ""},
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


@router.post("/onekey/run")
async def onekey_run(req: OneKeyRunRequest):
    text = (req.text or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="文本太短（至少20字），请粘贴小说章节或故事梗概")
    task_id = f"onekey_{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    _team = _resolve_team(getattr(req, "team_id", "") or "")
    TASKS[task_id] = {
        "task_id": task_id,
        "title": req.title or "一键成片",
        "status": "queued",
        "progress": 0,
        "logs": [],
        "subagents": {},
        "todos": [],
        "team_id": _team.id if _team else str(getattr(req, "team_id", "") or ""),
        "team_name": _team.name if _team else "",
        "result": None,
        "error": None,
        "created_at": now,
        "updated_at": now,
    }
    asyncio.create_task(_run_agent_task(task_id, req))
    return {"task_id": task_id, "status": "queued",
            "team_id": _team.id if _team else "", "team_name": _team.name if _team else ""}


@router.get("/onekey/tasks/{task_id}")
async def onekey_status(task_id: str, include_project: bool = True):
    task = TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"任务不存在: {task_id}")
    # 草稿仍在则实时刷新结果快照（异步视频完成后会自动回写草稿，历史任务也能看到终态）
    try:
        from app.pipelines import onekey_agent as _oka
        _draft = _oka.get_draft(f"ok_{task_id}")
        if _draft is not None:
            task["result"] = _oka.draft_result(_draft)
    except Exception:
        pass
    if not include_project and task.get("result"):
        shallow = {k: v for k, v in task.items() if k != "result"}
        shallow["result"] = {k: v for k, v in (task["result"] or {}).items() if k != "project"}
        return shallow
    return task


@router.get("/onekey/tasks")
async def onekey_list(limit: int = 20):
    items = sorted(TASKS.values(), key=lambda t: t.get("created_at", ""), reverse=True)[: max(1, min(limit, 50))]
    return {"tasks": [{k: v for k, v in t.items() if k not in ("result",)} for t in items]}
