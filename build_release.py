# -*- coding: utf-8 -*-
"""
一键全量构建发布脚本 (Build Release)
1. 编译前端 Vite + React -> client/dist
2. 调用 PyInstaller 重新打包 Windows 独立桌面应用 -> dist/Studio/Studio.exe
3. 同步至 dist/MiniMax_AI漫剧Studio
4. 校验产物完整性与后端服务
"""
import os
import sys
import shutil
import subprocess

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(ROOT, "client")
DIST_DIR = os.path.join(ROOT, "dist")
STUDIO_DIR = os.path.join(DIST_DIR, "Studio")
MINIMAX_DIR = os.path.join(DIST_DIR, "MiniMax_AI漫剧Studio")

# 发布模式：python build_release.py --release
# 剔除个人 Key / 数据 / 开发文件，附《使用说明.md》，产出可安全分发的干净包
RELEASE = "--release" in sys.argv

print("==================================================")
print("  🚀 开始构建 AI 漫剧 Studio")
if RELEASE:
    print("  📦 模式：干净发布包（--release）")
    print("  📂 输出：dist\\AI漫剧Studio_0.1.0（不覆盖 dist\\Studio）")
print("==================================================")

# 输出目录：发布模式输出到独立目录，绝不覆盖开发用的 dist/Studio
RELEASE_DIR = os.path.join(DIST_DIR, "AI漫剧Studio_0.1.0")
RELEASE_BUILD_DIR = os.path.join(DIST_DIR, "_release_build")
OUT_DIR = RELEASE_DIR if RELEASE else STUDIO_DIR

# 0. 备份用户持久化配置（避免 dist 重建导致丢失）
print("\n[0/4] 正在备份用户配置与持久化数据...")
_backup_store = {}
# 需要备份的根目录配置
_root_persist = [
    os.path.join(ROOT, ".env"),
    os.path.join(ROOT, "server", ".env"),
    os.path.join(ROOT, "storage", "config_store.json"),
]
# 之前构建产物中的用户数据（exe 运行后会写到 dist/Studio/storage）
_dist_persist = [
    os.path.join(STUDIO_DIR, ".env"),
    os.path.join(STUDIO_DIR, "server", ".env"),
    os.path.join(STUDIO_DIR, "storage", "config_store.json"),
    os.path.join(STUDIO_DIR, "_internal", "storage", "config_store.json"),
]
for _p in _root_persist + _dist_persist:
    try:
        if os.path.exists(_p) and os.path.isfile(_p) and os.path.getsize(_p) > 0:
            with open(_p, "rb") as _f:
                _c = _f.read()
            # 至少包含一个有效键才算有价值
            if _c.strip():
                _backup_store[_p] = _c
                print(f"  已备份: {_p} ({len(_c)} bytes)")
    except Exception as _e:
        print(f"  备份跳过 {_p}: {_e}")

# 1. 编译前端
print("\n[1/4] 正在编译前端生产资源 (Vite + TypeScript)...")
# 显式清空旧产物，避免历史 hashed chunk 残留导致包体膨胀
_cli_dist = os.path.join(CLIENT_DIR, "dist")
try:
    if os.path.exists(_cli_dist):
        shutil.rmtree(_cli_dist, ignore_errors=True)
        print("  已清空旧 client/dist")
except Exception as _e:
    print(f"  清理 client/dist 跳过: {_e}")
res = subprocess.run(["npm", "run", "build"], cwd=CLIENT_DIR, shell=True)
if res.returncode != 0:
    print("❌ 前端编译失败，请检查错误日志")
    sys.exit(1)
print("✓ 前端构建完成 -> client/dist")

# 2. PyInstaller 独立桌面端打包
print("\n[2/4] 正在使用 PyInstaller 打包 Windows 独立应用...")
import time
try:
    subprocess.run(["taskkill", "/F", "/IM", "Studio.exe"], capture_output=True, shell=True)
    subprocess.run(["taskkill", "/F", "/IM", "MiniMax_AI漫剧Studio.exe"], capture_output=True, shell=True)
    time.sleep(2)
except Exception:
    pass
pyinstaller_cmd = [
    sys.executable, "-m", "PyInstaller",
    "--noconfirm",
    "--onedir",
    "--windowed",
    "--name", "Studio",
    "--add-data", f"{os.path.join(ROOT, 'client', 'dist')};client/dist",
    "--add-data", f"{os.path.join(ROOT, 'server')};server",
    "--collect-all", "fastapi",
    "--collect-all", "starlette",
    "--collect-all", "uvicorn",
    "--collect-all", "pywebview",
    "--collect-all", "pyJianYingDraft",
    "--collect-all", "fastmcp",
    "--collect-all", "pydantic",
    "--collect-all", "httpx",
    "--collect-all", "aiohttp",
    "--collect-all", "requests",
    "--collect-all", "langchain",
    "--collect-all", "langchain_openai",
    "--collect-all", "langchain_core",
    "--collect-all", "langgraph",
    os.path.join(ROOT, "launch_desktop_app.py")
]
# 发布模式：构建到独立目录，避免覆盖 dist/Studio
if RELEASE:
    pyinstaller_cmd[3:3] = ["--distpath", RELEASE_BUILD_DIR, "--workpath", os.path.join(ROOT, "build_release")]

