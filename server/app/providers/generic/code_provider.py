
"""
Code Provider - Python / JavaScript coroutine as single execution mode
Replaces JSON template completely.
"""
import os
import re
import json
import time
import uuid as uuidlib
import asyncio
import tempfile
import subprocess
import ast
from typing import Dict, Any, Optional

import httpx

from app.models.provider_definition import ProviderDefinition
from app.providers.image.base import ImageProvider, ImageGenerateRequest, ImageGenerateResult
from app.providers.audio.base import AudioProvider, AudioGenerateRequest, AudioGenerateResult
from app.providers.video.base import VideoProvider, VideoGenerateRequest, VideoGenerateResult


def _get_api_key_for_provider(provider_id: str, definition: ProviderDefinition) -> str:
    if definition.auth.key_env:
        val = os.getenv(definition.auth.key_env, "")
        if val:
            return val
    try:
        from app.core.config import settings
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                for k in [f"CUSTOM_PROVIDER_{provider_id}", provider_id, definition.auth.key_env or ""]:
                    if k and data.get(k):
                        return str(data[k])
                cp = data.get("custom_providers", {})
                if isinstance(cp, dict) and provider_id in cp:
                    entry = cp[provider_id]
                    if isinstance(entry, dict) and entry.get("api_key"):
                        return str(entry["api_key"])
                    if isinstance(entry, str):
                        return entry
    except Exception:
        pass
    return ""


def _get_generated_dir():
    from app.core.config import settings
    gen_dir = os.path.join(settings.STORAGE_DIR, "generated")
    os.makedirs(gen_dir, exist_ok=True)
    return gen_dir


async def _download_to_storage(url: str, prefix: str = "gen") -> tuple[str, str]:
    from app.core.config import settings
    gen_dir = _get_generated_dir()
    async with httpx.AsyncClient(timeout=40.0) as client:
        resp = await client.get(url, timeout=40.0)
        resp.raise_for_status()
        content = resp.content
        ct = resp.headers.get("content-type", "")
        ext = ".png"
        if "jpeg" in ct or "jpg" in ct:
            ext = ".jpg"
        elif "webp" in ct:
            ext = ".webp"
        elif "mp3" in ct or "mpeg" in ct:
            ext = ".mp3"
        elif "mp4" in ct:
            ext = ".mp4"
        elif "wav" in ct:
            ext = ".wav"
        elif url.endswith(".mp3"):
            ext = ".mp3"
        elif url.endswith(".mp4"):
            ext = ".mp4"
        filename = f"{prefix}_{int(time.time())}_{uuidlib.uuid4().hex[:8]}{ext}"
        if ext in (".mp4", ".mov", ".webm"):
            videos_dir = os.path.join(settings.STORAGE_DIR, "videos")
            os.makedirs(videos_dir, exist_ok=True)
            local_path = os.path.join(videos_dir, filename)
            storage_url = f"/storage/videos/{filename}"
        else:
            local_path = os.path.join(gen_dir if ext in (".png",".jpg",".webp") else settings.STORAGE_DIR, filename)
            storage_url = f"/storage/generated/{filename}" if ext in (".png",".jpg",".webp") else f"/storage/{filename}"
            if ext in (".mp3",".wav"):
                storage_url = f"/storage/{filename}"
        with open(local_path, "wb") as f:
            f.write(content)
        return storage_url, local_path


def _is_trusted_provider(definition=None, trusted_override=None) -> bool:
    """可信判定（A档）：逐源 trusted=True 且全局 STUDIO_TRUSTED_MODE=1 同时满足才放行。"""
    try:
        want = bool(trusted_override) if trusted_override is not None else bool(getattr(definition, "trusted", False)) if definition is not None else False
        if not want:
            return False
        from app.core.config import is_trusted_mode_enabled as _gate
        return bool(_gate())
    except Exception:
        return False


def _validate_python_code(code: str, trusted: bool = False):
    if not trusted:
        for pat in [r"os\.system", r"subprocess\.", r"shutil\."]:
            if re.search(pat, code):
                raise ValueError(f"forbidden pattern: {pat}（如需执行任意命令，请将该源设为可信 trusted=True 并开启 STUDIO_TRUSTED_MODE=1）")
        # 进程级杀伤原语：命中即拒收，防止导演改码后服务崩溃重启
        # （os._exit 直接杀进程无异常可捕；sys.exit/exit/quit 抛 SystemExit 会穿透 except Exception 杀死 worker）
        for pat in [r"os\._exit", r"sys\.exit", r"os\.kill", r"os\.abort",
                    r"(?<![\w.])exit\s*\(", r"(?<![\w.])quit\s*\(",
                    r"ctypes", r"multiprocessing"]:
            if re.search(pat, code):
                raise ValueError(f"forbidden pattern: {pat}（该调用可杀死后端进程，已拦截；请去掉后重试）")
    try:
        ast.parse(code)
    except SyntaxError as e:
        raise ValueError(f"Python syntax error: {e}") from e


def _python_trusted_env(ctx: Dict[str, Any]):
    """可信执行环境（跳出沙箱）：完整 builtins + 真实 import + os/sys/subprocess 全量开放。仅本地可信模式可用。"""
    import builtins as _builtins
    import sys as _sys
    async def api_download(url: str, prefix: str = "gen"):
        return await _download_to_storage(url, prefix=prefix)
    api: Dict[str, Any] = {
        "httpx": httpx,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "time": time,
        "uuid": uuidlib,
        "download": api_download,
        "get_api_key": lambda: ctx.get("api_key", ""),
        "storage_dir": _get_generated_dir(),
        "trusted": True,
    }
    g: Dict[str, Any] = {
        "__builtins__": _builtins,
        "httpx": httpx,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "time": time,
        "uuid": uuidlib,
        "ctx": ctx,
        "api": api,
    }
    # 预置常用系统库，省一次 import（仍可用真实 __import__ 引任意库）
    try:
        import os as _os
        import subprocess as _sp
        import pathlib as _pl
        import shutil as _sh
        import socket as _sock
        g.update({"os": _os, "sys": _sys, "subprocess": _sp, "pathlib": _pl, "shutil": _sh, "socket": _sock})
        api.update({"os": _os, "sys": _sys, "subprocess": _sp, "pathlib": _pl})
    except Exception:
        pass
    try:
        import aiohttp as _aiohttp
        g["aiohttp"] = _aiohttp
        api["aiohttp"] = _aiohttp
    except Exception:
        pass
    try:
        import requests as _requests
        g["requests"] = _requests
        api["requests"] = _requests
    except Exception:
        pass
    return g, {}, api


