# -*- coding: utf-8 -*-
"""功能页运行时开关 API。

- GET /pages   页面清单 + 启停状态 + 分组（挂载后为 ``/api/v1/pages``）

启停写口不在这里另开：统一走 ``POST /extensions/{ext_id}/enable|disable``
（ext_id 形如 ``page:studio``），复用扩展注册表的覆盖层逻辑与审计。
"""
from typing import Any, Dict

from fastapi import APIRouter

from app.core import pages

router = APIRouter()


@router.get("/pages")
async def list_pages() -> Dict[str, Any]:
    return pages.snapshot()
