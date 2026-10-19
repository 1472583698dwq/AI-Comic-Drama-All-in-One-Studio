# -*- coding: utf-8 -*-
"""模型广场：地址收口、供应商增删改、自定义请求头、对话选中覆盖。不访问网络。"""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from app.llm import plaza
from app.llm.claude_wire import events_to_chunks, to_anthropic
from app.agent.llm.adapter import adapter, pop_chat_override, push_chat_override


class PlazaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "llm_plaza.json")
        self.p = patch("app.llm.plaza._store_path", return_value=self.path)
        self.p.start()
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"suppliers": [], "active": {"supplier_id": "", "model": ""}}, f)

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def test_models_url_and_chat_endpoint(self):
        self.assertEqual(plaza.models_url("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/models")
        self.assertEqual(plaza.models_url("https://api.deepseek.com"), "https://api.deepseek.com/v1/models")
        self.assertEqual(
            plaza.chat_endpoint("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        self.assertEqual(
            plaza.chat_endpoint("https://api.openai.com/v1/responses"),
            "https://api.openai.com/v1/chat/completions",
        )
        self.assertEqual(
            plaza.chat_endpoint("https://api.anthropic.com", "claude"),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(plaza.list_headers("claude", "sk-ant")["x-api-key"], "sk-ant")
        self.assertNotIn("Authorization", plaza.list_headers("claude", "sk-ant"))

    def test_add_select_delete_does_not_leak_key(self):
        pub = plaza.add_supplier("DeepSeek", "https://api.deepseek.com/v1", "sk-test-secret-key")
        self.assertNotIn("api_key", pub)
        self.assertTrue(pub["has_key"])
        self.assertIn("••••", pub["api_key_hint"])
        plaza.set_active(pub["id"], "deepseek-chat")
        ov = plaza.resolve_override(pub["id"], "deepseek-chat")
        self.assertEqual(ov["model"], "deepseek-chat")
        self.assertEqual(ov["api_key"], "sk-test-secret-key")
        self.assertTrue(ov["endpoint"].endswith("/chat/completions"))
        self.assertEqual(ov["protocol"], "openai")
        claude = plaza.add_supplier("官方 Claude", "https://api.anthropic.com", "sk-ant-secret", "claude")
        self.assertEqual(claude["protocol"], "claude")
        cov = plaza.resolve_override(claude["id"], "claude-sonnet-4-5")
        self.assertEqual(cov["protocol"], "claude")
        self.assertTrue(cov["endpoint"].endswith("/v1/messages"))
        snap = plaza.snapshot()
        self.assertEqual(snap["active"]["model"], "deepseek-chat")
        plaza.delete_supplier(pub["id"])
        plaza.delete_supplier(claude["id"])
        self.assertEqual(plaza.snapshot()["suppliers"], [])
        self.assertEqual(plaza.resolve_override(pub["id"], "deepseek-chat"), None)

    def test_custom_headers_flow_to_list_and_chat(self):
        pub = plaza.add_supplier(
            "OpenCode Zen", "https://opencode.ai/zen/go/v1", "sk-ok", "openai",
            headers={"x-opencode-session": "session_abc", "X-Foo": "bar"},
        )
        self.assertEqual(pub["headers"]["X-Foo"], "bar")
        self.assertNotIn("api_key", pub)

        hdrs = plaza.list_headers("openai", "sk-ok", pub["headers"])
        self.assertEqual(hdrs["x-opencode-session"], "session_abc")
        self.assertEqual(hdrs["X-Foo"], "bar")

        ov = plaza.resolve_override(pub["id"], "some-model")
        self.assertEqual(ov["headers"]["x-opencode-session"], "session_abc")
        self.assertTrue(ov["endpoint"].endswith("/chat/completions"))

        # 没配会话头时自动补一个（与全局通道行为一致）
        pub2 = plaza.add_supplier("Zen2", "https://opencode.ai/zen/go/v1", "sk-ok")
        ov2 = plaza.resolve_override(pub2["id"], "m")
        self.assertTrue(str(ov2["headers"].get("x-opencode-session", "")).startswith("session_"))

    def test_headers_parse_and_validation(self):
        self.assertEqual(
            plaza._clean_headers('{"X-A": "1"}\n'),
            {"X-A": "1"},
        )
        self.assertEqual(plaza._clean_headers("X-A: 1\nX-B=2"), {"X-A": "1", "X-B": "2"})
        self.assertEqual(plaza._clean_headers([{"key": "X-A", "value": "1"}]), {"X-A": "1"})
        with self.assertRaises(ValueError):
            plaza._clean_headers({"X-中文": "1"})
        with self.assertRaises(ValueError):
            plaza._clean_headers({"X-A": "中文值"})

    def test_key_validation_rejects_masked_and_non_ascii(self):
        with self.assertRaises(ValueError):
            plaza.add_supplier("x", "https://api.example.com/v1", "••••••••••••")
        with self.assertRaises(ValueError):
            plaza.add_supplier("x", "https://api.example.com/v1", "sk-中文")
        with self.assertRaises(ValueError):
            plaza.add_supplier("x", "https://api.example.com/v1", "sk-a b")
        with self.assertRaises(ValueError):
            plaza.add_supplier("x", "api.example.com", "sk-ok")

    def test_update_supplier_edits_fields_and_keeps_blank_key(self):
        pub = plaza.add_supplier("Old", "https://api.example.com/v1", "sk-old")
        upd = plaza.update_supplier(
            pub["id"], name="New", base_url="https://api.example.com/v1/", api_key="",
            headers={"X-Foo": "bar"},
        )
        self.assertEqual(upd["name"], "New")
        self.assertEqual(upd["base_url"], "https://api.example.com/v1")
        self.assertEqual(upd["headers"], {"X-Foo": "bar"})
        ov = plaza.resolve_override(pub["id"], "m")
        self.assertEqual(ov["api_key"], "sk-old")  # 留空 = 保留旧 Key
        plaza.update_supplier(pub["id"], api_key="sk-new")
        self.assertEqual(plaza.resolve_override(pub["id"], "m")["api_key"], "sk-new")
        self.assertIsNone(plaza.update_supplier("sup_missing", name="x"))

    def test_refresh_legacy_non_ascii_key_gives_readable_error(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({
                "suppliers": [{
                    "id": "sup_bad", "name": "bad", "protocol": "openai",
                    "base_url": "https://api.example.com/v1", "api_key": "••••••••",
                    "headers": {}, "models": [], "fetched_at": "", "error": "",
                }],
                "active": {"supplier_id": "", "model": ""},
            }, f, ensure_ascii=False)

        class Boom:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def get(self, *a, **k):
                raise UnicodeEncodeError("ascii", "••••••••", 0, 8, "ordinal not in range(128)")

        with patch("app.llm.plaza.httpx.AsyncClient", Boom):
            sup = asyncio.run(plaza.refresh_supplier("sup_bad"))
        self.assertIn("非 ASCII", sup["error"])

    def test_adapter_override_wins_over_settings(self):
        token = push_chat_override({
            "endpoint": "https://example.test/v1/chat/completions",
            "api_key": "sk-plaza",
            "model": "plaza-model",
        })
        try:
            cfg = adapter.resolve()
            self.assertEqual(cfg["model"], "plaza-model")
            self.assertEqual(cfg["api_key"], "sk-plaza")
        finally:
            pop_chat_override(token)
        self.assertNotEqual(adapter.resolve().get("model"), "plaza-model")

    def test_adapter_plaza_headers_do_not_mix_with_global_custom_headers(self):
        from app.pipelines.llm_service import llm_service

        with patch.object(llm_service, "_get_custom_headers",
                          return_value={"Authorization": "Bearer global-key", "X-Global": "1"}):
            token = push_chat_override({
                "endpoint": "https://example.test/v1/chat/completions",
                "api_key": "sk-plaza",
                "model": "m",
                "headers": {"x-opencode-session": "session_x"},
            })
            try:
                cfg = adapter.resolve()
                hdrs = adapter._headers(cfg["api_key"], cfg.get("headers") or None,
                                        use_global=not cfg.get("from_plaza"))
                self.assertEqual(hdrs["Authorization"], "Bearer sk-plaza")
                self.assertEqual(hdrs["x-opencode-session"], "session_x")
                self.assertNotIn("X-Global", hdrs)
            finally:
                pop_chat_override(token)
            # 没有广场覆盖时，全局自定义头照旧生效（不回归）
            hdrs2 = adapter._headers("sk-global")
            self.assertEqual(hdrs2["Authorization"], "Bearer global-key")

    def test_default_model_set_resolve_and_cleanup(self):
        pub = plaza.add_supplier("DeepSeek", "https://api.deepseek.com/v1", "sk-d")
        plaza.set_default(pub["id"], "deepseek-chat")
        snap = plaza.snapshot()
        self.assertEqual(snap["default"], {"supplier_id": pub["id"], "model": "deepseek-chat"})
        d = plaza.resolve_default()
        self.assertEqual(d["model"], "deepseek-chat")
        self.assertEqual(d["api_key"], "sk-d")
        self.assertTrue(d["endpoint"].endswith("/chat/completions"))
        with self.assertRaises(ValueError):
            plaza.set_default("sup_missing", "m")
        with self.assertRaises(ValueError):
            plaza.set_default(pub["id"], "")
        plaza.delete_supplier(pub["id"])
        self.assertEqual(plaza.snapshot()["default"]["supplier_id"], "")
        self.assertIsNone(plaza.resolve_default())

    def test_pipeline_chat_stream_uses_plaza_default(self):
        from app.pipelines.llm_service import llm_service as svc

        captured = {}

        async def fake_stream(**kw):
            captured.update(kw)
            yield "OK"

        override = {
            "endpoint": "https://gateway.test/v1/chat/completions",
            "api_key": "sk-gw",
            "model": "gw-model",
            "protocol": "openai",
            "headers": {"X-Foo": "1"},
        }

        async def run():
            with patch.object(svc, "_plaza_default_override", return_value=override), \
                 patch.object(svc, "_stream_openai_chat_completions", fake_stream):
                out = []
                async for c in svc.chat_stream([{"role": "user", "content": "hi"}]):
                    out.append(c)
                return out

        out = asyncio.run(run())
        self.assertEqual(out, ["OK"])
        self.assertTrue(captured["base_url"].endswith("/chat/completions"))
        self.assertEqual(captured["model"], "gw-model")
        self.assertEqual(captured["api_key"], "sk-gw")
        self.assertTrue(captured["skip_global_headers"])
        self.assertEqual(captured["extra_headers"], {"X-Foo": "1"})

    def test_adapter_falls_back_to_plaza_default(self):
        with patch("app.llm.plaza.resolve_default", return_value={
            "endpoint": "https://gw.test/v1/chat/completions",
            "api_key": "sk-gw",
            "model": "gw-model",
            "protocol": "openai",
            "headers": {"X-Foo": "1"},
        }):
            cfg = adapter.resolve()
        self.assertEqual(cfg["model"], "gw-model")
        self.assertEqual(cfg["headers"], {"X-Foo": "1"})
        self.assertTrue(cfg.get("from_plaza"))

    def test_responses_protocol_endpoints_and_override(self):
        self.assertEqual(plaza.normalize_protocol("responses_api"), "responses")
        self.assertEqual(plaza.normalize_protocol("responses"), "responses")
        self.assertEqual(
            plaza.chat_endpoint("https://api.openai.com/v1", "responses"),
            "https://api.openai.com/v1/responses",
        )
        self.assertEqual(
            plaza.chat_endpoint("https://gateway.test", "responses"),
            "https://gateway.test/v1/responses",
        )
        self.assertEqual(
            plaza.chat_completions_endpoint("https://api.openai.com/v1/responses"),
            "https://api.openai.com/v1/chat/completions",
        )
        pub = plaza.add_supplier("OpenAI", "https://api.openai.com/v1", "sk-rs", "responses")
        self.assertEqual(pub["protocol"], "responses")
        ov = plaza.resolve_override(pub["id"], "gpt-5")
        self.assertEqual(ov["endpoint"], "https://api.openai.com/v1/responses")
        self.assertEqual(ov["fallback_endpoint"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(ov["protocol"], "responses")
        # 拉模型仍走 /v1/models（Bearer），与 chat 协议无关
        self.assertEqual(plaza.models_url("https://api.openai.com/v1", "responses"), "https://api.openai.com/v1/models")

    def test_pipeline_responses_protocol_uses_responses_streamer(self):
        from app.pipelines.llm_service import llm_service as svc

        captured = {}

        async def fake_responses(**kw):
            captured.update(kw)
            yield "RS-OK"

        override = {
            "endpoint": "https://gw.test/v1/responses",
            "fallback_endpoint": "https://gw.test/v1/chat/completions",
            "api_key": "sk-rs",
            "model": "gpt-5",
            "protocol": "responses",
            "headers": {},
        }

        async def run():
            with patch.object(svc, "_plaza_default_override", return_value=override), \
                 patch.object(svc, "_stream_responses_api", fake_responses):
                out = []
                async for c in svc.chat_stream([{"role": "user", "content": "hi"}]):
                    out.append(c)
                return out

        out = asyncio.run(run())
        self.assertEqual(out, ["RS-OK"])
        self.assertTrue(captured["url"].endswith("/v1/responses"))
        self.assertEqual(captured["fallback_base"], "https://gw.test/v1/chat/completions")
        self.assertTrue(captured["skip_global_headers"])

    def test_adapter_responses_protocol_downgrades_to_chat(self):
        with patch("app.llm.plaza.resolve_default", return_value={
            "endpoint": "https://gw.test/v1/responses",
            "fallback_endpoint": "https://gw.test/v1/chat/completions",
            "api_key": "sk-rs",
            "model": "gpt-5",
            "protocol": "responses",
            "headers": {},
        }):
            cfg = adapter.resolve()
        # Agent 会话统一走同站点 chat/completions（与旧直连通道同口径）
        self.assertEqual(cfg["endpoint"], "https://gw.test/v1/chat/completions")
        self.assertEqual(cfg["protocol"], "openai")
        self.assertTrue(cfg.get("from_plaza"))

    def test_claude_message_and_event_shape(self):
        system, messages, tools = to_anthropic(
            [
                {"role": "system", "content": "你是导演"},
                {"role": "user", "content": "画一张图"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "gen", "arguments": "{\"n\":1}"}},
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
            ],
            [{"type": "function", "function": {"name": "gen", "description": "生图", "parameters": {"type": "object"}}}],
        )
        self.assertIn("导演", system)
        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[1]["content"][0]["type"], "tool_use")
        self.assertEqual(messages[2]["content"][0]["type"], "tool_result")
        self.assertEqual(tools[0]["name"], "gen")
        start = events_to_chunks({
            "type": "content_block_start", "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu_1", "name": "gen"},
        })
        delta = events_to_chunks({
            "type": "content_block_delta", "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": "{\"n\":1}"},
        })
        done = events_to_chunks({"type": "message_delta", "delta": {"stop_reason": "tool_use"}})
        self.assertEqual(start[0]["tool_name"], "gen")
        self.assertEqual(delta[0]["arguments_delta"], "{\"n\":1}")
        self.assertEqual(done[0]["finish_reason"], "tool_calls")


if __name__ == "__main__":
    unittest.main()
