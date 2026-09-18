"""
漫剧全链路真实编排器 - 动态Provider版（一键成片 Agent v2）
Stage 1: MiniMax LLM 小说拆解
Stage 2: 角色资产（一致性三视图正面，用于全链路身份约束）
Stage 3: 动态图片Provider批量生图（角色参考 + 相机意图装配）
Stage 4: 动态视频Provider批量图生视频（首帧 + 角色参考 + 运镜提示）
Stage 5: 动态音频Provider台词配音
Stage 6: pyJianYingDraft 剪映草稿导出
"""
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.models.schemas import Project
from app.pipelines.script_agent import script_agent
from app.pipelines.jianyin_exporter import jianyin_exporter, DraftExportError
from app.core.config import settings

ProgressCallback = Callable[[Dict[str, Any]], Awaitable[None]]


def _get_image_registry():
    from app.providers.image.registry import image_registry
    if not image_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return image_registry

def _get_audio_registry():
    from app.providers.audio.registry import audio_registry
    if not audio_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return audio_registry

def _get_video_registry():
    from app.providers.video.registry import video_registry
    if not video_registry.list_ids():
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    return video_registry


def _camera_suffix(shot) -> str:
    """分镜自身景别/运镜转提示词后缀（与前端 withCameraIntent 同口径）"""
    framing = getattr(shot, "camera_framing", "") or ""
    motion = getattr(shot, "camera_motion", "") or ""
    parts = [p for p in (framing, motion) if p]
    if not parts:
        return ""
    return " [运镜: " + " · ".join(parts) + "]"


def _mentioned_roles(shot, characters):
    """分镜文本中提及的角色（按名匹配），未提及则回退全部（最多3个）"""
    text = " ".join([
        str(getattr(shot, "action_desc", "") or ""),
        str(getattr(shot, "image_prompt", "") or ""),
        str(getattr(shot, "dialogue", "") or ""),
    ])
    hit = [c for c in characters if getattr(c, "name", "") and c.name in text]
    return hit if hit else list(characters)[:3]


def _role_front(c) -> str:
    tv = getattr(c, "three_views", None) or {}
    if isinstance(tv, dict):
        return tv.get("front") or tv.get("three_quarter") or getattr(c, "avatar_url", "") or ""
    return getattr(c, "avatar_url", "") or ""


