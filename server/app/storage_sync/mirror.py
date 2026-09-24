# -*- coding: utf-8 -*-
"""
storage 镜像同步 —— 把本机 storage/ 里的素材与工程异步同步到 OpenList，
另一台机器打开时按需拉回，做到「谁的电脑上看到的都是同一套」。

设计被底层存储的两条特性钉死（详见 openlist.py 开头）：

  · **远端不能覆盖**：所以可变文件（工程 content/canvas、素材 meta、项目索引）
    不做原地覆盖，改成**版本化快照** —— 每次存一个新的 `<时间戳>.json`，
    最新版 = 时间戳最大的那个。顺带白捡一份版本历史。
  · **直链不能给浏览器**：所以前端一行都不用改，仍旧请求 `/storage/xxx`；
    本地缺文件时由后端去 OpenList 取回来落盘，再由原来的静态服务吐出去。

同步范围是**白名单**，`config_store.json`（里面是所有 API Key）永远不在其中。

一致性说明（不粉饰）：多机同时改同一个工程是**后写覆盖**语义。
本模块只保证「不丢数据」：检测到双方都改过时保留本机版本，
把远端那份存成 `xxx.remote-<时间戳>.json` 放在旁边，由人来看。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.storage_sync.openlist import OpenListClient, OpenListError

# ── 同步范围 ────────────────────────────────────────────────
# 只同步这几个顶层目录；其余（tasks/plugins/extensions/providers…）一律不碰
SYNC_DIRS = ("generated", "videos", "assets", "projects")
# storage 根下的散装产物（配音就直接写在根）按后缀收
ROOT_MEDIA_EXTS = (".mp3", ".wav", ".m4a", ".flac", ".mp4", ".mov", ".webm", ".png", ".jpg", ".jpeg", ".webp")
# 任何情况下都不上传的文件名
NEVER_SYNC = {"config_store.json", ".DS_Store", ".migrated"}
# 可变文件：走版本化快照，不走 media 直传
MUTABLE_BASENAMES = {"content.json", "canvas.json", "agent_sessions.json", "meta.json", "index.json"}

SYNC_META_DIR = os.path.join(settings.STORAGE_DIR, ".sync")
JOURNAL_PATH = os.path.join(SYNC_META_DIR, "journal.json")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _rel(local_path: str) -> str:
    return os.path.relpath(local_path, settings.STORAGE_DIR).replace("\\", "/")


def is_mutable(rel: str) -> bool:
    return os.path.basename(rel) in MUTABLE_BASENAMES


def in_scope(rel: str) -> bool:
    """这条相对路径要不要同步。"""
    if not rel or rel.startswith("."):
        return False
    base = os.path.basename(rel)
    if base in NEVER_SYNC:
        return False
    if base.startswith("."):                  # .gitkeep / .DS_Store 之类
        return False
    parts = rel.split("/")
    if len(parts) == 1:                       # storage 根下的散装文件
        return rel.lower().endswith(ROOT_MEDIA_EXTS)
    return parts[0] in SYNC_DIRS


class Journal:
    """记住每条文件上次同步时的 (size, mtime) 与远端版本号，避免重复上传。"""

    def __init__(self):
        self.data: Dict[str, Dict[str, Any]] = {}
        self._dirty = False
        self.load()

    def load(self) -> None:
        try:
            with open(JOURNAL_PATH, "r", encoding="utf-8") as f:
                self.data = json.load(f) or {}
        except Exception:
            self.data = {}

    def save(self) -> None:
        if not self._dirty:
            return
        os.makedirs(SYNC_META_DIR, exist_ok=True)
        tmp = JOURNAL_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        os.replace(tmp, JOURNAL_PATH)
        self._dirty = False

    def get(self, rel: str) -> Dict[str, Any]:
        return self.data.get(rel) or {}

    def mark(self, rel: str, **kw: Any) -> None:
        d = self.data.setdefault(rel, {})
        d.update(kw)
        self._dirty = True


class StorageMirror:
    def __init__(self):
        self.client: Optional[OpenListClient] = None
        self.root = ""
        self.journal = Journal()
        self.queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._workers: List[asyncio.Task] = []
        self._scanner: Optional[asyncio.Task] = None
        self._inflight: set = set()
        self.stats = {"uploaded": 0, "pulled": 0, "failed": 0, "skipped": 0,
                      "last_scan": 0.0, "last_error": ""}

    # ── 配置 ────────────────────────────────────────────────
    def configured(self) -> bool:
        return bool((getattr(settings, "OPENLIST_BASE_URL", "") or "").strip()
                    and (getattr(settings, "OPENLIST_USERNAME", "") or "").strip()
                    and (getattr(settings, "OPENLIST_PASSWORD", "") or "").strip())

    def enabled(self) -> bool:
        v = str(getattr(settings, "OPENLIST_SYNC_ENABLED", "") or "").strip().lower()
        return self.configured() and v in ("1", "true", "yes", "on")

    def _build(self) -> None:
        self.client = OpenListClient(
            settings.OPENLIST_BASE_URL, settings.OPENLIST_USERNAME, settings.OPENLIST_PASSWORD,
            timeout=float(getattr(settings, "OPENLIST_TIMEOUT", 300) or 300),
        )
        self.root = (getattr(settings, "OPENLIST_ROOT", "") or "/autoword/comic-studio").rstrip("/")

    # ── 远端路径 ────────────────────────────────────────────
    def media_path(self, rel: str) -> str:
        return f"{self.root}/media/{rel}"

    def state_dir(self, rel: str) -> str:
        stem = rel[:-5] if rel.endswith(".json") else rel
        return f"{self.root}/state/{stem}"

    # ── 上传 ────────────────────────────────────────────────
    async def _upload_one(self, rel: str) -> None:
        local = os.path.join(settings.STORAGE_DIR, rel)
        if not os.path.isfile(local):
            return
        st = os.stat(local)
        assert self.client
        if is_mutable(rel):
            # 版本化快照：文件名就是版本号，天然避开「远端不能覆盖」
            state_dir = self.state_dir(rel)
            remote = f"{state_dir}/{_now_ms()}.json"
            await self.client.put(remote, local)
            self.journal.mark(rel, size=st.st_size, mtime=st.st_mtime,
                              pushed_at=_now_ms(), remote=remote)
            try:
                await self._prune_snapshots(state_dir)
            except Exception:
                pass
        else:
            remote = self.media_path(rel)
            # 素材是一次写定的：远端已有同名就认为已同步（该驱动也覆盖不了）
            if not self.journal.get(rel).get("pushed_at"):
                if await self.client.stat(remote):
                    self.journal.mark(rel, size=st.st_size, mtime=st.st_mtime,
                                      pushed_at=_now_ms(), remote=remote, note="远端已存在")
                    self.stats["skipped"] += 1
                    return
            await self.client.put(remote, local)
            self.journal.mark(rel, size=st.st_size, mtime=st.st_mtime,
                              pushed_at=_now_ms(), remote=remote)
        self.stats["uploaded"] += 1

    async def _worker(self) -> None:
        while True:
            rel = await self.queue.get()
            try:
                for attempt in range(3):
                    try:
                        await self._upload_one(rel)
                        break
                    except Exception as e:
                        if attempt == 2:
                            self.stats["failed"] += 1
                            self.stats["last_error"] = f"{rel}: {e}"
                            self.journal.mark(rel, error=str(e)[:300], failed_at=_now_ms())
                        else:
                            await asyncio.sleep(2 ** attempt)
            finally:
                self._inflight.discard(rel)
                self.queue.task_done()

    def enqueue(self, rel: str) -> None:
        """立刻排队上传一条（生成产物落盘后可直接调，不阻塞调用方）。"""
        if not self.enabled() or not in_scope(rel) or rel in self._inflight:
            return
        self._inflight.add(rel)
        self.queue.put_nowait(rel)

    # ── 扫描 ────────────────────────────────────────────────
    def _walk(self) -> List[str]:
        out: List[str] = []
        root = settings.STORAGE_DIR
        try:
            for name in os.listdir(root):
                p = os.path.join(root, name)
                if os.path.isfile(p) and in_scope(name):
                    out.append(name)
        except Exception:
            pass
        for d in SYNC_DIRS:
            base = os.path.join(root, d)
            if not os.path.isdir(base):
                continue
            for cur, dirs, files in os.walk(base):
                dirs[:] = [x for x in dirs if not x.startswith(".")]
                for f in files:
                    rel = _rel(os.path.join(cur, f))
                    if in_scope(rel):
                        out.append(rel)
        return out

    def scan_once(self) -> int:
        """把「和上次记录不一样」的文件排进上传队列，返回排了几条。"""
        n = 0
        for rel in self._walk():
            local = os.path.join(settings.STORAGE_DIR, rel)
            try:
                st = os.stat(local)
            except OSError:
                continue
            j = self.journal.get(rel)
            if j.get("size") == st.st_size and abs(float(j.get("mtime") or 0) - st.st_mtime) < 1e-6:
                continue
            self.enqueue(rel)
            n += 1
        self.stats["last_scan"] = time.time()
        self.journal.save()
        return n

    async def _scan_loop(self) -> None:
        interval = float(getattr(settings, "OPENLIST_SCAN_INTERVAL", 20) or 20)
        while True:
            try:
                if self.enabled():
                    self.scan_once()
            except Exception as e:
                self.stats["last_error"] = f"scan: {e}"
            await asyncio.sleep(max(5.0, interval))

    # ── 按需回拉 ────────────────────────────────────────────
    async def ensure_local(self, rel: str) -> bool:
        """本地缺这个素材时去 OpenList 取回来。命中返回 True。"""
        if not self.enabled() or not in_scope(rel) or is_mutable(rel):
            return False
        local = os.path.join(settings.STORAGE_DIR, rel)
        if os.path.isfile(local):
            return True
        assert self.client
        try:
            await self.client.download(self.media_path(rel), local)
        except Exception as e:
            self.stats["last_error"] = f"pull {rel}: {e}"
            return False
        st = os.stat(local)
        self.journal.mark(rel, size=st.st_size, mtime=st.st_mtime, pulled_at=_now_ms())
        self.journal.save()
        self.stats["pulled"] += 1
        return True

    # ── 工程状态回拉（启动时跑一次） ──────────────────────────
    async def _snapshots(self, remote_dir: str) -> List[Tuple[int, str]]:
        """列出某个可变文件的全部快照，按版本号升序。

        **必须 refresh=True**：OpenList 的目录列表带缓存，实测刚传上去的快照
        在非 refresh 的列表里看不到（甚至出现过空名条目），
        那会让另一台机器一直以为自己已经是最新。
        """
        assert self.client
        out: List[Tuple[int, str]] = []
        for it in await self.client.list_dir(remote_dir, refresh=True):
            if it.get("is_dir"):
                continue
            name = str(it.get("name") or "")
            if not name.endswith(".json"):
                continue
            try:
                ts = int(name[:-5])
            except ValueError:
                continue
            out.append((ts, f"{remote_dir}/{name}"))
        return sorted(out)

    async def _prune_snapshots(self, remote_dir: str) -> None:
        """只留最近 N 个版本，老的删掉 —— 否则每存一次工程就多一份，无上限。"""
        try:
            keep = int(getattr(settings, "OPENLIST_KEEP_VERSIONS", 20) or 20)
        except Exception:
            keep = 20
        if keep <= 0:
            return
        snaps = await self._snapshots(remote_dir)
        assert self.client
        for _ts, path in snaps[:-keep]:
            try:
                await self.client.remove(path)
            except Exception:
                break

    async def _newest_snapshot(self, remote_dir: str) -> Optional[Tuple[int, str]]:
        snaps = await self._snapshots(remote_dir)
        return snaps[-1] if snaps else None

    async def _pull_state_file(self, rel: str) -> str:
        """拉一个可变文件的最新快照，按「谁都改过就不覆盖」处理冲突。"""
        assert self.client
        snap = await self._newest_snapshot(self.state_dir(rel))
        if not snap:
            return "远端无快照"
        ts, remote = snap
        local = os.path.join(settings.STORAGE_DIR, rel)
        j = self.journal.get(rel)
        if int(j.get("pulled_ts") or 0) >= ts and os.path.isfile(local):
            return "已是最新"

        local_changed = False
        if os.path.isfile(local):
            st = os.stat(local)
            local_changed = not (j.get("size") == st.st_size
                                 and abs(float(j.get("mtime") or 0) - st.st_mtime) < 1e-6)

        if os.path.isfile(local) and local_changed and j.get("pushed_at"):
            # 两边都改过：本机的留着，远端那份放旁边，交给人判断
            side = f"{local}.remote-{ts}.json"
            await self.client.download(remote, side)
            self.journal.mark(rel, conflict_at=_now_ms(), conflict_copy=side)
            self.journal.save()
            return f"冲突，远端版本另存为 {os.path.basename(side)}"

        if rel == "projects/index.json" and os.path.isfile(local):
            tmp = local + f".remote-{ts}"
            await self.client.download(remote, tmp)
            merged = _merge_index(local, tmp)
            os.remove(tmp)
            if not merged:
                return "索引合并失败"
        else:
            await self.client.download(remote, local)

        st = os.stat(local)
        self.journal.mark(rel, size=st.st_size, mtime=st.st_mtime, pulled_ts=ts, pulled_at=_now_ms())
        self.journal.save()
        self.stats["pulled"] += 1
        return f"已更新到 {ts}"

    async def pull_all_state(self) -> Dict[str, str]:
        """把远端的工程与素材元数据拉齐 —— 新机器靠这一步才「看得到项目」。"""
        if not self.enabled():
            return {}
        assert self.client
        out: Dict[str, str] = {}
        try:
            out["projects/index.json"] = await self._pull_state_file("projects/index.json")
        except Exception as e:
            out["projects/index.json"] = f"失败: {e}"

        rels: List[str] = []
        for kind, sub in (("projects", ("content", "canvas", "agent_sessions")), ("assets", ("meta",))):
            for it in await self.client.list_dir(f"{self.root}/state/{kind}", refresh=True):
                if it.get("is_dir"):
                    rels.extend(f"{kind}/{it['name']}/{leaf}.json" for leaf in sub)

        # 每条都要单独列一次远端目录，串行跑几十个项目会等很久（公网尤其明显），
        # 所以开一把小信号量并发拉，但别把对面打爆。
        sem = asyncio.Semaphore(6)

        async def one(rel: str) -> None:
            async with sem:
                try:
                    r = await self._pull_state_file(rel)
                    if r not in ("远端无快照", "已是最新"):
                        out[rel] = r
                except Exception as e:
                    out[rel] = f"失败: {e}"

        await asyncio.gather(*(one(r) for r in rels))
        return out

    # ── 生命周期 ────────────────────────────────────────────
    async def start(self) -> None:
        if not self.configured():
            return
        self._build()
        if not self.enabled():
            return
        workers = int(getattr(settings, "OPENLIST_WORKERS", 2) or 2)
        self._workers = [asyncio.create_task(self._worker()) for _ in range(max(1, workers))]
        self._scanner = asyncio.create_task(self._scan_loop())
        asyncio.create_task(self._bootstrap())

    async def _bootstrap(self) -> None:
        try:
            await self.pull_all_state()
        except Exception as e:
            self.stats["last_error"] = f"bootstrap: {e}"

    async def stop(self) -> None:
        for t in self._workers + ([self._scanner] if self._scanner else []):
            t.cancel()
        self._workers = []
        self._scanner = None
        self.journal.save()

    def status(self) -> Dict[str, Any]:
        return {
            "configured": self.configured(),
            "enabled": self.enabled(),
            "root": self.root,
            "base_url": getattr(settings, "OPENLIST_BASE_URL", ""),
            "queue": self.queue.qsize(),
            "tracked": len(self.journal.data),
            **self.stats,
        }


def _merge_index(local_path: str, remote_path: str) -> bool:
    """项目索引按 id 合并、updated_at 新的赢 —— 免得另一台机器的项目被抹掉。"""
    try:
        with open(local_path, "r", encoding="utf-8") as f:
            loc = json.load(f) or []
        with open(remote_path, "r", encoding="utf-8") as f:
            rem = json.load(f) or []
        by_id: Dict[str, Dict[str, Any]] = {}
        for item in list(loc) + list(rem):
            pid = item.get("id")
            if not pid:
                continue
            cur = by_id.get(pid)
            if not cur or str(item.get("updated_at") or "") > str(cur.get("updated_at") or ""):
                by_id[pid] = item
        merged = sorted(by_id.values(), key=lambda x: str(x.get("updated_at") or ""), reverse=True)
        tmp = local_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        os.replace(tmp, local_path)
        return True
    except Exception:
        return False


mirror = StorageMirror()
