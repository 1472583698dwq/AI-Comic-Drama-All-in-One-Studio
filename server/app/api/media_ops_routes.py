# -*- coding: utf-8 -*-
"""画布素材处理 API（REQ-toonflow-canvas）：Toonflow 式节点的截帧 / 分离音轨 / 截取 / 变速 / 宫格切分 / 局部重绘标记。

契约要点：
- 全部同步返回（单次处理是秒级）：产物写 `storage/generated/media_ops/`，响应里给 `/storage/...` URL；
- 参数非法 400、素材不存在 404、素材不可处理（无视频流/无音轨/ffmpeg 报错）422、
  并发已满 429、处理异常/超时 500、ffmpeg/Pillow 未就绪 503 —— detail 均为可直接展示的中文原因；
- 与时间线合片同一守卫：创意画布 / 多轨剪辑任一开启即放行（两边都会用到截取类能力）。
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core import pages
from app.media import ops
from app.media.ops import MediaOpError

logger = logging.getLogger("media_ops")

# REQ-toonflow-canvas 素材处理路由族（画布/多轨剪辑任一开启即放行）
router = APIRouter(dependencies=[Depends(pages.require_any(["canvas", "timeline"]))])


class FrameRequest(BaseModel):
    video_url: str
    at: str = "first"  # first | last | time（current 为 time 的别名）
    time: Optional[float] = None


class VideoRequest(BaseModel):
    video_url: str
    format: Optional[str] = None  # 音频产物格式：m4a（默认）| wav | mp3


class TrimRequest(BaseModel):
    url: str
    start: float
    end: float
    format: Optional[str] = None  # 仅音频：m4a | wav | mp3（缺省时 wav 源保持 wav，其余 m4a）


class SpeedRequest(BaseModel):
    audio_url: str
    rate: float
    format: Optional[str] = None


class GridSplitRequest(BaseModel):
    image_url: str
    rows: int
    cols: int


class ComposeMaskRequest(BaseModel):
    image_url: str
    mask_png: str  # PNG 的 base64（可带 data:image/png;base64, 前缀）
    opacity: Optional[float] = None  # 0.1–0.9，默认 0.45
    color: Optional[str] = None  # #RRGGBB，默认 #ff3b30


async def _call(what: str, coro: Awaitable[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        result = await coro
    except MediaOpError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # 兜底：意外异常也要给前端可读原因
        logger.exception("media op %s failed", what)
        raise HTTPException(status_code=500, detail=f"{what}失败：{type(e).__name__}: {e}"[:500])
    return {"status": "success", **result}


@router.get("/media/ops/engine")
async def media_ops_engine():
    """引擎自检：{ffmpeg, ffprobe, pillow, ffmpeg_hint}。"""
    return ops.engine_status()


@router.get("/media/ops/probe")
async def media_ops_probe(url: str = Query(..., description="素材地址：/storage/...、http(s)、data: 或 storage 内本地路径")):
    return await _call("探测", ops.probe(url))


@router.post("/media/ops/frame")
async def media_ops_frame(req: FrameRequest):
    return await _call("截帧", ops.extract_frame(req.video_url, at=req.at, time=req.time))


@router.post("/media/ops/extract-audio")
async def media_ops_extract_audio(req: VideoRequest):
    return await _call("提取音轨", ops.extract_audio(req.video_url, format=req.format))


@router.post("/media/ops/split-av")
async def media_ops_split_av(req: VideoRequest):
    return await _call("音画分离", ops.split_av(req.video_url, format=req.format))


@router.post("/media/ops/trim")
async def media_ops_trim(req: TrimRequest):
    return await _call("截取", ops.trim(req.url, req.start, req.end, format=req.format))


@router.post("/media/ops/speed")
async def media_ops_speed(req: SpeedRequest):
    return await _call("变速", ops.speed(req.audio_url, req.rate, format=req.format))


@router.post("/media/ops/grid-split")
async def media_ops_grid_split(req: GridSplitRequest):
    return await _call("宫格切分", ops.grid_split(req.image_url, req.rows, req.cols))


@router.post("/media/ops/compose-mask")
async def media_ops_compose_mask(req: ComposeMaskRequest):
    return await _call(
        "标记合成",
        ops.compose_mask(req.image_url, req.mask_png, opacity=req.opacity, color=req.color),
    )
