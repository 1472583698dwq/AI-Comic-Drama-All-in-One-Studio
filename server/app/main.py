import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.core.config import settings
from app.api.routes import router
from app.mcp.server import mcp_registry

# 初始化动态 Provider 注册表（图片/音频）
try:
    from app.providers.init_providers import init_all_providers
    init_all_providers()
except Exception as e:
    print(f"[Main] Provider init failed: {e}")

# FastMCP 标准协议应用（挂载到 /mcp-server，供外部 MCP 客户端直连）
mcp_http_app = mcp_registry.get_mcp_http_app()

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="AI 漫剧双端（移动端 App + 桌面端 Desktop）中枢引擎：MiniMax LLM 剧本拆解 / 动态多Provider生图(ComfyUI/硅基流动/通义万象) / 动态多Provider配音(MiniMax/ElevenLabs/CosyVoice/GPT-SoVITS) / pyJianYingDraft 剪映导出 / MCP 工具扩展（导演Agent全量暴露）",
    version="2.1.0",
    lifespan=mcp_http_app.lifespan if mcp_http_app else None,
)

# Configure CORS for multi-platform Web / Desktop / Mobile clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API routes
app.include_router(router, prefix=settings.API_V1_STR)
# 资产库路由
try:
    from app.api.asset_routes import router as asset_router
    app.include_router(asset_router, prefix=settings.API_V1_STR)
    print("[Main] Asset routes mounted at /api/v1/assets")
except Exception as e:
    print(f"[Main] Asset routes mount failed: {e}")
# 项目管理路由 (P0)
try:
    from app.api.project_routes import router as project_router
    app.include_router(project_router, prefix=settings.API_V1_STR)
    print("[Main] Project routes mounted at /api/v1/projects")
except Exception as e:
    print(f"[Main] Project routes mount failed: {e}")
# 画布执行路由 (P2)
try:
    from app.api.canvas_routes import router as canvas_router
    app.include_router(canvas_router, prefix=settings.API_V1_STR)
    print("[Main] Canvas routes mounted at /api/v1/canvas")
except Exception as e:
    print(f"[Main] Canvas routes mount failed: {e}")
# Provider 管理路由（解耦：每个生成源为独立节点）
try:
    from app.api.provider_routes import router as provider_router
    app.include_router(provider_router, prefix=settings.API_V1_STR)
    print("[Main] Provider routes mounted at /api/v1/providers")
except Exception as e:
    print(f"[Main] Provider routes mount failed: {e}")

# Mount standard MCP protocol server (Streamable HTTP)
if mcp_http_app:
    app.mount("/mcp-server", mcp_http_app, name="mcp")

from fastapi.responses import FileResponse

# Mount static/export directories
if os.path.exists(settings.STORAGE_DIR):
    app.mount("/storage", StaticFiles(directory=settings.STORAGE_DIR), name="storage")

if os.path.exists(settings.EXPORTS_DIR):
    app.mount("/exports", StaticFiles(directory=settings.EXPORTS_DIR), name="exports")

import sys

def find_client_dist_dir() -> str:
    candidates = [
        os.path.join(getattr(sys, '_MEIPASS', ''), 'client', 'dist'),
        os.path.join(os.path.dirname(sys.executable), 'client', 'dist'),
        os.path.join(os.path.dirname(sys.executable), '_internal', 'client', 'dist'),
        os.path.abspath(os.path.join(os.path.dirname(__file__), '../../client/dist')),
        os.path.abspath(os.path.join(os.getcwd(), 'client/dist')),
        r"d:\ai漫剧\client\dist",
    ]
    for c in candidates:
        if c and os.path.exists(c) and os.path.isdir(c):
            return c
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "../../client/dist"))

CLIENT_DIST_DIR = find_client_dist_dir()
ASSETS_DIR = os.path.join(CLIENT_DIST_DIR, "assets")

if os.path.exists(ASSETS_DIR):
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="client_assets")

@app.get("/api/v1/health")
async def health_check():
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        comfy = image_registry.get("comfyui")
        comfy_online = await comfy.check_health() if comfy else False
    except Exception:
        comfy_online = False
    return {
        "status": "healthy",
        "comfyui_online": comfy_online,
        "minimax_configured": bool(settings.MINIMAX_API_KEY),
        "providers": {
            "image": [p for p in image_registry.list_providers()] if 'image_registry' in locals() else [],
            "audio": [p for p in audio_registry.list_providers()] if 'audio_registry' in locals() else [],
        },
    }

@app.get("/api/status")
def system_status():
    return {
        "status": "online",
        "system": settings.PROJECT_NAME,
        "version": "2.0.0",
        "mcp_enabled": bool(mcp_http_app),
        "docs_url": "/docs",
        "client_embedded": os.path.exists(CLIENT_DIST_DIR),
    }

@app.get("/mobile")
async def mobile_app():
    mobile_html = os.path.join(CLIENT_DIST_DIR, "mobile.html")
    if os.path.exists(mobile_html):
        return FileResponse(mobile_html)
    return FileResponse(os.path.join(CLIENT_DIST_DIR, "index.html"))

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    # Skip api/docs/openapi
    if full_path.startswith(("api/", "docs", "openapi.json", "mcp-server", "storage/", "exports/", "assets/")):
        return {"error": "Not Found", "path": full_path}
    
    # Check if direct file in dist
    target_file = os.path.join(CLIENT_DIST_DIR, full_path)
    if full_path and os.path.isfile(target_file):
        return FileResponse(target_file)
    
    index_html = os.path.join(CLIENT_DIST_DIR, "index.html")
    if os.path.exists(index_html):
        return FileResponse(index_html)
    
    return {
        "status": "online",
        "system": settings.PROJECT_NAME,
        "version": "2.0.0",
        "notice": "Frontend dist not found. Please run 'npm run build' in client/ or run dev server.",
        "docs_url": "/docs"
    }
