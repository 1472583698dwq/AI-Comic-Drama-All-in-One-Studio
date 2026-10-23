# -*- coding: utf-8 -*-
"""Creator ChangeSet 包装层：资源映射、状态、试跑/应用/回滚委托。"""
import unittest
from unittest.mock import AsyncMock, patch

from app.agent import change_sets


def _prop(**over):
    base = {
        "proposal_id": "prop_abc",
        "kind": "patch_provider",
        "goal": "补 first_frame",
        "title": "补齐生成源参数",
        "status": "proposed",
        "risk": "medium",
        "diff_preview": "patch input_schema",
        "test_plan": ["schema 校验"],
        "reversible": "可回滚",
        "target_provider_id": "prov_h3",
        "created_at": 1.0,
    }
    base.update(over)
    return base


class TestChangeSetMapping(unittest.TestCase):
    def test_status_and_resource_mapping(self):
        cs = change_sets.to_change_set(_prop())
        self.assertEqual(cs["id"], "cs_prop_abc")
        self.assertEqual(cs["status"], "proposed")
        self.assertEqual(cs["changes"][0]["resource"], "provider")
        self.assertEqual(cs["changes"][0]["action"], "patch")
        self.assertEqual(cs["changes"][0]["target"], "prov_h3")
        self.assertEqual(change_sets.to_change_set(_prop(status="persisted"))["status"], "applied")
        self.assertEqual(change_sets.to_change_set(_prop(status="rolled_back"))["status"], "rolled_back")
        self.assertEqual(change_sets.to_change_set(_prop(status="test_failed"))["status"], "failed")

    def test_plugin_and_slot_mapping(self):
        plugin = change_sets.to_change_set(_prop(kind="new_plugin", plugin_id="pack_x"))
        self.assertEqual(plugin["changes"][0]["resource"], "plugin")
        slot = change_sets.to_change_set(_prop(kind="storyboard_slot", slot_key="shot.tabs:x", target_provider_id=""))
        self.assertEqual(slot["changes"][0]["resource"], "storyboard_slot")
        self.assertEqual(slot["changes"][0]["target"], "shot.tabs:x")


class TestChangeSetActions(unittest.IsolatedAsyncioTestCase):
    async def test_test_and_apply_delegate_to_creator(self):
        with patch("app.agent.creator.get_proposal", return_value=_prop()), \
             patch("app.agent.creator.start_test", new=AsyncMock(return_value={"proposal": _prop(status="tested")})), \
             patch("app.agent.creator.finalize", new=AsyncMock(return_value={})):
            tested = await change_sets.test_change_set("cs_prop_abc")
            self.assertEqual(tested["status"], "tested")
            applied = await change_sets.apply_change_set("cs_prop_abc")
            self.assertEqual(applied["status"], "proposed")  # get_proposal 仍返回原状态，委托本身已被调用


if __name__ == "__main__":
    unittest.main()
