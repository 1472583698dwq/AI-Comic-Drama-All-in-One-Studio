# -*- coding: utf-8 -*-
"""MCP create_asset 挂图回归测试：file_url/thumb_url 必须写入素材。

历史 bug：MCP 的 create_asset 映射表只有 7 个字段，file_url 传了被静默丢弃，
Agent 建出来的条目"有档案、没缩略图"。HTTP 路由与 manager 一直是好的，这里锁住 MCP 侧。

运行： python -m unittest tests.test_mcp_create_asset -v
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config import settings  # noqa: E402
from app.providers.asset import manager as asset_mod  # noqa: E402


class TestMcpCreateAsset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="mcp_asset_")
        cls._orig = (settings.STORAGE_DIR, asset_mod.ASSETS_ROOT, asset_mod.TOMBSTONES,
                     asset_mod.MISSING_BACKUP, asset_mod.AssetManager._missing_swept)
        assets_root = os.path.join(cls._tmp, "assets")
        os.makedirs(assets_root, exist_ok=True)
        settings.STORAGE_DIR = cls._tmp
        asset_mod.ASSETS_ROOT = assets_root
        asset_mod.TOMBSTONES = os.path.join(assets_root, ".tombstones.jsonl")
        asset_mod.MISSING_BACKUP = os.path.join(assets_root, ".missing_backup.jsonl")
        asset_mod.AssetManager._missing_swept = True  # 测试里不触发缺失清扫

    @classmethod
    def tearDownClass(cls):
        (settings.STORAGE_DIR, asset_mod.ASSETS_ROOT, asset_mod.TOMBSTONES,
         asset_mod.MISSING_BACKUP, asset_mod.AssetManager._missing_swept) = cls._orig
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_create_asset_persists_file_url(self):
        """file_url 必须落到 file_url/thumb_url（thumb 缺省同 file）。"""
        from app.mcp.server import mcp_registry
        res = asyncio.run(mcp_registry.execute_tool("create_asset", {
            "name": "回归-苏冷月",
            "category": "character",
            "file_url": "/storage/assets/ast_test/original.png",
        }))
        self.assertEqual(res.status, "success", res.error)
        data = res.result or {}
        self.assertEqual(data.get("file_url"), "/storage/assets/ast_test/original.png")
        self.assertEqual(data.get("thumb_url"), "/storage/assets/ast_test/original.png")

    def test_create_asset_honors_explicit_thumb_url(self):
        from app.mcp.server import mcp_registry
        res = asyncio.run(mcp_registry.execute_tool("create_asset", {
            "name": "回归-缩略图",
            "file_url": "/storage/1.png",
            "thumb_url": "/storage/1_thumb.png",
        }))
        self.assertEqual(res.status, "success", res.error)
        data = res.result or {}
        self.assertEqual(data.get("file_url"), "/storage/1.png")
        self.assertEqual(data.get("thumb_url"), "/storage/1_thumb.png")

    def test_create_asset_without_file_url_unchanged(self):
        """不传 file_url 的路径保持原行为：成功创建、无图字段。"""
        from app.mcp.server import mcp_registry
        res = asyncio.run(mcp_registry.execute_tool("create_asset", {"name": "无图素材"}))
        self.assertEqual(res.status, "success", res.error)
        self.assertFalse((res.result or {}).get("file_url"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
