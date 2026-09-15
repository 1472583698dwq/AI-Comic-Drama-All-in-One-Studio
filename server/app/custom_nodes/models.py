# -*- coding: utf-8 -*-
"""
自定义节点标准 — 一段代码即一个画布节点（如视频超分、风格迁移、 slow-motion）

节点 = input_schema(输入槽，x-handle多媒体语义) + params_schema(参数，x-*分组)
       + 一段代码（async def run(inputs, params, ctx) -> dict）

契约：
- python: async def run(inputs: dict, params: dict, ctx: dict) -> dict
- javascript: async function run(inputs, params, ctx) { return {...}; }
- inputs: 按input_schema属性键收集的上游值（首帧/参考图/文本…）
- params: 节点参数（已合并schema默认值）
- 返回: {"image_url"|"video_url"|"audio_url"|"text": ...}（URL 或文本）
- 执行复用代码源沙箱（与Provider code模式同闸：trusted开关+超时）
"""
from typing import Dict, List, Optional
from pydantic import BaseModel, Field

CustomNodeKind = str  # image | video | audio | utility
CustomNodeLanguage = str  # python | javascript


class CustomNodeDefinition(BaseModel):
    model_config = {"extra": "allow"}

    id: str = ""
    name: str = ""
    kind: str = "utility"  # image | video | audio | utility
    description: str = ""
    icon: str = "Boxes"
    enabled: bool = True
    language: str = "python"  # python | javascript
    code: str = ""
    # 插件包写法：代码放真实文件（相对 plugin.json 的包内路径），启用时由插件管理器读入 code。
    # 与 code 同时存在时 inline code 优先；裸件/UI 创建仍用 code。
    code_file: str = ""
    code_entry: str = "run"
    code_timeout: int = 1200
    trusted: bool = False
    input_schema: Optional[Dict] = None
    params_schema: Optional[Dict] = None
    default_params: Dict = Field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""


PY_RUN_TEMPLATE = '''# 自定义节点代码标准（python）
# inputs: 上游按input_schema键收集的值；params: 节点参数；ctx: 运行上下文
# 返回: {"video_url"|"image_url"|"audio_url"|"text": ...}

async def run(inputs: dict, params: dict, ctx: dict) -> dict:
    # 示例：透传首帧视频（把你的超分/处理逻辑写在这里）
    video = inputs.get("video") or inputs.get("video_url") or ""
    scale = params.get("scale", 2)
    if not video:
        raise ValueError("缺少输入视频（请连入 video 句柄）")
    # TODO: 调用你的超分 API，返回新地址
    return {"video_url": video, "text": f"passthrough scale={scale}"}
'''

JS_RUN_TEMPLATE = '''// 自定义节点代码标准（javascript）
// inputs: 上游值；params: 节点参数；ctx: 运行上下文
// 返回: {"video_url"|"image_url"|"audio_url"|"text": ...}

async function run(inputs, params, ctx) {
  const video = inputs.video || inputs.video_url || "";
  const scale = params.scale || 2;
  if (!video) throw new Error("缺少输入视频（请连入 video 句柄）");
  // TODO: 调用你的超分 API，返回新地址
  return { video_url: video, text: `passthrough scale=${scale}` };
}
'''
