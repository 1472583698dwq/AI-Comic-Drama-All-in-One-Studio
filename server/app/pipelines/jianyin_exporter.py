"""
剪映 / CapCut 官方草稿导出器（基于开源库 pyJianYingDraft）

时间线口径（与前端多轨面板一致）：
- main_video 主画面轨定义时间线：每个镜头按"真实素材时长"占位，素材缺失/超长的部分被裁掉，
  不再出现"游标空推、配音错压到下一镜"的情况。
- dialogue 配音轨：只挂真实存在的 TTS 音频，长度不超过该镜在时间线上占的槽位。
- captions 字幕轨：subtitle_text（缺省回退台词/旁白文案）。
- bgm 音乐轨：仅当项目绑定 bgm_url 时才创建，按素材长度平铺到全片末尾。

素材侧：同一 URL 在一次导出内只下载一次、跨导出按 URL 哈希复用磁盘缓存；本地静态路径被围栏
限制在 storage/exports 之内；所有素材时长由 pymediainfo 真实探测（pyJianYingDraft 内部完成）。
探测不到就不产出片段，并在回执里逐镜说明原因，不产出"看起来成功"的假工程。
"""
import base64
import binascii
import hashlib
import os
import shutil
import threading
import urllib.parse
import urllib.request
import uuid as uuidlib
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from app.models.schemas import Project
from app.core.config import settings

try:
    import pyJianYingDraft as draft
    HAS_PYJIANYING = True
    DRAFT_IMPORT_ERROR: Optional[str] = None
except Exception as _e:  # ImportError 之外还可能是 MediaInfo DLL 缺失
    HAS_PYJIANYING = False
    DRAFT_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

SEC_US = 1_000_000
# 剪映不接受零长片段，缺时长时也给一个最小槽位
MIN_SLOT_US = 200_000
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
MAX_WARNINGS = 200
USER_AGENT = "MiniMaxComicDramaStudio/1.0"

PICTURE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-matroska": ".mkv", "video/webm": ".webm",
    "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/flac": ".flac", "audio/ogg": ".ogg", "audio/aac": ".aac",
}


class DraftExportError(RuntimeError):
    """剪映草稿导出失败"""


def _us(seconds: float) -> int:
    return int(round(max(0.0, float(seconds)) * SEC_US))


def engine_status() -> Dict[str, Any]:
    """供前端在点击导出之前判断引擎是否可用"""
    return {"installed": HAS_PYJIANYING, "error": DRAFT_IMPORT_ERROR}


def assets_dir() -> str:
    # 延迟取 settings.EXPORTS_DIR：打包态与测试用例都会改写它
    path = os.path.join(settings.EXPORTS_DIR, "_assets")
    os.makedirs(path, exist_ok=True)
    return path


def _static_roots() -> Dict[str, str]:
    return {"/storage/": settings.STORAGE_DIR, "/exports/": settings.EXPORTS_DIR}


def _is_inside(root: str, target: str) -> bool:
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:
        # 跨盘符（Windows）
        return False


def _resolve_local_url(url: str) -> Optional[str]:
    """把后端静态 URL 映射为本地绝对路径；越出 storage/exports 的一律拒绝"""
    for prefix, root in _static_roots().items():
        if url.startswith(prefix):
            target = os.path.realpath(os.path.join(root, url[len(prefix):]))
            if not _is_inside(root, target):
                raise ValueError(f"素材路径越界，已拒绝: {url}")
            return target
    return None


def _url_ext(url: str, allowed: set) -> Optional[str]:
    path = urllib.parse.urlparse(url).path
    ext = os.path.splitext(path)[1].lower()
    return ext if ext in allowed else None


def _asset_label(url: Optional[str]) -> Optional[str]:
    """回执里给前端看的素材短名（data URL 不打全）"""
    if not url:
        return None
    if url.startswith("data:"):
        return "<内联素材>"
    return (os.path.basename(urllib.parse.urlparse(url).path) or None)


