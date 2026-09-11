# -*- coding: utf-8 -*-
"""构建单文件安装器 exe。

1. 把 dist/AI漫剧Studio_0.1.0 压成 installer/payload.zip（deflate）
2. PyInstaller --onefile 把 installer/installer_app.py + payload.zip 打成
   dist/AI漫剧Studio_0.1.0_安装程序.exe（双击=安装向导）

用法：
  python build_installer.py                 # 使用默认源目录
  python build_installer.py <源目录>        # 自定义源目录
"""
import os
import sys
import time
import zipfile
import subprocess

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIST, "AI漫剧Studio_0.1.0")
PAYLOAD = os.path.join(ROOT, "installer", "payload.zip")
OUT_NAME = "AI漫剧Studio_0.1.0_安装程序"

if not os.path.isdir(SRC_DIR):
    print(f"❌ 源目录不存在: {SRC_DIR}")
    print("   先运行: python build_release.py --release")
    sys.exit(1)

print("==================================================")
print("  构建单文件安装器")
print(f"  源目录: {SRC_DIR}")
print("==================================================")

# 1. 压缩整包
print("\n[1/2] 压缩安装负载 payload.zip …")
os.makedirs(os.path.dirname(PAYLOAD), exist_ok=True)
if os.path.exists(PAYLOAD):
    os.remove(PAYLOAD)
t0 = time.time()
files = []
for dp, _dn, fn in os.walk(SRC_DIR):
    for f in fn:
        files.append(os.path.join(dp, f))
total = len(files)
with zipfile.ZipFile(PAYLOAD, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for i, fp in enumerate(files, 1):
        zf.write(fp, os.path.relpath(fp, SRC_DIR))
        if i % 400 == 0 or i == total:
            print(f"  {i}/{total} …", end="\r")
print(f"\n  ✓ payload.zip = {os.path.getsize(PAYLOAD)/1024/1024:.0f} MB，用时 {time.time()-t0:.0f}s")

# 2. PyInstaller onefile
print("\n[2/2] PyInstaller 打包单文件安装器 …")
cmd = [
    sys.executable, "-m", "PyInstaller",
    "--noconfirm", "--clean",
    "--onefile", "--windowed",
    "--name", OUT_NAME,
    "--add-data", f"{PAYLOAD};.",
    "--distpath", DIST,
    "--workpath", os.path.join(ROOT, "build_installer"),
    "--specpath", os.path.join(ROOT, "installer"),
    os.path.join(ROOT, "installer", "installer_app.py"),
]
res = subprocess.run(cmd, cwd=ROOT)
if res.returncode != 0:
    print("❌ 安装器打包失败")
    sys.exit(1)

out_exe = os.path.join(DIST, OUT_NAME + ".exe")
print("\n==================================================")
print("  🎉 安装器构建完成")
print(f"  👉 {out_exe}")
print(f"     大小 {os.path.getsize(out_exe)/1024/1024:.0f} MB")
print("==================================================")
