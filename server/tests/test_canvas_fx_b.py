# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas FX-B：E2E 修复轮后端（progress/COORDINATION.md 第 14–16 条、E2E-2 B5/B8、E2E-3 D5/内容安全）。

1. ``POST /llm/generate/stream`` 文本流式接口（上游 OpenAI 兼容 SSE 用 httpx.MockTransport 模拟；不支持流式时退化一次性）；
2. MCP 生成源工具视频 ``mode`` 缺省时按入参推断；
3. ``canvas_execute`` / ``/canvas/execute`` / ``/projects/{id}/canvas/execute`` 结果写回画布（产出键、agent_state、history）；
4. 指定 target_ids 时不重跑兄弟生成节点（只执行目标 + 缺产出的必要上游）；
5. 智能规划 LLM 预算可配置（缺省 90s）；
6. 内置 ComfyUI 生图负向词补内容安全词。

运行： python -m pytest -q server/tests/test_canvas_fx_b.py
"""
import asyncio
import copy
import json
import os
import shutil
import sys
import tempfile
import types
from unittest import mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.canvas import engine as eng  # noqa: E402
from app.canvas import persist as cp  # noqa: E402
from app.canvas import text_skills as ts  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.pipelines import llm_service as llm_mod  # noqa: E402

API = "/api/v1"


def _by_id(nodes):
    return {n["id"]: n for n in nodes}


# ======================================================================
# 1. 文本流式接口
# ======================================================================

def _sse_chunks(*contents):
    lines = []
    for c in contents:
        lines.append("data: " + json.dumps({"choices": [{"delta": {"content": c}}]}, ensure_ascii=False))
        lines.append("")
    lines.append("data: [DONE]")
    lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


class Upstream:
    """模拟 OpenAI 兼容上游：记录每次请求体，按 handler 返回。"""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        self.requests.append({"url": str(request.url), "body": body})
        return self.handler(body)


@pytest.fixture()
def upstream(monkeypatch):
    """把 llm_service 的 httpx 换成走 MockTransport 的版本，并配好 OpenAI 兼容通道。"""
    holder = {}

    def factory(*a, **kw):
        kw["transport"] = httpx.MockTransport(holder["up"])
        return httpx.AsyncClient(*a, **kw)

    monkeypatch.setattr(llm_mod, "httpx", types.SimpleNamespace(AsyncClient=factory, Response=httpx.Response))
    for k, v in {"LLM_PROVIDER": "openai_compatible", "LLM_API_TYPE": "chat_completions", "OPENAI_API_KEY": "sk-test",
                 "OPENAI_BASE_URL": "http://llm.test/v1", "OPENAI_MODEL": "test-model", "OPENAI_CUSTOM_HEADERS": ""}.items():
        monkeypatch.setattr(settings, k, v)
    monkeypatch.delenv("OPENAI_CUSTOM_HEADERS", raising=False)
    monkeypatch.delenv("LLM_TOTAL_TIMEOUT_S", raising=False)

    def use(handler):
        holder["up"] = Upstream(handler)
        return holder["up"]

    return use


@pytest.fixture()
def client():
    from app.api.routes import router
    app = FastAPI()
    app.include_router(router, prefix=API)
    return TestClient(app)


def _events(resp):
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    out = []
    for block in resp.text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), block
        out.append(json.loads(block[len("data: "):]))
    return out


def test_stream_free_generation_emits_deltas_then_done(client, upstream):
    up = upstream(lambda body: httpx.Response(
        200, headers={"content-type": "text/event-stream"},
        content=_sse_chunks("<think>先想想</think>", "你好", "，", "世界")))
    r = client.post(f"{API}/llm/generate/stream", json={"prompt": "写一句开场白", "images": ["/storage/a.png"]})
    ev = _events(r)
    assert [e["delta"] for e in ev if "delta" in e] == ["你好", "，", "世界"]
    assert ev[-1] == {"done": True, "text": "你好，世界"}
    assert len(up.requests) == 1
    body = up.requests[0]["body"]
    assert up.requests[0]["url"] == "http://llm.test/v1/chat/completions"
    assert body["stream"] is True and body["model"] == "test-model"
    # 系统提示 / 用户内容与非流式 /llm/generate 完全同一份（text_skills.generate_request）
    assert body["messages"] == ts.generate_request("写一句开场白", images=["/storage/a.png"])["messages"]
    assert body["messages"][0]["content"] == ts.FREE_GEN_SYSTEM


@pytest.mark.parametrize("skill,expected_system", [
    ("proposal_generation", ts.PROPOSAL_SYSTEM),
    ("prompt_expansion", ts.expand_request("x")["messages"][0]["content"]),
    ("free_generation", ts.FREE_GEN_SYSTEM),
])
def test_stream_skill_uses_same_system_prompt(client, upstream, skill, expected_system):
    up = upstream(lambda body: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_sse_chunks("ok")))
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "少女回眸", "skill": skill}))
    assert ev[-1] == {"done": True, "text": "ok"}
    msgs = up.requests[0]["body"]["messages"]
    assert msgs[0] == {"role": "system", "content": expected_system}
    assert msgs[1]["content"] == "少女回眸"
    if skill == "prompt_expansion":
        assert up.requests[0]["body"]["max_tokens"] == 600  # 同 /llm/expand


def test_stream_explicit_system_overrides(client, upstream):
    up = upstream(lambda body: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_sse_chunks("ok")))
    _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi", "skill": "proposal_generation", "system": "你是编剧"}))
    assert up.requests[0]["body"]["messages"][0] == {"role": "system", "content": "你是编剧"}


def test_stream_falls_back_to_one_shot_when_upstream_ignores_stream(client, upstream):
    def handler(body):
        # 上游无视 stream:true，直接回 JSON（非 SSE）→ 流式无增量 → 退化为一次性调用
        return httpx.Response(200, json={"choices": [{"message": {"content": "<think>x</think>整段结果"}}]})

    up = upstream(handler)
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi"}))
    assert ev == [{"delta": "整段结果"}, {"done": True, "text": "整段结果"}]
    assert [r["body"].get("stream") for r in up.requests] == [True, None]


def test_stream_falls_back_when_stream_endpoint_errors(client, upstream):
    def handler(body):
        if body.get("stream"):
            return httpx.Response(404, text="stream not supported")
        return httpx.Response(200, json={"choices": [{"message": {"content": "一次性"}}]})

    upstream(handler)
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi"}))
    assert ev == [{"delta": "一次性"}, {"done": True, "text": "一次性"}]


def test_stream_upstream_failure_is_error_event(client, upstream):
    upstream(lambda body: httpx.Response(500, text="boom"))
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi"}))
    assert len(ev) == 1 and "error" in ev[0] and "LLM 生成失败" in ev[0]["error"]


def test_stream_interrupted_mid_way_is_error_event(client, monkeypatch):
    async def broken(self, messages, **kw):
        yield "前半段"
        raise RuntimeError("连接被重置")

    monkeypatch.setattr(llm_mod.LLMService, "chat_stream", broken)
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi"}))
    assert ev[0] == {"delta": "前半段"}
    assert "error" in ev[-1] and "连接被重置" in ev[-1]["error"]
    assert not any(e.get("done") for e in ev)


def test_stream_validation_errors_are_error_events(client):
    assert "error" in _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "  "}))[0]
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi", "skill": "script_generation"}))
    assert len(ev) == 1 and "不支持" in ev[0]["error"]


def test_stream_expansion_is_capped_like_non_stream(client, monkeypatch):
    async def long_stream(self, messages, **kw):
        yield "a" * 1000
        yield "b" * 500

    monkeypatch.setattr(llm_mod.LLMService, "chat_stream", long_stream)
    ev = _events(client.post(f"{API}/llm/generate/stream", json={"prompt": "hi", "skill": "prompt_expansion"}))
    assert sum(len(e["delta"]) for e in ev if "delta" in e) == ts.EXPAND_MAX_CHARS
    assert len(ev[-1]["text"]) == ts.EXPAND_MAX_CHARS


def test_non_stream_paths_still_share_prompts(monkeypatch):
    seen = []

    async def fake_chat(messages, temperature=0.3, max_tokens=4096, **kw):
        seen.append({"messages": messages, "max_tokens": max_tokens})
        return " ok "

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", fake_chat)
    assert asyncio.run(ts.generate_text("p", system=ts.PROPOSAL_SYSTEM)) == "ok"
    assert asyncio.run(ts.expand_prompt("p")) == "ok"
    assert seen[0]["messages"] == ts.stream_request("proposal_generation", "p")["messages"]
    assert seen[1]["messages"] == ts.stream_request("prompt_expansion", "p")["messages"]
    assert seen[1]["max_tokens"] == 600


# ======================================================================
# 2. 视频 mode 推断
# ======================================================================

@pytest.mark.parametrize("args,expected", [
    ({"prompt": "x", "first_frame": "/s/a.png", "reference_images": ["/s/b.png"]}, "i2v"),
    ({"first_frame_url": "/s/a.png"}, "i2v"),
    ({"reference_images": ["/s/a.png", "/s/b.png"]}, "r2v"),
    ({"reference_video": ["/s/v.mp4"]}, "r2v"),
    ({"reference_videos": ["/s/v.mp4"]}, "r2v"),
    ({"prompt": "x"}, "t2v"),
    ({"prompt": "x", "first_frame": "", "reference_images": []}, "t2v"),
    ({"mode": "i2v", "reference_images": ["/s/a.png"]}, "i2v"),  # 显式保留
    ({"mode": "T2V", "first_frame": "/s/a.png"}, "t2v"),
    ({"mode": "multiReference", "first_frame": "/s/a.png"}, "r2v"),  # 新参考模式名换算
    ({"mode": "singleImage"}, "i2v"),
    ({"mode": "vendor_special"}, "vendor_special"),  # 未知显式值原样下发
])
def test_infer_video_mode(args, expected):
    from app.mcp.server import infer_video_mode
    assert infer_video_mode(args) == expected


@pytest.mark.parametrize("args,expected", [
    ({"prompt": "多参考", "reference_images": ["/s/a.png", "/s/b.png"]}, "r2v"),
    ({"prompt": "单图", "first_frame": "/s/a.png"}, "i2v"),
    ({"prompt": "纯文本"}, "t2v"),
    ({"prompt": "显式", "mode": "i2v", "first_frame": "/s/a.png"}, "i2v"),
])
def test_provider_tool_passes_inferred_mode(args, expected):
    import app.mcp.server as mcp_mod
    from app.models.schemas import MCPToolDefinition
    from app.providers.video.base import VideoGenerateResult
    from app.providers.video.registry import video_registry

    pid = "fxb_fake_video"
    tool_name = f"provider_{pid}"
    seen = {}

    async def scenario():
        orig_get, orig_gen = video_registry.get, video_registry.generate

        def fake_get(x):
            return object() if x == pid else orig_get(x)

        async def fake_gen(req, provider_id=None):
            seen["mode"] = req.mode
            return VideoGenerateResult(video_url="/storage/videos/fxb.mp4", local_path=None, provider=pid, engine="test",
                                       duration=5, elapsed_ms=1)

        video_registry.get = fake_get
        video_registry.generate = fake_gen
        mcp_mod.mcp_registry.register_tool(MCPToolDefinition(
            name=tool_name, description="test provider", category="ai_generation",
            icon="Video", author="test", input_schema={"type": "object", "properties": {}},
        ))
        try:
            with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None):
                return await mcp_mod.mcp_registry.execute_tool(tool_name, args)
        finally:
            mcp_mod.mcp_registry.tools.pop(tool_name, None)
            video_registry.get = orig_get
            video_registry.generate = orig_gen

    res = asyncio.run(scenario())
    assert res.status == "success", res.error
    assert seen["mode"] == expected


# ======================================================================
# 3/4. canvas_execute：只跑目标 + 缺产出的上游；结果写回画布
# ======================================================================

def _graph(a_has_output=False):
    """t(文本) → A(图片生成) → V(视频生成)；t → V；t → S(兄弟图片生成)；V → D(下游视频生成)。"""
    a_data = {"provider_id": "fakeimg", "prompt": "首帧", "refOrder": [], "refRoles": {}}
    if a_has_output:
        a_data["image_url"] = "/storage/generated/old_a.png"
    return [
        {"id": "t", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"prompt": "一只橘猫在窗台上"}},
        {"id": "A", "type": "image", "position": {"x": 300, "y": 0}, "data": a_data},
        {"id": "S", "type": "image", "position": {"x": 300, "y": 400},
         "data": {"provider_id": "fakeimg", "prompt": "兄弟", "image_url": "/storage/generated/sibling.png"}},
        {"id": "V", "type": "video", "position": {"x": 600, "y": 0},
         "data": {"provider_id": "fakevid", "prompt": "镜头推进", "params": {"duration": 5},
                  "refRoles": {"A|image": "first_frame"}, "history": [{"url": "/storage/videos/older.mp4", "created_at": "2026-10-01T00:00:00.000Z"}]}},
        {"id": "D", "type": "video", "position": {"x": 900, "y": 0}, "data": {"provider_id": "fakevid", "prompt": "下游"}},
    ], [
        {"id": "e1", "source": "t", "sourceHandle": "prompt", "target": "A", "targetHandle": "in"},
        {"id": "e2", "source": "A", "sourceHandle": "image", "target": "V", "targetHandle": "in"},
        {"id": "e3", "source": "t", "sourceHandle": "prompt", "target": "V", "targetHandle": "in"},
        {"id": "e4", "source": "t", "sourceHandle": "prompt", "target": "S", "targetHandle": "in"},
        {"id": "e5", "source": "V", "sourceHandle": "video", "target": "D", "targetHandle": "in"},
    ]


class ProviderCalls:
    """拦截 provider_* 工具调用并计数，其余工具（canvas_* 等）走真实实现。"""

    def __init__(self, orig, on_call=None):
        self.orig = orig
        self.calls = []
        self.on_call = on_call
        self.n = 0

    async def __call__(self, tool_name, arguments, *a, **kw):
        if not tool_name.startswith("provider_"):
            return await self.orig(tool_name, arguments, *a, **kw)
        from app.models.schemas import MCPToolCallResponse
        self.n += 1
        self.calls.append((tool_name, copy.deepcopy(arguments)))
        if self.on_call:
            self.on_call(tool_name, arguments)
        if tool_name == "provider_fakevid":
            result = {"video_url": f"/storage/videos/fxb_{self.n}.mp4"}
        else:
            result = {"image_url": f"/storage/generated/fxb_{self.n}.png"}
        return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, error=None, execution_time_ms=7)

    def count(self, tool):
        return sum(1 for t, _ in self.calls if t == tool)


def _run_dag(nodes, edges, target_ids):
    from app.mcp.server import mcp_registry
    calls = ProviderCalls(mcp_registry.execute_tool)
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        res = asyncio.run(eng.canvas_engine.execute_dag(copy.deepcopy(nodes), copy.deepcopy(edges), target_ids=target_ids))
    return res, calls


def test_execution_set_only_targets_and_missing_ancestors():
    nodes, edges = _graph()
    assert eng.execution_set(nodes, edges, ["V"]) == {"V", "A"}  # t 有正文、S 兄弟、D 下游都不执行
    nodes2, _ = _graph(a_has_output=True)
    assert eng.execution_set(nodes2, edges, ["V"]) == {"V"}
    assert eng.execution_set(nodes, edges, ["S"]) == {"S"}
    assert eng.execution_set(nodes, edges, ["missing"]) == set()


def test_sibling_generation_node_is_not_rerun():
    nodes, edges = _graph()
    res, calls = _run_dag(nodes, edges, ["V"])
    assert set(res["results"]) == {"A", "V"}
    assert res["order"].index("A") < res["order"].index("V")
    assert calls.count("provider_fakeimg") == 1  # 只有缺首帧的 A；兄弟 S 不重跑（E2E-3 高优先级发现）
    assert calls.count("provider_fakevid") == 1  # 只有 V；下游 D 不跑
    vid_args = [a for t, a in calls.calls if t == "provider_fakevid"][0]
    assert vid_args["first_frame"] == "/storage/generated/fxb_1.png"  # A 本次产出作首帧
    assert vid_args["prompt"].startswith("镜头推进")


def test_ancestor_with_output_is_read_not_executed():
    nodes, edges = _graph(a_has_output=True)
    res, calls = _run_dag(nodes, edges, ["V"])
    assert set(res["results"]) == {"V"}
    assert calls.count("provider_fakeimg") == 0
    vid_args = calls.calls[0][1]
    assert vid_args["first_frame"] == "/storage/generated/old_a.png"
    assert "一只橘猫在窗台上" in vid_args["prompt"]  # 未执行的文本上游照样作文本参考


def test_full_run_without_targets_unchanged():
    nodes, edges = _graph()
    res, calls = _run_dag(nodes, edges, None)
    assert set(res["results"]) == {"t", "A", "S", "V", "D"}
    assert calls.count("provider_fakeimg") == 2 and calls.count("provider_fakevid") == 2


def test_legacy_video_handle_reads_unexecuted_source_data():
    nodes = [
        {"id": "v", "type": "load-video", "position": {"x": 0, "y": 0}, "data": {"video_url": "/s/clip.mp4"}},
        {"id": "x", "type": "export", "position": {"x": 300, "y": 0}, "data": {}},
    ]
    edges = [{"id": "e", "source": "v", "sourceHandle": "video", "target": "x", "targetHandle": "videos"}]
    up = eng.collect_upstream_data("x", nodes, edges, {})
    assert up.get("reference_videos") == ["/s/clip.mp4"] or up.get("videos") == ["/s/clip.mp4"]
    edges[0]["targetHandle"] = "video"
    up = eng.collect_upstream_data("x", nodes, edges, {})
    assert up.get("videos") == ["/s/clip.mp4"]


# ---------- persist：结果 → 节点数据补丁 ----------

def test_result_patch_image_success_matches_frontend_shape():
    node = {"id": "A", "type": "image", "data": {"prompt": "首帧", "provider_id": "fakeimg", "params": {"steps": 20},
                                                  "history": [{"url": "/old.png", "created_at": "x"}]}}
    p = cp.result_patch(node, {"status": "success", "image_url": "/new.png", "provider": "fakeimg", "elapsed_ms": 12}, now="T")
    assert p["image_url"] == p["result_url"] == "/new.png"
    assert p["history"] == [
        {"url": "/new.png", "created_at": "T", "provider_id": "fakeimg", "prompt": "首帧", "params": {"steps": 20}},
        {"url": "/old.png", "created_at": "x"},
    ]
    assert p["agent_state"] == {"status": "completed", "tool": "canvas_execute", "updated_at": "T", "provider_id": "fakeimg", "elapsed_ms": 12}


def test_history_dedupes_by_url_and_caps_at_20():
    old = [{"url": f"/h{i}.png", "created_at": str(i)} for i in range(20)]
    out = cp.append_history(old, {"url": "/h5.png", "created_at": "new"})
    assert len(out) == 20 and out[0] == {"url": "/h5.png", "created_at": "new"}
    assert [h["url"] for h in out].count("/h5.png") == 1
    out = cp.append_history(old, {"url": "/brand_new.png", "created_at": "new"})
    assert len(out) == 20 and out[0]["url"] == "/brand_new.png" and out[-1]["url"] == "/h18.png"
    assert cp.append_history("garbage", {"url": "/a", "created_at": "1"}) == [{"url": "/a", "created_at": "1"}]


def test_result_patch_text_video_audio_error_and_passive():
    text = {"id": "t", "type": "prompt", "data": {"prompt": "正文"}}
    assert cp.result_patch(text, {"status": "success", "prompt": "正文", "text": "正文"}) == {}  # 透传不写
    p = cp.result_patch(text, {"status": "success", "prompt": "新", "text": "新", "skill_id": "script_generation",
                               "script_data": {"scenes": []}}, now="T")
    assert p["text"] == p["prompt"] == "新" and p["script_data"] == {"scenes": []}
    assert p["agent_state"]["status"] == "completed" and "history" not in p

    vid = {"id": "v", "type": "video", "data": {"prompt": "推进", "_polling": True}}
    p = cp.result_patch(vid, {"status": "success", "video_url": "/v.mp4", "provider": "fakevid"}, now="T")
    assert p["video_url"] == "/v.mp4" and p["_polling"] is False and p["history"][0]["prompt"] == "推进"
    pending = cp.result_patch({"id": "v", "type": "video", "data": {}},
                              {"status": "success", "video_url": "", "task_id": "tk1", "provider": "x"}, now="T")
    assert pending["_taskId"] == "tk1" and pending["_polling"] is True and pending["agent_state"]["status"] == "running"

    aud = {"id": "a", "type": "audio", "data": {"text": "台词", "prompt": "旧"}}
    p = cp.result_patch(aud, {"status": "success", "audio_url": "/a.wav"}, now="T")
    assert p["audio_url"] == "/a.wav" and p["history"][0]["prompt"] == "台词"

    err = cp.result_patch({"id": "i", "type": "image", "data": {"provider_id": "p"}}, {"status": "error", "error": "坏了"}, now="T")
    assert err == {"agent_state": {"status": "failed", "tool": "canvas_execute", "updated_at": "T", "provider_id": "p", "error": "坏了"}}

    assert cp.result_patch({"id": "l", "type": "load-image", "data": {}}, {"status": "success", "image_url": "/x.png"}) == {}
    d3 = cp.result_patch({"id": "d", "type": "director3d", "data": {}}, {"status": "success", "minimax_camera_prompt": "[推进]"}, now="T")
    assert d3["minimax_camera_prompt"] == "[推进]" and "camera_prompt" not in d3


# ---------- 真实落盘 ----------

class _RealStore:
    def __init__(self):
        import app.providers.project.manager as pm_mod
        self.pm = pm_mod.project_manager
        self.tmp = tempfile.mkdtemp(prefix="studio_fxb_store_")
        root = os.path.join(self.tmp, "projects")
        os.makedirs(root, exist_ok=True)
        self.patches = [mock.patch.object(pm_mod, "PROJECTS_ROOT", root),
                        mock.patch.object(pm_mod, "INDEX_PATH", os.path.join(root, "index.json"))]
        for p in self.patches:
            p.start()
        self.pid = self.pm.create_project("FX-B 写回测试")["id"]
        self.default_nodes = [{"id": "keep", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"prompt": "默认画布"}}]
        self.pm.save_canvas(self.pid, {"nodes": self.default_nodes, "edges": []}, canvas_id="default")
        nodes, edges = _graph()
        self.pm.save_canvas(self.pid, {"nodes": nodes, "edges": edges, "schema_version": 2, "viewport": {"x": 1, "y": 2, "zoom": 0.5}},
                            canvas_id="c2", name="第二张")

    def close(self):
        for p in reversed(self.patches):
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


@pytest.fixture()
def store():
    s = _RealStore()
    yield s
    s.close()


def _assert_persisted(store, results_n_img=1):
    c2 = store.pm.get_canvas(store.pid, "c2")
    assert c2["schema_version"] == 2 and c2["viewport"] == {"x": 1, "y": 2, "zoom": 0.5} and c2["name"] == "第二张"
    by = _by_id(c2["nodes"])
    a, v = by["A"]["data"], by["V"]["data"]
    assert a["image_url"] == a["result_url"] == f"/storage/generated/fxb_{results_n_img}.png"
    assert a["history"][0]["url"] == a["image_url"] and a["history"][0]["provider_id"] == "fakeimg"
    assert a["agent_state"]["status"] == "completed"
    assert v["video_url"].startswith("/storage/videos/fxb_")
    assert [h["url"] for h in v["history"]] == [v["video_url"], "/storage/videos/older.mp4"]
    assert v["history"][0]["params"] == {"duration": 5} and v["history"][0]["created_at"].endswith("Z")
    assert by["S"]["data"] == _by_id(_graph()[0])["S"]["data"]  # 兄弟节点原样
    assert by["D"]["data"] == _by_id(_graph()[0])["D"]["data"]
    assert store.pm.get_canvas(store.pid, "default")["nodes"] == store.default_nodes
    return c2


def test_mcp_canvas_execute_persists_results_into_read_canvas(store):
    from app.mcp.server import mcp_registry
    orig = mcp_registry.execute_tool

    def concurrent_edit(tool, args):
        # 执行期间前端自动保存了一个新节点：写回时要重读画布，不能用执行前的旧快照覆盖
        if tool == "provider_fakevid":
            snap = store.pm.get_canvas(store.pid, "c2")
            snap["nodes"].append({"id": "new", "type": "prompt", "position": {"x": 0, "y": 900}, "data": {"prompt": "执行中新加"}})
            store.pm.save_canvas(store.pid, snap, canvas_id="c2")

    calls = ProviderCalls(orig, on_call=concurrent_edit)
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        r = asyncio.run(mcp_registry.execute_tool("canvas_execute", {"project_id": store.pid, "target_ids": ["V"]}))
    assert r.status == "success", r.error
    assert r.result["persisted"]["persisted"] is True
    assert r.result["persisted"]["canvas_id"] == "c2"
    assert r.result["persisted"]["updated_nodes"] == ["A", "V"]
    assert calls.count("provider_fakeimg") == 1 and calls.count("provider_fakevid") == 1
    c2 = _assert_persisted(store)
    assert "new" in _by_id(c2["nodes"])


def test_mcp_canvas_execute_explicit_canvas_id(store):
    """激活画布被切到 default 后，显式 canvas_id=c2 仍读写 c2。"""
    from app.mcp.server import mcp_registry
    store.pm.save_canvas(store.pid, {"nodes": store.default_nodes, "edges": []}, canvas_id="default")  # 激活 default
    calls = ProviderCalls(mcp_registry.execute_tool)
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        r = asyncio.run(mcp_registry.execute_tool("canvas_execute", {"project_id": store.pid, "canvas_id": "c2", "target_ids": ["V"]}))
    assert r.status == "success", r.error
    assert r.result["persisted"]["canvas_id"] == "c2"
    _assert_persisted(store)


def test_http_canvas_execute_routes_persist(store):
    from app.api import canvas_routes as cr
    from app.mcp.server import mcp_registry
    calls = ProviderCalls(mcp_registry.execute_tool)
    nodes, edges = _graph()
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        out = asyncio.run(cr.execute_canvas(cr.CanvasExecuteRequest(
            nodes=nodes, edges=edges, target_ids=["V"], project_id=store.pid, canvas_id="c2")))
    assert out["persisted"]["persisted"] is True
    _assert_persisted(store)

    # /projects/{id}/canvas/execute：从存储读激活画布（c2），写回同一张
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        out = asyncio.run(cr.execute_project_canvas(store.pid, {"target_ids": ["V"]}))
    assert out["persisted"]["canvas_id"] == "c2" and out["persisted"]["updated_nodes"] == ["V"]  # A 已有产出，不再执行
    v = _by_id(store.pm.get_canvas(store.pid, "c2")["nodes"])["V"]["data"]
    assert len(v["history"]) == 3

    # persist=false 不写
    before = store.pm.get_canvas(store.pid, "c2")
    with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
            mock.patch.object(mcp_registry, "execute_tool", calls):
        out = asyncio.run(cr.execute_project_canvas(store.pid, {"target_ids": ["V"], "persist": False}))
    assert "persisted" not in out
    assert store.pm.get_canvas(store.pid, "c2")["nodes"] == before["nodes"]


# ======================================================================
# 5. 智能规划预算
# ======================================================================

@pytest.mark.parametrize("env,expected", [(None, 90.0), ("120", 120.0), ("abc", 90.0), ("0", 90.0), ("1", 5.0), ("9999", 600.0)])
def test_plan_budget_configurable(monkeypatch, env, expected):
    from app.canvas import agent_plan
    monkeypatch.setattr(settings, "CANVAS_AGENT_PLAN_TIMEOUT_S", "90")
    if env is None:
        monkeypatch.delenv("CANVAS_AGENT_PLAN_TIMEOUT_S", raising=False)
    else:
        monkeypatch.setenv("CANVAS_AGENT_PLAN_TIMEOUT_S", env)
    assert agent_plan.llm_plan_budget_s() == expected


def test_plan_uses_budget_and_falls_back_to_rules(monkeypatch):
    from app.canvas import agent_plan
    monkeypatch.setenv("CANVAS_AGENT_PLAN_TIMEOUT_S", "120")
    monkeypatch.setattr(agent_plan, "_providers_brief", lambda kind: [{"id": "fakeimg", "name": "Fake"}])
    seen = {}

    async def fake_chat(messages, timeout=None, **kw):
        seen["timeout"] = timeout
        raise llm_mod.LLMServiceError("网关超时")

    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", fake_chat)
    plan = asyncio.run(agent_plan.plan_node_agent("image", "一只橘猫", "fakeimg", {}))
    assert seen["timeout"] == 120.0
    assert plan["plan_source"] == "rule" and plan["provider_id"] == "fakeimg"


# ======================================================================
# 6. 内置 ComfyUI 负向词安全词
# ======================================================================

def test_safe_negative_prompt_appends_missing_terms_only():
    from app.providers.image.comfyui import DEFAULT_NEGATIVE, SAFETY_NEGATIVE_TERMS, safe_negative_prompt
    neg = safe_negative_prompt(None)
    assert neg.startswith(DEFAULT_NEGATIVE)
    toks = [t.strip() for t in neg.split(",")]
    for t in SAFETY_NEGATIVE_TERMS:
        assert toks.count(t) == 1
    user = safe_negative_prompt("ugly, NSFW, (nude:1.3), ")
    assert user.startswith("ugly, NSFW, (nude:1.3)")  # 用户词原样保留
    assert user.lower().count("nsfw") == 1 and user.count("nude") == 1
    assert user.endswith("nudity, sexual, explicit")
    full = "nsfw, nude, nudity, sexual, explicit"
    assert safe_negative_prompt(full) == full


def test_builtin_comfyui_workflow_negative_has_safety_terms(monkeypatch):
    from app.providers.image import comfyui as cmod
    from app.providers.image.base import ImageGenerateRequest

    prov = cmod.ComfyUIProvider()
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            captured["workflow"] = json.loads(request.content.decode("utf-8"))["prompt"]
            return httpx.Response(500, json={"error": "stop here"})
        return httpx.Response(404)

    real_client = httpx.AsyncClient

    def factory(*a, **kw):
        kw["transport"] = httpx.MockTransport(handler)
        return real_client(*a, **kw)

    async def healthy():
        return True

    async def ckpt(client):
        return "waiIllustriousSDXL.safetensors"

    monkeypatch.setattr(cmod.httpx, "AsyncClient", factory)
    monkeypatch.setattr(prov, "check_health", healthy)
    monkeypatch.setattr(prov, "_resolve_checkpoint", ckpt)
    monkeypatch.setattr(settings, "COMFYUI_DEFAULT_IMAGE_WORKFLOW", "")
    for neg, keep in (("", None), ("blurry hands", "blurry hands")):
        captured.clear()
        with pytest.raises(Exception):
            asyncio.run(prov.generate(ImageGenerateRequest(prompt="一只橘猫在窗台上", negative_prompt=neg)))
        text = captured["workflow"]["7"]["inputs"]["text"]
        for t in cmod.SAFETY_NEGATIVE_TERMS:
            assert t in text
        if keep:
            assert text.startswith(keep)
