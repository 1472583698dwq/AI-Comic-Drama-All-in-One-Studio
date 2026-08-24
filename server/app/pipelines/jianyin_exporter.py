"""
剪映 / CapCut 官方草稿导出器（基于开源库 pyJianYingDraft）
将漫剧分镜真实构建为多轨草稿工程：
- main_video 轨：每个分镜的画面素材（本地 /storage 图片或远程 URL 下载落盘）
- dialogue 轨：分镜已生成的配音 mp3
- captions 轨：台词字幕
未配置 pyJianYingDraft 或素材缺失时返回明确错误/警告，不产出假工程。
"""
import os
import uuid as uuidlib
import urllib.request
from typing import Any, Dict, List, Optional

from app.models.schemas import Project
from app.core.config import settings

try:
    import pyJianYingDraft as draft
    from pyJianYingDraft import Timerange
    HAS_PYJIANYING = True
except ImportError:
    HAS_PYJIANYING = False

ASSETS_DIR = os.path.join(settings.EXPORTS_DIR, "_assets")
os.makedirs(ASSETS_DIR, exist_ok=True)

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
VIDEO_EXTS = (".mp4", ".mov", ".avi")


class DraftExportError(RuntimeError):
    """剪映草稿导出失败"""


def _us(seconds: float) -> int:
    return int(round(seconds * 1_000_000))


def _resolve_local_url(url: str) -> Optional[str]:
    """把后端静态 URL (/storage/..., /exports/...) 映射为本地磁盘路径"""
    if url.startswith("/storage/"):
        return os.path.join(settings.STORAGE_DIR, url[len("/storage/"):])
    if url.startswith("/exports/"):
        return os.path.join(settings.EXPORTS_DIR, url[len("/exports/"):])
    return None


def _materialize_asset(url: str) -> str:
    """将素材 URL 转换为可用的本地文件路径；远程 URL 自动下载。失败抛异常。"""
    local = _resolve_local_url(url)
    if local:
        if os.path.exists(local):
            return local
        raise FileNotFoundError(f"本地素材不存在: {url} → {local}")

    if url.startswith("http://") or url.startswith("https://"):
        filename = f"asset_{uuidlib.uuid4().hex[:10]}{os.path.splitext(url.split('?')[0])[1] or '.png'}"
        dest = os.path.join(ASSETS_DIR, filename)
        req = urllib.request.Request(url, headers={"User-Agent": "MiniMaxComicDramaStudio/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        return dest

    raise ValueError(f"无法识别的素材地址: {url}")


class JianYingDraftExporter:

    def export_project_to_jianyin_draft(self, project: Project) -> Dict[str, Any]:
        """同步导出（内部含网络下载，建议经 export_project_to_jianyin_draft_async 在线程池中调用）"""
        if not HAS_PYJIANYING:
            raise DraftExportError(
                "pyJianYingDraft 未安装：请执行 pip install pyJianYingDraft pymediainfo 后重启服务"
            )

        canvas_width = 1080 if project.aspect_ratio == "9:16" else 1920
        canvas_height = 1920 if project.aspect_ratio == "9:16" else 1080
        draft_id = uuidlib.uuid4().hex[:8]
        folder_name = f"MiniMax_Draft_{draft_id}"

        all_shots = [sh for sc in project.scenes for sh in sc.shots]
        if not all_shots:
            raise DraftExportError("项目中没有分镜，无法导出剪映草稿")

        draft_folder = draft.DraftFolder(settings.EXPORTS_DIR)
        script = draft_folder.create_draft(folder_name, canvas_width, canvas_height, allow_replace=True)

        script.append_tracks([
            draft.TrackSpec(draft.TrackType.audio, "bgm"),
            draft.TrackSpec(draft.TrackType.audio, "dialogue"),
            draft.TrackSpec(draft.TrackType.video, "main_video"),
            draft.TrackSpec(draft.TrackType.text, "captions"),
        ])

        warnings: List[str] = []
        video_count = audio_count = caption_count = 0
        cursor_us = 0

        for shot in all_shots:
            duration_us = _us(max(0.5, float(shot.duration)))

            # ---- 主画面轨：图片 / 视频 ----
            media_url = shot.video_url or shot.image_url
            if media_url:
                try:
                    path = _materialize_asset(media_url)
                    material = draft.VideoMaterial(path)
                    script.add_segment(
                        draft.VideoSegment(material, Timerange(cursor_us, duration_us)),
                        "main_video",
                    )
                    video_count += 1
                except Exception as e:
                    warnings.append(f"分镜#{shot.shot_index} 画面素材跳过: {e}")
            else:
                warnings.append(f"分镜#{shot.shot_index} 无画面素材(image_url 为空)，已跳过该轨片段")

            # ---- 配音轨：已生成的 TTS 音频 ----
            if shot.audio_url:
                try:
                    audio_path = _materialize_asset(shot.audio_url)
                    audio_material = draft.AudioMaterial(audio_path)
                    script.add_segment(
                        draft.AudioSegment(audio_material, Timerange(cursor_us, duration_us)),
                        "dialogue",
                    )
                    audio_count += 1
                except Exception as e:
                    warnings.append(f"分镜#{shot.shot_index} 配音素材跳过: {e}")

            # ---- 字幕轨 ----
            if shot.subtitle_text:
                script.add_segment(
                    draft.TextSegment(
                        shot.subtitle_text,
                        Timerange(cursor_us, duration_us),
                        clip_settings=draft.ClipSettings(transform_y=-0.75),
                    ),
                    "captions",
                )
                caption_count += 1

            cursor_us += duration_us

        script.save()

        # If JIANYIN_DRAFT_PATH is configured and exists, sync draft there too so it appears in JianYing client
        jianyin_native_path = None
        if settings.JIANYIN_DRAFT_PATH and os.path.exists(settings.JIANYIN_DRAFT_PATH):
            try:
                import shutil
                src_draft_dir = os.path.join(settings.EXPORTS_DIR, folder_name)
                dst_draft_dir = os.path.join(settings.JIANYIN_DRAFT_PATH, folder_name)
                if os.path.exists(dst_draft_dir):
                    shutil.rmtree(dst_draft_dir)
                shutil.copytree(src_draft_dir, dst_draft_dir)
                jianyin_native_path = dst_draft_dir
            except Exception as e:
                warnings.append(f"同步至剪映本地草稿目录 ({settings.JIANYIN_DRAFT_PATH}) 失败: {e}")

        total_seconds = round(cursor_us / 1_000_000, 2)
        return {
            "draft_id": draft_id,
            "draft_folder_name": folder_name,
            "export_dir": os.path.join(settings.EXPORTS_DIR, folder_name),
            "jianyin_native_path": jianyin_native_path,
            "file_url": f"/exports/{folder_name}/draft_content.json",
            "canvas": {"width": canvas_width, "height": canvas_height},
            "total_shots": len(all_shots),
            "video_segments": video_count,
            "audio_segments": audio_count,
            "caption_segments": caption_count,
            "duration_seconds": total_seconds,
            "warnings": warnings,
            "engine": f"pyJianYingDraft (剪映官方草稿格式)",
        }

    async def export_project_to_jianyin_draft_async(self, project: Project) -> Dict[str, Any]:
        """异步包装：下载与草稿构建均在线程池执行，避免阻塞事件循环"""
        import asyncio
        return await asyncio.to_thread(self.export_project_to_jianyin_draft, project)


jianyin_exporter = JianYingDraftExporter()
