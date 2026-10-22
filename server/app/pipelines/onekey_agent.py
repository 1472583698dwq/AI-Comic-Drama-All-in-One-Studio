# -*- coding: utf-8 -*-
"""一键成片草稿与原子工具 — Agent 集群模式的底层能力。

把「拆解/定妆/生图/生视频/配音/导出」拆成幂等原子工具（onekey_*），
由总导演 Agent 通过 subagent_run 并行委派给专家子代理执行：
- 草稿（OneKeyDraft）是唯一事实来源，draft_id 由任务创建时分配；
- 每个工具只处理一个角色/一个镜头，天然可并行；
- onekey_summary 提供精简进度给编排者调度（Context Sharding：不给全量剧本）。
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.core.config import settings

_MAX_DRAFTS = 30
_DRAFTS: Dict[str, "OneKeyDraft"] = {}
_ORDER: List[str] = []
# 已接入统一轮询的异步视频任务（task_id 去重，防止重复起 watcher）
_VIDEO_WATCHERS: set = set()


@dataclass
class OneKeyDraft:
    id: str
    title: str
    novel_text: str
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    custom_instructions: str = ""
    image_provider: str = ""
    # 图像编辑源（i2i）：多图合成分镜；空 = 沿用 image_provider
    image_edit_provider: str = ""
    video_provider: str = ""
    audio_provider: str = ""
    image_workflow_id: str = ""
    video_workflow_id: str = ""
    max_images: int = 20
    max_videos: int = 12
    gen_roles: bool = True
    enable_video: bool = True
    project: Any = None
    # 全片统一风格规范（LLM 生成：画风/线条/色彩/光影/镜头语言；生图/生视频自动附加）
    style_spec: str = ""
    # 复用已有角色资产的角色名（直接使用角色资产，不重复定妆）
    assets_reused: List[str] = field(default_factory=list)
    # 参考图被降级/丢弃的告警（例如所选生图源无参考图槽位）——必须在 UI 可见，不允许静默
    ref_warnings: List[str] = field(default_factory=list)
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
        return {"error": ("draft_id 不存在或已过期：一键成片草稿目前是**内存对象**，需在项目页点「⚡ 一键成片」"
                          "由前端创建（服务重启/换会话后旧 draft_id 即失效，项目 ID / 剧本 ID 都不能当 draft_id）。"
                          "只想摆 3D 白模不动成片的话，用 stage_get_state / stage_control / split_novel_script，"
                          "它们直接作用于项目分镜，不需要 draft_id。")}
    return d


def _img_provider(d: OneKeyDraft) -> str:
    return d.image_provider or getattr(settings, "IMAGE_PROVIDER", "") or "comfyui"


def _img_edit_provider(d: OneKeyDraft) -> str:
    """图像编辑源（i2i）：多图合成分镜走这里；未单独配置时沿用生图源。"""
    return (d.image_edit_provider
            or getattr(settings, "IMAGE_EDIT_PROVIDER", "")
            or _img_provider(d))


def _vid_provider(d: OneKeyDraft) -> str:
    return d.video_provider or getattr(settings, "VIDEO_PROVIDER", "") or "comfyui_video"


def _aud_provider(d: OneKeyDraft) -> str:
    return d.audio_provider or getattr(settings, "TTS_PROVIDER", "") or "minimax"


# ── 角色资产复用 + 多参考装配 ─────────────────────────────
def _character_refs(c: Any, limit: int = 3) -> List[str]:
    """角色已有资产的多个视图（front/side/three_quarter/avatar）——多参考生成的素材来源。"""
    out: List[str] = []
    tv = getattr(c, "three_views", None)
    if isinstance(tv, dict):
        for k in ("front", "three_quarter", "side"):
            u = str(tv.get(k) or "").strip()
            if u and u not in out:
                out.append(u)
    avatar = str(getattr(c, "avatar_url", "") or "").strip()
    if avatar and avatar not in out:
        out.append(avatar)
    return out[: max(1, int(limit))]


def _role_ids(shot: Any) -> List[str]:
    ids = getattr(shot, "character_ids", None)
    return [str(x) for x in ids] if isinstance(ids, list) else []


def _mentioned_roles_by_ids(shot: Any, characters: List[Any]) -> List[Any]:
    """优先按 character_ids 精确匹配（前端绑定），其次按名字命中，最后回退全部（≤3）。"""
    ids = _role_ids(shot)
    if ids:
        by_id = [c for c in characters if str(getattr(c, "id", "")) in ids]
        if by_id:
            return by_id
    text = " ".join([
        str(getattr(shot, "action_desc", "") or ""),
        str(getattr(shot, "image_prompt", "") or ""),
        str(getattr(shot, "dialogue", "") or ""),
    ])
    hit = [c for c in characters if getattr(c, "name", "") and c.name in text]
    return hit if hit else list(characters)[:3]


def collect_shot_refs(shot: Any, characters: List[Any], scene: Any = None,
                      per_char: int = 3, total: int = 6) -> List[str]:
    """一镜的多参考图列表：**角色资产优先**（人物一致性第一优先），随后是场景参考图。

    去重 + 限总量；单槽源会由 _effective_refs 裁到前 N 张（角色优先，避免"只拿到场景没拿到角色"）。
    """
    refs: List[str] = []
    for c in _mentioned_roles_by_ids(shot, characters):
        for u in _character_refs(c, limit=per_char):
            if u not in refs:
                refs.append(u)
    scene_ref = str(getattr(scene, "ref_image_url", "") or "").strip() if scene is not None else ""
    if scene_ref and scene_ref not in refs:
        refs.append(scene_ref)
    return refs[: max(1, int(total))]


def _scene_of_shot(d: OneKeyDraft, shot: Any) -> Any:
    """按 shot.scene_index 找场景（用于场景参考图与道具）。"""
    try:
        si = int(getattr(shot, "scene_index", 1) or 1)
    except Exception:
        si = 1
    for sc in (getattr(d.project, "scenes", []) or []):
        try:
            if int(getattr(sc, "scene_index", 0) or 0) == si:
                return sc
        except Exception:
            continue
    return None


def _provider_image_slots(pid: str) -> Optional[int]:
    """provider 的图片输入槽数量；None = 无法判断（内置源/无定义，按支持处理）。

    只对能查到定义的源（自定义/ComfyUI 工作流）做硬判断：
    工作流是纯文生图（无 image 槽）时返回 0 —— 调用方必须显式告警而不是静默丢参考图。
    """
    try:
        from app.providers.custom.manager import custom_provider_manager
        d = custom_provider_manager.get_definition(pid)
    except Exception:
        return None
    if d is None:
        return None
    try:
        exposed = getattr(d, "workflow_exposed", None) or []
        if exposed:
            return sum(1 for e in exposed if isinstance(e, dict) and str(e.get("type") or "") == "image")
    except Exception:
        pass
    try:
        props = ((getattr(d, "input_schema", None) or {}).get("properties") or {})
        n = 0
        for v in props.values():
            if isinstance(v, dict) and (v.get("x-handle") == "image" or v.get("x-slot") == "reference_images"):
                n += 1
        return n
    except Exception:
        return None


def _ref_capability_warning(d: OneKeyDraft, pid: str, refs: List[str]) -> str:
    """视频源参考图不可用时的显式告警（空串=可用/无法判断）。

    图片源不再告警：资产生成与分镜画面本就允许纯文生图（用户口径），
    一致性由视频步的参考图保证；只有**视频源**丢参考图才是真实风险。
    """
    if not refs:
        return ""
    slots = _provider_image_slots(pid)
    if slots == 0:
        return (f"视频源「{pid}」无参考图槽位：本片成片一致性只能靠首帧画面，"
                f"角色/场景资产无法参与视频生成；请换用支持参考图/首帧+参考的视频源")
    return ""


def _image_ref_note(pid: str, slots: Optional[int]) -> str:
    """图片源参考图能力说明（信息级，非告警）。"""
    if slots == 0:
        return f"生图源「{pid}」为文生图：资产与分镜按文本+风格规范生成，一致性由视频参考步骤保证（正常流程）"
    if slots is not None:
        return f"生图源「{pid}」支持参考图（{slots} 槽）：分镜会附带角色/场景参考"
    return ""


def _style_suffix(d: OneKeyDraft) -> str:
    """风格规范后缀（生图/生视频统一附加；空则不附加）。"""
    spec = str(d.style_spec or "").strip()
    if not spec:
        return ""
    return f" [风格: {spec[:240]}]"


# ── 基础提示词兜底组合器（依据 prompt-basics 技能六要素）──────────
_FRAMING_EN = {
    "close_up": "close-up", "extreme_close_up": "extreme close-up", "medium": "medium shot",
    "full": "full shot", "long": "wide shot", "bird_eye": "bird's-eye view", "low_angle": "low-angle shot",
}
_MOTION_EN = {
    "static": "static camera", "push_in": "slow push-in", "pull_out": "slow pull-out",
    "pan_left": "pan left", "pan_right": "pan right", "tilt_up": "tilt up", "tilt_down": "tilt down",
    "orbit": "arc shot around the subject", "shake": "handheld camera",
}
_TIME_LIGHT = {
    "dawn": "soft dawn light", "morning": "soft morning light", "day": "natural daylight",
    "noon": "bright midday sunlight", "dusk": "warm golden-hour light", "evening": "dusky evening light",
    "night": "cool moonlight with practical lights",
}


def _compose_base_video_prompt(d: OneKeyDraft, shot: Any, scene: Any = None) -> str:
    """按 prompt-basics 六要素组装基础视频提示词（Agent 未给 prompt_override / 草稿无 video_prompt 时的兜底）。

    六要素：主体 Subject + 动作 Action + 环境 Setting + 光线 Lighting + 运镜 Camera + 风格 Style。
    i2v（已有首帧）遵循"只写动作与运镜变化，不重复画面"；r2v 显式点明"与参考图同一角色/场景"。
    """
    chars = _mentioned_roles_by_ids(shot, getattr(d.project, "characters", []) or [])
    has_first = bool(str(getattr(shot, "image_url", "") or "").strip())
    action = str(getattr(shot, "action_desc", "") or "").strip()
    subject = ""
    if chars:
        names = "、".join([str(getattr(c, "name", "") or "") for c in chars[:2] if getattr(c, "name", "")])
        if names:
            subject = f"{names}（与参考图同一角色）" if not has_first else names
    loc = time_of_day = atmosphere = ""
    props: List[str] = []
    if scene is not None:
        loc = str(getattr(scene, "location", "") or getattr(scene, "title", "") or "").strip()
        time_of_day = str(getattr(scene, "time_of_day", "") or "").strip().lower()
        atmosphere = str(getattr(scene, "atmosphere", "") or "").strip()
        props = [str(p) for p in (getattr(scene, "props", None) or []) if str(p).strip()][:4]
    head_bits = [x for x in (subject, action) if x]
    if loc:
        head_bits.append(f"场景：{loc}" + (f"（氛围：{atmosphere}）" if atmosphere else ""))
    if props:
        head_bits.append(f"（道具：{'、'.join(props)}）")
    head = "，".join(head_bits) or "静谧的画面，轻微的空气流动"
    lighting = _TIME_LIGHT.get(time_of_day, "cinematic lighting")
    framing = _FRAMING_EN.get(str(getattr(shot, "camera_framing", "") or ""), "")
    motion = _MOTION_EN.get(str(getattr(shot, "camera_motion", "") or ""), "")
    cam = "，".join([x for x in (framing, motion) if x]) or "static camera"
    parts = [f"{head}。{lighting}。镜头：{cam}。"]
    if has_first:
        parts.append("保持首帧画面的人物外观与场景一致，只表现动作与镜头运动。")
    spec = str(d.style_spec or "").strip()
    if spec:
        parts.append(f"Style: {spec[:240]}.")
    return " ".join(parts).strip()


async def _onekey_style_lock(d: OneKeyDraft, force: bool = False) -> Dict[str, Any]:
    """用大模型生成/固化全片统一风格规范（LLM 确保资产风格一致）。

    产出 `draft.style_spec`（英文风格 token 为主，供生图/生视频附加）；已有则复用，
    LLM 不可用时回退到画风预设内置 prompt，保证流程不被风格步骤卡死。
    """
    if d.style_spec and not force:
        return {"draft_id": d.id, "status": "already_locked", "style_spec": d.style_spec}
    from app.pipelines.script_agent import STYLE_PROMPTS
    preset_desc = STYLE_PROMPTS.get(d.style_preset, d.style_preset)
    fallback = f"{d.style_preset}; {preset_desc}".strip("; ")
    chars = []
    if d.project is not None:
        for c in (getattr(d.project, "characters", []) or [])[:12]:
            chars.append({
                "name": getattr(c, "name", ""),
                "visual_prompt": (getattr(c, "visual_prompt", "") or "")[:200],
            })
    spec = ""
    try:
        from app.pipelines.llm_service import llm_service
        data = await llm_service.chat_json(
            system_prompt=(
                "你是漫剧美术总监。你的任务是把全片视觉风格固化成一条统一、可复用的英文风格规范，"
                "让所有角色资产与分镜画面保持一致（线条/上色/色彩/光影/材质/镜头语言同一套）。"
            ),
            user_prompt=(
                f"画风预设：{d.style_preset}（参考：{preset_desc}）\n"
                f"自定义要求：{d.custom_instructions or '无'}\n"
                f"已有角色描述：{chars if chars else '暂无'}\n\n"
                "输出 JSON：{\"style_spec\": \"<80~200 字符英文风格 token，逗号分隔，可直接拼进生图 prompt>\","
                " \"notes\": \"<一句话中文说明>\"}"
            ),
            temperature=0.3,
        )
        spec = str((data or {}).get("style_spec") or "").strip()
    except Exception:
        spec = ""
    d.style_spec = spec or fallback
    return {"draft_id": d.id, "status": "locked", "style_spec": d.style_spec,
            "source": "llm" if spec else "preset_fallback",
            "note": "该风格规范会自动附加到本片所有生图/生视频 prompt；如不满意可再次调用并 force=true 重写"}


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
    scene_brief = []
    for sc in (getattr(d.project, "scenes", []) or [])[:20]:
        scene_brief.append({
            "scene_index": getattr(sc, "scene_index", 0),
            "title": getattr(sc, "title", ""),
            "location": getattr(sc, "location", ""),
            "props": list(getattr(sc, "props", []) or [])[:6],
            "has_ref": bool(str(getattr(sc, "ref_image_url", "") or "").strip()),
        })
    return {
        "draft_id": d.id, "status": "split_done",
        "characters": [{"name": getattr(c, "name", "?"), "role": getattr(c, "role", ""),
                        "gender": getattr(c, "gender", "")} for c in chars],
        "total_shots": len(shots),
        "shots": shot_brief,
        "scenes": scene_brief,
        "note": "简化流程：资产优先复用；缺失角色用 onekey_role_image、缺失场景用 onekey_scene_image；"
                "然后**直接逐镜 onekey_shot_video 参考生视频（r2v：角色多视图+场景参考）**，无需先生成分镜画面；"
                "同质任务用 subagent_run 的 batch 并行推进",
    }


async def _onekey_role_image(d: OneKeyDraft, character: str, force: bool = False) -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    c = d.find_character(character)
    if c is None:
        return {"error": f"角色不存在: {character}"}
    # 直接使用角色资产：已有视图（三视图/形象）即复用，不重复定妆（force=true 才重做）
    if not force:
        exist = _character_refs(c, limit=3)
        if exist:
            if character not in d.assets_reused:
                d.assets_reused.append(character)
            return {"draft_id": d.id, "character": character, "status": "reused",
                    "image_url": exist[0], "views": exist, "views_count": len(exist),
                    "note": "直接复用已有角色资产（多视图将作为后续多参考生成的素材）；需要重做定妆时传 force=true"}
    if not d.style_spec:
        await _onekey_style_lock(d)
    from app.providers.image.base import ImageGenerateRequest
    from app.pipelines.unified_orchestrator import _get_image_registry
    base = getattr(c, "visual_prompt", "") or f"1person, {getattr(c, 'name', '')}, {getattr(c, 'description', '')}"
    # 行业标准角色表：正面 + 侧面 + 3/4 三视图同图，供多参考锁定一致性
    sheet_prompt = (
        f"{base}, character reference sheet, three full-body views of the SAME character in one image: "
        f"front view on the left, side profile view in the middle, three-quarter view on the right, "
        f"identical face, hairstyle and outfit across all views, same horizontal line, plain white background, "
        f"no text, no watermark, full body, high detail turnaround{_style_suffix(d)}"
    )
    req = ImageGenerateRequest(prompt=sheet_prompt, aspect_ratio="16:9", style_preset=d.style_preset)
    res = await _get_image_registry().generate(req, provider_id=_img_provider(d))
    c.three_views = {"front": res.image_url, "three_quarter": res.image_url, "side": res.image_url}
    if not getattr(c, "avatar_url", ""):
        c.avatar_url = res.image_url
    return {"draft_id": d.id, "character": character, "image_url": res.image_url,
            "provider": getattr(res, "provider", ""), "status": "done",
            "style_locked": bool(d.style_spec)}


async def _onekey_scene_image(d: OneKeyDraft, scene_index: int, force: bool = False) -> Dict[str, Any]:
    """场景资产：为该场景生成【无人空镜参考图】（含关键道具），供分镜多参考保持空间一致。"""
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    scene = None
    try:
        si = int(scene_index)
    except Exception:
        si = -1
    for sc in (getattr(d.project, "scenes", []) or []):
        if int(getattr(sc, "scene_index", 0) or 0) == si:
            scene = sc
            break
    if scene is None:
        return {"error": f"场景不存在: #{scene_index}"}
    exist = str(getattr(scene, "ref_image_url", "") or "").strip()
    if exist and not force:
        return {"draft_id": d.id, "scene_index": si, "status": "reused", "image_url": exist,
                "note": "场景参考图已存在，直接复用（force=true 可重生成）"}
    if not d.style_spec:
        await _onekey_style_lock(d)
    from app.providers.image.base import ImageGenerateRequest
    from app.pipelines.unified_orchestrator import _get_image_registry
    props = [str(x) for x in (getattr(scene, "props", None) or []) if str(x).strip()]
    base = (getattr(scene, "image_prompt", "") or "").strip()
    if not base:
        base = ", ".join([x for x in [
            str(getattr(scene, "title", "") or ""),
            str(getattr(scene, "location", "") or ""),
            str(getattr(scene, "time_of_day", "") or ""),
            str(getattr(scene, "atmosphere", "") or ""),
        ] if x])
    if props:
        base = f"{base}, key props: {', '.join(props[:5])}"
    prompt = (f"{base}, EMPTY environment scene, no people, no characters, no text, "
              f"establishing shot background plate{_style_suffix(d)}")
    req = ImageGenerateRequest(prompt=prompt, negative_prompt="people, humans, characters, text, watermark",
                               aspect_ratio=d.aspect_ratio, style_preset=d.style_preset,
                               workflow_id=d.image_workflow_id or None)
    res = await _get_image_registry().generate(req, provider_id=_img_provider(d))
    scene.ref_image_url = res.image_url
    return {"draft_id": d.id, "scene_index": si, "image_url": res.image_url, "props": props,
            "provider": getattr(res, "provider", ""), "status": "done",
            "style_locked": bool(d.style_spec)}


def _image_capabilities(pid: str) -> Optional[set]:
    """图像源的声明能力（t2i/i2i/reference）；查不到（内置源未声明）返回 None。

    仅用于「多图合成分镜」时的能力提示：编辑源未声明 i2i/reference 时给出告警，
    而不是静默按文生图处理。
    """
    try:
        from app.providers.custom.manager import custom_provider_manager
        d = custom_provider_manager.get_definition(pid)
    except Exception:
        return None
    if d is None:
        return None
    caps = getattr(d, "capabilities", None) or []
    return {str(c) for c in caps if str(c).strip()} or None


def _effective_refs(pid: str, refs: List[str]) -> "tuple[List[str], Optional[int]]":
    """按 provider 的图片输入槽数量裁剪参考图，返回 (真正生效的列表, 槽位数)。

    - 槽位未知（内置 API 源）：原样返回；
    - 槽位=0（纯文生图）：返回空（调用方必须先告警，不允许假装用了参考）；
    - 槽位<N：只前 N 张生效（ComfyUI 单槽工作流只能吃 1 张，必须在结果里如实标注）。
    """
    if not refs:
        return [], None
    slots = _provider_image_slots(pid)
    if slots is None:
        return list(refs), None
    if slots <= 0:
        return [], 0
    return list(refs[:slots]), slots


async def _onekey_shot_image(d: OneKeyDraft, shot_index: int, prompt_override: str = "") -> Dict[str, Any]:
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    shot = d.find_shot(shot_index)
    if shot is None:
        return {"error": f"分镜不存在: #{shot_index}"}
    from app.pipelines.unified_orchestrator import _camera_suffix, _get_image_registry
    from app.providers.image.base import ImageGenerateRequest
    characters = getattr(d.project, "characters", []) or []
    scene = _scene_of_shot(d, shot)
    roles = _mentioned_roles_by_ids(shot, characters)
    tags = " ".join(f"[角色: {getattr(r, 'name', '')}]" for r in roles)
    base_prompt = prompt_override or getattr(shot, "image_prompt", "") or getattr(shot, "action_desc", "") or "cinematic anime scene"
    if tags and not any(getattr(r, "name", "") in base_prompt for r in roles):
        base_prompt = f"{tags} {base_prompt}"
    if scene is not None and (getattr(scene, "props", None) or []):
        props = [str(x) for x in scene.props if str(x).strip()][:5]
        if props and "props:" not in base_prompt.lower():
            base_prompt = f"{base_prompt}, scene props: {', '.join(props)}"
    cam = _camera_suffix(shot)
    if cam and "[运镜:" not in base_prompt and "[Camera:" not in base_prompt:
        base_prompt = f"{base_prompt}{cam}"
    base_prompt = f"{base_prompt}{_style_suffix(d)}"
    # 多参考：角色资产优先 + 场景参考。分镜合成属于「图像编辑」（i2i）——
    # 用独立的编辑源（未配置时回落到生图源），三视图/场景空镜才用生成源（t2i）。
    refs = collect_shot_refs(shot, characters, scene=scene)
    pid = _img_edit_provider(d)
    slots: Optional[int] = None
    refs, slots = _effective_refs(pid, refs)
    img_note = _image_ref_note(pid, slots)
    req = ImageGenerateRequest(
        prompt=base_prompt, negative_prompt="", aspect_ratio=d.aspect_ratio,
        style_preset=d.style_preset, workflow_id=d.image_workflow_id or None,
        reference_images=refs or None,
        dynamic_inputs={"reference_images": refs} if refs else None,
    )
    res = await _get_image_registry().generate(req, provider_id=pid)
    shot.image_url = res.image_url
    shot.status = "completed"
    out = {"draft_id": d.id, "shot_index": shot_index, "image_url": res.image_url,
           "provider": getattr(res, "provider", ""), "status": "done",
           "engine_role": "edit" if pid != _img_provider(d) else "generate",
           "refs_used": len(refs), "refs_slots": slots, "style_locked": bool(d.style_spec),
           "refs_detail": {
               "scene": bool(scene is not None and str(getattr(scene, "ref_image_url", "") or "").strip()
                             and str(getattr(scene, "ref_image_url", "")) in refs),
               "characters": [getattr(r, "name", "") for r in roles],
           }}
    if refs:
        caps = _image_capabilities(pid)
        if caps is not None and not ({"i2i", "reference"} & caps):
            warn = (f"图像编辑源「{pid}」未声明 i2i/reference 能力：多图合成分镜可能退化为文生图。"
                    f"请在「设置→生成源」把该源能力标为图生图/参考生图，或另配一个图像编辑源")
            out["warning"] = warn
            if warn not in d.ref_warnings:
                d.ref_warnings.append(warn)
    if img_note:
        out["note"] = img_note
    return out


async def _onekey_shot_video(d: OneKeyDraft, shot_index: int, prompt_override: str = "") -> Dict[str, Any]:
    """逐镜生成视频。

    - 该镜已有画面（关键帧模式）→ i2v：首帧；H3 不允许首尾帧与参考素材混用；
    - 无画面（默认）→ **r2v 参考生视频**：直接用角色多视图 + 场景参考；
    - prompt_override：Agent 自写/改写后的视频提示词（如按 minimax-h3-prompt 技能的三字段结构），
      原样作为基础提示词；已含运镜/风格/H3 字段时不再自动追加后缀。
    """
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    if not d.enable_video:
        return {"error": "本任务未开启视频生成"}
    shot = d.find_shot(shot_index)
    if shot is None:
        return {"error": f"分镜不存在: #{shot_index}"}
    first = getattr(shot, "image_url", "")
    mode = "i2v" if first else "r2v"   # 有画面→首帧驱动；无画面→直接用资产参考生视频
    from app.pipelines.unified_orchestrator import _camera_suffix, _get_video_registry
    from app.providers.video.base import VideoGenerateRequest
    characters = getattr(d.project, "characters", []) or []
    scene = _scene_of_shot(d, shot)
    refs = collect_shot_refs(shot, characters, scene=scene)
    if not first and not refs:
        return {"error": f"分镜 #{shot_index} 既没有画面也没有可用资产参考（请先生成角色/场景资产）"}
    _v_warn = _ref_capability_warning(d, _vid_provider(d), refs)
    _v_slots = _provider_image_slots(_vid_provider(d))
    _v_note = ""
    if _v_warn:
        if _v_warn not in d.ref_warnings:
            d.ref_warnings.append(_v_warn)
        refs = []
    elif mode == "i2v" and _v_slots is not None and _v_slots <= 1:
        # i2v 单图片槽：该槽被首帧占用，参考图无法同时塞入 → 明确跳过并说明
        refs = []
        _v_note = (f"视频源「{_vid_provider(d)}」只有 {_v_slots} 个图片槽（首帧专用）："
                   f"角色/场景参考未传，一致性依赖首帧画面；需多参考请用支持首帧+参考多槽的视频源")
    else:
        refs, _ = _effective_refs(_vid_provider(d), refs)
    override = str(prompt_override or "").strip()
    if override:
        vprompt = override
        cam = _camera_suffix(shot)
        low = vprompt.lower()
        if cam and "[运镜:" not in vprompt and "[Camera:" not in vprompt and "camera" not in low:
            vprompt = f"{vprompt}{cam}"
        # H3 结构化提示词（自带风格/声场）不再追加风格后缀，避免破坏三段结构
        if "integrated_multimodal_description" not in low:
            vprompt = f"{vprompt}{_style_suffix(d)}"
    else:
        base = str(getattr(shot, "video_prompt", "") or "").strip()
        if base:
            vprompt = base
            cam = _camera_suffix(shot)
            if cam and "[运镜:" not in vprompt and "[Camera:" not in vprompt:
                vprompt = f"{vprompt}{cam}"
            vprompt = f"{vprompt}{_style_suffix(d)}"
        else:
            # 兜底：按 prompt-basics 六要素组装（主体+动作+环境+光线+运镜+风格），
            # 而不是直接拿 action_desc 一句简单词去生成。
            vprompt = _compose_base_video_prompt(d, shot, scene)
    previz_vid = (getattr(shot, "previz_video_url", "") or "").strip()
    req = VideoGenerateRequest(
        prompt=vprompt or "cinematic camera move", mode=mode, first_frame_url=first or None,
        reference_images=refs or None,
        dynamic_inputs={"reference_images": refs} if refs else None,
        reference_videos=[previz_vid] if previz_vid else None,
        duration=int(getattr(shot, "duration", 0) or 5),
        aspect_ratio=d.aspect_ratio, workflow_id=d.video_workflow_id or None,
    )
    res = await _get_video_registry().generate(req, provider_id=_vid_provider(d))
    _ref_info = {"mode": mode, "refs_used": len(refs), "refs_slots": _v_slots}
    if _v_note:
        _ref_info["note"] = _v_note
    if _v_warn:
        _ref_info["warning"] = _v_warn
    if getattr(res, "video_url", ""):
        shot.video_url = res.video_url
        return {"draft_id": d.id, "shot_index": shot_index, "video_url": res.video_url,
                "provider": getattr(res, "provider", ""), "status": "done", **_ref_info}
    if getattr(res, "task_id", ""):
        tid = str(res.task_id)
        d.video_pending.append({"shot_index": shot_index, "task_id": tid})
        _register_pending_video(d, shot_index, tid)
        return {"draft_id": d.id, "shot_index": shot_index, "task_id": tid,
                "status": "submitted",
                "note": "异步生成中，已接入统一任务轮询（task_status/task_wait 可查，完成后自动写回草稿）",
                **_ref_info}
    return {"error": f"分镜 #{shot_index} 视频无结果返回"}


def _register_pending_video(d: OneKeyDraft, shot_index: int, task_id: str) -> None:
    """异步视频任务接入 TaskCenter + watcher：完成后自动把成片写回草稿（含下载落盘）。"""
    try:
        from app.providers.tasks import task_center
        task_center.register(str(task_id), _vid_provider(d), "video",
                             request={"shot_index": shot_index}, session_id=f"onekey_{d.id}")
    except Exception:
        pass
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    tid = str(task_id)
    if tid in _VIDEO_WATCHERS:
        return
    _VIDEO_WATCHERS.add(tid)
    draft_id = d.id

    async def _runner() -> None:
        try:
            from app.providers.tasks import task_center as _tc
            rec = await _tc.wait(tid, timeout_s=float(os.environ.get("ONEKEY_VIDEO_WAIT_S") or 2400))
            _apply_video_settle(draft_id, shot_index, tid, rec)
        except Exception:
            pass
        finally:
            _VIDEO_WATCHERS.discard(tid)

    loop.create_task(_runner())


def _apply_video_settle(draft_id: str, shot_index: int, task_id: str, rec: Any) -> None:
    """把已落定的异步视频写回草稿：成功→video_url；终态失败→video_fail。"""
    d = get_draft(draft_id)
    if d is None:
        return
    tid = str(task_id)
    url = str(getattr(rec, "video_url", "") or "")
    if url:
        shot = d.find_shot(shot_index)
        if shot is not None:
            shot.video_url = url
        d.video_pending = [p for p in d.video_pending if str(p.get("task_id") or "") != tid]
        return
    if str(getattr(rec, "status", "") or "").upper() in ("FAILED", "TIMEOUT", "CANCELLED"):
        err = str(getattr(rec, "error", "") or getattr(rec, "status", "") or "未知错误")
        d.video_pending = [p for p in d.video_pending if str(p.get("task_id") or "") != tid]
        d.video_fail.append({"shot_index": shot_index, "task_id": tid, "error": err[:300]})


def _sync_pending_videos(d: OneKeyDraft) -> None:
    """懒同步：把已落定的 pending 写回草稿（watcher 未跑/异常时的兜底，summary/export 前调用）。"""
    if not d.video_pending:
        return
    try:
        from app.providers.tasks import task_center
    except Exception:
        return
    for p in list(d.video_pending):
        tid = str(p.get("task_id") or "")
        if not tid:
            continue
        try:
            rec = task_center.status(tid)
        except Exception:
            rec = None
        if rec is not None and getattr(rec, "terminal", False):
            _apply_video_settle(d.id, int(p.get("shot_index") or 0), tid, rec)


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
    _sync_pending_videos(d)
    from app.pipelines.jianyin_exporter import jianyin_exporter, DraftExportError
    try:
        res = await jianyin_exporter.export_project_to_jianyin_draft_async(d.project)
        d.export_result = res or {}
        out = {"draft_id": d.id, "status": "done", **(d.export_result or {})}
        if d.video_pending:
            out["pending_videos"] = len(d.video_pending)
            out["note"] = f"仍有 {len(d.video_pending)} 镜视频生成中（未入轨，导出前会自动再同步一次）"
        return out
    except DraftExportError as e:
        return {"error": f"导出中止: {e}"}


def _onekey_summary(d: OneKeyDraft) -> Dict[str, Any]:
    if d.project is None:
        return {"draft_id": d.id, "status": "created", "note": "尚未拆解"}
    _sync_pending_videos(d)
    shots = d.all_shots()
    img_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "image_url", "")]
    vid_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "video_url", "")]
    voice_needed = [getattr(s, "shot_index", 0) for s in shots if (getattr(s, "dialogue", "") or getattr(s, "voiceover", ""))]
    voice_done = [getattr(s, "shot_index", 0) for s in shots if getattr(s, "audio_url", "")]
    chars = getattr(d.project, "characters", []) or []
    char_ready = [getattr(c, "name", "") for c in chars if (getattr(c, "three_views", None) or {}).get("front") or getattr(c, "avatar_url", "")]
    scenes = getattr(d.project, "scenes", []) or []
    scene_ready = [getattr(sc, "scene_index", 0) for sc in scenes if str(getattr(sc, "ref_image_url", "") or "").strip()]
    async_idx = [p.get("shot_index") for p in d.video_pending]
    return {
        "draft_id": d.id, "status": "running",
        "style": {"locked": bool(d.style_spec), "style_spec": d.style_spec or "", "assets_reused": d.assets_reused},
        "sources": {
            "image_generate": _img_provider(d),   # 定妆三视图 / 场景空镜（t2i）
            "image_edit": _img_edit_provider(d),  # 多图合成分镜（i2i）
            "video": _vid_provider(d),
            "audio": _aud_provider(d),
        },
        "ref_warnings": d.ref_warnings[-3:],
        "characters": {"total": len(chars), "ready": len(char_ready), "pending": [getattr(c, "name", "") for c in chars if getattr(c, "name", "") not in char_ready]},
        "scenes": {"total": len(scenes), "ready": len(scene_ready),
                   "pending": [getattr(sc, "scene_index", 0) for sc in scenes if getattr(sc, "scene_index", 0) not in scene_ready]},
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


def _onekey_review(d: OneKeyDraft, scope: str = "all", limit: int = 10) -> Dict[str, Any]:
    """产物验收清单：给产物 URL + 验收要点（requirement/criteria）→ 模型用 view_media 看后判定。

    生成的图片/视频**必须检查**（角色一致性/风格/动作是否达标），不合格重做。
    """
    if d.project is None:
        return {"error": "尚未拆解（先调用 onekey_split）"}
    scope = (scope or "all").strip().lower()
    limit = max(1, min(int(limit or 10), 30))
    items: List[Dict[str, Any]] = []
    characters = getattr(d.project, "characters", []) or []
    scenes = getattr(d.project, "scenes", []) or []
    if scope in ("all", "characters"):
        for c in characters:
            refs = _character_refs(c, limit=3)
            if not refs:
                continue
            items.append({
                "kind": "character", "id": getattr(c, "name", ""), "ref": refs[0], "refs": refs,
                "requirement": (getattr(c, "visual_prompt", "") or getattr(c, "description", "")
                                or getattr(c, "name", ""))[:300],
                "criteria": "三视图为同一角色；性别/年龄/发型/服饰/气质与设定一致；画风与全片风格规范一致",
            })
    if scope in ("all", "scenes"):
        for sc in scenes:
            ref = str(getattr(sc, "ref_image_url", "") or "").strip()
            if not ref:
                continue
            props = getattr(sc, "props", None) or []
            req = str(getattr(sc, "image_prompt", "") or "")
            if props:
                req = (req + "；关键道具：" + "、".join([str(p) for p in props if p])) if req else ("关键道具：" + "、".join([str(p) for p in props if p]))
            items.append({
                "kind": "scene", "id": getattr(sc, "scene_index", 0), "ref": ref, "refs": [ref],
                "requirement": req[:300],
                "criteria": "空镜符合场景描述/时间/氛围；关键道具在场；与角色资产画风一致",
            })
    if scope in ("all", "shots"):
        for s in d.all_shots():
            ref = str(getattr(s, "video_url", "") or "").strip()
            kind = "shot_video"
            if not ref:
                ref = str(getattr(s, "image_url", "") or "").strip()
                kind = "shot_image"
            if not ref:
                continue
            refs = collect_shot_refs(s, characters, scene=_scene_of_shot(d, s), total=3)
            items.append({
                "kind": kind, "id": getattr(s, "shot_index", 0), "ref": ref, "refs": refs,
                "requirement": (getattr(s, "action_desc", "") or getattr(s, "video_prompt", "") or "")[:300],
                "criteria": ("视频：动作与描述一致、运镜符合、角色与参考资产一致、无崩坏/闪烁；"
                             "时长/画幅正常" if kind == "shot_video" else "画面符合动作与景别、角色与参考一致"),
            })
    counts = {
        "characters": sum(1 for i in items if i["kind"] == "character"),
        "scenes": sum(1 for i in items if i["kind"] == "scene"),
        "shot_videos": sum(1 for i in items if i["kind"] == "shot_video"),
        "shot_images": sum(1 for i in items if i["kind"] == "shot_image"),
    }
    return {
        "draft_id": d.id, "scope": scope,
        "style_spec": d.style_spec or "",
        "pending_videos": [p.get("shot_index") for p in d.video_pending],
        "how_to": ("逐项 view_media(urls=[item.ref] + item.refs[:2]) 观看后对照 requirement/criteria 判定 "
                   "pass/fail；不合格：调整 prompt 重做（character/scene 传 force=true；视频重新 onekey_shot_video）；"
                   "视频会自动抽帧成图片，可直接查看"),
        "counts": counts,
        "items": items[:limit],
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
        if name == "onekey_style_lock":
            return await _onekey_style_lock(d, force=bool(args.get("force")))
        if name == "onekey_scene_image":
            return await _onekey_scene_image(d, int(args.get("scene_index") or 0), force=bool(args.get("force")))
        if name == "onekey_role_image":
            return await _onekey_role_image(d, str(args.get("character") or "").strip(),
                                            force=bool(args.get("force")))
        if name == "onekey_shot_image":
            return await _onekey_shot_image(d, int(args.get("shot_index") or 0), str(args.get("prompt_override") or ""))
        if name == "onekey_shot_video":
            return await _onekey_shot_video(d, int(args.get("shot_index") or 0),
                                            str(args.get("prompt_override") or ""))
        if name == "onekey_shot_voice":
            return await _onekey_shot_voice(d, int(args.get("shot_index") or 0))
        if name == "onekey_export":
            return await _onekey_export(d)
        if name == "onekey_summary":
            return _onekey_summary(d)
        if name == "onekey_review":
            return _onekey_review(d, str(args.get("scope") or "all"), int(args.get("limit") or 10))
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
    scenes = getattr(d.project, "scenes", []) or []
    return {
        "summary": {
            "characters": len(chars),
            "roles_designed": sum(1 for c in chars if (getattr(c, "three_views", None) or {}).get("front")),
            "scenes": len(scenes),
            "scenes_ready": sum(1 for sc in scenes if str(getattr(sc, "ref_image_url", "") or "").strip()),
            "total_shots": len(shots),
            "images_generated": img_ok, "images_failed": len(d.image_fail),
            "videos_generated": vid_ok, "videos_failed": len(d.video_fail),
            "videos_pending": len(d.video_pending),
            "tts_generated": voice_ok, "tts_skipped_or_failed": len(d.voice_fail),
            "draft_exported": bool(d.export_result and not d.export_result.get("error")),
            "style_locked": bool(d.style_spec),
            "assets_reused": len(d.assets_reused),
        },
        "ref_warnings": d.ref_warnings[-3:],
        "project": d.project.model_dump() if d.project is not None else None,
        "jianyin_draft": d.export_result or {},
        "image_errors": d.image_fail,
        "video_errors": d.video_fail,
        "videos_pending": d.video_pending,
    }