def _python_sandbox(ctx: Dict[str, Any], trusted: bool = False):
    """
    构造执行环境，返回 (globals, locals_dict, api)。
    _execute_python_code（真实执行）与 compile_check_code（创建体检）共用，保证体检环境=运行环境。
    trusted=True 且全局开关放行时走 _python_trusted_env（任意代码），否则走受限沙箱。
    """
    if trusted:
        try:
            from app.core.config import is_trusted_mode_enabled as _gate2
            if _gate2():
                return _python_trusted_env(ctx)
        except Exception:
            pass
    async def api_download(url: str, prefix: str = "gen"):
        return await _download_to_storage(url, prefix=prefix)
    api: Dict[str, Any] = {
        "httpx": httpx,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "time": time,
        "uuid": uuidlib,
        "download": api_download,
        "get_api_key": lambda: ctx.get("api_key", ""),
        "storage_dir": _get_generated_dir(),
    }
    # 受控 import：允许第三方库（aiohttp/requests 等），黑名单拦截危险模块。
    # 此前 builtins 不含 __import__，用户代码里的 `import xxx` 语句直接抛 "__import__ not found"
    import importlib as _importlib
    _BLOCKED_IMPORT_ROOTS = {
        "os", "subprocess", "shutil", "sys", "socket", "ctypes",
        "signal", "importlib", "builtins", "pickle", "pathlib",
    }

    def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = str(name).split(".")[0]
        if root in _BLOCKED_IMPORT_ROOTS:
            raise ImportError(f"代码源沙箱禁止导入模块: {name}（网络请求请使用 api.httpx / httpx）")
        mod = _importlib.import_module(name)
        # 对齐 __import__ 语义：`import a.b.c` 需绑定顶层包名 a
        if not fromlist and "." in str(name):
            mod = _importlib.import_module(str(name).split(".")[0])
        return mod

    g: Dict[str, Any] = {
        "__builtins__": {
            "__import__": _guarded_import,
            "len": len, "str": str, "int": int, "float": float, "bool": bool,
            "dict": dict, "list": list, "set": set, "tuple": tuple, "frozenset": frozenset,
            "range": range, "enumerate": enumerate, "zip": zip,
            "print": print, "isinstance": isinstance, "issubclass": issubclass,
            "hasattr": hasattr, "getattr": getattr, "setattr": setattr,
            "min": min, "max": max, "sum": sum, "sorted": sorted,
            "any": any, "all": all, "abs": abs, "round": round,
            "repr": repr, "format": format, "hash": hash, "callable": callable,
            "bytes": bytes, "bytearray": bytearray, "divmod": divmod, "pow": pow,
            "iter": iter, "next": next, "reversed": reversed, "slice": slice,
            # 异常类：用户代码常需 raise RuntimeError/ValueError 等
            "Exception": Exception, "RuntimeError": RuntimeError, "ValueError": ValueError,
            "TypeError": TypeError, "KeyError": KeyError, "IndexError": IndexError,
            "TimeoutError": TimeoutError, "StopIteration": StopIteration,
            "ArithmeticError": ArithmeticError, "AttributeError": AttributeError,
            "ZeroDivisionError": ZeroDivisionError, "NotImplementedError": NotImplementedError,
            "json": json, "re": re, "time": time, "uuid": uuidlib,
            "httpx": httpx, "asyncio": asyncio,
        },
        "httpx": httpx,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "time": time,
        "uuid": uuidlib,
    }
    l: Dict[str, Any] = {}
    import base64, hashlib, hmac, urllib.parse
    g["base64"] = base64
    g["hashlib"] = hashlib
    g["hmac"] = hmac
    g["urllib"] = urllib.parse
    # 常见第三方 HTTP 库直 exposure（用户代码可直接 import 或用 api.xxx）
    try:
        import aiohttp as _aiohttp
        g["aiohttp"] = _aiohttp
        api["aiohttp"] = _aiohttp
    except Exception:
        pass
    try:
        import requests as _requests
        g["requests"] = _requests
        api["requests"] = _requests
    except Exception:
        pass
    return g, l, api


def _run_guarded_sync(fn, timeout: int, timeout_msg: str):
    """同步函数隔离执行（daemon 线程 + 超时）：顶层死循环/sleep 不再卡死调用线程；
    超时后残留线程为 daemon，不阻塞进程退出（Python 无法杀线程，残留空转由改码前置体检拦截源头）。"""
    import threading as _th
    import queue as _q
    box: _q.Queue = _q.Queue(maxsize=1)

    def _target():
        try:
            box.put((True, fn()))
        except BaseException as e:
            box.put((False, e))

    t = _th.Thread(target=_target, daemon=True)
    t.start()
    try:
        ok, payload = box.get(timeout=timeout)
    except _q.Empty:
        raise RuntimeError(timeout_msg)
    if ok:
        return payload
    raise payload


async def _exec_module_guarded(code: str, g: Dict[str, Any], l: Dict[str, Any], timeout: int = 20) -> None:
    """模块级 exec 隔离执行：顶层死循环/sleep 不再卡死事件循环致服务假死重启。"""
    try:
        await asyncio.to_thread(
            _run_guarded_sync,
            lambda: exec(code, g, l),
            timeout,
            f"code module-level timeout ({timeout}s)：顶层代码疑似死循环/阻塞，已中断",
        )
    except asyncio.CancelledError:
        raise
    except BaseException as e:
        raise RuntimeError(f"code compile failed: {e}") from e


