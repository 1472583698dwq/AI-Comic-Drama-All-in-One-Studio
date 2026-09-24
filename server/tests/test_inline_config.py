# -*- coding: utf-8 -*-
"""代码源「隐式配置」识别与迁移回归测试（stdlib unittest，零外部依赖、零网络）。

运行： python -m unittest tests.test_inline_config -v

背景：自定义代码源把 Key / 网关地址 / 工作流 ID 写在代码里时，设置页只看到一个空 Key
输入框——用户看不出实际用哪把 Key、连哪个网关，想换还得翻代码，且明文值随定义落盘。
本文件锁三件事：

  1. 识别口径：`url` / `secret` / `value` 分类正确，掩码不泄全量，工作流 id 这类
     小写下划线 slug **不得**被误判成密钥；
  2. 生效口径：配置存储有值 → `stored`（优先）；只有代码内联 → `inline`；都没有 → `none`；
  3. 迁移安全：改写只动「常量字面量置空 + generate 入口注入」，找不到入口就**一个字都不改**；
     改写后的代码必须真的能拿到注入的 Key（跑真实沙箱执行，不靠肉眼）。
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
from app.models.provider_definition import ProviderDefinition  # noqa: E402
from app.providers.custom import inline_config as ic  # noqa: E402

# 真实 AutoDL 源的写法（取值同 storage/providers/custom/*.json，测试只用于识别/改写）
REAL_KEY = "3jfV2WXEzzGkSW1gcuZwAtTAMbDhruqwgphMu9mXQ5EIKapd"

MODULE_CONST_CODE = f'''import httpx

AUTODL_BASE = "https://autodl.art/api/v1"
AUTODL_API_KEY = "{REAL_KEY}"
WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2_15s"


async def generate(ctx, api):
    headers = {{"Authorization": f"Bearer {{AUTODL_API_KEY}}",
               "Content-Type": "application/json"}}
    return {{"image_url": headers["Authorization"] + "|" + AUTODL_BASE + "|" + WORKFLOW_ID}}
'''

CTX_FALLBACK_CODE = f'''async def generate(ctx, api):
    key = ctx.get("api_key") or "{REAL_KEY}"
    return {{"image_url": key}}
'''

# 真机同款（storage/providers/custom/prov_e3a19229.json）：ctx 读之后夹了一层延迟链
LAMBDA_CHAIN_CODE = f'''async def generate(ctx, api):
    DEFAULT_WORKFLOW_ID = "minimax_h3_lightx2v_no_pic"
    API_KEY = ctx.get("api_key") or api.get("get_api_key", lambda: "")() or "{REAL_KEY}"
    return {{"image_url": API_KEY + "|" + DEFAULT_WORKFLOW_ID}}
'''

NO_ENTRY_CODE = f'''AUTODL_API_KEY = "{REAL_KEY}"
ALREADY_BROKEN = True
'''


class TempStorage(unittest.TestCase):
    """把 STORAGE_DIR 指到临时目录，避免动到真实 config_store.json。"""

    def setUp(self):
        self._orig = settings.STORAGE_DIR
        self._tmp = tempfile.mkdtemp(prefix="inline_cfg_")
        settings.STORAGE_DIR = self._tmp
        self.addCleanup(self._restore)

    def _restore(self):
        settings.STORAGE_DIR = self._orig
        shutil.rmtree(self._tmp, ignore_errors=True)

    def store_key(self, pid: str, key: str):
        """走真实落盘路径（与设置页保存 Key 同一条）。"""
        from app.api.provider_routes import _save_api_key
        _save_api_key(pid, key)
        self.addCleanup(os.environ.pop, f"CUSTOM_PROVIDER_{pid}", None)

    def defn(self, pid: str, code: str, language: str = "python") -> ProviderDefinition:
        return ProviderDefinition(
            id=pid, name="隐式配置测试源", kind="video", provider_type="code",
            language=language, code=code, code_entry="generate",
            auth={"type": "none", "key_env": None, "prefix": "Bearer "},
        )


class TestScan(unittest.TestCase):
    def test_classify_url_secret_value(self):
        scan = ic.scan_code_config(MODULE_CONST_CODE)
        by_name = {c["name"]: c for c in scan["constants"]}
        self.assertEqual(by_name["AUTODL_BASE"]["kind"], "url")
        self.assertEqual(by_name["AUTODL_BASE"]["value"], "https://autodl.art/api/v1")
        self.assertEqual(by_name["AUTODL_API_KEY"]["kind"], "secret")
        # 工作流 id 是小写下划线 slug —— 不能误判成密钥
        self.assertEqual(by_name["WORKFLOW_ID"]["kind"], "value")
        self.assertEqual(by_name["WORKFLOW_ID"]["value"], "minimax_h3_image_audio_to_video_v2_15s")

    def test_secret_masked_and_never_full(self):
        scan = ic.scan_code_config(MODULE_CONST_CODE)
        key = next(c for c in scan["constants"] if c["name"] == "AUTODL_API_KEY")
        self.assertNotEqual(key["masked"], key["value"])
        self.assertNotIn(REAL_KEY[10:30], key["masked"])
        self.assertTrue(key["masked"].startswith(REAL_KEY[:4]))
        self.assertTrue(key["masked"].endswith(REAL_KEY[-4:]))
        self.assertEqual(key["masked"], ic.mask_secret(REAL_KEY))

    def test_module_level_flag_and_line(self):
        scan = ic.scan_code_config(MODULE_CONST_CODE)
        key = next(c for c in scan["constants"] if c["name"] == "AUTODL_API_KEY")
        self.assertTrue(key["module_level"])
        self.assertEqual(key["line"], 4)

    def test_ctx_fallback_literal_detected(self):
        scan = ic.scan_code_config(CTX_FALLBACK_CODE)
        self.assertEqual(scan["constants"], [])
        self.assertEqual(len(scan["ctx_fallbacks"]), 1)
        self.assertEqual(scan["ctx_fallbacks"][0]["value"], REAL_KEY)

    def test_empty_code(self):
        self.assertEqual(
            ic.scan_code_config(""),
            {"constants": [], "ctx_fallbacks": [], "loose_literals": []},
        )

    def test_lambda_chain_fallback_detected(self):
        """真机同款：ctx.get(...) or api.get("get_api_key", lambda: "")() or "密钥"。"""
        scan = ic.scan_code_config(LAMBDA_CHAIN_CODE)
        self.assertEqual([f["value"] for f in scan["ctx_fallbacks"]], [REAL_KEY])
        # 不能把 DEFAULT_WORKFLOW_ID 这类 slug 一起抓进来
        self.assertEqual(scan["loose_literals"], [])
        self.assertEqual([c["value"] for c in scan["constants"]], ["minimax_h3_lightx2v_no_pic"])

    def test_loose_literal_scan_catches_nameless_secret(self):
        code = 'async def generate(ctx, api):\n    return {"image_url": "' + REAL_KEY + '"}\n'
        scan = ic.scan_code_config(code)
        self.assertEqual(scan["constants"], [])
        self.assertEqual(scan["ctx_fallbacks"], [])
        self.assertEqual([x["value"] for x in scan["loose_literals"]], [REAL_KEY])


class TestEffectiveConfig(TempStorage):
    def test_reads_ctx_key_covers_all_injection_points(self):
        """三个注入点都要认：ctx["api_key"] / api.get("get_api_key") / api["get_api_key"]。

        漏认会让"填了生效"的源被误报成"填了不生效"——这条提示直接决定用户敢不敢点迁移。
        """
        head = 'async def generate(ctx, api):\n    k = '
        tail = '\n    return {"image_url": k}\n'
        exprs = (
            'ctx.get("api_key") or ""',
            'ctx["api_key"]',
            'api.get("get_api_key", lambda: "")()',
            'api["get_api_key"]()',
            'api.get_api_key()',
        )
        for i, expr in enumerate(exprs):
            eff = ic.effective_config(self.defn(f"prov_reads_{i}", head + expr + tail))
            self.assertTrue(eff["reads_ctx_key"], f"漏判读取点: {expr}")
        # 反向：完全不读注入 Key 的源必须判 False
        no_read = 'async def generate(ctx, api):\n    return {"image_url": ctx.get("prompt") or ""}\n'
        self.assertFalse(ic.effective_config(self.defn("prov_reads_no", no_read))["reads_ctx_key"])

    def test_lambda_chain_reports_inline_and_reads_ctx(self):
        """真机 prov_e3a19229 的口径：内联来源是 ctx 兜底字面量，且代码确实读 ctx。"""
        eff = ic.effective_config(self.defn("prov_lambda_0", LAMBDA_CHAIN_CODE))
        self.assertEqual(eff["key_source"], "inline")
        self.assertEqual(eff["inline_key"], REAL_KEY)
        self.assertEqual(eff["inline_key_origin"], "ctx_fallback")
        self.assertTrue(eff["reads_ctx_key"])

    def test_inline_when_only_code_has_key(self):
        eff = ic.effective_config(self.defn("prov_inline_1", MODULE_CONST_CODE))
        self.assertEqual(eff["key_source"], "inline")
        self.assertEqual(eff["inline_key"], REAL_KEY)
        self.assertEqual(eff["inline_key_name"], "AUTODL_API_KEY")
        self.assertEqual(eff["stored_key"], "")
        self.assertFalse(eff["reads_ctx_key"])

    def test_stored_wins_over_inline(self):
        pid = "prov_inline_2"
        self.store_key(pid, "storedKey1234567890")
        eff = ic.effective_config(self.defn(pid, MODULE_CONST_CODE))
        self.assertEqual(eff["key_source"], "stored")
        self.assertEqual(eff["stored_key"], "storedKey1234567890")
        self.assertEqual(eff["env_name"], f"CUSTOM_PROVIDER_{pid}")
        # 代码里那句仍在（只是变成兜底），所以两个字段都要如实给出
        self.assertEqual(eff["inline_key"], REAL_KEY)

    def test_none_when_nothing_configured(self):
        eff = ic.effective_config(self.defn("prov_inline_3", CTX_FALLBACK_CODE.replace(REAL_KEY, "")))
        self.assertEqual(eff["key_source"], "none")
        self.assertEqual(eff["inline_key"], "")
        self.assertTrue(eff["reads_ctx_key"])


class TestRewrite(unittest.TestCase):
    def test_constant_rewrite_shape(self):
        new, notes = ic.rewrite_inline_key(
            MODULE_CONST_CODE, "python", REAL_KEY, "AUTODL_API_KEY", "CUSTOM_PROVIDER_prov_x",
        )
        self.assertNotEqual(new, MODULE_CONST_CODE)
        self.assertIn('AUTODL_API_KEY = ""', new)
        self.assertIn("global AUTODL_API_KEY", new)
        self.assertNotIn(REAL_KEY, new)               # 明文密钥不再留在源码里
        self.assertIn("WORKFLOW_ID", new)             # 其他常量原样保留
        self.assertEqual(len(notes), 2)

    def test_rewritten_code_still_works_and_prefers_stored_key(self):
        """行为不变：改写后跑真实沙箱，拿到的必须是 ctx 里注入的 Key。"""
        from app.providers.generic import code_provider as cp
        new, _ = ic.rewrite_inline_key(
            MODULE_CONST_CODE, "python", REAL_KEY, "AUTODL_API_KEY", "CUSTOM_PROVIDER_prov_x",
        )
        out = asyncio.run(cp._execute_python_code(new, "generate", {"api_key": "stored-key-abc"}, timeout=30))
        self.assertEqual(
            out["image_url"],
            "Bearer stored-key-abc|https://autodl.art/api/v1|minimax_h3_image_audio_to_video_v2_15s",
        )

    def test_rewritten_code_without_ctx_key_degrades_to_empty(self):
        """没配 Key 时不再回落到明文（宁可空，也不静默用旧密钥）。"""
        from app.providers.generic import code_provider as cp
        new, _ = ic.rewrite_inline_key(
            MODULE_CONST_CODE, "python", REAL_KEY, "AUTODL_API_KEY", "CUSTOM_PROVIDER_prov_x",
        )
        out = asyncio.run(cp._execute_python_code(new, "generate", {}, timeout=30))
        self.assertTrue(out["image_url"].startswith("Bearer |"))

    def test_expression_literal_removed(self):
        new, notes = ic.rewrite_inline_key(CTX_FALLBACK_CODE, "python", REAL_KEY, None, "CUSTOM_PROVIDER_prov_y")
        self.assertNotIn(REAL_KEY, new)
        self.assertIn('ctx.get("api_key") or ""', new)
        self.assertEqual(len(notes), 1)

    def test_no_entry_means_no_change(self):
        """找不到 generate 入口时一个字都不能改（否则会把源改坏）。"""
        new, notes = ic.rewrite_inline_key(
            NO_ENTRY_CODE, "python", REAL_KEY, "AUTODL_API_KEY", "CUSTOM_PROVIDER_prov_z",
        )
        self.assertEqual(new, NO_ENTRY_CODE)
        self.assertEqual(len(notes), 1)
        self.assertIn("无法安全改写", notes[0])

    def test_javascript_never_rewritten(self):
        new, notes = ic.rewrite_inline_key(
            MODULE_CONST_CODE, "javascript", REAL_KEY, "AUTODL_API_KEY", "CUSTOM_PROVIDER_prov_js",
        )
        self.assertEqual(new, MODULE_CONST_CODE)
        self.assertEqual(notes, [])

    def test_literal_not_present_is_noop(self):
        new, notes = ic.rewrite_inline_key(MODULE_CONST_CODE, "python", "no-such-literal", "AUTODL_API_KEY", "env")
        self.assertEqual(new, MODULE_CONST_CODE)
        self.assertEqual(notes, [])

    def test_lambda_chain_rewrite_keeps_behavior(self):
        """真机同款延迟链：去掉字面量后仍优先读 ctx，且不误伤其他常量。"""
        from app.providers.generic import code_provider as cp
        new, notes = ic.rewrite_inline_key(
            LAMBDA_CHAIN_CODE, "python", REAL_KEY, None, "CUSTOM_PROVIDER_prov_lambda",
        )
        self.assertNotIn(REAL_KEY, new)
        self.assertIn("DEFAULT_WORKFLOW_ID", new)
        self.assertEqual(len(notes), 1)
        out = asyncio.run(cp._execute_python_code(new, "generate", {"api_key": "k-from-store"}, timeout=30))
        self.assertEqual(out["image_url"], "k-from-store|minimax_h3_lightx2v_no_pic")


class TestEffectiveConfigAfterMigration(TempStorage):
    def test_migrated_definition_reports_stored(self):
        pid = "prov_migrate_1"
        pd = self.defn(pid, MODULE_CONST_CODE)
        eff = ic.effective_config(pd)
        # 迁移动作 = 落盘 + 改写（与 POST /providers/{id}/migrate-inline-key 同路径）
        self.store_key(pid, eff["inline_key"])
        new_code, notes = ic.rewrite_inline_key(
            pd.code, pd.language, eff["inline_key"], eff["inline_key_name"], f"CUSTOM_PROVIDER_{pid}",
        )
        pd.code = new_code
        pd.auth.key_env = f"CUSTOM_PROVIDER_{pid}"
        after = ic.effective_config(pd)
        self.assertEqual(after["key_source"], "stored")
        self.assertEqual(after["stored_key"], REAL_KEY)
        self.assertEqual(after["inline_key"], "")     # 明文密钥已从源码里消失
        self.assertNotIn(REAL_KEY, pd.code)
        self.assertEqual([c for c in after["constants"] if c["kind"] == "secret"], [])
        # 地址 / 工作流 ID 这类非密钥常量原样保留（不是迁移对象）
        self.assertEqual(
            sorted(c["name"] for c in after["constants"]), ["AUTODL_BASE", "WORKFLOW_ID"],
        )
        self.assertTrue(after["reads_ctx_key"])
        self.assertEqual(len(notes), 2)


class TestStorageFileShape(TempStorage):
    def test_save_api_key_writes_both_shapes(self):
        pid = "prov_shape_1"
        self.store_key(pid, "k-1234567890")
        with open(os.path.join(self._tmp, "config_store.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data[f"CUSTOM_PROVIDER_{pid}"], "k-1234567890")
        self.assertEqual(data["custom_providers"][pid]["api_key"], "k-1234567890")


if __name__ == "__main__":
    unittest.main()
