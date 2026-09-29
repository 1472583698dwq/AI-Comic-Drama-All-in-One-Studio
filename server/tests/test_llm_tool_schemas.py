# -*- coding: utf-8 -*-
"""工具 schema 守门回归：布尔 `required` 是非法 JSON Schema，会让严格校验的 LLM 上游
400 Invalid request parameters（整次模型调用一票否决）。两层防御：
1) 工作流派生源的 per-slot 媒体输入不再写布尔 required（源头修复）；
2) 适配器发送前递归清洗（任何来源的脏 schema 都打不穿模型调用）。
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.llm.adapter import _sanitize_tool_schemas  # noqa: E402


def _has_bool_required(node) -> bool:
    if isinstance(node, dict):
        req = node.get("required")
        if req is not None and not (isinstance(req, list) and all(isinstance(x, str) for x in req)):
            return True
        return any(_has_bool_required(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_bool_required(v) for v in node)
    return False


class TestSanitizeToolSchemas(unittest.TestCase):
    def test_boolean_required_stripped_everywhere(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "provider_x",
                "description": "t",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "img_5": {"type": "string", "format": "uri", "required": False},
                        "nested": {"type": "object", "properties": {
                            "a": {"type": "string", "required": True}}},
                        "arr": {"type": "array", "items": {"type": "object", "required": "x"}},
                    },
                    "required": ["img_5"],
                },
            },
        }]
        out = _sanitize_tool_schemas(tools)
        self.assertFalse(_has_bool_required(out), "清洗后不应残留非法 required")
        # 合法的顶层 required 数组必须保留
        props = out[0]["function"]["parameters"]
        self.assertEqual(props.get("required"), ["img_5"])
        # 原对象不被修改（深拷贝）
        self.assertTrue(_has_bool_required(tools))

    def test_legal_and_empty_required_kept(self):
        tools = [{"type": "function", "function": {"name": "t", "description": "d",
                  "parameters": {"type": "object", "properties": {"a": {"type": "string"}},
                                 "required": []}}}]
        out = _sanitize_tool_schemas(tools)
        self.assertEqual(out[0]["function"]["parameters"]["required"], [])
        self.assertIsNone(_sanitize_tool_schemas(None))


class TestWorkflowProviderSchemaNoBoolRequired(unittest.TestCase):
    """工作流派生源的输入 schema 不得出现布尔 required（Agent 工具 schema 直接引用它）。"""

    def test_per_node_image_slot_without_bool_required(self):
        from app.providers.workflow import manager as m

        # 离线兜底：注入假 object_info 缓存位，避免测试触发网络探测
        m._OBJECT_INFO_CACHE = {}
        m._OBJECT_INFO_CACHE_TS = time.time()

        wf = {
            "5": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}, "_meta": {"title": "Body Reference"}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}, "_meta": {"title": "User Prompt"}},
            "9": {"class_type": "KSampler", "inputs": {"steps": 20, "cfg": 7.0, "sampler_name": "euler",
                                                       "scheduler": "normal", "denoise": 1.0, "seed": 1}, "_meta": {"title": "KSampler"}},
        }
        meta = {
            "exposed_source": "user",
            "exposed_inputs": [
                {"id": "img_5", "node_id": "5", "param_name": "image", "type": "image",
                 "label": "参考垫图 (Body Reference)", "required": False},
            ],
            "mapping": {"prompt_node": "6"},
        }
        _kind, input_schema, _ps, _os, exposed = m._build_provider_schemas_from_workflow(wf, meta)
        props = (input_schema or {}).get("properties") or {}
        self.assertIn("img_5", props, "图片槽应出现在输入 schema")
        self.assertFalse(_has_bool_required(input_schema), f"不得残留布尔 required: {props.get('img_5')}")
        self.assertNotIn("required", props.get("img_5") or {}, "槽位属性不得带 required 键")
        # 顶层 required 仍是合法数组
        self.assertIsInstance(input_schema.get("required"), list)


if __name__ == "__main__":
    unittest.main()
