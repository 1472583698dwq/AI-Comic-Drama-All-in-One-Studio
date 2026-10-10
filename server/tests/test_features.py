# -*- coding: utf-8 -*-
"""功能级（feature）运行时开关回归测试（stdlib unittest，风格同 test_pages.py）。

覆盖：
- 默认值：逐条按 ``FEATURE_DEFS[i].default`` 生效（设计 §2.3.2 定稿的显式白名单），
  ``values()``/``snapshot()`` 一致
- 未知 id：``is_enabled`` False、``require`` 404、``set_values`` ValueError
- ``set_values``：落盘内容正确（扁平 + 原子写、无 .tmp 残留）、连续写、外部改文件热重读
- 非法输入：未知 id / 非布尔 / 非法字符串 / 非 dict 被拒且**不写脏**（含"部分合法"批次）
- 真实拦截点 1：``agent_team_routes`` 路由级守卫归属（关闭 404 / 开启放行）
- 真实拦截点 2：附件三入口（sanitize / focus_nodes / tool_result）关闭退化为 []，
  且 ``build_user_content`` 自然走纯文本（正文照常进模型）
- 真实拦截点 3：``SubAgentPool.spawn`` / ``spawn_batch`` 关闭返回 error（同既有失败分支形状），
  开启后同一调用路径能真正跑出 success
- 真实拦截点 4：``view_media`` 关闭时不出现在 agent 工具清单里
- 真实拦截点 5：``canvas_custom_nodes`` 关闭时 MCP 工具 ``customnode_*`` 既不注册、也调用不了
  （审查 M1：闸必须同时关住 HTTP 与 MCP / Agent 两条执行路径）
- HTTP：``GET /api/v1/features`` / ``PUT /api/v1/features``（两种 body 写法、400 拒绝）

运行： python -m unittest test_features -v
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent.runtime import attachments as A  # noqa: E402
from app.agent.runtime import subagent as SA  # noqa: E402
from app.core import features  # noqa: E402
from app.core.config import settings  # noqa: E402

ALL_IDS = [str(d["id"]) for d in features.FEATURE_DEFS]
#: 逐条默认值（真相源 = FEATURE_DEFS；不再假设「一律全关」）
DEFAULTS = {str(d["id"]): bool(d["default"]) for d in features.FEATURE_DEFS}
#: 出厂即开启的 id 集合（设计 §2.3.2 定稿：链路必需的两条）
DEFAULT_ON = {fid for fid, on in DEFAULTS.items() if on}


class _TempStorage(unittest.TestCase):
    """storage 指到临时目录：功能开关文件不得污染真实 storage/。"""

    @classmethod
    def setUpClass(cls):
        cls._orig_storage = settings.STORAGE_DIR
        cls._tmp = tempfile.mkdtemp(prefix="studio_test_features_")
        settings.STORAGE_DIR = cls._tmp

    @classmethod
    def tearDownClass(cls):
        settings.STORAGE_DIR = cls._orig_storage
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        # 每个用例从「文件不存在 = 逐条按 default」的干净态开始
        try:
            os.remove(features._path())
        except OSError:
            pass

    def _disk(self):
        with open(features._path(), encoding="utf-8") as f:
            return json.load(f)


class TestDefaults(_TempStorage):
    def test_defaults_follow_defs(self):
        snap = features.snapshot()
        self.assertEqual({f["id"] for f in snap["features"] if f["enabled"]}, DEFAULT_ON)
        self.assertEqual(features.enabled_ids(), [fid for fid in ALL_IDS if DEFAULTS[fid]])
        self.assertEqual(features.values(), DEFAULTS)
        for fid in ALL_IDS:
            self.assertEqual(features.is_enabled(fid), DEFAULTS[fid])
        # 定义本身即契约：default 必须是**显式 bool**（不再要求一律 False），label/description 齐备
        for d in features.FEATURE_DEFS:
            self.assertIsInstance(d["default"], bool)
            self.assertTrue(d["label"] and d["description"])
        # 设计 §2.3.2 定稿口径（用户确认）：链路必需的两条默认开、安全敏感 / 可选进阶默认关。
        # 改这个集合 = 改产品口径，须同步本断言与本文件顶部说明。
        self.assertEqual(DEFAULT_ON, {"agent_multimodal", "agent_subagent"})

    def test_file_missing_is_all_default(self):
        self.assertFalse(os.path.exists(features._path()))
        self.assertEqual(features.values(), DEFAULTS)

    def test_snapshot_shape(self):
        snap = features.snapshot()
        self.assertEqual([f["id"] for f in snap["features"]], ALL_IDS)
        for row, definition in zip(snap["features"], features.FEATURE_DEFS):
            for key, val in definition.items():
                self.assertEqual(row[key], val)
            self.assertIn("enabled", row)
            # enabled 与各自的 default 一致（不再恒 False）
            self.assertEqual(row["enabled"], bool(definition.get("default", False)))
        # 分组清单是**契约**：新增分组必须是有意为之，不能顺手加。
        # 「创意画布」= 承载页内能力的画布能力组（canvas_custom_nodes），
        # 由《UI开关热插拔设计》§2.3.2 / §11.4 决定新增。
        self.assertEqual(snap["groups"], ["AI 导演", "扩展能力", "创意画布"])
        self.assertEqual(list(snap["values"].keys()), ALL_IDS)
        self.assertTrue(snap["file"].endswith("features.json"))
        self.assertIn(str(settings.STORAGE_DIR), snap["file"])

    def test_unknown_id_is_false(self):
        for bad in ("nope", "", "agent_team", "AGENT_TEAMS", None):
            self.assertFalse(features.is_enabled(bad))


class TestRequire(_TempStorage):
    def test_require_404_when_disabled_then_pass_after_enable(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            features.require("agent_teams")()
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("导演组", ctx.exception.detail)
        self.assertIn("设置 → 功能开关", ctx.exception.detail)

        features.set_values({"agent_teams": True})
        self.assertTrue(features.is_enabled("agent_teams"))
        features.require("agent_teams")()  # 开启后放行（不抛）

        features.set_values({"agent_teams": False})
        with self.assertRaises(HTTPException) as ctx2:
            features.require("agent_teams")()
        self.assertEqual(ctx2.exception.status_code, 404)

    def test_unknown_id_never_allowed(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            features.require("nope")()
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("nope", ctx.exception.detail)


class TestSetValues(_TempStorage):
    def test_write_persists_flat_file(self):
        r = features.set_values({"agent_teams": True})
        self.assertEqual(r["changed"], ["agent_teams"])
        self.assertEqual(r["file"], features._path())
        self.assertTrue(r["values"]["agent_teams"])
        # 落盘 = 扁平 {"<id>": bool}，全量 id（顺序同 FEATURE_DEFS），无 .tmp 残留
        disk = self._disk()
        self.assertEqual(list(disk.keys()), ALL_IDS)
        # 未动的键保持各自 default（agent_multimodal / agent_subagent 默认开，
        # canvas_custom_nodes / agent_teams 默认关）
        self.assertEqual(disk, {**DEFAULTS, "agent_teams": True})
        self.assertFalse(os.path.exists(features._path() + ".tmp"))
        self.assertTrue(features.is_enabled("agent_teams"))
        self.assertEqual(features.enabled_ids(),
                         [fid for fid in ALL_IDS if {**DEFAULTS, "agent_teams": True}[fid]])

    def test_repeat_write_no_change(self):
        features.set_values({"agent_teams": True})
        r = features.set_values({"agent_teams": True})
        self.assertEqual(r["changed"], [])
        self.assertTrue(features.is_enabled("agent_teams"))

    def test_external_edit_hot_reload(self):
        features.set_values({"agent_teams": True})
        self.assertTrue(features.is_enabled("agent_teams"))
        time.sleep(0.02)  # 拉开 mtime，模拟另一进程/手改
        with open(features._path(), "w", encoding="utf-8") as f:
            json.dump({"agent_teams": False, "agent_subagent": True}, f)
        self.assertFalse(features.is_enabled("agent_teams"))
        self.assertTrue(features.is_enabled("agent_subagent"))
        # 未写的键回落各自的 default（agent_multimodal 默认开 / canvas_custom_nodes 默认关）
        self.assertEqual(features.is_enabled("agent_multimodal"), DEFAULTS["agent_multimodal"])
        self.assertEqual(features.is_enabled("canvas_custom_nodes"), DEFAULTS["canvas_custom_nodes"])

    def test_deleting_file_resets_to_defaults(self):
        features.set_values({"agent_subagent": True})
        os.remove(features._path())
        self.assertEqual(features.values(), DEFAULTS)

    def test_corrupt_file_falls_back_to_defaults(self):
        features.set_values({"agent_teams": True})
        time.sleep(0.02)
        with open(features._path(), "w", encoding="utf-8") as f:
            f.write("{ not json")
        self.assertEqual(features.values(), DEFAULTS)


class TestInvalidInput(_TempStorage):
    def _assert_rejected(self, payload):
        before = self._disk() if os.path.exists(features._path()) else None
        with self.assertRaises(ValueError):
            features.set_values(payload)
        after = self._disk() if os.path.exists(features._path()) else None
        self.assertEqual(before, after)  # 不写脏

    def test_unknown_id_rejected(self):
        self._assert_rejected({"nope": True})
        self._assert_rejected({"agent_teams": True, "nope": True})  # 部分合法也要整批拒
        self.assertIsNone(features._disk() if os.path.exists(features._path()) else None)
        self.assertFalse(features.is_enabled("agent_teams"))

    def test_non_bool_rejected(self):
        for bad in (1, 0, "true", "yes", None, [], {}):
            self._assert_rejected({"agent_teams": bad})
        # 全量关闭（False）与真值 True 才合法
        features.set_values({"agent_teams": False})
        self.assertIs(self._disk()["agent_teams"], False)

    def test_non_dict_rejected(self):
        for bad in ("agent_teams", ["agent_teams"], 3, None):
            with self.assertRaises(ValueError):
                features.set_values(bad)

    def test_error_message_names_offenders(self):
        with self.assertRaises(ValueError) as ctx:
            features.set_values({"nope": True, "agent_teams": "yes"})
        msg = str(ctx.exception)
        self.assertIn("nope", msg)
        self.assertIn("agent_teams", msg)


class TestRouteGuardOwnership(_TempStorage):
    """导演组路由守卫归属：/agent-teams* 与 /agent-profiles* 同族同开关。"""

    def _dep(self):
        import importlib
        mod = importlib.import_module("app.api.agent_team_routes")
        deps = [d.dependency for d in mod.router.dependencies]
        self.assertEqual(len(deps), 1, "agent_team_routes 守卫数量异常")
        return deps[0]

    def test_agent_team_family_guarded_by_agent_teams(self):
        from fastapi import HTTPException
        dep = self._dep()
        with self.assertRaises(HTTPException) as ctx:
            dep()
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("导演组", ctx.exception.detail)

        features.set_values({"agent_teams": True})
        dep()  # 开启后放行

        features.set_values({"agent_teams": False})
        with self.assertRaises(HTTPException) as ctx2:
            dep()
        self.assertEqual(ctx2.exception.status_code, 404)

    def test_other_features_do_not_unlock_agent_teams(self):
        """防挂错开关：只开子代理/多模态，导演组仍须 404。"""
        from fastapi import HTTPException
        features.set_values({"agent_subagent": True, "agent_multimodal": True})
        with self.assertRaises(HTTPException) as ctx:
            self._dep()()
        self.assertEqual(ctx.exception.status_code, 404)


class TestMultimodalGate(_TempStorage):
    """拦截点 2：附件三入口关闭时退化为「无附件」（不是报错）。"""

    RAW = [{"kind": "image", "ref": "/storage/x.png", "name": "x.png"},
           {"kind": "image", "ref": "https://x.test/a.jpg", "name": "a.jpg"}]
    NODES = {"agent_focus_nodes": [{"id": "n1", "label": "生图 Agent",
                                   "image_url": "/storage/n1.png"}]}
    TOOL = "generate_image"
    TOOL_RESULT = {"image_url": "/storage/gen/out.png"}

    def setUp(self):
        super().setUp()
        # §2.3.2 定稿后 agent_multimodal 默认**开**；本类测「关闭时」的退化行为，显式关掉
        features.set_values({"agent_multimodal": False})
        self._env = os.environ.get("AGENT_FOCUS_MEDIA")
        os.environ["AGENT_FOCUS_MEDIA"] = "1"
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._env is None:
            os.environ.pop("AGENT_FOCUS_MEDIA", None)
        else:
            os.environ["AGENT_FOCUS_MEDIA"] = self._env

    def test_disabled_returns_empty_everywhere(self):
        self.assertFalse(features.is_enabled("agent_multimodal"))
        self.assertEqual(A.sanitize_attachments(self.RAW), [])
        self.assertEqual(A.attachments_from_focus_nodes(self.NODES), [])
        self.assertEqual(A.attachments_from_tool_result(self.TOOL, self.TOOL_RESULT), [])
        # 无附件 → 纯文本路径：用户正文照常进模型（不抛、不吞）
        content = A.build_user_content("看看这张图", A.sanitize_attachments(self.RAW))
        self.assertEqual(content, "看看这张图")
        self.assertIsInstance(content, str)

    def test_enabled_restores_three_entries(self):
        features.set_values({"agent_multimodal": True})
        atts = A.sanitize_attachments(self.RAW)
        self.assertEqual(len(atts), 2)
        self.assertEqual([a["kind"] for a in atts], ["image", "image"])
        self.assertTrue(all(a["ref"] for a in atts))
        focus = A.attachments_from_focus_nodes(self.NODES)
        self.assertEqual(len(focus), 1)
        self.assertEqual(focus[0]["ref"], "/storage/n1.png")
        tool = A.attachments_from_tool_result(self.TOOL, self.TOOL_RESULT)
        self.assertEqual(len(tool), 1)
        self.assertEqual(tool[0]["ref"], "/storage/gen/out.png")

    def test_view_media_tool_hidden_when_disabled(self):
        from app.agent.tools.registry import tool_view
        off = [x["function"]["name"] for x in tool_view.schemas()]
        self.assertNotIn("view_media", off)
        features.set_values({"agent_multimodal": True})
        on = [x["function"]["name"] for x in tool_view.schemas()]
        self.assertIn("view_media", on)   # 缓存键含开关 → 立刻重建
        features.set_values({"agent_multimodal": False})
        self.assertNotIn("view_media", [x["function"]["name"] for x in tool_view.schemas()])
        self.assertIn("todo_write", [x["function"]["name"] for x in tool_view.schemas()])


class TestSubagentGate(_TempStorage):
    """拦截点 3：子代理关闭时 spawn/spawn_batch 返回 error（同既有失败分支形状）。"""

    def setUp(self):
        super().setUp()
        # §2.3.2 定稿后 agent_subagent 默认**开**；本类测「关闭时」的 error 分支，显式关掉
        features.set_values({"agent_subagent": False})

    def _fake_parent(self):
        class FakeSession:
            id = "sub_parent_sess"

            def append(self, event_type, data):
                pass

        class Parent:
            context = {}
            run_mode = "auto"
            session = FakeSession()

        return Parent()

    def _install_fake_child(self):
        import app.agent.runtime.loop as loop_mod

        class FakeSession:
            def __init__(self, sid):
                self.id = sid
                self.store = None

            def last_assistant_text(self):
                return "子代理产物OK"

        class FakeChild:
            def __init__(self, sid, run_mode=None, mode=None, context=None,
                         interactive=None, store=None, max_steps=None, agent_profile=None):
                self.session = FakeSession(sid)

            async def prompt(self, text):
                pass

            async def wait_idle(self, timeout=None):
                pass

            def is_running(self):
                return False

            async def abort(self, cause="user"):
                pass

        orig = loop_mod.AgentLoop
        loop_mod.AgentLoop = FakeChild
        self.addCleanup(lambda: setattr(loop_mod, "AgentLoop", orig))

    def _run(self, coro):
        import asyncio
        return asyncio.new_event_loop().run_until_complete(coro)

    def test_spawn_returns_error_when_disabled(self):
        parent = self._fake_parent()
        r = self._run(SA.subagent_pool.spawn(parent, "generalist", "调研一下"))
        self.assertEqual(r["status"], "error")
        self.assertEqual(set(r.keys()), {"status", "error"})  # 与既有失败分支同形状
        self.assertIn("子代理能力已关闭", r["error"])
        self.assertIn("设置 → 功能开关", r["error"])
        # 没有产出句柄（不会被误判成 launched/success）
        self.assertNotIn("subagent_id", r)

    def test_run_subagent_maps_to_error_when_disabled(self):
        r = self._run(SA.run_subagent(self._fake_parent(), "调研一下"))
        self.assertEqual(r["status"], "error")
        self.assertEqual(r["error"], SA.DISABLED_ERROR)
        self.assertNotIn("result", r)

    def test_spawn_batch_returns_error_when_disabled(self):
        r = self._run(SA.subagent_pool.spawn_batch(self._fake_parent(), "generalist",
                                                  [{"task": "a"}, {"task": "b"}]))
        self.assertEqual(r["status"], "error")
        self.assertEqual(r["error"], SA.DISABLED_ERROR)

    def test_pipeline_subagent_run_surfaces_error_outcome(self):
        """工具层照既有 error 分支处理（不是 success、不抛异常）。"""
        from app.agent.tools.pipeline import ToolPipeline

        async def emit(ev):
            pass

        p = ToolPipeline("sess_feature_gate", emit, interactive=False)
        p.subagent_parent = self._fake_parent()  # 与 loop.py 的接线方式一致

        async def go():
            return await p.execute("c1", "subagent_run", {"task": "调研"}, run_mode="auto")

        out = self._run(go())
        self.assertEqual(out.status, "error")
        self.assertIn("子代理能力已关闭", out.error or "")

    def test_enabled_spawn_succeeds(self):
        features.set_values({"agent_subagent": True})
        self._install_fake_child()
        r = self._run(SA.run_subagent(self._fake_parent(), "独立调研任务"))
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["result"], "子代理产物OK")

    def test_enabled_batch_passes_gate(self):
        features.set_values({"agent_subagent": True})
        r = self._run(SA.subagent_pool.spawn_batch(self._fake_parent(), "generalist", []))
        # 过了闸门 → 走到既有参数校验（而不是功能关闭话术）
        self.assertEqual(r["status"], "error")
        self.assertNotEqual(r["error"], SA.DISABLED_ERROR)
        self.assertIn("非空数组", r["error"])


class TestFeatureRoutes(_TempStorage):
    """HTTP 层：GET 清单 / PUT 写开关（两种 body 写法与 400 拒绝）。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            from fastapi.testclient import TestClient
            import app.main as main_mod
        except Exception as e:  # pragma: no cover - 环境缺依赖时跳过
            raise unittest.SkipTest(f"TestClient / app.main 不可用: {e}")
        cls._orig_storage = settings.STORAGE_DIR  # 已被 _TempStorage 换过，这里只记快照
        cls.client = TestClient(main_mod.app)

    def test_get_features(self):
        r = self.client.get("/api/v1/features")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual([f["id"] for f in data["features"]], ALL_IDS)
        self.assertEqual({f["id"] for f in data["features"] if f["enabled"]}, DEFAULT_ON)
        self.assertIn(str(settings.STORAGE_DIR), data["file"])

    def test_put_features_both_bodies(self):
        r = self.client.put("/api/v1/features", json={"values": {"agent_teams": True}})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["changed"], ["agent_teams"])
        self.assertTrue(body["values"]["agent_teams"])
        self.assertTrue(features.is_enabled("agent_teams"))

        r2 = self.client.put("/api/v1/features", json={"agent_teams": False})
        self.assertEqual(r2.status_code, 200)
        self.assertFalse(features.is_enabled("agent_teams"))
        self.assertEqual(self._disk()["agent_teams"], False)

    def test_agent_team_family_http_404_when_disabled(self):
        """/agent-teams* 与 /agent-profiles* 同族：关闭时整族 404，开启后恢复 200。"""
        for path in ("/api/v1/agent-teams", "/api/v1/agent-teams/spec",
                     "/api/v1/agent-profiles", "/api/v1/agent-profiles/spec"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 404, path)
            self.assertIn("导演组", r.json()["detail"])
        self.client.put("/api/v1/features", json={"values": {"agent_teams": True}})
        for path in ("/api/v1/agent-teams", "/api/v1/agent-teams/spec",
                     "/api/v1/agent-profiles", "/api/v1/agent-profiles/spec"):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_agent_upload_404_when_multimodal_off(self):
        """多模态关闭 → 附件上传口 404（不能"文件落了盘但永远送不出去"）；开启后恢复。"""
        # §2.3.2 定稿后 agent_multimodal 默认开 → 先显式关掉再验 404
        self.client.put("/api/v1/features", json={"values": {"agent_multimodal": False}})
        r = self.client.post("/api/v1/agent/upload",
                             files={"file": ("a.png", b"\x89PNG\r\n\x1a\n", "image/png")})
        self.assertEqual(r.status_code, 404)
        self.assertIn("多模态", r.json()["detail"])
        self.client.put("/api/v1/features", json={"values": {"agent_multimodal": True}})
        r2 = self.client.post("/api/v1/agent/upload",
                              files={"file": ("a.png", b"\x89PNG\r\n\x1a\n", "image/png")})
        self.assertNotEqual(r2.status_code, 404)

    def test_put_rejects_invalid(self):
        for payload in ({"values": {"nope": True}}, {"values": {"agent_teams": "yes"}},
                        {"values": "x"}, {"nope": True}, {"agent_teams": 1}):
            r = self.client.put("/api/v1/features", json=payload)
            self.assertEqual(r.status_code, 400, payload)
        self.assertFalse(os.path.exists(features._path()))  # 一次脏写都没发生


