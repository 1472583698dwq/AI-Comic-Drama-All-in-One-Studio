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


if __name__ == "__main__":
    unittest.main(verbosity=2)
