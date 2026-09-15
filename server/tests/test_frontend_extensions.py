# -*- coding: utf-8 -*-
"""前端扩展点（themes / exporters / director_packs）回归测试。

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
from app.extensions import state  # noqa: E402
from app.themes.manager import theme_manager, list_effective_themes  # noqa: E402
from app.themes.models import ThemeSpec  # noqa: E402
from app.exporters.manager import (  # noqa: E402
    exporter_manager, build_export_args, run_exporter,
)
from app.exporters.models import ExporterSpec  # noqa: E402
from app.director_packs.manager import director_pack_manager  # noqa: E402
from app.director_packs.models import DirectorPackSpec  # noqa: E402


def _theme_doc(**over):
    doc = {"id": "ink-wash", "name": "水墨主题", "mode": "all",
           "vars": {"--color-brand": "#2f6b52", "--color-bg": "#0d1110"}}
    doc.update(over)
    return doc


def _exporter_doc(**over):
    doc = {"id": "srt_exporter", "name": "SRT 字幕导出", "accepts": ["project", "shots"],
           "run": {"extension": "custom_node:srt_node",
                   "map": {"project": "$project", "shots": "$shots"}}}
    doc.update(over)
    return doc


def _pack_doc(**over):
    doc = {"id": "wuxia-pack", "name": "武侠导演包",
           "presets": {
               "framing": [{"id": "hero_shot", "label": "英雄机位", "fl": 30, "desc": "低机位仰拍"}],
               "motion": [{"id": "sword_dash", "label": "御剑突进", "category": "combo",
                           "desc": "低机位推进", "minimaxCode": "Low Angle + Forward Tracking"}],
           },
           "environments": [{"id": "bamboo", "label": "竹林", "desc": "青翠竹海",
                             "icon": "🎋", "background_url": "/storage/scenes/bamboo.jpg"}],
           "props": [{"id": "jade_sword", "label": "青玉剑", "icon": "🗡️",
                      "glb_url": "/storage/props/jade_sword.glb", "scale": 1.0}]}
    doc.update(over)
    return doc


class _TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_fx_test_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def tearDown(self):
        for kind, eid in (("theme", "ink-wash"), ("exporter", "srt_exporter"),
                          ("director_pack", "wuxia-pack")):
            state.set_disabled(f"{kind}:{eid}", False)
            state.set_disabled(f"{kind}:{eid}", False, scope="p1")


class TestThemes(_TempStorage):
    def test_validation(self):
        ThemeSpec.model_validate(_theme_doc())
        with self.assertRaises(ValueError):
            ThemeSpec.model_validate(_theme_doc(vars={"color-brand": "#fff"}))
        with self.assertRaises(ValueError):
            ThemeSpec.model_validate(_theme_doc(mode="neon"))

    def test_crud_and_effective_filter(self):
        theme_manager.save(ThemeSpec.model_validate(_theme_doc()))
        self.assertIsNotNone(theme_manager.get("ink-wash"))
        state.set_disabled("theme:acme/ink-wash", True)
        try:
            self.assertNotIn("ink-wash", [t.id for t in list_effective_themes()])
            self.assertNotIn("ink-wash", [t.id for t in list_effective_themes("p1")])
            self.assertIn("ink-wash", [t.id for t in list_effective_themes(include_disabled=True)])
        finally:
            state.set_disabled("theme:acme/ink-wash", False)
        self.assertIn("ink-wash", [t.id for t in list_effective_themes()])
        self.assertTrue(theme_manager.delete("ink-wash"))


class TestExporters(_TempStorage):
    def test_validation(self):
        with self.assertRaises(ValueError):
            ExporterSpec.model_validate(_exporter_doc(run={"extension": "theme:foo"}))
        with self.assertRaises(ValueError):
            ExporterSpec.model_validate(_exporter_doc(accepts=["nope"]))

    def test_build_args_default_and_map(self):
        spec = ExporterSpec.model_validate(_exporter_doc(
            run={"extension": "custom_node:srt_node", "args": {"fmt": "srt"},
                 "map": {"project": "$project", "shots": "$shots", "tag": "literal"}}))
        args = build_export_args(spec, {"project": {"id": "proj"}, "shots": [1, 2]})
        self.assertEqual(args["fmt"], "srt")
        self.assertEqual(args["project"], {"id": "proj"})
        self.assertEqual(args["shots"], [1, 2])
        self.assertEqual(args["tag"], "literal")

    def test_run_and_guard(self):
        from app.extensions import guard
        from app.extensions.registry import extension_registry
        calls = {}

        async def fake_execute(ext_id, args=None, entry="generate", scope=""):
            calls.update({"ext_id": ext_id, "args": args, "scope": scope})
            return {"status": "success", "extension": ext_id, "file_url": "/exports/x.srt"}

        old = extension_registry.execute
        extension_registry.execute = fake_execute
        try:
            spec = ExporterSpec.model_validate(_exporter_doc())
            out = asyncio.run(run_exporter(spec, {"project": {"id": "proj"}, "shots": []}, project_id="p1"))
            self.assertEqual(out["file_url"], "/exports/x.srt")
            self.assertEqual(calls["ext_id"], "custom_node:srt_node")
            self.assertEqual(calls["scope"], "p1")
        finally:
            extension_registry.execute = old
        state.set_disabled("exporter:srt_exporter", True)
        with self.assertRaises(guard.ExtensionDisabledError):
            asyncio.run(run_exporter(spec, {}, project_id="p1"))


class TestDirectorPacks(_TempStorage):
    def test_validation_and_crud(self):
        spec = DirectorPackSpec.model_validate(_pack_doc())
        self.assertEqual(spec.presets["framing"][0].fl, 30)
        with self.assertRaises(ValueError):
            DirectorPackSpec.model_validate(_pack_doc(presets={"camera": []}))
        director_pack_manager.save(spec)
        self.assertIsNotNone(director_pack_manager.get("wuxia-pack"))
        self.assertTrue(director_pack_manager.delete("wuxia-pack"))


class TestPluginContribution(_TempStorage):
    def test_frontend_extensions_lifecycle(self):
        from app.plugins import manager as pm
        src = tempfile.mkdtemp(prefix="fx_plugin_")
        try:
            with open(os.path.join(src, "plugin.json"), "w", encoding="utf-8") as f:
                json.dump({
                    "id": "fx-pack", "name": "前端扩展包", "version": "1.0.0",
                    "extensionPoints": {
                        "themes": ["themes/*.json"],
                        "exporters": ["exporters/*.json"],
                        "director_packs": ["director_packs/*.json"],
                    },
                }, f)
            for sub, name, doc in (
                ("themes", "ink-wash.json", _theme_doc()),
                ("exporters", "srt_exporter.json", _exporter_doc()),
                ("director_packs", "wuxia-pack.json", _pack_doc()),
            ):
                os.makedirs(os.path.join(src, sub), exist_ok=True)
                with open(os.path.join(src, sub, name), "w", encoding="utf-8") as f:
                    json.dump(doc, f)
            pm.install_from_dir(src)
            summary = pm.enable("fx-pack")
            self.assertIn("ink-wash", [t["id"] for t in summary.get("themes", [])])
            self.assertIn("srt_exporter", [e["id"] for e in summary.get("exporters", [])])
            self.assertIn("wuxia-pack", [p["id"] for p in summary.get("director_packs", [])])
            self.assertIsNotNone(theme_manager.get("ink-wash"))
            self.assertIsNotNone(exporter_manager.get("srt_exporter"))
            self.assertIsNotNone(director_pack_manager.get("wuxia-pack"))
            from app.extensions.registry import extension_registry
            ext = extension_registry.get("theme:ink-wash")
            self.assertIsNotNone(ext)
            self.assertEqual(ext.source, "plugin")
            pm.disable("fx-pack")
            self.assertIsNone(theme_manager.get("ink-wash"))
            self.assertIsNone(exporter_manager.get("srt_exporter"))
            self.assertIsNone(director_pack_manager.get("wuxia-pack"))
            pm.uninstall("fx-pack")
        finally:
            shutil.rmtree(src, ignore_errors=True)


class TestCodeFileResolution(_TempStorage):
    """插件包真实代码文件（code_file）解析。"""

    def _make_pack(self, code_file="code/node.py", write_file=True, content=None,
                   extra_doc=None, providers=False):
        src = tempfile.mkdtemp(prefix="cf_plugin_")
        ext = {"providers": ["providers/*.json"]} if providers else {"custom_nodes": ["custom_nodes/*.json"]}
        with open(os.path.join(src, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "cf-pack", "name": "代码文件包", "version": "1.0.0",
                       "extensionPoints": ext}, f)
        sub = "providers" if providers else "custom_nodes"
        os.makedirs(os.path.join(src, sub), exist_ok=True)
        if providers:
            doc = {"id": "prov_cf", "name": "文件源", "kind": "image", "language": "python",
                   "code_file": code_file, "code_entry": "generate",
                   "input_schema": {"type": "object", "properties": {"prompt": {"type": "string", "x-handle": "text"}}}}
        else:
            doc = {"id": "cf_node", "name": "文件节点", "kind": "utility", "language": "python",
                   "code_file": code_file, "code_entry": "run",
                   "input_schema": {"type": "object", "properties": {}}}
        if extra_doc:
            doc.update(extra_doc)
        with open(os.path.join(src, sub, "item.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f)
        if write_file:
            fpath = os.path.join(src, code_file.replace("/", os.sep))
            os.makedirs(os.path.dirname(fpath) or src, exist_ok=True)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(content if content is not None else
                        "async def run(inputs, params, ctx):\n    return {'text': 'from-file'}\n")
        return src

    def test_custom_node_code_file_loaded_and_reloaded(self):
        from app.plugins import manager as pm
        from app.custom_nodes.manager import custom_node_manager
        src = self._make_pack()
        try:
            pm.install_from_dir(src)
            summary = pm.enable("cf-pack")
            node = custom_node_manager.get("cf_node")
            self.assertIsNotNone(node)
            self.assertIn("from-file", node.code)
            self.assertFalse(any("code_file" in w for w in summary.get("warnings", [])))
            # 修改"已安装"副本 → reload 后重读文件
            installed = os.path.join(settings.STORAGE_DIR, "plugins", "cf-pack", "code", "node.py")
            with open(installed, "w", encoding="utf-8") as f:
                f.write("async def run(inputs, params, ctx):\n    return {'text': 'v2'}\n")
            pm.reload_plugin("cf-pack")
            self.assertIn("v2", custom_node_manager.get("cf_node").code)
        finally:
            pm.uninstall("cf-pack")
            shutil.rmtree(src, ignore_errors=True)

    def test_provider_code_file_loaded(self):
        from app.plugins import manager as pm
        from app.providers.custom.manager import custom_provider_manager
        src = self._make_pack(code_file="code/prov.py", providers=True,
                              content="async def generate(ctx, api):\n    return {'image_url': 'https://x/y.png'}\n")
        try:
            pm.install_from_dir(src)
            summary = pm.enable("cf-pack")
            self.assertFalse(any("prov_cf" in w and "失败" in w for w in summary.get("warnings", [])))
            d = custom_provider_manager.get_definition("prov_cf")
            self.assertIsNotNone(d)
            self.assertIn("generate(ctx, api)", d.code or "")
        finally:
            pm.uninstall("cf-pack")
            shutil.rmtree(src, ignore_errors=True)

    def test_missing_and_escape_warn(self):
        from app.plugins import manager as pm
        from app.custom_nodes.manager import custom_node_manager
        for code_file, write, keyword in (("code/missing.py", False, "不存在"),
                                          ("../evil.py", False, "越界"),
                                          ("code/node.js", True, "不匹配")):
            src = self._make_pack(code_file=code_file, write_file=write,
                                  content="x = 1\n" if code_file.endswith(".js") else None)
            try:
                pm.install_from_dir(src)
                summary = pm.enable("cf-pack")
                self.assertTrue(any(keyword in w for w in summary.get("warnings", [])),
                                f"{code_file} 应触发 warning（{keyword}），实际 {summary.get('warnings')}")
                self.assertIsNone(custom_node_manager.get("cf_node"))
            finally:
                pm.uninstall("cf-pack")
                shutil.rmtree(src, ignore_errors=True)

    def test_inline_code_wins_with_warning(self):
        from app.plugins import manager as pm
        from app.custom_nodes.manager import custom_node_manager
        src = self._make_pack(extra_doc={"code": "async def run(inputs, params, ctx):\n    return {'text': 'inline'}\n"})
        try:
            pm.install_from_dir(src)
            summary = pm.enable("cf-pack")
            self.assertTrue(any("已内联" in w for w in summary.get("warnings", [])))
            self.assertIn("inline", custom_node_manager.get("cf_node").code)
        finally:
            pm.uninstall("cf-pack")
            shutil.rmtree(src, ignore_errors=True)

    def test_example_pack_uses_real_code_file(self):
        from app.plugins.manager import _resolve_code_ref
        from app.custom_nodes.models import CustomNodeDefinition
        from app.custom_nodes.manager import custom_node_manager, run_custom_node
        pack = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..",
                                            "plugins", "example-drama-pack"))
        with open(os.path.join(pack, "custom_nodes", "upscale_demo.json"), "r", encoding="utf-8") as f:
            doc = CustomNodeDefinition.model_validate(json.load(f))
        self.assertTrue(doc.code_file)
        self.assertFalse((doc.code or "").strip())
        _resolve_code_ref(pack, "custom_nodes/upscale_demo.json", doc)
        self.assertIn("async def run", doc.code)
        # 解析后的真实代码可入库并通过沙箱执行
        saved = custom_node_manager.save(doc)
        res = asyncio.run(run_custom_node(saved, {"video": "/storage/videos/x.mp4"}, {"scale": 3}))
        self.assertEqual(res.get("text"), "upscaled x3")
        self.assertEqual(res.get("video_url"), "/storage/videos/x.mp4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