async def _execute_python_code(code: str, entry: str, ctx: Dict[str, Any], timeout: int = 1200, trusted: bool = False) -> Dict[str, Any]:
    _validate_python_code(code, trusted=trusted)
    g, l, api = _python_sandbox(ctx, trusted=trusted)
    await _exec_module_guarded(code, g, l, timeout=int(timeout or 1200))
    fn = l.get(entry) or g.get(entry)
    if not fn:
        candidates = [v for v in l.values() if callable(v)]
        if len(candidates) == 1:
            fn = candidates[0]
        else:
            raise RuntimeError(f"entry '{entry}' not found")
    if not callable(fn):
        raise RuntimeError(f"entry '{entry}' not callable")
    try:
        coro = fn(ctx, api)
        if asyncio.iscoroutine(coro):
            result = await asyncio.wait_for(coro, timeout=timeout)
        else:
            result = coro
        if not isinstance(result, dict):
            raise RuntimeError(f"entry must return dict, got {type(result)}")
        return result
    except asyncio.TimeoutError:
        raise RuntimeError(f"code timeout ({timeout}s)")
    except asyncio.CancelledError:
        raise
    except BaseException as e:
        # SystemExit/KeyboardInterrupt 等必须就地转为普通错误，否则穿透 FastAPI 杀死 worker 致服务崩溃重启
        raise RuntimeError(f"code execution failed: {e}") from e


def compile_check_code(language: str, code: str, entry: str = "generate", trusted: bool = False) -> Dict[str, Any]:
    """
    创建即体检（零网络/零配额）：在真实沙箱中编译用户代码并定位入口函数。
    可捕获：语法错误、模块级 import 违禁/缺失、入口缺失、模块级运行时错误。
    返回 {ok, error?}；js 语言做 node --check 语法校验（node 不可用时跳过）。
    trusted=True（且全局开关放行）时按可信环境体检，允许 os/subprocess 等。
    """
    lang = (language or "python").lower()
    if not code or not code.strip():
        return {"ok": False, "error": "代码为空"}
    if lang in ("javascript", "js", "node"):
        try:
            import subprocess as _sp
            import tempfile as _tempfile
            with _tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
                f.write(code)
                tmp = f.name
            try:
                r = _sp.run(["node", "--check", tmp], capture_output=True, text=True, timeout=15)
                if r.returncode != 0:
                    return {"ok": False, "error": f"JS 语法错误: {(r.stderr or r.stdout or '')[:400]}"}
            except FileNotFoundError:
                pass  # node 不可用，跳过静态检查
            finally:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
        except Exception as e:
            return {"ok": False, "error": f"JS 体检异常: {e}"}
        return {"ok": True}
    # python：真实沙箱编译 + 入口定位
    try:
        _validate_python_code(code, trusted=trusted)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    g, l, _api = _python_sandbox({}, trusted=trusted)
    try:
        _run_guarded_sync(lambda: exec(code, g, l), 20,
                          "沙箱编译超时(20s)：顶层代码疑似死循环/阻塞")
    except BaseException as e:
        return {"ok": False, "error": f"沙箱编译失败: {e}"}
    fn = l.get(entry) or g.get(entry)
    if not fn:
        candidates = [v for v in l.values() if callable(v)]
        if len(candidates) == 1:
            fn = candidates[0]
    if not fn or not callable(fn):
        return {"ok": False, "error": f"未找到入口函数 '{entry}'（需定义 async def {entry}(ctx, api)）"}
    return {"ok": True}


# ==================== 统一参数/结果协议（三个包装类共用） ====================
# 重构要点：用户显式选择(dynamic_inputs>extra)、用户代码返回值解析、媒体落盘、超时策略
# 各只有一个实现，杜绝"每个 kind 一套写法"导致的行为漂移（图像 dyn 不生效/视频默认值压选择等历史 bug）

_STD_PARAM_KEYS = ("fps", "steps", "cfg", "width", "height", "resolution",
                   "aspect_ratio", "duration", "speed", "pitch", "volume",
                   "voice_id", "emotion", "workflow_id", "model", "style_preset",
                   "seed", "negative_prompt", "text", "prompt", "task_id")


def merge_user_params(req, keys: tuple = _STD_PARAM_KEYS) -> Dict[str, Any]:
    """
    提取"用户显式选择"：dynamic_inputs（独立控件通道，最优先）> extra（API 直传通道）。
    只含用户真实提供的键——出网前护栏只校验这一层，框架兜底默认值不参与校验（避免误报）。
    """
    user: Dict[str, Any] = {}
    extra = getattr(req, "extra", None) or {}
    dyn = getattr(req, "dynamic_inputs", None) or {}
    for k in keys:
        if k in extra and extra[k] not in (None, ""):
            user[k] = extra[k]
    for k, v in dyn.items():
        if v not in (None, ""):
            user[k] = v
    return user


def validate_user_params(definition, user_params: Dict[str, Any]) -> None:
    """
    出网前枚举护栏（与 ComfyUI 注入的 _set_input_guarded 对应）：
    用户显式参数必须落在该源 params_schema 声明的枚举内，非法直接报错并给出合法值，
    杜绝无效参数打到外部 API 后在用户代码深处炸出晦涩错误。
    """
    props = ((getattr(definition, "params_schema", None) or {}).get("properties")) or {}
    problems = []
    for key, spec in props.items():
        if not isinstance(spec, dict):
            continue
        enum = spec.get("enum")
        if not enum:
            continue
        val = user_params.get(key)
        if val is None or val == "":
            continue
        allowed = [str(x) for x in enum]
        if str(val) not in allowed:
            problems.append(
                f"参数「{spec.get('title') or key}」的值 {val!r} 不在该源声明的枚举内（合法值: {' / '.join(allowed)}）——请重新选择"
            )
    if problems:
        raise RuntimeError("参数校验失败（未发送请求）: " + "；".join(problems))


