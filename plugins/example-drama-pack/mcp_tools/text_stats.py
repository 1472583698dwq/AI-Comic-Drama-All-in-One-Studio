# -*- coding: utf-8 -*-
"""示例查壳工具：纯函数文本统计（无网络），演示插件mcp_tools全链路。

契约：PLUGIN_TOOLS 列表 + 同模块入口函数，注册为 plugin_example_drama_pack_text_stats，
执行强制走 trusted 总闸（STUDIO_TRUSTED_MODE=1），20分钟超时。
"""

PLUGIN_TOOLS = [
    {
        "name": "text_stats",
        "description": "统计输入文本的字数/词数/行数（示例插件工具）",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "待统计文本"},
            },
            "required": ["text"],
        },
        "entry": "text_stats",
    }
]


def text_stats(args: dict, ctx: dict) -> dict:
    text = str((args or {}).get("text") or "")
    return {
        "chars": len(text),
        "words": len(text.split()),
        "lines": len(text.splitlines()) or (1 if text else 0),
        "preview": text[:80],
    }
