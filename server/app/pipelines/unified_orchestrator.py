"""
漫剧全链路真实编排器 - 动态Provider版
Stage 1: MiniMax LLM 小说拆解
Stage 2: 动态图片Provider批量生图（comfyui/siliconflow/dashscope等，支持workflow_id）
Stage 3: 动态音频Provider台词配音（minimax/elevenlabs/cosyvoice/gpt_sovits）
Stage 4: pyJianYingDraft 剪映草稿导出
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

        # ============ Stage 2: 动态生图 ============
        img_prov_id = image_provider or getattr(settings, "IMAGE_PROVIDER", "comfyui")
        await self._log("Stage 2 · 生图", f"开始为分镜生成画面（Provider={img_prov_id}，最多 {max_images} 镜）...", progress_cb)
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
                req = ImageGenerateRequest(
                    prompt=shot.image_prompt or shot.action_desc or "cinematic anime scene",
                    negative_prompt="",
                    aspect_ratio=aspect_ratio,
                    style_preset=style_preset,
                    workflow_id=image_workflow_id,
                )
                reg = _get_image_registry()
                res = await reg.generate(req, provider_id=img_prov_id)
                shot.image_url = res.image_url
                shot.status = "completed"
                image_ok += 1
                await self._log(
                    "Stage 2 · 生图",
                    f"分镜 #{shot.shot_index} 生图完成 ({res.provider}:{res.elapsed_ms}ms)",
                    progress_cb, shot_index=shot.shot_index, image_url=res.image_url, provider=res.provider,
                )
            except Exception as e:
                shot.status = "error"
                image_fail.append({"shot_index": shot.shot_index, "error": str(e)})
                await self._log("Stage 2 · 生图", f"分镜 #{shot.shot_index} 生图失败: {e}", progress_cb)
                if "无法连接" in str(e) and idx == 0:
                    # 首镜即不可达，提示用户切换Provider
                    await self._log("Stage 2 · 生图", f"提示：{img_prov_id} 不可用，可尝试切换 siliconflow/dashscope 或检查 ComfyUI", progress_cb)
                    break
        await self._log(
            "Stage 2 · 生图", f"生图完成：成功 {image_ok} / 失败 {len(image_fail)} (Provider: {prov_name})",
            progress_cb, elapsed_ms=int((time.time() - t2) * 1000),
        )

        # ============ Stage 3: 动态TTS ============
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
            await self._log("Stage 3 · TTS 配音", f"为含台词分镜生成配音（Provider={aud_prov_id}）...", progress_cb)
            t3 = time.time()
            char_voice = {c.name: c.voice_id for c in project.characters}
            narrator_voice = next((c.voice_id for c in project.characters if c.role == "narrator"), "male-pangbai")
            for shot in all_shots:
                line = shot.dialogue or shot.voiceover
                if not line:
                    continue
                voice_id = char_voice.get(shot.speaker_name or "", narrator_voice)
                try:
                    from app.providers.audio.base import AudioGenerateRequest
                    areq = AudioGenerateRequest(text=line, voice_id=voice_id, emotion=shot.emotion)
                    reg = _get_audio_registry()
                    res = await reg.generate(areq, provider_id=aud_prov_id)
                    shot.audio_url = res.audio_url
                    tts_ok += 1
                except Exception:
                    tts_skipped += 1
            await self._log(
                "Stage 3 · TTS 配音", f"配音完成：成功 {tts_ok} / 失败 {tts_skipped} (Provider: {aud_prov_id})",
                progress_cb, elapsed_ms=int((time.time() - t3) * 1000),
            )
        else:
            tts_skipped = sum(1 for sh in all_shots if sh.dialogue or sh.voiceover)
            await self._log(
                "Stage 3 · TTS 配音",
                f"已跳过：{aud_prov_id} 未配置（{tts_skipped} 条台词待配音）。请在系统配置中填入对应API Key或切换Provider。",
                progress_cb,
            )

        # ============ Stage 4: 剪映草稿导出 ============
        draft_res: Dict[str, Any] = {}
        await self._log("Stage 4 · 剪映导出", "通过 pyJianYingDraft 构建官方多轨草稿工程...", progress_cb)
        try:
            draft_res = await jianyin_exporter.export_project_to_jianyin_draft_async(project)
        except DraftExportError as e:
            await self._log("Stage 4 · 剪映导出", f"导出中止: {e}", progress_cb)
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
                "images_generated": image_ok,
                "images_failed": len(image_fail),
                "tts_generated": tts_ok,
                "tts_skipped_or_failed": tts_skipped,
                "draft_exported": bool(draft_res and not draft_res.get("error")),
                "image_provider": img_prov_id,
                "audio_provider": aud_prov_id,
            },
            "image_errors": image_fail,
            "jianyin_draft": draft_res,
        }


unified_orchestrator = UnifiedDramaPipeline()