res = subprocess.run(pyinstaller_cmd, cwd=ROOT)
if res.returncode != 0:
    print("❌ PyInstaller 打包失败，请检查错误日志")
    sys.exit(1)

# 发布模式：把构建产物移到独立发布目录（绝不覆盖 dist/Studio）
if RELEASE:
    _built = os.path.join(RELEASE_BUILD_DIR, "Studio")
    try:
        if os.path.exists(RELEASE_DIR):
            shutil.rmtree(RELEASE_DIR, ignore_errors=True)
        shutil.move(_built, RELEASE_DIR)
        shutil.rmtree(RELEASE_BUILD_DIR, ignore_errors=True)
        print(f"  发布包已生成 -> {RELEASE_DIR}")
    except Exception as _e:
        print(f"❌ 移动发布包失败: {_e}")
        sys.exit(1)

# 3. 复制前端资源到 dist 目录确保即时生效
print("\n[3/4] 正在同步资源与建立双路径镜像...")
client_dist_src = os.path.join(ROOT, "client", "dist")

for target_dir in [
    os.path.join(OUT_DIR, "client", "dist"),
    os.path.join(OUT_DIR, "_internal", "client", "dist"),
]:
    if os.path.exists(target_dir):
        shutil.rmtree(target_dir)
    shutil.copytree(client_dist_src, target_dir)

# 3.5 还原用户配置（仅常规构建；发布包必须干净、不含任何个人 Key）
if not RELEASE:
    def _best_backup_for(target_key: str):
        # 优先取根目录的最新备份
        for k in [os.path.join(ROOT, ".env"), os.path.join(ROOT, "server", ".env"), os.path.join(ROOT, "storage", "config_store.json")]:
            if target_key in os.path.basename(k) and k in _backup_store:
                return _backup_store[k]
        # 其次取 dist 中的备份
        for k, v in _backup_store.items():
            if target_key in os.path.basename(k):
                return v
        return None

    _restore_targets = [
        os.path.join(OUT_DIR, "storage", "config_store.json"),
        os.path.join(OUT_DIR, "_internal", "storage", "config_store.json"),
        os.path.join(OUT_DIR, ".env"),
        os.path.join(OUT_DIR, "server", ".env"),
    ]
    for _rt in _restore_targets:
        # 只有当 dist 中的文件为空或缺失时才还原
        need_restore = False
        if not os.path.exists(_rt):
            need_restore = True
        else:
            try:
                if os.path.getsize(_rt) == 0:
                    need_restore = True
                else:
                    with open(_rt, "r", encoding="utf-8") as _rf:
                        _txt = _rf.read().strip()
                    # 全空值也视为需要还原
                    if _txt in ("{}", ""):
                        need_restore = True
            except Exception:
                need_restore = True
        if need_restore:
            _best = _best_backup_for(os.path.basename(_rt))
            if _best:
                try:
                    os.makedirs(os.path.dirname(_rt), exist_ok=True)
                    with open(_rt, "wb") as _wf:
                        _wf.write(_best)
                    print(f"  已还原: {_rt}")
                except Exception as _e:
                    print(f"  还原失败 {_rt}: {_e}")

# 3.6 附带文档与示例插件包（使用说明引用的 plugin-dev.md / 可直接安装的示例导演组包）
try:
    _pkg_docs = os.path.join(OUT_DIR, "docs")
    os.makedirs(_pkg_docs, exist_ok=True)
    _pd = os.path.join(ROOT, "docs", "plugin-dev.md")
    if os.path.isfile(_pd):
        shutil.copyfile(_pd, os.path.join(_pkg_docs, "plugin-dev.md"))
    _demo_src = os.path.join(ROOT, "plugins", "example-drama-pack")
    _demo_dst = os.path.join(OUT_DIR, "plugins", "example-drama-pack")
    if os.path.isdir(_demo_src):
        shutil.rmtree(_demo_dst, ignore_errors=True)
        shutil.copytree(_demo_src, _demo_dst)
    print("  已附: docs/plugin-dev.md 与 plugins/example-drama-pack（示例插件包/导演组）")
except Exception as _e:
    print(f"  附带文档/示例包跳过: {_e}")

