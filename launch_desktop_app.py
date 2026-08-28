# -*- coding: utf-8 -*-
"""
MiniMax AI 漫剧 Studio - Windows 桌面原生应用启动器
自动在后台拉起 FastAPI + FastMCP 后端引擎，并以原生桌面窗口 (WebView2 / Edge) 呈现工作台。
"""
import os
import sys
import time
import socket
import threading
import urllib.request
import webbrowser
import subprocess
import multiprocessing

# Safe standard output configuration for Windows console
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

def safe_log(msg: str):
    try:
        print(msg)
    except Exception:
        try:
            print(msg.encode('ascii', errors='ignore').decode('ascii'))
        except Exception:
            pass
    try:
        log_file = os.path.join(os.path.dirname(sys.executable if getattr(sys, 'frozen', False) else __file__), "app_startup.log")
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass

# Resolve base directories (handles PyInstaller _MEIPASS and normal execution)
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    EXE_DIR = os.path.dirname(sys.executable)
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    EXE_DIR = BUNDLE_DIR

# Ensure server module path is available in sys.path
for path in [
    os.path.join(BUNDLE_DIR, "server"),
    os.path.join(EXE_DIR, "server"),
    os.path.join(BUNDLE_DIR, "server", "app"),
    BUNDLE_DIR,
]:
    if os.path.exists(path) and path not in sys.path:
        sys.path.insert(0, path)

PORT = 8000
HOST = "127.0.0.1"
URL = f"http://{HOST}:{PORT}"

def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0

def run_server_thread():
    try:
        import traceback
        import uvicorn
        from app.main import app
        # log_config=None is critical for PyInstaller frozen executable to avoid "Unable to configure formatter 'default'"
        config = uvicorn.Config(app=app, host=HOST, port=PORT, log_config=None, log_level="warning")
        server = uvicorn.Server(config)
        server.run()
    except Exception as e:
        import traceback
        safe_log(f"[Server Error] {e}\n{traceback.format_exc()}")

def wait_for_server(timeout: float = 30.0) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(f"{URL}/api/v1/health", timeout=1.5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False

def launch_app_browser_mode():
    edge_paths = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for p in edge_paths:
        if os.path.exists(p):
            try:
                subprocess.Popen([p, f"--app={URL}", "--window-size=1440,920"])
                safe_log(f"[Browser Mode] Launched Edge App mode: {p}")
                return
            except Exception:
                pass
    chrome_paths = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ]
    for p in chrome_paths:
        if os.path.exists(p):
            try:
                subprocess.Popen([p, f"--app={URL}", "--window-size=1440,920"])
                safe_log(f"[Browser Mode] Launched Chrome App mode: {p}")
                return
            except Exception:
                pass
    safe_log("[Browser Mode] Opening default browser...")
    webbrowser.open(URL)

def main():
    safe_log("========================================================")
    safe_log("  MiniMax AI 漫剧 Studio (Windows 桌面版)")
    safe_log("  正在初始化漫剧引擎与 3D 虚拟导演台...")
    safe_log("========================================================")

    # 1. Start backend if not already running
    if not is_port_in_use(PORT):
        t = threading.Thread(target=run_server_thread, daemon=True)
        t.start()
        safe_log("[1/2] 后端引擎正在启动...")
    else:
        safe_log("[1/2] 检测到后端服务已在运行 (Port: 8000)")

    # 2. Wait for server to become healthy
    safe_log("[2/2] 等待服务就绪...")
    if not wait_for_server(timeout=30.0):
        safe_log("[Warning] 服务探测超时，尝试直接呈现窗口...")

    safe_log("[Success] 服务已就绪！正在打开原生桌面工作台...")

    # 3. Launch Native WebView Window or Browser App Mode
    opened = False
    try:
        import webview
        window = webview.create_window(
            title="MiniMax AI 漫剧 Studio (Desktop + Mobile 双端工作台)",
            url=URL,
            width=1440,
            height=920,
            min_size=(1080, 720),
            background_color="#07070A",
            text_select=True,
            zoomable=True,
        )
        safe_log("[GUI] 启动原生 WebView2 窗口...")
        webview.start(debug=False)
        opened = True
    except Exception as e:
        safe_log(f"[GUI Notice] 原生窗口组件异常: {e}，无缝切换为独立浏览器 App 窗口模式...")
    
    if not opened:
        launch_app_browser_mode()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            safe_log("[Exit] 用户退出应用")

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
