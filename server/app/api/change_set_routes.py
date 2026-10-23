# -*- coding: utf-8 -*-
"""Creator ChangeSet HTTP API：提案 → 试跑 → 应用 / 丢弃 / 回滚。"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.agent import change_sets

router = APIRouter()


class ProposeChangeSetRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=6000)
    project_id: Optional[str] = None


class ChangeSetContext(BaseModel):
    project_id: Optional[str] = None


@router.get("/change-sets")
async def list_change_sets(limit: int = 20):
    return {"change_sets": change_sets.list_change_sets(limit=max(1, min(int(limit or 20), 100)))}


@router.post("/change-sets/propose")
async def propose_change_set(req: ProposeChangeSetRequest):
    try:
        cs = change_sets.propose_change_set(
            req.goal.strip(),
            {"project_id": req.project_id} if req.project_id else {},
        )
        return cs
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成变更集失败: {e}")


@router.get("/change-sets/{cs_id}")
async def get_change_set(cs_id: str):
    cs = change_sets.get_change_set(cs_id)
    if not cs:
        raise HTTPException(status_code=404, detail=f"变更集不存在: {cs_id}")
    return cs


@router.post("/change-sets/{cs_id}/test")
async def test_change_set(cs_id: str, req: Optional[ChangeSetContext] = None):
    try:
        return await change_sets.test_change_set(cs_id, {"project_id": req.project_id} if req and req.project_id else {})
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"试跑失败: {e}")


@router.post("/change-sets/{cs_id}/apply")
async def apply_change_set(cs_id: str, req: Optional[ChangeSetContext] = None):
    try:
        return await change_sets.apply_change_set(cs_id, {"project_id": req.project_id} if req and req.project_id else {})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"应用变更集失败: {e}")


@router.post("/change-sets/{cs_id}/discard")
async def discard_change_set(cs_id: str):
    try:
        return await change_sets.discard_change_set(cs_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"丢弃失败: {e}")


@router.post("/change-sets/{cs_id}/rollback")
async def rollback_change_set(cs_id: str):
    try:
        return await change_sets.rollback_change_set(cs_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"回滚失败: {e}")
