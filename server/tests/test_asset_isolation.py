"""素材库分级隔离与共享（P0/P1）测试。

覆盖：可见性矩阵 / 写防护 / 统计项目口径 / 归属不变式 / 发布与收回 /
共享目标归一 / 引用检查 / 删除墓碑 / 双 ID（UUID→proj 目录名）归一。
"""
import os
import json
import shutil
import tempfile
import unittest

from app.core.config import settings
from app.providers.asset import manager as asset_mod
from app.providers.project import manager as proj_mod


class _AssetIsolationBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="asset_iso_")
        cls._orig = (settings.STORAGE_DIR, asset_mod.ASSETS_ROOT, asset_mod.TOMBSTONES,
                     asset_mod.MISSING_BACKUP, proj_mod.PROJECTS_ROOT, dict(proj_mod._UUID_ID_MAP),
                     proj_mod._UUID_MAP_BUILT, asset_mod.AssetManager._missing_swept)
        assets_root = os.path.join(cls._tmp, "assets")
        projects_root = os.path.join(cls._tmp, "projects")
        os.makedirs(assets_root, exist_ok=True)
        os.makedirs(projects_root, exist_ok=True)
        settings.STORAGE_DIR = cls._tmp
        asset_mod.ASSETS_ROOT = assets_root
        asset_mod.TOMBSTONES = os.path.join(assets_root, ".tombstones.jsonl")
        asset_mod.MISSING_BACKUP = os.path.join(assets_root, ".missing_backup.jsonl")
        proj_mod.PROJECTS_ROOT = projects_root
        proj_mod._UUID_ID_MAP.clear()
        proj_mod._UUID_MAP_BUILT = False
        asset_mod.AssetManager._missing_swept = True  # 测试里不做悬空清扫

    @classmethod
    def tearDownClass(cls):
        (settings.STORAGE_DIR, asset_mod.ASSETS_ROOT, asset_mod.TOMBSTONES,
         asset_mod.MISSING_BACKUP, proj_mod.PROJECTS_ROOT, saved_map,
         proj_mod._UUID_MAP_BUILT, asset_mod.AssetManager._missing_swept) = cls._orig
        proj_mod._UUID_ID_MAP.clear()
        proj_mod._UUID_ID_MAP.update(saved_map)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        # 每个用例清空素材与项目目录
        for entry in os.listdir(asset_mod.ASSETS_ROOT):
            p = os.path.join(asset_mod.ASSETS_ROOT, entry)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
        for entry in os.listdir(proj_mod.PROJECTS_ROOT):
            p = os.path.join(proj_mod.PROJECTS_ROOT, entry)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
        proj_mod._UUID_ID_MAP.clear()
        proj_mod._UUID_MAP_BUILT = False
        self.mgr = asset_mod.AssetManager()

    # ---- helpers ----
    def _make_project(self, dir_id: str, content_uuid: str = None):
        pdir = os.path.join(proj_mod.PROJECTS_ROOT, dir_id)
        os.makedirs(pdir, exist_ok=True)
        content = {"id": content_uuid or dir_id, "name": dir_id, "scenes": []}
        with open(os.path.join(pdir, "content.json"), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False)
        proj_mod._UUID_MAP_BUILT = False
        return dir_id

    def _mk(self, **kw):
        data = {"name": kw.pop("name", "t"), "category": kw.pop("category", "prop")}
        data.update(kw)
        return self.mgr.create_asset(data)


