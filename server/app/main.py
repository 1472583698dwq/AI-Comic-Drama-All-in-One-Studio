# ── 日志必须最先初始化：exe 无控制台（--windowed），print/未捕获异常全部落盘 storage/logs/studio.log ──
import logging
from app.core.logging_config import bootstrap_logging, attach_asyncio_exception_handler
bootstrap_logging()
logger = logging.getLogger("main")

import os
import time as _time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.responses import JSONResponse
from app.core.config import settings, cors_extra_origins, is_local_or_allowed_origin
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

from contextlib import asynccontextmanager

from app.storage_sync.mirror import mirror


@asynccontextmanager
async def _lifespan(_app):
    """MCP 原有 lifespan 照常走，另外把素材/工程的云端同步拉起来。"""
    attach_asyncio_exception_handler()  # asyncio 后台任务崩溃 → traceback 落盘
    logger.info("lifespan begin")
    try:
        await mirror.start()
    except Exception as e:
        print(f"[StorageSync] 启动失败（不影响主服务）: {e}")
    if mcp_http_app:
        async with mcp_http_app.lifespan(_app):
            yield
    else:
        yield
    try:
        await mirror.stop()
    except Exception:
        pass


app = FastAPI(
    title=settings.PROJECT_NAME,
    description="AI 漫剧双端（移动端 App + 桌面端 Desktop）中枢引擎：MiniMax LLM 剧本拆解 / 动态多Provider生图(ComfyUI/硅基流动/通义万象) / 动态多Provider配音(MiniMax/ElevenLabs/CosyVoice/GPT-SoVITS) / pyJianYingDraft 剪映导出 / MCP 工具扩展（导演Agent全量暴露）",
    version="2.1.0",
    lifespan=_lifespan,
)

# Configure CORS for multi-platform Web / Desktop / Mobile clients
# 只放行本机来源：打包态前端由本服务同源 serve，开发态 vite 在 localhost:5173 直连属真跨域。
# 曾经的 allow_origins=["*"] 会让浏览器里任意网页在应用运行期间读写本服务。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
    allow_origins=cors_extra_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 请求日志：4xx WARNING / 5xx ERROR（带 traceback）/ 其余 DEBUG（LOG_LEVEL=DEBUG 时可见全流水）
_REQ_LOG_NOISE = ("/assets/", "/storage/", "/exports/", "/system/logs/", "/api/v1/health", "/api/status", "/mcp-server")


@app.middleware("http")
async def _request_log(request, call_next):
    path = request.url.path
    noisy = any(path.startswith(p) or path == p.rstrip("/") for p in _REQ_LOG_NOISE)
    t0 = _time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        dt = int((_time.perf_counter() - t0) * 1000)
        if not noisy:
            logger.error("%s %s -> 500 (%dms) unhandled", request.method, path, dt, exc_info=True)
        raise
    dt = int((_time.perf_counter() - t0) * 1000)
    if not noisy:
        line = "%s %s -> %s (%dms)" % (request.method, path, response.status_code, dt)
        if response.status_code >= 500:
            logger.error(line)
        elif response.status_code >= 400:
            logger.warning(line)
        else:
            logger.debug(line)
    return response


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request, exc):
    # 注意：handler 收到的 exc 不在 except 块内，必须显式 exc_info=exc 才有 traceback
    logger.error("未处理异常 %s %s: %s", request.method, request.url.path, exc, exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"detail": f"服务器内部错误: {type(exc).__name__}: {str(exc)[:300]}"},
    )


# 任意工具执行口：CORS 只挡浏览器读响应，跨源 POST 在服务端仍会执行（fire-and-forget）。
# 这两个口能跑代码/花钱，故额外显式拒绝非本机 Origin；不带 Origin 的原生/同源请求不受影响。
EXECUTION_PATHS = {
    f"{settings.API_V1_STR}/mcp/call",
    f"{settings.API_V1_STR}/extensions/execute",
}


@app.middleware("http")
async def _origin_guard(request, call_next):
    if request.url.path in EXECUTION_PATHS and request.method.upper() != "OPTIONS":
        origin = request.headers.get("origin") or ""
        if not is_local_or_allowed_origin(origin):
            return JSONResponse(
                status_code=403,
                content={"detail": f"已拒绝跨源调用（Origin={origin}）：本机工具执行口不对外站开放"},
            )
    return await call_next(request)


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

# 功能页（page）默认停用集播种：首次运行把默认关的页面写入扩展覆盖层（幂等，失败不阻断启动）
try:
    from app.core import pages as _pages
    _page_seed = _pages.seed_defaults()
    if _page_seed.get("seeded"):
        print(f"[Main] Page defaults seeded (disabled={_page_seed.get('disabled')})")
except Exception as e:
    print(f"[Main] Page defaults seed failed: {e}")

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
# 一键成片 Agent 任务路由（异步 + 轮询）
try:
    from app.api.onekey_routes import router as onekey_router
    app.include_router(onekey_router, prefix=settings.API_V1_STR)
    print("[Main] OneKey routes mounted at /api/v1/onekey")
except Exception as e:
    print(f"[Main] OneKey routes mount failed: {e}")
# 分镜槽路由（storyboard_slots 聚合 + 项目覆盖 + 裸件 CRUD）
try:
    from app.api.storyboard_slot_routes import router as storyboard_slot_router
    app.include_router(storyboard_slot_router, prefix=settings.API_V1_STR)
    print("[Main] StoryboardSlot routes mounted at /api/v1/storyboard/slots")
