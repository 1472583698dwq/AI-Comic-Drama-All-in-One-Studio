# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas T6：扩展节点（ext-node）/ 代码节点（custom）的输入回归。

覆盖 N7 遗留的两个后端 bug：
1. 统一执行口把扁平 args 全当 params → 代码节点 inputs 为空（upscale_demo 报「缺少输入视频」）；
2. DAG 里上游值没有落到目标的声明端口 id（video 口写成 video_url/videos）→ 用的是节点上旧的传播值。

运行： python -m pytest -q server/tests/test_ext_node_inputs.py
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.canvas import engine as eng  # noqa: E402
from app.canvas import inputs as ci  # noqa: E402
from app.canvas_nodes.manager import canvas_node_manager, run_canvas_node, build_run_args, input_arg_keys  # noqa: E402
from app.canvas_nodes.models import CanvasNodeSpec  # noqa: E402
from app.custom_nodes.manager import custom_node_manager, split_run_args  # noqa: E402
from app.custom_nodes.models import CustomNodeDefinition  # noqa: E402
from app.extensions.registry import extension_registry  # noqa: E402

PACK = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "plugins", "example-drama-pack"))


def _by_id(nodes):
    return {n["id"]: n for n in nodes}


def _e(eid, src, sh, tgt, th):
    e = {"id": eid, "source": src, "target": tgt}
    if sh is not None:
        e["sourceHandle"] = sh
    if th is not None:
        e["targetHandle"] = th
    return e


def _load_example_pack():
    """把示例插件的 upscale_demo（真实代码文件）与 upscale_ext 声明落进当前 STORAGE_DIR。"""
    from app.plugins.manager import _resolve_code_ref
    with open(os.path.join(PACK, "custom_nodes", "upscale_demo.json"), "r", encoding="utf-8") as f:
        doc = CustomNodeDefinition.model_validate(json.load(f))
    _resolve_code_ref(PACK, "custom_nodes/upscale_demo.json", doc)
    custom_node_manager.save(doc)
    with open(os.path.join(PACK, "canvas_nodes", "upscale_ext.json"), "r", encoding="utf-8") as f:
        spec = CanvasNodeSpec.model_validate(json.load(f))
    canvas_node_manager.save(spec)
    return doc, spec


def _custom_def(**over):
    doc = {
        "id": "cn_demo", "name": "demo", "kind": "video",
        "input_schema": {"type": "object", "properties": {
            "video": {"type": "string", "format": "uri", "x-handle": "video"},
            "prompt": {"type": "string", "x-handle": "text"},
        }},
        "params_schema": {"type": "object", "properties": {"scale": {"type": "integer"}}},
    }
    doc.update(over)
    return CustomNodeDefinition.model_validate(doc)


class _TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_t6_test_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)


# ---------- bug 1：统一执行口 args → inputs / params ----------

class TestSplitRunArgs(unittest.TestCase):
    def test_flat_args_split_by_input_schema(self):
        inputs, params = split_run_args(_custom_def(), {"video": "/v.mp4", "prompt": "p", "scale": 2, "project_id": "p1"})
        self.assertEqual(inputs, {"video": "/v.mp4", "prompt": "p"})
        self.assertEqual(params, {"scale": 2, "project_id": "p1"})

    def test_nested_shape_kept(self):
        args = {"inputs": {"video": "/v.mp4"}, "params": {"scale": 3}}
        self.assertEqual(split_run_args(_custom_def(), args), ({"video": "/v.mp4"}, {"scale": 3}))
        # 旧语义：没给 params 时其余键进 params
        self.assertEqual(split_run_args(_custom_def(), {"inputs": {"video": "/v.mp4"}, "scale": 4}),
                         ({"video": "/v.mp4"}, {"scale": 4}))
        # 只给 params：顶层已声明的输入键补进 inputs
        self.assertEqual(split_run_args(_custom_def(), {"params": {"scale": 5}, "video": "/v.mp4"}),
                         ({"video": "/v.mp4"}, {"scale": 5}))
        # 空 params dict 不再把 {"params": {}} 自己塞进 params
        self.assertEqual(split_run_args(_custom_def(), {"inputs": {"video": "/v.mp4"}, "params": {}}),
                         ({"video": "/v.mp4"}, {}))

    def test_no_input_schema_keeps_old_all_params(self):
        d = _custom_def(input_schema=None)
        self.assertEqual(split_run_args(d, {"video": "/v.mp4", "scale": 2}), ({}, {"video": "/v.mp4", "scale": 2}))

    def test_input_keys_hint_goes_both_sides_unless_param(self):
        d = _custom_def(input_schema=None)
        inputs, params = split_run_args(d, {"clip": "/v.mp4", "scale": 2}, input_keys=["clip", "scale"])
        self.assertEqual(inputs, {"clip": "/v.mp4"})  # scale 是代码节点声明的参数：只进 params
        self.assertEqual(params, {"clip": "/v.mp4", "scale": 2})

    def test_input_arg_keys_follow_spec_ports_and_map(self):
        spec = CanvasNodeSpec.model_validate({
            "id": "x_ext", "name": "x", "inputs": [{"id": "clip", "type": "video"}, {"id": "note", "type": "text"}],
            "params_schema": {"type": "object", "properties": {"scale": {"type": "integer"}}},
            "run": {"extension": "custom_node:cn_demo", "map": {"video": "$in.clip", "note": "$param.scale"}},
        })
        args = build_run_args(spec, {"clip": "/v.mp4", "note": "n"}, {"scale": 2})
        # clip 同名透传 + video 来自 $in.clip；note 被 $param 映射覆盖，不算输入
        self.assertEqual(sorted(input_arg_keys(spec, args)), ["clip", "video"])


