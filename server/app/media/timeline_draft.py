# -*- coding: utf-8 -*-
"""时间线片段 → 剪映草稿（ffmpeg 缺失时的降级出口）。

不做第二套排布逻辑：把片段翻译成既有 `jianyin_exporter` 认得的 `Project`
（一场景 N 镜，duration = 裁剪后时长，视频片段挂 `video_url`），草稿的轨道排布、
缺素材回执、素材时长探测全部复用既有实现。

**已知降级差异**（会随结果一起回执给前端）：剪映草稿按素材完整时长排布镜头，
片段级入出点裁剪不生效；需要精确裁剪请用 ffmpeg 合 MP4。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from app.media.timeline_merge import TimelineMergeError, normalize_clips


def clips_to_project(
    clips: List[Dict[str, Any]],
    *,
    title: str = "时间线成片",
    aspect_ratio: str = "9:16",
    project_id: Optional[str] = None,
) -> Any:
    """把（已规整的）片段列表翻译成一份单场景 Project。"""
    from app.models.schemas import Project, Scene, StoryboardShot

    if not isinstance(clips, list) or not clips:
        raise TimelineMergeError("没有可导出的片段：请先添加素材")

    shots: List[StoryboardShot] = []
    for i, clip in enumerate(clips, start=1):
        is_audio = clip.get("kind") == "audio"
        span = float(clip.get("span") or (float(clip.get("out", 0)) - float(clip.get("in", 0))))
        shots.append(StoryboardShot(
            id=str(clip.get("id") or f"tl_clip_{i}"),
            shot_index=i,
            scene_index=1,
            action_desc=str(clip.get("name") or f"片段 {i}"),
            image_prompt="",
            video_url=None if is_audio else clip.get("url"),
            audio_url=clip.get("url") if is_audio else None,
            duration=round(max(span, 0.0), 3),
            subtitle_text="",
        ))

    stamp = time.strftime("%Y%m%d%H%M%S")
    return Project(
        id=project_id or f"timeline_{stamp}",
        title=title or "时间线成片",
        aspect_ratio=aspect_ratio or "9:16",
        scenes=[Scene(
            id="tl_scene_1",
            scene_index=1,
            title=title or "时间线成片",
            location="时间线",
            shots=shots,
        )],
    )


async def export_clips_to_draft(
    clips: Any,
    *,
    title: str = "时间线成片",
    aspect_ratio: str = "9:16",
    project_id: Optional[str] = None,
) -> Dict[str, Any]:
    """降级出口：把片段导出为剪映/CapCut 官方草稿工程。"""
    norm = clips if (isinstance(clips, list) and clips and isinstance(clips[0], dict) and "path" in clips[0]) else normalize_clips(clips)
    project = clips_to_project(norm, title=title, aspect_ratio=aspect_ratio, project_id=project_id)

    try:
        # 新基线口径：导出能力挂在模块级单例 `jianyin_exporter` 上（见 app/api/routes.py / onekey_agent.py），
        # 不存在模块级 `export_project_to_jianyin_draft_async` 函数，故按单例方法调用。
        from app.pipelines.jianyin_exporter import (
            DraftExportError,
            jianyin_exporter,
        )
    except Exception as e:
        raise TimelineMergeError(f"剪映草稿引擎不可用：{type(e).__name__}: {e}")

    try:
        result = await jianyin_exporter.export_project_to_jianyin_draft_async(project)
    except DraftExportError as e:
        raise TimelineMergeError(str(e))
    except Exception as e:
        raise TimelineMergeError(f"剪映草稿导出失败：{type(e).__name__}: {e}")

    warnings = list(result.get("warnings") or [])
    warnings.append("剪映草稿按素材完整时长排布，片段的入出点裁剪不会生效；需要精确裁剪请改用 ffmpeg 导出 MP4")
    result["warnings"] = warnings
    result["engine"] = "jianyin_draft"
    return result