class TestCustomNodeMcpGate(_TempStorage):
    """真实拦截点 5（审查 M1）：页内能力闸必须同时关住 MCP / Agent 执行路径。

    背景：``canvas_custom_nodes`` 的理由是「会执行用户代码、安全敏感」，此前它只挂在
    ``/api/v1/custom-nodes`` 的 4 条 HTTP 端点上；MCP 工具 ``customnode_<id>`` 的注册与调用
    完全不看这个闸 —— HTTP 404 了但 AI 导演 / MCP 调用照样能跑，正是「假闸」。
    """

    NODE_ID = "gate_node"

    def _save_node(self):
        from app.custom_nodes.models import CustomNodeDefinition
        from app.custom_nodes.manager import custom_node_manager
        return custom_node_manager.save(CustomNodeDefinition(
            id=self.NODE_ID, name="闸测试", kind="utility",
            code="async def run(inputs, params, ctx):\n    return {'text': 'ok'}\n",
        ))

    def _run(self, coro):
        import asyncio
        return asyncio.new_event_loop().run_until_complete(coro)

    def test_tool_not_registered_when_feature_off(self):
        from app.mcp.server import mcp_registry
        self._save_node()
        features.set_values({"canvas_custom_nodes": False})
        mcp_registry.refresh_customnode_tools()
        self.assertNotIn(f"customnode_{self.NODE_ID}", mcp_registry.tools)

    def test_tool_registered_when_feature_on(self):
        from app.mcp.server import mcp_registry
        self._save_node()
        features.set_values({"canvas_custom_nodes": True})
        mcp_registry.refresh_customnode_tools()
        self.assertIn(f"customnode_{self.NODE_ID}", mcp_registry.tools)

    def test_call_blocked_even_if_tool_list_is_stale(self):
        """闸关掉但清单没重刷（陈旧清单）：调用路径必须自己再判一次。"""
        from app.mcp.server import mcp_registry
        self._save_node()
        features.set_values({"canvas_custom_nodes": True})
        mcp_registry.refresh_customnode_tools()
        self.assertIn(f"customnode_{self.NODE_ID}", mcp_registry.tools)  # 此刻清单是「陈旧」的
        features.set_values({"canvas_custom_nodes": False})
        resp = self._run(mcp_registry.execute_tool(f"customnode_{self.NODE_ID}", {}))
        self.assertEqual(resp.status, "error")
        self.assertIn("功能开关", resp.error or "")

    def test_feature_route_refreshes_tool_list(self):
        """``PUT /features`` 写成功后立即重刷受闸的 MCP 工具清单（不依赖插件启停）。"""
        from app.api import feature_routes
        from app.mcp.server import mcp_registry
        self._save_node()
        self._run(feature_routes.update_features({"values": {"canvas_custom_nodes": True}}))
        self.assertIn(f"customnode_{self.NODE_ID}", mcp_registry.tools)
        self._run(feature_routes.update_features({"values": {"canvas_custom_nodes": False}}))
        self.assertNotIn(f"customnode_{self.NODE_ID}", mcp_registry.tools)


if __name__ == "__main__":
    unittest.main(verbosity=2)
