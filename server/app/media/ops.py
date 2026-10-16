# -*- coding: utf-8 -*-
"""画布素材处理内核（REQ-toonflow-canvas）：截帧 / 提取音轨 / 音画分离 / 截取 / 变速 / 宫格切分 / 标记合成 / 探测。

语义对齐 Toonflow 的 videoProcessing.ts / audioProcessing.ts / imageGridSplit，但运行在后端：
- 输入 URL 统一经 `_local_source` 解析：`/storage/...`、`/exports/...`（含 `storage/...` 相对写法）、
  指回本机后端的 `http://127.0.0.1:xxxx/storage/...`、`data:` URI、storage/exports 内的本地绝对路径，
  以及外网 http(s)（先下载到临时目录，用完即删）。本地路径一律 realpath 后做围栏校验，
  不允许借这组接口读 storage/exports 以外的文件。
- 产物写到 `storage/generated/media_ops/<uuid>.<ext>`，返回 `/storage/generated/media_ops/...`，
  与生成源产物的 URL 口径一致（前端用 resolveMediaUrl 回源）。
- 子进程走线程（同 timeline_merge：Windows 的 Selector 事件循环不支持 asyncio 子进程），
  参数以数组传入、带超时；失败抛 MediaOpError（自带 HTTP 状态码 + 可读原因），由路由层原样转成 HTTPException。
- 原素材永远不被覆盖；产物写失败/校验失败时把半成品删掉。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import io
import ipaddress
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from app.core.config import settings


class MediaOpError(RuntimeError):
    """素材处理失败：status_code 决定 HTTP 状态（400 参数 / 404 素材缺失 / 422 素材不可处理 /
    429 并发已满 / 500 处理异常 / 503 ffmpeg 未就绪）。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ── 常量 ──────────────────────────────────────────────────
OUTPUT_PARTS = ("generated", "media_ops")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
AUDIO_FORMATS = ("m4a", "wav", "mp3")

PROBE_TIMEOUT = 30.0
FRAME_TIMEOUT = 90.0
AUDIO_TIMEOUT = 300.0
VIDEO_TIMEOUT = 900.0
DOWNLOAD_TIMEOUT = 120.0
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
MAX_INLINE_BYTES = 50 * 1024 * 1024
MAX_MASK_BYTES = 30 * 1024 * 1024
MIN_SPAN_SECONDS = 0.05
END_TOLERANCE = 0.05
SPEED_MIN, SPEED_MAX = 0.5, 2.0
GRID_MIN, GRID_MAX = 1, 6

# 并发闸门：截取/分离是满 CPU 的重编码，不能按点击数无界拉起 ffmpeg（同 timeline 的纯计数器口径，
# 不用 asyncio.Semaphore —— 模块级对象跨 TestClient / 多事件循环复用时会绑死 loop）。
MAX_INFLIGHT = 4
_inflight = 0

_FFMPEG_HINT = (
    "未检测到 ffmpeg：请安装后加入 PATH 再重启服务"
    "（conda base 可执行 `conda install -c conda-forge ffmpeg`，"
    "或下载官方构建解压后把 bin 目录加入系统 PATH）。"
)

_IMAGE_FORMAT_NAMES = {"image2", "gif", "apng"}


# ── 引擎自检 ──────────────────────────────────────────────
def _ffmpeg_exe() -> Optional[str]:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:  # 与 agent 附件抽帧同口径：系统 PATH 缺失时回退 imageio_ffmpeg 自带二进制
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _ffprobe_exe() -> Optional[str]:
    return shutil.which("ffprobe")


def _pillow_ready() -> bool:
    try:
        import PIL  # noqa: F401

        return True
    except Exception:
        return False


def engine_status() -> Dict[str, Any]:
    """前端据此决定截帧/截取等按钮是否可用（宫格切分、标记合成只依赖 Pillow）。"""
    ffmpeg = _ffmpeg_exe() is not None
    return {
        "ffmpeg": ffmpeg,
        "ffprobe": _ffprobe_exe() is not None,
        "pillow": _pillow_ready(),
        "ffmpeg_hint": "" if ffmpeg else _FFMPEG_HINT,
    }


def _require_ffmpeg() -> str:
    exe = _ffmpeg_exe()
    if not exe:
        raise MediaOpError(f"ffmpeg 未就绪，无法处理音视频。{_FFMPEG_HINT}", 503)
    return exe


def _pil():
    try:
        from PIL import Image, ImageChops, ImageFilter, ImageOps  # noqa: F401

        return Image, ImageChops, ImageFilter, ImageOps
    except Exception as e:  # Pillow 未打包进运行环境
        raise MediaOpError(f"Pillow 未安装，无法处理图片：{e}（pip install Pillow）", 503)


@contextlib.contextmanager
def _slot():
    """占一个处理槽；满了直接 429，避免狂点把机器打满。"""
    global _inflight
    if _inflight >= MAX_INFLIGHT:
        raise MediaOpError(f"素材处理任务过多（同时最多 {MAX_INFLIGHT} 个），请稍后再试", 429)
    _inflight += 1
    try:
        yield
    finally:
        _inflight -= 1