# 3.7 发布模式：剔除个人 Key / 数据 / 开发残留，附《使用说明.md》与 .env 模板
if RELEASE:
    print("\n[release] 正在生成干净发布包（递归剔除 Key / 数据 / 测试残留）...")
    _removed = 0
    for _dp, _dn, _fn in os.walk(OUT_DIR, topdown=False):
        _base = os.path.basename(_dp)
        # 开发/缓存目录整目录删除
        if _base in ("__pycache__", "tests", ".pytest_cache"):
            shutil.rmtree(_dp, ignore_errors=True)
            _removed += 1
            continue
        for _f in _fn:
            _drop = False
            _low = _f.lower()
            if _low.endswith(".env"):            # .env（.env.example 不在其列）
                _drop = True
            if _f in ("config_store.json", "setup.json"):
                _drop = True
            if _f.startswith("test_") or _f.startswith("tmp_"):
                _drop = True
            if _low.endswith(".log") or _low.endswith(".pyc"):
                _drop = True
            if _drop:
                try:
                    os.remove(os.path.join(_dp, _f))
                    _removed += 1
                except Exception:
                    pass
    print(f"  已递归清理 {_removed} 个敏感/开发文件")
    # 附带使用说明 + .env 模板（让用户知道要填什么）
    try:
        if os.path.isfile(os.path.join(ROOT, "使用说明.md")):
            shutil.copyfile(os.path.join(ROOT, "使用说明.md"), os.path.join(OUT_DIR, "使用说明.md"))
            print("  已附: 使用说明.md")
        _env_example = os.path.join(ROOT, "server", ".env.example")
        if os.path.isfile(_env_example):
            shutil.copyfile(_env_example, os.path.join(OUT_DIR, ".env.example"))
    except Exception as _e:
        print(f"  附件复制跳过: {_e}")
    # 发布包内一键启动（GBK）
    try:
        with open(os.path.join(OUT_DIR, "一键启动.bat"), "w", encoding="gbk", errors="ignore") as _bf:
            _bf.write('@echo off\r\ntitle AI 漫剧 Studio\r\ncd /d "%~dp0"\r\ntaskkill /f /im Studio.exe >nul 2>nul\r\ntimeout /t 1 /nobreak >nul\r\nstart "" "%~dp0Studio.exe"\r\n')
    except Exception:
        pass
    print(f"  ✅ 干净发布包: {RELEASE_DIR}")

# 镜像到 MiniMax_AI漫剧Studio（仅常规构建；发布模式不覆盖/不镜像）
if not RELEASE:
    try:
        if os.path.exists(MINIMAX_DIR):
            shutil.rmtree(MINIMAX_DIR, ignore_errors=True)
        shutil.copytree(OUT_DIR, MINIMAX_DIR, dirs_exist_ok=True)
        shutil.copyfile(os.path.join(OUT_DIR, "Studio.exe"), os.path.join(MINIMAX_DIR, "MiniMax_AI漫剧Studio.exe"))
    except Exception as e:
        print(f"镜像目录更新提示: {e}")

# 4. 重写启动脚本 (GBK 编码)
print("\n[4/4] 正在更新一键启动脚本...")
batch_content = """@echo off
title AI 漫剧 Studio
cd /d "%~dp0"

taskkill /f /im Studio.exe >nul 2>nul
taskkill /f /im MiniMax_AI漫剧Studio.exe >nul 2>nul
timeout /t 1 /nobreak >nul

if exist "%~dp0dist\\Studio\\Studio.exe" (
    start "" "%~dp0dist\\Studio\\Studio.exe"
    exit /b 0
)

if exist "%~dp0dist\\MiniMax_AI漫剧Studio\\MiniMax_AI漫剧Studio.exe" (
    start "" "%~dp0dist\\MiniMax_AI漫剧Studio\\MiniMax_AI漫剧Studio.exe"
    exit /b 0
)

if exist "%~dp0launch_desktop_app.py" (
    start "" python "%~dp0launch_desktop_app.py"
    exit /b 0
)

start "AI Studio Server" /min cmd /c "cd /d \"%~dp0server\" && python run_server.py"
timeout /t 2 >nul
start http://127.0.0.1:8000
exit /b 0
"""
for fname in ["一键启动.bat", "start_all.bat", "run.bat"]:
    with open(os.path.join(ROOT, fname), "w", encoding="gbk", errors="ignore") as f:
        f.write(batch_content)

vbs_content = '''Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

exePath1 = currentDir & "\\dist\\Studio\\Studio.exe"
exePath2 = currentDir & "\\dist\\MiniMax_AI漫剧Studio\\MiniMax_AI漫剧Studio.exe"
pyPath = currentDir & "\\launch_desktop_app.py"

If fso.FileExists(exePath1) Then
    ws.Run """" & exePath1 & """", 0, False
ElseIf fso.FileExists(exePath2) Then
    ws.Run """" & exePath2 & """", 0, False
ElseIf fso.FileExists(pyPath) Then
    ws.Run "python """ & pyPath & """", 0, False
Else
    ws.Run "cmd /c cd /d """ & currentDir & "\\server"" && python run_server.py", 0, False
    WScript.Sleep 2000
    ws.Run "http://127.0.0.1:8000"
End If
'''
with open(os.path.join(ROOT, "启动桌面应用(无黑框).vbs"), "w", encoding="gbk", errors="ignore") as f:
    f.write(vbs_content)

print("\n==================================================")
print("  🎉 构建完成！")
if RELEASE:
    print(f"  👉 干净发布包: {RELEASE_DIR}")
    print("     含 使用说明.md / .env.example / 一键启动.bat；整目录打包即可发给用户")
    print("     （未覆盖 dist\\Studio，开发副本保持原样）")
else:
    print(f"  👉 独立桌面版: {os.path.join(STUDIO_DIR, 'Studio.exe')}")
    print(f"  👉 一键启动脚本: {os.path.join(ROOT, '一键启动.bat')}")
print("==================================================")
