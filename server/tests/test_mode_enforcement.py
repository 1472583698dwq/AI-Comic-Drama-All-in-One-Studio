# -*- coding: utf-8 -*-
"""运行模式代码门控回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_mode_enforcement -v
验收「模式靠代码约束，不靠提示词」：
- plan 只读白名单单一来源（mode_policy），绑定层与执行口共用同一对象；
- 强制计划预览（JSON Planner）已彻底移除，不存在遗留入口；
- 写工具不在只读白名单内。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestModeEnforcement(unittest.TestCase):
    def test_plan_whitelist_single_source(self):
        from app.agent import mode_policy
        from app.agent.tools import registry
        self.assertIs(registry.PLAN_READONLY_TOOLS, mode_policy.PLAN_READONLY_TOOLS)
        for tool in ("generate_image", "generate_video", "canvas_create_node",
                     "register_custom_provider", "shell_exec", "creator_finalize"):
            self.assertNotIn(tool, mode_policy.PLAN_READONLY_TOOLS)

    def test_planner_module_removed(self):
        import importlib
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("app.agent.planner")

    def test_forced_plan_preview_endpoint_removed(self):
        from app.api import routes
        paths = {getattr(r, "path", "") for r in routes.router.routes}
        self.assertNotIn("/agent/plan/preview", paths)


if __name__ == "__main__":
    unittest.main(verbosity=2)
