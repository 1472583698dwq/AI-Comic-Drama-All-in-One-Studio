# -*- coding: utf-8 -*-
"""插件 v2 四域：域推导 + 脚手架生成。"""
import json
import os
import shutil
import tempfile
import unittest

from app.core.config import settings
from app.plugins import manager as pm
from app.plugins.models import domains_of, domain_counts


class TestPluginScaffold(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_plugin_scaffold_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_domains_from_legacy_extension_points(self):
        m = pm.validate_manifest_dict({
            "id": "domain-pack", "name": "Domain", "version": "1.0.0",
            "extensionPoints": {"themes": ["themes/*.json"],
                                 "agent_teams": ["teams/*.json"]},
        })
        self.assertEqual(domains_of(m.extensionPoints, m.domains), ["workspace", "agent"])
        self.assertEqual(domain_counts(m.extensionPoints),
                         {"workspace": 1, "agent": 1})

    def test_scaffold_creates_valid_v2_plugin(self):
        out = pm.scaffold_plugin("scaffold-pack", "骨架包", "workspace",
                                 description="测试脚手架", author="tester")
        self.assertEqual(out["status"], "scaffolded")
        pdir = os.path.join(settings.STORAGE_DIR, "plugins", "scaffold-pack")
        self.assertTrue(os.path.isfile(os.path.join(pdir, "plugin.json")))
        self.assertTrue(os.path.isfile(os.path.join(pdir, "README.md")))
        self.assertTrue(os.path.isfile(os.path.join(pdir, "examples", "workspace.md")))
        with open(os.path.join(pdir, "plugin.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["schema"], 2)
        self.assertEqual(data["domains"], ["workspace"])
        found = [p for p in pm.discover() if p["id"] == "scaffold-pack"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["domains"], ["workspace"])
        self.assertFalse(found[0]["enabled"])

    def test_scaffold_examples_are_valid_json(self):
        sample = pm._SCAFFOLD_EXAMPLES["capability"]
        block = sample.split("```json", 1)[1].split("```", 1)[0].strip()
        data = json.loads(block)
        self.assertEqual(data["provider_type"], "code")
        self.assertIn("async def generate", data["code"])

    def test_scaffold_rejects_duplicate_and_bad_id(self):
        pm.scaffold_plugin("dup-pack", "重复包", "agent")
        with self.assertRaises(ValueError):
            pm.scaffold_plugin("dup-pack", "重复包", "agent")
        with self.assertRaises(ValueError):
            pm.scaffold_plugin("../escape", "坏包", "agent")
        with self.assertRaises(ValueError):
            pm.scaffold_plugin("bad-domain", "坏域", "unknown")


if __name__ == "__main__":
    unittest.main()
