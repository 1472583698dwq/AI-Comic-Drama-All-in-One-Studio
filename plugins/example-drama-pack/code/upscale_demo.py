# -*- coding: utf-8 -*-
"""视频超分演示节点（真实代码文件示例）。

契约：async def run(inputs, params, ctx) -> dict
- inputs: 按 input_schema 属性键收集的上游值（video / prompt ...）
- params: 节点参数（已合并 default_params）
- ctx:    运行上下文（ctx['api'] 为沙箱 api：httpx / download / storage_dir ...）
- 返回：  {"video_url"|"image_url"|"audio_url"|"text": ...}

把 TODO 处换成你的超分 API 调用即成真实能力；默认行为为透传 + 标注倍数。
"""


async def run(inputs: dict, params: dict, ctx: dict) -> dict:
    video = inputs.get("video") or inputs.get("video_url") or ""
    if not video:
        raise ValueError("缺少输入视频（请连入 video 句柄）")
    scale = params.get("scale", 2)

    # 真实实现示例（沙箱内网络请走 ctx['api']['httpx']）：
    # import asyncio
    # httpx = ctx["api"]["httpx"]
    # async with httpx.AsyncClient(timeout=1200) as client:
    #     resp = await client.post("https://api.example.com/upscale",
    #                              json={"url": video, "scale": scale})
    #     resp.raise_for_status()
    #     data = resp.json()
    # return {"video_url": data["url"], "text": f"upscaled x{scale}"}

    return {"video_url": video, "text": f"upscaled x{scale}"}
