# -*- coding: utf-8 -*-
"""插件 manifest v2 四域 -> 内部 extensionPoints 的兼容归一。"""
import unittest

from app.plugins.manager import validate_manifest_dict


class TestPluginManifestV2(unittest.TestCase):
    def test_four_domains_map_to_legacy_extension_points(self):
        m = validate_manifest_dict({
            "schema": 2,
            "id": "acme-pack",
            "name": "Acme",
            "version": "2.0.0",
            "contributes": {
                "capability": {
                    "providers": ["providers/*.json"],
                    "workflows": ["workflows/*.json"],
                    "tools": ["tools/*.py"],
                },
                "canvas": {
                    "nodes": ["canvas/*.json"],
                    "codeNodes": ["code/*.py"],
                },
                "workspace": {
                    "slots": ["slots/*.json"],
                    "themes": ["themes/*.json"],
                    "exporters": ["exporters/*.json"],
                    "directorPacks": ["director_packs/*.json"],
                },
                "agent": {
                    "skills": ["skills/*/SKILL.md"],
                    "profiles": ["agent_profiles/*.json"],
                    "teams": ["agent_teams/*.json"],
                },
            },
        })
        eps = m.extensionPoints
        self.assertEqual(eps.providers, ["providers/*.json"])
        self.assertEqual(eps.workflows, ["workflows/*.json"])
        self.assertEqual(eps.mcp_tools, ["tools/*.py"])
        self.assertEqual(eps.canvas_nodes, ["canvas/*.json"])
        self.assertEqual(eps.custom_nodes, ["code/*.py"])
        self.assertEqual(eps.storyboard_slots, ["slots/*.json"])
        self.assertEqual(eps.themes, ["themes/*.json"])
        self.assertEqual(eps.exporters, ["exporters/*.json"])
        self.assertEqual(eps.director_packs, ["director_packs/*.json"])
        self.assertEqual(eps.skills, ["skills/*/SKILL.md"])
        self.assertEqual(eps.agent_profiles, ["agent_profiles/*.json"])
        self.assertEqual(eps.agent_teams, ["agent_teams/*.json"])

    def test_v1_manifest_unchanged(self):
        m = validate_manifest_dict({
            "id": "legacy-pack",
            "name": "Legacy",
            "version": "1.0.0",
            "extensionPoints": {"themes": ["themes/*.json"]},
        })
        self.assertEqual(m.extensionPoints.themes, ["themes/*.json"])


if __name__ == "__main__":
    unittest.main()
