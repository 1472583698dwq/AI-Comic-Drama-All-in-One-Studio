# -*- coding: utf-8 -*-
"""tool 配对消毒回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_tool_pairing -v
背景：prune 替换预览与后续 summary 遮蔽集重叠时，会产出孤儿 tool 消息；
中断未执行的工具调用会缺响应。derive_messages 必须输出对 LLM 合法的配对，
否则真实运行会 400: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.runtime import events as E  # noqa: E402
from app.agent.runtime.session import Session  # noqa: E402
from app.agent.runtime.store import SessionStore  # noqa: E402


class TestToolPairing(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="pairing_")
        self.store = SessionStore(root=Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def _session(self, sid: str) -> Session:
        return Session(sid, [], store=self.store)

    def test_orphan_replacement_dropped_when_parent_shadowed(self):
        """prune 的替换预览 + 后续 summary 遮蔽父级 assistant → 替换残留必须丢弃。"""
        s = self._session("orphan")
        a = s.append(E.ASSISTANT_MESSAGE, {
            "text": "", "tool_calls": [{"id": "b1", "name": "list", "arguments": {}}]})
        r = s.append(E.TOOL_RESULT, {
            "call_id": "b1", "name": "list", "status": "success", "result": {"ok": 1}})
        s.append(E.COMPACTION_PRUNE, {
            "shadowed_seqs": [r["seq"]], "replacements": {str(r["seq"]): "结果预览"}})
        s.append(E.COMPACTION_SUMMARY, {
            "text": "旧历史摘要", "shadowed_seqs": [a["seq"], r["seq"]]})
        msgs = s.derive_messages()
        self.assertFalse([m for m in msgs if m["role"] == "tool"])
        self.assertTrue(any(m["role"] == "user" and "旧历史摘要" in m["content"] for m in msgs))

    def test_missing_tool_response_filled(self):
        """assistant 有两个 tool_calls，只回了一个 → 另一个补合成错误结果且顺序正确。"""
        s = self._session("missing")
        s.append(E.USER_MESSAGE, {"text": "hi"})
        s.append(E.ASSISTANT_MESSAGE, {"text": "", "tool_calls": [
            {"id": "c1", "name": "a", "arguments": {}},
            {"id": "c2", "name": "b", "arguments": {}},
        ]})
        s.append(E.TOOL_RESULT, {
            "call_id": "c1", "name": "a", "status": "success", "result": "ok"})
        s.append(E.USER_MESSAGE, {"text": "next"})
        msgs = s.derive_messages()
        roles = [m["role"] for m in msgs]
        ai = roles.index("assistant")
        self.assertEqual(msgs[ai + 1]["role"], "tool")
        self.assertEqual(msgs[ai + 1]["tool_call_id"], "c1")
        self.assertEqual(msgs[ai + 2]["role"], "tool")
        self.assertEqual(msgs[ai + 2]["tool_call_id"], "c2")
        self.assertIn("不可用", msgs[ai + 2]["content"])
        self.assertEqual(msgs[ai + 3]["role"], "user")

    def test_pure_orphan_dropped(self):
        """无任何父级的 tool 结果直接丢弃。"""
        s = self._session("pure")
        s.append(E.TOOL_RESULT, {
            "call_id": "zz", "name": "x", "status": "success", "result": "x"})
        self.assertFalse([m for m in s.derive_messages() if m["role"] == "tool"])

    def test_valid_pair_untouched(self):
        """合法配对原样保留，不注入合成结果。"""
        s = self._session("valid")
        s.append(E.USER_MESSAGE, {"text": "hi"})
        s.append(E.ASSISTANT_MESSAGE, {
            "text": "", "tool_calls": [{"id": "k1", "name": "t", "arguments": {}}]})
        s.append(E.TOOL_RESULT, {
            "call_id": "k1", "name": "t", "status": "success", "result": {"a": 1}})
        msgs = s.derive_messages()
        tools = [m for m in msgs if m["role"] == "tool"]
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["tool_call_id"], "k1")
        self.assertNotIn("不可用", tools[0]["content"])

    def test_derived_messages_never_violate_pairing(self):
        """组合断言：任意投影结果里，tool 消息必须都能找到仍在挂起的父级 tool_calls。"""
        s = self._session("combo")
        s.append(E.USER_MESSAGE, {"text": "u1"})
        s.append(E.ASSISTANT_MESSAGE, {"text": "", "tool_calls": [
            {"id": "m1", "name": "a", "arguments": {}},
            {"id": "m2", "name": "b", "arguments": {}}]})
        s.append(E.TOOL_RESULT, {"call_id": "m1", "name": "a", "status": "success", "result": "ok"})
        s.append(E.USER_MESSAGE, {"text": "u2"})
        s.append(E.ASSISTANT_MESSAGE, {
            "text": "", "tool_calls": [{"id": "n1", "name": "c", "arguments": {}}]})
        pending = set()
        for m in s.derive_messages():
            if m["role"] == "assistant":
                pending = {tc["id"] for tc in (m.get("tool_calls") or [])}
            elif m["role"] == "tool":
                self.assertIn(m["tool_call_id"], pending)
                pending.discard(m["tool_call_id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
