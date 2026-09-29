# -*- coding: utf-8 -*-
"""统一日志系统 —— 文件落盘 + print/未捕获异常收编 + 运行期级别切换。

背景：Studio.exe 以 --windowed 打包（无控制台），后端存量 print() 全部蒸发，无法调试。
本模块解决三件事：
1. RotatingFileHandler 落盘 {STORAGE_DIR}/logs/studio.log（5MB × 5 滚动，UTF-8）
2. sys.stdout/stderr 重定向到 logger —— 164 处存量 print() 零改动全部入档
3. sys.excepthook / threading.excepthook / asyncio 全局异常 → 带 traceback 落盘
   （此前后台任务崩溃直接消失）

运行期级别优先级：storage/log_level.json（POST /system/logs/level 写入）> LOG_LEVEL 环境变量 > INFO。
"""
import asyncio
import json
import logging
import logging.handlers
import os
import sys
import threading
import traceback
from typing import List, Optional

_FMT = "%(asctime)s [%(levelname).1s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

_BOOTSTRAPPED = False
_ORIG_STDOUT = sys.stdout
_ORIG_STDERR = sys.stderr
_LOG_DIR: str = ""
_MAIN_LOG: str = ""

# 每条日志记录里级别字段是单字母：[D] [I] [W] [E] [C]
_LEVEL_LETTERS = {"DEBUG": "D", "INFO": "I", "WARNING": "W", "ERROR": "E", "CRITICAL": "C"}
_LEVEL_FROM_LETTER = {v: k for k, v in _LEVEL_LETTERS.items()}


def log_dir() -> str:
    return _LOG_DIR


def main_log_path() -> str:
    return _MAIN_LOG


def _resolve_log_dir(override: Optional[str] = None) -> str:
    if override:
        return os.path.abspath(override)
    try:
        from app.core.config import settings
        return os.path.join(settings.STORAGE_DIR, "logs")
    except Exception:
        return os.path.abspath(os.path.join(os.getcwd(), "storage", "logs"))


def _level_file_path(log_directory: str) -> str:
    return os.path.join(os.path.dirname(log_directory), "log_level.json")


def resolve_level(log_directory: Optional[str] = None) -> int:
    """运行期级别优先级：log_level.json > LOG_LEVEL 环境变量 > INFO。"""
    directory = log_directory or _LOG_DIR or _resolve_log_dir()
    try:
        with open(_level_file_path(directory), "r", encoding="utf-8") as f:
            name = str((json.load(f) or {}).get("level") or "").strip().upper()
        if name in ("DEBUG", "INFO", "WARNING", "ERROR"):
            return getattr(logging, name)
    except Exception:
        pass
    env = (os.environ.get("LOG_LEVEL") or "").strip().upper()
    if env in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        return getattr(logging, env)
    return logging.INFO


def set_level(name: str) -> str:
    """运行期切换级别：立即生效并持久化到 storage/log_level.json。"""
    name = (name or "").strip().upper()
    if name not in ("DEBUG", "INFO", "WARNING", "ERROR"):
        raise ValueError(f"不支持的日志级别: {name}")
    logging.getLogger().setLevel(getattr(logging, name))
    try:
        path = _level_file_path(_LOG_DIR or _resolve_log_dir())
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"level": name}, f, ensure_ascii=False)
    except Exception:
        pass
    return name


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


class _LoggerWriter:
    """把 print()/sys.stderr 输出接到 logging。

    带重入保护：handler 报错时 logging 会往 stderr 写错误，此时直接落原始 stderr，防递归。
    """

    def __init__(self, logger: logging.Logger, level: int):
        self._logger = logger
        self._level = level
        self._in_write = False
        self.encoding = "utf-8"

    def write(self, msg) -> int:
        text = str(msg or "")
        if not text.strip():
            return len(text)
        if self._in_write:
            try:
                _ORIG_STDERR.write(text)
            except Exception:
                pass
            return len(text)
        self._in_write = True
        try:
            for line in text.rstrip("\n").splitlines():
                self._logger.log(self._level, line.rstrip())
        except Exception:
            pass
        finally:
            self._in_write = False
        return len(text)

    def flush(self) -> None:  # noqa: D102
        pass

    def isatty(self) -> bool:
        return False

    def fileno(self):
        raise OSError("_LoggerWriter has no fileno")


