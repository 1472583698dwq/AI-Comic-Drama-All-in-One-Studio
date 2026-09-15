# -*- coding: utf-8 -*-
"""主题包（themes）声明模型 — 前端扩展点最轻量形态：CSS 变量包。

示例：
{
  "id": "ink-wash", "name": "水墨主题", "mode": "all",
  "vars": {"--color-brand": "#2f6b52", "--color-bg": "#0d1110"}
}
"""
import re
from typing import Dict, List

from pydantic import BaseModel, Field, field_validator

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")
_VAR_RE = re.compile(r"^--[A-Za-z0-9_\-]{1,64}$")
_MODES = ("all", "dark", "light")
_MAX_VARS = 200


class ThemeSpec(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    name: str
    description: str = ""
    icon: str = "Palette"
    mode: str = Field(default="all", description="all|dark|light —— 仅在对应明暗模式下生效")
    vars: Dict[str, str] = Field(default_factory=dict, description="CSS 变量名（--x）→ 值")
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"主题 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("mode")
    @classmethod
    def _check_mode(cls, v: str) -> str:
        if v not in _MODES:
            raise ValueError(f"mode 非法: {v}，支持 {list(_MODES)}")
        return v

    @field_validator("vars")
    @classmethod
    def _check_vars(cls, v: Dict[str, str]) -> Dict[str, str]:
        if len(v or {}) > _MAX_VARS:
            raise ValueError(f"变量超限（≤{_MAX_VARS}）")
        for k, val in (v or {}).items():
            if not _VAR_RE.match(str(k)):
                raise ValueError(f"变量名非法（须为 --xxx）: {k}")
            if not isinstance(val, str) or len(val) > 300:
                raise ValueError(f"变量值非法或过长: {k}")
        return v


MANIFEST_TEMPLATE: Dict = {
    "id": "my-theme",
    "name": "我的主题",
    "description": "一句话说明",
    "mode": "all",
    "vars": {"--color-brand": "#7c3aed", "--color-bg": "#0b0b0f"},
}
