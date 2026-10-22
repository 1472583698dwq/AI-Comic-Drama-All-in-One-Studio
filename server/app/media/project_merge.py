# -*- coding: utf-8 -*-
"""项目多轨时间线 → MP4。

把多轨剪辑面板看到的内容合成为一条 MP4：
- 主画面轨：镜头成片视频；没有视频时回退分镜静帧；两者都没有时输出黑场；
- 配音轨：每镜 audio_url 按该镜起始时间延迟混入，超出镜头槽位的部分截断；
- 字幕轨：subtitle_text → dialogue → voiceover，用 libass 烧录；
- BGM 轨：项目 bgm_url 循环平铺全片，音量取 project.bgm_volume。

片段校验、路径围栏、任务并发闸门复用 `timeline_merge` 的口径；本模块只负责
多轨混流的命令构造与实际合成。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import os
import subprocess
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.media import timeline_merge as tm

MIN_SHOT_SECONDS = 0.4
MAX_SHOTS = 200
MAX_TOTAL_SECONDS = 1800.0
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
DEFAULT_TIMEOUT = 1800.0

TARGET_FPS = tm.TARGET_FPS
AUDIO_RATE = tm.AUDIO_RATE
VIDEO_EXTS = set(tm.VIDEO_EXTS)
AUDIO_EXTS = set(tm.AUDIO_EXTS)
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-m4v": ".m4v",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
}

_USER_AGENT = "MiniMaxComicDramaStudio/1.0"
_ASSET_DIR_NAME = "_timeline_assets"


def _num(value: Any, default: float = 0.0) -> float:
    try:
        got = float(value)
    except (TypeError, ValueError):
        return default
    if got != got or got in (float("inf"), float("-inf")):
        return default
    return got


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _secs(value: float) -> str:
    return f"{max(0.0, float(value)):g}"


def _ext(url: str) -> str:
    return os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()


def _is_remote(url: str) -> bool:
    return url.lower().startswith(("http://", "https://", "data:"))


def _inside(root: str, target: str) -> bool:
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:
        return False


def _inside_roots(path: str) -> bool:
    return any(_inside(root, path) for root in (settings.STORAGE_DIR, settings.EXPORTS_DIR))


def _local_path(url: str, role: str) -> str:
    raw = _text(url)
    if not raw:
        raise tm.TimelineMergeError("素材地址为空")
    if _is_remote(raw):
        raise tm.TimelineMergeError(f"远程素材需先下载：{raw[:80]}")
    path = raw.replace("\\", "/")
    allowed = {
        "image": IMAGE_EXTS,
        "video": VIDEO_EXTS,
        "audio": AUDIO_EXTS,
    }[role]
    ext = os.path.splitext(path)[1].lower()
    if ext not in allowed:
        raise tm.TimelineMergeError(
            f"不支持的{role}素材后缀「{ext or '（无）'}」：{raw[:120]}"
        )
    roots = {"/storage/": settings.STORAGE_DIR, "/exports/": settings.EXPORTS_DIR}
    for prefix, root in roots.items():
        if path.startswith(prefix):
            rel = path[len(prefix):]
            parts = [p for p in rel.split("/") if p not in ("", ".")]
            if not parts or any(p == ".." for p in parts):
                raise tm.TimelineMergeError(f"素材路径非法：{raw[:120]}")
            target = os.path.realpath(os.path.join(root, *parts))
            if not _inside(root, target):
                raise tm.TimelineMergeError(f"素材路径越出存储目录：{raw[:120]}")
            return target
    if os.path.isabs(path):
        real = os.path.realpath(path)
        if _inside_roots(real):
            return real
        raise tm.TimelineMergeError("素材路径必须落在 storage/ 或 exports/ 之内")
    raise tm.TimelineMergeError(f"无法识别的素材路径：{raw[:120]}")


def _asset_dir() -> str:
    path = os.path.join(settings.EXPORTS_DIR, _ASSET_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _role_ext(role: str, url: str, content_type: str = "") -> str:
    allowed = {"image": IMAGE_EXTS, "video": VIDEO_EXTS, "audio": AUDIO_EXTS}[role]
    ext = _ext(url)
    if ext in allowed:
        return ext
    mime = (content_type or "").split(";")[0].strip().lower()
    guessed = CONTENT_TYPE_EXT.get(mime, "")
    if guessed in allowed:
        return guessed
    if role == "image":
        return ".png"
    if role == "audio":
        return ".mp3"
    return ".mp4"


def _cache_remote(url: str) -> Optional[str]:
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    folder = _asset_dir()
    for name in os.listdir(folder):
        if name.startswith(f"remote_{key}."):
            path = os.path.join(folder, name)
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                return path
    return None


def _fetch_remote(url: str, role: str) -> str:
    cached = _cache_remote(url)
    if cached:
        return cached
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    folder = _asset_dir()
    tmp = os.path.join(folder, f"remote_{key}.part")
    total = 0
    with urllib.request.urlopen(req, timeout=60) as resp:
        content_type = resp.headers.get("Content-Type", "")
        with open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise tm.TimelineMergeError("素材超过 512MB 上限，已中止下载")
                fh.write(chunk)
    if total <= 0:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise tm.TimelineMergeError(f"素材下载后为空文件：{url[:120]}")
    final = os.path.join(folder, f"remote_{key}{_role_ext(role, url, content_type)}")
    os.replace(tmp, final)
    return final


def _write_data_url(url: str, role: str) -> str:
    header, _, body = url.partition(",")
    if "base64" not in header.lower():
        raise tm.TimelineMergeError("内联素材仅支持 base64 data URL")
    try:
        raw = base64.b64decode(body, validate=False)
    except (binascii.Error, ValueError) as e:
        raise tm.TimelineMergeError(f"内联素材 base64 解码失败：{e}")
    if not raw:
        raise tm.TimelineMergeError("内联素材内容为空")
    if len(raw) > MAX_DOWNLOAD_BYTES:
        raise tm.TimelineMergeError("内联素材超过 512MB 上限")
    mime = header.split(";")[0].split(":")[-1].strip().lower()
    ext = CONTENT_TYPE_EXT.get(mime) or _role_ext(role, "", mime)
    dest = os.path.join(_asset_dir(), f"inline_{hashlib.sha1(url.encode('utf-8')).hexdigest()[:20]}{ext}")
    if not os.path.exists(dest):
        tmp = dest + ".part"
        with open(tmp, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, dest)
    return dest


async def _materialize(url: str, role: str) -> str:
    raw = _text(url)
    if not raw:
        raise tm.TimelineMergeError("素材地址为空")
    if raw.lower().startswith("data:"):
        return await asyncio.to_thread(_write_data_url, raw, role)
    if raw.lower().startswith(("http://", "https://")):
        return await asyncio.to_thread(_fetch_remote, raw, role)
    path = _local_path(raw, role)
    if not os.path.isfile(path):
        raise tm.TimelineMergeError(f"素材不存在：{raw[:120]}")
    return path


def _pick_picture(raw: Dict[str, Any], index: int, warnings: List[str]) -> List[Dict[str, str]]:
    image_url = _text(raw.get("image_url"))
    video_url = _text(raw.get("video_url"))
    chain: List[Dict[str, str]] = []
    seen: set = set()
    for url, default_kind, label in (
        (video_url, "video", "成片视频"),
        (image_url, "image", "分镜图"),
    ):
        if not url:
            continue
        kind = ""
        if url.startswith("data:"):
            mime = url[5:].split(";")[0].split(",")[0].lower()
            if mime.startswith("video/"):
                kind = "video"
            elif mime.startswith("image/"):
                kind = "image"
            else:
                warnings.append(f"分镜 #{index} 的{label} mime 不支持，已跳过：{mime or '未知'}")
                continue
        else:
            ext = _ext(url)
            if ext in VIDEO_EXTS:
                kind = "video"
            elif ext in IMAGE_EXTS:
                kind = "image"
            elif _is_remote(url):
                kind = default_kind
            else:
                warnings.append(f"分镜 #{index} 的{label}后缀不支持，已跳过：{ext or '（无）'}")
                continue
        key = (url, kind)
        if key in seen:
            continue
        seen.add(key)
        chain.append({"url": url, "kind": kind})
    return chain


def _pick_audio(raw: Dict[str, Any], index: int, warnings: List[str]) -> Optional[str]:
    url = _text(raw.get("audio_url"))
    if not url:
        return None
    if _is_remote(url):
        return url
    ext = _ext(url)
    if ext not in AUDIO_EXTS:
        warnings.append(f"分镜 #{index} 的配音后缀不支持，已跳过：{ext or '（无）'}")
        return None
    return url


def normalize_project_shots(raw_shots: Any) -> Tuple[List[Dict[str, Any]], List[str]]:
    if not isinstance(raw_shots, list) or not raw_shots:
        raise tm.TimelineMergeError("没有可导出的分镜：请先在分镜台生成画面或配音")
    if len(raw_shots) > MAX_SHOTS:
        raise tm.TimelineMergeError(f"分镜数量超过上限（最多 {MAX_SHOTS} 镜）")

    shots: List[Dict[str, Any]] = []
    warnings: List[str] = []
    total = 0.0
    for i, raw in enumerate(raw_shots):
        if not isinstance(raw, dict):
            raise tm.TimelineMergeError(f"第 {i + 1} 镜格式不正确")
        index = int(_num(raw.get("shot_index"), i + 1)) or i + 1
        duration = _num(raw.get("duration"))
        if duration <= 0:
            duration = _num(raw.get("audio_duration"))
        if duration <= 0:
            duration = 3.5
        duration = round(min(max(duration, MIN_SHOT_SECONDS), 600.0), 3)
        picture_chain = _pick_picture(raw, index, warnings)
        audio_url = _pick_audio(raw, index, warnings)
        subtitle = (
            _text(raw.get("subtitle_text"))
            or _text(raw.get("dialogue"))
            or _text(raw.get("voiceover"))
        )
        if not picture_chain:
            warnings.append(f"分镜 #{index} 没有可用画面，导出为黑场")
        shots.append({
            "id": str(raw.get("id") or f"shot_{i + 1}"),
            "shot_index": index,
            "duration": duration,
            "picture_chain": picture_chain,
            "picture_url": picture_chain[0]["url"] if picture_chain else None,
            "picture_kind": picture_chain[0]["kind"] if picture_chain else None,
            "audio_url": audio_url,
            "audio_duration": round(max(0.0, _num(raw.get("audio_duration"))), 3),
            "dialogue": _text(raw.get("dialogue")),
            "voiceover": _text(raw.get("voiceover")),
            "speaker_name": _text(raw.get("speaker_name")),
            "emotion": _text(raw.get("emotion")),
            "subtitle": subtitle,
        })
        total += duration

    if total > MAX_TOTAL_SECONDS:
        raise tm.TimelineMergeError(
            f"总时长 {total:.1f}s 超过上限 {MAX_TOTAL_SECONDS:.0f}s，请拆分后再导出"
        )
    if not any(s["picture_url"] or s["audio_url"] or s["subtitle"] for s in shots):
        raise tm.TimelineMergeError("当前集没有可导出的画面、配音或字幕素材")
    return shots, warnings


def _video_chain(index: int, slot: float, kind: Optional[str], width: int, height: int, label: str) -> str:
    span = _secs(slot)
    common = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={TARGET_FPS}"
    )
    if kind == "video":
        return (
            f"[{index}:v]trim=start=0:end={span},setpts=PTS-STARTPTS,{common},"
            f"tpad=stop_mode=clone:stop_duration={span},trim=start=0:end={span},"
            f"setpts=PTS-STARTPTS,format=yuv420p[{label}]"
        )
    if kind == "image":
        return (
            f"[{index}:v]{common},trim=start=0:end={span},setpts=PTS-STARTPTS,"
            f"format=yuv420p[{label}]"
        )
    return (
        f"[{index}:v]trim=start=0:end={span},setpts=PTS-STARTPTS,"
        f"setsar=1,format=yuv420p[{label}]"
    )


def _audio_chain(index: int, end: float, start: float, label: str) -> str:
    delay = max(0, int(round(start * 1000)))
    return (
        f"[{index}:a]atrim=start=0:end={_secs(end)},asetpts=PTS-STARTPTS,"
        f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
        f"adelay={delay}:all=1[{label}]"
    )


def build_project_command(
    shots: List[Dict[str, Any]],
    output_path: str,
    *,
    aspect_ratio: Optional[str] = None,
    bgm_path: Optional[str] = None,
    bgm_volume: float = 0.5,
    subtitle_file: Optional[str] = None,
    ffmpeg_bin: Optional[str] = None,
) -> List[str]:
    width, height = tm.output_size(aspect_ratio)
    total = round(sum(float(s["duration"]) for s in shots), 3)
    inputs: List[str] = [
        "-f", "lavfi", "-t", _secs(total), "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo",
    ]
    next_index = 1
    graph: List[str] = []
    video_labels: List[str] = []
    dialogue_labels: List[str] = []
    video_audio_labels: List[str] = []
    cursor = 0.0

    for n, shot in enumerate(shots):
        slot = float(shot["duration"])
        kind = shot.get("picture_kind") if shot.get("picture_path") else None
        label = f"v{n}"
        pic_index = -1
        if kind == "video":
            pic_index = next_index
            inputs += ["-i", shot["picture_path"]]
            graph.append(_video_chain(next_index, slot, "video", width, height, label))
            next_index += 1
        elif kind == "image":
            inputs += ["-loop", "1", "-framerate", str(TARGET_FPS), "-t", _secs(slot), "-i", shot["picture_path"]]
            graph.append(_video_chain(next_index, slot, "image", width, height, label))
            next_index += 1
        else:
            inputs += [
                "-f", "lavfi", "-t", _secs(slot), "-i",
                f"color=c=black:s={width}x{height}:r={TARGET_FPS}",
            ]
            graph.append(_video_chain(next_index, slot, None, width, height, label))
            next_index += 1

        video_labels.append(f"[{label}]")

        audio_path = shot.get("audio_path")
        if audio_path:
            inputs += ["-i", audio_path]
            audio_duration = _num(shot.get("audio_duration"))
            end = min(slot, audio_duration) if audio_duration > 0 else slot
            if end < MIN_SHOT_SECONDS:
                end = slot
            audio_label = f"a{n}"
            graph.append(_audio_chain(next_index, end, cursor, audio_label))
            dialogue_labels.append(f"[{audio_label}]")
            next_index += 1

        if shot.get("video_audio") and kind == "video" and pic_index >= 0:
            video_duration = _num(shot.get("video_audio_duration"))
            end = min(slot, video_duration) if video_duration > 0 else slot
            if end < MIN_SHOT_SECONDS:
                end = slot
            video_audio_label = f"va{n}"
            graph.append(_audio_chain(pic_index, end, cursor, video_audio_label))
            video_audio_labels.append(f"[{video_audio_label}]")

        cursor = round(cursor + slot, 3)

    graph.append(
        "".join(video_labels) + f"concat=n={len(shots)}:v=1:a=0[vo]"
    )
    graph.append(
        f"[0:a]atrim=start=0:end={_secs(total)},asetpts=PTS-STARTPTS,"
        f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[abase]"
    )

    mix_inputs = ["[abase]"] + dialogue_labels + video_audio_labels
    if bgm_path:
        inputs += ["-stream_loop", "-1", "-i", bgm_path]
        volume = min(1.0, max(0.0, _num(bgm_volume, 0.5)))
        graph.append(
            f"[{next_index}:a]atrim=start=0:end={_secs(total)},asetpts=PTS-STARTPTS,"
            f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume={volume:g}[bgm]"
        )
        mix_inputs.append("[bgm]")
        next_index += 1

    if len(mix_inputs) == 1:
        audio_out = "abase"
    else:
        graph.append(
            "".join(mix_inputs)
            + f"amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=0:normalize=0[aout]"
        )
        audio_out = "aout"

    if subtitle_file:
        graph.append(f"[vo]subtitles=filename={subtitle_file}[vout]")
        video_out = "vout"
    else:
        video_out = "vo"

    return [
        ffmpeg_bin or "ffmpeg",
        "-y",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        *inputs,
        "-filter_complex",
        ";".join(graph),
        "-map",
        f"[{video_out}]",
        "-map",
        f"[{audio_out}]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(TARGET_FPS),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        str(AUDIO_RATE),
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-t",
        _secs(total),
        output_path,
    ]


def _ass_time(seconds: float) -> str:
    cs = int(round(max(0.0, seconds) * 100))
    h = cs // 360000
    m = (cs // 6000) % 60
    s = (cs // 100) % 60
    return f"{h}:{m:02d}:{s:02d}.{cs % 100:02d}"


def _ass_text(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    return escaped.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\N")


def build_ass(shots: List[Dict[str, Any]], width: int, height: int) -> str:
    font_size = max(28, int(round(height * 0.046)))
    margin_v = max(24, int(round(height * 0.06)))
    margin_lr = max(20, int(round(width * 0.04)))
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,Microsoft YaHei,{font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        f"0,0,0,0,100,100,0,0,1,3,1,2,{margin_lr},{margin_lr},{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    cursor = 0.0
    for shot in shots:
        slot = float(shot["duration"])
        text = _text(shot.get("subtitle"))
        if text:
            lines.append(
                f"Dialogue: 0,{_ass_time(cursor)},{_ass_time(cursor + slot)},Default,,0,0,0,,{_ass_text(text)}"
            )
        cursor = round(cursor + slot, 3)
    return "\n".join(lines) + "\n"


def _run_sync(cmd: List[str], timeout: float, cwd: str) -> Any:
    kwargs: Dict[str, Any] = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        **kwargs,
    )


async def _run(cmd: List[str], timeout: float, cwd: str) -> Any:
    return await asyncio.to_thread(_run_sync, cmd, timeout, cwd)


def _tail(raw: Any, limit: int = 500) -> str:
    data = raw.decode("utf-8", "ignore") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
    data = " ".join(data.split())
    return data[-limit:] if len(data) > limit else data


def _looks_like_subtitle_error(raw: Any) -> bool:
    text = (raw.decode("utf-8", "ignore") if isinstance(raw, (bytes, bytearray)) else str(raw or "")).lower()
    return any(token in text for token in ("subtitles", "libass", "fontconfig", "fontselect", "font file"))


def _cleanup(path: Optional[str]) -> None:
    if not path:
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


async def merge_project_shots(
    shots: List[Dict[str, Any]],
    output_path: str,
    *,
    aspect_ratio: Optional[str] = None,
    bgm_url: Optional[str] = None,
    bgm_volume: float = 0.5,
    subtitles: bool = True,
    allow_silent: bool = False,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    if not tm.has_binary("ffmpeg"):
        raise tm.TimelineMergeError(tm._NO_FFMPEG_MSG)
    if not shots:
        raise tm.TimelineMergeError("没有可导出的分镜")
    if not _inside_roots(output_path):
        raise tm.TimelineMergeError("导出路径必须落在 storage/ 或 exports/ 之内")

    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    warnings: List[str] = []
    jobs: Dict[Tuple[str, str], None] = {}
    for shot in shots:
        chain = shot.get("picture_chain") or []
        if not chain and shot.get("picture_url"):
            chain = [{"url": shot["picture_url"], "kind": shot.get("picture_kind") or "video"}]
        for candidate in chain:
            jobs[(candidate["url"], candidate["kind"])] = None
        if shot.get("audio_url"):
            jobs[(shot["audio_url"], "audio")] = None
    if bgm_url:
        jobs[(bgm_url, "audio")] = None

    keys = list(jobs)
    results = await asyncio.gather(
        *[_materialize(url, role) for url, role in keys],
        return_exceptions=True,
    )
    resolved: Dict[Tuple[str, str], str] = {}
    for key, result in zip(keys, results):
        if isinstance(result, BaseException):
            warnings.append(f"素材不可用，已跳过：{key[0][:100]}（{result}）")
        else:
            resolved[key] = result

    audio_paths = sorted({
        resolved[(s["audio_url"], "audio")]
        for s in shots
        if s.get("audio_url") and (s["audio_url"], "audio") in resolved
    })
    probes = await asyncio.gather(*[tm.probe_media(path) for path in audio_paths], return_exceptions=True)
    probe_map = {
        path: (info if isinstance(info, dict) else {})
        for path, info in zip(audio_paths, probes)
    }

    video_paths = sorted({
        resolved[(s["picture_url"], s["picture_kind"])]
        for s in shots
        if s.get("picture_url") and (s.get("picture_kind") or "") == "video"
        and (s["picture_url"], s["picture_kind"]) in resolved
    })
    video_probes = await asyncio.gather(
        *[tm.probe_media(path) for path in video_paths],
        return_exceptions=True,
    )
    video_probe_map = {
        path: (info if isinstance(info, dict) else {})
        for path, info in zip(video_paths, video_probes)
    }
    if video_paths and not tm.has_binary("ffprobe"):
        warnings.append("未检测到 ffprobe：无法读取视频自带音轨，导出可能没有原声")

    resolved_shots: List[Dict[str, Any]] = []
    for shot in shots:
        entry = dict(shot)
        chain = shot.get("picture_chain") or []
        if not chain and shot.get("picture_url"):
            chain = [{"url": shot["picture_url"], "kind": shot.get("picture_kind") or "video"}]
        entry["picture_path"] = None
        entry["picture_kind"] = None
        for candidate in chain:
            path = resolved.get((candidate["url"], candidate["kind"]))
            if path:
                entry["picture_path"] = path
                entry["picture_kind"] = candidate["kind"]
                break
        audio_key = (shot.get("audio_url"), "audio")
        audio_path = resolved.get(audio_key) if shot.get("audio_url") else None
        if audio_path:
            info = probe_map.get(audio_path) or {}
            if info and not info.get("has_audio"):
                warnings.append(f"分镜 #{shot['shot_index']} 的配音没有音轨，已跳过")
                audio_path = None
            elif info.get("duration"):
                entry["audio_duration"] = round(float(info["duration"]), 3)
                if float(entry["audio_duration"]) > float(shot["duration"]) + 0.05:
                    warnings.append(
                        f"分镜 #{shot['shot_index']} 配音 {entry['audio_duration']:.2f}s 超出镜头 "
                        f"{shot['duration']:.2f}s，超出部分已截断"
                    )
        entry["audio_path"] = audio_path
        if entry.get("picture_kind") == "video" and not audio_path and entry.get("picture_path"):
            info = video_probe_map.get(entry["picture_path"]) or {}
            if info.get("has_audio"):
                entry["video_audio"] = True
                entry["video_audio_duration"] = round(float(info.get("duration") or 0), 3)
        resolved_shots.append(entry)

    bgm_path = resolved.get((bgm_url, "audio")) if bgm_url else None
    if bgm_url and not bgm_path:
        warnings.append("BGM 素材不可用，已跳过音乐轨")
    if bgm_path:
        info = await tm.probe_media(bgm_path)
        if info and not info.get("has_audio"):
            warnings.append("BGM 素材没有音轨，已跳过音乐轨")
            bgm_path = None

    has_any_audio = bool(bgm_path) or any(
        s.get("audio_path") or s.get("video_audio") for s in resolved_shots
    )
    if not allow_silent and not has_any_audio:
        _cleanup(output_path)
        raise tm.TimelineMergeError(
            "没有可混入的音频：当前项目的镜头没有配音/视频原声，也没有 BGM。"
            "请先生成配音或绑定 BGM；确需静音成片请传 allow_silent=true。"
        )

    subtitle_file: Optional[str] = None
    subtitle_path: Optional[str] = None
    if subtitles and any(_text(s.get("subtitle")) for s in resolved_shots):
        width, height = tm.output_size(aspect_ratio)
        ass_name = f"subs_{uuid.uuid4().hex[:8]}.ass"
        subtitle_path = os.path.join(out_dir, ass_name)
        with open(subtitle_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(build_ass(resolved_shots, width, height))
        subtitle_file = ass_name

    total = round(sum(float(s["duration"]) for s in resolved_shots), 3)
    cmd = build_project_command(
        resolved_shots,
        output_path,
        aspect_ratio=aspect_ratio,
        bgm_path=bgm_path,
        bgm_volume=bgm_volume,
        subtitle_file=subtitle_file,
    )

    try:
        try:
            proc = await _run(cmd, timeout, out_dir)
        except subprocess.TimeoutExpired:
            _cleanup(output_path)
            raise tm.TimelineMergeError(f"合成超时（{timeout:.0f}s），请减少分镜或降低分辨率后重试")
        except OSError as e:
            _cleanup(output_path)
            raise tm.TimelineMergeError(f"无法启动 ffmpeg：{e}")

        if proc.returncode != 0 and subtitle_file and _looks_like_subtitle_error(proc.stderr):
            _cleanup(output_path)
            warnings.append("字幕烧录失败，已自动改为不带字幕导出")
            subtitle_file = None
            cmd = build_project_command(
                resolved_shots,
                output_path,
                aspect_ratio=aspect_ratio,
                bgm_path=bgm_path,
                bgm_volume=bgm_volume,
                subtitle_file=None,
            )
            try:
                proc = await _run(cmd, timeout, out_dir)
            except subprocess.TimeoutExpired:
                _cleanup(output_path)
                raise tm.TimelineMergeError(f"合成超时（{timeout:.0f}s），请减少分镜或降低分辨率后重试")
            except OSError as e:
                _cleanup(output_path)
                raise tm.TimelineMergeError(f"无法启动 ffmpeg：{e}")

        if proc.returncode != 0 or not os.path.exists(output_path):
            _cleanup(output_path)
            detail = _tail(proc.stderr) or f"ffmpeg 退出码 {proc.returncode}"
            raise tm.TimelineMergeError(f"ffmpeg 合成失败：{detail}")
    finally:
        _cleanup(subtitle_path)

    return {
        "status": "success",
        "output_path": os.path.abspath(output_path),
        "output_url": tm._to_url(output_path),
        "shots": len(resolved_shots),
        "duration": total,
        "size_bytes": os.path.getsize(output_path),
        "subtitles": bool(subtitle_file),
        "audio_tracks": sum(
            1 for s in resolved_shots if s.get("audio_path") or s.get("video_audio")
        ) + (1 if bgm_path else 0),
        "video_audio_tracks": sum(1 for s in resolved_shots if s.get("video_audio")),
        "warnings": warnings[:200],
        "engine": "ffmpeg",
    }