# ── 路径围栏与产物路径 ────────────────────────────────────
def _roots() -> Dict[str, str]:
    return {"/storage/": settings.STORAGE_DIR, "/exports/": settings.EXPORTS_DIR}


def _inside(root: str, target: str) -> bool:
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:  # 不同盘符
        return False


def _static_to_path(path: str) -> Optional[str]:
    """`/storage/x/y.png` → 本机真实路径（围栏校验 + URL 解码兜底）；前缀不认识返回 None。"""
    for prefix, root in _roots().items():
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix):]
        candidates = [rel]
        unq = urllib.parse.unquote(rel)
        if unq != rel:
            candidates.append(unq)
        for cand in candidates:
            parts = [p for p in cand.replace("\\", "/").split("/") if p not in ("", ".")]
            if not parts or any(p == ".." for p in parts):
                raise MediaOpError(f"素材路径非法：{path[:120]}", 400)
            target = os.path.realpath(os.path.join(root, *parts))
            if not _inside(root, target):
                raise MediaOpError(f"素材路径越出存储目录：{path[:120]}", 400)
            if os.path.isfile(target):
                return target
        raise MediaOpError(f"素材不存在：{path[:120]}", 404)
    return None


def _is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _output_dir() -> str:
    out = os.path.join(settings.STORAGE_DIR, *OUTPUT_PARTS)
    os.makedirs(out, exist_ok=True)
    return out


def _new_output(ext: str) -> Tuple[str, str]:
    """分配一个产物路径，返回 (本机路径, /storage URL)。"""
    ext = ext if ext.startswith(".") else f".{ext}"
    name = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(_output_dir(), name)
    return path, "/storage/" + "/".join(OUTPUT_PARTS) + "/" + name


def _cleanup(*paths: Optional[str]) -> None:
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


# ── 输入解析 ──────────────────────────────────────────────
_MIME_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/wave": ".wav", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac",
    "audio/ogg": ".ogg", "audio/flac": ".flac",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}


def _decode_data_uri(src: str, limit: int) -> Tuple[bytes, str]:
    head, sep, payload = src.partition(",")
    if not sep or not payload:
        raise MediaOpError("data URI 格式非法", 400)
    mime = head[5:].split(";")[0].strip().lower()
    try:
        if ";base64" in head.lower():
            if len(payload) > limit * 4 // 3 + 16:
                raise MediaOpError(f"内联素材超过 {limit // 1024 // 1024}MB 上限", 400)
            raw = base64.b64decode(payload, validate=False)
        else:
            raw = urllib.parse.unquote_to_bytes(payload)
    except (binascii.Error, ValueError) as e:
        raise MediaOpError(f"data URI 解码失败：{e}", 400)
    if len(raw) > limit:
        raise MediaOpError(f"内联素材超过 {limit // 1024 // 1024}MB 上限", 400)
    if not raw:
        raise MediaOpError("data URI 内容为空", 400)
    return raw, _MIME_EXT.get(mime, ".bin")


async def _download(url: str, dest_dir: str) -> str:
    import httpx

    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
    try:
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    raise MediaOpError(f"素材下载失败（HTTP {resp.status_code}）：{url[:120]}", 422)
                if not ext or len(ext) > 6:
                    ct = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                    ext = _MIME_EXT.get(ct, ".bin")
                path = os.path.join(dest_dir, f"src{ext}")
                total = 0
                with open(path, "wb") as f:
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_DOWNLOAD_BYTES:
                            raise MediaOpError(
                                f"素材超过 {MAX_DOWNLOAD_BYTES // 1024 // 1024}MB 下载上限：{url[:120]}", 400
                            )
                        f.write(chunk)
    except MediaOpError:
        raise
    except Exception as e:
        raise MediaOpError(f"素材下载失败：{type(e).__name__}: {e}"[:300], 422)
    if total <= 0:
        raise MediaOpError(f"下载到的素材为空：{url[:120]}", 422)
    return path