class TestExecCustomNodeCallBoundary(_TempStorage):
    """mock run_custom_node，断言统一执行口交给代码节点的 inputs / params。"""

    def _call(self, args):
        seen = {}

        async def fake_run(definition, inputs, params, extra_ctx=None):
            seen.update(inputs=inputs, params=params)
            return {"video_url": inputs.get("video")}

        with mock.patch.object(custom_node_manager, "get", lambda nid: _custom_def(id=nid)), \
                mock.patch("app.custom_nodes.manager.run_custom_node", side_effect=fake_run):
            asyncio.run(extension_registry._exec_custom_node("cn_demo", args))
        return seen

    def test_flat_args(self):
        seen = self._call({"video": "/v.mp4", "prompt": "p", "scale": 2})
        self.assertEqual(seen, {"inputs": {"video": "/v.mp4", "prompt": "p"}, "params": {"scale": 2}})

    def test_nested_args_unchanged(self):
        seen = self._call({"inputs": {"video": "/v.mp4"}, "params": {"scale": 2}})
        self.assertEqual(seen, {"inputs": {"video": "/v.mp4"}, "params": {"scale": 2}})


class TestUpscaleDemoRealRun(_TempStorage):
    """示例插件真实代码（沙箱）跑通：/extensions/execute 扁平 args、/canvas-nodes/run、画布引擎 ext-node 分支。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _load_example_pack()
        cls.video_url = "/storage/videos/t6_in.mp4"
        cls.video_file = ""
        if shutil.which("ffmpeg"):
            vdir = os.path.join(cls._tmp, "videos")
            os.makedirs(vdir, exist_ok=True)
            path = os.path.join(vdir, "t6_in.mp4")
            r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5",
                                "-t", "1", "-pix_fmt", "yuv420p", path], capture_output=True, timeout=60)
            if r.returncode == 0 and os.path.getsize(path) > 0:
                cls.video_file = path

    def test_ffmpeg_fixture(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("本机没有 ffmpeg")
        self.assertTrue(self.video_file and os.path.isfile(self.video_file))

    def test_extensions_execute_flat_args(self):
        # N7 实证：此前 {"video": …} 扁平调用报「缺少输入视频」
        res = asyncio.run(extension_registry.execute(
            "custom_node:upscale_demo", args={"video": self.video_url, "prompt": "p", "scale": 2}))
        self.assertEqual(res["video_url"], self.video_url)
        self.assertEqual(res["text"], "upscaled x2")

    def test_extensions_execute_nested_args(self):
        res = asyncio.run(extension_registry.execute(
            "custom_node:upscale_demo", args={"inputs": {"video": self.video_url}, "params": {"scale": 3}}))
        self.assertEqual((res["video_url"], res["text"]), (self.video_url, "upscaled x3"))

    def test_run_canvas_node(self):
        spec = canvas_node_manager.get("upscale_ext")
        out = asyncio.run(run_canvas_node(spec, {"video": self.video_url, "prompt": "p"}, {"scale": 4}))
        self.assertEqual(out["status"], "success", out)
        self.assertEqual(out["outputs"], {"video": self.video_url})
        self.assertEqual(out["text"], "upscaled x4")

    def test_run_canvas_node_sends_nested_args(self):
        spec = canvas_node_manager.get("upscale_ext")
        calls = {}

        async def fake_execute(ext_id, args=None, entry="generate", scope=""):
            calls["args"] = args
            return {"video_url": "/o.mp4"}

        with mock.patch.object(extension_registry, "execute", side_effect=fake_execute):
            asyncio.run(run_canvas_node(spec, {"video": "/v.mp4", "prompt": "p"}, {"scale": 2}))
        self.assertEqual(calls["args"], {"inputs": {"video": "/v.mp4", "prompt": "p"}, "params": {"scale": 2}})

    def test_engine_ext_node_with_upstream_video(self):
        nodes = [
            {"id": "v1", "type": "load-video", "position": {"x": 0, "y": 0}, "data": {"video_url": self.video_url}},
            {"id": "ext", "type": "ext-node", "position": {"x": 400, "y": 0},
             "data": {"canvas_node_id": "upscale_ext", "params": {"scale": 2}}},
        ]
        edges = [_e("e1", "v1", "video", "ext", "video")]
        up = eng.collect_upstream_data("ext", nodes, edges, {})
        self.assertEqual(up["video"], self.video_url)
        res = asyncio.run(eng.execute_node(nodes[1], up))
        self.assertEqual(res["status"], "success", res)
        self.assertEqual(res["outputs"], {"video": self.video_url})

    def test_dag_uses_regenerated_upstream_not_stale_node_data(self):
        nodes = [
            {"id": "gen", "type": "video", "position": {"x": 0, "y": 0},
             "data": {"prompt": "x", "video_url": "/storage/videos/old.mp4"}},
            # 节点上是上次连线时前端传播下来的旧值
            {"id": "ext", "type": "ext-node", "position": {"x": 400, "y": 0},
             "data": {"canvas_node_id": "upscale_ext", "video": "/storage/videos/old.mp4", "params": {"scale": 2}}},
        ]
        edges = [_e("e1", "gen", "video", "ext", "video")]
        real_execute_node = eng.execute_node

        async def fake_execute_node(node, upstream, project_id=None):
            if node["id"] == "gen":
                return {"status": "success", "video_url": "/storage/videos/new.mp4"}
            return await real_execute_node(node, upstream, project_id=project_id)

        # REQ-toonflow-canvas FX-B（COORDINATION 第 16 条）：target_ids 只执行目标 + 缺产出的上游，
        # 已有产出的 gen 不再被连带重跑；要重新生成上游就把它也列进 target_ids
        with mock.patch.object(eng, "execute_node", side_effect=fake_execute_node):
            out = asyncio.run(eng.canvas_engine.execute_dag(nodes, edges, target_ids=["gen", "ext"]))
        res = out["results"]["ext"]
        self.assertEqual(res["status"], "success", res)
        self.assertEqual(res["video_url"], "/storage/videos/new.mp4")
        self.assertEqual(res["outputs"], {"video": "/storage/videos/new.mp4"})
        with mock.patch.object(eng, "execute_node", side_effect=fake_execute_node) as m:
            out = asyncio.run(eng.canvas_engine.execute_dag(nodes, edges, target_ids=["ext"]))
        self.assertEqual([c.args[0]["id"] for c in m.call_args_list], ["ext"])
        self.assertEqual(out["results"]["ext"]["outputs"], {"video": "/storage/videos/old.mp4"})


# ---------- bug 2：上游值 → 目标声明端口 id ----------

class TestCollectUpstreamToDeclaredPorts(_TempStorage):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _load_example_pack()
        custom_node_manager.save(CustomNodeDefinition.model_validate({
            "id": "cn_multi", "name": "multi", "kind": "image", "code": "async def run(inputs, params, ctx):\n    return {}\n",
            "input_schema": {"type": "object", "properties": {
                "refs": {"type": "array", "items": {"type": "string", "format": "uri"}, "x-handle": "image"},
                "caption": {"type": "string"},
            }},
        }))

    def _nodes(self, extra=()):
        return [
            {"id": "v1", "type": "load-video", "data": {"video_url": "/s/v1.mp4"}},
            {"id": "i1", "type": "load-image", "data": {"image_url": "/s/a.png"}},
            {"id": "i2", "type": "load-image", "data": {"image_url": "/s/b.png"}},
            {"id": "t1", "type": "prompt", "data": {"prompt": "放大一点"}},
            {"id": "ext", "type": "ext-node", "data": {"canvas_node_id": "upscale_ext"}},
            *extra,
        ]

    def test_ext_ports_by_target_handle(self):
        nodes = self._nodes()
        edges = [_e("e1", "v1", "video", "ext", "video"), _e("e2", "t1", "prompt", "ext", "prompt")]
        up = eng.collect_upstream_data("ext", nodes, edges, {})
        self.assertEqual((up["video"], up["prompt"]), ("/s/v1.mp4", "放大一点"))

    def test_no_handle_goes_to_first_port_and_unknown_handle_ignored(self):
        nodes = self._nodes()
        up = eng.collect_upstream_data("ext", nodes, [_e("e1", "v1", "video", "ext", None)], {})
        self.assertEqual(up["video"], "/s/v1.mp4")
        up = eng.collect_upstream_data("ext", nodes, [_e("e1", "v1", "video", "ext", "first_frame")], {})
        self.assertNotIn("video", up)

    def test_kind_mismatch_not_landed(self):
        up = eng.collect_upstream_data("ext", self._nodes(), [_e("e1", "i1", "image", "ext", "video")], {})
        self.assertNotIn("video", up)

    def test_results_override_node_data(self):
        up = eng.collect_upstream_data("ext", self._nodes(), [_e("e1", "v1", "video", "ext", "video")],
                                       {"v1": {"status": "success", "video_url": "/s/fresh.mp4"}})
        self.assertEqual(up["video"], "/s/fresh.mp4")

    def test_ext_snapshot_definition_when_spec_missing(self):
        snap = {"id": "gone_ext", "inputs": [{"id": "clip", "type": "video"}], "outputs": []}
        nodes = self._nodes([{"id": "ext2", "type": "ext-node", "data": {"canvas_node_id": "gone_ext", "definition": snap}}])
        up = eng.collect_upstream_data("ext2", nodes, [_e("e1", "v1", "video", "ext2", "clip")], {})
        self.assertEqual(up["clip"], "/s/v1.mp4")

    def test_custom_multi_port_and_text_port(self):
        nodes = self._nodes([{"id": "cn", "type": "custom", "data": {"custom_node_id": "cn_multi"}}])
        edges = [_e("e1", "i1", "image", "cn", "refs"), _e("e2", "i2", "image", "cn", "refs"),
                 _e("e3", "i1", "image", "cn", "refs"), _e("e4", "t1", "prompt", "cn", "caption")]
        up = eng.collect_upstream_data("cn", nodes, edges, {})
        self.assertEqual(up["refs"], ["/s/a.png", "/s/b.png"])
        self.assertEqual(up["caption"], "放大一点")

    def test_custom_without_schema_uses_fallback_ports(self):
        nodes = self._nodes([{"id": "cn", "type": "custom", "data": {"custom_node_id": "not_saved"}}])
        up = eng.collect_upstream_data("cn", nodes, [_e("e1", "v1", "video", "cn", "video")], {})
        self.assertEqual(up["video"], "/s/v1.mp4")

    def test_engine_custom_branch_reads_port_value_over_stale_data(self):
        nodes = self._nodes([{"id": "cn", "type": "custom",
                              "data": {"custom_node_id": "upscale_demo", "video": "/s/stale.mp4"}}])
        up = eng.collect_upstream_data("cn", nodes, [_e("e1", "v1", "video", "cn", "video")],
                                       {"v1": {"status": "success", "video_url": "/s/fresh.mp4"}})
        res = asyncio.run(eng.execute_node(_by_id(nodes)["cn"], up))
        self.assertEqual(res["status"], "success", res)
        self.assertEqual(res["video_url"], "/s/fresh.mp4")

    def test_ext_source_reads_outputs_not_same_named_input(self):
        nodes = self._nodes([
            {"id": "ext_b", "type": "ext-node", "data": {"canvas_node_id": "upscale_ext"}},
            {"id": "vid", "type": "video", "data": {}},
        ])
        _by_id(nodes)["ext"]["data"]["video"] = "/s/input_of_ext.mp4"  # 输入口的值，不是产出
        chain = [_e("e1", "ext", "video", "ext_b", "video")]
        # 上游没跑出结果：不能把它的输入当产出漏给下游
        self.assertNotIn("video", eng.collect_upstream_data("ext_b", nodes, chain, {}))
        self.assertEqual(ci.source_values(ci.VIDEO, _by_id(nodes)["ext"], "video", {"status": "error"}), [])
        # 跑出结果：读 outputs[端口]
        res = {"status": "success", "outputs": {"video": "/s/out.mp4"}, "video_url": "/s/out.mp4"}
        self.assertEqual(eng.collect_upstream_data("ext_b", nodes, chain, {"ext": res})["video"], "/s/out.mp4")
        # 生成节点（in 口）作为下游也一样
        r = ci.collect_inputs(_by_id(nodes)["vid"], [_e("e2", "ext", "video", "vid", "in")], _by_id(nodes), {"ext": res})
        self.assertEqual(r["slots"].get("reference_video"), ["/s/out.mp4"])

    def test_provider_source_not_landed_but_passed_through(self):
        nodes = self._nodes([{"id": "p", "type": "provider-video", "data": {"provider_id": "seedance"}}])
        up = eng.collect_upstream_data("ext", nodes, [_e("e1", "p", "provider", "ext", None)], {})
        self.assertNotIn("video", up)
        self.assertEqual(up.get("provider_video"), "seedance")


if __name__ == "__main__":
    unittest.main(verbosity=2)
