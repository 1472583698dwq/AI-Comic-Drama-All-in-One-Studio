# -*- coding: utf-8 -*-
"""导出前补齐缺失配音：有台词/旁白但 audio_url 为空的镜头，调用 TTS 生成并写回。

导出器只混已有音轨；项目里只有旁白文本、没有 TTS 文件时，导出的 MP4 会是静音。
本模块在合片前补这一步，并把生成的 audio_url 写回项目内容（下一次导出直接复用）。
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional, Tuple

from app.providers.audio.base import AudioGenerateRequest
from app.providers.audio.registry import audio_registry
from app.core.config import settings

VOICE_TIMEOUT = 120.0


def _character_maps(characters: Optional[List[Dict[str, Any]]]):
    by_name: Dict[str, Dict[str, str]] = {}
    narrator_voice = ""
    narrator_ref = ""
    for raw in characters or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if name:
            by_name[name] = {
                "voice_id": str(raw.get("voice_id") or ""),
                "ref_audio_url": str(raw.get("ref_audio_url") or ""),
            }
        if str(raw.get("role") or "").strip() == "narrator":
            narrator_voice = narrator_voice or str(raw.get("voice_id") or "")
            narrator_ref = narrator_ref or str(raw.get("ref_audio_url") or "")
    return by_name, narrator_voice, narrator_ref


def _candidate_providers(preferred: Optional[str]) -> List[str]:
    ids: List[str] = []
    if preferred:
        ids.append(preferred)
    for pid in audio_registry.list_ids():
        if pid in ids:
            continue
        try:
            prov = audio_registry.get(pid)
            if prov is not None and prov.is_configured():
                ids.append(pid)
        except Exception:
            continue
    return ids


def _write_back(project_content: Optional[Dict[str, Any]], shot: Dict[str, Any]) -> None:
    if not isinstance(project_content, dict):
        return
    sid = str(shot.get("id") or "")
    for scene in project_content.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        for target in scene.get("shots") or []:
            if not isinstance(target, dict) or str(target.get("id") or "") != sid:
                continue
            target["audio_url"] = shot["audio_url"]
            target["audio_duration"] = shot["audio_duration"]
            target["audio_provider"] = shot["audio_provider"]
            return


def persist_generated_voice(
    shots: List[Dict[str, Any]],
    project_id: Optional[str],
    before_ids: Optional[List[str]] = None,
) -> List[str]:
    """把本次生成成功的配音按字段写回项目（不整份保存，避免覆盖并发的舞台改动）。"""
    if not project_id:
        return []
    allowed = set(before_ids or [])
    warnings: List[str] = []
    from app.providers.project.manager import project_manager
    for shot in shots:
        sid = str(shot.get("id") or "")
        if allowed and sid not in allowed:
            continue
        if not sid or not shot.get("audio_url"):
            continue
        try:
            project_manager.patch_shot(project_id, sid, {
                "audio_url": shot["audio_url"],
                "audio_duration": shot.get("audio_duration", 0),
                "audio_provider": shot.get("audio_provider", ""),
            })
        except Exception as exc:
            warnings.append(f"分镜 #{shot.get('shot_index')} 配音写回项目失败：{type(exc).__name__}: {exc}")
    return warnings


async def fill_missing_voice(
    shots: List[Dict[str, Any]],
    *,
    project_content: Optional[Dict[str, Any]] = None,
    characters: Optional[List[Dict[str, Any]]] = None,
    provider: Optional[str] = None,
    project_id: Optional[str] = None,
    on_progress=None,
) -> Tuple[int, List[str]]:
    """就地补齐 shots 的 audio_url，返回 (生成数量, 警告)。"""
    warnings: List[str] = []
    generated = 0
    by_name, narrator_voice, narrator_ref = _character_maps(characters)
    preferred = (provider or "").strip() or str(getattr(settings, "TTS_PROVIDER", "") or "").strip()
    provider_ids = _candidate_providers(preferred)
    if not provider_ids:
        return 0, ["自动配音未执行：没有可用的 TTS 源（请先在设置→生成源配置语音源）"]

    for shot in shots:
        if shot.get("audio_url"):
            continue
        dialogue = str(shot.get("dialogue") or "").strip()
        voiceover = str(shot.get("voiceover") or "").strip()
        text = dialogue or voiceover
        if not text:
            continue
        speaker = str(shot.get("speaker_name") or "").strip()
        is_voiceover = (not dialogue) and bool(voiceover)
        meta = by_name.get(speaker) if speaker else None
        if not meta and (is_voiceover or not speaker):
            meta = {"voice_id": narrator_voice, "ref_audio_url": narrator_ref}
        voice_id = (meta or {}).get("voice_id", "")
        ref_audio = (meta or {}).get("ref_audio_url", "")
        errors: List[str] = []
        for pid in provider_ids:
            if not pid:
                continue
            try:
                req = AudioGenerateRequest(
                    text=text,
                    voice_id=voice_id,
                    emotion=str(shot.get("emotion") or ""),
                    ref_audio_path=(ref_audio or None),
                    extra={"project_id": project_id} if project_id else None,
                )
                res = await asyncio.wait_for(audio_registry.generate(req, provider_id=pid), timeout=VOICE_TIMEOUT)
                if not res.audio_url:
                    raise RuntimeError("TTS 未返回音频地址")
                shot["audio_url"] = res.audio_url
                shot["audio_duration"] = round(float(res.duration or 0), 3)
                shot["audio_provider"] = res.provider or pid
                _write_back(project_content, shot)
                generated += 1
                if on_progress:
                    try:
                        on_progress(f"已生成 #{shot.get('shot_index')} 配音")
                    except Exception:
                        pass
                errors = []
                break
            except Exception as exc:
                errors.append(f"{pid or 'default'}: {type(exc).__name__}: {exc}")
        if errors:
            warnings.append(
                f"分镜 #{shot.get('shot_index')} 自动配音失败（已尝试 {len(errors)} 个源）："
                + "；".join(errors)[-300:]
            )
    return generated, warnings