def _excepthook(exc_type, exc, tb) -> None:
    try:
        logging.getLogger("unhandled").error(
            "未捕获异常: %s: %s", exc_type.__name__ if exc_type else "?", exc,
            exc_info=(exc_type, exc, tb),
        )
    except Exception:
        pass
    try:
        _ORIG_STDERR.write("".join(traceback.format_exception(exc_type, exc, tb)))
    except Exception:
        pass


def _thread_excepthook(args) -> None:
    try:
        exc = getattr(args, "exc_value", None) or getattr(args, "exc_type", None)
        logging.getLogger("unhandled").error(
            "线程未捕获异常 (%s)", getattr(args, "thread", None) and args.thread.name or "?",
            exc_info=getattr(args, "exc_info", None) or exc,
        )
    except Exception:
        pass


def _asyncio_exception_handler(loop, context) -> None:
    try:
        exc = context.get("exception")
        msg = context.get("message") or "asyncio task error"
        logger = logging.getLogger("asyncio")
        if exc is not None:
            logger.error("Asyncio 异常: %s", msg, exc_info=exc)
        else:
            logger.error("Asyncio 异常: %s | context=%s", msg,
                         {k: str(v)[:200] for k, v in (context or {}).items() if k != "exception"})
    except Exception:
        pass


def attach_asyncio_exception_handler(loop=None) -> None:
    """把 asyncio 全局异常处理器绑到当前运行 loop（lifespan 里调用）。"""
    try:
        loop = loop or asyncio.get_running_loop()
        loop.set_exception_handler(_asyncio_exception_handler)
    except Exception:
        pass


def log_files() -> List[dict]:
    """日志文件清单（主文件 + 滚动备份），供 /system/logs/files。"""
    out: List[dict] = []
    directory = _LOG_DIR or _resolve_log_dir()
    try:
        for name in sorted(os.listdir(directory)):
            if not name.startswith("studio.log"):
                continue
            p = os.path.join(directory, name)
            try:
                st = os.stat(p)
                out.append({"name": name, "path": p, "size": st.st_size, "mtime": st.st_mtime})
            except Exception:
                continue
    except Exception:
        pass
    return out


def bootstrap_logging(log_directory: Optional[str] = None, level: Optional[str] = None,
                      capture_stdio: bool = True, force: bool = False) -> None:
    """初始化日志（默认幂等）：文件轮转 + stderr 镜像 + 异常钩子 + print 收编。

    force=True 允许重新配置（测试换临时目录用）：旧的自有 handler 会被摘除。
    """
    global _BOOTSTRAPPED, _LOG_DIR, _MAIN_LOG
    if _BOOTSTRAPPED and not force:
        return
    _BOOTSTRAPPED = True

    _LOG_DIR = _resolve_log_dir(log_directory)
    _MAIN_LOG = os.path.join(_LOG_DIR, "studio.log")
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
    except Exception:
        pass

    logging.raiseExceptions = False
    lvl = getattr(logging, (level or "").strip().upper(), None)
    if lvl is None:
        lvl = resolve_level(_LOG_DIR)

    root = logging.getLogger()
    root.setLevel(lvl)

    fmt = logging.Formatter(_FMT, datefmt=_DATEFMT)
    # force 重配时摘除旧自有 handler，避免文件句柄堆积
    for h in list(root.handlers):
        if getattr(h, "_studio_own", False):
            root.removeHandler(h)
            try:
                h.close()
            except Exception:
                pass
    try:
        fh = logging.handlers.RotatingFileHandler(
            _MAIN_LOG, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8", delay=True,
        )
        fh.setFormatter(fmt)
        fh.setLevel(lvl)
        fh._studio_own = True  # type: ignore[attr-defined]
        root.addHandler(fh)
    except Exception:
        pass
    sh = logging.StreamHandler(_ORIG_STDERR)
    sh.setFormatter(fmt)
    sh.setLevel(lvl)
    sh._studio_own = True  # type: ignore[attr-defined]
    root.addHandler(sh)

    try:
        logging.captureWarnings(True)
    except Exception:
        pass

    sys.excepthook = _excepthook
    try:
        threading.excepthook = _thread_excepthook
    except Exception:
        pass

    if capture_stdio and not isinstance(sys.stdout, _LoggerWriter):
        sys.stdout = _LoggerWriter(logging.getLogger("stdout"), logging.INFO)
        sys.stderr = _LoggerWriter(logging.getLogger("stderr"), logging.WARNING)

    logging.getLogger("logging").info(
        "日志已初始化 level=%s file=%s", logging.getLevelName(lvl), _MAIN_LOG,
    )
