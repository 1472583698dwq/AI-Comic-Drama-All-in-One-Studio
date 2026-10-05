# -*- coding: utf-8 -*-
"""一键成片「简化流程」回归测试（stdlib unittest，零外部依赖）。

运行：python -m unittest discover -s tests -p "test_onekey_default_flow.py"
覆盖：角色资产复用、多参考收集（多角色/多视图/上限）、风格锁定（LLM 失败回退预设）、
角色表生成写回、按 character_ids 精确匹配出场角色。
"""
import asyncio
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.pipelines import onekey_agent as OK  # noqa: E402

_LOOP = None


def run(coro):
    """显式复用测试事件循环（避免跨模块 get_event_loop 状态漂移）。"""
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP.run_until_complete(coro)


def _char(cid, name, views=None, avatar="", visual=""):
    return SimpleNamespace(id=cid, name=name, three_views=views or {},
                           avatar_url=avatar, visual_prompt=visual, description="",
                           role="protagonist", gender="male", voice_id="", ref_audio_url="")


def _shot(idx, text="", cids=None, scene_index=1):
    return SimpleNamespace(id=f"sh{idx}", shot_index=idx, action_desc=text,
                           image_prompt="", dialogue="", camera_framing="medium",
                           camera_motion="push_in", video_prompt="", scene_index=scene_index,
                           character_ids=cids, image_url="", video_url="", audio_url="")


def _scene(idx=1, ref="", props=None, location="大殿"):
    return SimpleNamespace(id=f"sc{idx}", scene_index=idx, title=f"场景{idx}", location=location,
                           time_of_day="dusk", atmosphere="epic", image_prompt="empty hall",
                           props=props or [], ref_image_url=ref)


def _draft(chars=None, shots=None, scenes=None):
    return OK.OneKeyDraft(
        id="d_test", title="t", novel_text="x",
        project=SimpleNamespace(characters=chars or [],
                                scenes=scenes if scenes is not None else [SimpleNamespace(shots=shots or [])]),
    )


class TestCharacterRefs(unittest.TestCase):
    def test_refs_order_and_dedup(self):
        c = _char("c1", "林野", views={"front": "/f.png", "side": "/s.png", "three_quarter": "/q.png"},
                  avatar="/a.png")
        refs = OK._character_refs(c, limit=3)
        self.assertEqual(refs, ["/f.png", "/q.png", "/s.png"])  # front > three_quarter > side，avatar 被限位剪掉
        refs2 = OK._character_refs(c, limit=4)
        self.assertEqual(refs2, ["/f.png", "/q.png", "/s.png", "/a.png"])

    def test_refs_avatar_only(self):
        c = _char("c1", "林野", avatar="/a.png")
        self.assertEqual(OK._character_refs(c), ["/a.png"])

    def test_collect_shot_refs_multi_char_and_cap(self):
        a = _char("c1", "甲", views={"front": "/a1.png", "side": "/a2.png", "three_quarter": "/a3.png"})
        b = _char("c2", "乙", views={"front": "/b1.png", "side": "/b2.png", "three_quarter": "/b3.png"})
        shot = _shot(1, "甲和乙对打", cids=["c1", "c2"])
        refs = OK.collect_shot_refs(shot, [a, b], per_char=3, total=6)
        # 视图顺序 front > three_quarter > side
        self.assertEqual(refs, ["/a1.png", "/a3.png", "/a2.png", "/b1.png", "/b3.png", "/b2.png"])
        refs_small = OK.collect_shot_refs(shot, [a, b], per_char=2, total=3)
        self.assertEqual(refs_small, ["/a1.png", "/a3.png", "/b1.png"])

    def test_character_ids_win_over_name(self):
        a = _char("c1", "甲")
        b = _char("c2", "乙")
        shot = _shot(1, "甲在说话", cids=["c2"])
        hit = OK._mentioned_roles_by_ids(shot, [a, b])
        self.assertEqual([c.id for c in hit], ["c2"])

    def test_scene_ref_after_characters(self):
        a = _char("c1", "甲", views={"front": "/a1.png", "side": "/a2.png"})
        sc = _scene(1, ref="/scene1.png")
        shot = _shot(1, "甲站在殿中", cids=["c1"])
        refs = OK.collect_shot_refs(shot, [a], scene=sc, per_char=2, total=5)
        self.assertEqual(refs[0], "/a1.png")               # 角色资产优先（单槽源先吃角色）
        self.assertIn("/scene1.png", refs)

    def test_scene_of_shot_matches_index(self):
        sc1 = _scene(1)
        sc2 = _scene(2)
        d = _draft(chars=[], scenes=[sc1, sc2])
        shot = _shot(1, scene_index=2)
        self.assertIs(OK._scene_of_shot(d, shot), sc2)