def extract_result_media(kind: str, result: Dict[str, Any]) -> tuple:
    """
    统一解析用户代码返回值，返回 (media_url, task_id)。
    兼容：主键(image_url/video_url/audio_url)/url/output、复数列表(image_urls/...)、
    b64/b64_json、results 对象数组([{url:...}] 或 ["..."])、task_id 接管流。
    """
    if not isinstance(result, dict):
        return None, None
    primary = {"image": "image_url", "video": "video_url", "audio": "audio_url"}[kind]
    url: Any = None
    for k in (primary, "url", "output"):
        v = result.get(k)
        if isinstance(v, str) and v:
            url = v
            break
    if not url:
        for k in (f"{kind}_urls", "urls"):
            lst = result.get(k)
            if isinstance(lst, list) and lst:
                first = lst[0]
                url = first.get("url") if isinstance(first, dict) else first
                if isinstance(url, str) and url:
                    break
                url = None
    if not url:
        results = result.get("results")
        if isinstance(results, list) and results:
            first = results[0]
            url = first.get("url") if isinstance(first, dict) else (first if isinstance(first, str) else None)
    if not url and kind == "image":
        for k in ("b64_json", "b64", "image_b64"):
            v = result.get(k)
            if isinstance(v, str) and v:
                url = "data:image/png;base64," + v.split(",")[-1]
                break
    if not url and kind == "audio":
        v = result.get("b64")
        if isinstance(v, str) and v:
            url = "data:audio/mp3;base64," + v.split(",")[-1]
    task_id = result.get("task_id") or result.get("id")
    return (url if isinstance(url, str) and url else None), task_id


async def persist_media(url: str, kind: str, prefix: str) -> tuple:
    """统一媒体落盘：http(s) 下载；data:/base64 解码；本地 /storage 路径原样。返回 (storage_url, local_path)。"""
    from app.core.config import settings
    if not url.startswith(("http://", "https://", "data:")):
        return url, None
    if url.startswith("data:"):
        import base64
        _header, _, b64 = url.partition(",")
        data = base64.b64decode(b64)
        ext = ".png" if kind == "image" else ".mp4" if kind == "video" else ".mp3"
        filename = f"{prefix}_{int(time.time())}_{uuidlib.uuid4().hex[:8]}{ext}"
        if kind == "video":
            target_dir = os.path.join(settings.STORAGE_DIR, "videos")
            os.makedirs(target_dir, exist_ok=True)
            storage_url = f"/storage/videos/{filename}"
        elif kind == "audio":
            target_dir = settings.STORAGE_DIR
            storage_url = f"/storage/{filename}"
        else:
            target_dir = _get_generated_dir()
            storage_url = f"/storage/generated/{filename}"
        local_path = os.path.join(target_dir, filename)
        with open(local_path, "wb") as f:
            f.write(data)
        return storage_url, local_path
    return await _download_to_storage(url, prefix=prefix)


def resolve_code_timeout(definition) -> int:
    """超时策略单点：显式 code_timeout > legacy transport.timeout > kind 默认；
    下限 20 分钟（1200s），存量较短配置自动抬升，保证长任务不被提前掐断。"""
    explicit = getattr(definition, "code_timeout", None)
    base = None
    if explicit:
        base = int(explicit)
    else:
        transport = getattr(definition, "transport", None)
        if transport is not None:
            transport_timeout = transport.get("timeout") if isinstance(transport, dict) else getattr(transport, "timeout", None)
            if transport_timeout:
                base = int(transport_timeout)
    if base is None:
        base = 600 if getattr(definition, "kind", "") == "video" else 120
    return max(1200, base)


# ==================== 代码视频源异步任务表（H3 等提交即返 task_id 型） ====================
# 背景：code 源返回 {"task_id"} 后，任务表由此模块统一维护（非代码模式已删除）；
# 导致 task_id 永远查不到。本表由 GenericCodeVideoProvider 提交时注册，后台协程复用源自身代码的
# 查询模式（task_id + 空 prompt，单次秒回）推进，前端 /videos/status 经 get_custom_video_task 穿透可见。
_CODE_VIDEO_TASKS: Dict[str, Dict[str, Any]] = {}
_CODE_VIDEO_POLLING: set = set()  # 已在后台轮询中的 task_id（去重：查询复用不重复起协程）
_CODE_VIDEO_POLL_INTERVAL = 5.0
_CODE_VIDEO_MAX_ATTEMPTS = 300  # ~25 分钟，覆盖排队+生成
_CODE_VIDEO_TERMINAL_FAIL = ("FAILED", "FAIL", "ERROR", "CANCELLED")


def _spawn_code_video_poll(task_id: str, provider_id: str) -> None:
    """起后台轮询（去重：同一 task 只有一个协程在跑）。"""
    tid = str(task_id)
    if tid in _CODE_VIDEO_POLLING:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # 无运行中 loop（如单测直调）：仅注册不轮询，由外部查询推进
    _CODE_VIDEO_POLLING.add(tid)

    async def _runner():
        try:
            await _poll_code_video_task(tid, provider_id)
        finally:
            _CODE_VIDEO_POLLING.discard(tid)
    loop.create_task(_runner())


def get_code_video_task(task_id: str) -> Optional[Dict[str, Any]]:
    """查询代码视频源异步任务（/videos/status 与 TaskCenter 共用口径）。"""
    if not task_id:
        return None
    return _CODE_VIDEO_TASKS.get(str(task_id))


def register_code_video_task(task_id: str, provider_id: str) -> Dict[str, Any]:
    """注册提交即返的任务为 SUBMITTED（幂等：已存在则保留原记录）。"""
    tid = str(task_id)
    entry = _CODE_VIDEO_TASKS.get(tid)
    if entry is None:
        entry = {"status": "SUBMITTED", "task_id": tid, "provider": provider_id,
                 "video_url": None, "created_at": time.time(), "last_poll": time.time()}
        _CODE_VIDEO_TASKS[tid] = entry
    return entry


