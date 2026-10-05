# -*- coding: utf-8 -*-
"""功能级（feature）运行时开关 API。

- GET /features   功能清单 + 启停状态 + 分组（挂载后为 ``/api/v1/features``）
- PUT /features   批量写开关：``{"values": {"agent_teams": true}}``
  也接受直接传扁平 dict：``{"agent_teams": true}``（前端两种写法都认）
  非法输入（未知 id / 非布尔）→ 400，磁盘保持原样

与 ``page_routes`` 的分工：页面开关走扩展注册表覆盖层（``POST /extensions/{id}/…``），
功能开关的写口就在本模块（功能不是扩展 kind，没有 registry 覆盖层可借）。
路由**始终挂载**，开关运行期生效（关闭态由各拦截点自行判断，不靠不挂路由实现）。
"""
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException

from app.core import features

router = APIRouter()


@router.get("/features")
async def list_features() -> Dict[str, Any]:
    return features.snapshot()


@router.put("/features")
async def update_features(body: Any = Body(...)) -> Dict[str, Any]:
    """写开关。兼容两种 body：``{"values": {...}}`` 与裸扁平 ``{id: bool}``。"""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body 必须是 JSON 对象")
    if "values" in body:
        raw = body["values"]
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="values 必须是 {feature_id: bool} 对象")
    else:
        raw = body
    try:
        result = features.set_values(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "success", "changed": result["changed"], **features.snapshot()}
