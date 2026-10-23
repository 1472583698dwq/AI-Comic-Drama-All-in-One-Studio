# -*- coding: utf-8 -*-
"""按 storage 相对路径共享的进程内文件锁。

云端同步上传可变文件时，会先在同一把锁下复制一份本地快照再上传；
工程状态写入方也用这把锁包住“写临时文件 + 原子替换”。这样 Windows 上
上传线程/静态服务读取旧文件时，不会与 os.replace 抢占导致会话保存 500。
"""
import threading
from typing import Dict

_LOCKS: Dict[str, threading.RLock] = {}
_GUARD = threading.Lock()


def normalize(rel: str) -> str:
    return (rel or "").replace("\\", "/").lstrip("./")


def lock_for(rel: str) -> threading.RLock:
    key = normalize(rel)
    with _GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[key] = lock
        return lock