async def query_code_task_once(provider_id: str, task_id: str) -> Dict[str, Any]:
    """单次查询代码源任务（task_id + 空 prompt 的查询模式）；成功即落盘。

    TaskCenter 的 code_query 适配器与旧后台轮询共用此实现。
    返回 {status, video_url?, local_path?, error?, transient?}。
    """
    tid = str(task_id)
    try:
        from app.providers.custom.manager import custom_provider_manager as _mgr
        definition = _mgr.get_definition(provider_id)
    except Exception:
        definition = None
    if definition is None or not getattr(definition, "code", None):
        snap = {"status": "FAILED", "task_id": tid, "provider": provider_id,
                "error": f"Provider 定义缺失，无法轮询: {provider_id}"}
        _CODE_VIDEO_TASKS[tid] = snap
        return snap
    trusted = _is_trusted_provider(definition)
    api_key = _get_api_key_for_provider(provider_id, definition)
    entry_name = getattr(definition, "code_entry", None) or "generate"
    lang = (getattr(definition, "language", None) or "python").lower()
    code = definition.code or ""
    ctx = {"prompt": "", "task_id": tid, "api_key": api_key, "provider_id": provider_id,
           "kind": "video", "dynamic_inputs": {"task_id": tid}}
    try:
        if lang in ("javascript", "js", "node"):
            result = await asyncio.wait_for(_execute_js_code(code, entry_name, ctx, timeout=30, trusted=trusted), timeout=45)
        else:
            result = await asyncio.wait_for(_execute_python_code(code, entry_name, ctx, timeout=30, trusted=trusted), timeout=45)
    except Exception as e:
        # 瞬态错误（网络抖动/单次查询超时）：只刷新心跳，交由轮询器继续
        ent = _CODE_VIDEO_TASKS.get(tid) or {"task_id": tid, "provider": provider_id}
        ent.update({"status": ent.get("status") or "SUBMITTED", "last_poll": time.time(),
                    "last_error": str(e)[:160]})
        _CODE_VIDEO_TASKS[tid] = ent
        return {"status": ent.get("status") or "SUBMITTED", "task_id": tid,
                "last_error": str(e)[:160], "transient": True}
    if not isinstance(result, dict):
        return {"status": "RUNNING", "task_id": tid}
    url, _t = extract_result_media("video", result)
    new_tid = str(result.get("task_id") or result.get("id") or "").strip()
    if not url and new_tid and new_tid != tid:
        # 查询调用却返回新 task_id：该源缺查询分支（把查询当再次提交），任务永远不会终态
        snap = {"status": "FAILED", "task_id": tid, "provider": provider_id,
                "error": ("该 Provider 缺少异步查询分支：以「空 prompt + task_id」调用时返回了新的 task_id，"
                          "疑似把查询当成了再次提交。请实现『ctx 有 task_id 且 prompt 为空 → 调查询接口』分支，"
                          "并返回与传入相同的 task_id（参考 provider-factory 技能·异步视频源铁律）。")}
        _CODE_VIDEO_TASKS[tid] = snap
        print(f"[CodeVideo] Task {tid} FAILED: missing query branch (got new task_id {new_tid})")
        return snap
    if url:
        try:
            storage_url, local_path = await persist_media(url, "video", "vid")
        except Exception as e:
            snap = {"status": "FAILED", "task_id": tid, "provider": provider_id, "error": f"下载失败: {e}"}
            _CODE_VIDEO_TASKS[tid] = snap
            return snap
        snap = {"status": "SUCCESS", "task_id": tid, "provider": provider_id,
                "video_url": storage_url, "local_path": local_path}
        _CODE_VIDEO_TASKS[tid] = snap
        print(f"[CodeVideo] Task {tid} SUCCESS -> {storage_url}")
        return snap
    status = str(result.get("status") or "").upper()
    if status in _CODE_VIDEO_TERMINAL_FAIL:
        snap = {"status": "FAILED", "task_id": tid, "provider": provider_id,
                "error": str(result.get("error") or result)[:300]}
        _CODE_VIDEO_TASKS[tid] = snap
        print(f"[CodeVideo] Task {tid} FAILED: {str(result)[:160]}")
        return snap
    ent = _CODE_VIDEO_TASKS.get(tid) or {"task_id": tid, "provider": provider_id}
    ent.update({"status": status or "SUBMITTED", "last_poll": time.time()})
    _CODE_VIDEO_TASKS[tid] = ent
    return {"status": ent.get("status") or "SUBMITTED", "task_id": tid, "provider": provider_id}


async def _poll_code_video_task(task_id: str, provider_id: str) -> None:
    """旧后台轮询（外部直调 provider 的兼容路径）：复用 query_code_task_once。"""
    tid = str(task_id)
    for _ in range(_CODE_VIDEO_MAX_ATTEMPTS):
        await asyncio.sleep(_CODE_VIDEO_POLL_INTERVAL)
        snap = await query_code_task_once(provider_id, tid)
        if str(snap.get("status") or "").upper() in ("SUCCESS", "FAILED", "TIMEOUT"):
            return
    ent = _CODE_VIDEO_TASKS.get(tid) or {"task_id": tid, "provider": provider_id}
    ent.update({"status": "TIMEOUT", "error": "轮询超时（~25min），可携带 task_id 重新查询"})
    _CODE_VIDEO_TASKS[tid] = ent


_JS_WRAPPER_TEMPLATE = r"""
const fs = require('fs');
(async () => {
  const ctx = JSON.parse(process.env.CTX_JSON || '{}');
  const codePath = process.env.USER_CODE_PATH;
  let mod;
  try {
    mod = require(codePath);
  } catch(e){
    console.error(JSON.stringify({ok:false, error:"require failed: "+e.message}));
    process.exit(0);
  }
  let fn = mod[process.env.ENTRY] || mod.default || mod.generate;
  if(!fn){
    const keys = Object.keys(mod);
    if(keys.length===1 && typeof mod[keys[0]]==='function') fn = mod[keys[0]];
  }
  if(!fn || typeof fn!=='function'){
    console.error(JSON.stringify({ok:false, error:"entry not found "+process.env.ENTRY}));
    process.exit(0);
  }
  const api = {
    fetch: async (url, opts={}) => {
      const https = require('https');
      const http = require('http');
      return new Promise((resolve, reject)=>{
        const u = new URL(url);
        const lib = u.protocol==='https:'?https:http;
        const req = lib.request(url, {method: opts.method||'GET', headers: opts.headers||{}}, res=>{
          let data='';
          res.on('data', c=> data+=c);
          res.on('end', ()=> resolve({
            ok: res.statusCode>=200&&res.statusCode<300,
            status: res.statusCode,
            headers: res.headers,
            text: ()=> Promise.resolve(data),
            json: ()=> Promise.resolve(JSON.parse(data||'{}')),
          }));
        });
        req.on('error', reject);
        if(opts.body) req.write(typeof opts.body==='string'?opts.body:JSON.stringify(opts.body));
        req.end();
      });
    },
    sleep: (ms)=> new Promise(r=>setTimeout(r, ms)),
    download: null,
  };
  try{
    let result = fn(ctx, api);
    if(result && typeof result.then==='function') result = await result;
    console.log(JSON.stringify({ok:true, result}));
  } catch(e){
    console.error(JSON.stringify({ok:false, error:e.message, stack:e.stack}));
  }
})();
"""

