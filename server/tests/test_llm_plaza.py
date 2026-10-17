# -*- coding: utf-8 -*-
"""模型广场：地址收口、供应商增删、对话选中覆盖。不访问网络。"""
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
