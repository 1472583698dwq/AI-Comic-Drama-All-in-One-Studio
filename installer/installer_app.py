# -*- coding: utf-8 -*-
"""AI 漫剧 Studio 单文件安装器（Tkinter 安装向导）。

- 内置整包 payload.zip（由 build_installer.py 生成）
- 双击运行 → 选择安装目录 → 解压全部文件 → 可勾选立即启动 Studio.exe
- 运行时依赖已随包内置：用户无需安装 Python / 任何依赖
"""
import os
import sys
import threading
import zipfile
import subprocess
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

APP_NAME = "AI 漫剧 Studio"
VERSION = "0.1.0"
DEFAULT_DIR = os.environ.get("AI_DRAMA_DEFAULT_DIR") or ""


def resource_path(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


def default_install_dir() -> str:
    if DEFAULT_DIR:
        return DEFAULT_DIR
    # 优先非系统盘某个固定目录，其次用户本地目录
    for root in ("D:\\", "E:\\", "C:\\"):
        if os.path.isdir(root):
            if root[0] in ("D", "E"):
                return os.path.join(root, "AI漫剧Studio")
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AI漫剧Studio")


class Installer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} 安装程序 v{VERSION}")
        self.geometry("560x380")
        self.resizable(False, False)
        try:
            self.iconbitmap(default="")
        except Exception:
            pass

        self.payload = resource_path("payload.zip")
        self.total = 0
        try:
            with zipfile.ZipFile(self.payload) as zf:
                self.total = len(zf.namelist())
        except Exception:
            self.total = 0

        self._build_ui()

    def _build_ui(self):
        pad = {"padx": 18}
        title = tk.Label(self, text=f"欢迎使用 {APP_NAME}", font=("Microsoft YaHei UI", 14, "bold"))
        title.pack(anchor="w", pady=(16, 2), **pad)
        tk.Label(self, text="安装向导将把程序完整解压到下面的目录，无需安装 Python 或其他依赖。",
                 fg="#555", justify="left", wraplength=510).pack(anchor="w", **pad)

        frm = tk.Frame(self)
        frm.pack(fill="x", pady=(14, 4), **pad)
        tk.Label(frm, text="安装位置：").grid(row=0, column=0, sticky="w")
        self.dir_var = tk.StringVar(value=default_install_dir())
        entry = tk.Entry(frm, textvariable=self.dir_var, width=44)
        entry.grid(row=0, column=1, padx=(4, 6))
        tk.Button(frm, text="浏览…", command=self._browse).grid(row=0, column=2)

        tk.Label(self, text="需要约 1.2 GB 磁盘空间。若目录已存在，将覆盖其中同名文件。",
                 fg="#888").pack(anchor="w", pady=(2, 8), **pad)

        self.launch_var = tk.BooleanVar(value=True)
        tk.Checkbutton(self, text="安装完成后立即启动", variable=self.launch_var).pack(anchor="w", **pad)

        self.progress = ttk.Progressbar(self, length=520, mode="determinate", maximum=100)
        self.progress.pack(pady=(14, 4), **pad)
        self.status = tk.Label(self, text="准备就绪", fg="#666")
        self.status.pack(anchor="w", **pad)

        self.install_btn = tk.Button(self, text="开始安装", height=1, width=16,
                                     font=("Microsoft YaHei UI", 10, "bold"),
                                     bg="#4f46e5", fg="white", activebackground="#4338ca",
                                     command=self._start_install)
        self.install_btn.pack(pady=14)

    def _browse(self):
        d = filedialog.askdirectory(title="选择安装目录")
        if d:
            self.dir_var.set(os.path.join(d, "AI漫剧Studio") if os.path.basename(d).lower() != "ai漫剧studio" else d)

    def _start_install(self):
        target = self.dir_var.get().strip()
        if not target:
            messagebox.showwarning("提示", "请先选择安装目录")
            return
        try:
            os.makedirs(target, exist_ok=True)
        except Exception as e:
            messagebox.showerror("错误", f"无法创建目录：{e}")
            return
        self.install_btn.config(state="disabled")
        threading.Thread(target=self._do_install, args=(target,), daemon=True).start()

    def _do_install(self, target: str):
        try:
            with zipfile.ZipFile(self.payload) as zf:
                total = len(zf.namelist())
                for i, name in enumerate(zf.namelist(), 1):
                    zf.extract(name, target)
                    if i % 20 == 0 or i == total:
                        pct = int(i * 100 / max(1, total))
                        self.after(0, self._set_progress, pct, f"正在解压… {i}/{total}")
            self.after(0, self._set_progress, 100, "安装完成")
            self.after(0, self._finish, target)
        except Exception as e:
            self.after(0, lambda: messagebox.showerror("安装失败", str(e)))
            self.after(0, lambda: self.install_btn.config(state="normal"))

    def _set_progress(self, pct: int, text: str):
        self.progress["value"] = pct
        self.status.config(text=text)

    def _finish(self, target: str):
        exe = os.path.join(target, "Studio.exe")
        ok = os.path.isfile(exe)
        if self.launch_var.get() and ok:
            try:
                subprocess.Popen([exe], cwd=target)
            except Exception as e:
                messagebox.showwarning("启动失败", f"安装已完成，但自动启动失败：{e}\n请手动双击 {exe}")
        messagebox.showinfo("完成", f"{APP_NAME} 已安装到：\n{target}\n\n"
                                     f"{'已启动。' if self.launch_var.get() and ok else '可从该目录双击 Studio.exe 启动。'}")
        self.destroy()


if __name__ == "__main__":
    if not os.path.isfile(resource_path("payload.zip")):
        # 非打包状态下直接运行也给出提示
        root = tk.Tk(); root.withdraw()
        messagebox.showerror("缺少负载", "未找到 payload.zip，请用 build_installer.py 构建。")
        sys.exit(1)
    Installer().mainloop()
