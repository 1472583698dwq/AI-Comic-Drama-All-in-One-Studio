# -*- coding: utf-8 -*-
"""导演组扩展 HTTP API — 角色画像 / 导演组的列表、声明模板、保存、删除。

- 角色（agent_profile）：自定义专家子代理（工具白名单，禁止委派类工具）；
- 导演组（agent_team）：成员名单 + 总导演编排脚本（playbook）+ 默认参数 + 质检门；
- 两者均支持插件贡献（plugin.json extensionPoints）与裸件落盘，重名需显式 override。
"""
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException, Query

from app.agent_teams.manager import (
    agent_team_manager,
    list_effective_profiles,
    list_effective_teams,
    validate_team_members,
)
from app.agent_teams.models import AgentProfileSpec, AgentTeamSpec, MANIFEST_TEMPLATES

router = APIRouter()


# ── 角色画像 ─────────────────────────────────────────────
@router.get("/agent-profiles")
async def list_agent_profiles(project_id: str = Query(default=""),
                              include_disabled: bool = Query(default=False)):
    specs = (agent_team_manager.list_profiles() if include_disabled
             else list_effective_profiles(project_id or "", include_disabled=False))
    catalog: list = []
    errors: list = []
    try:
        from app.agent.runtime.agents import external_load_errors, profile_catalog
        catalog = profile_catalog(include_internal=True)
        errors = external_load_errors()
    except Exception:
        pass
    return {"profiles": [s.model_dump() for s in specs], "total": len(specs),
            "catalog": catalog, "errors": errors}


@router.get("/agent-profiles/spec")
async def agent_profile_spec():
    return {"template": MANIFEST_TEMPLATES["profile"], "contract": MANIFEST_TEMPLATES["contract"]}


@router.post("/agent-profiles")
async def save_agent_profile(payload: Dict[str, Any] = Body(...)):
    try:
        spec = AgentProfileSpec.model_validate(payload)
        saved = agent_team_manager.save_profile(spec)
        return {"status": "success", "profile": saved.model_dump()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"角色声明非法: {e}")


@router.delete("/agent-profiles/{pid}")
async def delete_agent_profile(pid: str):
    if not agent_team_manager.delete_profile(pid):
        raise HTTPException(status_code=404, detail=f"角色不存在: {pid}")
    return {"status": "deleted", "id": pid}


@router.get("/agent-profiles/{pid}")
async def get_agent_profile(pid: str):
    spec = agent_team_manager.get_profile_spec(pid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"角色不存在: {pid}")
    return {"profile": spec.model_dump()}


# ── 导演组 ───────────────────────────────────────────────
@router.get("/agent-teams")
async def list_agent_teams(project_id: str = Query(default=""),
                           include_disabled: bool = Query(default=False)):
    specs = (agent_team_manager.list_teams() if include_disabled
             else list_effective_teams(project_id or "", include_disabled=False))
    return {"teams": [s.model_dump() for s in specs], "total": len(specs)}


@router.get("/agent-teams/spec")
async def agent_team_spec():
    return {"template": MANIFEST_TEMPLATES["team"], "contract": MANIFEST_TEMPLATES["contract"]}


@router.post("/agent-teams")
async def save_agent_team(payload: Dict[str, Any] = Body(...)):
    try:
        spec = AgentTeamSpec.model_validate(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"导演组声明非法: {e}")
    errors = validate_team_members(spec)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))
    saved = agent_team_manager.save_team(spec)
    return {"status": "success", "team": saved.model_dump()}


@router.delete("/agent-teams/{tid}")
async def delete_agent_team(tid: str):
    if not agent_team_manager.delete_team(tid):
        raise HTTPException(status_code=404, detail=f"导演组不存在: {tid}")
    return {"status": "deleted", "id": tid}


@router.get("/agent-teams/{tid}")
async def get_agent_team(tid: str):
    spec = agent_team_manager.get_team(tid)
    if not spec:
        raise HTTPException(status_code=404, detail=f"导演组不存在: {tid}")
    return {"team": spec.model_dump()}