# REQ-toonflow-canvas 输入统一解析：/storage、本机回源 http、外网 http（下载）、data:、storage 内本地路径
@contextlib.asynccontextmanager
async def _local_source(url: Any, field: str = "url") -> AsyncIterator[str]:
    """把任意输入 URL 解析成本机可读文件路径；下载/内联落地的临时文件在退出时删除。"""
    raw = str(url or "").strip()
    if not raw:
        raise MediaOpError(f"{field} 不能为空", 400)
    tmpdir: Optional[str] = None
    try:
        low = raw.lower()
        if low.startswith("data:"):
            data, ext = _decode_data_uri(raw, MAX_INLINE_BYTES)
            tmpdir = tempfile.mkdtemp(prefix="mediaops_")
            path = os.path.join(tmpdir, f"src{ext}")
            with open(path, "wb") as f:
                f.write(data)
            yield path
            return
        if low.startswith(("http://", "https://")):
            parts = urllib.parse.urlsplit(raw)
            # 前端 dev 下会把 /storage 回源成 http://127.0.0.1:800x/storage/...：指回本机的直接走本地文件
            if _is_loopback(parts.hostname):
                local = _static_to_path(parts.path)
                if local:
                    yield local
                    return
            tmpdir = tempfile.mkdtemp(prefix="mediaops_")
            yield await _download(raw, tmpdir)
            return
        path = raw.replace("\\", "/")
        if path.startswith("file://"):
            path = urllib.parse.unquote(path[len("file://"):])
        elif path.startswith(("storage/", "exports/")):
            path = "/" + path
        if path.startswith(("/storage/", "/exports/")):
            local = _static_to_path(urllib.parse.urlsplit(path).path)
            if local:
                yield local
                return
        native = path if os.name != "nt" else path.replace("/", os.sep)
        if os.path.isabs(native):
            real = os.path.realpath(native)
            if not any(_inside(root, real) for root in _roots().values()):
                raise MediaOpError("本地素材路径必须在 storage/ 或 exports/ 之内", 400)
            if not os.path.isfile(real):
                raise MediaOpError(f"素材不存在：{raw[:120]}", 404)
            yield real
            return
        raise MediaOpError(f"无法识别的素材地址：{raw[:120]}", 400)
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ── 子进程 ────────────────────────────────────────────────
def _run_sync(cmd: List[str], timeout: float) -> subprocess.CompletedProcess:
    kwargs: Dict[str, Any] = {}
    if os.name == "nt":  # 打包态无控制台：别为每次 ffmpeg 闪一个黑框
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
        timeout=timeout, **kwargs,
    )


async def _run(cmd: List[str], timeout: float) -> subprocess.CompletedProcess:
    # 线程里跑同步 subprocess：Windows 下 uvicorn 的 Selector 事件循环不支持 asyncio 子进程
    return await asyncio.to_thread(_run_sync, cmd, timeout)


def _tail(raw: Any, limit: int = 400) -> str:
    text = raw.decode("utf-8", "ignore") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
    text = " ".join(text.split())
    return text[-limit:] if len(text) > limit else text


async def _ffmpeg(args: List[str], timeout: float, what: str, outputs: Tuple[str, ...] = ()) -> None:
    """跑一条 ffmpeg；失败时清掉半成品并抛可读错误。"""
    exe = _require_ffmpeg()
    cmd = [exe, "-y", "-hide_banner", "-nostdin", "-loglevel", "error", *args]
    try:
        proc = await _run(cmd, timeout)
    except subprocess.TimeoutExpired:
        _cleanup(*outputs)
        raise MediaOpError(f"{what}超时（>{timeout:.0f}s），请缩短素材后重试", 500)
    except OSError as e:
        _cleanup(*outputs)
        raise MediaOpError(f"无法启动 ffmpeg：{e}", 500)
    if proc.returncode != 0:
        _cleanup(*outputs)
        detail = _tail(proc.stderr) or f"ffmpeg 退出码 {proc.returncode}"
        raise MediaOpError(f"{what}失败：{detail}", 422)
    for out in outputs:
        if not os.path.isfile(out) or os.path.getsize(out) <= 0:
            _cleanup(*outputs)
            raise MediaOpError(f"{what}失败：未产出有效文件", 422)


# ── 探测 ──────────────────────────────────────────────────
def _num(value: Any) -> float:
    try:
        got = float(value)
    except (TypeError, ValueError):
        return 0.0
    if got != got or got in (float("inf"), float("-inf")) or got < 0:
        return 0.0
    return got


def _image_size(path: str) -> Optional[Tuple[int, int]]:
    try:
        Image, _, _, ImageOps = _pil()
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            return int(im.width), int(im.height)
    except MediaOpError:
        return None
    except Exception:
        return None


def _parse_ffprobe(data: Dict[str, Any]) -> Dict[str, Any]:
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = [
        s for s in streams
        if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")
    ]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    duration = _num(fmt.get("duration"))
    if duration <= 0:
        duration = max([_num(s.get("duration")) for s in streams] or [0.0])
    v0 = video[0] if video else {}
    return {
        "format_name": str(fmt.get("format_name") or ""),
        "duration": round(duration, 3),
        "width": int(v0.get("width") or 0),
        "height": int(v0.get("height") or 0),
        "has_video": bool(video),
        "has_audio": bool(audio),
        "video_index": v0.get("index") if video else None,
        "video_codec": str(v0.get("codec_name") or "") if video else "",
    }


_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VSTREAM_RE = re.compile(r"Stream #0:(\d+)[^:]*:\s*Video:\s*(\w+)[^\n]*?(\d{2,5})x(\d{2,5})")
_ASTREAM_RE = re.compile(r"Stream #0:\d+[^:]*:\s*Audio:")
_INPUT_FMT_RE = re.compile(r"Input #0,\s*([^,]+(?:,[^,\s]+)*?),\s*from")