class TestRefCapabilityWarning(unittest.TestCase):
    def test_video_warning_when_no_image_slots(self):
        d = _draft()
        orig = OK._provider_image_slots
        OK._provider_image_slots = lambda pid: 0
        try:
            w = OK._ref_capability_warning(d, "video_src", ["/a.png"])
        finally:
            OK._provider_image_slots = orig
        self.assertIn("视频源", w)
        self.assertIn("video_src", w)

    def test_no_warning_when_slots_available_or_unknown(self):
        d = _draft()
        orig = OK._provider_image_slots
        try:
            OK._provider_image_slots = lambda pid: 2
            self.assertEqual(OK._ref_capability_warning(d, "p", ["/a.png"]), "")
            OK._provider_image_slots = lambda pid: None
            self.assertEqual(OK._ref_capability_warning(d, "p", ["/a.png"]), "")
        finally:
            OK._provider_image_slots = orig
        self.assertEqual(OK._ref_capability_warning(d, "p", []), "")

    def test_image_ref_note_is_informational(self):
        self.assertIn("文生图", OK._image_ref_note("t2i_src", 0))     # 文生图是正常流程，不是告警
        self.assertIn("支持参考图", OK._image_ref_note("edit_src", 2))
        self.assertEqual(OK._image_ref_note("unknown", None), "")

    def test_effective_refs_truncates_by_slots(self):
        orig = OK._provider_image_slots
        try:
            OK._provider_image_slots = lambda pid: 1
            refs, slots = OK._effective_refs("p", ["/a.png", "/b.png", "/c.png"])
            self.assertEqual(refs, ["/a.png"])          # 单槽源只吃 1 张（如实裁剪）
            self.assertEqual(slots, 1)
            OK._provider_image_slots = lambda pid: 0
            refs0, slots0 = OK._effective_refs("p", ["/a.png"])
            self.assertEqual(refs0, [])
            self.assertEqual(slots0, 0)
            OK._provider_image_slots = lambda pid: None
            refs_n, slots_n = OK._effective_refs("p", ["/a.png", "/b.png"])
            self.assertEqual(refs_n, ["/a.png", "/b.png"])  # 内置 API 源：无法判断即原样
            self.assertIsNone(slots_n)
        finally:
            OK._provider_image_slots = orig
        self.assertEqual(OK._effective_refs("p", [])[0], [])


class TestStyleLock(unittest.TestCase):
    def test_style_lock_falls_back_to_preset(self):
        d = _draft()
        orig = None
        try:
            from app.pipelines import llm_service as LS

            async def _boom(**_kw):
                raise RuntimeError("llm down")

            orig = getattr(LS.llm_service, "chat_json", None)
            LS.llm_service.chat_json = _boom
            res = run(OK._onekey_style_lock(d))
        finally:
            if orig is not None:
                from app.pipelines import llm_service as LS2
                LS2.llm_service.chat_json = orig
        self.assertEqual(res["status"], "locked")
        self.assertEqual(res["source"], "preset_fallback")
        self.assertTrue(d.style_spec)

    def test_style_suffix_attached(self):
        d = _draft()
        self.assertEqual(OK._style_suffix(d), "")
        d.style_spec = "cel shading, clean lineart"
        self.assertIn("cel shading", OK._style_suffix(d))


class TestRoleAssetReuse(unittest.TestCase):
    def test_reuse_existing_assets(self):
        c = _char("c1", "林野", views={"front": "/f.png", "three_quarter": "/q.png"})
        d = _draft(chars=[c])
        res = run(OK._onekey_role_image(d, "林野"))
        self.assertEqual(res["status"], "reused")
        self.assertEqual(res["views_count"], 2)
        self.assertIn("林野", d.assets_reused)
        # 不传 force 时不生成新图（image_url 为已存在资产）
        self.assertEqual(res["image_url"], "/f.png")

    def test_missing_character_errors(self):
        d = _draft(chars=[_char("c1", "林野")])
        res = run(OK._onekey_role_image(d, "不存在"))
        self.assertIn("error", res)