async def _execute_js_code(code: str, entry: str, ctx: Dict[str, Any], timeout: int = 1200, trusted: bool = False) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmpdir:
        user_path = os.path.join(tmpdir, "user_code.js")
        wrapper_path = os.path.join(tmpdir, "runner.js")
        if "module.exports" not in code and "exports." not in code:
            if f"function {entry}" in code or f"async function {entry}" in code or f"const {entry}" in code or f"let {entry}" in code:
                code = code + f"\nmodule.exports = {{ {entry} }};\n"
                code = code + f"module.exports.default = {entry};\n"
            else:
                code = code + f"\nif(typeof {entry}==='function') module.exports={{{entry}}};\n"
        with open(user_path, "w", encoding="utf-8") as f:
            f.write(code)
        with open(wrapper_path, "w", encoding="utf-8") as f:
            f.write(_JS_WRAPPER_TEMPLATE)
        env = os.environ.copy()
        env["CTX_JSON"] = json.dumps(ctx, ensure_ascii=False)
        env["USER_CODE_PATH"] = user_path
        env["ENTRY"] = entry
        # JS 本就跑在独立 node 进程（可 require fs/child_process），trusted 仅显式标记透传
        try:
            from app.core.config import is_trusted_mode_enabled as _gate_js
            env["STUDIO_TRUSTED"] = "1" if (trusted and _gate_js()) else "0"
        except Exception:
            env["STUDIO_TRUSTED"] = "0"
        try:
            proc = await asyncio.create_subprocess_exec(
                "node", wrapper_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError(f"JS timeout ({timeout}s)")
            out = stdout.decode("utf-8", errors="ignore").strip()
            err = stderr.decode("utf-8", errors="ignore").strip()
            if out:
                for line in reversed(out.splitlines()):
                    line=line.strip()
                    if not line: continue
                    try:
                        payload = json.loads(line)
                        if payload.get("ok"):
                            res = payload.get("result")
                            if not isinstance(res, dict):
                                raise RuntimeError(f"JS must return object, got {type(res)}")
                            return res
                        else:
                            raise RuntimeError(payload.get("error") or err or "JS failed")
                    except json.JSONDecodeError:
                        continue
            raise RuntimeError(err or out or "JS no output")
        except FileNotFoundError:
            raise RuntimeError("Node.js not found, cannot execute JS provider")
        except Exception as e:
            raise


async def execute_code_provider(definition: ProviderDefinition, ctx: Dict[str, Any]) -> Dict[str, Any]:
    if not definition.code or not definition.code.strip():
        raise RuntimeError(f"Provider {definition.id} has no code")
    # 注入自定义请求头 (Custom Headers)，满足 OpenCode 网关与自定义代理规范
    hdrs = getattr(definition, "headers", None) or (getattr(definition.transport, "headers", None) if getattr(definition, "transport", None) else {}) or {}
    ctx.setdefault("headers", hdrs)
    ctx.setdefault("custom_headers", hdrs)
    timeout = resolve_code_timeout(definition)
    entry = definition.code_entry or "generate"
    # 可信判定：逐源 trusted + 全局总闸，逐源要可信但总闸未开时直接明错（不静默回落沙箱）
    want_trusted = bool(getattr(definition, "trusted", False))
    trusted = False
    if want_trusted:
        try:
            from app.core.config import is_trusted_mode_enabled as _gate_exec
            if _gate_exec():
                trusted = True
            else:
                raise RuntimeError(
                    f"Provider {definition.id} 已标记可信(trusted=True)但全局可信开关未开启："
                    "请在 .env/环境变量设 STUDIO_TRUSTED_MODE=1 并重启后端后再试（本地桌面端显式 opt-in）"
                )
        except RuntimeError:
            raise
        except Exception:
            trusted = False
    lang = (definition.language or "python").lower()
    if lang == "python":
        return await _execute_python_code(definition.code, entry, ctx, timeout=timeout, trusted=trusted)
    elif lang in ("javascript", "js", "node"):
        return await _execute_js_code(definition.code, entry, ctx, timeout=timeout, trusted=trusted)
    else:
        raise RuntimeError(f"unsupported language: {lang}")


class _CodeSourceBase:
    """
    代码源包装基类：is_configured/check_health/capabilities 共用；
    generate 由三个 kind 薄壳实现（ctx 兜底链 = 用户显式选择 > 请求显式字段 > kind 默认）。
    """
    kind = "image"

    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.display_name = definition.get_display_name()
        self.language = definition.language or "python"

    def is_configured(self) -> bool:
        # 代码源自行处理 Key（可能内联在代码里），不以 auth 缺 Key 判不可用——
        # 旧逻辑用 auth.type!=none 硬拦，导致"代码自带 Key"的自定义源永远无法被调用。
        return bool(self.definition.code and self.definition.code.strip())

    async def check_health(self) -> bool:
        # 仅语法级检查（不 exec，避免模块级副作用被健康检查反复触发）；深度体检走 compile_check_code（测试按钮/创建时）
        if not self.is_configured():
            return False
        if self.language == "python":
            try:
                ast.parse(self.definition.code or "")
                return True
            except Exception:
                return False
        return True

    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({"id": self.id, "display_name": self.display_name, "kind": self.kind,
                     "provider_type": "code", "language": self.language,
                     "has_code": bool(self.definition.code), "is_configured": self.is_configured()})
        return base

    def _api_key(self) -> str:
        return _get_api_key_for_provider(self.id, self.definition)

    def _engine(self) -> str:
        return f"code:{self.id} ({self.language})"

    @staticmethod
    def _default_model(definition, req) -> str:
        return (getattr(req, "model", None) or definition.default_model
                or (definition.models[0] if definition.models else "") or "")


class GenericCodeImageProvider(_CodeSourceBase, ImageProvider):
    kind = "image"

    # 独立控件分辨率档位 → 像素（分辨率/比例下拉不再手填 size）
    RES_MAP = {
        "480p": {"9:16": (480, 832), "16:9": (832, 480), "1:1": (480, 480)},
        "720p": {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)},
        "1080p": {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)},
    }
    FALLBACK_SIZES = {"9:16": (832, 1216), "16:9": (1216, 832), "1:1": (1024, 1024)}

    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        # prompt 只是 ctx 数据之一（去模板后可来自上游连线/暴露项/为空），契约由源代码自己定义。
        # 不再硬拦缺失 API Key：代码源可能内联 Key，由用户代码自行校验并给出明确错误。
        api_key = self._api_key()
        user = merge_user_params(req)
        # 出网前枚举护栏：只校验用户显式选择，非法直接报错（不消耗配额）
        validate_user_params(self.definition, user)
        # 本地 /storage 引用内联为 data URI（云端 API 拉不到本机地址，旧链路静默丢弃）
        from app.providers.media_refs import resolve_media_refs as _resolve_refs
        _raw_refs = (req.dynamic_inputs or {}).get("reference_images") or []
        if isinstance(_raw_refs, str):
            _raw_refs = [_raw_refs]
        _kept_refs, _dropped_refs = _resolve_refs(_raw_refs, kind="image")
        if _raw_refs and not _kept_refs and _dropped_refs:
            _reasons = "；".join(f"{d['ref'][:60]}({d['reason']})" for d in _dropped_refs[:3])
            raise RuntimeError(f"参考图全部不可用，已拦截提交以免浪费配额: {_reasons}")
        ar = user.get("aspect_ratio") or getattr(req, "aspect_ratio", None) or "9:16"
        res_label = user.get("resolution") or getattr(req, "resolution", None) or "720p"
        if req.width and req.height:
            width, height = req.width, req.height
        else:
            width, height = self.RES_MAP.get(res_label, {}).get(ar) or self.FALLBACK_SIZES.get(ar, (1024, 1024))
        ctx: Dict[str, Any] = {
            "prompt": req.prompt.strip(),
            "negative_prompt": user.get("negative_prompt") or req.negative_prompt or "",
            "width": width, "height": height, "size": f"{width}x{height}",
            "aspect_ratio": ar, "resolution": res_label,
            "seed": req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little") % 9999999999,
            "model": user.get("model") or self._default_model(self.definition, req),
            "steps": user.get("steps") or req.steps or 20,
            "cfg": user.get("cfg") or req.cfg or 7.0,
            "fps": user.get("fps") or getattr(req, "fps", None),
            "duration": user.get("duration") or getattr(req, "duration", None),
            "style_preset": user.get("style_preset") or req.style_preset or "",
            "api_key": api_key, "provider_id": self.id, "kind": "image",
            "dynamic_inputs": req.dynamic_inputs or {},
            "reference_images": _kept_refs,
            "api_key_env": self.definition.auth.key_env,
            "headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
            "custom_headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
        }
        for k, v in user.items():
            ctx.setdefault(k, v)
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        url, _task = extract_result_media("image", result)
        if not url:
            raise RuntimeError(f"代码未返回图像地址（需含 image_url）: {str(result)[:600]}")
        storage_url, local_path = await persist_media(url, "image", "code")
        if _dropped_refs and isinstance(result, dict):
            result = {**result, "media_warnings": [f"参考图 {d['ref'][:60]} 已跳过({d['reason']})" for d in _dropped_refs[:5]]}
        return ImageGenerateResult(image_url=storage_url, local_path=local_path or storage_url, provider=self.id,
                                   seed=ctx["seed"], width=width, height=height,
                                   elapsed_ms=int((time.time() - started) * 1000),
                                   engine=self._engine(), raw=result)


