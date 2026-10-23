# -*- coding: utf-8 -*-
import os
import sys

# Ensure app path in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 日志最先初始化（exe 无控制台，uvicorn/应用输出全部落盘 storage/logs/studio.log）
from app.core.logging_config import bootstrap_logging  # noqa: E402
bootstrap_logging()

import uvicorn  # noqa: E402

if __name__ == "__main__":
    host = (os.getenv("STUDIO_HOST", "127.0.0.1") or "127.0.0.1").strip()
    try:
        port = int(os.getenv("STUDIO_PORT", "8000") or "8000")
    except ValueError:
        port = 8000
    print("[MiniMax AI 漫剧 Studio 后端服务启动中...]")
    print(f"查看 Swagger 文档: http://{host}:{port}/docs")
    if host not in ("127.0.0.1", "localhost", "::1") and not os.getenv("STUDIO_MCP_AUTH_TOKEN", "").strip():
        print("[Security] 当前监听非回环地址，但未设置 STUDIO_MCP_AUTH_TOKEN；"
              "MCP /mcp-server 及全部 REST API 会直接暴露，建议仅在本机使用或加反向代理鉴权。")
    # reload 只监视后端代码目录（用户数据/生成结果都在 storage/，避免反复重载重启）
    _app_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
    uvicorn.run("app.main:app", host=host, port=port, reload=True,
                reload_dirs=[_app_dir] if os.path.isdir(_app_dir) else None)
