# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas 素材库上传保留真实扩展名（C1）。

以前 `_attach_file` 的白名单只有 png/jpg/jpeg/webp/mp3/wav/mp4/glb/fbx，webm/m4a/mov/ogg/flac/aac/gif… 一律被存成
original.png（/storage 再按 image/png 吐给浏览器，音视频播不了）。这里覆盖：
- 扩展名解析：文件名 → content-type → 文件头 → 旧规则 .png；危险 / 未知类型不放行；
- 上传接口 POST /assets（单个、批量）与 PUT /assets/{id} 换文件：落盘扩展名 + file_url；
- /storage 静态服务按扩展名回标准 content-type；
- 复制素材时优先复制 file_url 指向的那个文件。

运行：cd server && python -m pytest -q tests/test_asset_file_ext.py
storage 指到临时目录，绝不碰真实素材库。
"""
import mimetypes
import os
import shutil
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi import FastAPI  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.asset_routes import router as asset_router  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.providers.asset import manager as asset_mod  # noqa: E402
from app.providers.asset.manager import ASSET_FILE_EXTS, resolve_asset_ext  # noqa: E402

API = "/api/v1"

# 各格式的最小文件头（只用来测「按文件头认格式」，内容不需要能播放）
HEADS = {
    ".png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 24,
    ".jpg": b"\xff\xd8\xff\xe0" + b"\x00" * 24,
    ".gif": b"GIF89a" + b"\x00" * 24,
    ".webp": b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 16,
    ".wav": b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 16,
    ".mp4": b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00" + b"\x00" * 16,
    ".m4a": b"\x00\x00\x00\x1cftypM4A \x00\x00\x02\x00" + b"\x00" * 16,
    ".mov": b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00" + b"\x00" * 16,
    ".webm": b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\x82\x84webm" + b"\x00" * 16,
    ".mkv": b"\x1a\x45\xdf\xa3\xa3\x42\x86\x81\x01\x42\x82\x88matroska" + b"\x00" * 16,
    ".ogg": b"OggS\x00\x02" + b"\x00" * 24,
    ".flac": b"fLaC\x00\x00\x00\x22" + b"\x00" * 24,
    ".mp3": b"ID3\x04\x00\x00" + b"\x00" * 24,
    ".aac": b"\xff\xf1\x50\x80" + b"\x00" * 24,
    ".glb": b"glTF\x02\x00\x00\x00" + b"\x00" * 24,
}


@pytest.fixture()
def env(monkeypatch):
    root = tempfile.mkdtemp(prefix="asset_ext_test_")
    storage = os.path.join(root, "storage")
    assets_root = os.path.join(storage, "assets")
    os.makedirs(assets_root, exist_ok=True)
    monkeypatch.setattr(settings, "STORAGE_DIR", storage)
    monkeypatch.setattr(asset_mod, "ASSETS_ROOT", assets_root)
    # 不往云端同步队列里塞测试文件
    from app.storage_sync.mirror import mirror

    monkeypatch.setattr(mirror, "enqueue", lambda rel: None)
    app = FastAPI()
    app.include_router(asset_router, prefix=API)
    app.mount("/storage", StaticFiles(directory=storage), name="storage")
    client = TestClient(app)
    try:
        yield client, storage
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _upload(client, filename, body, content_type, **form):
    data = {"name": os.path.splitext(filename)[0] or "x", "category": "other", "scope": "global", **form}
    r = client.post(f"{API}/assets", data=data, files={"file": (filename, body, content_type)})
    assert r.status_code == 200, r.text
    return r.json()


# —— 扩展名解析 ——

@pytest.mark.parametrize("name, ext", [
    ("previz.webm", ".webm"), ("voice.m4a", ".m4a"), ("clip.MOV", ".mov"), ("rain.ogg", ".ogg"), ("a.flac", ".flac"),
    ("b.aac", ".aac"), ("c.webp", ".webp"), ("d.gif", ".gif"), ("e.opus", ".opus"), ("f.weba", ".weba"),
    ("g.mkv", ".mkv"), ("h.avi", ".avi"), ("i.ogv", ".ogv"), ("j.m4v", ".m4v"), ("k.jpeg", ".jpeg"), ("l.JPG", ".jpg"),
    ("m.mp3", ".mp3"), ("n.wav", ".wav"), ("o.mp4", ".mp4"), ("p.glb", ".glb"), ("q.fbx", ".fbx"), ("r.avif", ".avif"),
])
def test_resolve_by_filename(name, ext):
    assert resolve_asset_ext(name) == ext


@pytest.mark.parametrize("ctype, ext", [
    ("video/webm;codecs=vp9", ".webm"), ("audio/mp4", ".m4a"), ("audio/x-m4a", ".m4a"), ("video/quicktime", ".mov"),
    ("audio/ogg; codecs=opus", ".ogg"), ("audio/flac", ".flac"), ("audio/aac", ".aac"), ("audio/webm", ".weba"),
    ("image/gif", ".gif"), ("audio/mpeg", ".mp3"), ("model/gltf-binary", ".glb"), ("IMAGE/JPEG", ".jpg"),
])
def test_resolve_by_content_type_when_name_has_no_usable_ext(ctype, ext):
    assert resolve_asset_ext("blob", ctype) == ext
    assert resolve_asset_ext("upload.bin", ctype) == ext


@pytest.mark.parametrize("ext", sorted(HEADS))
def test_resolve_by_magic_bytes(ext):
    assert resolve_asset_ext("blob", None, HEADS[ext]) == ext
    assert resolve_asset_ext("", "application/octet-stream", HEADS[ext]) == ext


def test_filename_wins_over_content_type_and_unknown_falls_back_to_png():
    assert resolve_asset_ext("x.webm", "video/mp4") == ".webm"
    # 同源可执行 / 未知类型不放行，沿用旧规则落成 .png
    for bad in ("x.html", "x.svg", "x.js", "x.exe", "x.txt", "x"):
        assert resolve_asset_ext(bad) == ".png"
    assert resolve_asset_ext("x.html", "text/html", b"<html>") == ".png"
    assert resolve_asset_ext("x.svg", "image/svg+xml", b"<svg") == ".png"


def test_content_types_registered_for_every_kept_ext():
    for ext in ASSET_FILE_EXTS:
        assert mimetypes.guess_type(f"original{ext}")[0], ext
    assert mimetypes.guess_type("original.m4a")[0] == "audio/mp4"
    assert mimetypes.guess_type("original.webm")[0] == "video/webm"
    assert mimetypes.guess_type("original.glb")[0] == "model/gltf-binary"
    assert mimetypes.guess_type("original.flac")[0] == "audio/flac"


# —— 上传接口 ——

@pytest.mark.parametrize("filename, ctype, ext, served", [
    ("previz.webm", "video/webm", ".webm", "video/webm"),
    ("voice.m4a", "audio/mp4", ".m4a", "audio/mp4"),
    ("clip.mov", "video/quicktime", ".mov", "video/quicktime"),
    ("rain.ogg", "audio/ogg", ".ogg", "audio/ogg"),
    ("a.flac", "audio/flac", ".flac", "audio/flac"),
    ("b.aac", "audio/aac", ".aac", "audio/aac"),
    ("c.webp", "image/webp", ".webp", "image/webp"),
    ("d.gif", "image/gif", ".gif", "image/gif"),
    ("e.mp4", "video/mp4", ".mp4", "video/mp4"),
    ("f.wav", "audio/wav", ".wav", "audio/wav"),
])
def test_upload_keeps_real_extension_and_serves_right_content_type(env, filename, ctype, ext, served):
    client, storage = env
    body = HEADS.get(ext, b"\x00" * 64) + b"payload"
    asset = _upload(client, filename, body, ctype)
    assert asset["file_url"] == f"/storage/assets/{asset['id']}/original{ext}"
    assert asset["thumb_url"] == asset["file_url"]
    local = os.path.join(storage, "assets", asset["id"], f"original{ext}")
    assert os.path.isfile(local)
    assert not os.path.exists(os.path.join(storage, "assets", asset["id"], "original.png")) or ext == ".png"
    with open(local, "rb") as f:
        assert f.read() == body
    r = client.get(asset["file_url"])
    assert r.status_code == 200
    assert r.headers["content-type"].split(";")[0] == served
    assert r.content == body


def test_upload_without_usable_filename_uses_content_type_then_magic(env):
    client, _ = env
    a = _upload(client, "blob", HEADS[".webm"], "video/webm")
    assert a["file_url"].endswith("/original.webm")
    b = _upload(client, "recording", HEADS[".m4a"], "application/octet-stream")
    assert b["file_url"].endswith("/original.m4a")
    c = _upload(client, "page.html", b"<html><script>alert(1)</script></html>", "text/html")
    assert c["file_url"].endswith("/original.png")


def test_batch_upload_keeps_extensions(env):
    client, _ = env
    files = [
        ("files", ("v.webm", HEADS[".webm"], "video/webm")),
        ("files", ("s.m4a", HEADS[".m4a"], "audio/mp4")),
        ("files", ("p.png", HEADS[".png"], "image/png")),
    ]
    r = client.post(f"{API}/assets/batch", data={"category": "other", "scope": "global"}, files=files)
    assert r.status_code == 200, r.text
    urls = sorted(a["file_url"].rsplit("/", 1)[1] for a in r.json()["assets"])
    assert urls == ["original.m4a", "original.png", "original.webm"]


def test_replace_file_with_other_format_and_duplicate_copies_current_file(env):
    client, storage = env
    a = _upload(client, "shot.png", HEADS[".png"], "image/png")
    r = client.put(f"{API}/assets/{a['id']}", data={"name": "shot"}, files={"file": ("shot.webm", HEADS[".webm"], "video/webm")})
    assert r.status_code == 200, r.text
    assert r.json()["file_url"] == f"/storage/assets/{a['id']}/original.webm"
    dup = client.post(f"{API}/assets/{a['id']}/duplicate").json()
    assert dup["file_url"] == f"/storage/assets/{dup['id']}/original.webm"
    with open(os.path.join(storage, "assets", dup["id"], "original.webm"), "rb") as f:
        assert f.read() == HEADS[".webm"]