class TestVisibility(_AssetIsolationBase):
    def test_visibility_matrix(self):
        g = self._mk(name="global", scope="global")
        a1 = self._mk(name="p1-owned", scope="project", project_id="proj_p1")
        a2 = self._mk(name="p2-shared-to-p1", scope="project", project_id="proj_p2", shared_to=["proj_p1"])
        a3 = self._mk(name="p2-private", scope="project", project_id="proj_p2")

        res = self.mgr.list_assets(project_id="proj_p1", limit=50)
        names = {a["name"] for a in res["assets"]}
        self.assertEqual(names, {"global", "p1-owned", "p2-shared-to-p1"})

        res = self.mgr.list_assets(project_id="proj_p1", include_shared=False, limit=50)
        names = {a["name"] for a in res["assets"]}
        self.assertEqual(names, {"p1-owned"})

        res = self.mgr.list_assets(project_id="proj_p1", scope="global", limit=50)
        names = {a["name"] for a in res["assets"]}
        self.assertEqual(names, {"global"})

        res = self.mgr.list_assets(project_id="proj_p1", scope="shared", limit=50)
        names = {a["name"] for a in res["assets"]}
        self.assertEqual(names, {"p2-shared-to-p1"})

        res = self.mgr.list_assets(limit=50)
        self.assertEqual(res["total"], 4)
        self.assertIn(g.id, {a["id"] for a in res["assets"]})
        self.assertIn(a3.id, {a["id"] for a in res["assets"]})

    def test_legacy_orphan_visible_without_disk_mutation(self):
        # 历史悬空数据：scope=project 且无归属 → 兼容可见，但不写盘改成 global
        a = self._mk(name="orphan", scope="project")
        self.assertEqual(a.scope, "global")  # create 层不变式已收口
        # 手动构造磁盘上的孤儿 meta
        a.scope = "project"
        a.project_id = None
        asset_mod._save_asset(a)
        res = self.mgr.list_assets(project_id="proj_any", limit=50)
        self.assertEqual(res["total"], 1)
        reloaded = self.mgr.get_asset(a.id)
        self.assertEqual(reloaded.scope, "project")  # 读路径不再静默改为 global


class TestWriteGuard(_AssetIsolationBase):
    def test_writable_by(self):
        p1 = self._mk(name="p1", scope="project", project_id="proj_p1")
        p2shared = self._mk(name="shared", scope="project", project_id="proj_p2", shared_to=["proj_p1"])
        g_legacy = self._mk(name="g-legacy", scope="global")
        g_origin = self._mk(name="g-origin", scope="global", project_id="proj_p2")

        self.assertTrue(self.mgr.writable_by(p1, "proj_p1"))
        self.assertFalse(self.mgr.writable_by(p1, "proj_p2"))
        self.assertFalse(self.mgr.writable_by(p2shared, "proj_p1"))  # 共享给我=只读
        self.assertTrue(self.mgr.writable_by(g_legacy, "proj_p1"))  # 旧全局无出生项目→兼容
        self.assertFalse(self.mgr.writable_by(g_origin, "proj_p1"))
        self.assertTrue(self.mgr.writable_by(g_origin, "proj_p2"))
        self.assertTrue(self.mgr.writable_by(p1, None))  # 无上下文兼容放行


class TestOwnershipInvariants(_AssetIsolationBase):
    def test_create_project_without_owner_becomes_global(self):
        a = self._mk(name="x", scope="project")
        self.assertEqual(a.scope, "global")
        self.assertIsNone(a.project_id)

    def test_create_global_from_project_records_origin(self):
        self._make_project("proj_src")
        a = self._mk(name="x", scope="global", project_id="proj_src")
        self.assertEqual(a.scope, "global")
        self.assertIsNone(a.project_id)
        self.assertEqual(a.origin_project_id, "proj_src")

    def test_update_clearing_owner_promotes_to_global(self):
        a = self._mk(name="x", scope="project", project_id="proj_p1")
        self.mgr.update_asset(a.id, {"project_id": None})
        reloaded = self.mgr.get_asset(a.id)
        self.assertEqual(reloaded.scope, "global")
        self.assertIsNone(reloaded.project_id)

    def test_uuid_resolves_to_project_dir(self):
        self._make_project("proj_abc", content_uuid="11111111-2222-3333-4444-555555555555")
        a = self._mk(name="x", scope="project", project_id="11111111-2222-3333-4444-555555555555")
        self.assertEqual(a.project_id, "proj_abc")
        self.assertEqual(a.origin_project_id, "proj_abc")
        res = self.mgr.list_assets(project_id="11111111-2222-3333-4444-555555555555", limit=50)
        self.assertEqual(res["total"], 1)


