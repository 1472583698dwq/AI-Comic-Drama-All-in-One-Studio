# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas F2：画布引擎文本节点（type=prompt）技能 — canvas_execute / /canvas/execute / Agent 走的后端路径。

- 修复前：策划案 / 扩写对 llm_service.chat_completion 的返回值（str）调 .get("content") → 必抛异常 → 静默透传正文；
- 新增自由生成（free_generation，= /llm/generate）；
- 技能指令用 gen_prompt（N1），正文 / 文本参考作输入来源，与前端宿主 executeRouter.runTextSkill 同口径。

LLM 一律 mock（monkeypatch llm_service.chat_completion / script_agent.parse_novel_to_project）。
运行： python -m pytest -q server/tests/test_canvas_text_skills.py
"""
import asyncio
import copy
import os
import shutil
import sys
import tempfile
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.canvas import engine as eng  # noqa: E402
from app.canvas import text_skills as ts  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.models.schemas import Project, Scene, StoryboardShot  # noqa: E402
from app.pipelines import llm_service as llm_mod  # noqa: E402
from app.pipelines import script_agent as sa_mod  # noqa: E402


class FakeLLM:
    """记录每次调用；reply 为异常时抛出。"""

    def __init__(self, reply="  LLM 生成结果  "):
        self.reply = reply
        self.calls = []

    async def __call__(self, messages, temperature=0.3, max_tokens=4096, **kw):
        self.calls.append({"messages": messages, "temperature": temperature, "max_tokens": max_tokens})
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply

    @property
    def system(self):
        return self.calls[-1]["messages"][0]["content"]

    @property
    def user(self):
        return self.calls[-1]["messages"][1]["content"]


@pytest.fixture()
def llm(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(llm_mod.llm_service, "chat_completion", fake)
    return fake


def _text(nid="t", **data):
    return {"id": nid, "type": "prompt", "position": {"x": 400, "y": 0}, "data": data}


def _run(node, upstream=None):
    return asyncio.run(eng.execute_node(node, upstream or {}))


def _run_in_graph(target_id, nodes, edges, results=None):
    by_id = {n["id"]: n for n in nodes}
    up = eng.collect_upstream_data(target_id, nodes, edges, results or {})
    return asyncio.run(eng.execute_node(by_id[target_id], up)), up


def _edge(eid, src, sh, tgt):
    return {"id": eid, "source": src, "sourceHandle": sh, "target": tgt, "targetHandle": "in"}


# ---------- 1. 修复前的 .get() 崩溃：策划案 / 扩写 ----------

@pytest.mark.parametrize("skill", ["proposal_generation", "prompt_expansion"])
def test_str_reply_is_used_not_silently_passed_through(llm, skill):
    """chat_completion 返回 str（真实返回类型）：修复前 .get 抛 AttributeError 后透传正文，现在写回生成结果。"""
    res = _run(_text(prompt="仙侠复仇，女主重生", skill_id=skill))
    assert res["status"] == "success", res
    assert res["prompt"] == res["text"] == "LLM 生成结果"
    assert res["skill_id"] == skill
    assert len(llm.calls) == 1


def test_proposal_uses_proposal_system_and_instruction(llm):
    res = _run(_text(prompt="旧正文", gen_prompt="写一个{{ref 1}}题材的策划案", skill_id="proposal_generation"))
    assert res["status"] == "success"
    assert llm.system == ts.PROPOSAL_SYSTEM
    # 指令优先于正文；单节点执行无连线，{{ref N}} 只换成「参考 N」
    assert llm.user == "写一个参考 1题材的策划案"
    assert res["input_source"] == "instruction"


def test_expansion_matches_llm_expand_endpoint(llm):
    llm.reply = "x" * 1500
    res = _run(_text(prompt="少女回眸", skill_id="prompt_expansion"))
    assert res["status"] == "success"
    # 与 POST /llm/expand（kind=image）同一实现：扩写引擎系统提示、max_tokens 600、结果截断 1200
    assert "提示词扩写引擎" in llm.system and "生图提示词" in llm.system
    assert llm.calls[-1]["max_tokens"] == 600
    assert llm.user == "少女回眸"  # 指令与文本参考都空 → 回落正文
    assert res["input_source"] == "document"
    assert res["prompt"] == "x" * 1200


def test_skill_failure_returns_error_instead_of_passthrough(llm):
    llm.reply = llm_mod.LLMServiceError("no key")
    res = _run(_text(prompt="仙侠", skill_id="proposal_generation"))
    assert res["status"] == "error"
    assert "策划案失败" in res["error"] and "no key" in res["error"]
    assert "prompt" not in res  # 下游回落读节点正文


def test_empty_reply_is_error(llm):
    llm.reply = "   "
    res = _run(_text(gen_prompt="写一段开场白", skill_id="free_generation"))
    assert res["status"] == "error" and "返回为空" in res["error"]


# ---------- 2. 自由生成 free_generation（= /llm/generate） ----------

def test_free_generation_explicit(llm):
    res = _run(_text(prompt="", gen_prompt="写一段开场白", skill_id="free_generation"))
    assert res["status"] == "success"
    assert res["prompt"] == res["text"] == "LLM 生成结果"
    assert llm.system == ts.FREE_GEN_SYSTEM
    assert llm.user == "写一段开场白"
    assert llm.calls[-1]["max_tokens"] == 2000


@pytest.mark.parametrize("skill_id", [None, "", "custom_text", "unknown_skill"])
def test_default_skill_with_instruction_is_free_generation(llm, skill_id):
    data = {"prompt": "旧正文", "gen_prompt": "续写下一段"}
    if skill_id is not None:
        data["skill_id"] = skill_id
    res = _run(_text(**data))
    assert res["status"] == "success" and res["skill_id"] == "free_generation"
    assert llm.user == "续写下一段"


@pytest.mark.parametrize("data", [
    {"prompt": "纯文本源"},                                   # Agent 建的文本源节点
    {"prompt": "纯文本源", "skill_id": "custom_text"},        # 旧画布「自由编写」
    {"prompt": "纯文本源", "skill_id": "free_generation"},    # 自由生成但没有指令 / 文本参考：前端也不允许发送
])
def test_no_instruction_passes_document_through(llm, data):
    res = _run(_text(**data))
    assert res == {"status": "success", "prompt": "纯文本源", "text": "纯文本源", "elapsed_ms": res["elapsed_ms"]}
    assert llm.calls == []


def test_free_generation_with_refs_and_images(llm):
    """全部文本参考（含 3D 导演机位）进提示词；提到的图片附对应关系，图片地址交给 LLM。"""
    nodes = [
        {"id": "t1", "type": "prompt", "data": {"prompt": "一个女孩在雨中奔跑"}},
        {"id": "i1", "type": "load-image", "data": {"image_url": "/s/a.png"}},
        {"id": "d1", "type": "director3d", "data": {"camera_prompt": "[推进,左摇]"}},
        _text(prompt="旧正文", gen_prompt="按{{ref 2}}写描写，结合{{ref 1}}和{{ref 3}}"),
    ]
    edges = [_edge("e1", "t1", "prompt", "t"), _edge("e2", "i1", "image", "t"), _edge("e3", "d1", "camera_prompt", "t")]
    res, up = _run_in_graph("t", nodes, edges)
    assert res["status"] == "success", res
    assert up[ts.SKILL_INPUT_KEY]["reference_images"] == ["/s/a.png"]
    assert llm.user == (
        "按参考 2写描写，结合参考 1和参考 3\n\n"
        "参考 1：\n一个女孩在雨中奔跑\n\n"
        "参考 3：\n[推进,左摇]\n\n"
        "（参考编号对应：参考 2=第 1 张参考图）\n\n"
        "（参考图地址：/s/a.png）"
    )


def test_text_ref_is_body_when_no_instruction(llm):
    """指令为空时第一条文本参考作主体（显式自由生成），正文不参与。"""
    nodes = [
        {"id": "t1", "type": "prompt", "data": {"prompt": "角色：白衣少女"}},
        {"id": "t2", "type": "prompt", "data": {"prompt": "场景：竹林夜雨"}},
        _text(prompt="旧正文", skill_id="free_generation"),
    ]
    res, _ = _run_in_graph("t", nodes, [_edge("e1", "t1", "prompt", "t"), _edge("e2", "t2", "prompt", "t")])
    assert res["status"] == "success" and res["input_source"] == "refs"
    assert llm.user == "角色：白衣少女\n\n参考 2：\n场景：竹林夜雨"


def test_instruction_overrides_document_with_refs(llm):
    nodes = [
        {"id": "t1", "type": "prompt", "data": {"prompt": "角色：白衣少女"}},
        _text(prompt="这是正文，不应作为输入", gen_prompt="扩写{{ref 1}}", skill_id="prompt_expansion"),
    ]
    res, _ = _run_in_graph("t", nodes, [_edge("e1", "t1", "prompt", "t")])
    assert res["status"] == "success"
    assert llm.user == "扩写参考 1\n\n参考 1：\n角色：白衣少女"
    assert "这是正文" not in llm.user


def test_single_node_upstream_text_is_first_ref(llm):
    """/canvas/node/execute：没有连线，调用方给的 upstream 文本当第 1 条文本参考。"""
    res = _run(_text(prompt="", skill_id="prompt_expansion"), {"prompt": "上游文本"})
    assert res["status"] == "success" and llm.user == "上游文本"


def test_passthrough_unchanged_with_text_refs(llm):
    """不执行技能的文本节点：原样透传自身正文（修复前行为），不调 LLM。"""
    nodes = [{"id": "t1", "type": "prompt", "data": {"prompt": "上游"}}, _text(prompt="自身正文")]
    res, _ = _run_in_graph("t", nodes, [_edge("e1", "t1", "prompt", "t")])
    assert (res["status"], res["prompt"], res["text"]) == ("success", "自身正文", "自身正文")
    assert llm.calls == []


# ---------- 3. 剧本拆解 script_generation ----------

def _project():
    shots = [
        StoryboardShot(id="s1", shot_index=1, camera_framing="close_up", action_desc="女孩回眸", dialogue="你来了", image_prompt="x"),
        StoryboardShot(id="s2", shot_index=2, action_desc="雨落竹林", image_prompt="y"),
    ]
    return Project(id="p", title="t", scenes=[Scene(id="sc1", scene_index=1, title="雨夜", location="竹林", shots=shots)])


def test_script_generation(monkeypatch, llm):
    seen = {}

    async def fake_parse(novel_text, style_preset="donghua_xianxia", aspect_ratio="9:16", custom_instructions=""):
        seen.update(text=novel_text, style=style_preset, ratio=aspect_ratio)
        return _project()

    monkeypatch.setattr(sa_mod.script_agent, "parse_novel_to_project", fake_parse)
    res = _run(_text(prompt="旧正文", gen_prompt="小说段落", skill_id="script_generation", aspect_ratio="16:9"))
    assert res["status"] == "success", res
    assert seen == {"text": "小说段落", "style": "donghua_xianxia", "ratio": "16:9"}
    # 与前端 executeRouter.formatScript 同格式
    expected = "【场景 1】\n镜头 1: [close_up] 女孩回眸\n台词: 你来了\n\n镜头 2: [medium] 雨落竹林\n台词: （无对白）"
    assert res["prompt"] == res["text"] == expected
    assert res["script_data"]["scenes"][0]["shots"][0]["id"] == "s1"
    assert llm.calls == []


def test_script_generation_failure_is_error(monkeypatch):
    async def boom(*a, **kw):
        raise llm_mod.LLMServiceError("503")

    monkeypatch.setattr(sa_mod.script_agent, "parse_novel_to_project", boom)
    res = _run(_text(prompt="小说", skill_id="script_generation"))
    assert res["status"] == "error" and "剧本拆解失败" in res["error"]


# ---------- 4. DAG / MCP 路径 ----------

def test_execute_dag_runs_text_skill(llm):
    nodes = [
        {"id": "t1", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"prompt": "仙侠复仇"}},
        _text(gen_prompt="以{{ref 1}}为题写策划案", skill_id="proposal_generation"),
    ]
    out = asyncio.run(eng.canvas_engine.execute_dag(nodes, [_edge("e1", "t1", "prompt", "t")]))
    assert out["order"] == ["t1", "t"]
    assert out["results"]["t1"]["prompt"] == "仙侠复仇"  # 源节点透传
    assert out["results"]["t"]["prompt"] == "LLM 生成结果"
    assert len(llm.calls) == 1 and llm.user == "以参考 1为题写策划案\n\n参考 1：\n仙侠复仇"


class _FakeCanvasStore:
    def __init__(self, snap):
        self.snap = copy.deepcopy(snap)

    def get_canvas(self, pid, canvas_id=None):
        return copy.deepcopy(self.snap)

    def save_canvas(self, pid, snapshot, canvas_id="default", name=None):
        self.snap = {**self.snap, "nodes": copy.deepcopy(snapshot.get("nodes", [])), "edges": copy.deepcopy(snapshot.get("edges", []))}
        return {"canvas_id": canvas_id}


@pytest.fixture()
def mcp(monkeypatch):
    orig = settings.STORAGE_DIR
    tmp = tempfile.mkdtemp(prefix="studio_text_skill_test_")
    settings.STORAGE_DIR = tmp
    from app.mcp.server import mcp_registry
    from app.providers.project.manager import project_manager

    def call(store, tool, args):
        with mock.patch.object(project_manager, "get_canvas", store.get_canvas), \
                mock.patch.object(project_manager, "save_canvas", store.save_canvas):
            return asyncio.run(mcp_registry.execute_tool(tool, {"project_id": "proj_t", **args}))

    yield call
    settings.STORAGE_DIR = orig
    shutil.rmtree(tmp, ignore_errors=True)


def test_mcp_canvas_execute_free_generation(mcp, llm):
    store = _FakeCanvasStore({"canvas_id": "c1", "nodes": [_text(gen_prompt="写一段开场白")], "edges": []})
    r = mcp(store, "canvas_execute", {"target_ids": ["t"]})
    assert r.status == "success", r.error
    assert r.result["results"]["t"]["status"] == "success"
    assert r.result["results"]["t"]["text"] == "LLM 生成结果"
    assert llm.system == ts.FREE_GEN_SYSTEM and llm.user == "写一段开场白"


def test_mcp_dispatch_skill_writes_instruction_to_gen_prompt(mcp, llm):
    store = _FakeCanvasStore({"canvas_id": "c1", "nodes": [_text(prompt="旧正文", text="旧正文", gen_prompt="旧指令")], "edges": []})
    r = mcp(store, "canvas_dispatch_skill", {"skill_id": "prompt_expansion", "prompt": "少女回眸", "node_id": "t"})
    assert r.status == "success", r.error
    assert r.result["result"]["status"] == "success"
    assert llm.user == "少女回眸"  # dispatch 的 prompt 是本次指令，不是旧 gen_prompt / 正文
    d = store.snap["nodes"][0]["data"]
    assert d["gen_prompt"] == "少女回眸" and d["skill_id"] == "prompt_expansion"
    assert d["prompt"] == d["text"] == "LLM 生成结果"
    assert "image_prompt" not in d and "video_prompt" not in d


# ---------- 5. HTTP 接口仍走同一实现 ----------

@pytest.fixture()
def client():
    from app.api.routes import router
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    return TestClient(app)


def test_llm_expand_endpoint_unchanged(client, llm):
    r = client.post("/api/v1/llm/expand", json={"prompt": " 少女回眸 ", "kind": "video"})
    assert r.status_code == 200 and r.json() == {"status": "success", "expanded": "LLM 生成结果"}
    assert "视频运动提示词" in llm.system and llm.user == "少女回眸"
    assert client.post("/api/v1/llm/expand", json={"prompt": "  "}).status_code == 400
    llm.reply = llm_mod.LLMServiceError("no key")
    r = client.post("/api/v1/llm/expand", json={"prompt": "x"})
    assert r.status_code == 502 and "no key" in r.json()["detail"]
