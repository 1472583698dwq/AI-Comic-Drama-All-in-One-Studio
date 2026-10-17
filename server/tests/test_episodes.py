# -*- coding: utf-8 -*-
"""分集管理（项目 → 分集 → 场/镜）回归测试。

覆盖：分集 CRUD / 场归属（assign/移出）/ 删除分集时场景去向 / auto_split 均分 /
模型 round-trip（episodes + Scene.episode_id 不丢）/ MCP 工具注册与分发。
"""
import os
import json
import shutil
import tempfile
import asyncio
import unittest

from app.core.config import settings
from app.providers.project import manager as proj_mod


class _EpisodeBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._orig_projects = proj_mod.PROJECTS_ROOT
        cls._tmp = tempfile.mkdtemp(prefix="ep_ops_")
        cls._projects = os.path.join(cls._tmp, "projects")
        os.makedirs(cls._projects, exist_ok=True)
        settings.STORAGE_DIR = cls._tmp
        proj_mod.PROJECTS_ROOT = cls._projects
        proj_mod._UUID_ID_MAP.clear()
        proj_mod._UUID_MAP_BUILT = False

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        proj_mod.PROJECTS_ROOT = cls._orig_projects
        proj_mod._UUID_ID_MAP.clear()
        proj_mod._UUID_MAP_BUILT = False
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        for entry in os.listdir(self._projects):
            p = os.path.join(self._projects, entry)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)

    def _mk_project(self, pid: str = "proj_ep", scenes: int = 5, shots_per_scene: int = 2):
        scenes_payload = []
        for i in range(1, scenes + 1):
            scenes_payload.append({
                "id": f"scene-{i}",
                "scene_index": i,
                "title": f"场景 {i}",
                "location": "", "time_of_day": "day", "atmosphere": "epic",
                "shots": [
                    {"id": f"shot-{i}-{j}", "shot_index": j, "scene_index": i, "action_desc": f"s{i}-{j}", "image_prompt": "x"}
                    for j in range(1, shots_per_scene + 1)
                ],
            })
        content = {"id": pid, "title": "分集测试", "scenes": scenes_payload, "characters": []}
        # 走 create_project 建 meta（save_content 依赖 index/meta 存在）
        meta = proj_mod.project_manager.create_project("分集测试", initial_content=content)
        return meta.get("id")


