# -*- coding: utf-8 -*-
"""导演包（director_packs）声明模型 — 3D 导演台扩展：预设 / 环境底图 / GLB 道具。

示例：
{
  "id": "wuxia-pack", "name": "武侠导演包",
  "presets": {
    "framing": [{"id": "hero_shot", "label": "英雄机位", "fl": 30, "desc": "低机位仰拍"}],
    "motion":  [{"id": "sword_dash", "label": "御剑突进", "category": "combo",
                 "desc": "低机位推进", "minimaxCode": "Low Angle + Forward Tracking"}],
    "pose":    [{"id": "sword_pose", "label": "持剑式", "icon": "🗡️"}],
    "cast":    [{"id": "trio", "label": "三人成阵", "desc": "三角站位"}]
  },
  "environments": [{"id": "bamboo", "label": "竹林", "desc": "青翠竹海",
                    "icon": "🎋", "background_url": "/storage/scenes/bamboo.jpg"}],
  "props": [{"id": "jade_sword", "label": "青玉剑", "icon": "🗡️",
             "glb_url": "/storage/props/jade_sword.glb", "scale": 1.0}]
}
"""
import re
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")
_PRESET_CATEGORIES = ("framing", "motion", "pose", "cast")
_MOTION_KINDS = ("single", "combo")
_MAX_ITEMS = 40


class DirectorPreset(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    label: str
    desc: str = ""
    icon: str = ""
    # framing 专用：等效焦距
    fl: Optional[int] = None
    # motion 专用
    category: str = ""
    minimaxCode: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"预设 id 非法: {v}（小写字母数字_-，含中划线）")
        return v

    @field_validator("category")
    @classmethod
    def _check_category(cls, v: str) -> str:
        if v and v not in _MOTION_KINDS:
            raise ValueError(f"运镜 category 非法: {v}，支持 {list(_MOTION_KINDS)}")
        return v


class DirectorEnvironment(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    label: str
    desc: str = ""
    icon: str = "🌆"
    background_url: str = Field(default="", description="远景背景板图片 URL")

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"环境 id 非法: {v}")
        return v


class DirectorProp(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    label: str
    icon: str = "🧩"
    glb_url: str = Field(description="GLB/GLTF 模型 URL")
    scale: float = 1.0

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"道具 id 非法: {v}")
        return v


class DirectorPackSpec(BaseModel):
    model_config = {"extra": "forbid"}

    id: str
    name: str
    description: str = ""
    icon: str = "Clapperboard"
    presets: Dict[str, List[DirectorPreset]] = Field(default_factory=dict)
    environments: List[DirectorEnvironment] = Field(default_factory=list)
    props: List[DirectorProp] = Field(default_factory=list)
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"导演包 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("presets")
    @classmethod
    def _check_presets(cls, v: Dict[str, List[DirectorPreset]]) -> Dict[str, List[DirectorPreset]]:
        for k, items in (v or {}).items():
            if k not in _PRESET_CATEGORIES:
                raise ValueError(f"预设分类非法: {k}，支持 {list(_PRESET_CATEGORIES)}")
            if len(items or []) > _MAX_ITEMS:
                raise ValueError(f"预设数量超限（{k} ≤{_MAX_ITEMS}）")
        return v

    @field_validator("environments", "props")
    @classmethod
    def _check_lists(cls, v: List) -> List:
        if len(v or []) > _MAX_ITEMS:
            raise ValueError(f"条目数量超限（≤{_MAX_ITEMS}）")
        return v


MANIFEST_TEMPLATE: Dict = {
    "id": "my-director-pack",
    "name": "我的导演包",
    "description": "一句话说明",
    "presets": {
        "framing": [{"id": "hero_shot", "label": "英雄机位", "fl": 30, "desc": "低机位仰拍"}],
        "motion": [],
        "pose": [],
        "cast": [],
    },
    "environments": [],
    "props": [],
}
