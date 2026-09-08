# -*- coding: utf-8 -*-
"""插件系统 HTTP API — 列表/安装(zip)/启用/禁用/卸载/重扫/spec"""
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, UploadFile, File

from app.plugins.models import MANIFEST_TEMPLATE, EXTENSION_POINTS_DOC
from app.plugins import manager as pm

router = APIRouter()


@router.get("/plugins")
async def list_plugins():
    try:
        return {"plugins": pm.discover(), "total": len(pm.discover())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"插件列表失败: {e}")


@router.get("/plugins/spec")
async def plugin_spec():
    return {"template": MANIFEST_TEMPLATE, "extensionPoints": EXTENSION_POINTS_DOC}


@router.post("/plugins/install")
async def install_plugin(file: UploadFile = File(...)):
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="请上传zip包")
    if not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="仅支持.zip插件包")
    try:
        data = await file.read()
        m = pm.install_from_zip(data)
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
        return {"status": "ok", "total": len(plugins)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重扫失败: {e}")


@router.post("/plugins/{pid}/enable")
async def enable_plugin(pid: str):
    try:
        return pm.enable(pid)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"启用失败: {e}")


@router.post("/plugins/{pid}/disable")
async def disable_plugin(pid: str):
    try:
        return pm.disable(pid)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"禁用失败: {e}")


@router.delete("/plugins/{pid}")
async def uninstall_plugin(pid: str):
    try:
        return pm.uninstall(pid)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"卸载失败: {e}")
