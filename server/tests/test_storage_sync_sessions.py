# -*- coding: utf-8 -*-
"""会话保存与云端同步的竞态：上传读取不能阻塞本地原子替换。"""
import asyncio
import json
import os
import shutil
import tempfile
import unittest

from app.core.config import settings
from app.providers.project import manager as pm
from app.storage_sync.mirror import StorageMirror


class _FakeClient:
    def __init__(self):
        self.started = asyncio.Event()
        self.payload = b""

    async def put(self, remote, path):
        with open(path, "rb") as f:
            self.payload = f.read()
        self.started.set()
        await asyncio.sleep(0.25)

    async def list_dir(self, path, **kwargs):
        return []

    async def remove(self, path):
        return None

    async def stat(self, path):
        return None


class TestStorageSyncSessionRace(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._root = pm.PROJECTS_ROOT
        self._index = pm.INDEX_PATH
        self._storage = settings.STORAGE_DIR
        self.tmp = tempfile.mkdtemp(prefix="sync_session_race_")
        settings.STORAGE_DIR = self.tmp
        pm.PROJECTS_ROOT = os.path.join(self.tmp, "projects")
        pm.INDEX_PATH = os.path.join(pm.PROJECTS_ROOT, "index.json")
        os.makedirs(os.path.join(pm.PROJECTS_ROOT, "proj_race"), exist_ok=True)

    def tearDown(self):
        settings.STORAGE_DIR = self._storage
        pm.PROJECTS_ROOT = self._root
        pm.INDEX_PATH = self._index
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_upload_snapshot_does_not_block_local_save(self):
        pm.project_manager.save_agent_sessions(
            "proj_race", [{"id": "before", "messages": []}], scope="page")
        mirror = StorageMirror()
        client = _FakeClient()
        mirror.client = client
        mirror.root = "/state"
        task = asyncio.create_task(
            mirror._upload_one("projects/proj_race/agent_sessions.json"))
        await asyncio.wait_for(client.started.wait(), timeout=3)
        # 上传正在读快照时，本地保存仍必须成功（旧实现会因目标文件被占用而 500）。
        pm.project_manager.save_agent_sessions(
            "proj_race", [{"id": "after", "messages": []}], scope="page")
        await asyncio.wait_for(task, timeout=5)
        uploaded = json.loads(client.payload.decode("utf-8"))
        self.assertEqual(uploaded[0]["id"], "before")
        current = pm.project_manager.get_agent_sessions("proj_race", scope="page")
        self.assertEqual(current[0]["id"], "after")
        self.assertEqual(
            [n for n in os.listdir(os.path.dirname(os.path.join(
                pm.PROJECTS_ROOT, "proj_race", "agent_sessions.json")))
             if n.startswith(".sync-")],
            [],
        )


if __name__ == "__main__":
    unittest.main()