async def _probe_via_ffmpeg(path: str) -> Dict[str, Any]:
    """没有 ffprobe 时的兜底：解析 `ffmpeg -i` 的横幅信息。"""
    exe = _require_ffmpeg()
    try:
        proc = await _run([exe, "-hide_banner", "-nostdin", "-i", path], PROBE_TIMEOUT)
    except Exception as e:
        raise MediaOpError(f"素材探测失败：{e}", 500)
    text = (proc.stderr or b"").decode("utf-8", "ignore")
    if "Input #0" not in text:
        raise MediaOpError(f"无法识别的媒体文件：{_tail(text, 200)}", 422)
    dur = 0.0
    m = _DUR_RE.search(text)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    vids = [v for v in _VSTREAM_RE.finditer(text) if "attached pic" not in text[v.start(): text.find("\n", v.start())]]
    fm = _INPUT_FMT_RE.search(text)
    v0 = vids[0] if vids else None
    return {
        "format_name": fm.group(1).strip() if fm else "",
        "duration": round(dur, 3),
        "width": int(v0.group(3)) if v0 else 0,
        "height": int(v0.group(4)) if v0 else 0,
        "has_video": bool(vids),
        "has_audio": bool(_ASTREAM_RE.search(text)),
        "video_index": int(v0.group(1)) if v0 else None,
        "video_codec": v0.group(2) if v0 else "",
    }


# REQ-toonflow-canvas 探测：ffprobe 优先，缺失时解析 ffmpeg 横幅；图片走 Pillow
async def _probe_path(path: str) -> Dict[str, Any]:
    """探测本机文件；返回含 kind（video/audio/image）的流信息。"""
    info: Optional[Dict[str, Any]] = None
    ffprobe = _ffprobe_exe()
    if ffprobe:
        cmd = [ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]
        try:
            proc = await _run(cmd, PROBE_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise MediaOpError("素材探测超时", 500)
        except OSError as e:
            raise MediaOpError(f"无法启动 ffprobe：{e}", 500)
        if proc.returncode == 0:
            try:
                info = _parse_ffprobe(json.loads((proc.stdout or b"{}").decode("utf-8", "ignore") or "{}"))
            except ValueError:
                info = None
    elif _ffmpeg_exe():
        try:
            info = await _probe_via_ffmpeg(path)
        except MediaOpError:
            info = None

    fmt = (info or {}).get("format_name", "")
    looks_image = (
        not info
        or fmt in _IMAGE_FORMAT_NAMES
        or fmt.endswith("_pipe")
        or (info.get("has_video") and not info.get("has_audio") and info.get("duration", 0) <= 0)
    )
    if looks_image:
        size = await asyncio.to_thread(_image_size, path)
        if size:
            return {
                "kind": "image", "duration": 0.0, "width": size[0], "height": size[1],
                "has_video": False, "has_audio": False, "video_index": None, "video_codec": "",
                "format_name": fmt,
            }
    if not info or not (info.get("has_video") or info.get("has_audio")):
        if not ffprobe and not _ffmpeg_exe():
            raise MediaOpError(f"ffmpeg 未就绪，无法探测音视频。{_FFMPEG_HINT}", 503)
        raise MediaOpError("无法识别的媒体文件（不含音视频流）", 422)
    info["kind"] = "video" if info.get("has_video") else "audio"
    return info


def _public_probe(info: Dict[str, Any], path: str) -> Dict[str, Any]:
    return {
        "kind": info.get("kind"),
        "duration": info.get("duration", 0.0),
        "width": info.get("width", 0),
        "height": info.get("height", 0),
        "has_audio": bool(info.get("has_audio")),
        "has_video": bool(info.get("has_video")),
        "size_bytes": os.path.getsize(path) if os.path.isfile(path) else 0,
    }


async def probe(url: str) -> Dict[str, Any]:
    """探测素材：{kind, duration, width, height, has_audio, has_video, size_bytes}。"""
    async with _local_source(url, "url") as path:
        info = await _probe_path(path)
        return _public_probe(info, path)


# ── 编码参数 ──────────────────────────────────────────────
def _audio_codec_args(fmt: str) -> List[str]:
    if fmt == "wav":
        return ["-c:a", "pcm_s16le"]
    if fmt == "mp3":
        return ["-c:a", "libmp3lame", "-q:a", "2"]
    return ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]


# 重编码到 H.264：奇数边长只补齐到偶数（不拉伸），兼容所有播放器
_VIDEO_ENCODE = [
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
]


def _audio_format(fmt: Optional[str], source_path: Optional[str] = None) -> str:
    """显式 format 优先；否则源是 wav 就保持 wav（TTS 参考音频多要 wav），其余统一 m4a(AAC)。"""
    if fmt is not None and str(fmt).strip():
        f = str(fmt).strip().lower().lstrip(".")
        if f not in AUDIO_FORMATS:
            raise MediaOpError(f"不支持的音频格式「{fmt}」：仅支持 {', '.join(AUDIO_FORMATS)}", 400)
        return f
    if source_path and os.path.splitext(source_path)[1].lower() == ".wav":
        return "wav"
    return "m4a"