class TestVideoR2V(unittest.TestCase):
    """默认简化流程：没有分镜画面时用角色/场景资产直接参考生视频（r2v）。"""

    def _run_video(self, d, shot_index=1, prompt_override=""):
        from app.pipelines import unified_orchestrator as UO
        captured = {}

        class FakeRegistry:
            async def generate(self, req, provider_id=None):
                captured["req"] = req
                return SimpleNamespace(video_url="/storage/generated/v1.mp4", task_id=None)

        orig = UO._get_video_registry
        UO._get_video_registry = lambda: FakeRegistry()
        try:
            out = run(OK._onekey_shot_video(d, shot_index, prompt_override))
        finally:
            UO._get_video_registry = orig
        return out, captured.get("req")

    def test_r2v_with_character_assets_only(self):
        c = _char("c1", "林野", views={"front": "/f.png", "side": "/s.png"})
        sc = _scene(1, ref="/scene1.png")
        shot = _shot(1, "林野推门而入", cids=["c1"])
        d = _draft(chars=[c], scenes=[sc])
        # 把 shot 放进场景
        sc.shots = [shot]
        out, req = self._run_video(d, 1)
        self.assertEqual(out.get("status"), "done")
        self.assertEqual(req.mode, "r2v")                 # 无画面 → 参考生视频
        self.assertIsNone(req.first_frame_url)
        self.assertTrue(req.reference_images)             # 角色/场景资产作为参考
        self.assertIn("/f.png", req.reference_images)

    def test_i2v_when_shot_image_exists(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "林野推门而入", cids=["c1"])
        shot.image_url = "/keyframe.png"
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        out, req = self._run_video(d, 1)
        self.assertEqual(out.get("status"), "done")
        self.assertEqual(req.mode, "i2v")
        self.assertEqual(req.first_frame_url, "/keyframe.png")

    def test_no_assets_and_no_image_errors(self):
        shot = _shot(1, "空镜")
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[], scenes=[sc])
        out = run(OK._onekey_shot_video(d, 1))
        self.assertIn("error", out)

    def test_prompt_override_h3_structured_used_as_is(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "林野推门而入", cids=["c1"])
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        draft_prompt = ("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
                        "integrated_multimodal_description: [Shot 1] 2D-animated, <Subject 1> ...\n\n"
                        "overall_soundscape: Quiet room tone.\n\nnon_diegetic_music: N/A")
        out, req = self._run_video(d, 1, prompt_override=draft_prompt)
        self.assertEqual(out.get("status"), "done")
        self.assertTrue(req.prompt.startswith("For the target video"))
        self.assertIn("integrated_multimodal_description", req.prompt)
        # H3 结构化提示词不再追加风格后缀（避免破坏三段结构）
        self.assertNotIn("masterpiece", req.prompt)

    def test_prompt_override_plain_text_gets_style_suffix(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "林野推门而入", cids=["c1"])
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        d.style_spec = "ink linework, cel shading"
        out, req = self._run_video(d, 1, prompt_override="she pushes the door open")
        self.assertIn("she pushes the door open", req.prompt)
        self.assertIn("ink linework", req.prompt)


