# -*- coding: utf-8 -*-
"""一键成片草稿与原子工具 — Agent 集群模式的底层能力。

把「拆解/定妆/生图/生视频/配音/导出」拆成幂等原子工具（onekey_*），
由总导演 Agent 通过 subagent_run 并行委派给专家子代理执行：
- 草稿（OneKeyDraft）是唯一事实来源，draft_id 由任务创建时分配；
- 每个工具只处理一个角色/一个镜头，天然可并行；
- onekey_summary 提供精简进度给编排者调度（Context Sharding：不给全量剧本）。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.core.config import settings

_MAX_DRAFTS = 30
_DRAFTS: Dict[str, "OneKeyDraft"] = {}
_ORDER: List[str] = []


@dataclass
class OneKeyDraft:
    id: str
    title: str
    novel_text: str
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    custom_instructions: str = ""
    image_provider: str = ""
    video_provider: str = ""
    audio_provider: str = ""
    image_workflow_id: str = ""
    video_workflow_id: str = ""
    max_images: int = 20
    max_videos: int = 12
    gen_roles: bool = True
    enable_video: bool = True
    project: Any = None
    role_fail: List[Dict[str, Any]] = field(default_factory=list)
    image_fail: List[Dict[str, Any]] = field(default_factory=list)
    video_fail: List[Dict[str, Any]] = field(default_factory=list)
    video_pending: List[Dict[str, Any]] = field(default_factory=list)
    voice_fail: List[Dict[str, Any]] = field(default_factory=list)
    export_result: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)

    # ── 结构访问 ─────────────────────────────────────────
    def all_shots(self) -> List[Any]:
        if self.project is None:
            return []
        try:
            return [sh for sc in self.project.scenes for sh in sc.shots]
        except Exception:
            return []

    def find_shot(self, shot_index: int) -> Optional[Any]:
        for sh in self.all_shots():
            try:
                if int(getattr(sh, "shot_index", -1)) == int(shot_index):
                    return sh
            except Exception:
                continue
        return None

    def find_character(self, name: str) -> Optional[Any]:
        if self.project is None:
            return None
        for c in getattr(self.project, "characters", []) or []:
            if str(getattr(c, "name", "")) == str(name):
                return c
        return None


def create_draft(draft_id: str, title: str, novel_text: str, **opts: Any) -> OneKeyDraft:
    d = OneKeyDraft(id=draft_id, title=title or "一键成片", novel_text=novel_text, **{
        k: v for k, v in opts.items() if k in OneKeyDraft.__dataclass_fields__ and k not in ("id", "title", "novel_text")
    })
    _DRAFTS[d.id] = d
    _ORDER.append(d.id)
    while len(_ORDER) > _MAX_DRAFTS:
        old = _ORDER.pop(0)
        if old != d.id:
            _DRAFTS.pop(old, None)
    return d


def get_draft(draft_id: str) -> Optional[OneKeyDraft]:
    return _DRAFTS.get(str(draft_id or ""))


def _need_draft(args: Dict[str, Any]) -> "OneKeyDraft | Dict[str, Any]":
    d = get_draft(str((args or {}).get("draft_id") or ""))
    if d is None:
        return {"error": "draft_id 不存在或已过期（请用 onekey 任务创建的 draft_id）"}
    return d


def _img_provider(d: OneKeyDraft) -> str:
    return d.image_provider or getattr(settings, "IMAGE_PROVIDER", "") or "comfyui"


def _vid_provider(d: OneKeyDraft) -> str:
    return d.video_provider or getattr(settings, "VIDEO_PROVIDER", "") or "comfyui_video"


def _aud_provider(d: OneKeyDraft) -> str:
    return d.audio_provider or getattr(settings, "TTS_PROVIDER", "") or "minimax"


# ── 原子工具实现 ─────────────────────────────────────────
async def _onekey_split(d: OneKeyDraft) -> Dict[str, Any]:
    if d.project is not None:
        chars = getattr(d.project, "characters", []) or []
        shots = d.all_shots()
        return {"draft_id": d.id, "status": "already_split",
                "characters": [{"name": getattr(c, "name", "?"), "role": getattr(c, "role", "")} for c in chars],
                "total_shots": len(shots)}
    from app.pipelines.script_agent import script_agent
    project = await script_agent.parse_novel_to_project(
        d.novel_text, d.style_preset, d.aspect_ratio, d.custom_instructions)
    d.project = project
    chars = getattr(project, "characters", []) or []
    shots = d.all_shots()
    shot_brief = []
    for sh in shots[:60]:
        brief = (getattr(sh, "action_desc", "") or getattr(sh, "image_prompt", "") or "")[:60]
        shot_brief.append({
            "shot_index": getattr(sh, "shot_index", 0),
            "framing": getattr(sh, "camera_framing", ""),
            "has_dialogue": bool(getattr(sh, "dialogue", "") or getattr(sh, "voiceover", "")),
            "brief": brief,
        })
    return {
        "draft_id": d.id, "status": "split_done",
        "characters": [{"name": getattr(c, "name", "?"), "role": getattr(c, "role", ""),
                        "gender": getattr(c, "gender", "")} for c in chars],
        "total_shots": len(shots),
        "shots": shot_brief,
        "note": "后续用 subagent_run 并行推进：角色定妆→逐镜生图→图生视频→配音→导出",
    }


async def _onekey_role_image(d: OneKeyDraft, character: str) -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    c = d.find_character(character)
    if c is None:
        return {"error": f"角色不存在: {character}"}
    from app.pipelines.consistency_engine import consistency_engine
    from app.providers.image.base import ImageGenerateRequest
    from app.pipelines.unified_orchestrator import _get_image_registry
    prompts = consistency_engine.build_character_3views_prompts(c, d.style_preset)
    front_prompt = (prompts or {}).get("front") or next(iter((prompts or {}).values()), "")
    if not front_prompt:
        return {"error": f"角色 {character} 无可用定妆提示词"}
    req = ImageGenerateRequest(prompt=front_prompt, aspect_ratio="1:1", style_preset=d.style_preset)
    res = await _get_image_registry().generate(req, provider_id=_img_provider(d))
    c.three_views = {"front": res.image_url}
    return {"draft_id": d.id, "character": character, "image_url": res.image_url,
            "provider": getattr(res, "provider", ""), "status": "done"}


async def _onekey_shot_image(d: OneKeyDraft, shot_index: int, prompt_override: str = "") -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    shot = d.find_shot(shot_index)
    if shot is None:
        return {"error": f"分镜不存在: #{shot_index}"}
    from app.pipelines.unified_orchestrator import _camera_suffix, _mentioned_roles, _role_front, _get_image_registry
    from app.providers.image.base import ImageGenerateRequest
    roles = _mentioned_roles(shot, getattr(d.project, "characters", []) or [])
    tags = " ".join(f"[角色: {getattr(r, 'name', '')}]" for r in roles)
    base_prompt = prompt_override or getattr(shot, "image_prompt", "") or getattr(shot, "action_desc", "") or "cinematic anime scene"
    if tags and not any(getattr(r, "name", "") in base_prompt for r in roles):
        base_prompt = f"{tags} {base_prompt}"
    cam = _camera_suffix(shot)
    if cam and "[运镜:" not in base_prompt and "[Camera:" not in base_prompt:
        base_prompt = f"{base_prompt}{cam}"
    refs = [u for u in (_role_front(r) for r in roles) if u]
    req = ImageGenerateRequest(
        prompt=base_prompt, negative_prompt="", aspect_ratio=d.aspect_ratio,
        style_preset=d.style_preset, workflow_id=d.image_workflow_id or None,
        dynamic_inputs={"reference_images": refs} if refs else None,
    )
    res = await _get_image_registry().generate(req, provider_id=_img_provider(d))
    shot.image_url = res.image_url
    shot.status = "completed"
    return {"draft_id": d.id, "shot_index": shot_index, "image_url": res.image_url,
            "provider": getattr(res, "provider", ""), "status": "done"}


async def _onekey_shot_video(d: OneKeyDraft, shot_index: int) -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    if not d.enable_video:
        return {"error": "本任务未开启图生视频"}
    shot = d.find_shot(shot_index)
    if shot is None:
        return {"error": f"分镜不存在: #{shot_index}"}
    first = getattr(shot, "image_url", "")
    if not first:
        return {"error": f"分镜 #{shot_index} 还没有画面（先生成 onekey_shot_image）"}
    from app.pipelines.unified_orchestrator import _camera_suffix, _mentioned_roles, _role_front, _get_video_registry
    from app.providers.video.base import VideoGenerateRequest
    roles = _mentioned_roles(shot, getattr(d.project, "characters", []) or [])
    refs = [u for u in (_role_front(r) for r in roles) if u]
    vprompt = getattr(shot, "video_prompt", "") or getattr(shot, "action_desc", "") or ""
    cam = _camera_suffix(shot)
    if cam and "[运镜:" not in vprompt and "[Camera:" not in vprompt:
        vprompt = f"{vprompt}{cam}"
    previz_vid = (getattr(shot, "previz_video_url", "") or "").strip()
    req = VideoGenerateRequest(
        prompt=vprompt or "cinematic camera move", mode="i2v", first_frame_url=first,
        reference_images=refs or None,
        reference_videos=[previz_vid] if previz_vid else None,
        duration=int(getattr(shot, "duration", 0) or 5),
        aspect_ratio=d.aspect_ratio, workflow_id=d.video_workflow_id or None,
    )
    res = await _get_video_registry().generate(req, provider_id=_vid_provider(d))
    if getattr(res, "video_url", ""):
        shot.video_url = res.video_url
        return {"draft_id": d.id, "shot_index": shot_index, "video_url": res.video_url,
                "provider": getattr(res, "provider", ""), "status": "done"}
    if getattr(res, "task_id", ""):
        d.video_pending.append({"shot_index": shot_index, "task_id": res.task_id})
        return {"draft_id": d.id, "shot_index": shot_index, "task_id": res.task_id,
                "status": "submitted", "note": "异步生成中，可用 task_status 查询"}
    return {"error": f"分镜 #{shot_index} 视频无结果返回"}


async def _onekey_shot_voice(d: OneKeyDraft, shot_index: int) -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    shot = d.find_shot(shot_index)
    if shot is None:
        return {"error": f"分镜不存在: #{shot_index}"}
    line = getattr(shot, "dialogue", "") or getattr(shot, "voiceover", "")
    if not line:
        return {"draft_id": d.id, "shot_index": shot_index, "status": "skipped", "note": "该镜无台词/旁白"}
    from app.providers.audio.base import AudioGenerateRequest
    from app.pipelines.unified_orchestrator import _get_audio_registry
    chars = getattr(d.project, "characters", []) or []
    speaker = getattr(shot, "speaker_name", "") or ""
    char_voice = {getattr(c, "name", ""): getattr(c, "voice_id", "") for c in chars}
    char_ref = {getattr(c, "name", ""): (getattr(c, "ref_audio_url", "") or "") for c in chars}
    narrator_voice = next((getattr(c, "voice_id", "") for c in chars if getattr(c, "role", "") == "narrator"), "male-pangbai")
    narrator_ref = next((getattr(c, "ref_audio_url", "") or "" for c in chars if getattr(c, "role", "") == "narrator"), "")
    voice_id = char_voice.get(speaker, narrator_voice)
    ref_audio = char_ref.get(speaker, narrator_ref)
    req = AudioGenerateRequest(text=line, voice_id=voice_id, emotion=getattr(shot, "emotion", ""),
                               ref_audio_path=(ref_audio or None))
    res = await _get_audio_registry().generate(req, provider_id=_aud_provider(d))
    shot.audio_url = res.audio_url
    return {"draft_id": d.id, "shot_index": shot_index, "audio_url": res.audio_url,
            "voice_id": voice_id, "status": "done"}


async def _onekey_export(d: OneKeyDraft) -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    from app.pipelines.jianyin_exporter import jianyin_exporter, DraftExportError
    try:
        res = await jianyin_exporter.export_project_to_jianyin_draft_async(d.project)
        d.export_result = res or {}
        return {"draft_id": d.id, "status": "done", **(d.export_result or {})}
    except DraftExportError as e:
        return {"error": f"导出中止: {e}"}


def _onekey_summary(d: OneKeyDraft) -> Dict[str, Any]:
    if d.project is None:
        return {"draft_id": d.id, "status": "created", "note": "尚未拆解"}
    shots = d.all_shots()
    img_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "image_url", "")]
    vid_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "video_url", "")]
    voice_needed = [getattr(s, "shot_index", 0) for s in shots if (getattr(s, "dialogue", "") or getattr(s, "voiceover", ""))]
    voice_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "audio_url", "")]
    chars = getattr(d.project, "characters", []) or []
    char_ready = [getattr(c, "name", "") for c in chars if (getattr(c, "three_views", None) or {}).get("front") or getattr(c, "avatar_url", "")]
    async_idx = [p.get("shot_index") for p in d.video_pending]
    return {
        "draft_id": d.id, "status": "running",
        "characters": {"total": len(chars), "ready": len(char_ready), "pending": [getattr(c, "name", "") for c in chars if getattr(c, "name", "") not in char_ready]},
        "shots": {
            "total": len(shots),
            "images_done": len(img_done), "images_pending": [getattr(s, "shot_index", 0) for s in shots if not getattr(s, "image_url", "")][:30],
            "videos_done": len(vid_done), "videos_async": async_idx, "videos_failed": d.video_fail[-10:],
            "voice_needed": len(voice_needed), "voice_done": len(voice_done),
            "voice_pending": [i for i in voice_needed if i not in voice_done][:30],
        },
        "image_errors": d.image_fail[-10:],
        "role_errors": d.role_fail[-10:],
        "exported": bool(d.export_result and not d.export_result.get("error")),
    }


async def handle_onekey_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """内置工具分发（由 pipeline.execute 调用）。"""
    args = args or {}
    d = _need_draft(args)
    if isinstance(d, dict):
        return d
    try:
        if name == "onekey_split":
            return await _onekey_split(d)
        if name == "onekey_role_image":
            return await _onekey_role_image(d, str(args.get("character") or "").strip())
        if name == "onekey_shot_image":
            return await _onekey_shot_image(d, int(args.get("shot_index") or 0), str(args.get("prompt_override") or ""))
        if name == "onekey_shot_video":
            return await _onekey_shot_video(d, int(args.get("shot_index") or 0))
        if name == "onekey_shot_voice":
            return await _onekey_shot_voice(d, int(args.get("shot_index") or 0))
        if name == "onekey_export":
            return await _onekey_export(d)
        if name == "onekey_summary":
            return _onekey_summary(d)
        return {"error": f"未知一键成片工具: {name}"}
    except Exception as e:
        return {"error": f"{name} 执行失败: {str(e)[:300]}"}


def draft_result(d: OneKeyDraft) -> Dict[str, Any]:
    """给路由/前端的成品汇总（与经典流水线返回结构对齐）。"""
    if d.project is None:
        return {"summary": {"characters": 0, "total_shots": 0}, "project": None,
                "jianyin_draft": {}, "image_errors": [], "video_errors": [], "videos_pending": []}
    shots = d.all_shots()
    chars = getattr(d.project, "characters", []) or []
    img_ok = sum(1 for s in shots if getattr(s, "image_url", ""))
    vid_ok = sum(1 for s in shots if getattr(s, "video_url", ""))
    voice_ok = sum(1 for s in shots if getattr(s, "audio_url", ""))
    return {
        "summary": {
            "characters": len(chars),
            "roles_designed": sum(1 for c in chars if (getattr(c, "three_views", None) or {}).get("front")),
            "total_shots": len(shots),
            "images_generated": img_ok, "images_failed": len(d.image_fail),
            "videos_generated": vid_ok, "videos_failed": len(d.video_fail),
            "videos_pending": len(d.video_pending),
            "tts_generated": voice_ok, "tts_skipped_or_failed": len(d.voice_fail),
            "draft_exported": bool(d.export_result and not d.export_result.get("error")),
        },
        "project": d.project.model_dump() if d.project is not None else None,
        "jianyin_draft": d.export_result or {},
        "image_errors": d.image_fail,
        "video_errors": d.video_fail,
        "videos_pending": d.video_pending,
    }
