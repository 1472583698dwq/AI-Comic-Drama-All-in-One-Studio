# -*- coding: utf-8 -*-
"""
OpenList (AList 系) 客户端 —— 只包住本项目要用的五个动作。

后端挂的是 HalalCloudOpen 驱动（底层 IPFS，内容寻址），实测有两条硬规矩，
整个同步层的设计都是被它们逼出来的：

  1. **PUT 到已存在的路径是静默 no-op**：返回 code 200 success，但文件内容原封不动。
     所以「改了再传一次」这种写法在这里永远不生效 —— 可变文件必须走 remove+put，
     或者干脆别覆盖，换个新文件名（本项目选后者，见 mirror.py 的版本化快照）。
  2. **直链 raw_url 带 Referer 或 Origin 一律 403**（ipfs-gateway.qzy.xyz 双防盗链），
     而且 auth_key 约 4 小时过期。所以直链只能由服务端当场取当场用，
     既不能落库，也不能丢给浏览器的 <img src>。

登录态：/api/auth/login 拿 token，缓存复用，遇 401 自动重登一次。
"""
from __future__ import annotations

import asyncio
import os
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx


class OpenListError(RuntimeError):
    pass


class OpenListClient:
    def __init__(self, base_url: str, username: str, password: str, timeout: float = 120.0):
        self.base = (base_url or "").strip().rstrip("/")
        self.username = (username or "").strip()
        self.password = password or ""
        self.timeout = timeout
        self._token: str = ""
        self._lock = asyncio.Lock()

    # ── 鉴权 ────────────────────────────────────────────────
    async def _login(self, c: httpx.AsyncClient) -> str:
        r = await c.post(f"{self.base}/api/auth/login",
                         json={"username": self.username, "password": self.password})
        r.raise_for_status()
        d = r.json()
        if d.get("code") != 200:
            raise OpenListError(f"OpenList 登录失败: {d.get('message')}")
        tok = ((d.get("data") or {}).get("token") or "").strip()
        if not tok:
            raise OpenListError("OpenList 登录没返回 token")
        self._token = tok
        return tok

    async def _token_for(self, c: httpx.AsyncClient) -> str:
        async with self._lock:
            if self._token:
                return self._token
            return await self._login(c)

    async def _call(self, method: str, path: str, *, retry_auth: bool = True, **kw) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            tok = await self._token_for(c)
            headers = dict(kw.pop("headers", {}) or {})
            headers["Authorization"] = tok
            r = await c.request(method, f"{self.base}{path}", headers=headers, **kw)
            if r.status_code in (401, 403) and retry_auth:
                async with self._lock:
                    self._token = ""
                tok = await self._token_for(c)
                headers["Authorization"] = tok
                r = await c.request(method, f"{self.base}{path}", headers=headers, **kw)
            r.raise_for_status()
            d = r.json()
            if d.get("code") != 200:
                raise OpenListError(f"{path} 返回 {d.get('code')}: {d.get('message')}")
            return d.get("data") or {}

    # ── 目录 ────────────────────────────────────────────────
    async def mkdirs(self, remote_dir: str) -> None:
        """建目录；多级一次到位，已存在也返回 200。"""
        await self._call("POST", "/api/fs/mkdir", json={"path": remote_dir})

    async def list_dir(self, remote_dir: str, refresh: bool = False) -> List[Dict[str, Any]]:
        try:
            d = await self._call("POST", "/api/fs/list",
                                 json={"path": remote_dir, "page": 1, "per_page": 1000, "refresh": refresh})
        except OpenListError:
            return []          # 目录不存在 → 当空目录处理
        return list(d.get("content") or [])

    async def stat(self, remote_path: str) -> Optional[Dict[str, Any]]:
        parent = os.path.dirname(remote_path) or "/"
        name = os.path.basename(remote_path)
        for it in await self.list_dir(parent):
            if it.get("name") == name:
                return it
        return None

    # ── 读写 ────────────────────────────────────────────────
    @staticmethod
    async def _aiter_file(path: str, chunk: int = 1024 * 1024):
        """异步分块读文件。httpx 的 AsyncClient 不收同步文件句柄（会直接抛
        "Attempted to send an sync request with an AsyncClient instance"），
        所以这里包一层异步生成器；大文件也不会整个读进内存。"""
        with open(path, "rb") as f:
            while True:
                b = f.read(chunk)
                if not b:
                    break
                yield b

    async def put(self, remote_path: str, local_path: str) -> None:
        """
        上传。注意：远端已存在同名文件时本调用是空操作（驱动特性），
        调用方要么保证路径唯一，要么先 remove。
        """
        await self.mkdirs(os.path.dirname(remote_path) or "/")
        size = os.path.getsize(local_path)
        await self._call(
            "PUT", "/api/fs/put",
            headers={
                "File-Path": urllib.parse.quote(remote_path),
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
                "As-Task": "false",
            },
            content=self._aiter_file(local_path),
        )

    async def remove(self, remote_path: str) -> None:
        await self._call("POST", "/api/fs/remove", json={
            "dir": os.path.dirname(remote_path) or "/",
            "names": [os.path.basename(remote_path)],
        })

    async def raw_url(self, remote_path: str) -> str:
        """现取现用，**绝不落库**：auth_key 约 4h 过期。"""
        d = await self._call("POST", "/api/fs/get", json={"path": remote_path})
        url = (d.get("raw_url") or "").strip()
        if not url:
            raise OpenListError(f"取直链失败: {remote_path}")
        return url

    async def download(self, remote_path: str, local_path: str) -> int:
        """
        下到本地。走服务端 httpx，**不带 Referer / Origin** —— 带了网关直接 403。
        先落 .part 再 rename，避免半截文件被 /storage 静态服务读到。
        """
        url = await self.raw_url(remote_path)
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        tmp = local_path + ".part"
        n = 0
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as c:
            async with c.stream("GET", url) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    async for chunk in r.aiter_bytes(256 * 1024):
                        f.write(chunk)
                        n += len(chunk)
        os.replace(tmp, local_path)
        return n

    async def ping(self) -> Dict[str, Any]:
        """连通性自检：登录 + 列根目录。"""
        async with httpx.AsyncClient(timeout=20.0) as c:
            async with self._lock:
                self._token = ""
            await self._login(c)
        return {"ok": True}
