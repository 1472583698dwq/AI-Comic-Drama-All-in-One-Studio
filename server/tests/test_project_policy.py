# -*- coding: utf-8 -*-
"""项目级 Agent 权限与三模式回归。"""
import unittest

from app.agent.policy import permission_decision, policy_from_context, tool_group
from app.models.agent_policy import normalize_policy


class TestProjectPolicy(unittest.TestCase):
    def test_default_policy_is_safe_auto(self):
        p = normalize_policy({})
        self.assertEqual(p["execution_mode"], "auto")
        self.assertEqual(p["permissions"]["read"], "allow")
        self.assertEqual(p["permissions"]["generate"], "allow")
        self.assertEqual(p["permissions"]["write_project"], "allow")
        self.assertEqual(p["permissions"]["system"], "deny")

    def test_legacy_mode_aliases(self):
        self.assertEqual(normalize_policy({"execution_mode": "approve"})["execution_mode"], "auto")
        self.assertEqual(normalize_policy({"execution_mode": "create_auto"})["execution_mode"], "create")
        self.assertEqual(normalize_policy({"execution_mode": "plan_auto"})["execution_mode"], "plan")

    def test_project_policy_overrides_groups(self):
        p = normalize_policy({"permissions": {"system": "allow", "write_project": "deny"}})
        self.assertEqual(p["permissions"]["system"], "allow")
        self.assertEqual(p["permissions"]["write_project"], "deny")
        self.assertEqual(permission_decision("shell_exec", {}, "auto", p), "ask")
        self.assertEqual(permission_decision("canvas_create_node", {}, "auto", p), "deny")

    def test_auto_respects_allow_ask_deny(self):
        p = normalize_policy({})
        self.assertEqual(permission_decision("list_assets", {}, "auto", p), "allow")
        self.assertEqual(permission_decision("generate_image", {}, "auto", p), "allow")
        self.assertEqual(permission_decision("canvas_create_node", {}, "auto", p), "allow")
        self.assertEqual(permission_decision("register_custom_provider", {}, "auto", p), "ask")
        self.assertEqual(permission_decision("shell_exec", {}, "auto", p), "deny")

    def test_plan_is_readonly(self):
        p = normalize_policy({"permissions": {"write_project": "allow"}})
        self.assertEqual(permission_decision("list_assets", {}, "plan", p), "allow")
        self.assertEqual(permission_decision("canvas_create_node", {}, "plan", p), "deny")
        self.assertEqual(permission_decision("shell_exec", {}, "plan", p), "deny")

    def test_mode_switch_only_create_requires_approval(self):
        p = normalize_policy({})
        self.assertEqual(permission_decision("request_mode_switch", {"target": "create"}, "auto", p), "ask")
        self.assertEqual(permission_decision("request_mode_switch", {"target": "plan"}, "auto", p), "allow")
        self.assertEqual(permission_decision("request_mode_switch", {"target": "auto"}, "auto", p), "allow")

    def test_tool_groups(self):
        self.assertEqual(tool_group("generate_image"), "generate")
        self.assertEqual(tool_group("canvas_create_node"), "write_project")
        self.assertEqual(tool_group("register_custom_provider"), "admin")
        self.assertEqual(tool_group("subagent_run"), "delegate")
        self.assertEqual(tool_group("shell_exec"), "system")

    def test_context_policy_is_used(self):
        ctx = {"agent_policy": {"execution_mode": "plan", "permissions": {"read": "deny"}}}
        p = policy_from_context(ctx)
        self.assertEqual(p["execution_mode"], "plan")
        self.assertEqual(p["permissions"]["read"], "deny")


if __name__ == "__main__":
    unittest.main()
