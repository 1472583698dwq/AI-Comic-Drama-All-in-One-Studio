# -*- coding: utf-8 -*-
"""声明式画布节点（canvas_nodes）模型 — 插件前端扩展点的轻量 DSL。

一个节点声明 = 输入端口 + 输出端口 + 参数 schema + 运行目标（任意可执行扩展）：
- 无需前端代码，节点卡片由通用渲染器（ExtNode）按声明绘制；
- 执行统一走可执行扩展（provider / skill / custom_node / mcp_tool），
  参数由 `run.map`（`$in.<端口>` / `$param.<键>` / 字面量）或同名默认映射装配。

示例（slots/canvas_nodes JSON）：
{
  "id": "upscale_ext", "name": "智能超分", "kind": "video",
  "inputs": [{"id": "video", "label": "输入视频", "type": "video", "required": true}],
  "outputs": [{"id": "video", "label": "视频", "type": "video", "from": "video_url"}],
  "params_schema": {"type": "object", "properties": {"scale": {"type": "integer", "default": 2}}},
  "run": {"extension": "custom_node:upscale_demo", "map": {"video": "$in.video", "scale": "$param.scale"}}
}
"""
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")
_PORT_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,48}$")
_PORT_TYPES = ("image", "video", "audio", "text", "any")
_KINDS = ("image", "video", "audio", "utility", "text")
_MAX_INPUTS = 12
_MAX_OUTPUTS = 8

# 插件/裸件可引用的可执行 kind（与 app.extensions.models.EXECUTABLE_KINDS 对齐）
_RUNNABLE_KINDS = ("provider", "skill", "custom_node", "mcp_tool")


class NodePort(BaseModel):
    """输入/输出端口。"""
    model_config = {"extra": "forbid"}

    id: str = Field(description="端口 id（连线句柄名）")
    label: str = ""
    type: str = Field(default="text", description="image|video|audio|text|any")
    required: bool = False
    description: str = ""
    # 输出端口专用：结果字段名（缺省与 id 同名）
    from_key: str = Field(default="", alias="from")

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _PORT_ID_RE.match(str(v or "")):
            raise ValueError(f"端口 id 非法: {v}（字母数字_ -，1~48 字符）")
        return v

    @field_validator("type")
    @classmethod
    def _check_type(cls, v: str) -> str:
        if v not in _PORT_TYPES:
            raise ValueError(f"端口 type 非法: {v}，支持 {list(_PORT_TYPES)}")
        return v


class CanvasNodeRun(BaseModel):
    """运行目标：可执行扩展 id + 参数装配。"""
    model_config = {"extra": "forbid"}

    extension: str = Field(description="可执行扩展 id，如 provider:xxx / custom_node:yyy / skill:zzz / mcp_tool:plugin_a_b")
    entry: str = Field(default="generate", description="执行入口（provider 可用 image/video/audio 显式指定类型）")
    args: Dict[str, Any] = Field(default_factory=dict, description="静态参数")
    map: Dict[str, str] = Field(
        default_factory=dict,
        description="参数装配：目标键 -> $in.<端口id> | $param.<参数键> | 字面量；未声明的输入/参数按同名合并",
    )

    @field_validator("extension")
    @classmethod
    def _check_extension(cls, v: str) -> str:
        raw = str(v or "").strip()
        if ":" not in raw:
            raise ValueError("run.extension 须为 kind:local_id（如 provider:comfyui / custom_node:upscale_demo）")
        kind = raw.split(":", 1)[0]
        if kind not in _RUNNABLE_KINDS:
            raise ValueError(f"run.extension kind 非法: {kind}，支持 {list(_RUNNABLE_KINDS)}")
        return raw

    @field_validator("map")
    @classmethod
    def _check_map(cls, v: Dict[str, str]) -> Dict[str, str]:
        for k, expr in (v or {}).items():
            if not str(k).strip():
                raise ValueError("run.map 目标键不能为空")
            if not isinstance(expr, str):
                raise ValueError(f"run.map.{k} 须为字符串表达式")
        return v


class CanvasNodeSpec(BaseModel):
    """一张声明式节点卡片。"""
    model_config = {"extra": "forbid"}

    id: str = Field(description="节点 id，小写字母数字中划线/下划线")
    name: str = Field(description="展示名")
    description: str = ""
    icon: str = "Boxes"
    color: str = "text-teal-400"
    kind: str = Field(default="utility", description="image|video|audio|utility|text")
    enabled: bool = True
    inputs: List[NodePort] = Field(default_factory=list)
    outputs: List[NodePort] = Field(default_factory=list)
    params_schema: Dict[str, Any] = Field(default_factory=dict)
    run: CanvasNodeRun
    created_at: str = ""
    updated_at: str = ""

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(str(v or "")):
            raise ValueError(f"节点 id 非法: {v}（小写字母数字_-，2~64 字符）")
        return v

    @field_validator("kind")
    @classmethod
    def _check_kind(cls, v: str) -> str:
        if v not in _KINDS:
            raise ValueError(f"kind 非法: {v}，支持 {list(_KINDS)}")
        return v

    @field_validator("inputs")
    @classmethod
    def _check_inputs(cls, v: List[NodePort]) -> List[NodePort]:
        if len(v or []) > _MAX_INPUTS:
            raise ValueError(f"输入端口超限（≤{_MAX_INPUTS}）")
        seen = set()
        for p in v or []:
            if p.id in seen:
                raise ValueError(f"输入端口重复: {p.id}")
            seen.add(p.id)
        return v

    @field_validator("outputs")
    @classmethod
    def _check_outputs(cls, v: List[NodePort]) -> List[NodePort]:
        if len(v or []) > _MAX_OUTPUTS:
            raise ValueError(f"输出端口超限（≤{_MAX_OUTPUTS}）")
        seen = set()
        for p in v or []:
            if p.id in seen:
                raise ValueError(f"输出端口重复: {p.id}")
            seen.add(p.id)
        return v

    @field_validator("params_schema")
    @classmethod
    def _check_params(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        if v and (not isinstance(v, dict) or v.get("type") != "object"):
            raise ValueError("params_schema 须为 type=object 的 dict")
        props = (v or {}).get("properties") or {}
        if len(props) > 30:
            raise ValueError("params_schema 属性超限（≤30）")
        return v


MANIFEST_TEMPLATE: Dict[str, Any] = {
    "id": "my-node",
    "name": "我的节点",
    "description": "一句话说明",
    "icon": "Boxes",
    "color": "text-teal-400",
    "kind": "utility",
    "inputs": [{"id": "prompt", "label": "提示词", "type": "text", "required": False}],
    "outputs": [{"id": "image", "label": "图像", "type": "image", "from": "image_url"}],
    "params_schema": {"type": "object", "properties": {}},
    "run": {"extension": "custom_node:my_node", "entry": "generate", "args": {}, "map": {"prompt": "$in.prompt"}},
}