class GenericCodeVideoProvider(_CodeSourceBase, VideoProvider):
    kind = "video"

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        # 不再硬拦缺失 API Key：代码源可能内联 Key（如 AutoDL 源），由用户代码自行校验。
        api_key = self._api_key()
        user = merge_user_params(req)
        validate_user_params(self.definition, user)
        # 兼容：reference_audios/last_frame 等可能仅在 dynamic_inputs 中
        dyn = req.dynamic_inputs or {}
        _extra = getattr(req, "extra", None) or {}
        # 本地 /storage 引用内联为 data URI（云端 API 拉不到本机地址，旧链路静默丢弃致“参考无法使用”）
        from app.providers.media_refs import resolve_media_refs as _resolve_vrefs, resolve_single_ref as _resolve_vref
        _ff_raw = req.first_frame_url or dyn.get("first_frame") or dyn.get("first_frame_url") or ""
        _lf_raw = getattr(req, "last_frame_url", None) or dyn.get("last_frame") or dyn.get("last_frame_url") or ""
        _ff, _ff_drop = _resolve_vref(_ff_raw, kind="image")
        _lf, _lf_drop = _resolve_vref(_lf_raw, kind="image")
        _ri_raw = req.reference_images or dyn.get("reference_images") or dyn.get("reference") or []
        if isinstance(_ri_raw, str):
            _ri_raw = [_ri_raw]
        _ri_kept, _ri_dropped = _resolve_vrefs(_ri_raw, kind="image")
        _ra_raw = dyn.get("reference_audios") or dyn.get("ref_audio") or dyn.get("reference_audio") or []
        if isinstance(_ra_raw, str):
            _ra_raw = [_ra_raw]
        _ra_kept, _ra_dropped = _resolve_vrefs(_ra_raw, kind="audio")
        _media_dropped = ([{**_ff_drop, "slot": "first_frame"}] if _ff_drop else []) \
            + ([{**_lf_drop, "slot": "last_frame"}] if _lf_drop else []) \
            + [{**d, "slot": "reference_images"} for d in _ri_dropped] \
            + [{**d, "slot": "reference_audios"} for d in _ra_dropped]
        # 调用方显式挂载了媒体引用但全部不可用 → 明错拦截，不浪费配额提交无参考任务
        _supplied_media = bool((_ff_raw or "").strip() or (_lf_raw or "").strip() or _ri_raw or _ra_raw)
        _kept_any = bool(_ff or _lf or _ri_kept or _ra_kept)
        if _supplied_media and not _kept_any and _media_dropped:
            _reasons = "；".join(f"[{d.get('slot')}]{d['ref'][:60]}({d['reason']})" for d in _media_dropped[:3])
            raise RuntimeError(f"媒体引用全部不可用，已拦截提交: {_reasons}")
        ctx: Dict[str, Any] = {
            "prompt": req.prompt or "", "mode": req.mode,
            # 查询模式：调用方透传 task_id（dynamic_inputs/extra）+ 空 prompt → 源代码走单次查询分支
            "task_id": dyn.get("task_id") or _extra.get("task_id") or "",
            "first_frame_url": _ff or "",
            "first_frame": _ff or "",
            "last_frame_url": _lf or "",
            "last_frame": _lf or "",
            "reference_images": _ri_kept,
            "reference_audios": _ra_kept,
            "ref_audio": _ra_kept,
            # 用户显式选择 > 请求显式字段 > kind 默认
            "duration": user.get("duration") or req.duration or 5,
            "aspect_ratio": user.get("aspect_ratio") or req.aspect_ratio or "9:16",
            "resolution": user.get("resolution") or getattr(req, "resolution", None) or "720p",
            "fps": user.get("fps") or getattr(req, "fps", None) or 24,
            "seed": req.seed if req.seed is not None else user.get("seed") if user.get("seed") is not None else 0,
            "model": user.get("model") or req.provider or self.definition.default_model or "",
            # 源 params_schema 可声明 workflow_id（如 AutoDL 的工作流切换），用户显式值优先于 ComfyUI 语义的 req.workflow_id
            "workflow_id": user.get("workflow_id") or req.workflow_id or "",
            "api_key": api_key, "provider_id": self.id, "kind": "video",
            "dynamic_inputs": dyn,
            "steps": user.get("steps"), "cfg": user.get("cfg"),
            "headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
            "custom_headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
        }
        # 兼容：code 内可能用 ctx.get("reference_audios") 或 ctx.get("ref_audio") 或 ctx["dynamic_inputs"]["reference_audios"]
        # 已在上层扁平化，此处再兜底
        for k in ("reference_audios", "ref_audio", "reference_audio", "reference_images", "first_frame", "last_frame"):
            if k not in ctx or not ctx[k]:
                if k in dyn and dyn[k]:
                    ctx[k] = dyn[k]
        for k, v in user.items():
            ctx.setdefault(k, v)
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        if _media_dropped and isinstance(result, dict):
            result = {**result, "media_warnings": [f"[{d.get('slot')}]{d['ref'][:60]} 已跳过({d['reason']})" for d in _media_dropped[:5]]}
        url, task_id = extract_result_media("video", result)
        if not url and task_id:
            # 轮询接管流：用户代码只返回 task_id → 注册进代码任务表并起后台轮询（复用源查询模式），
            # 调用方立即拿到 task_id（不再阻塞），经 /videos/status 或 provider 查询分支取终态。
            register_code_video_task(str(task_id), self.id)
            _spawn_code_video_poll(str(task_id), self.id)
            return VideoGenerateResult(video_url="", local_path=None, provider=self.id, engine=self._engine(),
                                       duration=req.duration or 5, elapsed_ms=int((time.time() - started) * 1000),
                                       task_id=task_id, raw=result)
        if not url:
            raise RuntimeError(f"代码未返回视频地址（需含 video_url）: {str(result)[:600]}")
        storage_url, local_path = await persist_media(url, "video", "vid")
        return VideoGenerateResult(video_url=storage_url, local_path=local_path or storage_url, provider=self.id,
                                   engine=self._engine(), duration=req.duration or 5,
                                   elapsed_ms=int((time.time() - started) * 1000), task_id=task_id, raw=result)