class TestPublishUnpublish(_AssetIsolationBase):
    def test_publish_and_unpublish(self):
        self._make_project("proj_p1")
        a = self._mk(name="hero", scope="project", project_id="proj_p1", shared_to=["proj_other"])
        pub = self.mgr.publish_asset(a.id, actor_project_id="proj_p1")
        self.assertEqual(pub.scope, "global")
        self.assertIsNone(pub.project_id)
        self.assertEqual(pub.origin_project_id, "proj_p1")
        self.assertEqual(pub.shared_to, [])
        self.assertTrue(pub.published_at)

        # 非出生项目不能收回
        with self.assertRaises(PermissionError):
            self.mgr.unpublish_asset(a.id, actor_project_id="proj_p2")
        back = self.mgr.unpublish_asset(a.id, actor_project_id="proj_p1")
        self.assertEqual(back.scope, "project")
        self.assertEqual(back.project_id, "proj_p1")
        self.assertIsNone(back.published_at)

    def test_publish_other_project_denied(self):
        a = self._mk(name="x", scope="project", project_id="proj_p1")
        with self.assertRaises(PermissionError):
            self.mgr.publish_asset(a.id, actor_project_id="proj_p2")

    def test_unpublish_requires_origin(self):
        g = self._mk(name="legacy-global", scope="global")
        with self.assertRaises(PermissionError):
            self.mgr.unpublish_asset(g.id, actor_project_id="proj_p1")


class TestReferencesAndDelete(_AssetIsolationBase):
    def test_find_references_and_tombstone(self):
        self._make_project("proj_a")
        self._make_project("proj_b")
        a = self._mk(name="used", scope="project", project_id="proj_a")
        # 在 proj_b 的 content.json 里引用
        p = os.path.join(proj_mod.PROJECTS_ROOT, "proj_b", "content.json")
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        data["scenes"] = [{"shots": [{"image_url": f"/storage/assets/{a.id}/original.png"}]}]
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

        refs = self.mgr.find_references(a.id)
        self.assertEqual([r["project_id"] for r in refs], ["proj_b"])

        ok = self.mgr.delete_asset(a.id)
        self.assertTrue(ok)
        self.assertIsNone(self.mgr.get_asset(a.id))
        self.assertTrue(os.path.exists(asset_mod.TOMBSTONES))
        with open(asset_mod.TOMBSTONES, encoding="utf-8") as f:
            line = f.read().strip().splitlines()[-1]
        self.assertEqual(json.loads(line)["id"], a.id)


