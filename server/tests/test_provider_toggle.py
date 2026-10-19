# -*- coding: utf-8 -*-
"""生成源启停：自定义源走定义生命周期，内置源走软停用覆盖层；不可删除内置源。不访问网络。"""
import os
import sys
import types
import unittest
from unittest import mock

from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import provider_routes as pr  # noqa: E402


class TestProviderToggle(unittest.TestCase):
    def test_custom_provider_toggle_uses_definition_lifecycle(self):
        d = types.SimpleNamespace(id="prov_test", builtin=False, enabled=True, kind="image")
        with mock.patch.object(pr.custom_provider_manager, "get_definition", return_value=d), \
             mock.patch.object(pr.custom_provider_manager, "save_definition") as save, \
             mock.patch("app.providers.init_providers.unregister_single_custom_provider") as unreg, \
             mock.patch("app.providers.init_providers.register_single_custom_provider") as reg:
            r_off = pr._set_provider_enabled("prov_test", False)
            self.assertEqual(r_off["mode"], "native")
            self.assertFalse(r_off["builtin"])
            self.assertFalse(d.enabled)
            unreg.assert_called_once_with("prov_test", "image")
            reg.assert_not_called()

            r_on = pr._set_provider_enabled("prov_test", True)
            self.assertEqual(r_on["mode"], "native")
            self.assertTrue(d.enabled)
            reg.assert_called_once_with(d)
        self.assertEqual(save.call_count, 2)

    def test_builtin_provider_uses_overlay_soft_disable(self):
        d = types.SimpleNamespace(id="kling", builtin=True, enabled=True, kind="video")
        calls = []

        def fake_set_disabled(ext_id, disabled, scope=""):
            calls.append((ext_id, disabled, scope))
            return {"disabled": [ext_id] if disabled else []}

        with mock.patch.object(pr.custom_provider_manager, "get_definition", return_value=d), \
             mock.patch("app.extensions.state.set_disabled", side_effect=fake_set_disabled):
            r = pr._set_provider_enabled("kling", False)
        self.assertEqual(r["mode"], "overlay")
        self.assertTrue(r["builtin"])
        self.assertEqual(calls, [("provider:kling", True, "")])
        # 内置源定义本身不动（代码内定义，只做覆盖层软停用）
        self.assertTrue(d.enabled)

        with mock.patch.object(pr.custom_provider_manager, "get_definition", return_value=d), \
             mock.patch("app.extensions.state.set_disabled", side_effect=fake_set_disabled):
            r2 = pr._set_provider_enabled("kling", True)
        self.assertEqual(r2["mode"], "overlay")
        self.assertEqual(calls[-1], ("provider:kling", False, ""))

    def test_unknown_provider_404(self):
        with mock.patch.object(pr.custom_provider_manager, "get_definition", return_value=None):
            with self.assertRaises(HTTPException) as cm:
                pr._set_provider_enabled("prov_not_exists_xyz", False)
        self.assertEqual(cm.exception.status_code, 404)

    def test_registry_allows_builtin_provider_overlay_toggle(self):
        """统一扩展入口（扩展页的启停按钮）对内置生成源也给 overlay 模式。"""
        from app.extensions import registry as reg
        try:
            from app.providers.init_providers import init_all_providers
            init_all_providers()
        except Exception:
            pass
        ext = reg.extension_registry.get("provider:comfyui")
        if ext is None:
            self.skipTest("内置 provider:comfyui 未注册（跳过）")
        with mock.patch("app.extensions.state.set_disabled", return_value={}) as sd:
            out = reg.extension_registry.set_enabled("provider:comfyui", False)
        self.assertEqual(out.get("mode"), "overlay")
        sd.assert_called_once()
        self.assertEqual(sd.call_args[0][0], "provider:comfyui")
        self.assertTrue(sd.call_args[0][1])

    def test_registry_uninstall_still_refuses_builtin(self):
        from app.extensions import registry as reg
        try:
            from app.providers.init_providers import init_all_providers
            init_all_providers()
        except Exception:
            pass
        if reg.extension_registry.get("provider:comfyui") is None:
            self.skipTest("内置 provider:comfyui 未注册（跳过）")
        with self.assertRaises(ValueError):
            reg.extension_registry.uninstall("provider:comfyui")


if __name__ == "__main__":
    unittest.main(verbosity=2)