class GenericCodeAudioProvider(_CodeSourceBase, AudioProvider):
    kind = "audio"

    async def list_voices(self):
        if self.definition.models:
            return [{"id": m, "name": m} for m in self.definition.models]
        return []

    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        api_key = self._api_key()
        user = merge_user_params(req)
        validate_user_params(self.definition, user)
        # 参考音频同样内联本地 /storage（音色克隆源此前收不到任何参考音频）
        from app.providers.media_refs import resolve_media_refs as _resolve_arefs
        _dyn_a = getattr(req, "dynamic_inputs", None) or {}
        _a_raw = _dyn_a.get("reference_audio") or _dyn_a.get("ref_audio") or _dyn_a.get("reference_audios") or getattr(req, "ref_audio_path", None) or (user.get("ref_audio") or user.get("reference_audio"))
        if isinstance(_a_raw, str) and _a_raw.strip():
            _a_raw = [_a_raw]
        _a_kept, _a_dropped = _resolve_arefs(_a_raw or [], kind="audio")
        ctx: Dict[str, Any] = {
            "text": req.text,
            "voice_id": user.get("voice_id") or req.voice_id,
            "emotion": user.get("emotion") or req.emotion,
            "speed": user.get("speed") if user.get("speed") is not None else req.speed,
            "pitch": user.get("pitch") if user.get("pitch") is not None else req.pitch,
            "volume": user.get("volume"),
            "model": user.get("model") or self._default_model(self.definition, req),
            "reference_audio": (_a_kept[0] if _a_kept else ""),
            "ref_audio": (_a_kept[0] if _a_kept else ""),
            "reference_audios": _a_kept,
            "api_key": api_key, "provider_id": self.id, "kind": "audio",
            "dynamic_inputs": getattr(req, "dynamic_inputs", None) or {},
            "headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
            "custom_headers": self.definition.headers or (self.definition.transport.headers if self.definition.transport else {}) or {},
        }
        for k, v in user.items():
            ctx.setdefault(k, v)
        result = await execute_code_provider(self.definition, ctx)
        if _a_dropped and isinstance(result, dict):
            result = {**result, "media_warnings": [f"参考音频 {d['ref'][:60]} 已跳过({d['reason']})" for d in _a_dropped[:3]]}
        url, _task = extract_result_media("audio", result)
        if not url:
            raise RuntimeError(f"代码未返回音频地址（需含 audio_url）: {str(result)[:600]}")
        storage_url, local_path = await persist_media(url, "audio", "tts")
        return AudioGenerateResult(audio_url=storage_url, local_path=local_path or storage_url, voice_id=req.voice_id,
                                   text=req.text, emotion=req.emotion, duration=1.0, provider=self.id,
                                   engine=self._engine(), status="ready", raw=result)
