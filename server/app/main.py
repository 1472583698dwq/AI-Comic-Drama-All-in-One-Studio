import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.core.config import settings
from app.api.routes import router
from app.mcp.server import mcp_registry

# 初始化动态 Provider 注册表（图片/音频）+ 同步为 MCP 动态 Tool（节点Agent调度）
try:
    from app.providers.init_providers import init_all_providers
    init_all_providers()
    # 将异构 Provider 统一暴露为 MCP Tool，供节点Agent动态调用
    try:
        mcp_registry.refresh_provider_tools()
    except Exception as _e:
        print(f"[Main] MCP provider tools refresh failed: {_e}")
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


# 项目作用域传播：从 query/header 读 project_id 注入 contextvar，
# 供扩展停用审计切面（app.extensions.guard）在深层引擎处强制项目级停用。
@app.middleware("http")
async def _extension_project_scope(request, call_next):
    pid = request.query_params.get("project_id") or request.headers.get("x-project-id") or ""
    try:
        from app.extensions import guard
        token = guard.set_project_context(pid)
    except Exception:
        token = None
    try:
        return await call_next(request)
    finally:
        if token is not None:
            try:
                from app.extensions import guard
                guard.reset_project_context(token)
            except Exception:
                pass

# ══════════════════════════════════════════════════════════════════════════════
# 路由挂载 —— 精简链路（SLIM BUILD）
# ══════════════════════════════════════════════════════════════════════════════
# 目标链路：基础配置 + 无限画布 + 素材库 + AI 导演 + 生图/生视频
#
# 保留：核心(router) / 素材库 / 项目 / 画布 / 生成源 / 扩展中心 / 插件中心 /
#       代码节点 / 画布节点（画布工具栏）/ 首次引导
# 裁掉：一键成片 / 分镜槽 / 主题包 / 导出器 / 导演包
#       —— 这五类的宿主页签（分镜工作台 / 3D 片场 / 多轨剪辑）已从前端下线，
#          路由留着只会变成"没人调用但仍在启动时 import"的冷负担。
#
# 回到全量对照测试：设环境变量 STUDIO_FULL_BUILD=1（.env 或启动脚本）。
SLIM_BUILD = os.environ.get("STUDIO_FULL_BUILD", "0") not in ("1", "true", "True", "on")


def _mount_router(module_path: str, attr: str, label: str) -> None:
    """挂载单个路由模块：失败只告警不影响其余路由（原逐块 try/except 的收敛写法）。"""
    try:
        import importlib
        _r = getattr(importlib.import_module(module_path), attr)
        app.include_router(_r, prefix=settings.API_V1_STR)
        print(f"[Main] {label} mounted")
    except Exception as e:
        print(f"[Main] {label} mount failed: {e}")


# ── 核心：Agent / MCP / 技能 / 任务 等主路由（始终保留） ──
_mount_router("app.api.routes", "router", "Core routes")

# ── 保留链路 ──
_mount_router("app.api.asset_routes", "router", "Asset routes (/api/v1/assets)")
_mount_router("app.api.project_routes", "router", "Project routes (/api/v1/projects)")
_mount_router("app.api.canvas_routes", "router", "Canvas routes (/api/v1/canvas)")
_mount_router("app.api.provider_routes", "router", "Provider routes (/api/v1/providers)")
_mount_router("app.api.extension_routes", "router", "Extension routes (/api/v1/extensions)")
_mount_router("app.api.plugin_routes", "router", "Plugin routes (/api/v1/plugins)")
_mount_router("app.api.custom_node_routes", "router", "CustomNode routes (/api/v1/custom-nodes)")
_mount_router("app.api.canvas_node_routes", "router", "CanvasNode routes (/api/v1/canvas-nodes)")
_mount_router("app.api.setup_routes", "router", "Setup routes (/api/v1/system/setup-status)")