def _seconds(value: Any, field: str) -> float:
    try:
        got = float(value)
    except (TypeError, ValueError):
        raise MediaOpError(f"{field} 必须是数字（秒）", 400)
    if got != got or got in (float("inf"), float("-inf")):
        raise MediaOpError(f"{field} 必须是有限数字", 400)
    return got


def _fmt_secs(value: float) -> str:
    return f"{max(0.0, value):.3f}"


async def _audio_result(path: str, url: str, what: str) -> Dict[str, Any]:
    info = await _probe_path(path)
    if not info.get("has_audio") or info.get("duration", 0) <= 0:
        _cleanup(path)
        raise MediaOpError(f"{what}失败：生成的音频无效", 422)
    return {"url": url, "kind": "audio", "duration": info["duration"], "size_bytes": os.path.getsize(path)}


async def _video_result(path: str, url: str, what: str) -> Dict[str, Any]:
    info = await _probe_path(path)
    if not info.get("has_video") or info.get("duration", 0) <= 0:
        _cleanup(path)
        raise MediaOpError(f"{what}失败：生成的视频无效", 422)
    return {
        "url": url, "kind": "video", "duration": info["duration"],
        "width": info["width"], "height": info["height"], "has_audio": bool(info.get("has_audio")),
        "size_bytes": os.path.getsize(path),
    }


def _need_video(info: Dict[str, Any]) -> None:
    if info.get("kind") != "video":
        raise MediaOpError("素材不包含视频画面", 422)


# ── 截帧 ──────────────────────────────────────────────────
_AT_ALIASES = {"first": "first", "last": "last", "time": "time", "current": "time"}


async def _grab_last_frame(src: str, info: Dict[str, Any], out: str) -> None:
    duration = float(info.get("duration") or 0)
    vmap = ["-map", f"0:{info['video_index']}"] if info.get("video_index") is not None else []
    # 从结尾前 1s 起解码并不断覆盖同一张图，最后留下的就是末帧（比 -sseof 对短片/无时长素材更稳）
    seek = ["-ss", _fmt_secs(duration - 1.0)] if duration > 1.0 else []
    await _ffmpeg([*seek, "-i", src, *vmap, "-an", "-update", "1", out], FRAME_TIMEOUT, "截取尾帧", (out,))


# REQ-toonflow-canvas 视频节点「截帧」（当前/首/尾帧 → 图片节点）
async def extract_frame(video_url: str, at: str = "first", time: Optional[float] = None) -> Dict[str, Any]:
    """截帧 → PNG。at: first | last | time（别名 current，配合 time 秒数）。"""
    mode = _AT_ALIASES.get(str(at or "first").strip().lower())
    if not mode:
        raise MediaOpError(f"at 只能是 first / last / time（current）：{at}", 400)
    t = 0.0
    if mode == "time":
        if time is None:
            raise MediaOpError("at=time 时必须提供 time（秒）", 400)
        t = _seconds(time, "time")
        if t < 0:
            raise MediaOpError("time 不能为负数", 400)
    with _slot():
        async with _local_source(video_url, "video_url") as src:
            info = await _probe_path(src)
            _need_video(info)
            duration = float(info.get("duration") or 0)
            if mode == "time" and duration > 0:
                if t > duration + END_TOLERANCE:
                    raise MediaOpError(f"time 超出视频时长（{t:g}s > {duration:g}s）", 400)
                if t >= duration - END_TOLERANCE:
                    mode = "last"  # 播放头停在结尾：直接取末帧，避免 seek 越界拿不到帧
            out, url = _new_output(".png")
            vmap = ["-map", f"0:{info['video_index']}"] if info.get("video_index") is not None else []
            if mode == "last":
                await _grab_last_frame(src, info, out)
                used = duration
            else:
                seek = ["-ss", _fmt_secs(t)] if mode == "time" and t > 0 else []
                try:
                    await _ffmpeg([*seek, "-i", src, *vmap, "-an", "-frames:v", "1", "-update", "1", out],
                                  FRAME_TIMEOUT, "截帧", (out,))
                    used = t
                except MediaOpError as e:
                    if mode != "time" or e.status_code != 422:
                        raise
                    # 时长元数据不准时 seek 可能落在最后一帧之后：退回取末帧
                    await _grab_last_frame(src, info, out)
                    mode, used = "last", duration
            size = await asyncio.to_thread(_image_size, out)
            if not size:
                _cleanup(out)
                raise MediaOpError("截帧失败：生成的图片无效", 422)
            return {
                "url": url, "kind": "image", "width": size[0], "height": size[1],
                "at": mode, "time": round(used, 3),
            }