class TestStatsAndShare(_AssetIsolationBase):
    def test_stats_project_scoped(self):
        self._mk(name="g", scope="global")
        self._mk(name="mine", scope="project", project_id="proj_p1")
        self._mk(name="shared", scope="project", project_id="proj_p2", shared_to=["proj_p1"])
        self._mk(name="other", scope="project", project_id="proj_p3")

        s_all = self.mgr.get_stats()
        self.assertEqual(s_all["total"], 4)
        s_p1 = self.mgr.get_stats(project_id="proj_p1")
        self.assertEqual(s_p1["total"], 3)
        self.assertEqual(s_p1["owned"], 1)
        self.assertEqual(s_p1["shared_to_me"], 1)
        tags = self.mgr.search_tags(project_id="proj_p1")
        self.assertIsInstance(tags, list)

    def test_duplicate_clears_share_state(self):
        a = self._mk(name="src", scope="project", project_id="proj_p1", shared_to=["proj_p2"])
        dup = self.mgr.duplicate_asset(a.id)
        self.assertEqual(dup.shared_to, [])
        self.assertIsNone(dup.published_at)
        self.assertEqual(dup.extra.get("derived_from"), a.id)

    def test_shared_targets_normalized(self):
        self._make_project("proj_abc", content_uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        a = self._mk(name="x", scope="project", project_id="proj_p1",
                     shared_to=["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "proj_p1", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])
        self.assertEqual(a.shared_to, ["proj_abc", "proj_p1"])


class TestRoutesHTTP(_AssetIsolationBase):
    """路由层（直接调用异步处理函数）：发布/收回/共享/批量/安全删除。"""

    def _call(self, coro):
        import asyncio
        return asyncio.run(coro)

    def test_publish_unpublish_share_batch_delete(self):
        from fastapi import HTTPException
        from app.api.asset_routes import (
            publish_asset, unpublish_asset, share_asset, batch_share_assets, delete_asset, copy_asset,
        )
        self._make_project("proj_a")
        self._make_project("proj_b")
        a = self._mk(name="hero", scope="project", project_id="proj_a")

        # 共享到不存在项目 → 400
        with self.assertRaises(HTTPException) as ctx:
            self._call(share_asset(a.id, {"target_project_ids": ["proj_missing"], "project_id": "proj_a"}))
        self.assertEqual(ctx.exception.status_code, 400)

        # 定向共享到 proj_b
        res = self._call(share_asset(a.id, {"target_project_ids": ["proj_b"], "project_id": "proj_a"}))
        self.assertEqual(res.shared_to, ["proj_b"])
        # proj_b 可见、只读（writable_by=False）
        self.assertTrue(self.mgr.visible_to(self.mgr.get_asset(a.id), "proj_b"))
        self.assertFalse(self.mgr.writable_by(self.mgr.get_asset(a.id), "proj_b"))

        # 发布到全局（actor=proj_a）
        pub = self._call(publish_asset(a.id, {"project_id": "proj_a"}))
        self.assertEqual(pub.scope, "global")
        self.assertEqual(pub.origin_project_id, "proj_a")
        # 其他项目发布他人素材 → 403
        b = self._mk(name="b-prop", scope="project", project_id="proj_b")
        with self.assertRaises(HTTPException) as ctx2:
            self._call(publish_asset(b.id, {"project_id": "proj_a"}))
        self.assertEqual(ctx2.exception.status_code, 403)

        # 收回：无跨项目引用 → 直接成功
        back = self._call(unpublish_asset(a.id, {"project_id": "proj_a"}))
        self.assertEqual(back.scope, "project")
        self.assertEqual(back.project_id, "proj_a")

        # 批量发布（actor=proj_a 的 a + b 应分成功/失败）
        batch = self._call(batch_share_assets({"asset_ids": [a.id, b.id], "scope": "global", "project_id": "proj_a"}))
        self.assertEqual(batch["shared"], 1)
        self.assertEqual(batch["failed"], 1)

        # 删除被引用素材 → 409（引用在 proj_b），force 后成功
        p = os.path.join(proj_mod.PROJECTS_ROOT, "proj_b", "content.json")
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        data["scenes"] = [{"shots": [{"image_url": f"/storage/assets/{b.id}/original.png"}]}]
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        with self.assertRaises(HTTPException) as ctx3:
            self._call(delete_asset(b.id, project_id="proj_b", force=False))
        self.assertEqual(ctx3.exception.status_code, 409)
        out = self._call(delete_asset(b.id, project_id="proj_b", force=True))
        self.assertEqual(out["status"], "deleted")

        # 复制到项目：目标不存在 → 400；正常复制清空共享/发布态、出生项目=目标
        with self.assertRaises(HTTPException):
            self._call(copy_asset(a.id, {"target_project_id": "proj_missing"}))
        dup = self._call(copy_asset(a.id, {"target_project_id": "proj_b"}))
        self.assertEqual(dup.project_id, "proj_b")
        self.assertEqual(dup.origin_project_id, "proj_b")
        self.assertEqual(dup.scope, "project")
        self.assertEqual(dup.shared_to, [])
        self.assertIsNone(dup.published_at)


class TestGroupsAndRouting(_AssetIsolationBase):
    """L2 分组（HTTP 级）+ 路由优先级 + 墓碑守卫。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.api.asset_routes import router
        app = FastAPI()
        app.include_router(router, prefix="/api/v1")
        cls.client = TestClient(app)

    def _mk_http(self, name="a", project_id="proj_a", **kw):
        data = {"name": name, "category": "prop", "scope": "project", "project_id": project_id}
        data.update(kw)
        r = self.client.post("/api/v1/assets", data=data)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_groups_crud_and_routes(self):
        base = "/api/v1/assets/groups"
        # 创建 + 非法路径
        r = self.client.post(base, json={"path": "角色", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("角色", r.json()["project"])
        r = self.client.post(base, json={"path": "角色/主角", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("角色/主角", r.json()["project"])
        r = self.client.post(base, json={"path": "a/b/c", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(base, json={"path": "..", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 400)
        # 全局桶
        r = self.client.post(base, json={"path": "共用", "scope": "global"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("共用", r.json()["global"])
        # 读取（验证 /assets/groups 没有被 /assets/{asset_id} 吞掉）
        r = self.client.get(base, params={"project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("角色", body["project"])
        self.assertIn("共用", body["global"])
        self.assertIn("counts", body)
        # 重命名级联
        r = self.client.put(base, json={"old_path": "角色", "new_path": "阵营", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("阵营/主角", r.json()["project"])
        self.assertNotIn("角色", r.json()["project"])
        # 删除级联
        r = self.client.delete(base, params={"path": "阵营", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["project"], [])

    def test_group_assign_filter_and_rename_rebind(self):
        base = "/api/v1/assets/groups"
        self.client.post(base, json={"path": "角色", "project_id": "proj_a"})
        self.client.post(base, json={"path": "角色/主角", "project_id": "proj_a"})
        a = self._mk_http(name="hero")
        # 归组
        r = self.client.put(f"/api/v1/assets/{a['id']}", data={"group_path": "角色/主角", "actor_project_id": "proj_a"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["group_path"], "角色/主角")
        # 过滤：父路径含子级
        lst = self.client.get("/api/v1/assets", params={"project_id": "proj_a", "group": "角色"}).json()
        self.assertEqual(lst["total"], 1)
        lst = self.client.get("/api/v1/assets", params={"project_id": "proj_a", "group": "角色/主角"}).json()
        self.assertEqual(lst["total"], 1)
        lst = self.client.get("/api/v1/assets", params={"project_id": "proj_a", "group": "__none__"}).json()
        self.assertEqual(lst["total"], 0)
        # 重命名分组 → 素材 group_path 级联
        r = self.client.put(base, json={"old_path": "角色", "new_path": "阵营", "project_id": "proj_a"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["assets_moved"], 1)
        self.assertEqual(self.mgr.get_asset(a["id"]).group_path, "阵营/主角")
        # 删除分组 → 解绑素材（不删素材）
        r = self.client.delete(base, params={"path": "阵营", "project_id": "proj_a"})
        self.assertEqual(r.json()["unbound_assets"], 1)
        self.assertIsNone(self.mgr.get_asset(a["id"]).group_path)
        lst = self.client.get("/api/v1/assets", params={"project_id": "proj_a", "group": "__none__"}).json()
        self.assertEqual(lst["total"], 1)
        # 计数接口
        r = self.client.get(base, params={"project_id": "proj_a"})
        self.assertIsInstance(r.json().get("counts"), dict)

    def test_write_guard_and_tombstone(self):
        self._make_project("proj_a")
        self._make_project("proj_b")
        a = self._mk_http(name="hero", project_id="proj_a")
        # 跨项目修改 → 403
        r = self.client.put(f"/api/v1/assets/{a['id']}", data={"name": "hacked", "actor_project_id": "proj_b"})
        self.assertEqual(r.status_code, 403)
        # 强删（无引用）→ 墓碑
        r = self.client.delete(f"/api/v1/assets/{a['id']}", params={"project_id": "proj_a", "force": "true"})
        self.assertEqual(r.status_code, 200, r.text)
        from app.providers.asset.manager import load_tombstone_ids, is_tombstoned
        self.assertIn(a["id"], load_tombstone_ids())
        self.assertTrue(is_tombstoned(a["id"]))
        from app.storage_sync import mirror as mirror_mod
        self.assertTrue(mirror_mod._asset_tombstoned(f"assets/{a['id']}/original.png"))
        self.assertTrue(mirror_mod._asset_tombstoned(f"assets/{a['id']}/meta.json"))
        self.assertFalse(mirror_mod._asset_tombstoned("assets/ast_other/original.png"))
        self.assertFalse(mirror_mod._asset_tombstoned("projects/proj_a/content.json"))

    def test_cleanup_writes_tombstone(self):
        a = self._mk_http(name="dangling", file_url="/storage/assets/ast_missing_file.png")
        report = self.mgr.cleanup_missing()
        self.assertGreaterEqual(report["count"], 1)
        from app.providers.asset.manager import load_tombstone_ids
        self.assertIn(a["id"], load_tombstone_ids())

    def test_publish_tool_registered(self):
        from app.agent.mode_policy import TOOL_RISK
        self.assertEqual(TOOL_RISK.get("publish_asset"), "medium")
        # 计划模式只读白名单里不应包含发布（写操作）
        from app.agent.mode_policy import PLAN_READONLY_TOOLS
        self.assertNotIn("publish_asset", PLAN_READONLY_TOOLS)


if __name__ == "__main__":
    unittest.main()