except Exception as e:
    print(f"[Main] StoryboardSlot routes mount failed: {e}")
# 统一扩展注册表路由（聚合查看 + 统一执行 + 统一启停）
try:
    from app.api.extension_routes import router as extension_router
    app.include_router(extension_router, prefix=settings.API_V1_STR)
    print("[Main] Extension routes mounted at /api/v1/extensions")
except Exception as e:
    print(f"[Main] Extension routes mount failed: {e}")
# 功能页运行时开关路由（清单 + 启停状态）
try:
    from app.api.page_routes import router as page_router
    app.include_router(page_router, prefix=settings.API_V1_STR)
    print("[Main] Page routes mounted at /api/v1/pages")
except Exception as e:
    print(f"[Main] Page routes mount failed: {e}")
# 插件系统路由（P1：providers/skills/workflows/mcp_tools 四类扩展点）
try:
    from app.api.plugin_routes import router as plugin_router
    app.include_router(plugin_router, prefix=settings.API_V1_STR)
    print("[Main] Plugin routes mounted at /api/v1/plugins")
except Exception as e:
    print(f"[Main] Plugin routes mount failed: {e}")
# 自定义代码节点路由（CRUD/体检/试运行/单次执行）
try:
    from app.api.custom_node_routes import router as custom_node_router
    app.include_router(custom_node_router, prefix=settings.API_V1_STR)
    print("[Main] CustomNode routes mounted at /api/v1/custom-nodes")
except Exception as e:
    print(f"[Main] CustomNode routes mount failed: {e}")
# 声明式画布节点路由（canvas_nodes 声明 CRUD/单次执行）
try:
    from app.api.canvas_node_routes import router as canvas_node_router
    app.include_router(canvas_node_router, prefix=settings.API_V1_STR)
    print("[Main] CanvasNode routes mounted at /api/v1/canvas-nodes")
except Exception as e:
    print(f"[Main] CanvasNode routes mount failed: {e}")
# 画布时间线节点路由（引擎自检 / 合片 MP4 长任务 / 降级剪映草稿；画布页关闭时整族 404）
try:
    from app.api.timeline_routes import router as timeline_router
    app.include_router(timeline_router, prefix=settings.API_V1_STR)
    print("[Main] Timeline routes mounted at /api/v1/timeline")
except Exception as e:
    print(f"[Main] Timeline routes mount failed: {e}")
# 前端扩展点路由：主题包 / 导出器 / 导演包
# 三个模块导出的都是 `router`（与其余路由模块一致），此前按 theme_router/exporter_router/
# director_pack_router 取会 AttributeError，被 except 吞掉 → 三个扩展点静默未挂载
for _mod, _name, _path in (
    ("app.api.theme_routes", "router", "/api/v1/themes"),
    ("app.api.exporter_routes", "router", "/api/v1/exporters"),
    ("app.api.director_pack_routes", "router", "/api/v1/director-packs"),
    ("app.api.agent_team_routes", "router", "/api/v1/agent-teams"),
):
    try:
        import importlib as _il
        _r = getattr(_il.import_module(_mod), _name)
        app.include_router(_r, prefix=settings.API_V1_STR)
        print(f"[Main] FrontendExt routes mounted at {_path}")
    except Exception as e:
        print(f"[Main] FrontendExt routes mount failed ({_mod}): {e}")
# 首次启动引导路由（安装向导状态）
try:
    from app.api.setup_routes import router as setup_router
    app.include_router(setup_router, prefix=settings.API_V1_STR)
    print("[Main] Setup routes mounted at /api/v1/system/setup-status")
except Exception as e:
    print(f"[Main] Setup routes mount failed: {e}")
# 日志接口（调试）：tail / files / download / frontend 上报 / 运行期级别
try:
    from app.api.log_routes import router as log_router
    app.include_router(log_router, prefix=settings.API_V1_STR)
    logger.info("Log routes mounted at /api/v1/system/logs")
except Exception as e:
    logger.error("Log routes mount failed: %s", e)
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

class MirrorStaticFiles(StaticFiles):
    """
    /storage 的静态服务，多一条兜底：本机没有这个文件时，
    先去 OpenList 把它拉回来再照常吐出去（Range、缓存头一切不变）。

    换台机器打开同一个工程时，素材就是这样「自己长出来」的 ——
    前端一行不用改，请求的还是原来的 /storage/xxx。
    """

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code != 404:
                raise
            try:
                if await mirror.ensure_local(path.replace("\\", "/")):
                    return await super().get_response(path, scope)
            except Exception as pull_err:
                print(f"[StorageSync] 回拉失败 {path}: {pull_err}")
            raise


# Mount static/export directories
if os.path.exists(settings.STORAGE_DIR):
    app.mount("/storage", MirrorStaticFiles(directory=settings.STORAGE_DIR), name="storage")

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
        from app.providers.video.registry import video_registry
        img_ids = image_registry.list_ids() if hasattr(image_registry, "list_ids") else []
        aud_ids = audio_registry.list_ids() if hasattr(audio_registry, "list_ids") else []
        vid_ids = video_registry.list_ids() if hasattr(video_registry, "list_ids") else []
        return {
            "status": "healthy",
            "comfyui_online": False,
            "openai_configured": bool(settings.OPENAI_API_KEY),
            "providers": {
                "image": img_ids,
                "audio": aud_ids,
                "video": vid_ids,
                "image_count": len(img_ids),
                "audio_count": len(aud_ids),
                "video_count": len(vid_ids),
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
