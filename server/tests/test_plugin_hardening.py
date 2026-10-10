# -*- coding: utf-8 -*-
"""插件系统加固回归测试（未完成清单第 18–22 条；stdlib unittest，零依赖）。

覆盖：
- 18 `min_app_version` 校验：声明了就必须被当前应用版本满足，否则拒绝安装（此前全仓零消费）
- 19 贡献物撞名预检：安装 / 启用前调用 `extension_registry.check_id_available`，
     撞到**别的来源**直接拒绝 —— 不再「warning + 静默跳过」（那样启用成功了但贡献少一半）
- 20 `uninstall` 不再吞掉 `disable` 失败：停用失败即中止，目录 / 索引 / 贡献保持一致可重试
- 21 扩展点 glob 无命中告警：声明了却一个文件都没命中 = 明确 warning（此前完全静默）
- 22 `reload_plugin` 状态回滚：enable 失败时回滚到重载前的启用态，并把最终状态写进报错

运行： python -m unittest test_plugin_hardening -v
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import APP_VERSION, settings  # noqa: E402
from app.plugins import manager as pm  # noqa: E402


def _canvas_doc(node_id: str) -> dict:
    """最小可用的声明式画布节点（canvas_nodes）文档。"""
    return {
        "id": node_id, "name": f"节点{node_id}", "kind": "utility",
        "inputs": [], "outputs": [],
        "params_schema": {"type": "object", "properties": {}},
        "run": {"extension": "custom_node:whatever"},
    }


class _TempStorage(unittest.TestCase):
    """storage 指到临时目录：插件目录与索引不得污染真实 storage/。"""

    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_plugin_hardening_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────
    def _make_pack(self, pid: str, extension_points=None, files=None, extra=None) -> str:
        """造一个插件源目录；``files`` = {包内相对路径: JSON 内容}。"""
        src = tempfile.mkdtemp(prefix=f"src_{pid}_")
        self.addCleanup(shutil.rmtree, src, ignore_errors=True)
        manifest = {"id": pid, "name": pid, "version": "1.0.0"}
        if extension_points:
            manifest["extensionPoints"] = extension_points
        if extra:
            manifest.update(extra)
        with open(os.path.join(src, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        for rel, doc in (files or {}).items():
            fp = os.path.join(src, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(doc, f)
        return src

    def _installed_dir(self, pid: str) -> str:
        return os.path.join(settings.STORAGE_DIR, "plugins", pid)

    def _index(self) -> dict:
        return pm._load_index().get("plugins", {})


class TestMinAppVersion(_TempStorage):
    """第 18 条：``min_app_version`` 必须被消费（此前声明了等于没写）。"""

    def test_unsatisfied_rejected(self):
        src = self._make_pack("mv-pack", extra={"min_app_version": ">=99.0.0"})
        with self.assertRaises(ValueError) as ctx:
            pm.install_from_dir(src)
        self.assertIn("应用版本", str(ctx.exception))
        self.assertFalse(os.path.isdir(self._installed_dir("mv-pack")))

    def test_satisfied_accepted(self):
        src = self._make_pack("mv-ok", extra={"min_app_version": f">={APP_VERSION}"})
        self.assertEqual(pm.install_from_dir(src).id, "mv-ok")
        self.assertTrue(os.path.isdir(self._installed_dir("mv-ok")))

    def test_caret_constraint_on_major(self):
        src = self._make_pack("mv-caret", extra={"min_app_version": f"^{APP_VERSION}"})
        self.assertEqual(pm.install_from_dir(src).id, "mv-caret")

    def test_absent_unaffected(self):
        src = self._make_pack("mv-none")
        self.assertEqual(pm.install_from_dir(src).id, "mv-none")


class TestContributionConflictPreflight(_TempStorage):
    """第 19 条：安装 / 启用前的撞名预检（`check_id_available` 真正被调用）。"""

    def test_install_refused_when_id_taken_by_other_plugin(self):
        src_a = self._make_pack("t19-a", {"canvas_nodes": ["canvas_nodes/*.json"]},
                                {"canvas_nodes/a.json": _canvas_doc("t19_dup")})
        pm.install_from_dir(src_a)
        pm.enable("t19-a")
        try:
            # packB 声明同一个 canvas_node id → 安装即拒绝，
            # 而不是「装上、启用成功、这条贡献被静默丢掉」
            src_b = self._make_pack("t19-b", {"canvas_nodes": ["canvas_nodes/*.json"]},
                                    {"canvas_nodes/b.json": _canvas_doc("t19_dup")})
            with self.assertRaises(ValueError) as ctx:
                pm.install_from_dir(src_b)
            self.assertIn("撞名", str(ctx.exception))
            self.assertFalse(os.path.isdir(self._installed_dir("t19-b")))
        finally:
            pm.uninstall("t19-a")

    def test_enable_refused_when_id_taken_after_install(self):
        """装的时候没冲突、之后被别人占了 → 启用这一步仍要拦住。"""
        from app.canvas_nodes.manager import canvas_node_manager
        from app.canvas_nodes.models import CanvasNodeSpec

        src = self._make_pack("t19-c", {"canvas_nodes": ["canvas_nodes/*.json"]},
                              {"canvas_nodes/c.json": _canvas_doc("t19_after")})
        pm.install_from_dir(src)
        canvas_node_manager.save(CanvasNodeSpec.model_validate(_canvas_doc("t19_after")))
        try:
            with self.assertRaises(ValueError) as ctx:
                pm.enable("t19-c")
            self.assertIn("撞名", str(ctx.exception))
        finally:
            canvas_node_manager.delete("t19_after")
            pm.uninstall("t19-c")

    def test_unique_ids_pass_preflight(self):
        src = self._make_pack("t19-ok", {"canvas_nodes": ["canvas_nodes/*.json"]},
                              {"canvas_nodes/ok.json": _canvas_doc("t19_unique")})
        pm.install_from_dir(src)
        try:
            summary = pm.enable("t19-ok")
            self.assertEqual([c["id"] for c in summary.get("canvas_nodes", [])], ["t19_unique"])
        finally:
            pm.uninstall("t19-ok")


class TestEmptyGlobWarning(_TempStorage):
    """第 21 条：声明了扩展点却无文件命中 → 明确 warning（此前完全静默）。"""

    def test_enable_warns_on_declared_but_empty_globs(self):
        src = self._make_pack("t21-pack",
                              {"themes": ["themes/*.json"], "exporters": ["exporters/*.json"]})
        pm.install_from_dir(src)
        try:
            warns = pm.enable("t21-pack").get("warnings", [])
            self.assertTrue(any("themes" in w and "无任何文件命中" in w for w in warns), warns)
            self.assertTrue(any("exporters" in w and "无任何文件命中" in w for w in warns), warns)
        finally:
            pm.uninstall("t21-pack")

    def test_no_warning_when_glob_hits(self):
        src = self._make_pack("t21-ok", {"canvas_nodes": ["canvas_nodes/*.json"]},
                              {"canvas_nodes/ok.json": _canvas_doc("t21_node")})
        pm.install_from_dir(src)
        try:
            warns = pm.enable("t21-ok").get("warnings", [])
            self.assertFalse(any("无任何文件命中" in w for w in warns), warns)
        finally:
            pm.uninstall("t21-ok")


class TestUninstallFailSafe(_TempStorage):
    """第 20 条：`uninstall` 不再吞掉 `disable` 失败。"""

    def test_uninstall_aborts_when_disable_fails(self):
        src = self._make_pack("t20-pack")
        pm.install_from_dir(src)
        orig = pm.disable

        def boom(pid):
            raise RuntimeError("disable 炸了")

        pm.disable = boom
        try:
            with self.assertRaises(ValueError) as ctx:
                pm.uninstall("t20-pack")
            self.assertIn("停用失败", str(ctx.exception))
        finally:
            pm.disable = orig
        # 目录 / 索引 / 贡献都保留 → 可重试（修复前会把目录删掉、索引 pop 掉，留下孤儿贡献）
        self.assertTrue(os.path.isdir(self._installed_dir("t20-pack")))
        self.assertIn("t20-pack", self._index())
        # 恢复后能正常卸载
        pm.uninstall("t20-pack")
        self.assertFalse(os.path.isdir(self._installed_dir("t20-pack")))
        self.assertNotIn("t20-pack", self._index())


class TestReloadRollback(_TempStorage):
    """第 22 条：`reload_plugin` 在 enable 失败时回滚，而不是静默停在未启用态。"""

    def test_reload_rolls_back_when_enable_fails(self):
        src = self._make_pack("t22-pack")
        pm.install_from_dir(src)
        pm.enable("t22-pack")
        orig_enable = pm.enable
        calls = []

        def flaky(pid):
            calls.append(pid)
            if len(calls) == 1:
                raise RuntimeError("enable 炸了")
            return orig_enable(pid)

        pm.enable = flaky
        try:
            with self.assertRaises(ValueError) as ctx:
                pm.reload_plugin("t22-pack")
            msg = str(ctx.exception)
            self.assertIn("重载失败", msg)
            self.assertIn("已回滚", msg)
        finally:
            pm.enable = orig_enable
        self.assertTrue(self._index()["t22-pack"]["enabled"])   # 修复前这里会变成 False

    def test_reload_reports_when_rollback_also_fails(self):
        src = self._make_pack("t22b-pack")
        pm.install_from_dir(src)
        pm.enable("t22b-pack")
        orig_enable = pm.enable

        def always_boom(pid):
            raise RuntimeError("enable 一直炸")

        pm.enable = always_boom
        try:
            with self.assertRaises(ValueError) as ctx:
                pm.reload_plugin("t22b-pack")
            self.assertIn("已停用", str(ctx.exception))
        finally:
            pm.enable = orig_enable
        self.assertFalse(self._index()["t22b-pack"]["enabled"])

    def test_reload_disabled_plugin_still_rescans(self):
        src = self._make_pack("t22c-pack")
        pm.install_from_dir(src)
        out = pm.reload_plugin("t22c-pack")
        self.assertTrue(out["reloaded"])
        self.assertFalse(out["enabled"])
        self.assertIn("仅重扫", out.get("note", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
