# -*- coding: utf-8 -*-
"""画布时间线节点·合片内核（ffmpeg 探测式可选依赖）。

职责单一：把前端时间线的片段列表（含入出点裁剪）合成为一条 MP4。

设计取舍：
- **走 filter_complex 而非 concat demuxer**：产品要的是「片段级入出点裁剪」，
  concat demuxer 只能整文件首尾相连；每段 trim + 统一缩放 + concat 是唯一正解。
- **不硬依赖探测库**：时长由前端 video 元数据给出，这里只做防御性钳制；
  ffprobe 在场时用它判断「有没有音轨」，不在场时一律补静音轨（宁丢音轨不整体失败），
  并在结果里显式警告，不静默吞掉。
- **不做免重编码快路径**：不同生成源（Kling/Seedance/Wan/ComfyUI）出来的编码参数
  几乎必然不一致，`-c copy` 拼接会失败或产出坏帧；统一 `-preset veryfast` 重编码更稳。
- 所有输入路径 realpath 后必须落在 storage/exports 之内，参数以数组传子进程，
  绝不拼接 shell 字符串。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings


class TimelineMergeError(RuntimeError):
    """合片失败（可读原因，前端直接展示）。"""


VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
ALLOWED_EXTS = VIDEO_EXTS | AUDIO_EXTS

MAX_CLIPS = 60
MAX_TOTAL_SECONDS = 1800.0
MIN_CLIP_SECONDS = 0.4
AUDIO_RATE = 44100
TARGET_FPS = 30
DEFAULT_TIMEOUT = 1800.0
PROBE_TIMEOUT = 30.0

_FFMPEG_HINT = (
    "未检测到 ffmpeg：请安装后加入 PATH 再重启服务"
    "（conda base 可执行 `conda install -c conda-forge ffmpeg`，"
    "或下载官方构建解压后把 bin 目录加入系统 PATH）。"
)
_DRAFT_HINT = "当前可改用「导出到剪映草稿」，在剪映客户端内完成成片。"
_NO_FFMPEG_MSG = f"ffmpeg 未就绪，无法合成 MP4。{_FFMPEG_HINT} {_DRAFT_HINT}"


# ── 引擎自检 ──────────────────────────────────────────────
def has_binary(name: str) -> bool:
    return shutil.which(name) is not None


def engine_status() -> Dict[str, Any]:
    """供前端在点击导出前判断引擎是否可用（ffmpeg 合片 + 剪映草稿两个出口）。"""
    ffmpeg = has_binary("ffmpeg")
    ffprobe = has_binary("ffprobe")
    jianyin = False
    jianyin_error: Optional[str] = None
    try:
        from app.pipelines.jianyin_exporter import engine_status as _jy_status

        jy = _jy_status() or {}
        jianyin = bool(jy.get("installed"))
        jianyin_error = jy.get("error")
    except Exception as e:  # 剪映引擎 import 失败不应影响合片自检
        jianyin_error = f"{type(e).__name__}: {e}"
    return {
        "ffmpeg": ffmpeg,
        "ffprobe": ffprobe,
        "jianyin": jianyin,
        "jianyin_error": jianyin_error,
        "available": ffmpeg,
        "ffmpeg_hint": "" if ffmpeg else _FFMPEG_HINT,
        "draft_hint": "" if jianyin else _DRAFT_HINT,
    }


# ── 路径围栏 ──────────────────────────────────────────────
def _roots() -> Dict[str, str]:
    return {"/storage/": settings.STORAGE_DIR, "/exports/": settings.EXPORTS_DIR}


def _inside(root: str, target: str) -> bool:
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:  # 不同盘符
        return False


def _inside_any_root(path: str) -> bool:
    return any(_inside(root, path) for root in _roots().values())


def static_path_for(url: str) -> str:
    """把 /storage/... 或 /exports/... 静态 URL 还原成本机真实路径并做围栏校验。"""
    raw = (url or "").strip()
    if not raw:
        raise TimelineMergeError("片段 url 为空")
    if raw.lower().startswith(("http://", "https://", "data:")):
        raise TimelineMergeError(f"网络/内联资源需先落盘到 storage 再合成：{raw[:80]}")
    path = raw.replace("\\", "/")
    ext = os.path.splitext(urllib.parse.urlparse(path).path)[1].lower()
    if ext not in ALLOWED_EXTS:
        raise TimelineMergeError(
            f"不支持的素材后缀「{ext or '（无）'}」：仅接受 {', '.join(sorted(ALLOWED_EXTS))}"
        )
    for prefix, root in _roots().items():
        if path.startswith(prefix):
            rel = path[len(prefix):]
            parts = [p for p in rel.split("/") if p not in ("", ".")]
            if not parts or any(p == ".." for p in parts):
                raise TimelineMergeError(f"素材路径非法：{raw[:120]}")
            target = os.path.realpath(os.path.join(root, *parts))
            if not _inside(root, target):
                raise TimelineMergeError(f"素材路径越出存储目录：{raw[:120]}")
            return target
    if os.path.isabs(path):
        real = os.path.realpath(path)
        if _inside_any_root(real):
            return real
        raise TimelineMergeError("素材路径必须在 storage/ 或 exports/ 之内")
    raise TimelineMergeError(f"无法识别的素材路径：{raw[:120]}")


def _to_url(path: str) -> str:
    real = os.path.realpath(path).replace("\\", "/")
    for prefix, root in _roots().items():
        root_real = os.path.realpath(root).replace("\\", "/").rstrip("/")
        if real.startswith(root_real + "/"):
            return prefix + real[len(root_real) + 1:]
    return real


# ── 片段规整 ──────────────────────────────────────────────
def _num(value: Any, default: float = 0.0) -> float:
    try:
        got = float(value)
    except (TypeError, ValueError):
        return default
    if got != got or got in (float("inf"), float("-inf")):  # NaN / inf
        return default
    return got


def _secs(value: float) -> str:
    return f"{value:g}"


def normalize_clips(raw_clips: Any) -> List[Dict[str, Any]]:
    """校验并规整片段：越界 in/out 宽容钳制，非法项明确拒绝。"""
    if not isinstance(raw_clips, list) or not raw_clips:
        raise TimelineMergeError("没有可合成的片段：请先从上游连入视频，或添加素材")
    if len(raw_clips) > MAX_CLIPS:
        raise TimelineMergeError(f"片段数量超过上限（最多 {MAX_CLIPS} 段）")

    out: List[Dict[str, Any]] = []
    total = 0.0
    for i, c in enumerate(raw_clips):
        if not isinstance(c, dict):
            raise TimelineMergeError(f"第 {i + 1} 段片段格式不正确")
        url = str(c.get("url") or "").strip()
        if not url:
            raise TimelineMergeError(f"第 {i + 1} 段片段缺少 url")
        path = static_path_for(url)
        if not os.path.isfile(path):
            raise TimelineMergeError(f"第 {i + 1} 段素材不存在：{url[:120]}")

        kind = "audio" if str(c.get("kind") or "video").lower() == "audio" else "video"
        if kind == "video" and os.path.splitext(path)[1].lower() in AUDIO_EXTS:
            kind = "audio"

        declared_duration = _num(c.get("duration"))
        cin = max(0.0, _num(c.get("in")))
        cout = _num(c.get("out"))
        duration = declared_duration if declared_duration > 0 else max(cout, 0.0)
        if duration > 0:
            cin = min(cin, duration)
        if cout <= 0:
            cout = duration
        if duration > 0:
            cout = min(cout, duration)
        span = round(cout - cin, 3)
        if span < MIN_CLIP_SECONDS:
            # 时长压根没探测到（链接失效 / 格式不受支持）与「用户自己裁太短」是两回事，
            # 分开报，前者要让用户去查素材本身，而不是去调入出点
            if declared_duration <= 0:
                raise TimelineMergeError(
                    f"第 {i + 1} 段素材时长未知（链接可能失效或格式不受支持），无法参与合成：{url[:80]}"
                )
            raise TimelineMergeError(
                f"第 {i + 1} 段裁剪后过短（{max(span, 0.0):.2f}s，最少 {MIN_CLIP_SECONDS}s）"
            )
        total += span
        out.append({
            "id": str(c.get("id") or f"clip_{i + 1}"),
            "url": url,
            "path": path,
            "name": str(c.get("name") or os.path.basename(path)),
            "kind": kind,
            "duration": round(duration, 3),
            "in": round(cin, 3),
            "out": round(cout, 3),
            "span": span,
        })

    if total > MAX_TOTAL_SECONDS:
        raise TimelineMergeError(
            f"总时长 {total:.1f}s 超过上限 {MAX_TOTAL_SECONDS:.0f}s，请拆分后再导出"
        )
    return out


# ── 命令构造 ──────────────────────────────────────────────
def output_size(aspect_ratio: Optional[str] = None) -> Tuple[int, int]:
    """成片画幅：竖屏 1080x1920 / 方屏 1080x1080 / 其余（含 16:9 与未知值）1920x1080。"""
    ratio = (aspect_ratio or "").strip()
    if ratio == "9:16":
        return (1080, 1920)
    if ratio == "1:1":
        return (1080, 1080)
    return (1920, 1080)


def build_ffmpeg_command(
    clips: List[Dict[str, Any]],
    probe_infos: List[Dict[str, Any]],
    output_path: str,
    *,
    aspect_ratio: Optional[str] = None,
    ffmpeg_bin: Optional[str] = None,
) -> List[str]:
    """构造合成命令。

    probe_infos 与 clips 索引对齐；探测失败传 {} 即可（按「无音轨」保守处理，
    补静音轨永远能合成成功，只是源素材自带音轨不参与）。
    """
    width, height = output_size(aspect_ratio)
    inputs: List[str] = []
    graph: List[str] = []
    segments: List[str] = []
    next_index = 0

    for n, clip in enumerate(clips):
        info = probe_infos[n] if n < len(probe_infos) and isinstance(probe_infos[n], dict) else {}
        span = _secs(float(clip["out"]) - float(clip["in"]))
        is_video = clip.get("kind") != "audio"
        has_video = bool(info.get("has_video")) if info else is_video
        has_audio = bool(info.get("has_audio")) if info else False

        main_index = next_index
        inputs += ["-i", clip["path"]]
        next_index += 1

        vlabel, alabel = f"v{n}", f"a{n}"
        if has_video:
            graph.append(
                f"[{main_index}:v]trim=start={_secs(float(clip['in']))}:end={_secs(float(clip['out']))},"
                f"setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={TARGET_FPS},format=yuv420p[{vlabel}]"
            )
        else:
            inputs += ["-f", "lavfi", "-t", span, "-i", f"color=c=black:s={width}x{height}:r={TARGET_FPS}"]
            graph.append(
                f"[{next_index}:v]trim=start=0:end={span},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[{vlabel}]"
            )
            next_index += 1

        if has_audio:
            graph.append(
                f"[{main_index}:a]atrim=start={_secs(float(clip['in']))}:end={_secs(float(clip['out']))},"
                f"asetpts=PTS-STARTPTS,aresample={AUDIO_RATE},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[{alabel}]"
            )
        else:
            inputs += ["-f", "lavfi", "-t", span, "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
            graph.append(
                f"[{next_index}:a]atrim=start=0:end={span},asetpts=PTS-STARTPTS,"
                f"aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[{alabel}]"
            )
            next_index += 1

        segments += [f"[{vlabel}]", f"[{alabel}]"]

    count = len(clips)
    graph.append("".join(segments) + f"concat=n={count}:v=1:a=1[vo][ao]")

    return [
        ffmpeg_bin or "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        *inputs,
        "-filter_complex",
        ";".join(graph),
        "-map",
        "[vo]",
        "-map",
        "[ao]",
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
        output_path,
    ]


# ── 探测与合成 ────────────────────────────────────────────
def _run_sync(cmd: List[str], timeout: float) -> Any:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


async def _run(cmd: List[str], timeout: float) -> Any:
    """在**线程里**跑同步 subprocess。

    为什么不用 `asyncio.create_subprocess_exec`：Windows 上 uvicorn 用的是 Selector
    事件循环，它根本不支持子进程，调用会直接抛 `NotImplementedError` —— 真机表现为
    「合片任务提交成功、轮询却是 NotImplementedError: 」。线程方式对所有平台与事件
    循环实现都成立，也与仓库既有口径一致（jianyin_exporter / 打开目录 / 插件工具）。
    """
    try:
        return await asyncio.to_thread(_run_sync, cmd, timeout)
    except subprocess.TimeoutExpired as e:
        # subprocess.run 超时时已自行 kill 子进程，这里只需把语义换成 asyncio 超时
        raise asyncio.TimeoutError(str(e)) from e


async def probe_media(path: str) -> Dict[str, Any]:
    """ffprobe 探测流构成；ffprobe 缺失或异常时返回 {}（由调用方保守处理）。"""
    if not has_binary("ffprobe"):
        return {}
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]
    try:
        proc = await _run(cmd, PROBE_TIMEOUT)
        data = json.loads((proc.stdout or b"").decode("utf-8", "ignore") or "{}")
    except Exception:
        return {}
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    return {
        "has_video": any(s.get("codec_type") == "video" for s in streams),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "duration": _num(fmt.get("duration")),
    }


def _tail(raw: Any, limit: int = 500) -> str:
    text = raw.decode("utf-8", "ignore") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
    text = " ".join(text.split())
    return text[-limit:] if len(text) > limit else text


def _cleanup(path: str) -> None:
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


async def merge_clips(
    clips: Any,
    output_path: str,
    *,
    aspect_ratio: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """把片段合成为一条 MP4。失败一律抛 TimelineMergeError（含可读原因）。"""
    if not has_binary("ffmpeg"):
        raise TimelineMergeError(_NO_FFMPEG_MSG)

    norm = clips if (isinstance(clips, list) and clips and isinstance(clips[0], dict) and "path" in clips[0]) else normalize_clips(clips)

    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)
    if not _inside_any_root(output_path):
        raise TimelineMergeError("导出路径必须在 storage/ 或 exports/ 之内")

    warnings: List[str] = []
    if not has_binary("ffprobe"):
        warnings.append("未检测到 ffprobe：已为全部片段补静音轨，源素材自带音轨不参与合成")
    probes = [await probe_media(c["path"]) for c in norm]

    cmd = build_ffmpeg_command(norm, probes, output_path, aspect_ratio=aspect_ratio)
    _cleanup(output_path)
    try:
        proc = await _run(cmd, timeout)
    except asyncio.TimeoutError:
        _cleanup(output_path)
        raise TimelineMergeError(f"合成超时（>{timeout:.0f}s），请减少片段或降低分辨率后重试")
    except OSError as e:
        raise TimelineMergeError(f"无法启动 ffmpeg：{e}")

    if proc.returncode != 0 or not os.path.exists(output_path):
        _cleanup(output_path)
        detail = _tail(proc.stderr) or f"ffmpeg 退出码 {proc.returncode}"
        raise TimelineMergeError(f"ffmpeg 合成失败：{detail}")

    total = round(sum(float(c["span"]) for c in norm), 3)
    return {
        "status": "success",
        "output_path": os.path.abspath(output_path),
        "output_url": _to_url(output_path),
        "clips": len(norm),
        "duration": total,
        "size_bytes": os.path.getsize(output_path),
        "warnings": warnings,
    }