class UnifiedDramaPipeline:

    def __init__(self):
        self._stage_logs: List[Dict[str, Any]] = []

    async def _log(self, stage: str, message: str, progress_cb: Optional[ProgressCallback] = None, **extra: Any):
        entry = {"stage": stage, "message": message, "time_ms": int(time.time() * 1000), **extra}
        self._stage_logs.append(entry)
        if progress_cb:
            try:
                await progress_cb(entry)
            except Exception:
                pass

    async def execute_full_pipeline(
        self,
        novel_text: str,
        style_preset: str = "donghua_xianxia",
        aspect_ratio: str = "9:16",
        custom_instructions: str = "",
        max_images: int = 12,
        image_provider: Optional[str] = None,
        image_workflow_id: Optional[str] = None,
        audio_provider: Optional[str] = None,
        # ---- v2 一键成片新增 ----
        video_provider: Optional[str] = None,
        video_workflow_id: Optional[str] = None,
        enable_video: bool = True,
        max_videos: int = 6,
        gen_roles: bool = True,
        max_roles: int = 4,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> Dict[str, Any]:
        started = time.time()
        self._stage_logs = []

        # ============ Stage 1: LLM 小说拆解 ============
        await self._log("Stage 1 · 剧本拆解", "调用 LLM 拆解小说为角色与分镜序列...", progress_cb)
        t1 = time.time()
        project: Project = await script_agent.parse_novel_to_project(
            novel_text, style_preset, aspect_ratio, custom_instructions
        )
        all_shots = [sh for sc in project.scenes for sh in sc.shots]
        await self._log(
            "Stage 1 · 剧本拆解", f"拆解完成：{len(project.characters)} 个角色 / {len(all_shots)} 个分镜",
            progress_cb, elapsed_ms=int((time.time() - t1) * 1000),
        )

        # ============ Stage 2: 角色资产（三视图正面，全链路身份约束） ============
        img_prov_id = image_provider or getattr(settings, "IMAGE_PROVIDER", "comfyui")
        role_ok, role_fail = 0, []
        if gen_roles and project.characters:
            await self._log("Stage 2 · 角色资产", f"为前 {min(max_roles, len(project.characters))} 个角色生成三视图正面...", progress_cb)
            t15 = time.time()
            try:
                from app.pipelines.consistency_engine import consistency_engine
                from app.providers.image.base import ImageGenerateRequest as RoleImgReq
                img_reg0 = _get_image_registry()
                for c in project.characters[:max_roles]:
                    try:
                        prompts = consistency_engine.build_character_3views_prompts(c, style_preset)
                        front_prompt = (prompts or {}).get("front") or next(iter((prompts or {}).values()), "")
                        if not front_prompt:
                            continue
                        rreq = RoleImgReq(prompt=front_prompt, aspect_ratio="1:1", style_preset=style_preset)
                        rres = await img_reg0.generate(rreq, provider_id=img_prov_id)
                        c.three_views = {"front": rres.image_url}
                        role_ok += 1
                        await self._log("Stage 2 · 角色资产", f"角色 {c.name} 定妆完成", progress_cb, image_url=rres.image_url)
                    except Exception as e:
                        role_fail.append({"character": getattr(c, "name", "?"), "error": str(e)})
                        await self._log("Stage 2 · 角色资产", f"角色 {getattr(c, 'name', '?')} 定妆失败: {e}", progress_cb)
            except Exception as e:
                await self._log("Stage 2 · 角色资产", f"角色资产阶段跳过: {e}", progress_cb)
            await self._log("Stage 2 · 角色资产", f"定妆完成：成功 {role_ok} / 失败 {len(role_fail)}", progress_cb, elapsed_ms=int((time.time() - t15) * 1000))
        else:
            await self._log("Stage 2 · 角色资产", "已跳过（关闭或无角色）", progress_cb)

        # ============ Stage 3: 动态生图（角色参考 + 相机意图） ============
        await self._log("Stage 3 · 生图", f"开始为分镜生成画面（Provider={img_prov_id}，最多 {max_images} 镜）...", progress_cb)
        t2 = time.time()
        image_ok, image_fail = 0, []
        targets = [sh for sc in project.scenes for sh in sc.shots][:max_images]
        try:
            img_reg = _get_image_registry()
            prov = img_reg.get(img_prov_id)
            prov_name = prov.display_name if prov else img_prov_id
        except Exception:
            prov_name = img_prov_id

        for idx, shot in enumerate(targets):
            try:
                from app.providers.image.base import ImageGenerateRequest
                roles = _mentioned_roles(shot, project.characters)
                tags = " ".join(f"[角色: {c.name}]" for c in roles)
                base_prompt = shot.image_prompt or shot.action_desc or "cinematic anime scene"
                if tags and not any(c.name in base_prompt for c in roles):
                    base_prompt = f"{tags} {base_prompt}"
                cam = _camera_suffix(shot)
                if cam and "[运镜:" not in base_prompt and "[Camera:" not in base_prompt:
                    base_prompt = f"{base_prompt}{cam}"
                refs = [u for u in (_role_front(c) for c in roles) if u]
                req = ImageGenerateRequest(
                    prompt=base_prompt,
                    negative_prompt="",
                    aspect_ratio=aspect_ratio,
                    style_preset=style_preset,
                    workflow_id=image_workflow_id,
                    dynamic_inputs={"reference_images": refs} if refs else None,
                )
                reg = _get_image_registry()
                res = await reg.generate(req, provider_id=img_prov_id)
                shot.image_url = res.image_url
                shot.status = "completed"
                image_ok += 1
                await self._log(
                    "Stage 3 · 生图",
                    f"分镜 #{shot.shot_index} 生图完成 ({res.provider}:{res.elapsed_ms}ms)",
                    progress_cb, shot_index=shot.shot_index, image_url=res.image_url, provider=res.provider,
                )
            except Exception as e:
                shot.status = "error"
                image_fail.append({"shot_index": shot.shot_index, "error": str(e)})
                await self._log("Stage 3 · 生图", f"分镜 #{shot.shot_index} 生图失败: {e}", progress_cb)
                if "无法连接" in str(e) and idx == 0:
                    # 首镜即不可达，提示用户切换Provider
                    await self._log("Stage 3 · 生图", f"提示：{img_prov_id} 不可用，可尝试切换 siliconflow/dashscope 或检查 ComfyUI", progress_cb)
                    break
        await self._log(
            "Stage 3 · 生图", f"生图完成：成功 {image_ok} / 失败 {len(image_fail)} (Provider: {prov_name})",
            progress_cb, elapsed_ms=int((time.time() - t2) * 1000),
        )

        # ============ Stage 4: 图生视频（首帧 + 角色参考 + 运镜） ============
        vid_prov_id = video_provider or getattr(settings, "VIDEO_PROVIDER", "comfyui_video")
        video_ok, video_fail, video_pending = 0, [], []
        if enable_video:
            vtargets = [sh for sh in targets if getattr(sh, "image_url", "")]
            vtargets = vtargets[:max_videos]
            await self._log("Stage 4 · 视频", f"开始图生视频（Provider={vid_prov_id}，最多 {max_videos} 镜）...", progress_cb)
            t4 = time.time()
            try:
                from app.providers.video.base import VideoGenerateRequest
                vid_reg = _get_video_registry()
                vprov = vid_reg.get(vid_prov_id)
                vprov_name = vprov.display_name if vprov else vid_prov_id
            except Exception:
                vprov_name = vid_prov_id
            for shot in vtargets:
                try:
                    roles = _mentioned_roles(shot, project.characters)
                    refs = [u for u in (_role_front(c) for c in roles) if u]
                    vprompt = getattr(shot, "video_prompt", "") or shot.action_desc or ""
                    cam = _camera_suffix(shot)
                    if cam and "[运镜:" not in vprompt and "[Camera:" not in vprompt:
                        vprompt = f"{vprompt}{cam}"
                    vreq = VideoGenerateRequest(
                        prompt=vprompt or "cinematic camera move",
                        mode="i2v",
                        first_frame_url=shot.image_url,
                        reference_images=refs or None,
                        duration=int(getattr(shot, "duration", 0) or 5),
                        aspect_ratio=aspect_ratio,
                        workflow_id=video_workflow_id,
                    )
                    vres = await vid_reg.generate(vreq, provider_id=vid_prov_id)
                    if getattr(vres, "video_url", ""):
                        shot.video_url = vres.video_url
                        video_ok += 1
                        await self._log("Stage 4 · 视频", f"分镜 #{shot.shot_index} 视频完成 ({vres.provider})", progress_cb, shot_index=shot.shot_index, video_url=vres.video_url)
                    elif getattr(vres, "task_id", ""):
                        video_pending.append({"shot_index": shot.shot_index, "task_id": vres.task_id})
                        await self._log("Stage 4 · 视频", f"分镜 #{shot.shot_index} 已提交异步任务 {vres.task_id}（成片后在分镜台轮询）", progress_cb, shot_index=shot.shot_index)
                    else:
                        video_fail.append({"shot_index": shot.shot_index, "error": "无 video_url/task_id 返回"})
                        await self._log("Stage 4 · 视频", f"分镜 #{shot.shot_index} 视频无结果返回", progress_cb)
                except Exception as e:
                    video_fail.append({"shot_index": shot.shot_index, "error": str(e)})
                    await self._log("Stage 4 · 视频", f"分镜 #{shot.shot_index} 视频失败: {e}", progress_cb)
            await self._log(
                "Stage 4 · 视频", f"视频完成：成功 {video_ok} / 失败 {len(video_fail)} / 异步 {len(video_pending)} (Provider: {vprov_name})",
                progress_cb, elapsed_ms=int((time.time() - t4) * 1000),
            )
        else:
            await self._log("Stage 4 · 视频", "已跳过（关闭）", progress_cb)

        # ============ Stage 5: 动态TTS ============
        aud_prov_id = audio_provider or getattr(settings, "TTS_PROVIDER", "minimax")
        tts_ok, tts_skipped = 0, 0
        # 检查是否有可用provider
        try:
            aud_reg = _get_audio_registry()
            prov = aud_reg.get(aud_prov_id)
            is_cfg = prov.is_configured() if prov else False
        except Exception:
            is_cfg = False

        if is_cfg:
            await self._log("Stage 5 · TTS 配音", f"为含台词分镜生成配音（Provider={aud_prov_id}）...", progress_cb)
            t3 = time.time()
            char_voice = {c.name: c.voice_id for c in project.characters}
            # 角色绑定的参考音频：优先作为音色克隆参考（支持克隆的源生效，其余源忽略该参数）
            char_ref = {c.name: (getattr(c, "ref_audio_url", "") or "") for c in project.characters}
            narrator_voice = next((c.voice_id for c in project.characters if c.role == "narrator"), "male-pangbai")
            narrator_ref = next((getattr(c, "ref_audio_url", "") or "" for c in project.characters if c.role == "narrator"), "")
            for shot in all_shots:
                line = shot.dialogue or shot.voiceover
                if not line:
                    continue
                voice_id = char_voice.get(shot.speaker_name or "", narrator_voice)
                ref_audio = char_ref.get(shot.speaker_name or "", narrator_ref)
                try:
                    from app.providers.audio.base import AudioGenerateRequest
                    areq = AudioGenerateRequest(text=line, voice_id=voice_id, emotion=shot.emotion,
                                                ref_audio_path=(ref_audio or None))
                    reg = _get_audio_registry()
                    res = await reg.generate(areq, provider_id=aud_prov_id)
                    shot.audio_url = res.audio_url
                    tts_ok += 1
                except Exception:
                    tts_skipped += 1
            await self._log(
                "Stage 5 · TTS 配音", f"配音完成：成功 {tts_ok} / 失败 {tts_skipped} (Provider: {aud_prov_id})",
                progress_cb, elapsed_ms=int((time.time() - t3) * 1000),
            )
        else:
            tts_skipped = sum(1 for sh in all_shots if sh.dialogue or sh.voiceover)
            await self._log(
                "Stage 5 · TTS 配音",
                f"已跳过：{aud_prov_id} 未配置（{tts_skipped} 条台词待配音）。请在系统配置中填入对应API Key或切换Provider。",
                progress_cb,
            )

        # ============ Stage 6: 剪映草稿导出 ============
        draft_res: Dict[str, Any] = {}
        await self._log("Stage 6 · 剪映导出", "通过 pyJianYingDraft 构建官方多轨草稿工程...", progress_cb)
        try:
            draft_res = await jianyin_exporter.export_project_to_jianyin_draft_async(project)
        except DraftExportError as e:
            await self._log("Stage 6 · 剪映导出", f"导出中止: {e}", progress_cb)
            draft_res = {"status": "error", "error": str(e)}
        total_time_ms = int((time.time() - started) * 1000)

        return {
            "status": "success" if not draft_res.get("error") else "partial",
            "execution_time_ms": total_time_ms,
            "pipeline_stages": self._stage_logs,
            "project": project.model_dump(),
            "summary": {
                "characters": len(project.characters),
                "total_shots": len(all_shots),
                "roles_designed": role_ok,
                "roles_failed": len(role_fail),
                "images_generated": image_ok,
                "images_failed": len(image_fail),
                "videos_generated": video_ok,
                "videos_failed": len(video_fail),
                "videos_pending": len(video_pending),
                "tts_generated": tts_ok,
                "tts_skipped_or_failed": tts_skipped,
                "draft_exported": bool(draft_res and not draft_res.get("error")),
                "image_provider": img_prov_id,
                "video_provider": vid_prov_id,
                "audio_provider": aud_prov_id,
            },
            "image_errors": image_fail,
            "video_errors": video_fail,
            "videos_pending": video_pending,
            "jianyin_draft": draft_res,
        }


unified_orchestrator = UnifiedDramaPipeline()
