# -*- coding: utf-8 -*-
"""导演组扩展系统回归测试（stdlib unittest）。

运行： python -m unittest discover -s tests -p "test_*.py"

覆盖：
- AgentProfileSpec 校验（id/工具白名单/委派类拒绝/未知工具/图标配色/步数边界）
- AgentTeamSpec 校验与成员解析（未知成员、qa_gate 约束）
- 管理器 CRUD + 热更新签名 + 覆盖层停用过滤
- 运行时合并（外部画像生效 / 重名拒绝 / override 替换 / 角色目录）
- playbook 占位符渲染 + 一键成片导演提示词（成员约束 + 质检门）
- 扩展中心适配器（两个新 kind 出现在 ADAPTERS 与聚合列表）
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.agent_teams.manager import (  # noqa: E402
    agent_team_manager,
    list_effective_profiles,
    list_effective_teams,
    render_playbook,
    validate_team_members,
)
from app.agent_teams.models import (  # noqa: E402
    AgentProfileSpec,
    AgentTeamSpec,
    MANIFEST_TEMPLATES,
)


def _profile_payload(**kw):
    base = {
        "id": "palette_girl",
        "name": "上色师",
        "description": "分镜上色专家（测试用）",
        "icon": "Palette",
        "color": "pink",
        "system_prompt": "你是上色子代理，只做上色。",
        "allow_tools": ["onekey_summary", "fs_read"],
        "deny_tools": [],
        "max_steps": 20,
        "background_default": False,
    }
    base.update(kw)
    return base


def _team_payload(**kw):
    base = {
        "id": "test_team",
        "name": "测试导演组",
        "description": "测试用导演组",
        "icon": "Users",
        "color": "blue",
        "members": ["screenwriter", "qa_reviewer"],
        "playbook": "任务 {title}，draft_id={draft_id}，画幅 {aspect}。",
        "defaults": {"gen_roles": True, "enable_video": False, "max_images": 8},
        "qa_gate": True,
    }
    base.update(kw)
    return base


class TeamStorageBase(unittest.TestCase):
    """storage 指到临时目录，避免污染真实数据。"""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="agent_teams_")
        from app.core.config import settings as app_settings
        cls._orig_storage = app_settings.STORAGE_DIR
        app_settings.STORAGE_DIR = cls._tmp
        cls._orig_env = os.environ.get("AGENT_SUBAGENT_MAX_CONCURRENCY")
        os.environ["AGENT_SUBAGENT_MAX_CONCURRENCY"] = "2"

    @classmethod
    def tearDownClass(cls):
        from app.core.config import settings as app_settings
        app_settings.STORAGE_DIR = cls._orig_storage
        if cls._orig_env is None:
            os.environ.pop("AGENT_SUBAGENT_MAX_CONCURRENCY", None)
        else:
            os.environ["AGENT_SUBAGENT_MAX_CONCURRENCY"] = cls._orig_env
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def tearDown(self):
        for spec in agent_team_manager.list_profiles():
            agent_team_manager.delete_profile(spec.id)
        for spec in agent_team_manager.list_teams():
            agent_team_manager.delete_team(spec.id)
        try:
            from app.extensions import state
            state.set_disabled("agent_profile:palette_girl", False)
            state.set_disabled("agent_team:test_team", False)
        except Exception:
            pass


class TestProfileModel(TeamStorageBase):
    def test_valid_profile(self):
        spec = AgentProfileSpec.model_validate(_profile_payload())
        self.assertEqual(spec.id, "palette_girl")
        self.assertEqual(spec.allow_tools, ["onekey_summary", "fs_read"])

    def test_bad_id_rejected(self):
        with self.assertRaises(ValueError):
            AgentProfileSpec.model_validate(_profile_payload(id="Bad ID!"))

    def test_empty_allow_tools_rejected(self):
        with self.assertRaises(ValueError):
            AgentProfileSpec.model_validate(_profile_payload(allow_tools=[]))

    def test_delegate_tools_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            AgentProfileSpec.model_validate(_profile_payload(allow_tools=["subagent_run", "fs_read"]))
        self.assertIn("委派类", str(ctx.exception))

    def test_unknown_tool_rejected(self):
        import app.agent_teams.models as M
        orig = M.known_tool_names
        M.known_tool_names = lambda: {"onekey_summary", "fs_read"}
        try:
            with self.assertRaises(ValueError) as ctx:
                AgentProfileSpec.model_validate(_profile_payload(allow_tools=["definitely_not_a_tool"]))
            self.assertIn("未注册工具", str(ctx.exception))
        finally:
            M.known_tool_names = orig

    def test_icon_color_and_steps_bounds(self):
        with self.assertRaises(ValueError):
            AgentProfileSpec.model_validate(_profile_payload(icon="NoSuchIcon"))
        with self.assertRaises(ValueError):
            AgentProfileSpec.model_validate(_profile_payload(color="gold"))
        with self.assertRaises(ValueError):
            AgentProfileSpec.model_validate(_profile_payload(max_steps=999))

    def test_template_is_valid(self):
        spec = AgentProfileSpec.model_validate(MANIFEST_TEMPLATES["profile"])
        self.assertTrue(spec.id)


class TestTeamModel(TeamStorageBase):
    def test_valid_team(self):
        spec = AgentTeamSpec.model_validate(_team_payload())
        self.assertTrue(spec.qa_gate)

    def test_playbook_over_limit_rejected(self):
        with self.assertRaises(ValueError):
            AgentTeamSpec.model_validate(_team_payload(playbook="x" * 9000))

    def test_unknown_member_rejected(self):
        spec = AgentTeamSpec.model_validate(_team_payload(members=["no_such_role"]))
        errors = validate_team_members(spec)
        self.assertTrue(errors)
        self.assertIn("未知成员角色", errors[0])

    def test_qa_gate_requires_reviewer(self):
        spec = AgentTeamSpec.model_validate(_team_payload(members=["screenwriter"]))
        errors = validate_team_members(spec)
        self.assertTrue(any("qa_reviewer" in e for e in errors))

    def test_render_playbook_placeholders(self):
        spec = AgentTeamSpec.model_validate(_team_payload())
        text = render_playbook(spec, {"title": "测试片", "draft_id": "ok_1", "aspect": "9:16"})
        self.assertIn("ok_1", text)
        self.assertIn("测试片", text)
        self.assertIn("9:16", text)
        # 未知占位符原样保留
        spec2 = AgentTeamSpec.model_validate(_team_payload(playbook="值={unknown_key}"))
        self.assertEqual(render_playbook(spec2, {}), "值={unknown_key}")

    def test_template_is_valid(self):
        spec = AgentTeamSpec.model_validate(MANIFEST_TEMPLATES["team"])
        self.assertTrue(spec.id)


class TestManager(TeamStorageBase):
    def test_crud_roundtrip(self):
        spec = agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        self.assertTrue(spec.created_at)
        got = agent_team_manager.get_profile_spec("palette_girl")
        self.assertIsNotNone(got)
        self.assertTrue(agent_team_manager.delete_profile("palette_girl"))
        self.assertIsNone(agent_team_manager.get_profile_spec("palette_girl"))

        team = agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload()))
        self.assertEqual(team.id, "test_team")
        self.assertTrue(agent_team_manager.delete_team("test_team"))

    def test_signature_changes_on_write(self):
        from app.agent_teams.manager import signature
        before = signature()
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        after = signature()
        self.assertNotEqual(before, after)

    def test_overlay_disable_filters_effective(self):
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload(members=["screenwriter"])))
        from app.extensions import state
        state.set_disabled("agent_profile:palette_girl", True)
        state.set_disabled("agent_team:test_team", True)
        self.assertEqual(list_effective_profiles(), [])
        # 内置默认导演组始终存在（可被停用过滤）；文件团队停用后仅剩内置组
        teams = list_effective_teams()
        self.assertEqual([t.id for t in teams], ["studio-default"])
        state.set_disabled("agent_team:studio-default", True)
        self.assertEqual(list_effective_teams(), [])
        # include_disabled 仍可见
        self.assertEqual(len(list_effective_profiles(include_disabled=True)), 1)
        self.assertEqual(len(list_effective_teams(include_disabled=True)), 2)

    def test_builtin_default_team_resolvable_and_overridable(self):
        from app.agent_teams.manager import BUILTIN_TEAMS, get_effective_team, list_effective_teams
        spec = get_effective_team("studio-default")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.playbook, "")  # 简化流程：不写死编排脚本
        self.assertIn("video_operator", spec.members)
        self.assertNotIn("storyboard_artist", spec.members)  # 默认流程不生成分镜画面
        # 文件同名 → 覆盖内置
        agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload(id="studio-default", members=["screenwriter"])))
        overridden = get_effective_team("studio-default")
        self.assertEqual(overridden.members, ["screenwriter"])
        self.assertTrue(BUILTIN_TEAMS["studio-default"].members)


class TestRuntimeMerge(TeamStorageBase):
    def _refresh(self):
        from app.agent.runtime import agents
        agents.refresh_external_profiles(force=True)
        return agents

    def test_external_profile_registered(self):
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        agents = self._refresh()
        prof = agents.get_profile("palette_girl")
        self.assertEqual(prof.name, "palette_girl")
        self.assertTrue(prof.allows("onekey_summary"))
        self.assertFalse(prof.allows("generate_image"))

    def test_builtin_collision_requires_override(self):
        baseline = self._refresh().get_profile("storyboard_artist").system_prompt
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(
            _profile_payload(id="storyboard_artist", name="假分镜画师", override=False)))
        agents = self._refresh()
        # 未 override：仍用内置画像
        self.assertEqual(agents.get_profile("storyboard_artist").system_prompt, baseline)
        errors = agents.external_load_errors()
        self.assertTrue(any("重名" in e for e in errors))

        agent_team_manager.delete_profile("storyboard_artist")
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(
            _profile_payload(id="storyboard_artist", name="自定义分镜", override=True)))
        agents = self._refresh()
        self.assertEqual(agents.get_profile("storyboard_artist").system_prompt, "你是上色子代理，只做上色。")
        self.assertEqual(agents.external_load_errors(), [])

    def test_profile_catalog_marks_source(self):
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        agents = self._refresh()
        catalog = {row["id"]: row for row in agents.profile_catalog(include_internal=True)}
        self.assertEqual(catalog["palette_girl"]["source"], "external")
        self.assertEqual(catalog["palette_girl"]["icon"], "Palette")
        self.assertEqual(catalog["screenwriter"]["source"], "builtin")

    def test_team_brief_member_filter(self):
        agents = self._refresh()
        brief = agents.team_brief(members=["screenwriter", "qa_reviewer"])
        self.assertIn("screenwriter", brief)
        self.assertNotIn("video_operator", brief)
        self.assertIn("成员约束", brief)
        full = agents.team_brief()
        self.assertIn("video_operator", full)


class TestOneKeyTeamPrompt(TeamStorageBase):
    def test_playbook_rendering_and_qa_gate(self):
        from app.api.onekey_routes import OneKeyRunRequest, _director_prompt, _resolve_team
        agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload()))
        req = OneKeyRunRequest(text="x" * 30, title="测试片", aspect_ratio="9:16")
        team = _resolve_team("test_team")
        self.assertIsNotNone(team)
        prompt = _director_prompt("ok_abc", req, team)
        self.assertIn("测试片", prompt)
        self.assertIn("ok_abc", prompt)
        self.assertIn("导演组：测试导演组", prompt)
        self.assertIn("只能委派以下成员", prompt)
        self.assertIn("qa_reviewer", prompt)
        self.assertIn("质检", prompt)

    def test_default_prompt_without_team(self):
        from app.api.onekey_routes import OneKeyRunRequest, _director_prompt
        req = OneKeyRunRequest(text="x" * 30, title="默认片")
        prompt = _director_prompt("ok_def", req, None)
        self.assertIn("ok_def", prompt)
        self.assertIn("subagent_run", prompt)
        self.assertNotIn("只能委派以下成员", prompt)

    def test_prompt_skill_injection(self):
        from app.api.onekey_routes import OneKeyRunRequest, _director_prompt
        req = OneKeyRunRequest(text="x" * 30, title="技能片", prompt_skill="minimax-h3-prompt")
        prompt = _director_prompt("ok_skill", req, None)
        self.assertIn("minimax-h3-prompt", prompt)
        self.assertIn("read_skill", prompt)
        self.assertIn("prompt_override", prompt)
        # 不指定时给推荐技能提示（兜底）
        req2 = OneKeyRunRequest(text="x" * 30, title="自动片")
        prompt2 = _director_prompt("ok_auto", req2, None)
        self.assertIn("prompt-basics", prompt2)

    def test_disabled_team_resolves_none(self):
        from app.api.onekey_routes import _resolve_team
        agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload()))
        from app.extensions import state
        state.set_disabled("agent_team:test_team", True)
        self.assertIsNone(_resolve_team("test_team"))
        state.set_disabled("agent_team:test_team", False)
        self.assertIsNotNone(_resolve_team("test_team"))


class TestExtensionsIntegration(TeamStorageBase):
    def test_new_kinds_registered(self):
        from app.extensions.adapters import ADAPTERS
        from app.extensions.models import ExtensionKind, KIND_LABELS, OVERLAY_LIFECYCLE_KINDS
        self.assertIn(ExtensionKind.AGENT_PROFILE, ADAPTERS)
        self.assertIn(ExtensionKind.AGENT_TEAM, ADAPTERS)
        self.assertIn("agent_profile", KIND_LABELS)
        self.assertIn("agent_team", KIND_LABELS)
        self.assertIn("agent_profile", OVERLAY_LIFECYCLE_KINDS)
        self.assertIn("agent_team", OVERLAY_LIFECYCLE_KINDS)

    def test_adapters_list_contributions(self):
        from app.extensions.adapters import list_agent_profile_extensions, list_agent_team_extensions
        agent_team_manager.save_profile(AgentProfileSpec.model_validate(_profile_payload()))
        agent_team_manager.save_team(AgentTeamSpec.model_validate(_team_payload()))
        profiles = list_agent_profile_extensions()
        teams = list_agent_team_extensions()
        self.assertEqual([p.local_id for p in profiles], ["palette_girl"])
        self.assertEqual(profiles[0].id, "agent_profile:palette_girl")
        self.assertEqual([t.local_id for t in teams], ["test_team"])
        self.assertIn("质检门", teams[0].sub_kind)


class TestPluginContribution(TeamStorageBase):
    """插件贡献导演组成员/导演组 → 启用可见 → 禁用精确回滚。"""

    def _build_pack(self) -> str:
        src = os.path.join(self._tmp, "src", "demo-team-pack")
        os.makedirs(os.path.join(src, "agent_profiles"), exist_ok=True)
        os.makedirs(os.path.join(src, "agent_teams"), exist_ok=True)
        with open(os.path.join(src, "plugin.json"), "w", encoding="utf-8") as f:
            json.dump({
                "id": "demo-team-pack", "name": "导演组演示包", "version": "1.0.0",
                "extensionPoints": {
                    "agent_profiles": ["agent_profiles/*.json"],
                    "agent_teams": ["agent_teams/*.json"],
                },
            }, f, ensure_ascii=False)
        with open(os.path.join(src, "agent_profiles", "colorist.json"), "w", encoding="utf-8") as f:
            json.dump(_profile_payload(id="colorist", name="上色师（插件）"), f, ensure_ascii=False)
        with open(os.path.join(src, "agent_teams", "demo-team.json"), "w", encoding="utf-8") as f:
            json.dump(_team_payload(id="demo_team", name="演示导演组",
                                   members=["colorist"], qa_gate=False), f, ensure_ascii=False)
        return src

    def test_enable_disable_roundtrip(self):
        import app.plugins.manager as pm
        src = self._build_pack()
        orig_root = pm._skills_target_root
        pm._skills_target_root = lambda: os.path.join(self._tmp, "skills_plugins")
        try:
            pm.install_from_dir(src)
            summary = pm.enable("demo-team-pack")
            self.assertEqual([p["id"] for p in summary.get("agent_profiles", [])], ["colorist"])
            self.assertEqual([t["id"] for t in summary.get("agent_teams", [])], ["demo_team"])
            self.assertIn("colorist", [p.id for p in agent_team_manager.list_profiles()])
            self.assertIn("demo_team", [t.id for t in agent_team_manager.list_teams()])

            # 运行时合并可见（含团队成员的 playbook 渲染）
            from app.agent.runtime import agents
            agents.refresh_external_profiles(force=True)
            self.assertEqual(agents.get_profile("colorist").name, "colorist")

            # 扩展中心归属插件（命名空间化 id）
            from app.extensions.adapters import list_agent_profile_extensions, list_agent_team_extensions
            row = next(r for r in list_agent_profile_extensions() if r.local_id == "colorist")
            self.assertEqual(row.source, "plugin")
            self.assertEqual(row.publisher, "demo-team-pack")
            self.assertEqual(row.id, "agent_profile:demo-team-pack/colorist")
            team_row = next(r for r in list_agent_team_extensions() if r.local_id == "demo_team")
            self.assertEqual(team_row.publisher, "demo-team-pack")
        finally:
            pm.disable("demo-team-pack")
            pm._skills_target_root = orig_root

        # 禁用精确回滚
        self.assertNotIn("colorist", [p.id for p in agent_team_manager.list_profiles()])
        self.assertNotIn("demo_team", [t.id for t in agent_team_manager.list_teams()])


if __name__ == "__main__":
    unittest.main()
