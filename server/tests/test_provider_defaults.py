# -*- coding: utf-8 -*-
"""生成源默认插槽回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_defaults -v
约定：尾帧(last_frame)不再作为默认插槽自动挂出——只有真正支持尾帧的源自行声明
（Kling/Seedance/Wan3/MiniMax H3 等内置源仍在各自 schema 里声明）。
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestProviderDefaults(unittest.TestCase):
    def test_video_default_has_no_last_frame(self):
        from app.api.provider_routes import _default_input_schema
        props = _default_input_schema("video")["properties"]
        self.assertNotIn("last_frame", props)
        for k in ("prompt", "first_frame", "reference_images", "reference_audios"):
            self.assertIn(k, props)

    def test_defaults_do_not_add_last_frame_for_any_kind(self):
        from app.api.provider_routes import _default_input_schema
        for kind in ("image", "video", "audio", "utility"):
            props = _default_input_schema(kind).get("properties") or {}
            self.assertNotIn("last_frame", props, f"{kind} 默认不应含尾帧插槽")

    def test_workflow_video_schema_has_no_default_last_frame(self):
        from app.providers.workflow.manager import _build_provider_schemas_from_workflow
        with mock.patch("app.providers.workflow.manager._detect_workflow_kind", return_value="video"):
            result = _build_provider_schemas_from_workflow({"nodes": [], "links": []}, None)
        input_schema = result[1]
        props = (input_schema or {}).get("properties") or {}
        self.assertNotIn("last_frame", props)
        self.assertIn("first_frame", props)


if __name__ == "__main__":
    unittest.main(verbosity=2)