# ── 音轨 ──────────────────────────────────────────────────
async def _extract_audio_from(src: str, info: Dict[str, Any], fmt: str) -> Dict[str, Any]:
    if not info.get("has_audio"):
        raise MediaOpError("该视频没有音轨", 422)
    out, url = _new_output(f".{fmt}")
    await _ffmpeg(["-i", src, "-map", "0:a:0", "-vn", *_audio_codec_args(fmt), out],
                  AUDIO_TIMEOUT, "提取音轨", (out,))
    return await _audio_result(out, url, "提取音轨")


# REQ-toonflow-canvas 视频节点「提取音轨」
async def extract_audio(video_url: str, format: Optional[str] = None) -> Dict[str, Any]:
    """提取音轨 → 音频（默认 m4a/AAC 192k，可选 wav/mp3）。"""
    fmt = _audio_format(format or "m4a")
    with _slot():
        async with _local_source(video_url, "video_url") as src:
            info = await _probe_path(src)
            _need_video(info)
            return await _extract_audio_from(src, info, fmt)


# REQ-toonflow-canvas 视频节点「分离音视频」（对齐 Toonflow processVideo separate）
async def split_av(video_url: str, format: Optional[str] = None) -> Dict[str, Any]:
    """音画分离 → {video_url（无声 MP4）, audio_url}；H.264 源直接拷贝视频流，其余重编码。"""
    fmt = _audio_format(format or "m4a")
    with _slot():
        async with _local_source(video_url, "video_url") as src:
            info = await _probe_path(src)
            _need_video(info)
            if not info.get("has_audio"):
                raise MediaOpError("该视频没有音轨，无需分离", 422)
            vmap = ["-map", f"0:{info['video_index']}"] if info.get("video_index") is not None else ["-map", "0:v:0"]
            vout, vurl = _new_output(".mp4")
            copied = False
            if info.get("video_codec") == "h264":
                try:
                    await _ffmpeg(["-i", src, *vmap, "-an", "-c:v", "copy", "-movflags", "+faststart", vout],
                                  VIDEO_TIMEOUT, "分离画面", (vout,))
                    copied = True
                except MediaOpError as e:
                    if e.status_code != 422:
                        raise
            if not copied:
                await _ffmpeg(["-i", src, *vmap, "-an", *_VIDEO_ENCODE, "-movflags", "+faststart", vout],
                              VIDEO_TIMEOUT, "分离画面", (vout,))
            try:
                video = await _video_result(vout, vurl, "分离画面")
                audio = await _extract_audio_from(src, info, fmt)
            except MediaOpError:
                _cleanup(vout)
                raise
            return {
                "video_url": video["url"], "audio_url": audio["url"],
                "video": video, "audio": audio,
            }


# ── 截取 ──────────────────────────────────────────────────
# REQ-toonflow-canvas 视频/音频节点「截取片段」（对齐 Toonflow processVideo trim / processAudio clip）
async def trim(url: str, start: Any, end: Any, format: Optional[str] = None) -> Dict[str, Any]:
    """截取 [start, end) 秒 → 同类型媒体（视频重编码 H.264+AAC 的 MP4；音频默认保持 wav 或转 m4a）。"""
    s = _seconds(start, "start")
    e = _seconds(end, "end")
    if s < 0 or e <= s:
        raise MediaOpError("截取范围须满足 0 ≤ start < end", 400)
    with _slot():
        async with _local_source(url, "url") as src:
            info = await _probe_path(src)
            if info.get("kind") == "image":
                raise MediaOpError("图片不能截取，仅支持视频或音频", 400)
            duration = float(info.get("duration") or 0)
            if duration > 0:
                if e > duration + END_TOLERANCE:
                    raise MediaOpError(f"截取范围须满足 0 ≤ start < end ≤ 时长（{duration:g}s）", 400)
                e = min(e, duration)
                if s >= duration:
                    raise MediaOpError(f"start 超出素材时长（{duration:g}s）", 400)
            span = e - s
            if span < MIN_SPAN_SECONDS:
                raise MediaOpError(f"截取片段过短（{span:.3f}s，至少 {MIN_SPAN_SECONDS}s）", 400)
            seek = ["-ss", _fmt_secs(s)] if s > 0 else []
            if info.get("kind") == "video":
                if format:
                    raise MediaOpError("视频截取固定输出 mp4，不支持 format 参数", 400)
                vmap = ["-map", f"0:{info['video_index']}"] if info.get("video_index") is not None else ["-map", "0:v:0"]
                out, out_url = _new_output(".mp4")
                await _ffmpeg(
                    [*seek, "-i", src, "-t", _fmt_secs(span), *vmap, "-map", "0:a:0?", *_VIDEO_ENCODE,
                     "-c:a", "aac", "-b:a", "192k", "-avoid_negative_ts", "make_zero",
                     "-movflags", "+faststart", out],
                    VIDEO_TIMEOUT, "截取视频", (out,),
                )
                result = await _video_result(out, out_url, "截取视频")
            else:
                fmt = _audio_format(format, src)
                out, out_url = _new_output(f".{fmt}")
                await _ffmpeg(
                    [*seek, "-i", src, "-t", _fmt_secs(span), "-map", "0:a:0", "-vn", *_audio_codec_args(fmt), out],
                    AUDIO_TIMEOUT, "截取音频", (out,),
                )
                result = await _audio_result(out, out_url, "截取音频")
            result.update({"start": round(s, 3), "end": round(e, 3)})
            return result


