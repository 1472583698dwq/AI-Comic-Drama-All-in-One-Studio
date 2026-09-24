# -*- coding: utf-8 -*-
"""导演组扩展（agent_teams）：自定义剧组角色（agent_profile）与导演组编排（agent_team）。

- 存储为裸件 JSON（storage/agent_profiles/、storage/agent_teams/），与 director_pack 同构；
- 插件可通过 plugin.json 的 extensionPoints.agent_profiles / agent_teams 贡献；
- 运行时由 app.agent.runtime.agents 合并进内置角色表（外部 override 语义见模型字段）。
"""
from app.agent_teams.manager import (  # noqa: F401
    agent_team_manager,
    list_effective_profiles,
    list_effective_teams,
    render_playbook,
    validate_team_members,
)
from app.agent_teams.models import (  # noqa: F401
    DELEGATE_TOOLS,
    AgentProfileSpec,
    AgentTeamSpec,
    MANIFEST_TEMPLATES,
)