def plan_slot(design_us: int, pic_us: Optional[int], pic_is_still: bool, audio_us: Optional[int]) -> Dict[str, int]:
    """算出该镜头在时间线上实占的槽位，以及画面/配音片段各自的长度（微秒）

    规则：
    - 有静帧画面：静帧可以免费延长，槽位取"设计时长"与"配音长度"的较大者（配音不被腰斩）；
    - 有视频画面：不给冻帧，槽位不超过素材真实长度，配音超出槽位则截断；
    - 无画面：槽位让给配音；两者都没有的镜头由调用方跳过。
    """
    audio_us = max(0, int(audio_us or 0))
    design_us = max(MIN_SLOT_US, int(design_us))
    if pic_us is None:
        slot = audio_us or design_us
    elif pic_is_still:
        slot = max(design_us, audio_us)
    else:
        slot = min(design_us, max(int(pic_us), MIN_SLOT_US))
    slot = max(slot, MIN_SLOT_US)
    return {
        "slot_us": slot,
        "pic_us": slot if pic_us is not None else 0,
        "audio_us": min(slot, audio_us),
    }


def picture_url_chain(shot: Any) -> List[str]:
    """画面素材回退顺序：成片 → 分镜图 → 导演台预演视频 → 预演截图"""
    out = []
    for key in ("video_url", "image_url", "previz_video_url", "previz_url"):
        val = getattr(shot, key, None)
        if isinstance(val, str) and val.strip():
            out.append(val.strip())
    return out


class AssetStore:
    """URL → 本地文件 → pyJianYingDraft 素材实例，三层都带缓存"""

    def __init__(self):
        self._lock = threading.Lock()
        self._paths: Dict[str, str] = {}
        self._videos: Dict[str, Any] = {}
        self._audios: Dict[str, Any] = {}
        self.downloaded = 0
        self.reused = 0

    def local_path(self, url: str, kind: str) -> str:
        key = f"{kind}::{url}"
        with self._lock:
            cached = self._paths.get(key)
        if cached:
            return cached

        if url.startswith("data:"):
            path = self._write_data_url(url, kind)
        elif url.startswith("http://") or url.startswith("https://"):
            path = self._fetch_remote(url, kind)
        else:
            local = _resolve_local_url(url)
            if not local:
                raise ValueError(f"无法识别的素材地址: {url}")
            if not os.path.exists(local):
                raise FileNotFoundError(f"本地素材不存在: {url} → {local}")
            path = local

        with self._lock:
            self._paths[key] = path
        return path

    def _write_data_url(self, url: str, kind: str) -> str:
        header, _, body = url.partition(",")
        if "base64" not in header.lower():
            raise ValueError("内联素材仅支持 base64 data URL")
        try:
            raw = base64.b64decode(body, validate=False)
        except (binascii.Error, ValueError) as e:
            raise ValueError(f"内联素材 base64 解码失败: {e}")
        if not raw:
            raise ValueError("内联素材内容为空")
        if len(raw) > MAX_DOWNLOAD_BYTES:
            raise ValueError("内联素材超过 512MB 上限")
        mime = header.split(";")[0].split(":")[-1].strip().lower()
        all_exts = PICTURE_EXTS | VIDEO_EXTS | AUDIO_EXTS
        ext = CONTENT_TYPE_EXT.get(mime) or _url_ext("x." + mime.split("/")[-1], all_exts)
        if not ext:
            ext = ".mp3" if kind == "audio" else ".png"
        dest = os.path.join(assets_dir(), f"inline_{hashlib.sha1(url.encode('utf-8')).hexdigest()[:16]}{ext}")
        if not os.path.exists(dest):
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, dest)
        return dest

    def _fetch_remote(self, url: str, kind: str) -> str:
        allowed = {"audio": AUDIO_EXTS, "video": VIDEO_EXTS | PICTURE_EXTS}.get(kind, VIDEO_EXTS | PICTURE_EXTS)
        ext = _url_ext(url, allowed)
        cache_key = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
        if ext:
            dest = os.path.join(assets_dir(), f"asset_{cache_key}{ext}")
            if os.path.exists(dest) and os.path.getsize(dest) > 0:
                with self._lock:
                    self.reused += 1
                return dest
        else:
            dest = os.path.join(assets_dir(), f"asset_{cache_key}")

        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            mime = (resp.headers.get_content_type() or "").lower()
            total = 0
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        f.close()
                        os.remove(tmp)
                        raise ValueError("素材超过 512MB 上限，已中止下载")
                    f.write(chunk)
        if total == 0:
            os.remove(tmp)
            raise ValueError(f"素材下载后为空文件: {url}")
        if not ext:
            guess = CONTENT_TYPE_EXT.get(mime, ".mp3" if kind == "audio" else ".mp4")
            final = dest + guess
            os.replace(tmp, final)
            with self._lock:
                self.downloaded += 1
            return final
        os.replace(tmp, dest)
        with self._lock:
            self.downloaded += 1
        return dest

    def prepare(self, items: List[Any]) -> None:
        """并发预取（items 为 (url, kind) 列表）。失败不抛错：后续真正取用素材时会带明确原因报错"""
        uniq = [f"{kind}::{url}" for url, kind in items if url]
        if len(set(uniq)) < 2:
            return

        def worker(key: str) -> None:
            kind, _, url = key.partition("::")
            try:
                self.local_path(url, kind)
            except Exception:
                pass

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(worker, list(dict.fromkeys(uniq))))

    def video_material(self, url: str) -> Any:
        path = self.local_path(url, "video")
        with self._lock:
            cached = self._videos.get(path)
        if cached is not None:
            return cached
        material = draft.VideoMaterial(path)
        with self._lock:
            self._videos[path] = material
        return material

    def audio_material(self, url: str) -> Any:
        path = self.local_path(url, "audio")
        with self._lock:
            cached = self._audios.get(path)
        if cached is not None:
            return cached
        material = draft.AudioMaterial(path)
        with self._lock:
            self._audios[path] = material
        return material