# ── 变速 ──────────────────────────────────────────────────
def atempo_chain(rate: float) -> str:
    """atempo 单级只保证 0.5–2.0 精度：超出时拆成多级（同 Toonflow audioProcessing）。"""
    filters: List[str] = []
    tempo = float(rate)
    while tempo < 0.5:
        filters.append("atempo=0.5")
        tempo /= 0.5
    while tempo > 2.0:
        filters.append("atempo=2.0")
        tempo /= 2.0
    filters.append(f"atempo={tempo:.6g}")
    return ",".join(filters)


# REQ-toonflow-canvas 音频节点「变速」（atempo 链，保持音高）
async def speed(audio_url: str, rate: Any, format: Optional[str] = None) -> Dict[str, Any]:
    """音频变速（保持音高）0.5–2.0 倍 → 音频；视频输入时只取其音轨。"""
    r = _seconds(rate, "rate")
    if r < SPEED_MIN or r > SPEED_MAX:
        raise MediaOpError(f"rate 须在 {SPEED_MIN}–{SPEED_MAX} 之间", 400)
    with _slot():
        async with _local_source(audio_url, "audio_url") as src:
            info = await _probe_path(src)
            if not info.get("has_audio"):
                raise MediaOpError("素材不包含音轨", 422)
            fmt = _audio_format(format, src)
            out, url = _new_output(f".{fmt}")
            await _ffmpeg(["-i", src, "-map", "0:a:0", "-vn", "-filter:a", atempo_chain(r),
                           *_audio_codec_args(fmt), out], AUDIO_TIMEOUT, "音频变速", (out,))
            result = await _audio_result(out, url, "音频变速")
            result["rate"] = r
            return result


# ── 图片：宫格切分 / 标记合成 ─────────────────────────────
def _open_image(path: str):
    Image, _, _, ImageOps = _pil()
    try:
        # with 块内转出独立副本再关闭文件句柄：Windows 上句柄不释放会让临时下载目录删不掉
        with Image.open(path) as src:
            if getattr(src, "is_animated", False):
                src.seek(0)
            src.load()
            # 浏览器按 EXIF 方向显示，切分/标记都以用户看到的方向为准
            im = ImageOps.exif_transpose(src)
            has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
            return im.convert("RGBA" if has_alpha else "RGB")
    except MediaOpError:
        raise
    except Exception as e:
        raise MediaOpError(f"无法读取图片：{e}", 422)


def _int_in(value: Any, field: str, lo: int, hi: int) -> int:
    try:
        got = int(value)
    except (TypeError, ValueError):
        raise MediaOpError(f"{field} 必须是整数", 400)
    if isinstance(value, float) and value != got:
        raise MediaOpError(f"{field} 必须是整数", 400)
    if got < lo or got > hi:
        raise MediaOpError(f"{field} 须在 {lo}–{hi} 之间", 400)
    return got


def _split_sync(src: str, rows: int, cols: int) -> List[Dict[str, Any]]:
    im = _open_image(src)
    w, h = im.size
    if w < cols or h < rows:
        raise MediaOpError(f"图片太小（{w}×{h}），无法切成 {rows}×{cols}", 400)
    tiles: List[Dict[str, Any]] = []
    written: List[str] = []
    try:
        for r in range(rows):
            for c in range(cols):
                box = (round(c * w / cols), round(r * h / rows), round((c + 1) * w / cols), round((r + 1) * h / rows))
                tile = im.crop(box)
                out, url = _new_output(".png")
                tile.save(out, format="PNG")
                written.append(out)
                tiles.append({
                    "url": url, "index": r * cols + c, "row": r, "col": c,
                    "width": tile.width, "height": tile.height,
                })
    except Exception:
        _cleanup(*written)
        raise
    return tiles


# REQ-toonflow-canvas 图片节点「宫格切分」（生成多个图片节点）
async def grid_split(image_url: str, rows: Any, cols: Any) -> Dict[str, Any]:
    """宫格切分 rows×cols（各 1–6）→ 按行优先排列的 PNG 列表。"""
    r = _int_in(rows, "rows", GRID_MIN, GRID_MAX)
    c = _int_in(cols, "cols", GRID_MIN, GRID_MAX)
    _pil()
    with _slot():
        async with _local_source(image_url, "image_url") as src:
            tiles = await asyncio.to_thread(_split_sync, src, r, c)
    return {"rows": r, "cols": c, "images": tiles, "urls": [t["url"] for t in tiles]}


