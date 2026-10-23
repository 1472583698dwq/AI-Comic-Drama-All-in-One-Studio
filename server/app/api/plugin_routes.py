# -*- coding: utf-8 -*-
"""插件系统 HTTP API — 列表/安装(zip)/启用/禁用/卸载/重扫/spec"""
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException, UploadFile, File

from app.extensions import events
from app.plugins.models import (
    MANIFEST_TEMPLATE, EXTENSION_POINTS_DOC, V2_DOMAINS, DOMAIN_ORDER,
)
from app.plugins import manager as pm

router = APIRouter()


@router.get("/plugins")
async def list_plugins():
    try:
        plugins = pm.discover()
        return {"plugins": plugins, "total": len(plugins)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"插件列表失败: {e}")


@router.get("/plugins/spec")
async def plugin_spec():
    domains = [{"key": key, **V2_DOMAINS[key]} for key in DOMAIN_ORDER]
    return {"template": MANIFEST_TEMPLATE, "extensionPoints": EXTENSION_POINTS_DOC,
            "domains": domains, "schema": 2}


@router.post("/plugins/scaffold")
async def scaffold_plugin(body: Dict[str, Any] = Body(...)):
    try:
        return pm.scaffold_plugin(
            pid=str(body.get("id") or ""),
            name=str(body.get("name") or ""),
            domain=str(body.get("domain") or "capability"),
            description=str(body.get("description") or ""),
            author=str(body.get("author") or ""),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"生成插件骨架失败: {e}")


@router.post("/plugins/install")
async def install_plugin(file: UploadFile = File(...)):
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="请上传zip包")
    if not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持.zip插件包")
    try:
        data = await file.read()
        m = pm.install_from_zip(data)
        # 变更推送（SSE）：前端收到即重拉插件列表（设计 §4 Phase 4）
        events.publish("plugin", "install", m.id)
        return {"status": "installed", "id": m.id, "version": m.version, "enabled": False,
                "next": f"POST /plugins/{m.id}/enable"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"安装失败: {e}")


@router.post("/plugins/reload")
async def reload_plugins():
    try:
        plugins = pm.discover()
        events.publish("plugin", "reload", "*")
        return {"status": "ok", "total": len(plugins)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重扫失败: {e}")


@router.get("/plugins/health")
async def plugins_health():
    """插件可观测：执行次数/错误/超时/近因 + 已知扩展数。"""
    try:
        from app.extensions.registry import extension_registry
        return {"status": "ok", **extension_registry.health()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"健康查询失败: {e}")


@router.post("/plugins/{pid}/reload")
async def reload_plugin(pid: str):
    try:
        result = {"status": "ok", **pm.reload_plugin(pid)}
        events.publish("plugin", "reload", pid)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"热重载失败: {e}")


@router.post("/plugins/{pid}/enable")
async def enable_plugin(pid: str):
    try:
        result = pm.enable(pid)
        events.publish("plugin", "enable", pid)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"启用失败: {e}")


@router.post("/plugins/{pid}/disable")
async def disable_plugin(pid: str):
    try:
        result = pm.disable(pid)
        events.publish("plugin", "disable", pid)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"禁用失败: {e}")


@router.delete("/plugins/{pid}")
async def uninstall_plugin(pid: str):
    try:
        result = pm.uninstall(pid)
        events.publish("plugin", "uninstall", pid)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"卸载失败: {e}")
