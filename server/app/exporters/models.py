# -*- coding: utf-8 -*-
"""导出器（exporters）声明模型 — 声明式导出目标，执行统一走可执行扩展。

示例（把项目交给插件 mcp_tool 生成 SRT/FFmpeg 命令/第三方草稿）：
{
  "id": "srt_exporter", "name": "SRT 字幕导出",
  "accepts": ["project", "shots"],
  "run": {"extension": "mcp_tool:plugin_acme_srt_export",
          "map": {"project": "$project", "shots": "$shots"}}
}
"""
import re
from typing import Any, Dict, List

from pydantic import BaseModel, Field, field_validator

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")
_RUNNABLE_KINDS = ("provider", "skill", "custom_node", "mcp_tool")
_PAYLOAD_KEYS = ("project", "shots", "characters", "assets", "meta")


class ExporterRun(BaseModel):
    model_config = {"extra": "forbid"}

    extension: str = Field(description="可执行扩展 id")
    entry: str = "generate"
    args: Dict[str, Any] = Field(default_factory=dict, description="静态参数")
    map: Dict[str, str] = Field(
        default_factory=dict,
        description="参数装配：目标键 -> $project|$shots|$characters|$assets|$meta 或字面量；缺省按 accepts 同名注入",
    )

    @field_validator("extension")
    @classmethod
    def _check_extension(cls, v: str) -> str:
        raw = str(v or "").strip()
        if ":" not in raw:
            raise ValueError("run.extension 须为 kind:local_id")
        kind = raw.split(":", 1)[0]
        if kind not in _RUNNABLE_KINDS:
            raise ValueError(f"run.extension kind 非法: {kind}，支持 {list(_RUNNABLE_KINDS)}")
        return raw


class ExporterSpec(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    name: str
    description: str = ""
    icon: str = "FileOutput"
    color: str = "text-emerald-400"
    accepts: List[str] = Field(default_factory=lambda: ["project"],
                               description=f"前端会装配的载荷：{list(_PAYLOAD_KEYS)}")
    run: ExporterRun
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"导出器 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("accepts")
    @classmethod
    def _check_accepts(cls, v: List[str]) -> List[str]:
        for k in v or []:
            if k not in _PAYLOAD_KEYS:
                raise ValueError(f"accepts 非法: {k}，支持 {list(_PAYLOAD_KEYS)}")
        return v or ["project"]


MANIFEST_TEMPLATE: Dict = {
    "id": "my-exporter",
    "name": "我的导出器",
    "description": "一句话说明",
    "accepts": ["project", "shots"],
    "run": {"extension": "custom_node:my_exporter_node",
            "map": {"project": "$project", "shots": "$shots"}},
}