_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")


def _parse_color(value: Optional[str]) -> Tuple[int, int, int]:
    m = _HEX_RE.match(str(value or "#ff3b30").strip())
    if not m:
        raise MediaOpError(f"color 须是 #RRGGBB：{value}", 400)
    h = m.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _decode_mask(mask_png: Any) -> bytes:
    raw = str(mask_png or "").strip()
    if not raw:
        raise MediaOpError("mask_png 不能为空", 400)
    if raw.lower().startswith("data:"):
        data, _ = _decode_data_uri(raw, MAX_MASK_BYTES)
        return data
    if len(raw) > MAX_MASK_BYTES * 4 // 3 + 16:
        raise MediaOpError(f"遮罩超过 {MAX_MASK_BYTES // 1024 // 1024}MB 上限", 400)
    try:
        return base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as e:
        raise MediaOpError(f"mask_png 不是合法的 base64：{e}", 400)


def _compose_sync(src: str, mask_bytes: bytes, opacity: float, color: Tuple[int, int, int]) -> Dict[str, Any]:
    Image, ImageChops, ImageFilter, _ = _pil()
    try:
        mask_img = Image.open(io.BytesIO(mask_bytes))
        mask_img.load()
    except Exception as e:
        raise MediaOpError(f"mask_png 不是有效的图片：{e}", 400)
    base = _open_image(src).convert("RGBA")
    w, h = base.size

    # 遮罩口径：带透明通道 → alpha>0 即标记区；全不透明（黑底白笔）→ 亮度>0 即标记区
    has_alpha = mask_img.mode in ("RGBA", "LA") or (mask_img.mode == "P" and "transparency" in mask_img.info)
    alpha = mask_img.convert("RGBA").getchannel("A") if has_alpha else None
    if alpha is None or alpha.getextrema() == (255, 255):
        alpha = mask_img.convert("L")
    threshold = 0
    if alpha.size != (w, h):  # 前端按显示尺寸画的遮罩：拉伸到原图尺寸
        alpha = alpha.resize((w, h), Image.BILINEAR)
        threshold = 16
    binary = alpha.point(lambda v: 255 if v > threshold else 0)
    if binary.getbbox() is None:
        raise MediaOpError("遮罩为空：请先在图片上涂抹要重绘的区域", 400)

    fill = Image.new("RGBA", (w, h), color + (0,))
    fill.putalpha(binary.point(lambda v: int(v * opacity)))
    out_img = Image.alpha_composite(base, fill)

    # 描边：在 ≤1024 的缩略尺度上找边并膨胀，再放大回原尺寸 —— 线宽随图片尺寸等比，且大图也不慢
    scale = min(1.0, 1024.0 / max(w, h))
    sw, sh = max(1, round(w * scale)), max(1, round(h * scale))
    small = binary.resize((sw, sh), Image.BILINEAR).point(lambda v: 255 if v > 127 else 0)
    edge = small.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 0 else 0)
    edge = edge.filter(ImageFilter.MaxFilter(3))
    outline = edge.resize((w, h), Image.BILINEAR).point(lambda v: 255 if v > 64 else 0)
    line = Image.new("RGBA", (w, h), color + (255,))
    line.putalpha(outline)
    out_img = Image.alpha_composite(out_img, line)

    out, url = _new_output(".png")
    mask_out, mask_url = _new_output(".png")
    try:
        out_img.save(out, format="PNG")
        binary.save(mask_out, format="PNG")  # 白=重绘区、黑=保留；给支持真遮罩的生成源用
    except Exception as e:
        _cleanup(out, mask_out)
        raise MediaOpError(f"保存标记图失败：{e}", 500)
    marked = binary.histogram()[255]
    return {
        "url": url, "kind": "image", "width": w, "height": h,
        "mask_url": mask_url, "mask_ratio": round(marked / float(w * h), 4),
    }


# REQ-toonflow-canvas 图片节点「局部重绘」标记参考图
async def compose_mask(image_url: str, mask_png: Any, opacity: Any = 0.45, color: Optional[str] = None) -> Dict[str, Any]:
    """把遮罩叠到原图上（半透明色块 + 描边）→ 局部重绘的参考图；同时产出二值遮罩 mask_url。"""
    op = _seconds(0.45 if opacity is None else opacity, "opacity")
    if op < 0.1 or op > 0.9:
        raise MediaOpError("opacity 须在 0.1–0.9 之间", 400)
    rgb = _parse_color(color)
    mask_bytes = _decode_mask(mask_png)
    _pil()
    with _slot():
        async with _local_source(image_url, "image_url") as src:
            return await asyncio.to_thread(_compose_sync, src, mask_bytes, op, rgb)


__all__ = [
    "MediaOpError",
    "atempo_chain",
    "compose_mask",
    "engine_status",
    "extract_audio",
    "extract_frame",
    "grid_split",
    "probe",
    "speed",
    "split_av",
    "trim",
]
