# -*- coding: utf-8 -*-
"""功能页（page）运行时开关回归测试（stdlib unittest，风格同 test_extensions.py）。

覆盖：
- 默认集：只开 首页/素材库/角色设定/AI 导演/创意画布/设置，其余 False
- ``seed_defaults()`` 幂等：不重复、``pages_seeded`` 落盘、既有键不被破坏
- 路由级守卫 ``require(pid)``：关闭 → 404，开启 → 放行
- locked：设置页停用必须抛 ValueError，且停用集不变（不是 500、不改状态）
- 未知 id：``is_enabled`` False / ``require`` 404
- 路由守卫归属：分镜槽+一键成片 → studio；导演包 → director3d；三个画布族 → canvas
- 来回开关 3 次无残留（``enabled_ids()`` 与初始一致）
- 与扩展注册表打通：page 作为第 14 个 kind 出现在统一列表里，默认关的页首次即为 disabled

运行： python -m unittest discover -s server/tests -p "test_*.py" -v
"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core import pages  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.extensions import state  # noqa: E402
from app.extensions.registry import extension_registry  # noqa: E402

# 契约冻结的默认启用集
DEFAULT_ON = {"home", "assets", "characters", "agent", "canvas", "config"}
DEFAULT_OFF = {"projects", "studio", "director3d", "timeline"}


class _TempStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_test_pages_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        # 每个用例从「未播种、无残留」的干净态开始
        try:
            os.remove(state._state_path())
        except OSError:
            pass

    def _disk_state(self):
        with open(state._state_path(), encoding="utf-8") as f:
            return json.load(f)


class TestDefaults(_TempStorage):
    def test_default_enabled_set(self):
        pages.seed_defaults()
        snap = pages.snapshot()
        enabled = {p["id"] for p in snap["pages"] if p["enabled"]}
        self.assertEqual(enabled, DEFAULT_ON)
        self.assertEqual(set(pages.enabled_ids()), DEFAULT_ON)
        self.assertEqual({k for k, v in snap["values"].items() if v}, DEFAULT_ON)
        for pid in DEFAULT_OFF:
            self.assertFalse(pages.is_enabled(pid))
            self.assertFalse(snap["values"][pid])

    def test_snapshot_shape(self):
        pages.seed_defaults()
        snap = pages.snapshot()
        # 顺序即侧栏顺序，字段与 PAGE_DEFS 一致
        self.assertEqual([p["id"] for p in snap["pages"]], [d["id"] for d in pages.PAGE_DEFS])
        for page_row, definition in zip(snap["pages"], pages.PAGE_DEFS):
            for key, val in definition.items():
                self.assertEqual(page_row[key], val)
            self.assertIn("enabled", page_row)
            self.assertTrue(page_row["description"])
        self.assertEqual(snap["groups"], ["工作区", "漫剧工坊", "创意工坊", "系统"])
        # file 指向当前 storage 的扩展覆盖层状态文件
        self.assertIn("state.json", snap["file"])
        self.assertIn(str(settings.STORAGE_DIR), snap["file"])


class TestSeedIdempotent(_TempStorage):
    def test_seed_twice_preserves_existing_keys(self):
        # 预置既有键（历史数据：全局停用 + 项目覆盖），播种不得破坏
        legacy = {"global": {"disabled": ["skill:demo"]},
                  "projects": {"p1": {"disabled": ["skill:demo"]}}}
        os.makedirs(os.path.dirname(state._state_path()), exist_ok=True)
        with open(state._state_path(), "w", encoding="utf-8") as f:
            json.dump(legacy, f)

        first = pages.seed_defaults()
        self.assertTrue(first["seeded"])
        self.assertEqual(sorted(first["disabled"]),
                         sorted(pages.page_ext_id(p) for p in DEFAULT_OFF))

        after_first = self._disk_state()
        second = pages.seed_defaults()
        self.assertFalse(second["seeded"])            # 已播种 → 直接返回
        after_second = self._disk_state()
        self.assertEqual(after_first, after_second)   # 既有键一个也没动

        self.assertTrue(after_second["pages_seeded"])
        self.assertIn("skill:demo", after_second["global"]["disabled"])
        self.assertEqual(after_second["projects"], {"p1": {"disabled": ["skill:demo"]}})
        disabled = after_second["global"]["disabled"]
        self.assertEqual(disabled, sorted(set(disabled)))  # 无重复
        for pid in DEFAULT_OFF:
            self.assertIn(pages.page_ext_id(pid), disabled)
        # 默认开的页不得被写进停用集
        for pid in DEFAULT_ON:
            self.assertNotIn(pages.page_ext_id(pid), disabled)


class TestRequire(_TempStorage):
    def test_require_404_when_disabled_then_pass_after_enable(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        with self.assertRaises(HTTPException) as ctx:
            pages.require("studio")()
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("分镜台", ctx.exception.detail)

        extension_registry.set_enabled("page:studio", True)
        self.assertTrue(pages.is_enabled("studio"))
        pages.require("studio")()  # 开启后放行（不抛）

        extension_registry.set_enabled("page:studio", False)
        with self.assertRaises(HTTPException) as ctx2:
            pages.require("studio")()
        self.assertEqual(ctx2.exception.status_code, 404)

    def test_unknown_id_never_allowed(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        self.assertFalse(pages.is_enabled("nope"))
        self.assertFalse(pages.is_enabled(""))
        with self.assertRaises(HTTPException) as ctx:
            pages.require("nope")()
        self.assertEqual(ctx.exception.status_code, 404)


class TestLockedConfig(_TempStorage):
    def test_locked_page_rejects_disable(self):
        pages.seed_defaults()
        self.assertTrue(pages.is_locked("config"))
        self.assertFalse(pages.is_locked("studio"))
        before = state.disabled_ids("")
        with self.assertRaises(ValueError) as ctx:
            extension_registry.set_enabled("page:config", False)
        self.assertIn("设置页不可关闭", str(ctx.exception))
        # 停用集不变，页面仍启用
        self.assertEqual(state.disabled_ids(""), before)
        self.assertTrue(pages.is_enabled("config"))

    def test_already_disabled_locked_page_still_rejected(self):
        # 外部写盘把 locked 页显式停用后，再停用仍须 400（ValueError），且不改状态
        pages.seed_defaults()
        state.set_disabled(pages.page_ext_id("config"), True)
        try:
            with self.assertRaises(ValueError) as ctx:
                extension_registry.set_enabled("page:config", False)
            self.assertIn("设置页不可关闭", str(ctx.exception))
            self.assertTrue(state.is_disabled(pages.page_ext_id("config")))
        finally:
            state.set_disabled(pages.page_ext_id("config"), False)


class TestRouteGuardOwnership(_TempStorage):
    def _dep(self, module_path: str):
        """取路由级依赖里的守卫函数（APIRouter(dependencies=[Depends(require(...))]))。"""
        mod = importlib.import_module(module_path)
        deps = [d.dependency for d in mod.router.dependencies]
        self.assertTrue(deps, f"{module_path} 未挂功能页守卫")
        self.assertEqual(len(deps), 1, f"{module_path} 守卫数量异常")
        return deps[0]

    def test_studio_family_guarded_by_studio(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        deps = [self._dep(m) for m in ("app.api.storyboard_slot_routes",
                                       "app.api.onekey_routes")]
        for dep in deps:
            with self.assertRaises(HTTPException) as ctx:
                dep()
            self.assertEqual(ctx.exception.status_code, 404)
        extension_registry.set_enabled("page:studio", True)
        for dep in deps:
            dep()  # 开启后放行

    def test_director3d_family_guarded_by_director3d(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        dep = self._dep("app.api.director_pack_routes")
        with self.assertRaises(HTTPException) as ctx:
            dep()
        self.assertEqual(ctx.exception.status_code, 404)
        extension_registry.set_enabled("page:director3d", True)
        dep()

    def test_canvas_family_guarded_by_canvas(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        deps = [self._dep(m) for m in ("app.api.canvas_routes",
                                       "app.api.canvas_node_routes",
                                       "app.api.custom_node_routes")]
        for dep in deps:
            dep()  # canvas 默认开 → 放行
        extension_registry.set_enabled("page:canvas", False)
        for dep in deps:
            with self.assertRaises(HTTPException) as ctx:
                dep()
            self.assertEqual(ctx.exception.status_code, 404)
        extension_registry.set_enabled("page:canvas", True)
        for dep in deps:
            dep()

    def test_families_do_not_share_switch(self):
        """防挂错开关：只开 studio 时，director3d 族仍必须 404。"""
        from fastapi import HTTPException
        pages.seed_defaults()
        extension_registry.set_enabled("page:studio", True)
        self._dep("app.api.storyboard_slot_routes")()
        with self.assertRaises(HTTPException):
            self._dep("app.api.director_pack_routes")()


class TestToggleNoResidue(_TempStorage):
    def test_toggle_roundtrip_three_times(self):
        """studio 出厂默认关闭：开→关往返 3 次后必须回到初始（关闭）且停用集无悬空引用。"""
        pages.seed_defaults()
        baseline = pages.enabled_ids()
        self.assertNotIn("studio", baseline)
        for _ in range(3):
            extension_registry.set_enabled("page:studio", True)
            self.assertTrue(pages.is_enabled("studio"))
            extension_registry.set_enabled("page:studio", False)
            self.assertFalse(pages.is_enabled("studio"))
        self.assertEqual(pages.enabled_ids(), baseline)
        # 停用集与有效集严格互补：不留悬空引用，也不多出未定义的项
        self.assertEqual(
            sorted(i for i in state.disabled_ids("") if i.startswith("page:")),
            sorted(f"page:{d['id']}" for d in pages.PAGE_DEFS if not pages.is_enabled(d["id"])),
        )

    def test_canvas_toggle_roundtrip(self):
        pages.seed_defaults()
        baseline = pages.enabled_ids()
        for _ in range(3):
            extension_registry.set_enabled("page:canvas", False)
            extension_registry.set_enabled("page:canvas", True)
        self.assertEqual(pages.enabled_ids(), baseline)


class TestRequireAny(_TempStorage):
    """多页共用能力族（/api/v1/timeline 被画布时间线节点与多轨剪辑页共用）：任一开启即放行。"""

    def _guard(self):
        from app.api import timeline_routes
        deps = [d.dependency for d in timeline_routes.router.dependencies]
        self.assertTrue(deps, "timeline_routes 未挂页面守卫")
        return deps[0]

    def test_timeline_route_uses_require_any(self):
        from fastapi import HTTPException
        pages.seed_defaults()
        guard = self._guard()
        # 出厂态：canvas 开、timeline 关 → 放行
        self.assertTrue(pages.is_enabled("canvas"))
        self.assertFalse(pages.is_enabled("timeline"))
        guard()
        # 只关 canvas：timeline 仍关 → 404
        extension_registry.set_enabled("page:canvas", False)
        with self.assertRaises(HTTPException) as ctx:
            guard()
        self.assertEqual(ctx.exception.status_code, 404)
        # 打开 timeline → 放行（不被 canvas 开关挟持）
        extension_registry.set_enabled("page:timeline", True)
        guard()
        # 两侧都开也放行
        extension_registry.set_enabled("page:canvas", True)
        guard()


class TestExtensionRegistryIntegration(_TempStorage):
    def test_pages_listed_with_default_state(self):
        # 不显式播种：首次列表即应完成播种，且默认关的页为 disabled
        items = extension_registry.list(kind="page")
        self.assertEqual(len(items), len(pages.PAGE_DEFS))
        by_id = {e.id: e for e in items}
        self.assertIn(pages.page_ext_id("studio"), by_id)
        self.assertEqual(by_id[pages.page_ext_id("studio")].kind, "page")
        self.assertEqual(by_id[pages.page_ext_id("studio")].local_id, "studio")
        self.assertEqual(by_id[pages.page_ext_id("studio")].publisher, "builtin")
        self.assertEqual(by_id[pages.page_ext_id("studio")].source, "builtin")
        self.assertEqual(by_id[pages.page_ext_id("studio")].status, "disabled")
        self.assertEqual(by_id[pages.page_ext_id("home")].status, "builtin")
        self.assertTrue(self._disk_state().get("pages_seeded"))
        self.assertEqual(extension_registry.counts().get("page"), len(pages.PAGE_DEFS))

    def test_enable_disable_via_registry_is_overlay(self):
        pages.seed_defaults()
        r = extension_registry.set_enabled("page:studio", True)
        self.assertEqual(r["mode"], "overlay")
        self.assertTrue(pages.is_enabled("studio"))
        r2 = extension_registry.set_enabled("page:studio", False)
        self.assertEqual(r2["mode"], "overlay")
        self.assertFalse(pages.is_enabled("studio"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
