# -*- coding: utf-8 -*-
"""模型广场 HTTP：供应商增删改、从 base URL 拉模型、设定对话当前模型。"""
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.llm import plaza

router = APIRouter()


class SupplierIn(BaseModel):
    name: str = Field(..., description="展示名，用来区分不同供应商上的同名模型")
    base_url: str = Field(..., description="根地址。OpenAI 兼容如 https://api.deepseek.com/v1；Claude 如 https://api.anthropic.com")
    api_key: str = ""
    protocol: str = Field(default="openai", description="openai 或 claude")
    headers: Optional[Dict[str, str]] = Field(
        default=None,
        description="自定义请求头（高级）：私有网关 / OpenCode 的会话与治理头，如 x-opencode-session",
    )


class SupplierPatch(BaseModel):
    """编辑供应商：None = 不改；api_key 留空 = 保留旧 Key；headers 传 {} = 清空。"""
    name: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    protocol: Optional[str] = None
    headers: Optional[Dict[str, str]] = None


class ActiveIn(BaseModel):
    supplier_id: str = ""
    model: str = ""


@router.get("/llm/plaza")
async def get_plaza():
    return plaza.snapshot()


@router.post("/llm/suppliers")
async def create_supplier(body: SupplierIn):
    try:
        created = plaza.add_supplier(body.name, body.base_url, body.api_key, body.protocol, body.headers)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        created = await plaza.refresh_supplier(created["id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"supplier": created, "active": plaza.snapshot()["active"]}


@router.patch("/llm/suppliers/{sid}")
async def update_supplier(sid: str, body: SupplierPatch):
    try:
        updated = plaza.update_supplier(
            sid,
            name=body.name,
            base_url=body.base_url,
            api_key=body.api_key,
            protocol=body.protocol,
            headers=body.headers,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if updated is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    try:
        updated = await plaza.refresh_supplier(sid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"supplier": updated, "active": plaza.snapshot()["active"]}


@router.delete("/llm/suppliers/{sid}")
async def remove_supplier(sid: str):
    try:
        plaza.delete_supplier(sid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return plaza.snapshot()


@router.post("/llm/suppliers/{sid}/refresh")
async def refresh_supplier(sid: str):
    try:
        supplier = await plaza.refresh_supplier(sid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"supplier": supplier}


@router.post("/llm/active")
async def set_active(body: ActiveIn):
    try:
        active = plaza.set_active(body.supplier_id, body.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"active": active}


@router.post("/llm/default")
async def set_default(body: ActiveIn):
    """设置全局默认模型：拆剧本 / 润色 / 一键成片 / 对话都走它。"""
    try:
        default = plaza.set_default(body.supplier_id, body.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"default": default}