class TestEpisodeOps(_EpisodeBase):
    def test_create_list_assign_rename(self):
        from app.pipelines import episode_ops
        pid = self._mk_project(scenes=4)
        r = episode_ops.create_episode(pid, "序章")
        self.assertEqual(len(r["episodes"]), 1)
        self.assertEqual(r["episodes"][0]["title"], "序章")
        ep1 = r["episodes"][0]["id"]

        r = episode_ops.create_episode(pid)  # 默认标题
        self.assertEqual(r["episodes"][1]["title"], "第2集")
        ep2 = r["episodes"][1]["id"]

        r = episode_ops.assign_scenes(pid, [1, 2], ep1)
        self.assertEqual(r["assigned_scenes"], 2)
        r = episode_ops.assign_scenes(pid, [3], ep2)
        self.assertEqual(r["assigned_scenes"], 1)
        self.assertEqual(r["unassigned_scenes"], 1)
        # counts：ep1 2 场 4 镜
        e1 = next(e for e in r["episodes"] if e["id"] == ep1)
        self.assertEqual((e1["scene_count"], e1["shot_count"]), (2, 4))

        r = episode_ops.rename_episode(pid, ep1, "第一集·觉醒")
        self.assertEqual(next(e for e in r["episodes"] if e["id"] == ep1)["title"], "第一集·觉醒")

        # 移出分集
        r = episode_ops.assign_scenes(pid, [1], None)
        self.assertEqual(r["unassigned_scenes"], 2)

    def test_delete_episode_modes(self):
        from app.pipelines import episode_ops
        pid = self._mk_project(scenes=4)
        ep1 = episode_ops.create_episode(pid, "甲")["episodes"][0]["id"]
        ep2 = episode_ops.create_episode(pid, "乙")["episodes"][1]["id"]
        episode_ops.assign_scenes(pid, [1, 2], ep1)
        episode_ops.assign_scenes(pid, [3], ep2)
        # 删除 ep2：场 3 变未分集
        r = episode_ops.delete_episode(pid, ep2)
        self.assertEqual(len(r["episodes"]), 1)
        self.assertEqual(r["unassigned_scenes"], 2)  # 场3 + 场4
        # 删除 ep1 并转入...只剩一个分集，先再建一个
        ep3 = episode_ops.create_episode(pid, "丙")["episodes"][-1]["id"]
        r = episode_ops.delete_episode(pid, ep1, move_to=ep3)
        self.assertEqual(r["scenes_moved"], 2)
        content = proj_mod.project_manager.get_content(pid)
        by_idx = {s["scene_index"]: s.get("episode_id") for s in content["scenes"]}
        self.assertEqual(by_idx[1], ep3)
        self.assertEqual(by_idx[2], ep3)
        self.assertIsNone(by_idx[3])

    def test_auto_split_even_distribution(self):
        from app.pipelines import episode_ops
        pid = self._mk_project(scenes=7, shots_per_scene=1)
        r = episode_ops.auto_split(pid, 3)
        self.assertEqual([e["title"] for e in r["episodes"]], ["第1集", "第2集", "第3集"])
        self.assertEqual([e["scene_count"] for e in r["episodes"]], [3, 2, 2])
        self.assertEqual(r["unassigned_scenes"], 0)
        self.assertEqual(r["scenes_total"], 7)
        # 重建式：再来一次 2 集
        r2 = episode_ops.auto_split(pid, 2)
        self.assertEqual(len(r2["episodes"]), 2)
        self.assertEqual([e["scene_count"] for e in r2["episodes"]], [4, 3])

    def test_validation_errors(self):
        from app.pipelines import episode_ops
        pid = self._mk_project(scenes=3)
        with self.assertRaises(ValueError):
            episode_ops.auto_split(pid, 0)
        with self.assertRaises(ValueError):
            episode_ops.auto_split(pid, 9)
        with self.assertRaises(ValueError):
            episode_ops.assign_scenes(pid, [1], "ep_missing")
        with self.assertRaises(ValueError):
            episode_ops.assign_scenes(pid, [], None)
        with self.assertRaises(ValueError):
            episode_ops.rename_episode(pid, "ep_missing", "x")
        with self.assertRaises(ValueError):
            episode_ops.delete_episode(pid, "ep_missing")
        ep1 = episode_ops.create_episode(pid)["episodes"][0]["id"]
        with self.assertRaises(ValueError):
            episode_ops.delete_episode(pid, ep1, move_to=ep1)
        with self.assertRaises(ValueError):
            episode_ops.list_episodes("proj_nonexist")

    def test_model_roundtrip_preserves_episodes(self):
        from app.models.schemas import Project
        pid = self._mk_project(scenes=2)
        from app.pipelines import episode_ops
        ep = episode_ops.create_episode(pid, "第一集")["episodes"][0]["id"]
        episode_ops.assign_scenes(pid, [1], ep)
        content = proj_mod.project_manager.get_content(pid)
        proj = Project.model_validate(content)
        dumped = proj.model_dump()
        self.assertEqual(len(dumped["episodes"]), 1)
        self.assertEqual(dumped["episodes"][0]["title"], "第一集")
        self.assertEqual(dumped["scenes"][0]["episode_id"], ep)
        self.assertIsNone(dumped["scenes"][1].get("episode_id"))


class TestEpisodeMcp(_EpisodeBase):
    def test_tool_registered_and_dispatch(self):
        from app.mcp.server import mcp_registry
        names = {t.name for t in mcp_registry.get_all_tools()}
        self.assertIn("episode_manage", names)
        from app.agent.mode_policy import TOOL_RISK
        self.assertEqual(TOOL_RISK.get("episode_manage"), "medium")

        pid = self._mk_project(scenes=4)
        res = asyncio.run(mcp_registry.execute_tool("episode_manage", {"action": "auto_split", "project_id": pid, "count": 2}))
        self.assertEqual(res.status, "success", res.error)
        eps = res.result["episodes"]
        self.assertEqual(len(eps), 2)
        # assign 未分集 → 空 episode_id
        res2 = asyncio.run(mcp_registry.execute_tool("episode_manage", {"action": "assign", "project_id": pid, "episode_id": "", "scene_indices": [1]}))
        self.assertEqual(res2.status, "success", res2.error)
        self.assertGreaterEqual(res2.result["unassigned_scenes"], 1)
        # 未知 action → 报错
        res3 = asyncio.run(mcp_registry.execute_tool("episode_manage", {"action": "explode", "project_id": pid}))
        self.assertEqual(res3.status, "error")


if __name__ == "__main__":
    unittest.main()
