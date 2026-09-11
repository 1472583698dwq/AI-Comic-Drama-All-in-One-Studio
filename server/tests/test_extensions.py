# -*- coding: utf-8 -*-
"""统一扩展 / 插件系统回归测试（stdlib unittest，零依赖）。

运行： python -m unittest discover -s server/tests -v
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.extensions import state  # noqa: E402
from app.extensions.registry import extension_registry  # noqa: E402
from app.extensions.models import make_ext_id, split_ext_id  # noqa: E402
from app.extensions import telemetry  # noqa: E402
from app.plugins import manager as pm  # noqa: E402
from app.plugins.models import PluginManifest  # noqa: E402
from app.storyboard import slots as slot_store  # noqa: E402


class _TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_test_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)


class TestManifest(_TempStorage):
    def test_storyboard_slots_path_fence(self):
        base = {"id": "pack-a", "name": "A", "version": "1.0.0"}
        # 合法
        pm.validate_manifest_dict({**base, "extensionPoints": {"storyboard_slots": ["slots/*.json"]}})
        # 越界必须被拒（历史漏洞：storyboard_slots 曾漏检）
        with self.assertRaises(ValueError):
            pm.validate_manifest_dict({**base, "extensionPoints": {"storyboard_slots": ["../../etc/passwd"]}})

    def test_dependency_parsing(self):
        from app.plugins.manager import _satisfies
        self.assertTrue(_satisfies("1.2.3", "*"))
        self.assertTrue(_satisfies("1.2.3", ">=1.0.0"))
        self.assertTrue(_satisfies("1.2.3", "^1.0.0"))
        self.assertTrue(_satisfies("1.2.3", "~1.2.0"))
        self.assertFalse(_satisfies("2.0.0", "^1.0.0"))
        self.assertFalse(_satisfies("1.1.0", "~1.2.0"))
        self.assertFalse(_satisfies("0.9.0", ">=1.0.0"))


class TestPluginInstall(_TempStorage):
    def _make_plugin(self, pid="test-pack", version="1.0.0", extra=None):
        d = tempfile.mkdtemp(prefix=f"src_{pid}_")
        manifest = {"id": pid, "name": pid, "version": version}
        if extra:
            manifest.update(extra)
        with open(os.path.join(d, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        return d

    def test_install_atomic_no_staging_left(self):
        src = self._make_plugin()
        m = pm.install_from_dir(src)
        self.assertEqual(m.id, "test-pack")
        self.assertTrue(os.path.isdir(os.path.join(settings.STORAGE_DIR, "plugins", "test-pack")))
        roots = os.listdir(os.path.join(settings.STORAGE_DIR, "plugins"))
        self.assertFalse([r for r in roots if r.startswith(".staging-")])
        # 重复安装拒绝
        with self.assertRaises(ValueError):
            pm.install_from_dir(src)

    def test_missing_dependency_rejected(self):
        src = self._make_plugin(pid="needs-dep", extra={"dependsOn": {"not-installed": ">=1.0.0"}})
        with self.assertRaises(ValueError) as ctx:
            pm.install_from_dir(src)
        self.assertIn("缺少依赖", str(ctx.exception))


class TestNaming(_TempStorage):
    def test_ext_id_namespace_roundtrip(self):
        self.assertEqual(make_ext_id("provider", "kling", "acme"), "provider:acme/kling")
        self.assertEqual(make_ext_id("provider", "kling", "builtin"), "provider:kling")
        self.assertEqual(make_ext_id("provider", "kling", "local"), "provider:kling")
        self.assertEqual(split_ext_id("provider:acme/kling"), ("provider", "kling", "acme"))
        self.assertEqual(split_ext_id("provider:kling"), ("provider", "kling", ""))
        # local_id 自带冒号（分镜槽 key）时仍可正确解析
        self.assertEqual(
            split_ext_id("storyboard_slot:acme/shot.tabs:visual"),
            ("storyboard_slot", "shot.tabs:visual", "acme"))
        self.assertEqual(
            split_ext_id("storyboard_slot:shot.tabs:visual"),
            ("storyboard_slot", "shot.tabs:visual", ""))

    def test_cross_kind_does_not_conflict(self):
        # provider:kling（内置）不应拦截 skill:kling
        r = extension_registry.check_id_available("skill", "kling")
        self.assertNotIn("provider:kling", r["conflicts"])
        # 同 kind 撞名应报告
        r2 = extension_registry.check_id_available("provider", "kling")
        self.assertIn("provider:kling", r2["conflicts"])

    def test_publisher_namespace(self):
        r = extension_registry.check_id_available("provider", "kling", publisher="acme")
        self.assertIn("provider:kling", r["cross_publisher_conflicts"])
        self.assertFalse(r["namespace_ok"])
        self.assertEqual(r["qualified"], "provider:acme/kling")


class TestOverlayLifecycle(_TempStorage):
    def test_overlay_disable_roundtrip(self):
        state.set_disabled("skill:demo-skill", True, scope="")
        self.assertTrue(state.is_disabled("skill:demo-skill"))
        # 项目作用域继承全局
        self.assertTrue(state.is_disabled("skill:demo-skill", scope="proj-1"))
        state.set_disabled("workflow:wf1", True, scope="proj-1")
        self.assertTrue(state.is_disabled("workflow:wf1", scope="proj-1"))
        self.assertFalse(state.is_disabled("workflow:wf1", scope="proj-2"))
        state.set_disabled("skill:demo-skill", False, scope="")
        self.assertFalse(state.is_disabled("skill:demo-skill"))

    def test_prune_unknown(self):
        state.set_disabled("skill:ghost", True)
        removed = state.prune_unknown({"skill:alive"})
        self.assertGreaterEqual(removed, 1)
        self.assertFalse(state.is_disabled("skill:ghost"))


class TestStoryboardOverrides(_TempStorage):
    def _write_custom(self, doc):
        return slot_store.save_custom_slot(doc)

    def test_override_pruned_for_unknown(self):
        slot_store.set_project_overrides("p1", ["shot.tabs:ghost-tab"], {"shot.tabs:ghost-tab": 5})
        ov = slot_store.get_project_overrides("p1")
        self.assertNotIn("shot.tabs:ghost-tab", ov["disabled"])
        self.assertNotIn("shot.tabs:ghost-tab", ov["order"])

    def test_delete_custom_cleans_overrides(self):
        self._write_custom({"slot": "shot.tabs", "id": "note-x", "label": "批注",
                            "blocks": [{"kind": "info", "text": "hi"}]})
        slot_store.set_project_overrides("p2", ["shot.tabs:note-x"], {"shot.tabs:note-x": 7})
        self.assertTrue(slot_store.delete_custom_slot("shot.tabs", "note-x"))
        ov = slot_store.get_project_overrides("p2")
        self.assertNotIn("shot.tabs:note-x", ov["disabled"])
        self.assertNotIn("shot.tabs:note-x", ov["order"])


class TestProjectScopeNative(_TempStorage):
    def test_native_provider_project_scope_soft_disable(self):
        target = "provider:comfyui"
        if not extension_registry.get(target):
            self.skipTest("内置 provider 未加载")
        r = extension_registry.set_enabled(target, False, scope="proj-x")
        self.assertIn(r["mode"], ("overlay", "project-overlay"))
        proj = {e.id: e.status for e in extension_registry.list(kind="provider", scope="proj-x")}
        self.assertEqual(proj.get(target), "disabled")
        # 全局不受影响
        glob = {e.id: e.status for e in extension_registry.list(kind="provider")}
        self.assertIn(glob.get(target), ("builtin", "enabled"))
        # 清理
        extension_registry.set_enabled(target, True, scope="proj-x")
        proj2 = {e.id: e.status for e in extension_registry.list(kind="provider", scope="proj-x")}
        self.assertIn(proj2.get(target), ("builtin", "enabled"))


class TestSkillNamespace(_TempStorage):
    def test_rewrite_skill_name(self):
        from app.plugins.manager import _namespace_skill_name
        src = "---\nname: foo\ndescription: d\n---\nBody here\n"
        out = _namespace_skill_name(src, "pack__foo")
        self.assertIn("name: pack__foo", out)
        self.assertNotIn("name: foo\n", out)
        self.assertIn("Body here", out)
        # 缺 name 键 → 补写
        src2 = "---\ndescription: d\n---\nB\n"
        self.assertIn("name: pack__bar", _namespace_skill_name(src2, "pack__bar"))
        # 无 frontmatter → 原样
        self.assertEqual(_namespace_skill_name("Body", "x"), "Body")


class TestEngineGuard(_TempStorage):
    def tearDown(self):
        # 清理本类写入的停用状态，避免污染后续用例
        from app.extensions import state as _s
        _s.set_disabled("skill:__guard_demo__", False)
        for pid in ("comfyui", "minimax", "dashscope"):
            _s.set_disabled(f"provider:{pid}", False)

    def test_match_disabled_namespaced(self):
        state.set_disabled("skill:acme/foo", True)
        self.assertEqual(state.match_disabled("skill", "foo"), "skill:acme/foo")
        self.assertIsNone(state.match_disabled("skill", "bar"))
        state.set_disabled("skill:acme/foo", False)

    def test_guard_raises_on_disabled(self):
        from app.extensions import guard
        state.set_disabled("provider:comfyui", True)
        self.assertFalse(guard.is_enabled("provider", "comfyui"))
        with self.assertRaises(guard.ExtensionDisabledError):
            guard.ensure_provider_enabled("comfyui")
        state.set_disabled("provider:comfyui", False)

    def test_skill_engine_refuses_disabled(self):
        import asyncio
        from app.skills.engine import skill_engine
        skills = skill_engine.list_skills()
        if not skills:
            self.skipTest("无技能")
        name = skills[0].name
        state.set_disabled(f"skill:{name}", True)
        try:
            res = asyncio.run(skill_engine.execute_skill(name, {}, ""))
            self.assertEqual(res.status, "error")
            self.assertIn("停用", res.result_message)
        finally:
            state.set_disabled(f"skill:{name}", False)

    def test_provider_registry_refuses_disabled(self):
        import asyncio
        from app.providers.image.registry import image_registry
        from app.providers.image.base import ImageGenerateRequest
        if not image_registry.list_ids():
            try:
                from app.providers.init_providers import init_all_providers
                init_all_providers()
            except Exception:
                pass
        ids = image_registry.list_ids()
        if not ids:
            self.skipTest("无 provider")
        pid = ids[0]
        state.set_disabled(f"provider:{pid}", True)
        try:
            with self.assertRaises(Exception) as ctx:
                asyncio.run(image_registry.generate(ImageGenerateRequest(prompt="x"), provider_id=pid))
            self.assertIn("停用", str(ctx.exception))
        finally:
            state.set_disabled(f"provider:{pid}", False)


class TestTelemetry(_TempStorage):
    def test_record_and_health(self):
        telemetry.reset()
        telemetry.record("provider:demo", True, 12, kind="provider")
        telemetry.record("provider:demo", False, 30, kind="provider", error="boom")
        h = telemetry.health()
        self.assertEqual(h["stats"]["provider:demo"]["calls"], 2)
        self.assertEqual(h["stats"]["provider:demo"]["errors"], 1)
        self.assertIn("provider:demo", telemetry.recent(5)[0]["extension"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