class TestVideoAsyncBridge(unittest.TestCase):
    """异步视频任务必须接入统一任务轮询（TaskCenter）并可回写草稿（历史事故：videos_async 永不落定）。"""

    def _patch_task_dir(self):
        import tempfile
        from pathlib import Path
        from app.providers import tasks as tasks_mod
        self._tasks_mod = tasks_mod
        self._orig_dir = tasks_mod._tasks_dir
        self._tmp = Path(tempfile.mkdtemp(prefix="ok_taskcenter_"))
        tasks_mod._tasks_dir = lambda: self._tmp
        self._tc = tasks_mod.task_center
        self._orig_spawn = self._tc._spawn_poller
        self._tc._spawn_poller = lambda rec: None  # 测试里不真起轮询协程（避免 loop 关闭告警）

    def _restore(self):
        self._tasks_mod._tasks_dir = self._orig_dir
        self._tc._spawn_poller = self._orig_spawn

    def _draft_with_shot(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "林野推门而入", cids=["c1"])
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        OK._DRAFTS[d.id] = d  # 回写依赖草稿在册
        self.addCleanup(lambda: OK._DRAFTS.pop(d.id, None))
        return d, shot

    def test_submit_registers_taskcenter_and_note(self):
        from app.pipelines import unified_orchestrator as UO

        class FakeRegistry:
            async def generate(self, req, provider_id=None):
                return SimpleNamespace(video_url="", task_id="tid_bridge_1")

        d, shot = self._draft_with_shot()
        self._patch_task_dir()
        orig = UO._get_video_registry
        UO._get_video_registry = lambda: FakeRegistry()
        try:
            out = run(OK._onekey_shot_video(d, 1))
        finally:
            UO._get_video_registry = orig
        try:
            self.assertEqual(out.get("status"), "submitted")
            self.assertIn("task_status", out.get("note") or "")
            self.assertEqual(d.video_pending, [{"shot_index": 1, "task_id": "tid_bridge_1"}])
            rec = self._tc.status("tid_bridge_1")
            self.assertIsNotNone(rec)  # 已注册 → task_status/task_wait 可查
            # 终态回写：成片写回 shot 并从 pending 移除（真实 watcher 由 settle 唤醒）
            rec.video_url = "/storage/videos/ok1.mp4"
            self._tc._settle(rec, "SUCCESS")
            run(asyncio.sleep(0.05))
            self.assertEqual(shot.video_url, "/storage/videos/ok1.mp4")
            self.assertEqual(d.video_pending, [])
        finally:
            self._restore()

    def test_sync_pending_writes_back_and_fails(self):
        d, shot = self._draft_with_shot()
        self._patch_task_dir()
        try:
            tc = self._tc
            ok_rec = tc.register("tid_sync_ok", "prov_x", "video")
            ok_rec.video_url = "/storage/videos/ok2.mp4"
            ok_rec.status = "SUCCESS"
            bad_rec = tc.register("tid_sync_bad", "prov_x", "video")
            bad_rec.status = "FAILED"
            bad_rec.error = "审核不通过"
            d.video_pending.extend([
                {"shot_index": 1, "task_id": "tid_sync_ok"},
                {"shot_index": 2, "task_id": "tid_sync_bad"},
            ])
            OK._sync_pending_videos(d)
            self.assertEqual(shot.video_url, "/storage/videos/ok2.mp4")
            self.assertEqual(d.video_pending, [])
            self.assertTrue(any("审核不通过" in str(x.get("error")) for x in d.video_fail))
        finally:
            self._restore()


class TestReviewTool(unittest.TestCase):
    """产物验收清单：图片/视频生成后必须检查（onekey_review + view_media）。"""

    def _build_draft(self):
        c = _char("c1", "林野", views={"front": "/f.png", "side": "/s.png"}, visual="黑发少年，青衫")
        sc = _scene(1, ref="/scene1.png", props=["香炉"])
        shot = _shot(1, "林野推门而入", cids=["c1"])
        shot.video_url = "/storage/videos/v1.mp4"
        sc.shots = [shot]
        return _draft(chars=[c], scenes=[sc])

    def test_review_lists_assets_and_shots(self):
        d = self._build_draft()
        res = OK._onekey_review(d, "all", 10)
        kinds = [i["kind"] for i in res["items"]]
        self.assertIn("character", kinds)
        self.assertIn("scene", kinds)
        self.assertIn("shot_video", kinds)
        vid = next(i for i in res["items"] if i["kind"] == "shot_video")
        self.assertEqual(vid["ref"], "/storage/videos/v1.mp4")
        self.assertIn("/f.png", vid["refs"])              # 角色参考随条目下发（对比一致性）
        ch = next(i for i in res["items"] if i["kind"] == "character")
        self.assertEqual(ch["ref"], "/f.png")
        self.assertTrue(ch["criteria"] and ch["requirement"])
        scene = next(i for i in res["items"] if i["kind"] == "scene")
        self.assertIn("香炉", scene["requirement"])

    def test_review_scope_and_limit(self):
        d = self._build_draft()
        res = OK._onekey_review(d, "characters", 1)
        self.assertTrue(res["items"])
        self.assertTrue(all(i["kind"] == "character" for i in res["items"]))
        res2 = OK._onekey_review(d, "shots", 10)
        self.assertTrue(all(i["kind"].startswith("shot") for i in res2["items"]))

    def test_review_skips_unprepared_products(self):
        sc = _scene(1)  # 无参考图
        sc.shots = [_shot(1, "空镜")]
        d = _draft(chars=[], scenes=[sc])
        res = OK._onekey_review(d, "all", 10)
        self.assertEqual(res["items"], [])


