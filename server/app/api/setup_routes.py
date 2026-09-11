# -*- coding: utf-8 -*-
"""首次启动引导：安装向导状态查询 + 完成标记。

- GET  /system/setup-status   各模态是否「已配置 + 已验证」，以及是否已完成引导
- POST /system/setup-complete 标记引导已完成（或重置）
"""
import json
import os
import time
from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import settings

router = APIRouter()


def _flag_path() -> str:
    base = getattr(settings, "STORAGE_DIR", "storage")
    return os.path.join(base, "setup.json")


def _read_flag() -> Dict[str, Any]:
    try:
        with open(_flag_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_flag(done: bool) -> None:
    try:
        p = _flag_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"onboarding_done": bool(done),
                       "at": time.strftime("%Y-%m-%d %H:%M:%S")},
                      f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
    except Exception:
        pass


def _kind_ready(reg, skip_ids=()) -> bool:
    """该模态是否有「已配置 + 已验证」的源。"""
    try:
        from app.providers import verification
        for oid in reg.list_ids():
            if oid in skip_ids:
                continue
            p = reg.get(oid)
            if p and p.is_configured() and verification.is_verified(oid):
                return True
    except Exception:
        pass
    return False


def _llm_status() -> Dict[str, Any]:
    has_openai = bool(getattr(settings, "OPENAI_API_KEY", ""))
    has_minimax = bool(getattr(settings, "MINIMAX_API_KEY", ""))
    has_responses = bool(getattr(settings, "RESPONSES_API_KEY", ""))
    return {
        "ready": has_openai or has_minimax or has_responses,
        "provider": getattr(settings, "LLM_PROVIDER", "openai_compatible"),
        "has_openai_key": has_openai,
        "has_minimax_key": has_minimax,
    }


@router.get("/system/setup-status")
async def setup_status():
    try:
        from app.providers.image.registry import image_registry
        from app.providers.video.registry import video_registry
        from app.providers.audio.registry import audio_registry
    except Exception:
        image_registry = video_registry = audio_registry = None  # type: ignore
    image_ready = _kind_ready(image_registry) if image_registry else False
    video_ready = _kind_ready(video_registry) if video_registry else False
    audio_ready = _kind_ready(audio_registry) if audio_registry else False
    llm = _llm_status()
    # 最低可用：能拆解文本(LLM) + 能出图(图像)
    minimal_ready = bool(llm["ready"] and image_ready)
    # 完整功能：文本 + 图像 + (视频 或 配音)
    full_ready = bool(minimal_ready and (video_ready or audio_ready))
    return {
        "onboarding_done": bool(_read_flag().get("onboarding_done")),
        "llm": llm,
        "image": {"ready": image_ready},
        "video": {"ready": video_ready},
        "audio": {"ready": audio_ready},
        "minimal_ready": minimal_ready,
        "full_ready": full_ready,
    }


class SetupFlagRequest(BaseModel):
    done: bool = True


@router.post("/system/setup-complete")
async def setup_complete(req: SetupFlagRequest):
    _write_flag(req.done)
    return {"status": "ok", "onboarding_done": req.done}
