# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas 素材处理接口 + 画布备份接口测试（pytest + fastapi TestClient）。

运行：cd server && python -m pytest -q tests/test_media_ops.py

素材全部现场生成：ffmpeg lavfi（testsrc + sine）出 2.5s 有声视频 / 2s 无声视频 / 3s wav，
Pillow 出 300×200 的 6 色块图；storage/exports 指到临时目录，绝不碰真实 storage。
本机没有 ffmpeg 时，音视频类用例 skip（图片类与备份接口照跑）。
"""
import base64
import functools
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.api.media_ops_routes import router as media_router  # noqa: E402
from app.api.project_routes import router as project_router  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.media import ops  # noqa: E402

API = "/api/v1"
HAS_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(
    not HAS_FFMPEG, reason="本机没有 ffmpeg：conda install -c conda-forge ffmpeg 或把官方构建 bin 加入 PATH"
)

# 6 色块：2 行 × 3 列，每块 100×100
BLOCK_COLORS = [
    [(255, 0, 0), (0, 255, 0), (0, 0, 255)],
    [(255, 255, 0), (0, 255, 255), (255, 0, 255)],
]


def _ff(*args):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True, capture_output=True)


@pytest.fixture(scope="module")
def env():
    root = tempfile.mkdtemp(prefix="media_ops_test_")
    storage = os.path.join(root, "storage")
    exports = os.path.join(root, "exports")
    fixtures = os.path.join(storage, "fixtures")
    os.makedirs(fixtures, exist_ok=True)
    os.makedirs(exports, exist_ok=True)
    saved = (settings.STORAGE_DIR, settings.EXPORTS_DIR)
    settings.STORAGE_DIR = storage
    settings.EXPORTS_DIR = exports

    img = Image.new("RGB", (300, 200))
    for r, row in enumerate(BLOCK_COLORS):
        for c, color in enumerate(row):
            img.paste(color, (c * 100, r * 100, (c + 1) * 100, (r + 1) * 100))
    img.save(os.path.join(fixtures, "blocks.png"))

    if HAS_FFMPEG:
        _ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "2.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            os.path.join(fixtures, "av.mp4"))
        _ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            os.path.join(fixtures, "silent.mp4"))
        _ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", "-c:a", "pcm_s16le",
            os.path.join(fixtures, "tone.wav"))

    app = FastAPI()
    app.include_router(media_router, prefix=API)
    app.include_router(project_router, prefix=API)
    client = TestClient(app)
    try:
        yield {"root": root, "storage": storage, "client": client}
    finally:
        settings.STORAGE_DIR, settings.EXPORTS_DIR = saved
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(autouse=True)
def _reset_inflight():
    ops._inflight = 0
    yield
    ops._inflight = 0


def _local(env, url):
    assert url.startswith("/storage/generated/media_ops/"), url
    path = os.path.join(env["storage"], url[len("/storage/"):])
    assert os.path.isfile(path), path
    return path


def _probe(env, url):
    res = env["client"].get(f"{API}/media/ops/probe", params={"url": url})
    assert res.status_code == 200, res.text
    return res.json()


# ── 探测 ──────────────────────────────────────────────────
@needs_ffmpeg
def test_probe_video_audio_image(env):
    v = _probe(env, "/storage/fixtures/av.mp4")
    assert v["kind"] == "video" and v["has_audio"] is True and v["has_video"] is True
    assert (v["width"], v["height"]) == (320, 240)
    assert 2.3 <= v["duration"] <= 2.7

    s = _probe(env, "/storage/fixtures/silent.mp4")
    assert s["kind"] == "video" and s["has_audio"] is False

    a = _probe(env, "/storage/fixtures/tone.wav")
    assert a["kind"] == "audio" and a["has_video"] is False and 2.9 <= a["duration"] <= 3.1

    i = _probe(env, "/storage/fixtures/blocks.png")
    assert i["kind"] == "image" and (i["width"], i["height"]) == (300, 200) and i["has_audio"] is False


@needs_ffmpeg
def test_probe_accepts_loopback_http_relative_and_absolute_paths(env):
    for url in (
        "http://127.0.0.1:8001/storage/fixtures/av.mp4",
        "http://localhost:5180/storage/fixtures/av.mp4?t=123",
        "storage/fixtures/av.mp4",
        os.path.join(env["storage"], "fixtures", "av.mp4"),
    ):
        assert _probe(env, url)["kind"] == "video", url


@needs_ffmpeg
def test_probe_without_ffprobe_falls_back_to_ffmpeg_banner(env, monkeypatch):
    """只有 ffmpeg、没有 ffprobe（部分 Windows 精简包）：靠解析 `ffmpeg -i` 横幅照样能探测与截帧。"""
    monkeypatch.setattr(ops, "_ffprobe_exe", lambda: None)
    v = _probe(env, "/storage/fixtures/av.mp4")
    assert v["kind"] == "video" and v["has_audio"] is True and (v["width"], v["height"]) == (320, 240)
    assert 2.3 <= v["duration"] <= 2.7
    assert _probe(env, "/storage/fixtures/tone.wav")["kind"] == "audio"
    assert _probe(env, "/storage/fixtures/silent.mp4")["has_audio"] is False
    assert _probe(env, "/storage/fixtures/blocks.png")["kind"] == "image"
    res = env["client"].post(f"{API}/media/ops/frame", json={"video_url": "/storage/fixtures/av.mp4", "at": "last"})
    assert res.status_code == 200, res.text


def test_probe_rejects_bad_inputs(env):
    c = env["client"]
    outside = os.path.join(env["root"], "outside.png")
    Image.new("RGB", (10, 10)).save(outside)
    cases = [
        ("/storage/../outside.png", 400),
        (outside, 400),
        ("/storage/fixtures/nope.mp4", 404),
        ("ftp://example.com/a.mp4", 400),
        ("", 400),
    ]
    for url, code in cases:
        res = c.get(f"{API}/media/ops/probe", params={"url": url})
        assert res.status_code == code, (url, res.status_code, res.text)
        assert res.json()["detail"]
    # 缺 url 参数：FastAPI 自身的 422
    assert c.get(f"{API}/media/ops/probe").status_code == 422


@needs_ffmpeg
def test_probe_downloads_remote_http(env):
    """非 /storage 的 http 地址走下载（用本机临时 http 服务模拟外网素材）。"""
    serve_dir = os.path.join(env["root"], "remote")
    os.makedirs(serve_dir, exist_ok=True)
    shutil.copy(os.path.join(env["storage"], "fixtures", "tone.wav"), os.path.join(serve_dir, "remote.wav"))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=serve_dir)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        got = _probe(env, f"{base}/remote.wav")
        assert got["kind"] == "audio"
        res = env["client"].get(f"{API}/media/ops/probe", params={"url": f"{base}/missing.wav"})
        assert res.status_code == 422 and "HTTP 404" in res.json()["detail"]
    finally:
        srv.shutdown()
        srv.server_close()


def test_engine_endpoint(env):
    body = env["client"].get(f"{API}/media/ops/engine").json()
    for key in ("ffmpeg", "ffprobe", "pillow", "ffmpeg_hint"):
        assert key in body
    assert body["pillow"] is True


# ── 截帧 ──────────────────────────────────────────────────
@needs_ffmpeg
def test_frame_first_last_time(env):
    c = env["client"]
    shots = {}
    for at, extra in (("first", {}), ("last", {}), ("time", {"time": 1.2}), ("current", {"time": 0.6})):
        res = c.post(f"{API}/media/ops/frame", json={"video_url": "/storage/fixtures/av.mp4", "at": at, **extra})
        assert res.status_code == 200, (at, res.text)
        body = res.json()
        assert body["status"] == "success" and body["kind"] == "image"
        assert (body["width"], body["height"]) == (320, 240)
        assert body["url"].endswith(".png")
        with Image.open(_local(env, body["url"])) as im:
            assert im.size == (320, 240)
            shots[at] = im.convert("RGB").tobytes()
    assert res.json()["at"] == "time" and res.json()["time"] == 0.6
    # testsrc 每帧有计数器/滚动图案：首帧、尾帧、中间帧必然不同
    assert shots["first"] != shots["last"]
    assert shots["time"] != shots["first"]


@needs_ffmpeg
def test_frame_time_at_end_falls_back_to_last(env):
    res = env["client"].post(f"{API}/media/ops/frame",
                             json={"video_url": "/storage/fixtures/silent.mp4", "at": "time", "time": 2.0})
    assert res.status_code == 200, res.text
    assert res.json()["at"] == "last"


@needs_ffmpeg
def test_frame_validation_errors(env):
    c = env["client"]
    cases = [
        ({"video_url": "/storage/fixtures/av.mp4", "at": "middle"}, 400),
        ({"video_url": "/storage/fixtures/av.mp4", "at": "time"}, 400),
        ({"video_url": "/storage/fixtures/av.mp4", "at": "time", "time": -1}, 400),
        ({"video_url": "/storage/fixtures/av.mp4", "at": "time", "time": 99}, 400),
        ({"video_url": "/storage/fixtures/tone.wav", "at": "first"}, 422),
        ({"video_url": "/storage/fixtures/blocks.png", "at": "first"}, 422),
        ({"video_url": "", "at": "first"}, 400),
    ]
    for payload, code in cases:
        res = c.post(f"{API}/media/ops/frame", json=payload)
        assert res.status_code == code, (payload, res.status_code, res.text)
        assert isinstance(res.json()["detail"], (str, list))


def test_frame_without_ffmpeg_returns_503_with_hint(env, monkeypatch):
    monkeypatch.setattr(ops, "_ffmpeg_exe", lambda: None)
    monkeypatch.setattr(ops, "_ffprobe_exe", lambda: None)
    # 用一个假视频文件：探测阶段就该因 ffmpeg 缺失 503，而不是 500 裸异常
    fake = os.path.join(env["storage"], "fixtures", "fake.mp4")
    with open(fake, "wb") as f:
        f.write(b"\x00" * 64)
    res = env["client"].post(f"{API}/media/ops/frame", json={"video_url": "/storage/fixtures/fake.mp4"})
    assert res.status_code == 503
    assert "ffmpeg" in res.json()["detail"] and "PATH" in res.json()["detail"]


def test_inflight_limit_returns_429(env):
    ops._inflight = ops.MAX_INFLIGHT
    res = env["client"].post(f"{API}/media/ops/grid-split",
                             json={"image_url": "/storage/fixtures/blocks.png", "rows": 2, "cols": 2})
    assert res.status_code == 429


# ── 音轨 ──────────────────────────────────────────────────
@needs_ffmpeg
def test_extract_audio_default_m4a_and_wav(env):
    c = env["client"]
    res = c.post(f"{API}/media/ops/extract-audio", json={"video_url": "/storage/fixtures/av.mp4"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["url"].endswith(".m4a") and body["kind"] == "audio"
    assert 2.2 <= body["duration"] <= 2.8
    _local(env, body["url"])
    p = _probe(env, body["url"])
    assert p["kind"] == "audio" and p["has_video"] is False

    res = c.post(f"{API}/media/ops/extract-audio", json={"video_url": "/storage/fixtures/av.mp4", "format": "wav"})
    assert res.status_code == 200 and res.json()["url"].endswith(".wav")

    res = c.post(f"{API}/media/ops/extract-audio", json={"video_url": "/storage/fixtures/av.mp4", "format": "ogg"})
    assert res.status_code == 400

    res = c.post(f"{API}/media/ops/extract-audio", json={"video_url": "/storage/fixtures/silent.mp4"})
    assert res.status_code == 422 and "音轨" in res.json()["detail"]


@needs_ffmpeg
def test_split_av(env):
    c = env["client"]
    res = c.post(f"{API}/media/ops/split-av", json={"video_url": "/storage/fixtures/av.mp4"})
    assert res.status_code == 200, res.text
    body = res.json()
    v = _probe(env, body["video_url"])
    a = _probe(env, body["audio_url"])
    assert v["kind"] == "video" and v["has_audio"] is False and (v["width"], v["height"]) == (320, 240)
    assert a["kind"] == "audio"
    assert body["video"]["has_audio"] is False and body["audio"]["duration"] > 2

    res = c.post(f"{API}/media/ops/split-av", json={"video_url": "/storage/fixtures/silent.mp4"})
    assert res.status_code == 422


# ── 截取 ──────────────────────────────────────────────────
@needs_ffmpeg
def test_trim_video_keeps_audio(env):
    res = env["client"].post(f"{API}/media/ops/trim", json={"url": "/storage/fixtures/av.mp4", "start": 0.5, "end": 1.5})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "video" and body["url"].endswith(".mp4")
    assert 0.85 <= body["duration"] <= 1.2, body
    assert body["has_audio"] is True and (body["width"], body["height"]) == (320, 240)
    assert (body["start"], body["end"]) == (0.5, 1.5)


@needs_ffmpeg
def test_trim_audio_keeps_wav_and_end_clamped(env):
    c = env["client"]
    res = c.post(f"{API}/media/ops/trim", json={"url": "/storage/fixtures/tone.wav", "start": 1, "end": 2})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "audio" and body["url"].endswith(".wav")
    assert 0.95 <= body["duration"] <= 1.05
    # 结尾稍超时长（播放器 currentTime 误差）宽容钳到时长
    res = c.post(f"{API}/media/ops/trim", json={"url": "/storage/fixtures/tone.wav", "start": 2.5, "end": 3.03})
    assert res.status_code == 200 and res.json()["end"] == 3.0
    res = c.post(f"{API}/media/ops/trim", json={"url": "/storage/fixtures/tone.wav", "start": 0, "end": 1, "format": "m4a"})
    assert res.status_code == 200 and res.json()["url"].endswith(".m4a")


@needs_ffmpeg
def test_trim_validation_errors(env):
    c = env["client"]
    cases = [
        {"url": "/storage/fixtures/av.mp4", "start": 1.5, "end": 1.0},
        {"url": "/storage/fixtures/av.mp4", "start": -1, "end": 1.0},
        {"url": "/storage/fixtures/av.mp4", "start": 0, "end": 30},
        {"url": "/storage/fixtures/av.mp4", "start": 1.0, "end": 1.01},
        {"url": "/storage/fixtures/av.mp4", "start": 0, "end": 1, "format": "wav"},
        {"url": "/storage/fixtures/blocks.png", "start": 0, "end": 1},
    ]
    for payload in cases:
        res = c.post(f"{API}/media/ops/trim", json=payload)
        assert res.status_code == 400, (payload, res.status_code, res.text)


# ── 变速 ──────────────────────────────────────────────────
def test_atempo_chain():
    assert ops.atempo_chain(1.5) == "atempo=1.5"
    assert ops.atempo_chain(0.5) == "atempo=0.5"
    assert ops.atempo_chain(4) == "atempo=2.0,atempo=2"
    assert ops.atempo_chain(0.25) == "atempo=0.5,atempo=0.5"


@needs_ffmpeg
def test_speed_changes_duration(env):
    c = env["client"]
    res = c.post(f"{API}/media/ops/speed", json={"audio_url": "/storage/fixtures/tone.wav", "rate": 2.0})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["url"].endswith(".wav") and 1.4 <= body["duration"] <= 1.6 and body["rate"] == 2.0

    res = c.post(f"{API}/media/ops/speed", json={"audio_url": "/storage/fixtures/tone.wav", "rate": 0.5, "format": "m4a"})
    assert res.status_code == 200, res.text
    assert res.json()["url"].endswith(".m4a") and 5.8 <= res.json()["duration"] <= 6.2

    # 视频输入：只取音轨
    res = c.post(f"{API}/media/ops/speed", json={"audio_url": "/storage/fixtures/av.mp4", "rate": 1.25})
    assert res.status_code == 200 and res.json()["url"].endswith(".m4a")

    for rate in (0.3, 2.5):
        res = c.post(f"{API}/media/ops/speed", json={"audio_url": "/storage/fixtures/tone.wav", "rate": rate})
        assert res.status_code == 400, rate
    res = c.post(f"{API}/media/ops/speed", json={"audio_url": "/storage/fixtures/silent.mp4", "rate": 1.5})
    assert res.status_code == 422


# ── 宫格切分 ──────────────────────────────────────────────
def test_grid_split_2x3(env):
    res = env["client"].post(f"{API}/media/ops/grid-split",
                             json={"image_url": "/storage/fixtures/blocks.png", "rows": 2, "cols": 3})
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["rows"], body["cols"]) == (2, 3) and len(body["images"]) == 6 and len(body["urls"]) == 6
    for tile in body["images"]:
        assert (tile["width"], tile["height"]) == (100, 100)
        assert tile["index"] == tile["row"] * 3 + tile["col"]
        with Image.open(_local(env, tile["url"])) as im:
            assert im.convert("RGB").getpixel((50, 50)) == BLOCK_COLORS[tile["row"]][tile["col"]]


def test_grid_split_uneven_and_data_uri(env):
    buf = io.BytesIO()
    Image.new("RGB", (101, 51), (10, 20, 30)).save(buf, format="PNG")
    data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    res = env["client"].post(f"{API}/media/ops/grid-split", json={"image_url": data_uri, "rows": 2, "cols": 2})
    assert res.status_code == 200, res.text
    tiles = res.json()["images"]
    assert sum(t["width"] for t in tiles if t["row"] == 0) == 101
    assert sum(t["height"] for t in tiles if t["col"] == 0) == 51


def test_grid_split_validation(env):
    c = env["client"]
    for rows, cols in ((0, 2), (7, 2), (2, 0), (2, 9)):
        res = c.post(f"{API}/media/ops/grid-split",
                     json={"image_url": "/storage/fixtures/blocks.png", "rows": rows, "cols": cols})
        assert res.status_code == 400, (rows, cols)
    bad = os.path.join(env["storage"], "fixtures", "broken.png")
    with open(bad, "wb") as f:
        f.write(b"not an image")
    res = c.post(f"{API}/media/ops/grid-split", json={"image_url": "/storage/fixtures/broken.png", "rows": 2, "cols": 2})
    assert res.status_code == 422


# ── 标记合成 ──────────────────────────────────────────────
def _mask_b64(size, rect, *, prefix=False, opaque_bw=False):
    if opaque_bw:
        m = Image.new("RGB", size, (0, 0, 0))
        m.paste((255, 255, 255), rect)
    else:
        m = Image.new("RGBA", size, (0, 0, 0, 0))
        m.paste((255, 255, 255, 255), rect)
    buf = io.BytesIO()
    m.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return ("data:image/png;base64," + b64) if prefix else b64


def test_compose_mask_overlay_outline_and_binary_mask(env):
    # 遮罩按一半尺寸画（模拟前端按显示尺寸涂抹）：左上 (0,0)-(50,50) → 原图 (0,0)-(100,100) 红块区域
    mask = _mask_b64((150, 100), (0, 0, 50, 50), prefix=True)
    res = env["client"].post(f"{API}/media/ops/compose-mask",
                             json={"image_url": "/storage/fixtures/blocks.png", "mask_png": mask, "color": "#0000ff"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["width"], body["height"]) == (300, 200)
    assert 0.14 <= body["mask_ratio"] <= 0.2  # 100×100 / 300×200 ≈ 0.167
    with Image.open(_local(env, body["url"])) as im:
        rgb = im.convert("RGB")
        inside = rgb.getpixel((40, 40))  # 红块被半透明蓝覆盖 → 偏紫
        assert inside[2] > 60 and inside[0] > 100
        assert rgb.getpixel((250, 150)) == (255, 0, 255)  # 远离标记区：原色不变
        edge = rgb.getpixel((100, 40))  # 标记边界上有实心描边
        assert edge == (0, 0, 255)
    with Image.open(_local(env, body["mask_url"])) as m:
        assert m.size == (300, 200)
        assert m.getpixel((40, 40)) == 255 and m.getpixel((250, 150)) == 0


def test_compose_mask_opaque_bw_mask_and_errors(env):
    c = env["client"]
    ok = c.post(f"{API}/media/ops/compose-mask", json={
        "image_url": "/storage/fixtures/blocks.png",
        "mask_png": _mask_b64((300, 200), (200, 100, 300, 200), opaque_bw=True),
    })
    assert ok.status_code == 200, ok.text
    assert 0.14 <= ok.json()["mask_ratio"] <= 0.2

    empty = _mask_b64((300, 200), (0, 0, 0, 0))
    cases = [
        ({"image_url": "/storage/fixtures/blocks.png", "mask_png": empty}, "遮罩为空"),
        ({"image_url": "/storage/fixtures/blocks.png", "mask_png": "@@@not-base64@@@"}, "mask_png"),
        ({"image_url": "/storage/fixtures/blocks.png", "mask_png": ""}, "mask_png"),
        ({"image_url": "/storage/fixtures/blocks.png", "mask_png": _mask_b64((10, 10), (0, 0, 5, 5)), "opacity": 1.5}, "opacity"),
        ({"image_url": "/storage/fixtures/blocks.png", "mask_png": _mask_b64((10, 10), (0, 0, 5, 5)), "color": "red"}, "color"),
    ]
    for payload, hint in cases:
        res = c.post(f"{API}/media/ops/compose-mask", json=payload)
        assert res.status_code == 400, (hint, res.status_code, res.text)
        assert hint in res.json()["detail"]


# ── 画布备份 ──────────────────────────────────────────────
@pytest.fixture()
def projects(env, monkeypatch):
    from app.api import project_routes
    from app.providers.project import manager as pm

    root = os.path.join(env["storage"], "projects")
    os.makedirs(root, exist_ok=True)
    monkeypatch.setattr(pm, "PROJECTS_ROOT", root)
    monkeypatch.setattr(pm, "INDEX_PATH", os.path.join(root, "index.json"))
    meta = pm.project_manager.create_project(title="备份测试")
    pm.project_manager.save_canvas(meta["id"], {"nodes": [{"id": "n1", "type": "text-prompt"}], "edges": []},
                                   canvas_id="cv_a", name="画布A")
    return {"pid": meta["id"], "root": root, "pm": pm, "routes": project_routes}


def _backup(env, pid, cid, body=None):
    url = f"{API}/projects/{pid}/canvases/{cid}/backup"
    return env["client"].post(url, json=body) if body is not None else env["client"].post(url)


def test_backup_stored_canvas(env, projects):
    res = _backup(env, projects["pid"], "cv_a")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"] == "stored" and body["created_at"]
    assert body["path"].startswith(f"projects/{projects['pid']}/canvas_backups/cv_a-")
    assert body["url"] == f"/storage/{body['path']}"
    with open(os.path.join(env["storage"], body["path"]), encoding="utf-8") as f:
        saved = json.load(f)
    assert saved["canvas_id"] == "cv_a" and saved["name"] == "画布A"
    assert saved["nodes"] == [{"id": "n1", "type": "text-prompt"}] and "updated_at" in saved

    # 同一秒内重复备份：文件名避让，不覆盖
    again = _backup(env, projects["pid"], "cv_a", {})
    assert again.status_code == 200 and again.json()["file"] != body["file"]


def test_backup_payload_and_errors(env, projects):
    raw = {"schema_version": 1, "nodes": [{"id": "x", "type": "video-legacy", "data": {"video_url": "/storage/v.mp4"}}],
           "edges": [{"source": "a", "target": "x", "targetHandle": "first_frame"}]}
    res = _backup(env, projects["pid"], "cv_new", {"canvas": raw})
    assert res.status_code == 200, res.text
    assert res.json()["source"] == "payload"
    with open(os.path.join(env["storage"], res.json()["path"]), encoding="utf-8") as f:
        assert json.load(f) == raw

    assert _backup(env, projects["pid"], "cv_missing").status_code == 404
    assert _backup(env, "proj_nope", "cv_a").status_code == 404
    assert _backup(env, projects["pid"], "cv_a", {"canvas": [1, 2]}).status_code == 400


def test_backup_sanitizes_name_and_prunes(env, projects, monkeypatch):
    monkeypatch.setattr(projects["routes"], "_CANVAS_BACKUP_KEEP", 3)
    # URL 编码的 ".." 进到路由里就是字面 ".."：文件名必须被清洗，不能穿越出 canvas_backups
    res = _backup(env, projects["pid"], "%2E%2E", {"canvas": {"nodes": []}})
    assert res.status_code == 200, res.text
    assert res.json()["file"].startswith("canvas-") and res.json()["canvas_id"] == ".."
    last = None
    for i in range(5):
        res = _backup(env, projects["pid"], "my canvas.v1", {"canvas": {"nodes": [], "seq": i}})
        assert res.status_code == 200, res.text
        assert res.json()["file"].startswith("my_canvas_v1-")
        last = res.json()["file"]
    bdir = os.path.join(projects["root"], projects["pid"], "canvas_backups")
    kept = [n for n in os.listdir(bdir) if n.startswith("my_canvas_v1-")]
    assert len(kept) == 3 and last in kept
    seqs = sorted(json.load(open(os.path.join(bdir, n), encoding="utf-8"))["seq"] for n in kept)
    assert seqs == [2, 3, 4]  # 留下的是最新的 3 份
    assert any(n.startswith("canvas-") for n in os.listdir(bdir))  # 别的画布的备份不受清理波及


def test_backup_legacy_single_canvas(env, projects):
    pid = projects["pid"]
    with open(os.path.join(projects["root"], pid, "canvas.json"), "w", encoding="utf-8") as f:
        json.dump({"nodes": [{"id": "old"}], "edges": []}, f)
    res = _backup(env, pid, "default")
    assert res.status_code == 200, res.text
    with open(os.path.join(env["storage"], res.json()["path"]), encoding="utf-8") as f:
        assert json.load(f)["nodes"] == [{"id": "old"}]
    assert _backup(env, pid, "cv_a").status_code == 404


# ── 画布条目保留 schema_version 等未知顶层键（T4 迁移写 schema_version: 2） ──────
def test_save_canvas_keeps_schema_version_and_unknown_keys(env, projects):
    pm, pid = projects["pm"], projects["pid"]
    mgr = pm.project_manager
    mgr.save_canvas(pid, {"nodes": [{"id": "n1"}], "edges": [], "schema_version": 2,
                          "viewport": {"x": 1, "y": 2, "zoom": 0.5}, "project_id": pid, "version": 9},
                    canvas_id="cv_a")
    got = mgr.get_canvas(pid, canvas_id="cv_a")
    assert got["schema_version"] == 2 and got["viewport"] == {"x": 1, "y": 2, "zoom": 0.5}
    assert got["name"] == "画布A"  # 未传 name：沿用已存名称
    with open(os.path.join(projects["root"], pid, "canvas.json"), encoding="utf-8") as f:
        raw = json.load(f)
    entry = raw["canvases"]["cv_a"]
    assert "project_id" not in entry and "version" not in entry and "canvas_id" not in entry  # 容器层键不进条目
    assert raw["version"] == 2

    # 再存一次不带这些键：已存的 schema_version / viewport 不丢；新值覆盖旧值
    mgr.save_canvas(pid, {"nodes": [], "edges": [], "theme": "dark"}, canvas_id="cv_a")
    got = mgr.get_canvas(pid, canvas_id="cv_a")
    assert got["schema_version"] == 2 and got["viewport"]["zoom"] == 0.5 and got["theme"] == "dark"
    mgr.save_canvas(pid, {"nodes": [], "edges": [], "schema_version": 3}, canvas_id="cv_a")
    assert mgr.get_canvas(pid, canvas_id="cv_a")["schema_version"] == 3
    # 当前画布（不指定 canvas_id）读出来也带
    assert mgr.get_canvas(pid)["schema_version"] == 3
    listed = {c["id"]: c for c in mgr.list_canvases(pid)}
    assert listed["cv_a"]["schema_version"] == 3


def test_save_canvas_routes_roundtrip_schema_version(env, projects):
    c, pid = env["client"], projects["pid"]
    res = c.put(f"{API}/projects/{pid}/canvas", json={
        "canvas_id": "cv_b", "name": "画布B", "schema_version": 2,
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [{"id": "p", "type": "prompt"}], "edges": [],
    })
    assert res.status_code == 200, res.text
    assert res.json()["canvas"] == {"canvas_id": "cv_b", "name": "画布B", "schema_version": 2}
    got = c.get(f"{API}/projects/{pid}/canvas", params={"canvas_id": "cv_b"}).json()["canvas"]
    assert got["schema_version"] == 2 and got["viewport"]["zoom"] == 1 and got["canvas_id"] == "cv_b"
    # 包装形式 {snapshot, canvas_id}：同样保留
    res = c.put(f"{API}/projects/{pid}/canvas", json={
        "canvas_id": "cv_c", "snapshot": {"nodes": [], "edges": [], "schema_version": 2}})
    assert res.status_code == 200
    listed = {x["id"]: x for x in c.get(f"{API}/projects/{pid}/canvases").json()["canvases"]}
    assert listed["cv_b"]["schema_version"] == 2 and listed["cv_c"]["schema_version"] == 2
    assert listed["cv_a"]["schema_version"] is None  # 旧画布没有该键 → None（前端据此判定需要迁移）
    # 备份接口拿到的原始条目同样带 schema_version
    bak = _backup(env, pid, "cv_b").json()
    with open(os.path.join(env["storage"], bak["path"]), encoding="utf-8") as f:
        assert json.load(f)["schema_version"] == 2


def test_save_canvas_without_id_writes_back_to_snapshot_canvas(env, projects):
    """「读当前画布 → 改 → save_canvas(pid, snap)」（画布 MCP 工具的写法）必须写回同一张画布，而不是 default。"""
    mgr, pid = projects["pm"].project_manager, projects["pid"]
    mgr.save_canvas(pid, {"nodes": [{"id": "d"}], "edges": []}, canvas_id="default")
    mgr.save_canvas(pid, {"nodes": [{"id": "b"}], "edges": []}, canvas_id="cv_b")  # 当前画布 = cv_b
    snap = mgr.get_canvas(pid)
    assert snap["canvas_id"] == "cv_b"
    snap["nodes"].append({"id": "b2"})
    assert mgr.save_canvas(pid, snap)["canvas_id"] == "cv_b"
    assert [n["id"] for n in mgr.get_canvas(pid, canvas_id="cv_b")["nodes"]] == ["b", "b2"]
    assert [n["id"] for n in mgr.get_canvas(pid, canvas_id="default")["nodes"]] == ["d"]
    # 快照不带 canvas_id 时仍落 default（旧行为不变）
    assert mgr.save_canvas(pid, {"nodes": [], "edges": []})["canvas_id"] == "default"


def test_save_canvas_migrates_legacy_file_keeping_extras(env, projects):
    mgr, pid = projects["pm"].project_manager, projects["pid"]
    with open(os.path.join(projects["root"], pid, "canvas.json"), "w", encoding="utf-8") as f:
        json.dump({"nodes": [{"id": "old"}], "edges": [], "viewport": {"zoom": 2}}, f)
    assert mgr.get_canvas(pid)["viewport"] == {"zoom": 2}
    mgr.save_canvas(pid, {"nodes": [], "edges": [], "schema_version": 2}, canvas_id="cv_new")
    legacy = mgr.get_canvas(pid, canvas_id="default")
    assert legacy["viewport"] == {"zoom": 2} and legacy["nodes"] == [{"id": "old"}]
    assert mgr.get_canvas(pid, canvas_id="cv_new")["schema_version"] == 2
