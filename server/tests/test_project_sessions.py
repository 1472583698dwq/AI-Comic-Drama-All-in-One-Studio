# -*- coding: utf-8 -*-
"""Agent 会话整文件保存：并发写不互相破坏，scope 合并不丢失。"""
import json
import os
import shutil
import tempfile
import threading
import unittest

from app.providers.project import manager as pm


class TestAgentSessionSave(unittest.TestCase):
    def setUp(self):
        self._root = pm.PROJECTS_ROOT
        self._index = pm.INDEX_PATH
        self.tmp = tempfile.mkdtemp(prefix="session_save_test_")
        pm.PROJECTS_ROOT = os.path.join(self.tmp, "projects")
        pm.INDEX_PATH = os.path.join(pm.PROJECTS_ROOT, "index.json")
        os.makedirs(os.path.join(pm.PROJECTS_ROOT, "proj_test"), exist_ok=True)

    def tearDown(self):
        pm.PROJECTS_ROOT = self._root
        pm.INDEX_PATH = self._index
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _path(self):
        return os.path.join(pm.PROJECTS_ROOT, "proj_test", "agent_sessions.json")

    def test_concurrent_saves_keep_file_valid(self):
        errors = []

        def writer(i):
            try:
                pm.project_manager.save_agent_sessions(
                    "proj_test",
                    [{"id": f"s{i}", "messages": [{"id": f"m{i}", "text": "x" * 2000}]}],
                    scope="page",
                )
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(24)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        with open(self._path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 1)
        self.assertTrue(data[0]["id"].startswith("s"))
        leftovers = [n for n in os.listdir(os.path.dirname(self._path())) if ".tmp." in n]
        self.assertEqual(leftovers, [])

    def test_scope_writes_are_merged(self):
        pm.project_manager.save_agent_sessions(
            "proj_test", [{"id": "page-1", "messages": []}], scope="page")
        pm.project_manager.save_agent_sessions(
            "proj_test", [{"id": "float-1", "messages": []}], scope="float")
        page = pm.project_manager.get_agent_sessions("proj_test", scope="page")
        float_ = pm.project_manager.get_agent_sessions("proj_test", scope="float")
        self.assertEqual([s["id"] for s in page], ["page-1"])
        self.assertEqual([s["id"] for s in float_], ["float-1"])


if __name__ == "__main__":
    unittest.main()
