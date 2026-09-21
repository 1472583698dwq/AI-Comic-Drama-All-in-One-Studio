# -*- coding: utf-8 -*-
"""技能系统回归测试（stdlib unittest，零外部依赖）。

运行： python -m unittest tests.test_skill_engine -v
钉住四件曾经漏过的事：
- 扫描边界不出项目（外部目录必须显式声明）；
- 「可用性」只有一个口径，list / read / execute 共用；
- 执行结果状态由真实工具调用决定，不许恒定 success；
- 技能索引常驻系统提示（只有目录，正文仍按需 read_skill）。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.skills import engine as eng  # noqa: E402


def _run(coro):
    # 别的测试模块会关掉当前 loop，get_event_loop() 在 3.13 上会直接抛错
    return asyncio.run(coro)


def _write_skill(root: str, name: str, *, enabled=True, desc="测试技能", tools=None) -> str:
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    fp = os.path.join(d, "SKILL.md")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(
            "---\n"
            f"name: {name}\n"
            f"description: {desc}\n"
            "category: test\n"
            f"tools: {tools or []}\n"
            f"enabled: {'true' if enabled else 'false'}\n"
            "---\n\n# SOP\n步骤一\n"
        )
    return fp


class TestSkillScope(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skilltest_")
        self._orig_env = os.environ.get("STUDIO_SKILL_EXTRA_DIRS")

    def tearDown(self):
        if self._orig_env is None:
            os.environ.pop("STUDIO_SKILL_EXTRA_DIRS", None)
        else:
            os.environ["STUDIO_SKILL_EXTRA_DIRS"] = self._orig_env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_scan_stays_inside_project(self):
        e = eng.SkillEngine()
        roots = [os.path.normpath(d) for d in e.search_dirs()]
        self.assertTrue(roots, "默认扫描根不该为空")
        for d in roots:
            self.assertTrue(d.startswith(os.path.normpath(eng._REPO_ROOT)),
                            f"默认不该扫项目外目录: {d}")
        home = os.path.normpath(os.path.expanduser("~"))
        self.assertFalse(any(d.startswith(home) for d in roots), "不该再扫 ~/.gemini 等外部技能")

    def test_extra_dirs_are_opt_in(self):
        _write_skill(self.tmp, "outsider", desc="项目外技能")
        e = eng.SkillEngine()
        self.assertIsNone(e.get_skill("outsider"), "未声明 env 就该看不见外部技能")
        os.environ["STUDIO_SKILL_EXTRA_DIRS"] = self.tmp
        e2 = eng.SkillEngine()
        sk = e2.get_skill("outsider")
        self.assertIsNotNone(sk, "声明后应能加载")
        self.assertTrue(sk.external, "外部技能必须带 external 标记")
        self.assertIn("outsider", {s.name for s in e2.active_skills()},
                      "显式声明的外部技能就该可用（否则声明无意义）")

    def test_project_skill_wins_name_collision(self):
        dup = os.path.join(self.tmp, "dup")
        _write_skill(dup, "provider-factory", desc="顶名伪装技能")
        os.environ["STUDIO_SKILL_EXTRA_DIRS"] = dup
        e = eng.SkillEngine()
        self.assertNotIn("顶名伪装", e.get_skill("provider-factory").description)
        self.assertTrue(any("重名" in x for x in e.load_errors), "重名要被记下来，不能静默丢弃")


class TestUsability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skilluse_")
        _write_skill(self.tmp, "live-skill", desc="可用技能")
        _write_skill(self.tmp, "off-skill", desc="被关闭的技能", enabled=False)
        self.engine = eng.SkillEngine(skills_dir=self.tmp)
        # 保证项目自带技能也在（同名时项目优先不影响这两个）
        self.assertTrue(self.engine.get_skill("off-skill"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_frontmatter_enabled_excluded_from_active(self):
        names = {s.name for s in self.engine.active_skills()}
        self.assertIn("live-skill", names)
        self.assertNotIn("off-skill", names)
        self.assertIn("off-skill", {s.name for s in self.engine.list_skills()},
                      "全量列表要仍看得见，否则用户没法改回 enabled")
        ok, why = self.engine.is_usable("off-skill")
        self.assertFalse(ok)
        self.assertIn("enabled: false", why)

    def test_guard_disabled_excluded(self):
        import app.extensions.guard as guard
        orig = guard.is_enabled
        try:
            guard.is_enabled = lambda kind, local_id, project_id=None: False
            self.assertNotIn("live-skill", {s.name for s in self.engine.active_skills()})
            ok, why = self.engine.is_usable("live-skill")
            self.assertFalse(ok)
            self.assertIn("停用", why)
        finally:
            guard.is_enabled = orig

    def test_execute_honors_usability(self):
        res = _run(
            self.engine.execute_skill("off-skill", {}))
        self.assertEqual(res.status, "error")
        self.assertIn("enabled: false", res.result_message)
        res2 = _run(
            self.engine.execute_skill("no-such-skill", {}))
        self.assertEqual(res2.status, "error")
        self.assertIn("未找到", res2.result_message)

    def test_brief_has_names_not_bodies(self):
        brief = self.engine.skill_brief()
        self.assertIn("live-skill", brief)
        self.assertNotIn("off-skill", brief)
        self.assertNotIn("步骤一", brief, "索引只给一句话描述，正文留给 read_skill")

    def test_brief_respects_max_chars(self):
        self.assertLessEqual(len(self.engine.skill_brief(max_chars=30)), 30)


class TestExecuteStatus(unittest.TestCase):
    def test_status_follows_tool_outcome(self):
        """出图/配音失败时不能再报 success（以前恒定 success）。"""
        from app.mcp.server import mcp_registry
        engine = eng.SkillEngine()
        if engine.get_skill("character-3view-consistency") is None:
            self.skipTest("项目技能缺失")
        orig = mcp_registry.execute_tool

        async def failing(tool_name, args, *a, **kw):
            class R:
                status = "error"
                result = None
                error = "ComfyUI 未连接"
            return R()
        try:
            mcp_registry.execute_tool = failing
            res = _run(
                engine.execute_skill("character-3view-consistency", {"character_name": "主角"}))
        finally:
            mcp_registry.execute_tool = orig
        self.assertEqual(res.status, "error", "工具失败必须反映到技能状态")
        self.assertIn("失败", res.result_message)


class TestAgentSurface(unittest.TestCase):
    def test_skill_index_in_system_prompt(self):
        from app.agent.runtime.prompt import build_system_prompt
        p = build_system_prompt(run_mode="approve")
        self.assertIn("技能库索引", p)
        self.assertIn("read_skill", p)
        self.assertIn("provider-factory", p, "真实技能名要出现在索引里")
        self.assertNotIn("步骤一", p)

    def test_read_skill_lists_only_active(self):
        from app.mcp.server import mcp_registry
        from app.skills.engine import skill_engine
        res = _run(
            mcp_registry.execute_tool("read_skill", {}))
        self.assertEqual(res.status, "success")
        listed = {s["name"] for s in res.result["skills"]}
        self.assertEqual(listed, {s.name for s in skill_engine.active_skills()},
                         "模型看到的技能清单必须与可执行清单同口径")

    def test_read_skill_refuses_disabled(self):
        from app.mcp.server import mcp_registry
        import app.extensions.guard as guard
        orig = guard.is_enabled
        try:
            guard.is_enabled = lambda kind, local_id, project_id=None: local_id != "provider-author"
            res = _run(
                mcp_registry.execute_tool("read_skill", {"name": "provider-author"}))
        finally:
            guard.is_enabled = orig
        self.assertEqual(res.status, "error")
        self.assertIn("不可用", str(res.error))


if __name__ == "__main__":
    unittest.main(verbosity=2)
