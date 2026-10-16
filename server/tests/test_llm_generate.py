# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas H1：通用文本生成接口 POST /llm/generate（画布文本节点「自由生成」技能）。"""
import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.routes import router  # noqa: E402
from app.pipelines import llm_service as llm_mod  # noqa: E402

API = "/api/v1"


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(router, prefix=API)
    return TestClient(app)


def test_generate_returns_text_and_passes_system(client, monkeypatch):
    seen = {}

    async def fake_chat(messages, temperature=0.3, max_tokens=4096, **kw):
        seen["messages"] = messages
        seen["max_tokens"] = max_tokens
        return "  # 标题\n正文  "

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", fake_chat)
    r = client.post(f"{API}/llm/generate", json={"prompt": "写一段开场白", "system": "你是编剧", "images": ["/storage/a.png"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "success", "text": "# 标题\n正文"}
    assert seen["messages"][0] == {"role": "system", "content": "你是编剧"}
    assert seen["messages"][1]["content"].startswith("写一段开场白")
    assert "/storage/a.png" in seen["messages"][1]["content"]


def test_generate_default_system_prompt(client, monkeypatch):
    seen = {}

    async def fake_chat(messages, **kw):
        seen["messages"] = messages
        return "ok"

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", fake_chat)
    r = client.post(f"{API}/llm/generate", json={"prompt": "hi"})
    assert r.status_code == 200
    assert "Markdown" in seen["messages"][0]["content"]


def test_generate_rejects_empty_prompt(client):
    r = client.post(f"{API}/llm/generate", json={"prompt": "   "})
    assert r.status_code == 400


def test_generate_maps_llm_errors_to_502(client, monkeypatch):
    async def boom(messages, **kw):
        raise llm_mod.LLMServiceError("no key")

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", boom)
    r = client.post(f"{API}/llm/generate", json={"prompt": "hi"})
    assert r.status_code == 502
    assert "no key" in r.json()["detail"]


def test_generate_empty_result_is_502(client, monkeypatch):
    async def empty(messages, **kw):
        return "   "

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", empty)
    r = client.post(f"{API}/llm/generate", json={"prompt": "hi"})
    assert r.status_code == 502
