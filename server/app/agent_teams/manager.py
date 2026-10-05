# -*- coding: utf-8 -*-
"""导演组管理器 — 文件即仓库：storage/agent_profiles/<id>.json、storage/agent_teams/<id>.json。

与 director_packs/theme/exporter 同构：插件贡献与裸件写同一目录，同名先到先得；
热更新无需显式 reload——运行时 agents.py 按 ``signature()``（目录内容 + mtime）变化自动重建。
"""
import json
import os
import time
from typing import Any, Dict, List, Optional

from app.agent_teams.models import (
    MAX_PROFILES,
    MAX_TEAMS,
    AgentProfileSpec,
    AgentTeamSpec,
)


def _base_root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    return base


def _profiles_root() -> str:
    root = os.path.join(_base_root(), "agent_profiles")
    os.makedirs(root, exist_ok=True)
    return root


def _teams_root() -> str:
    root = os.path.join(_base_root(), "agent_teams")
    os.makedirs(root, exist_ok=True)
    return root


def _profile_path(pid: str) -> str:
    return os.path.join(_profiles_root(), f"{pid}.json")


def _team_path(tid: str) -> str:
    return os.path.join(_teams_root(), f"{tid}.json")


def _dump(spec: Any, path: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(spec.model_dump(), f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


class AgentTeamManager:
    """角色画像与导演组的统一 CRUD（裸件 + 插件贡献共用存储目录）。"""

    # ── 角色画像 ─────────────────────────────────────────
    def list_profiles(self) -> List[AgentProfileSpec]:
        out: List[AgentProfileSpec] = []
        try:
            for fn in sorted(os.listdir(_profiles_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_profiles_root(), fn), "r", encoding="utf-8") as f:
                        out.append(AgentProfileSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out[:MAX_PROFILES]

    def get_profile_spec(self, pid: str) -> Optional[AgentProfileSpec]:
        try:
            with open(_profile_path(pid), "r", encoding="utf-8") as f:
                return AgentProfileSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save_profile(self, spec: AgentProfileSpec) -> AgentProfileSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        _dump(spec, _profile_path(spec.id))
        return spec

    def delete_profile(self, pid: str) -> bool:
        try:
            if os.path.isfile(_profile_path(pid)):
                os.remove(_profile_path(pid))
                return True
        except Exception:
            pass
        return False

    # ── 导演组 ───────────────────────────────────────────
    def list_teams(self) -> List[AgentTeamSpec]:
        out: List[AgentTeamSpec] = []
        try:
            for fn in sorted(os.listdir(_teams_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_teams_root(), fn), "r", encoding="utf-8") as f:
                        out.append(AgentTeamSpec.model_validate(json.load(f)))
                except Exception:
                    continue
        except Exception:
            pass
        return out[:MAX_TEAMS]

    def get_team(self, tid: str) -> Optional[AgentTeamSpec]:
        try:
            with open(_team_path(tid), "r", encoding="utf-8") as f:
                return AgentTeamSpec.model_validate(json.load(f))
        except Exception:
            return None

    def save_team(self, spec: AgentTeamSpec) -> AgentTeamSpec:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not spec.created_at:
            spec.created_at = now
        spec.updated_at = now
        _dump(spec, _team_path(spec.id))
        return spec

    def delete_team(self, tid: str) -> bool:
        try:
            if os.path.isfile(_team_path(tid)):
                os.remove(_team_path(tid))
                return True
        except Exception:
            pass
        return False


agent_team_manager = AgentTeamManager()


# ── 内置默认导演组（简化流程：资产复用 + 多参考 + 风格锁定，不写死步骤）──
# 设计原则（对齐用户口径）：
# - 不再写固定编排脚本（playbook 为空）——流程由总导演 Agent 自主决定；
# - 成员只保留必要专家；角色资产已存在则直接复用，缺失才补；
# - 全片风格一致性交给 onekey_style_lock（大模型生成统一风格规范，自动附加到生图/生视频）。
BUILTIN_TEAMS: Dict[str, AgentTeamSpec] = {
    "studio-default": AgentTeamSpec(
        id="studio-default",
        name="默认简化剧组",
        description="资产复用优先：已有角色三视图/形象直接用作多参考，缺失才补；全片风格锁定；产物自动验收（角色/场景/视频抽检，不合格重做）；流程由总导演自主编排。",
        icon="Zap",
        color="amber",
        members=["screenwriter", "scene_designer", "character_designer", "video_operator", "voice_operator", "editor", "qa_reviewer"],
        playbook="",
        qa_gate=True,
        enabled=True,
    ),
}


def builtin_teams() -> List[AgentTeamSpec]:
    """内置导演组（不可删除；与 storage/agent_teams 同名文件则以文件为准）。"""
    return list(BUILTIN_TEAMS.values())


def _disabled_ids(project_id: str = "") -> set:
    try:
        from app.extensions import state
        return state.effective_disabled(project_id or "")
    except Exception:
        return set()


def _is_disabled(kind: str, local_id: str, ids: set) -> bool:
    try:
        from app.extensions import state
        return state.match_in(kind, local_id, ids) is not None
    except Exception:
        return False


def list_effective_profiles(project_id: str = "", include_disabled: bool = False) -> List[AgentProfileSpec]:
    specs = agent_team_manager.list_profiles()
    if include_disabled:
        return specs
    ids = _disabled_ids(project_id)
    return [s for s in specs if not _is_disabled("agent_profile", s.id, ids)]


def list_effective_teams(project_id: str = "", include_disabled: bool = False) -> List[AgentTeamSpec]:
    specs = agent_team_manager.list_teams()
    file_ids = {s.id for s in specs}
    # 内置导演组在前（文件同名即覆盖内置），停用状态对两者都生效
    merged = [s for s in builtin_teams() if s.id not in file_ids] + specs
    if include_disabled:
        return merged
    ids = _disabled_ids(project_id)
    return [s for s in merged if not _is_disabled("agent_team", s.id, ids)]


def get_effective_team(tid: str) -> Optional[AgentTeamSpec]:
    """取导演组：文件优先，其次内置（供 onekey 默认组解析）。"""
    t = agent_team_manager.get_team(tid)
    if t is not None:
        return t
    return BUILTIN_TEAMS.get(str(tid or ""))


def known_role_ids() -> List[str]:
    """当前可用角色 id（内置 + 外部画像，含 director/generalist）。"""
    try:
        from app.agent.runtime.agents import list_profiles as _runtime_profiles
        names = [p.name for p in _runtime_profiles(include_internal=True)]
        names += [s.id for s in list_effective_profiles()]
        return sorted(set(names))
    except Exception:
        return sorted({s.id for s in list_effective_profiles()})


def validate_team_members(spec: AgentTeamSpec) -> List[str]:
    """成员必须是可用角色（内置或外部画像）；返回错误清单（空 = 通过）。"""
    if not spec.members:
        return []
    known = set(known_role_ids())
    unknown = [m for m in spec.members if m not in known]
    errors: List[str] = []
    if unknown:
        errors.append(f"未知成员角色: {', '.join(sorted(unknown))}（可用: {', '.join(sorted(known))}）")
    if spec.qa_gate and spec.members and "qa_reviewer" not in spec.members:
        errors.append("qa_gate=true 需将 qa_reviewer 加入 members（或留空 members 表示全员可用）")
    return errors


class _SafeDict(dict):
    """format_map 安全字典：未知占位符原样保留（不抛 KeyError）。"""

    def __missing__(self, key: str) -> str:  # noqa: D105
        return "{" + key + "}"


def render_playbook(spec: AgentTeamSpec, context: Dict[str, Any]) -> str:
    """渲染导演组编排脚本：{draft_id}/{title}/{aspect}/{max_images}/{max_videos} 占位符。"""
    text = str(spec.playbook or "")
    if not text:
        return ""
    try:
        return text.format_map(_SafeDict({k: str(v) for k, v in (context or {}).items()}))
    except Exception:
        return text


def signature() -> str:
    """热更新签名：两个目录的文件名/mtime/size + 扩展停用状态文件 mtime。"""
    parts: List[str] = []
    for root in (_profiles_root(), _teams_root()):
        try:
            for fn in sorted(os.listdir(root)):
                if not fn.endswith(".json"):
                    continue
                try:
                    st = os.stat(os.path.join(root, fn))
                    parts.append(f"{fn}:{int(st.st_mtime_ns)}:{st.st_size}")
                except Exception:
                    parts.append(f"{fn}:?")
        except Exception:
            pass
    try:
        state_path = os.path.join(_base_root(), "extensions", "state.json")
        if os.path.isfile(state_path):
            st = os.stat(state_path)
            parts.append(f"__state__:{int(st.st_mtime_ns)}:{st.st_size}")
    except Exception:
        pass
    return "|".join(parts)
