# -*- coding: utf-8 -*-
"""3D 导演台 Agent 控制（stage_get_state / stage_control）回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_stage_control -v
钉住四件事：
- 写操作就地落盘内容并返回 stage_patch（前端实时应用靠它）；
- 关节按限位钳制（肘/膝铰链防反关节）、姿态预设清除自定义关节；
- 枚举非法一律明错（不静默吞）；
- MCP 注册表 / 模式策略 / 只读白名单同口径。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.director_stage import ops  # noqa: E402


def _content():
    return {
        "id": "proj_test",
        "title": "测试片",
        "scenes": [
            {"id": "sc1", "shots": [
                {"id": "sh1", "shot_index": 1, "action_desc": "主角拔剑", "duration": 5},
                {"id": "sh2", "shot_index": 2, "action_desc": "对手冷笑", "duration": 4},
            ]},
        ],
    }


class TestStageState(unittest.TestCase):
    def test_state_defaults_and_enums(self):
        st = ops.stage_state(_content(), shot_index=2)
        self.assertEqual(st["shot_id"], "sh2")
        self.assertEqual(st["pose_preset"], "stand")
        self.assertEqual(st["camera_framing"], "medium")
        self.assertIn("joint_limits", st["available"])
        self.assertIn("elbow_L", st["available"]["joints"])
        self.assertIn("cast_spell", st["available"]["pose_presets"])

    def test_state_empty_project_guides_instead_of_dead_end(self):
        empty = {"id": "p", "title": "空项目", "scenes": [{"scene_index": 1, "title": "场景 1", "shots": []}]}
        st = ops.stage_state(empty)
        self.assertEqual(st["shots_total"], 0)
        self.assertIn("create_shot", st["hint"])
        self.assertIn("画布节点不是分镜", st["hint"])

    def test_state_missing_shot_index_raises_with_hint(self):
        with self.assertRaises(ops.StageControlError) as ctx:
            ops.stage_state(_content(), shot_index=99)
        self.assertIn("未找到指定分镜", str(ctx.exception))

    def test_state_includes_clay_fields(self):
        c = _content()
        shot = c["scenes"][0]["shots"][0]
        shot["clay_video_url"] = "/storage/videos/clay_1.mp4"
        shot["previz_video_url"] = "/storage/videos/clay_1.mp4"
        shot["clay_first_frame_url"] = "/storage/generated/f1.jpg"
        shot["clay_last_frame_url"] = "/storage/generated/f2.jpg"
        st = ops.stage_state(c)
        self.assertEqual(st["clay_video_url"], "/storage/videos/clay_1.mp4")
        self.assertEqual(st["previz_video_url"], "/storage/videos/clay_1.mp4")
        self.assertEqual(st["clay_first_frame_url"], "/storage/generated/f1.jpg")
        self.assertEqual(st["clay_last_frame_url"], "/storage/generated/f2.jpg")

    def test_create_shot_on_empty_project_unlocks_stage(self):
        empty = {"id": "p", "title": "空项目", "scenes": [{"scene_index": 1, "title": "场景 1", "shots": []}]}
        out = ops.apply_stage_control(empty, {
            "action": "create_shot",
            "payload": {"action_desc": "双忍庭院对峙起手", "duration": 3.0, "pose_preset": "fight"},
        })
        self.assertTrue(out["created_shot"])
        self.assertEqual(out["created_shot"]["shot_index"], 1)
        self.assertEqual(empty["scenes"][0]["shots"][0]["action_desc"], "双忍庭院对峙起手")
        # 建完后其他控制立即可用
        out2 = ops.apply_stage_control(empty, {"action": "set_cast_layout", "shot_index": 1,
                                               "payload": {"cast_layout": "duel"}})
        self.assertEqual(out2["stage_patch"]["cast_layout"], "duel")

    def test_create_shot_autocreates_scene(self):
        empty = {"id": "p", "title": "空项目", "scenes": []}
        out = ops.apply_stage_control(empty, {"action": "create_shot", "payload": {"action_desc": "第一镜"}})
        self.assertEqual(len(empty["scenes"]), 1)
        self.assertEqual(empty["scenes"][0]["shots"][0]["shot_index"], 1)
        self.assertEqual(out["shot_index"], 1)


class TestStageControl(unittest.TestCase):
    def test_set_pose_and_clear_joints(self):
        c = _content()
        out = ops.apply_stage_control(c, {"action": "set_pose", "shot_index": 1,
                                          "payload": {"pose_preset": "fight"}})
        self.assertEqual(out["shot_id"], "sh1")
        self.assertEqual(out["stage_patch"]["pose_preset"], "fight")
        self.assertEqual(c["scenes"][0]["shots"][0]["pose_preset"], "fight")

        out2 = ops.apply_stage_control(c, {"action": "set_joints", "shot_index": 1,
                                           "payload": {"entity": "entity_protagonist",
                                                       "joints": {"elbow_L": [-1.2, 0, 0], "knee_R": [1.0, 0, 0]}}})
        self.assertIn("mannequin_pose", out2["stage_patch"])
        joints = c["scenes"][0]["shots"][0]["mannequin_pose"]["entities"]["entity_protagonist"]["joints"]
        self.assertAlmostEqual(joints["elbow_L"][0], -1.2, places=3)

        # 姿态预设 = 清除自定义关节
        out3 = ops.apply_stage_control(c, {"action": "set_pose", "shot_index": 1,
                                           "payload": {"pose_preset": "stand"}})
        self.assertIsNone(out3["stage_patch"]["mannequin_pose"])
        self.assertNotIn("mannequin_pose", c["scenes"][0]["shots"][0])

    def test_joint_limits_clamped(self):
        c = _content()
        ops.apply_stage_control(c, {"action": "set_joints", "shot_index": 1,
                                    "payload": {"joints": {"knee_L": [-2.0, 0, 0], "elbow_R": [1.5, 0, 0]}}})
        joints = c["scenes"][0]["shots"][0]["mannequin_pose"]["entities"]["entity_protagonist"]["joints"]
        self.assertGreaterEqual(joints["knee_L"][0], 0.0)   # 膝只能向后弯
        self.assertLessEqual(joints["elbow_R"][0], 0.1)     # 肘不得反折

    def test_unknown_joint_and_action_raise(self):
        c = _content()
        with self.assertRaises(ops.StageControlError):
            ops.apply_stage_control(c, {"action": "set_joints", "shot_index": 1,
                                        "payload": {"joints": {"tail": [0, 0, 0]}}})
        with self.assertRaises(ops.StageControlError):
            ops.apply_stage_control(c, {"action": "dance", "shot_index": 1, "payload": {}})
        with self.assertRaises(ops.StageControlError):
            ops.apply_stage_control(c, {"action": "set_pose", "shot_index": 1,
                                        "payload": {"pose_preset": "fly_away"}})

    def test_transform_camera_waypoints_props_lighting_cast(self):
        c = _content()
        shot = c["scenes"][0]["shots"][0]
        ops.apply_stage_control(c, {"action": "set_transform", "shot_index": 1,
                                    "payload": {"entity": "entity_protagonist", "p": [1.2, 0, -0.5], "r": [0, 1.57, 0], "s": 1.1}})
        self.assertAlmostEqual(shot["stage_layout"]["entity_protagonist"]["p"][0], 1.2, places=3)

        ops.apply_stage_control(c, {"action": "set_camera", "shot_index": 1,
                                    "payload": {"camera_framing": "close_up", "camera_motion": "orbit", "focal_length_mm": 50, "camera_roll_deg": 12}})
        self.assertEqual(shot["camera_framing"], "close_up")
        self.assertEqual(shot["focal_length_mm"], 50)

        ops.apply_stage_control(c, {"action": "set_camera", "shot_index": 1,
                                    "payload": {"camera": {"pos": [0, 1.5, 3], "quat": [0, 0, 0, 1], "fov": 40, "name": "英雄机位"}}})
        self.assertEqual(shot["stage_cameras"][-1]["name"], "英雄机位")

        ops.apply_stage_control(c, {"action": "set_waypoints", "shot_index": 1,
                                    "payload": {"points": [{"x": 1, "z": 1}, {"x": 9, "z": -9}, "bad"]}})
        self.assertEqual(shot["walk_path"], [{"x": 1.0, "z": 1.0}, {"x": 6.0, "z": -6.0}])

        ops.apply_stage_control(c, {"action": "set_props", "shot_index": 1,
                                    "payload": {"props": ["sword", "bogus", "chair"]}})
        self.assertEqual(shot["props_config"], ["sword", "chair"])

        ops.apply_stage_control(c, {"action": "set_lighting", "shot_index": 1,
                                    "payload": {"keyIntensity": 5.0, "keyTemp": "warm", "exposure": 9}})
        self.assertEqual(shot["lighting_config"]["keyTemp"], "warm")
        self.assertLessEqual(shot["lighting_config"]["exposure"], 3.0)

        ops.apply_stage_control(c, {"action": "set_cast_layout", "shot_index": 1,
                                    "payload": {"cast_layout": "duel"}})
        self.assertEqual(shot["cast_layout"], "duel")

    def test_set_shot_text_updates_text_fields(self):
        c = _content()
        out = ops.apply_stage_control(c, {"action": "set_shot_text", "shot_index": 1,
                                          "payload": {"action_desc": "双忍雨夜对峙", "dialogue": "你终于来了。"}})
        shot = c["scenes"][0]["shots"][0]
        self.assertEqual(shot["action_desc"], "双忍雨夜对峙")
        self.assertEqual(shot["dialogue"], "你终于来了。")
        self.assertEqual(out["stage_patch"]["action_desc"], "双忍雨夜对峙")
        # 不给任何文字字段 → 明错（不静默）
        with self.assertRaises(ops.StageControlError):
            ops.apply_stage_control(c, {"action": "set_shot_text", "shot_index": 1, "payload": {}})

    def test_entity_whitelist_rejects_junk(self):
        c = _content()
        with self.assertRaises(ops.StageControlError):
            ops.apply_stage_control(c, {"action": "set_transform", "shot_index": 1,
                                        "payload": {"entity": "<script>", "p": [0, 0, 0]}})


class TestScriptSplitFallback(unittest.TestCase):
    """拆解兜底：LLM 只给场景不给 shots 时，按文本节拍补镜（项目不允许落成 0 镜）。"""

    def test_empty_shots_repaired_by_beats(self):
        from app.pipelines.script_agent import script_agent
        data = {"title": "樱下双刃", "characters": [{"name": "苍"}],
                "scenes": [{"scene_index": 1, "title": "庭院对峙", "image_prompt": "empty courtyard",
                            "shots": []}]}
        text = "苍拔刀。鹤腾空而起，刀光闪过！两人在庭院中交错而过。刀刃再次相撞，火星四溅。"
        proj = script_agent._build_project_from_dict(data, text, "donghua_xianxia", "9:16")
        self.assertGreaterEqual(sum(len(s.shots) for s in proj.scenes), 2)
        self.assertTrue(all(s.shots for s in proj.scenes), "不允许留空 shots")

    def test_fallback_beats_splits_text(self):
        from app.pipelines.script_agent import _fallback_beats
        beats = _fallback_beats("甲出刀。乙格挡！甲反击。乙闪避。两人僵持。")
        self.assertGreaterEqual(len(beats), 3)


class TestFsReadDirListing(unittest.TestCase):
    """fs_read 支持目录清单（无需可信模式）——排障不再依赖 shell。"""

    def test_list_directory(self):
        import os
        import shutil
        from app.mcp.server import _fs_read_action, _trusted_repo_root
        root = _trusted_repo_root()
        d = os.path.join(root, "__fsread_probe__")
        os.makedirs(d, exist_ok=True)
        try:
            with open(os.path.join(d, "probe.txt"), "w", encoding="utf-8") as f:
                f.write("hi")
            out = _fs_read_action("__fsread_probe__")
            self.assertEqual(out.get("type"), "dir")
            names = {e["name"] for e in out.get("entries") or []}
            self.assertIn("probe.txt", names)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_missing_path_hints_storage_layout(self):
        from app.mcp.server import _fs_read_action
        with self.assertRaises(ValueError) as ctx:
            _fs_read_action("storage/definitely_missing_zz.json")
        self.assertIn("storage/projects", str(ctx.exception))


class TestClayPending(unittest.TestCase):
    """白模导出回执对账：按 project+shot 记住发起会话，回执只通知这个会话。"""

    def setUp(self):
        from app.director_stage import pending
        self.p = pending
        with pending._LOCK:
            pending._PENDING.clear()

    def tearDown(self):
        with self.p._LOCK:
            self.p._PENDING.clear()

    def test_register_and_pop_by_id_or_index(self):
        self.p.register("proj1", "sh1", 2, "proj_proj1_sess1")
        self.assertEqual(self.p.pending_count(), 1)
        e = self.p.pop("proj1", shot_index=2)  # index 也能命中（id/index 双键）
        self.assertIsNotNone(e)
        self.assertEqual(e.session_id, "proj_proj1_sess1")
        self.assertEqual(self.p.pending_count(), 0)
        self.assertIsNone(self.p.pop("proj1", shot_id="sh1"))  # 同一登记的双键一并清除
        self.assertIsNone(self.p.pop("proj1", shot_index=2))

    def test_no_session_id_is_ignored(self):
        self.p.register("proj1", "sh1", 1, "")
        self.assertEqual(self.p.pending_count(), 0)

    def test_stale_entries_expire(self):
        self.p.register("proj2", "sh2", None, "s2")
        with self.p._LOCK:
            for e in self.p._PENDING.values():
                e.created_at -= self.p.TTL_SECONDS + 1
        self.assertEqual(self.p.pending_count(), 0)
        self.assertIsNone(self.p.pop("proj2", shot_id="sh2"))

    def test_project_isolation(self):
        self.p.register("projA", "sh1", 1, "sessA")
        self.assertIsNone(self.p.pop("projB", shot_id="sh1"))
        self.assertIsNotNone(self.p.pop("projA", shot_id="sh1"))


class TestClayResultRoute(unittest.TestCase):
    """POST /agent/stage/clay-result：回执路由接线与对账（无登记不打扰任何会话）。"""

    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
            from app import main as main_mod
        except Exception as e:
            raise unittest.SkipTest(f"TestClient / app.main 不可用: {e}")
        cls.client = TestClient(main_mod.app)

    def setUp(self):
        from app.director_stage import pending
        self.p = pending
        with pending._LOCK:
            pending._PENDING.clear()

    def tearDown(self):
        with self.p._LOCK:
            self.p._PENDING.clear()

    def test_no_pending_returns_no_pending(self):
        r = self.client.post("/api/v1/agent/stage/clay-result", json={
            "project_id": "proj_x", "shot_id": "sh1", "shot_index": 1,
            "ok": True, "video_url": "/storage/videos/x.mp4",
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("status"), "no_pending")

    def test_pending_without_live_session_consumes_and_returns_no_session(self):
        self.p.register("proj_x", "sh1", 1, "proj_proj_x_sess_dead")
        r = self.client.post("/api/v1/agent/stage/clay-result", json={
            "project_id": "proj_x", "shot_id": "sh1", "shot_index": 1,
            "ok": True, "video_url": "/storage/videos/x.mp4", "secs": 2.5,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("status"), "no_session")
        self.assertEqual(self.p.pending_count(), 0)
        # 回执被消费：同一登记再来一次就是 no_pending（不会重复唤醒）
        r2 = self.client.post("/api/v1/agent/stage/clay-result", json={
            "project_id": "proj_x", "shot_id": "sh1",
        })
        self.assertEqual(r2.json().get("status"), "no_pending")


class TestMcpSurface(unittest.TestCase):
    def test_tools_registered(self):
        from app.mcp.server import mcp_registry
        names = {t.name for t in mcp_registry.get_all_tools()}
        self.assertIn("stage_get_state", names)
        self.assertIn("stage_control", names)
        self.assertIn("stage_export_clay", names)

    def test_mode_policy_entries(self):
        from app.agent import mode_policy
        self.assertIn("stage_get_state", mode_policy.PLAN_READONLY_TOOLS)
        self.assertNotIn("stage_control", mode_policy.PLAN_READONLY_TOOLS)
        self.assertEqual(mode_policy.tool_risk("stage_get_state"), "low")
        self.assertEqual(mode_policy.tool_risk("stage_control"), "medium")

    def test_white_model_skill_loads(self):
        from app.skills.engine import skill_engine
        sk = skill_engine.get_skill("seedance-white-model")
        self.assertIsNotNone(sk, "白模工作流技能应随项目内置加载")
        self.assertIn("@video1", sk.instructions or "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
