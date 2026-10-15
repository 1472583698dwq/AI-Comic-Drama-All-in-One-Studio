# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas 画布单一输入口 in + 有序参考列表：后端解析、执行器、画布 MCP 工具回归。

运行： python -m pytest -q server/tests/test_canvas_in_port.py
"""
import asyncio
import copy
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.canvas import inputs as ci  # noqa: E402
from app.canvas import engine as eng  # noqa: E402
from app.canvas import groups as cg  # noqa: E402


def _by_id(nodes):
    return {n["id"]: n for n in nodes}


def _src_nodes():
    return [
        {"id": "t1", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"prompt": "一个女孩在雨中奔跑"}},
        {"id": "d1", "type": "director3d", "position": {"x": 0, "y": 200}, "data": {"camera_prompt": "[推进,左摇]"}},
        {"id": "i1", "type": "load-image", "position": {"x": 0, "y": 400}, "data": {"image_url": "/s/a.png"}},
        {"id": "i2", "type": "load-image", "position": {"x": 0, "y": 600}, "data": {"image_url": "/s/b.png"}},
        {"id": "i3", "type": "load-image", "position": {"x": 0, "y": 800}, "data": {"image_url": "/s/c.png"}},
        {"id": "a1", "type": "load-audio", "position": {"x": 0, "y": 1000}, "data": {"audio_url": "/s/x.mp3"}},
        {"id": "v1", "type": "load-video", "position": {"x": 0, "y": 1200}, "data": {"video_url": "/s/r.mp4"}},
    ]


def _e(eid, src, sh, tgt, th):
    e = {"id": eid, "source": src, "target": tgt}
    if sh:
        e["sourceHandle"] = sh
    if th is not None:
        e["targetHandle"] = th
    return e


def _to_new_model(nodes, edges, target_id):
    """把旧具名口连线换成 in + refRoles（与前端迁移同口径），返回新的 (nodes, edges)。"""
    nodes = copy.deepcopy(nodes)
    edges = copy.deepcopy(edges)
    tgt = _by_id(nodes)[target_id]
    roles, order = {}, []
    for e in edges:
        if e["target"] != target_id:
            continue
        key = ci.edge_key(e)
        slot = ci.LEGACY_HANDLE_SLOTS.get(e.get("targetHandle") or "")
        if slot:
            roles[key] = slot
        order.append(key)
        e["targetHandle"] = "in"
    tgt.setdefault("data", {})["refRoles"] = roles
    tgt["data"]["refOrder"] = order
    return nodes, edges


# ---------- 1. 解析规则 ----------

class TestResolverLegacyVsNew(unittest.TestCase):
    def _assert_same(self, nodes, edges, target_id):
        old = ci.collect_inputs(_by_id(nodes)[target_id], edges, _by_id(nodes))
        n2, e2 = _to_new_model(nodes, edges, target_id)
        new = ci.collect_inputs(_by_id(n2)[target_id], e2, _by_id(n2))
        self.assertEqual(old["slots"], new["slots"])
        self.assertEqual(old["mode"], new["mode"])
        self.assertEqual(eng.collect_upstream_data(target_id, nodes, edges, {}),
                         eng.collect_upstream_data(target_id, n2, e2, {}))
        return old

    def test_video_all_slots(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 400, "y": 0}, "data": {}}]
        edges = [
            _e("e1", "t1", "prompt", "vid", "prompt"),
            _e("e2", "d1", "camera_prompt", "vid", "camera_prompt"),
            _e("e3", "i1", "image", "vid", "first_frame"),
            _e("e4", "i2", "image", "vid", "last_frame"),
            _e("e5", "i3", "image", "vid", "reference_images"),
            _e("e6", "a1", "audio", "vid", "ref_audio"),
        ]
        r = self._assert_same(nodes, edges, "vid")
        self.assertEqual(r["slots"], {
            "prompt": "一个女孩在雨中奔跑", "camera_prompt": "[推进,左摇]",
            "first_frame": "/s/a.png", "last_frame": "/s/b.png",
            "reference_images": ["/s/c.png"], "ref_audio": ["/s/x.mp3"],
        })
        # mode 是自动落位用的模式（按全部图片参考数：3 张 → multiReference）；显式槽位不受影响，生成源模式由引擎按槽位定
        self.assertEqual(r["mode"], "multiReference")
        self.assertTrue(all(x["assigned_by"] == "legacy_handle" for x in r["refs"]))

    def test_image_reference_handles(self):
        nodes = _src_nodes() + [{"id": "img", "type": "image", "position": {"x": 400, "y": 0}, "data": {}}]
        edges = [
            _e("e1", "t1", "prompt", "img", "prompt"),
            _e("e2", "i1", "image", "img", "reference"),
            _e("e3", "i2", "image", "img", "reference_images"),
            _e("e4", "d1", "camera_prompt", "img", "camera_prompt"),
        ]
        r = self._assert_same(nodes, edges, "img")
        self.assertEqual(r["slots"]["reference_images"], ["/s/a.png", "/s/b.png"])
        self.assertEqual(r["slots"]["camera_prompt"], "[推进,左摇]")
        self.assertEqual(r["mode"], "")

    def test_audio_text_and_ref_audio(self):
        nodes = _src_nodes() + [{"id": "aud", "type": "audio", "position": {"x": 400, "y": 0}, "data": {}}]
        edges = [_e("e1", "t1", "prompt", "aud", "text"), _e("e2", "a1", "audio", "aud", "ref_audio")]
        r = self._assert_same(nodes, edges, "aud")
        self.assertEqual(r["slots"], {"prompt": "一个女孩在雨中奔跑", "ref_audio": ["/s/x.mp3"]})


class TestAutoAssignment(unittest.TestCase):
    def _video(self, n_images, mode=None, roles=None):
        data = {}
        if mode is not None:
            data["mode"] = mode
        if roles:
            data["refRoles"] = roles
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 400, "y": 0}, "data": data}]
        edges = [_e(f"e{i}", f"i{i}", "image", "vid", "in") for i in range(1, n_images + 1)]
        return ci.collect_inputs(_by_id(nodes)["vid"], edges, _by_id(nodes))

    def test_zero_images_is_text(self):
        r = self._video(0)
        self.assertEqual(r["slots"], {})
        self.assertEqual(r["mode"], "text")

    def test_one_image_first_frame(self):
        r = self._video(1)
        self.assertEqual(r["slots"], {"first_frame": "/s/a.png"})
        self.assertEqual(r["mode"], "singleImage")
        self.assertEqual(r["refs"][0]["assigned_by"], "auto")

    def test_two_images_reference_by_default(self):
        r = self._video(2)
        self.assertEqual(r["slots"], {"reference_images": ["/s/a.png", "/s/b.png"]})
        self.assertEqual(r["mode"], "multiReference")

    def test_two_images_start_end_mode(self):
        r = self._video(2, mode="startEnd")
        self.assertEqual(r["slots"], {"first_frame": "/s/a.png", "last_frame": "/s/b.png"})
        r3 = self._video(3, mode="startEnd")
        self.assertEqual(r3["slots"]["reference_images"], ["/s/c.png"])

    def test_single_image_mode_and_text_mode(self):
        r = self._video(2, mode="singleImage")
        self.assertEqual(r["slots"], {"first_frame": "/s/a.png", "reference_images": ["/s/b.png"]})
        t = self._video(2, mode="text")
        self.assertEqual(t["slots"], {})
        self.assertTrue(all(x.get("ignored") for x in t["refs"]))

    def test_multi_reference_and_legacy_r2v(self):
        self.assertEqual(self._video(1, mode="multiReference")["slots"], {"reference_images": ["/s/a.png"]})
        self.assertEqual(self._video(1, mode="r2v")["slots"], {"reference_images": ["/s/a.png"]})
        # 旧生成源模式：i2v→singleImage、t2v→text
        self.assertEqual(self._video(2, mode="i2v")["slots"], {"first_frame": "/s/a.png", "reference_images": ["/s/b.png"]})
        self.assertEqual(self._video(1, mode="t2v")["slots"], {})
        self.assertEqual(self._video(2, mode="i2v", roles={"i1|image": "first_frame", "i2|image": "last_frame"})["mode"], "startEnd")

    def test_explicit_first_frame_then_auto_goes_reference(self):
        r = self._video(2, roles={"i2|image": "first_frame"})
        self.assertEqual(r["slots"], {"first_frame": "/s/b.png", "reference_images": ["/s/a.png"]})

    def test_single_slot_first_wins(self):
        r = self._video(2, roles={"i1|image": "first_frame", "i2|image": "first_frame"})
        self.assertEqual(r["slots"], {"first_frame": "/s/a.png"})
        self.assertTrue(r["refs"][1].get("ignored"))

    def test_image_target_single_image_is_reference(self):
        nodes = _src_nodes() + [{"id": "img", "type": "image", "position": {"x": 0, "y": 0}, "data": {}}]
        r = ci.collect_inputs(_by_id(nodes)["img"], [_e("e1", "i1", "image", "img", "in")], _by_id(nodes))
        self.assertEqual(r["slots"], {"reference_images": ["/s/a.png"]})

    def test_audio_video_refs(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 0, "y": 0}, "data": {}}]
        edges = [_e("e1", "a1", "audio", "vid", "in"), _e("e2", "v1", "video", "vid", "in")]
        r = ci.collect_inputs(_by_id(nodes)["vid"], edges, _by_id(nodes))
        self.assertEqual(r["slots"], {"ref_audio": ["/s/x.mp3"], "reference_video": ["/s/r.mp4"]})
        self.assertEqual(r["mode"], "multiReference")

    def test_role_kind_mismatch_falls_back_to_auto(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 0, "y": 0},
                                 "data": {"refRoles": {"t1|prompt": "first_frame"}}}]
        r = ci.collect_inputs(_by_id(nodes)["vid"], [_e("e1", "t1", "prompt", "vid", "in")], _by_id(nodes))
        self.assertEqual(r["slots"], {"prompt": "一个女孩在雨中奔跑"})
        self.assertEqual(r["refs"][0]["assigned_by"], "auto")

    def test_director_text_goes_to_camera_prompt(self):
        for ttype, slot in (("video", "camera_prompt"), ("image", "camera_prompt"), ("audio", "camera_prompt")):
            nodes = _src_nodes() + [{"id": "g", "type": ttype, "position": {"x": 0, "y": 0}, "data": {}}]
            r = ci.collect_inputs(_by_id(nodes)["g"], [_e("e1", "d1", "", "g", "in")], _by_id(nodes))
            self.assertEqual(r["refs"][0]["slot"], slot, ttype)
        nodes = _src_nodes() + [{"id": "g", "type": "video", "data": {"refRoles": {"d1|camera_prompt": "prompt"}}}]
        r = ci.collect_inputs(_by_id(nodes)["g"], [_e("e1", "d1", "camera_prompt", "g", "in")], _by_id(nodes))
        self.assertEqual(r["slots"], {"prompt": "[推进,左摇]"})

    def test_empty_target_handle_is_auto(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 0, "y": 0}, "data": {}}]
        r = ci.collect_inputs(_by_id(nodes)["vid"], [{"id": "e1", "source": "i1", "target": "vid"}], _by_id(nodes))
        self.assertEqual(r["slots"], {"first_frame": "/s/a.png"})

    def test_batch_image_expands(self):
        nodes = [{"id": "b", "type": "load-image-batch", "data": {"images": ["/1.png", "/2.png"]}},
                 {"id": "vid", "type": "video", "data": {}}]
        r = ci.collect_inputs(nodes[1], [_e("e1", "b", "images", "vid", "in")], _by_id(nodes))
        self.assertEqual(r["slots"], {"reference_images": ["/1.png", "/2.png"]})
        self.assertEqual(r["refs"][0]["values"], ["/1.png", "/2.png"])

    def test_results_override_node_data(self):
        nodes = [{"id": "g1", "type": "image", "data": {"image_url": "/old.png"}}, {"id": "vid", "type": "video", "data": {}}]
        r = ci.collect_inputs(nodes[1], [_e("e1", "g1", "image", "vid", "in")], _by_id(nodes),
                              results={"g1": {"status": "success", "image_url": "/new.png"}})
        self.assertEqual(r["slots"]["first_frame"], "/new.png")

    def test_provider_and_group_sources_are_not_refs(self):
        nodes = [{"id": "p", "type": "provider-video", "data": {"provider_id": "seedance"}},
                 {"id": "grp", "type": "group", "data": {}},
                 {"id": "vid", "type": "video", "data": {}}]
        edges = [_e("e1", "p", "provider", "vid", "in"), _e("e2", "grp", "", "vid", "in")]
        r = ci.collect_inputs(nodes[2], edges, _by_id(nodes))
        self.assertEqual(r["refs"], [])
        up = eng.collect_upstream_data("vid", nodes, edges, {})
        self.assertEqual(up.get("provider_video"), "seedance")


class TestOrderAndPrompt(unittest.TestCase):
    def _nodes(self, own="", order=None):
        data = {"prompt": own}
        if order is not None:
            data["refOrder"] = order
        return [
            {"id": "ta", "type": "prompt", "data": {"prompt": "角色：白衣少女"}},
            {"id": "tb", "type": "prompt", "data": {"prompt": "场景：竹林夜雨"}},
            {"id": "im", "type": "load-image", "data": {"image_url": "/s/a.png"}},
            {"id": "img", "type": "image", "data": data},
        ]

    def _edges(self):
        return [_e("e1", "ta", "text", "img", "in"), _e("e2", "im", "image", "img", "in"), _e("e3", "tb", "text", "img", "in")]

    def test_own_prompt_plus_numbered_refs(self):
        nodes = self._nodes(own="画 {{ref 1}} 站在 {{ref 3}}")
        r = ci.collect_inputs(nodes[-1], self._edges(), _by_id(nodes))
        self.assertEqual(r["slots"]["prompt"], "画 参考 1 站在 参考 3\n\n参考 1：\n角色：白衣少女\n\n参考 3：\n场景：竹林夜雨")
        self.assertEqual([x["n"] for x in r["refs"]], [1, 2, 3])

    def test_media_ref_token_gets_mapping(self):
        nodes = self._nodes(own="让 {{ref 1}} 穿上 {{ref 2}} 的衣服")
        r = ci.collect_inputs(nodes[-1], self._edges(), _by_id(nodes))
        self.assertEqual(r["slots"]["prompt"], "让 参考 1 穿上 参考 2 的衣服\n\n参考 1：\n角色：白衣少女\n\n参考 3：\n场景：竹林夜雨"
                                               "\n\n（参考编号对应：参考 2=第 1 张参考图）")
        vnodes = _src_nodes() + [{"id": "vid", "type": "video", "data": {"prompt": "{{ref 1}} 到 {{ref 2}}", "mode": "startEnd"}}]
        rv = ci.collect_inputs(_by_id(vnodes)["vid"], [_e("a", "i1", "image", "vid", "in"), _e("b", "i2", "image", "vid", "in")], _by_id(vnodes))
        self.assertEqual(rv["slots"]["prompt"], "参考 1 到 参考 2\n\n（参考编号对应：参考 1=首帧图，参考 2=尾帧图）")

    def test_ref_order_reorders_numbers(self):
        nodes = self._nodes(own="X", order=["tb|text", "im|image"])
        r = ci.collect_inputs(nodes[-1], self._edges(), _by_id(nodes))
        self.assertEqual([x["key"] for x in r["refs"]], ["tb|text", "im|image", "ta|text"])
        self.assertEqual(r["slots"]["prompt"], "X\n\n参考 1：\n场景：竹林夜雨\n\n参考 3：\n角色：白衣少女")

    def test_empty_own_first_text_is_body(self):
        nodes = self._nodes(own="")
        r = ci.collect_inputs(nodes[-1], self._edges(), _by_id(nodes))
        self.assertEqual(r["slots"]["prompt"], "角色：白衣少女\n\n参考 3：\n场景：竹林夜雨")

    def test_copied_text_equal_to_own_is_deduped(self):
        nodes = self._nodes(own="角色：白衣少女")
        r = ci.collect_inputs(nodes[-1], self._edges(), _by_id(nodes))
        self.assertEqual(r["slots"]["prompt"], "角色：白衣少女\n\n参考 3：\n场景：竹林夜雨")

    def test_engine_uses_assembled_prompt_over_node_data(self):
        nodes = self._nodes(own="画 {{ref 1}}")
        edges = self._edges()
        up = eng.collect_upstream_data("img", nodes, edges, {})
        captured = {}

        async def fake_exec(name, args, *a, **kw):
            captured["name"], captured["args"] = name, args
            return mock.Mock(status="success", result={"image_url": "/out.png"}, execution_time_ms=1, error=None)

        node = copy.deepcopy(nodes[-1])
        node["data"]["provider_id"] = "fakeimg"
        with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
                mock.patch("app.mcp.server.mcp_registry.execute_tool", side_effect=fake_exec):
            res = asyncio.run(eng.execute_node(node, up))
        self.assertEqual(res["status"], "success")
        self.assertTrue(captured["args"]["prompt"].startswith("画 参考 1\n\n参考 1：\n角色：白衣少女"))
        self.assertEqual(captured["args"]["reference_images"], ["/s/a.png"])


# ---------- 2. 执行器：生成源入参新旧一致、group 跳过 ----------

class TestEngineProviderArgs(unittest.TestCase):
    def _run(self, node, upstream):
        captured = {}

        async def fake_exec(name, args, *a, **kw):
            captured["name"], captured["args"] = name, dict(args)
            return mock.Mock(status="success", result={"video_url": "/out.mp4", "image_url": "/out.png", "audio_url": "/out.mp3"},
                             execution_time_ms=1, error=None)

        with mock.patch.object(eng, "_ensure_provider_registered", lambda *a, **k: None), \
                mock.patch("app.mcp.server.mcp_registry.execute_tool", side_effect=fake_exec):
            res = asyncio.run(eng.execute_node(node, upstream))
        self.assertEqual(res["status"], "success", res)
        return captured

    def test_video_args_identical_old_vs_new(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "data": {"provider_id": "fakevid", "duration": 6}}]
        edges = [
            _e("e1", "t1", "prompt", "vid", "prompt"),
            _e("e2", "d1", "camera_prompt", "vid", "camera_prompt"),
            _e("e3", "i1", "image", "vid", "first_frame"),
            _e("e4", "i2", "image", "vid", "last_frame"),
            _e("e5", "a1", "audio", "vid", "ref_audio"),
        ]
        n2, e2 = _to_new_model(nodes, edges, "vid")
        old = self._run(_by_id(nodes)["vid"], eng.collect_upstream_data("vid", nodes, edges, {}))
        new = self._run(_by_id(n2)["vid"], eng.collect_upstream_data("vid", n2, e2, {}))
        self.assertEqual(old, new)
        args = old["args"]
        self.assertEqual(old["name"], "provider_fakevid")
        self.assertEqual(args["mode"], "i2v")
        self.assertEqual(args["first_frame"], "/s/a.png")
        self.assertEqual(args["last_frame"], "/s/b.png")
        self.assertEqual(args["camera_prompt"], "[推进,左摇]")
        self.assertEqual(args["reference_audios"], ["/s/x.mp3"])
        self.assertNotIn("reference_images", args)  # 首帧不再顺带塞进参考图

    def test_video_reference_only_is_r2v_and_text_only_is_t2v(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "data": {"provider_id": "fakevid"}}]
        edges = [_e("e1", "i1", "image", "vid", "in"), _e("e2", "i2", "image", "vid", "in")]
        a = self._run(_by_id(nodes)["vid"], eng.collect_upstream_data("vid", nodes, edges, {}))["args"]
        self.assertEqual(a["mode"], "r2v")
        self.assertEqual(a["reference_images"], ["/s/a.png", "/s/b.png"])
        self.assertNotIn("first_frame", a)
        edges_t = [_e("e1", "t1", "prompt", "vid", "in")]
        t = self._run(_by_id(nodes)["vid"], eng.collect_upstream_data("vid", nodes, edges_t, {}))["args"]
        self.assertEqual(t["mode"], "t2v")
        self.assertEqual(t["prompt"], "一个女孩在雨中奔跑")

    def test_video_new_mode_names_map_to_provider_modes(self):
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "data": {"provider_id": "fakevid", "mode": "startEnd"}}]
        edges = [_e("e1", "i1", "image", "vid", "in"), _e("e2", "i2", "image", "vid", "in")]
        a = self._run(_by_id(nodes)["vid"], eng.collect_upstream_data("vid", nodes, edges, {}))["args"]
        self.assertEqual((a["mode"], a["first_frame"], a["last_frame"]), ("i2v", "/s/a.png", "/s/b.png"))

    def test_image_args_identical_old_vs_new(self):
        nodes = _src_nodes() + [{"id": "img", "type": "image", "data": {"provider_id": "fakeimg"}}]
        edges = [_e("e1", "t1", "prompt", "img", "prompt"), _e("e2", "i1", "image", "img", "reference"),
                 _e("e3", "i2", "image", "img", "reference_images")]
        n2, e2 = _to_new_model(nodes, edges, "img")
        old = self._run(_by_id(nodes)["img"], eng.collect_upstream_data("img", nodes, edges, {}))
        new = self._run(_by_id(n2)["img"], eng.collect_upstream_data("img", n2, e2, {}))
        self.assertEqual(old, new)
        self.assertEqual(old["args"]["reference_images"], ["/s/a.png", "/s/b.png"])

    def test_audio_args_identical_old_vs_new(self):
        nodes = _src_nodes() + [{"id": "aud", "type": "audio", "data": {"provider_id": "fakeaud"}}]
        edges = [_e("e1", "t1", "prompt", "aud", "text"), _e("e2", "a1", "audio", "aud", "ref_audio")]
        n2, e2 = _to_new_model(nodes, edges, "aud")
        old = self._run(_by_id(nodes)["aud"], eng.collect_upstream_data("aud", nodes, edges, {}))
        new = self._run(_by_id(n2)["aud"], eng.collect_upstream_data("aud", n2, e2, {}))
        self.assertEqual(old, new)
        self.assertEqual((old["args"]["text"], old["args"]["ref_audio"]), ("一个女孩在雨中奔跑", "/s/x.mp3"))


class TestGroupSkipped(unittest.TestCase):
    def test_execute_dag_skips_group_and_expands_target(self):
        nodes = [
            {"id": "grp", "type": "group", "position": {"x": 0, "y": 0}, "data": {"label": "G"}},
            {"id": "pa", "type": "prompt", "parentId": "grp", "position": {"x": 24, "y": 40}, "data": {"prompt": "A"}},
            {"id": "pb", "type": "prompt", "parentId": "grp", "position": {"x": 300, "y": 40}, "data": {"prompt": ""}},
            {"id": "pc", "type": "prompt", "position": {"x": 900, "y": 0}, "data": {"prompt": "C"}},
        ]
        edges = [_e("e1", "pa", "text", "pb", "in")]
        out = asyncio.run(eng.canvas_engine.execute_dag(copy.deepcopy(nodes), edges))
        self.assertNotIn("grp", out["order"])
        self.assertNotIn("grp", out["results"])
        self.assertEqual(out["results"]["pb"]["text"], "A")
        only = asyncio.run(eng.canvas_engine.execute_dag(copy.deepcopy(nodes), edges, target_ids=["grp"]))
        self.assertEqual(sorted(only["order"]), ["pa", "pb"])


# ---------- 3. 画布 MCP 工具 ----------

class _FakeCanvasStore:
    def __init__(self, snap):
        self.snap = copy.deepcopy(snap)
        self.saved_ids = []

    def get_canvas(self, pid, canvas_id=None):
        return copy.deepcopy(self.snap)

    def save_canvas(self, pid, snapshot, canvas_id="default", name=None):
        self.saved_ids.append(canvas_id)
        keep = {k: self.snap.get(k) for k in ("canvas_id", "name") if k in self.snap}
        self.snap = {**keep, "nodes": copy.deepcopy(snapshot.get("nodes", [])), "edges": copy.deepcopy(snapshot.get("edges", []))}
        return {"canvas_id": canvas_id}


class TestCanvasMcpTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_inport_test_")
        settings.STORAGE_DIR = cls._tmp
        from app.mcp.server import mcp_registry
        from app.providers.project.manager import project_manager
        cls.reg = mcp_registry
        cls.pm = project_manager

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _call(self, store, tool, args):
        with mock.patch.object(self.pm, "get_canvas", store.get_canvas), \
                mock.patch.object(self.pm, "save_canvas", store.save_canvas):
            return asyncio.run(self.reg.execute_tool(tool, {"project_id": "proj_t", **args}))

    def _store(self, extra_nodes=(), edges=(), canvas_id="c2"):
        nodes = _src_nodes() + [
            {"id": "vid", "type": "video", "position": {"x": 400, "y": 0}, "data": {}},
            {"id": "exp", "type": "export", "position": {"x": 800, "y": 0}, "data": {}},
        ] + list(extra_nodes)
        return _FakeCanvasStore({"canvas_id": canvas_id, "name": "第二张", "nodes": nodes, "edges": list(edges)})

    def _node(self, store, nid):
        return _by_id(store.snap["nodes"])[nid]

    def test_connect_legacy_handle_converted(self):
        st = self._store()
        r = self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid", "targetHandle": "first_frame"})
        self.assertEqual(r.status, "success", r.error)
        self.assertEqual(r.result["edge"]["targetHandle"], "in")
        self.assertEqual(r.result["slot"], "first_frame")
        self.assertIn("note", r.result)
        d = self._node(st, "vid")["data"]
        self.assertEqual(d["refRoles"], {"i1|image": "first_frame"})
        self.assertEqual(d["refOrder"], ["i1|image"])
        self.assertEqual(st.saved_ids, ["c2"])  # 写回读出来的那张画布

    def test_connect_explicit_slot_and_auto(self):
        st = self._store()
        r1 = self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid", "slot": "last_frame"})
        r2 = self._call(st, "canvas_connect", {"source": "t1", "sourceHandle": "text", "target": "vid"})
        self.assertEqual(r1.result["slot"], "last_frame")
        self.assertEqual((r2.result["slot"], r2.result["slot_source"], r2.result["ref_index"]), ("prompt", "auto", 2))
        d = self._node(st, "vid")["data"]
        self.assertEqual(d["refOrder"], ["i1|image", "t1|text"])
        self.assertNotIn("t1|text", d["refRoles"])

    def test_connect_fills_primary_output_port(self):
        st = self._store()
        r = self._call(st, "canvas_connect", {"source": "d1", "target": "vid"})
        self.assertEqual(r.result["edge"]["sourceHandle"], "camera_prompt")
        self.assertEqual((r.result["ref_key"], r.result["slot"]), ("d1|camera_prompt", "camera_prompt"))

    def test_connect_slot_type_mismatch_is_error(self):
        st = self._store()
        r = self._call(st, "canvas_connect", {"source": "t1", "target": "vid", "slot": "first_frame"})
        self.assertEqual(r.status, "error")
        self.assertIn("first_frame", r.error)
        bad = self._call(st, "canvas_connect", {"source": "i1", "target": "vid", "slot": "nope"})
        self.assertEqual(bad.status, "error")

    def test_connect_keeps_existing_order_when_ref_order_missing(self):
        st = self._store(edges=[_e("old1", "i1", "image", "vid", "reference_images")])
        r = self._call(st, "canvas_connect", {"source": "i2", "sourceHandle": "image", "target": "vid"})
        self.assertEqual(r.result["ref_index"], 2)
        self.assertEqual(self._node(st, "vid")["data"]["refOrder"], ["i1|image", "i2|image"])

    def test_reconnect_updates_slot_and_converts_legacy_edge(self):
        st = self._store(edges=[_e("old1", "i1", "image", "vid", "first_frame")])
        r = self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid", "slot": "reference_images"})
        self.assertEqual(r.result["status"], "updated")
        self.assertEqual(len(st.snap["edges"]), 1)
        self.assertEqual(st.snap["edges"][0]["targetHandle"], "in")
        self.assertEqual(self._node(st, "vid")["data"]["refRoles"], {"i1|image": "reference_images"})
        again = self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid"})
        self.assertEqual(again.result["status"], "already_connected")
        self.assertEqual(again.result["slot"], "reference_images")

    def test_connect_non_generation_target_unchanged(self):
        st = self._store()
        r = self._call(st, "canvas_connect", {"source": "v1", "sourceHandle": "video", "target": "exp", "targetHandle": "video"})
        self.assertEqual(r.result["status"], "connected")
        self.assertEqual(r.result["edge"]["targetHandle"], "video")
        self.assertNotIn("refOrder", self._node(st, "exp")["data"])

    def test_connect_group_rejected(self):
        st = self._store(extra_nodes=[{"id": "grp", "type": "group", "position": {"x": 0, "y": 0}, "data": {}}])
        r = self._call(st, "canvas_connect", {"source": "i1", "target": "grp"})
        self.assertEqual(r.status, "error")

    def test_create_group_with_children(self):
        st = self._store()
        r = self._call(st, "canvas_create_node", {"type": "group", "children": ["i1", "i2"], "label": "参考图"})
        self.assertEqual(r.status, "success", r.error)
        g = r.result["node"]
        # i1 @(0,400) i2 @(0,600)，默认尺寸 220x240 → 包围盒 (0,400)-(220,840)，内边距 L/R 24 T 40 B 24
        self.assertEqual(g["position"], {"x": -24.0, "y": 360.0})
        self.assertEqual((g["width"], g["height"]), (268.0, 504.0))
        self.assertEqual(g["data"]["label"], "参考图")
        self.assertEqual(sorted(r.result["children"]), ["i1", "i2"])
        ids = [n["id"] for n in st.snap["nodes"]]
        self.assertLess(ids.index(g["id"]), ids.index("i1"))  # 父节点排在子节点前
        i1 = self._node(st, "i1")
        self.assertEqual((i1["parentId"], i1["position"]), (g["id"], {"x": 24.0, "y": 40.0}))
        # 分组不影响参考解析
        self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid"})
        q = self._call(st, "canvas_query", {})
        self.assertEqual(q.result["inputs"]["vid"][0]["slot"], "first_frame")
        self.assertIn("[group]", q.result["summary"])

    def test_create_group_missing_children_error(self):
        st = self._store()
        r = self._call(st, "canvas_create_node", {"type": "group", "children": ["nope"]})
        self.assertEqual(r.status, "error")

    def test_delete_group_releases_children_and_delete_cleans_refs(self):
        st = self._store()
        g = self._call(st, "canvas_create_node", {"type": "group", "children": ["i1"]}).result["node"]
        self._call(st, "canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid", "slot": "first_frame"})
        d = self._call(st, "canvas_delete_node", {"node_id": g["id"]})
        self.assertEqual(d.result["released_children"], ["i1"])
        i1 = self._node(st, "i1")
        self.assertNotIn("parentId", i1)
        self.assertEqual(i1["position"], {"x": 0.0, "y": 400.0})
        self._call(st, "canvas_delete_node", {"node_id": "i1"})
        vd = self._node(st, "vid")["data"]
        self.assertEqual((vd["refOrder"], vd["refRoles"]), ([], {}))

    def test_create_node_legacy_type_alias_and_defaults(self):
        st = self._store()
        r = self._call(st, "canvas_create_node", {"type": "tts", "params": {"text": "你好"}})
        n = r.result["node"]
        self.assertEqual(n["type"], "audio")
        self.assertEqual((n["data"]["refOrder"], n["data"]["refRoles"]), ([], {}))

    def test_query_lists_refs_in_order_with_slots(self):
        st = self._store(edges=[_e("a", "t1", "prompt", "vid", "prompt"), _e("b", "i1", "image", "vid", "in"),
                                _e("c", "d1", "camera_prompt", "vid", "in")])
        q = self._call(st, "canvas_query", {})
        refs = q.result["inputs"]["vid"]
        self.assertEqual([(r["n"], r["kind"], r["slot"]) for r in refs],
                         [(1, "STRING", "prompt"), (2, "IMAGE", "first_frame"), (3, "STRING", "camera_prompt")])
        self.assertIn("input_model", q.result)


class TestMcpRealStorageKeepsDefaultCanvas(unittest.TestCase):
    """真实落盘：MCP 改的是当前激活的非默认画布，default 不被覆盖，schema_version/viewport 等顶层键保留。"""

    def setUp(self):
        import app.providers.project.manager as pm_mod
        from app.mcp.server import mcp_registry
        self.reg = mcp_registry
        self.pm = pm_mod.project_manager
        self._tmp = tempfile.mkdtemp(prefix="studio_inport_store_")
        root = os.path.join(self._tmp, "projects")
        os.makedirs(root, exist_ok=True)
        self._patches = [
            mock.patch.object(pm_mod, "PROJECTS_ROOT", root),
            mock.patch.object(pm_mod, "INDEX_PATH", os.path.join(root, "index.json")),
        ]
        for p in self._patches:
            p.start()
        self.pid = self.pm.create_project("in口测试")["id"]
        self.default_nodes = [{"id": "keep", "type": "prompt", "position": {"x": 0, "y": 0}, "data": {"prompt": "默认画布"}}]
        self.pm.save_canvas(self.pid, {"nodes": self.default_nodes, "edges": []}, canvas_id="default")
        nodes = _src_nodes() + [{"id": "vid", "type": "video", "position": {"x": 400, "y": 0}, "data": {}}]
        self.pm.save_canvas(self.pid, {"nodes": nodes, "edges": [], "schema_version": 2, "viewport": {"x": 1, "y": 2, "zoom": 0.5}},
                            canvas_id="c2", name="第二张")

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _call(self, tool, args):
        return asyncio.run(self.reg.execute_tool(tool, {"project_id": self.pid, **args}))

    def test_connect_create_delete_write_active_canvas_only(self):
        r = self._call("canvas_connect", {"source": "i1", "sourceHandle": "image", "target": "vid", "targetHandle": "first_frame"})
        self.assertEqual(r.status, "success", r.error)
        g = self._call("canvas_create_node", {"type": "group", "children": ["i2"]})
        self.assertEqual(g.status, "success", g.error)
        self.assertEqual(self._call("canvas_delete_node", {"node_id": "i3"}).status, "success")
        default = self.pm.get_canvas(self.pid, canvas_id="default")
        self.assertEqual(default["nodes"], self.default_nodes)
        self.assertEqual(default["edges"], [])
        c2 = self.pm.get_canvas(self.pid)
        self.assertEqual(c2["canvas_id"], "c2")
        self.assertEqual(c2["schema_version"], 2)
        self.assertEqual(c2["viewport"], {"x": 1, "y": 2, "zoom": 0.5})
        self.assertEqual(c2["edges"][0]["targetHandle"], "in")
        self.assertEqual(_by_id(c2["nodes"])["vid"]["data"]["refRoles"], {"i1|image": "first_frame"})
        self.assertIn(g.result["node"]["id"], _by_id(c2["nodes"]))
        self.assertNotIn("i3", _by_id(c2["nodes"]))


class TestGroupGeometry(unittest.TestCase):
    def test_nested_and_measured_sizes(self):
        nodes = [
            {"id": "outer", "type": "group", "position": {"x": 100, "y": 100}, "width": 800, "height": 600, "data": {}},
            {"id": "a", "type": "image", "parentId": "outer", "position": {"x": 50, "y": 60}, "measured": {"width": 300, "height": 200}, "data": {}},
            {"id": "b", "type": "image", "parentId": "outer", "position": {"x": 400, "y": 60}, "style": {"width": "200px", "height": 100}, "data": {}},
        ]
        g, missing = cg.create_group(nodes, "inner", ["a", "b"], label="内")
        self.assertEqual(missing, [])
        self.assertEqual(g["parentId"], "outer")
        # 绝对包围盒 (150,160)-(700,360) → 带内边距 (126,120)-(724,384)，相对 outer (26,20)
        self.assertEqual(g["position"], {"x": 26.0, "y": 20.0})
        self.assertEqual((g["width"], g["height"]), (598.0, 264.0))
        self.assertEqual(_by_id(nodes)["a"]["position"], {"x": 24.0, "y": 40.0})
        released = cg.release_children(nodes, "inner")
        self.assertEqual(sorted(released), ["a", "b"])
        self.assertEqual(_by_id(nodes)["a"]["parentId"], "outer")
        self.assertEqual(_by_id(nodes)["a"]["position"], {"x": 50.0, "y": 60.0})


if __name__ == "__main__":
    unittest.main()
