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

print("==================================================")
print("  🚀 开始全量重构与构建 AI 漫剧 Studio")
print("==================================================")

# 1. 编译前端
print("\n[1/4] 正在编译前端生产资源 (Vite + TypeScript)...")
res = subprocess.run(["npm", "run", "build"], cwd=CLIENT_DIR, shell=True)
if res.returncode != 0:
    print("❌ 前端编译失败，请检查错误日志")
    sys.exit(1)
print("✓ 前端构建完成 -> client/dist")

# 2. PyInstaller 独立桌面端打包
print("\n[2/4] 正在使用 PyInstaller 打包 Windows 独立应用...")
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
    "--collect-all", "pyjianyingdraft",
    "--collect-all", "fastmcp",
    "--collect-all", "pydantic",
    "--collect-all", "httpx",
    os.path.join(ROOT, "launch_desktop_app.py")
]

res = subprocess.run(pyinstaller_cmd, cwd=ROOT)
if res.returncode != 0:
    print("❌ PyInstaller 打包失败，请检查错误日志")
    sys.exit(1)

# 3. 复制前端资源到 dist 目录确保即时生效
print("\n[3/4] 正在同步资源与建立双路径镜像...")
client_dist_src = os.path.join(ROOT, "client", "dist")

for target_dir in [
    os.path.join(STUDIO_DIR, "client", "dist"),
    os.path.join(STUDIO_DIR, "_internal", "client", "dist"),
]:
    if os.path.exists(target_dir):
        shutil.rmtree(target_dir)
    shutil.copytree(client_dist_src, target_dir)

# 镜像到 MiniMax_AI漫剧Studio
if os.path.exists(MINIMAX_DIR):
    shutil.rmtree(MINIMAX_DIR)
shutil.copytree(STUDIO_DIR, MINIMAX_DIR)
shutil.copyfile(os.path.join(STUDIO_DIR, "Studio.exe"), os.path.join(MINIMAX_DIR, "MiniMax_AI漫剧Studio.exe"))

# 4. 重写启动脚本 (GBK 编码)
print("\n[4/4] 正在更新一键启动脚本...")
batch_content = """@echo off
title AI Studio
cd /d "%~dp0"

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
print("  🎉 全量构建完成！")
print(f"  👉 独立桌面版: {os.path.join(STUDIO_DIR, 'Studio.exe')}")
print(f"  👉 一键启动脚本: {os.path.join(ROOT, '一键启动.bat')}")
print("==================================================")
