# -*- coding: utf-8 -*-
"""构建 onedir 之外的「单文件」版 Studio.exe（PyInstaller --onefile）。

- 输出：dist/AI漫剧Studio_0.1.0_单文件.exe（双击即开，无 _internal 文件夹）
- 构建期间临时移走 server/.env，避免把个人 Key 打进 exe
- 注意：onefile 每次启动会自解压到临时目录，首次启动较慢
"""
import os
import sys
import time
import shutil
import subprocess

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
NAME = "AI漫剧Studio_0.1.0_单文件"

# 需要临时移出的敏感文件（避免打进 exe）
STASH = [
    os.path.join(ROOT, "server", ".env"),
]

print("==================================================")
print("  构建单文件版 Studio.exe（onefile）")
print("==================================================")

# 1. 暂存敏感文件
moved = []
for src in STASH:
    if os.path.isfile(src):
        bak = src + ".__buildbak"
        try:
            shutil.move(src, bak)
            moved.append((src, bak))
            print(f"  已暂存: {os.path.relpath(src, ROOT)}")
        except Exception as e:
            print(f"  暂存失败 {src}: {e}")

try:
    # 2. PyInstaller onefile
    print("\n[1/1] PyInstaller onefile 打包中（较慢，请耐心）...")
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile", "--windowed",
        "--name", NAME,
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
        "--collect-all", "aiohttp",
        "--collect-all", "requests",
        "--collect-all", "langchain",
        "--collect-all", "langchain_openai",
        "--collect-all", "langchain_core",
        "--collect-all", "langgraph",
        "--distpath", DIST,
        "--workpath", os.path.join(ROOT, "build_onefile"),
        "--specpath", os.path.join(ROOT, "installer"),
        os.path.join(ROOT, "launch_desktop_app.py"),
    ]
    res = subprocess.run(cmd, cwd=ROOT)
    if res.returncode != 0:
        print("❌ onefile 打包失败")
        sys.exit(1)
finally:
    # 3. 还原敏感文件
    for src, bak in moved:
        try:
            shutil.move(bak, src)
            print(f"  已还原: {os.path.relpath(src, ROOT)}")
        except Exception as e:
            print(f"  还原失败 {src}: {e}")

out = os.path.join(DIST, NAME + ".exe")
if os.path.isfile(out):
    print("\n==================================================")
    print("  🎉 单文件版构建完成")
    print(f"  👉 {out}")
    print(f"     大小 {os.path.getsize(out)/1024/1024:.0f} MB（双击即开，无需 _internal）")
    print("==================================================")
else:
    print("❌ 未找到输出 exe")