# ── 已裁剪链路：宿主页签已下线，路由不挂 ──
if not SLIM_BUILD:
    _mount_router("app.api.onekey_routes", "router", "OneKey routes (/api/v1/onekey)")
    _mount_router("app.api.storyboard_slot_routes", "router", "StoryboardSlot routes (/api/v1/storyboard/slots)")
    _mount_router("app.api.theme_routes", "router", "Theme routes (/api/v1/themes)")
    _mount_router("app.api.exporter_routes", "router", "Exporter routes (/api/v1/exporters)")
    _mount_router("app.api.director_pack_routes", "router", "DirectorPack routes (/api/v1/director-packs)")
else:
    print("[Main] SLIM_BUILD=1：已跳过 一键成片 / 分镜槽 / 主题包 / 导出器 / 导演包 路由"
          "（STUDIO_FULL_BUILD=1 可恢复全量）")
# 自定义代码节点 MCP Tool 注册（一节点一Tool）
try:
    from app.mcp.server import mcp_registry as _mcp_reg
    if hasattr(_mcp_reg, "refresh_customnode_tools"):
        _mcp_reg.refresh_customnode_tools()
        print("[Main] CustomNode tools registered")
except Exception as e:
    print(f"[Main] CustomNode tools register failed: {e}")
# 已启用插件的查壳工具恢复（providers/skills/workflows由各自存储自恢复）
try:
    from app.plugins.manager import restore_enabled_plugins
    _restored = restore_enabled_plugins()
    if _restored.get("restored"):
        print(f"[Main] Restored plugin tools: {_restored['restored']}")
    for _w in _restored.get("warnings", [])[:5]:
        print(f"[Main] Plugin restore note: {_w}")
except Exception as e:
    print(f"[Main] Plugin restore failed: {e}")
# 插件文件监听（热重载）：插件目录变化自动重载启用中的插件（STUDIO_PLUGIN_WATCH=0 关闭）
try:
    from app.plugins.manager import start_plugin_watcher
    _watch = start_plugin_watcher()
    if _watch.get("started"):
        print(f"[Main] Plugin file watcher started (interval={_watch.get('interval')}s)")
except Exception as e:
    print(f"[Main] Plugin watcher start failed: {e}")

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
    # 快速健康检查，不阻塞 ComfyUI 探测（避免冷启动 15s 超时）
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        img_ids = image_registry.list_ids() if hasattr(image_registry, "list_ids") else []
        aud_ids = audio_registry.list_ids() if hasattr(audio_registry, "list_ids") else []
        return {
            "status": "healthy",
            "comfyui_online": False,
            "openai_configured": bool(settings.OPENAI_API_KEY),
            "providers": {
                "image": img_ids,
                "audio": aud_ids,
                "image_count": len(img_ids),
                "audio_count": len(aud_ids),
            },
        }
    except Exception as e:
        return {"status": "healthy", "error": str(e)[:200]}

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
    headers = {"Cache-Control": "no-cache, no-store, must-revalidate"}
    if os.path.exists(mobile_html):
        return FileResponse(mobile_html, headers=headers)
    return FileResponse(os.path.join(CLIENT_DIST_DIR, "index.html"), headers=headers)

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    # Skip api/docs/openapi
    if full_path.startswith(("api/", "docs", "openapi.json", "mcp-server", "storage/", "exports/", "assets/")):
        return {"error": "Not Found", "path": full_path}
    
    # Check if direct file in dist
    target_file = os.path.join(CLIENT_DIST_DIR, full_path)
    if full_path and os.path.isfile(target_file):
        headers = {"Cache-Control": "no-cache, no-store, must-revalidate"} if target_file.endswith(".html") else {}
        return FileResponse(target_file, headers=headers)
    
    index_html = os.path.join(CLIENT_DIST_DIR, "index.html")
    if os.path.exists(index_html):
        return FileResponse(index_html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    
    return {
        "status": "online",
        "system": settings.PROJECT_NAME,
        "version": "2.0.0",
        "notice": "Frontend dist not found. Please run 'npm run build' in client/ or run dev server.",
        "docs_url": "/docs"
    }
