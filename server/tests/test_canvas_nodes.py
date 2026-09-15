# -*- coding: utf-8 -*-
"""声明式画布节点（canvas_nodes）回归测试（stdlib unittest，零依赖）。

运行： python -m unittest discover -s server/tests -p "test_*.py" -v
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.canvas_nodes.manager import (  # noqa: E402
    canvas_node_manager, build_run_args, run_canvas_node,
)
from app.canvas_nodes.models import CanvasNodeSpec  # noqa: E402
from app.extensions import state  # noqa: E402


def _spec_doc(**over):
    doc = {
        "id": "upscale_ext",
        "name": "智能超分",
        "kind": "video",
        "inputs": [{"id": "video", "label": "输入视频", "type": "video", "required": True},
                   {"id": "prompt", "label": "文本", "type": "text"}],
        "outputs": [{"id": "video", "label": "视频", "type": "video", "from": "video_url"}],
        "params_schema": {"type": "object", "properties": {"scale": {"type": "integer", "default": 2}}},
        "run": {"extension": "custom_node:upscale_demo",
                "map": {"video": "$in.video", "scale": "$param.scale", "prompt": "$in.prompt"}},
    }
    doc.update(over)
    return doc


class _TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_cn_test_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def tearDown(self):
        state.set_disabled("canvas_node:upscale_ext", False)
        state.set_disabled("canvas_node:upscale_ext", False, scope="proj-1")


class TestSpecValidation(_TempStorage):
    def test_valid_spec(self):
        spec = CanvasNodeSpec.model_validate(_spec_doc())
        self.assertEqual(spec.id, "upscale_ext")
        self.assertEqual(spec.outputs[0].from_key, "video_url")
        # by_alias 序列化保持插件声明口径
        self.assertEqual(spec.model_dump(by_alias=True)["outputs"][0]["from"], "video_url")

    def test_bad_extension_kind_rejected(self):
        # provider/skill/custom_node/mcp_tool 均为合法目标
        spec = CanvasNodeSpec.model_validate(_spec_doc(run={"extension": "provider:ok", "entry": "image"}))
        self.assertEqual(spec.run.extension, "provider:ok")
        with self.assertRaises(ValueError):
            CanvasNodeSpec.model_validate(_spec_doc(run={"extension": "canvas_node:other"}))
        with self.assertRaises(ValueError):
            CanvasNodeSpec.model_validate(_spec_doc(run={"extension": "no-colon"}))

    def test_bad_port_rejected(self):
        with self.assertRaises(ValueError):
            CanvasNodeSpec.model_validate(_spec_doc(inputs=[{"id": "a", "type": "exe"}]))
        with self.assertRaises(ValueError):
            CanvasNodeSpec.model_validate(_spec_doc(inputs=[{"id": "a"}, {"id": "a"}]))


class TestCrud(_TempStorage):
    def test_save_get_list_delete(self):
        canvas_node_manager.save(CanvasNodeSpec.model_validate(_spec_doc()))
        got = canvas_node_manager.get("upscale_ext")
        self.assertIsNotNone(got)
        self.assertTrue(got.created_at and got.updated_at)
        self.assertIn("upscale_ext", [n.id for n in canvas_node_manager.list_nodes()])
        self.assertTrue(canvas_node_manager.delete("upscale_ext"))
        self.assertIsNone(canvas_node_manager.get("upscale_ext"))

    def test_effective_filter_by_extension_state(self):
        from app.canvas_nodes.manager import list_effective_nodes
        canvas_node_manager.save(CanvasNodeSpec.model_validate(_spec_doc()))
        state.set_disabled("canvas_node:acme/upscale_ext", True)
        try:
            self.assertNotIn("upscale_ext", [n.id for n in list_effective_nodes()])
            self.assertNotIn("upscale_ext", [n.id for n in list_effective_nodes("p1")])
            self.assertIn("upscale_ext", [n.id for n in list_effective_nodes(include_disabled=True)])
        finally:
            state.set_disabled("canvas_node:acme/upscale_ext", False)
        self.assertIn("upscale_ext", [n.id for n in list_effective_nodes()])


class TestBuildRunArgs(_TempStorage):
    def test_default_and_map(self):
        spec = CanvasNodeSpec.model_validate(_spec_doc(
            run={"extension": "custom_node:upscale_demo", "args": {"mode": "fast"},
                 "map": {"video": "$in.video", "scale": "$param.scale", "tag": "literal"}}))
        args = build_run_args(spec, {"video": "/a.mp4", "prompt": "hi"}, {"scale": 4, "unused": ""})
        self.assertEqual(args["mode"], "fast")
        self.assertEqual(args["video"], "/a.mp4")
        self.assertEqual(args["prompt"], "hi")  # 未显式 map 的同名输入默认透传
        self.assertEqual(args["scale"], 4)
        self.assertEqual(args["tag"], "literal")
        self.assertNotIn("unused", args)


class TestRunCanvasNode(_TempStorage):
    def _fake_execute(self, calls):
        async def fake(ext_id, args=None, entry="generate", scope=""):
            calls.update({"ext_id": ext_id, "args": args, "entry": entry, "scope": scope})
            return {"status": "success", "extension": ext_id, "video_url": "/storage/out.mp4",
                    "provider": "demo"}
        return fake

    def test_run_maps_outputs_and_scope(self):
        from app.extensions.registry import extension_registry
        calls = {}
        old = extension_registry.execute
        extension_registry.execute = self._fake_execute(calls)
        try:
            spec = CanvasNodeSpec.model_validate(_spec_doc())
            out = asyncio.run(run_canvas_node(spec, {"video": "/a.mp4"}, {"scale": 3}, project_id="proj-1"))
            self.assertEqual(out["status"], "success")
            self.assertEqual(out["video_url"], "/storage/out.mp4")
            self.assertEqual(out["outputs"]["video"], "/storage/out.mp4")
            self.assertEqual(calls["ext_id"], "custom_node:upscale_demo")
            self.assertEqual(calls["args"]["scale"], 3)
            self.assertEqual(calls["scope"], "proj-1")
        finally:
            extension_registry.execute = old

    def test_guard_refuses_disabled(self):
        from app.extensions import guard
        spec = CanvasNodeSpec.model_validate(_spec_doc())
        state.set_disabled("canvas_node:upscale_ext", True)
        with self.assertRaises(guard.ExtensionDisabledError):
            asyncio.run(run_canvas_node(spec, {}, {}, project_id="proj-1"))

    def test_engine_branch(self):
        from app.canvas.engine import execute_node
        from app.extensions.registry import extension_registry
        old = extension_registry.execute
        extension_registry.execute = self._fake_execute({})
        try:
            canvas_node_manager.save(CanvasNodeSpec.model_validate(_spec_doc()))
            res = asyncio.run(execute_node(
                {"id": "nd1", "type": "ext-node", "data": {"canvas_node_id": "upscale_ext"}},
                {"video": "/a.mp4"}, project_id="proj-1"))
            self.assertEqual(res["status"], "success")
            self.assertEqual(res["canvas_node_id"], "upscale_ext")
        finally:
            extension_registry.execute = old


class TestPluginContribution(_TempStorage):
    def test_plugin_canvas_nodes_lifecycle(self):
        from app.plugins import manager as pm
        src = tempfile.mkdtemp(prefix="cn_plugin_")
        try:
            with open(os.path.join(src, "plugin.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "id": "cn-pack", "name": "画布节点包", "version": "1.0.0",
                    "extensionPoints": {"canvas_nodes": ["canvas_nodes/*.json"]},
                }, f)
            os.makedirs(os.path.join(src, "canvas_nodes"), exist_ok=True)
            with open(os.path.join(src, "canvas_nodes", "upscale_ext.json"), "w", encoding="utf-8") as f:
                json.dump(_spec_doc(), f)
            pm.install_from_dir(src)
            summary = pm.enable("cn-pack")
            self.assertIn("upscale_ext", [c["id"] for c in summary.get("canvas_nodes", [])])
            self.assertIsNotNone(canvas_node_manager.get("upscale_ext"))
            # 扩展注册表聚合可见，来源为插件
            from app.extensions.registry import extension_registry
            ext = extension_registry.get("canvas_node:upscale_ext")
            self.assertIsNotNone(ext)
            self.assertEqual(ext.source, "plugin")
            # 禁用精确回滚
            pm.disable("cn-pack")
            self.assertIsNone(canvas_node_manager.get("upscale_ext"))
            pm.uninstall("cn-pack")
        finally:
            shutil.rmtree(src, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
