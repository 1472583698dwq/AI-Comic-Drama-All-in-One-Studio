# -*- coding: utf-8 -*-
"""导演 Agent 工具分级的回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_provider_risk_and_identity -v

覆盖三处修复：
1. ``tool_risk`` 对 ``provider_<id>`` 按 kind 分流（视频源 → high），
   而不是此前恒返回 medium（注释写了 video→high，代码没实现）；
2. ``list_custom_nodes`` 从「只读白名单里的死条目」变成真实注册的只读工具；
3. 系统提示 IDENTITY 使用通用角色名「视频创造导演」，不再自称「AI漫剧导演 Agent」。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestProviderRiskByKind(unittest.TestCase):
    """:func:`app.agent.mode_policy.tool_risk` 的 provider_* 分流。"""

    def setUp(self):
        from app.agent import mode_policy
        self.policy = mode_policy

    def test_video_provider_is_high(self):
        # prov_e3a19229 = AutoDL H3 文生视频（video），示例源存在与否都不影响断言口径：
        # 这里直接验证「kind=video → high」这条规则本身。
        kinds = {}

        def fake_kind(name):
            return kinds.get(name, "")

        original = self.policy._provider_kind
        self.policy._provider_kind = fake_kind
        try:
            kinds["provider_demo_video"] = "video"
            kinds["provider_demo_image"] = "image"
            kinds["provider_demo_audio"] = "audio"
            self.assertEqual(self.policy.tool_risk("provider_demo_video"), "high")
            self.assertEqual(self.policy.tool_risk("provider_demo_image"), "medium")
            self.assertEqual(self.policy.tool_risk("provider_demo_audio"), "medium")
            # kind 解析不出来时保守留 medium，不误升
            self.assertEqual(self.policy.tool_risk("provider_demo_unknown"), "medium")
        finally:
            self.policy._provider_kind = original

    def test_explicit_table_wins_over_prefix(self):
        # provider_key_status 复用 provider_ 前缀，但必须按显式表定级（low）
        self.assertEqual(self.policy.tool_risk("provider_key_status"), "low")

    def test_kind_resolution_handles_blank(self):
        # 非 provider_ 前缀 / 空 id 不抛异常，返回空串
        self.assertEqual(self.policy._provider_kind(""), "")
        self.assertEqual(self.policy._provider_kind("generate_image"), "")
        self.assertEqual(self.policy._provider_kind("provider_"), "")

    def test_video_provider_requires_confirm_in_approve_mode(self):
        original = self.policy._provider_kind
        self.policy._provider_kind = lambda name: "video"
        try:
            self.assertTrue(self.policy.requires_confirm("provider_demo_video", "approve"))
            # 自动执行模式一律直跑（风险由前端危险态兜底）
            self.assertFalse(self.policy.requires_confirm("provider_demo_video", "auto"))
        finally:
            self.policy._provider_kind = original


class TestListCustomNodesTool(unittest.TestCase):
    """``list_custom_nodes`` 必须是真实注册的只读工具，而不是白名单里的死条目。"""

    def test_registered_and_readonly(self):
        from app.agent import mode_policy
        from app.mcp.server import mcp_registry

        names = {t.name for t in mcp_registry.get_all_tools()}
        self.assertIn("list_custom_nodes", names)
        # 白名单 / 风险表 / 并行安全集三处口径必须一致
        self.assertIn("list_custom_nodes", mode_policy.PLAN_READONLY_TOOLS)
        self.assertEqual(mode_policy.tool_risk("list_custom_nodes"), "low")

    def test_plan_mode_schema_includes_it(self):
        from app.agent.tools.registry import tool_view
        names = {s["function"]["name"] for s in tool_view.schemas(plan_mode=True)}
        self.assertIn("list_custom_nodes", names)

    def test_execute_returns_metadata_only(self):
        import asyncio
        from app.mcp.server import mcp_registry

        resp = asyncio.run(mcp_registry.execute_tool("list_custom_nodes", {}))
        self.assertEqual(resp.status, "success", resp.error)
        res = resp.result or {}
        self.assertIn("nodes", res)
        self.assertIn("total", res)
        for node in res.get("nodes") or []:
            # 只回元信息：不允许把代码正文带进对话上下文
            self.assertNotIn("code", node)
            self.assertEqual(node.get("mcp_tool"), f"customnode_{node['id']}")


class TestIdentityIsGeneric(unittest.TestCase):
    """系统提示 IDENTITY 用通用角色名。"""

    def test_identity_generic(self):
        from app.agent.runtime import prompt
        self.assertIn("视频创造导演", prompt.IDENTITY)
        self.assertNotIn("AI漫剧导演 Agent", prompt.IDENTITY)

    def test_assembled_prompt_has_no_old_identity(self):
        from app.agent.runtime.prompt import build_system_prompt
        text = build_system_prompt()
        self.assertTrue(text.startswith("你是「视频创造导演」"), text[:60])
        self.assertNotIn("AI漫剧导演 Agent", text)


if __name__ == "__main__":
    unittest.main()