class JianYingDraftExporter:

    def export_project_to_jianyin_draft(self, project: Project) -> Dict[str, Any]:
        """同步导出（内部含网络下载，建议经 export_project_to_jianyin_draft_async 在线程池中调用）"""
        if not HAS_PYJIANYING:
            raise DraftExportError(
                "剪映引擎未就绪（pyJianYingDraft/pymediainfo 未安装）："
                f"{DRAFT_IMPORT_ERROR}；开发环境执行 pip install pyJianYingDraft pymediainfo 后重启服务"
            )

        all_shots = [sh for sc in project.scenes for sh in sc.shots]
        if not all_shots:
            raise DraftExportError("项目中没有分镜，无法导出剪映草稿")

        canvas_width = 1080 if project.aspect_ratio == "9:16" else 1920
        canvas_height = 1920 if project.aspect_ratio == "9:16" else 1080
        draft_id = uuidlib.uuid4().hex[:8]
        folder_name = f"MiniMax_Draft_{draft_id}"

        bgm_url = (project.bgm_url or "").strip() or None
        bgm_volume = float(project.bgm_volume if project.bgm_volume is not None else 0.5)

        store = AssetStore()
        warnings: List[str] = []
        report: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []

        def warn(text: str) -> None:
            if len(warnings) < MAX_WARNINGS:
                warnings.append(text)

        def pick_picture(shot: Any):
            """按回退顺序拿到第一份能加载的画面素材"""
            chain = picture_url_chain(shot)
            if not chain:
                return None, None, "镜头没有任何画面素材（视频/图片/预演截图都为空）"
            last_err = "画面素材不可用"
            for url in chain:
                try:
                    return url, store.video_material(url), None
                except Exception as e:
                    last_err = f"{url} → {type(e).__name__}: {e}"
            return None, None, f"画面素材加载失败：{last_err}"

        def pick_audio(shot: Any):
            url = getattr(shot, "audio_url", None)
            if not (isinstance(url, str) and url.strip()):
                return None, None, None
            try:
                return url.strip(), store.audio_material(url.strip()), None
            except Exception as e:
                return None, None, f"配音素材加载失败: {url} → {type(e).__name__}: {e}"

        # ---- 1. 远端素材并发预取（本地路径直接命中，不产生网络请求）----
        prefetch: List[Any] = []
        for shot in all_shots:
            chain = picture_url_chain(shot)
            if chain:
                prefetch.append((chain[0], "video"))
            if (shot.audio_url or "").strip():
                prefetch.append((shot.audio_url.strip(), "audio"))
        if bgm_url:
            prefetch.append((bgm_url, "audio"))
        store.prepare(prefetch)

        # ---- 2. 先把每个镜头的槽位算清楚（含素材探测），再决定建哪些轨 ----
        slots: List[Dict[str, Any]] = []
        for shot in all_shots:
            pic_url, pic_mat, pic_err = pick_picture(shot)
            _, aud_mat, aud_err = pick_audio(shot)
            if pic_mat is None and aud_mat is None:
                reason = pic_err or "无画面且无配音"
                skipped.append({"shot_index": shot.shot_index, "reason": reason})
                warn(f"分镜#{shot.shot_index} 已从草稿中跳过：{reason}" + (f"；{aud_err}" if aud_err else ""))
                continue

            timing = plan_slot(
                _us(shot.duration),
                pic_mat.duration if pic_mat else None,
                getattr(pic_mat, "material_type", "photo") == "photo",
                aud_mat.duration if aud_mat else 0,
            )
            pic_is_still = bool(pic_mat) and getattr(pic_mat, "material_type", "photo") == "photo"
            if aud_mat is not None and timing["audio_us"] < MIN_SLOT_US:
                warn(f"分镜#{shot.shot_index} 配音只有 {aud_mat.duration / SEC_US:.2f}s（不足最小片段长度），该镜不挂配音")
                aud_mat = None
            elif aud_mat is not None and timing["audio_us"] < aud_mat.duration:
                warn(f"分镜#{shot.shot_index} 配音长 {(aud_mat.duration - timing['audio_us']) / SEC_US:.2f}s "
                     f"超出画面槽位，配音被截断；请补长画面或缩短台词")
            if pic_mat is not None and not pic_is_still and timing["slot_us"] < pic_mat.duration:
                # 静帧按设计时长自由延长/截断都正常，只有真视频素材被裁掉才需要说明
                warn(f"分镜#{shot.shot_index} 视频长 {(pic_mat.duration - timing['slot_us']) / SEC_US:.2f}s "
                     f"超出该镜槽位，超出部分已裁掉（不冻帧）")
            if aud_err:
                warn(f"分镜#{shot.shot_index} {aud_err}")
            slots.append({
                "shot": shot, "pic_url": pic_url, "pic_mat": pic_mat, "aud_mat": aud_mat,
                **timing,
            })

        if not slots:
            raise DraftExportError("所有分镜都没有可用素材，无法生成草稿：" + (warnings[0] if warnings else "请先生成分镜画面或配音"))

        # ---- 3. 建轨：只建真的有内容的轨，顺序 = 自下而上（主画面轨在最底、字幕在最顶）----
        bgm_mat = None
        if bgm_url:
            try:
                bgm_mat = store.audio_material(bgm_url)
            except Exception as e:
                warn(f"BGM 素材加载失败，已跳过音乐轨: {type(e).__name__}: {e}")
        has_caption = any(
            (getattr(s["shot"], "subtitle_text", "") or getattr(s["shot"], "dialogue", "")
             or getattr(s["shot"], "voiceover", ""))
            for s in slots
        )
        track_specs = []
        if any(s["pic_mat"] for s in slots):
            track_specs.append(draft.TrackSpec(draft.TrackType.video, "main_video"))
        if any(s["aud_mat"] for s in slots):
            track_specs.append(draft.TrackSpec(draft.TrackType.audio, "dialogue"))
        if bgm_mat is not None:
            track_specs.append(draft.TrackSpec(draft.TrackType.audio, "bgm"))
        if has_caption:
            track_specs.append(draft.TrackSpec(draft.TrackType.text, "captions"))

        draft_folder = draft.DraftFolder(settings.EXPORTS_DIR)
        script = draft_folder.create_draft(folder_name, canvas_width, canvas_height, allow_replace=True)
        script.append_tracks(track_specs)
        track_names = {spec.name for spec in track_specs}
        total_us = sum(s["slot_us"] for s in slots)

        video_count = audio_count = caption_count = 0
        cursor_us = 0
        for item in slots:
            shot = item["shot"]
            slot = item["slot_us"]
            notes: List[str] = []

            if item["pic_mat"] is not None:
                script.add_segment(
                    draft.VideoSegment(item["pic_mat"], draft.Timerange(cursor_us, slot)),
                    "main_video",
                )
                video_count += 1
            else:
                notes.append("无画面，仅占配音时长")

            if item["aud_mat"] is not None:
                script.add_segment(
                    draft.AudioSegment(item["aud_mat"], draft.Timerange(cursor_us, item["audio_us"])),
                    "dialogue",
                )
                if item["audio_us"] < item["aud_mat"].duration:
                    notes.append("配音被截断")
                audio_count += 1

            text = (getattr(shot, "subtitle_text", "") or getattr(shot, "dialogue", "")
                    or getattr(shot, "voiceover", "")).strip()
            if text and "captions" in track_names:
                script.add_segment(
                    draft.TextSegment(
                        text,
                        draft.Timerange(cursor_us, slot),
                        style=draft.TextStyle(size=8.0, align=1, auto_wrapping=True, max_line_width=0.9),
                        clip_settings=draft.ClipSettings(transform_y=-0.75),
                    ),
                    "captions",
                )
                caption_count += 1

            entry = {
                "shot_index": shot.shot_index,
                "start_us": cursor_us,
                "slot_us": slot,
                "design_us": _us(shot.duration),
                "picture": _asset_label(item["pic_url"]),
                "audio": bool(item["aud_mat"]),
                "skipped": False,
            }
            if notes:
                entry["notes"] = notes
            report.append(entry)
            cursor_us += slot

        # ---- 4. BGM 平铺到全片末尾（不超出素材时长的部分自然结束）----
        bgm_segments = 0
        if bgm_mat is not None:
            placed = 0
            while placed < total_us:
                dur = min(bgm_mat.duration, total_us - placed)
                if dur < MIN_SLOT_US:
                    break
                seg = draft.AudioSegment(bgm_mat, draft.Timerange(placed, dur), volume=bgm_volume)
                fade_in = int(0.4 * SEC_US) if placed == 0 else 0
                fade_out = int(1.0 * SEC_US) if placed + dur >= total_us else 0
                fade_in = min(fade_in, dur // 2)
                fade_out = min(fade_out, dur // 2)
                if fade_in or fade_out:
                    seg.add_fade(fade_in, fade_out)
                script.add_segment(seg, "bgm")
                bgm_segments += 1
                placed += dur

        script.save()

        jianyin_native_path = None
        if settings.JIANYIN_DRAFT_PATH and os.path.exists(settings.JIANYIN_DRAFT_PATH):
            try:
                src_draft_dir = os.path.join(settings.EXPORTS_DIR, folder_name)
                dst_draft_dir = os.path.join(settings.JIANYIN_DRAFT_PATH, folder_name)
                if os.path.exists(dst_draft_dir):
                    shutil.rmtree(dst_draft_dir)
                shutil.copytree(src_draft_dir, dst_draft_dir)
                jianyin_native_path = dst_draft_dir
            except Exception as e:
                warn(f"同步至剪映本地草稿目录 ({settings.JIANYIN_DRAFT_PATH}) 失败: {e}")
        else:
            warn("未配置（或不存在）剪映草稿目录 JIANYIN_DRAFT_PATH，工程只落在导出目录，需手动导入剪映")

        return {
            "draft_id": draft_id,
            "draft_folder_name": folder_name,
            "export_dir": os.path.join(settings.EXPORTS_DIR, folder_name),
            "jianyin_native_path": jianyin_native_path,
            "file_url": f"/exports/{folder_name}/draft_content.json",
            "canvas": {"width": canvas_width, "height": canvas_height},
            "tracks": [spec.name for spec in track_specs],
            "total_shots": len(all_shots),
            "placed_shots": len(slots),
            "video_segments": video_count,
            "audio_segments": audio_count,
            "caption_segments": caption_count,
            "bgm": {"bound": bool(bgm_url), "asset": _asset_label(bgm_url), "segments": bgm_segments},
            "duration_seconds": round(cursor_us / SEC_US, 2),
            "design_duration_seconds": round(sum(_us(s.duration) for s in all_shots) / SEC_US, 2),
            "assets": {"downloaded": store.downloaded, "cache_reused": store.reused},
            "report": report,
            "skipped_shots": skipped,
            "warnings": warnings,
            "engine": "pyJianYingDraft (剪映官方草稿格式)",
        }

    async def export_project_to_jianyin_draft_async(self, project: Project) -> Dict[str, Any]:
        """异步包装：下载与草稿构建均在线程池执行，避免阻塞事件循环"""
        import asyncio
        return await asyncio.to_thread(self.export_project_to_jianyin_draft, project)


jianyin_exporter = JianYingDraftExporter()