class TestBasePromptComposer(unittest.TestCase):
    """兜底组合器：六要素结构化提示词（prompt-basics 技能），替代"台本一句词直出"。"""

    def test_compose_contains_six_elements(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "推门而入，环顾教室", cids=["c1"])
        sc = _scene(1, ref="/s.png", props=["搪瓷杯", "粉笔"], location="山村教室")
        sc.time_of_day = "dusk"
        d = _draft(chars=[c], scenes=[sc])
        d.style_spec = "ink linework, cel shading"
        p = OK._compose_base_video_prompt(d, shot, sc)
        self.assertIn("林野", p)             # 主体（带角色名）
        self.assertIn("推门而入", p)         # 动作
        self.assertIn("山村教室", p)         # 环境
        self.assertIn("搪瓷杯", p)           # 道具
        self.assertIn("golden-hour", p)      # 光线（dusk → warm golden-hour light）
        self.assertIn("medium shot", p)      # 运镜（景别）
        self.assertIn("push-in", p)          # 运镜（运动）
        self.assertIn("ink linework", p)     # 风格

    def test_compose_i2v_keeps_first_frame_note(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "转身走向窗边", cids=["c1"])
        shot.image_url = "/keyframe.png"
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        p = OK._compose_base_video_prompt(d, shot, sc)
        self.assertIn("保持首帧", p)         # i2v：不重复画面，只写运动
        self.assertNotIn("与参考图同一角色", p)

    def test_shot_video_uses_composer_when_no_prompt(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        shot = _shot(1, "推门而入", cids=["c1"])
        sc = _scene(1); sc.shots = [shot]
        d = _draft(chars=[c], scenes=[sc])
        d.style_spec = "cel shading"
        from app.pipelines import unified_orchestrator as UO
        captured = {}

        class FakeRegistry:
            async def generate(self, req, provider_id=None):
                captured["req"] = req
                return SimpleNamespace(video_url="/v.mp4", task_id=None)

        orig = UO._get_video_registry
        UO._get_video_registry = lambda: FakeRegistry()
        try:
            run(OK._onekey_shot_video(d, 1))
        finally:
            UO._get_video_registry = orig
        self.assertIn("镜头：", captured["req"].prompt)   # 结构化兜底
        self.assertIn("cel shading", captured["req"].prompt)


class TestSceneAssetReuse(unittest.TestCase):
    def test_reuse_existing_scene_ref(self):
        sc = _scene(1, ref="/scene1.png", props=["香炉"])
        d = _draft(scenes=[sc])
        res = run(OK._onekey_scene_image(d, 1))
        self.assertEqual(res["status"], "reused")
        self.assertEqual(res["image_url"], "/scene1.png")

    def test_missing_scene_errors(self):
        d = _draft(scenes=[_scene(1)])
        res = run(OK._onekey_scene_image(d, 9))
        self.assertIn("error", res)

    def test_summary_reports_scene_assets(self):
        sc1 = _scene(1, ref="/scene1.png")
        sc2 = _scene(2)
        d = _draft(chars=[], scenes=[sc1, sc2])
        s = OK._onekey_summary(d)
        self.assertEqual(s["scenes"]["total"], 2)
        self.assertEqual(s["scenes"]["ready"], 1)
        self.assertEqual(s["scenes"]["pending"], [2])


class TestSummaryStyle(unittest.TestCase):
    def test_summary_reports_style_and_reuse(self):
        c = _char("c1", "林野", views={"front": "/f.png"})
        d = _draft(chars=[c], shots=[_shot(1)])
        d.style_spec = "cel shading"
        d.assets_reused.append("林野")
        s = OK._onekey_summary(d)
        self.assertTrue(s["style"]["locked"])
        self.assertEqual(s["style"]["assets_reused"], ["林野"])


if __name__ == "__main__":
    unittest.main()
