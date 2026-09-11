# -*- coding: utf-8 -*-
"""统一扩展 API：聚合查看 + 统一执行 + 统一启停。

- GET  /extensions            聚合全 kind 列表（kind/source/q 过滤）
- GET  /extensions/counts     各 kind 计数
- GET  /extensions/{ext_id}   单个扩展（ext_id 形如 provider:kling）
- POST /extensions/execute    {id, args?, entry?} 按 kind 路由执行
- POST /extensions/{ext_id}/enable|disable  统一启停（plugin/自定义provider）
- DELETE /extensions/{ext_id} 统一卸载（plugin/自定义provider）
- GET  /extensions/check-id   跨 kind 去重检查（?kind=&local_id=）

既有各管家原生路由保持不动（向后兼容），新入口收敛到这里。
"""
from typing import Any, Dict, Optional
from fastapi import APIRouter, Body, HTTPException, Query

from app.extensions.registry import extension_registry
from app.extensions.models import (
    ExtensionKind,
    KIND_LABELS,
    EXECUTABLE_KINDS,
    LIFECYCLE_KINDS,
    OVERLAY_LIFECYCLE_KINDS,
    PLACEHOLDER_KINDS,
)

router = APIRouter()


@router.get("/extensions")
async def list_extensions(kind: Optional[str] = Query(default=None),
                           source: Optional[str] = Query(default=None),
                           q: Optional[str] = Query(default=None),
                           project_id: Optional[str] = Query(default=None)):
    if kind and kind not in ExtensionKind.ALL:
        raise HTTPException(status_code=400, detail=f"kind 非法: {kind}，支持 {list(ExtensionKind.ALL)}")
    scope = project_id or ""
    items = extension_registry.list(kind=kind, source=source, q=q, scope=scope)
    return {"extensions": [e.model_dump() for e in items],
            "total": len(items), "counts": extension_registry.counts(scope=scope),
            "scope": scope or "global",
            "kinds": {"labels": KIND_LABELS, "executable": list(EXECUTABLE_KINDS),
                      "native_lifecycle": list(LIFECYCLE_KINDS),
                      "overlay_lifecycle": list(OVERLAY_LIFECYCLE_KINDS),
                      "placeholder": list(PLACEHOLDER_KINDS)}}


@router.get("/extensions/counts")
async def extension_counts(project_id: Optional[str] = Query(default=None)):
    return {"counts": extension_registry.counts(scope=project_id or "")}


@router.get("/extensions/health")
async def extension_health():
    return extension_registry.health()


@router.get("/extensions/stats")
async def extension_stats(ext_id: Optional[str] = Query(default=None)):
    return extension_registry.stats(ext_id)


@router.get("/extensions/recent")
async def extension_recent(n: int = Query(default=30, ge=1, le=200)):
    return extension_registry.recent(n)


@router.get("/extensions/check-id")
async def check_extension_id(kind: str = Query(...), local_id: str = Query(...),
                             publisher: str = Query(default="")):
    if kind not in ExtensionKind.ALL:
        raise HTTPException(status_code=400, detail=f"kind 非法: {kind}")
    result = extension_registry.check_id_available(kind, local_id, publisher=publisher)
    return {"status": "success", **result}


@router.get("/extensions/{ext_id:path}")
async def get_extension(ext_id: str):
    ext = extension_registry.get(ext_id)
    if not ext:
        raise HTTPException(status_code=404, detail=f"扩展不存在: {ext_id}")
    return {"extension": ext.model_dump()}


@router.post("/extensions/execute")
async def execute_extension(body: Dict[str, Any] = Body(...)):
    ext_id = str(body.get("id") or body.get("extension_id") or "").strip()
    if not ext_id:
        raise HTTPException(status_code=400, detail="需提供 id（格式 kind:local_id，如 provider:kling）")
    try:
        result = await extension_registry.execute(
            ext_id, args=body.get("args") or {}, entry=str(body.get("entry") or "generate"),
            scope=str(body.get("project_id") or ""))
        return {"status": "success", **result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (RuntimeError, TimeoutError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"执行失败: {e}")


@router.post("/extensions/{ext_id:path}/enable")
async def enable_extension(ext_id: str, project_id: Optional[str] = Query(default=None)):
    try:
        return {"status": "success", **extension_registry.set_enabled(ext_id, True, scope=project_id or "")}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/extensions/{ext_id:path}/disable")
async def disable_extension(ext_id: str, project_id: Optional[str] = Query(default=None)):
    try:
        return {"status": "success", **extension_registry.set_enabled(ext_id, False, scope=project_id or "")}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/extensions/{ext_id:path}")
async def uninstall_extension(ext_id: str):
    try:
        return {"status": "success", **extension_registry.uninstall(ext_id)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
