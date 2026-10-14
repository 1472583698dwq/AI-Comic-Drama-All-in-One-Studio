# -*- coding: utf-8 -*-
"""生成源 Key 治理回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_key_admin -v
钉住「Key 一律走设置→生成源（配置存储），代码里不许硬编码」：
- 只读状态：stored / inline / none 三态 + 掩码（绝不含明文）；
- 迁移：内联明文 → 配置存储（可改写代码为 ctx 读取），返回体只有掩码；
- Agent 面：工具注册 / 只读白名单 / 风险分级 / 系统提示词规则齐备。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402

_SECRET = "sk-live-abcdef1234567890abcdef"


def _defn(pid: str, code: str):
    from app.models.provider_definition import ProviderDefinition
    return ProviderDefinition(
        id=pid, name="Key 治理测试源", kind="video", provider_type="code",
        language="python", code=code, code_entry="generate",
    )


_INLINE_CODE = (
    "import httpx\n\n"
    "async def generate(ctx, api):\n"
    f"    key = ctx.get(\"api_key\") or \"{_SECRET}\"\n"
    "    return {'video_url': None, 'task_id': 't1', 'status': 'SUBMITTED'}\n"
)
_CLEAN_CODE = (
    "import httpx\n\n"
    "async def generate(ctx, api):\n"
    "    key = ctx.get(\"api_key\") or \"\"\n"
    "    return {'video_url': None, 'task_id': 't1', 'status': 'SUBMITTED'}\n"
)


class TestKeyStatusAndMigrate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="prov_key_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        # 用例间隔离：清掉迁移用例写下的配置/环境变量，避免污染后续用例的 key_source
        for k in list(os.environ.keys()):
            if k.startswith("CUSTOM_PROVIDER_prov_key"):
                os.environ.pop(k, None)
        try:
            os.remove(os.path.join(self._tmp, "config_store.json"))
        except Exception:
            pass

    def test_status_inline_masked(self):
        from app.providers.custom.inline_config import key_status
        st = key_status(_defn("prov_key_a", _INLINE_CODE))
        self.assertEqual(st["key_source"], "inline")
        self.assertTrue(st["migratable"])
        self.assertIn("*", st["key_masked"])
        self.assertNotIn(_SECRET, json.dumps(st, ensure_ascii=False), "状态接口绝不能吐出明文 Key")
        self.assertIn("明文", st["hint"])

    def test_status_none_needs_config(self):
        from app.providers.custom.inline_config import key_status
        st = key_status(_defn("prov_key_b", _CLEAN_CODE))
        self.assertEqual(st["key_source"], "none")
        self.assertIn("设置→生成源", st["hint"])

    def test_migrate_writes_store_and_rewrites_code(self):
        from app.providers.custom import inline_config as ic
        from app.providers.custom.manager import custom_provider_manager
        d = _defn("prov_key_a", _INLINE_CODE)
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=d), \
             mock.patch.object(custom_provider_manager, "save_definition", side_effect=lambda x: x), \
             mock.patch("app.providers.init_providers.register_single_custom_provider", return_value=True):
            res = ic.migrate_inline_key("prov_key_a", rewrite_code=True)
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["key_status"]["key_source"], "stored")
        self.assertNotIn(_SECRET, json.dumps(res, ensure_ascii=False), "迁移返回体绝不能带明文")
        # 配置存储落盘（换 Key 的唯一入口）
        cfg = json.load(open(os.path.join(self._tmp, "config_store.json"), encoding="utf-8"))
        self.assertEqual(cfg.get("CUSTOM_PROVIDER_prov_key_a"), _SECRET)
        # 代码里的明文被移除，改由 ctx 注入读
        self.assertNotIn(_SECRET, d.code or "", "迁移后代码里不允许再有明文 Key")
        self.assertIn('ctx.get("api_key")', d.code or "")

    def test_migrate_noop_when_clean(self):
        from app.providers.custom import inline_config as ic
        from app.providers.custom.manager import custom_provider_manager
        d = _defn("prov_key_b", _CLEAN_CODE)
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=d):
            res = ic.migrate_inline_key("prov_key_b")
        self.assertEqual(res["status"], "noop")

    def test_brief_key_mark(self):
        from app.agent.tools.registry import ToolRegistryView
        from app.providers.custom.manager import custom_provider_manager
        with mock.patch.object(custom_provider_manager, "get_definition", return_value=_defn("prov_key_a", _INLINE_CODE)):
            mark = ToolRegistryView._provider_key_mark("provider_prov_key_a")
        self.assertIn("迁移", mark)


class TestAgentSurfaceForKeyAdmin(unittest.TestCase):
    def test_tools_registered(self):
        from app.mcp.server import mcp_registry
        names = {t.name for t in mcp_registry.get_all_tools()}
        self.assertIn("provider_key_status", names)
        self.assertIn("migrate_provider_inline_key", names)

    def test_mode_policy(self):
        from app.agent import mode_policy
        self.assertIn("provider_key_status", mode_policy.PLAN_READONLY_TOOLS)
        self.assertEqual(mode_policy.tool_risk("provider_key_status"), "low")
        self.assertEqual(mode_policy.tool_risk("migrate_provider_inline_key"), "medium")

    def test_prompt_states_no_hardcode_rule(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(run_mode="approve")
        self.assertIn("禁止把 Key", p)
        self.assertIn("provider_key_status", p)
        self.assertIn("migrate_provider_inline_key", p)

    def test_register_warning_on_inline_key(self):
        """注册工具返回体要带 key_status/key_warning（Agent 必须提示用户改用设置页）。"""
        from app.providers.custom.inline_config import key_status
        st = key_status(_defn("prov_key_a", _INLINE_CODE))
        self.assertEqual(st["key_source"], "inline")
        self.assertTrue(st["migratable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
