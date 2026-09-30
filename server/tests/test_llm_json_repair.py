# -*- coding: utf-8 -*-
"""LLM JSON 鲁棒解析回归测试（stdlib unittest，零外部依赖）。

背景：拆解大章节时 LLM 返回的 JSON 常被 max_tokens 截断 / 带代码围栏 /
含裸换行，旧解析直接失败导致 onekey_split 连续报「无法解析有效 JSON」。
覆盖：围栏补剥离、尾逗号、裸控制字符、截断补齐（含字符串中途截断）。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.pipelines.llm_service import extract_json_from_text, LLMServiceError, _with_deadline  # noqa: E402


class TestJsonSalvage(unittest.TestCase):
    def test_complete_fenced(self):
        obj = extract_json_from_text('```json\n{"a": 1, "b": [1, 2]}\n```')
        self.assertEqual(obj["a"], 1)
        self.assertEqual(obj["b"], [1, 2])

    def test_bare_object(self):
        self.assertEqual(extract_json_from_text('{"x": true}')["x"], True)

    def test_truncated_fence_salvage(self):
        txt = ('```json\n{"title": "t", "scenes": [{"scene_index": 1, "shots": ['
               '{"shot_index": 1, "action_desc": "开"}, {"shot_index": 2, "action_desc": "中')
        obj = extract_json_from_text(txt)
        self.assertEqual(obj["title"], "t")
        self.assertTrue(obj["scenes"])
        self.assertEqual(obj["scenes"][0]["scene_index"], 1)

    def test_truncated_deep_mid_string(self):
        txt = ('{"scenes": [{"scene_index": 1, "shots": [{"shot_index": 1, '
               '"action_desc": "a", "image_prompt": "long long long')
        obj = extract_json_from_text(txt)
        self.assertEqual(obj["scenes"][0]["scene_index"], 1)

    def test_truncated_partial_value(self):
        txt = ('{"scenes": [{"scene_index": 1, "shots": [{"shot_index": 1}, '
               '{"shot_index": 2, "duration": 3.')
        obj = extract_json_from_text(txt)
        self.assertEqual(obj["scenes"][0]["shots"][0]["shot_index"], 1)

    def test_trailing_comma(self):
        obj = extract_json_from_text('{"a": [1, 2,], "b": {"c": 3,},}')
        self.assertEqual(obj["a"], [1, 2])
        self.assertEqual(obj["b"]["c"], 3)

    def test_raw_newline_in_string(self):
        obj = extract_json_from_text('{"text": "line1\nline2"}')
        self.assertIn("line1", obj["text"])

    def test_think_tags_stripped(self):
        txt = '<think>思考不输出</think>\n{"ok": 1}'
        self.assertEqual(extract_json_from_text(txt)["ok"], 1)

    def test_unparseable_raises_with_hint(self):
        with self.assertRaises(LLMServiceError) as ctx:
            extract_json_from_text("完全不是 JSON 的内容")
        msg = str(ctx.exception)
        self.assertIn("无法从 LLM 返回内容中解析有效 JSON", msg)
        self.assertIn("字符", msg)


class TestStreamDeadline(unittest.TestCase):
    """流式调用总时限：网关只发心跳不吐内容时，必须按总预算中止（历史事故：单次调用挂 8 分钟）。"""

    def test_hanging_stream_aborts_within_budget(self):
        import asyncio
        import time

        async def hang():
            await asyncio.sleep(30)
            yield "never"

        async def go():
            async for _ in _with_deadline(hang(), 0.2, "测试流"):
                pass

        t0 = time.monotonic()
        loop = asyncio.new_event_loop()
        try:
            with self.assertRaises(LLMServiceError) as ctx:
                loop.run_until_complete(go())
        finally:
            loop.close()
        self.assertIn("超时", str(ctx.exception))
        self.assertLess(time.monotonic() - t0, 5.0)

    def test_normal_stream_passes_through(self):
        import asyncio

        async def gen():
            for i in range(3):
                yield str(i)

        async def go():
            out = []
            async for c in _with_deadline(gen(), 5):
                out.append(c)
            return out

        loop = asyncio.new_event_loop()
        try:
            out = loop.run_until_complete(go())
        finally:
            loop.close()
        self.assertEqual(out, ["0", "1", "2"])


if __name__ == "__main__":
    unittest.main()
