
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


def _validate_python_code(code: str):
    for pat in [r"os\.system", r"subprocess\.", r"shutil\."]:
        if re.search(pat, code):
            raise ValueError(f"forbidden pattern: {pat}")
    try:
        ast.parse(code)
    except SyntaxError as e:
        raise ValueError(f"Python syntax error: {e}") from e


def _python_sandbox(ctx: Dict[str, Any]):
    """
    构造受限执行环境，返回 (globals, locals_dict, api)。
    _execute_python_code（真实执行）与 compile_check_code（创建体检）共用，保证体检环境=运行环境。
    """
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


async def _execute_python_code(code: str, entry: str, ctx: Dict[str, Any], timeout: int = 60) -> Dict[str, Any]:
    _validate_python_code(code)
    g, l, api = _python_sandbox(ctx)
    try:
        exec(code, g, l)
    except Exception as e:
        raise RuntimeError(f"code compile failed: {e}") from e
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
    except Exception as e:
        raise RuntimeError(f"code execution failed: {e}") from e


def compile_check_code(language: str, code: str, entry: str = "generate") -> Dict[str, Any]:
    """
    创建即体检（零网络/零配额）：在真实沙箱中编译用户代码并定位入口函数。
    可捕获：语法错误、模块级 import 违禁/缺失、入口缺失、模块级运行时错误。
    返回 {ok, error?}；js 语言做 node --check 语法校验（node 不可用时跳过）。
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
        _validate_python_code(code)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    g, l, _api = _python_sandbox({})
    try:
        exec(code, g, l)
    except Exception as e:
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
                   "seed", "negative_prompt", "text", "prompt")


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
    """超时策略单点：显式 code_timeout > legacy transport.timeout > kind 默认（视频 600s，其余 120s）"""
    explicit = getattr(definition, "code_timeout", None)
    if explicit:
        return int(explicit)
    transport = getattr(definition, "transport", None)
    if transport is not None:
        transport_timeout = transport.get("timeout") if isinstance(transport, dict) else getattr(transport, "timeout", None)
        if transport_timeout:
            return int(transport_timeout)
    return 600 if getattr(definition, "kind", "") == "video" else 120


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

async def _execute_js_code(code: str, entry: str, ctx: Dict[str, Any], timeout: int = 60) -> Dict[str, Any]:
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
    timeout = resolve_code_timeout(definition)
    entry = definition.code_entry or "generate"
    lang = (definition.language or "python").lower()
    if lang == "python":
        return await _execute_python_code(definition.code, entry, ctx, timeout=timeout)
    elif lang in ("javascript", "js", "node"):
        return await _execute_js_code(definition.code, entry, ctx, timeout=timeout)
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
        if not self.definition.code or not self.definition.code.strip():
            return False
        if self.definition.auth.type != "none":
            return bool(_get_api_key_for_provider(self.id, self.definition))
        return True

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
        # prompt 只是 ctx 数据之一（去模板后可来自上游连线/暴露项/为空），契约由源代码自己定义
        api_key = self._api_key()
        if self.definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} missing API Key")
        user = merge_user_params(req)
        # 出网前枚举护栏：只校验用户显式选择，非法直接报错（不消耗配额）
        validate_user_params(self.definition, user)
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
            "reference_images": (req.dynamic_inputs or {}).get("reference_images") or [],
            "api_key_env": self.definition.auth.key_env,
        }
        for k, v in user.items():
            ctx.setdefault(k, v)
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        url, _task = extract_result_media("image", result)
        if not url:
            raise RuntimeError(f"代码未返回图像地址（需含 image_url）: {str(result)[:600]}")
        storage_url, local_path = await persist_media(url, "image", "code")
        return ImageGenerateResult(image_url=storage_url, local_path=local_path or storage_url, provider=self.id,
                                   seed=ctx["seed"], width=width, height=height,
                                   elapsed_ms=int((time.time() - started) * 1000),
                                   engine=self._engine(), raw=result)


class GenericCodeVideoProvider(_CodeSourceBase, VideoProvider):
    kind = "video"

    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = self._api_key()
        if self.definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} missing API Key")
        user = merge_user_params(req)
        validate_user_params(self.definition, user)
        ctx: Dict[str, Any] = {
            "prompt": req.prompt or "", "mode": req.mode,
            "first_frame_url": req.first_frame_url or "",
            "reference_images": req.reference_images or [],
            # 用户显式选择 > 请求显式字段 > kind 默认
            "duration": user.get("duration") or req.duration or 5,
            "aspect_ratio": user.get("aspect_ratio") or req.aspect_ratio or "9:16",
            "resolution": user.get("resolution") or getattr(req, "resolution", None) or "720p",
            "fps": user.get("fps") or getattr(req, "fps", None) or 24,
            "seed": req.seed if req.seed is not None else 0,
            "model": user.get("model") or req.provider or self.definition.default_model or "",
            # 源 params_schema 可声明 workflow_id（如 AutoDL 的工作流切换），用户显式值优先于 ComfyUI 语义的 req.workflow_id
            "workflow_id": user.get("workflow_id") or req.workflow_id or "",
            "api_key": api_key, "provider_id": self.id, "kind": "video",
            "dynamic_inputs": req.dynamic_inputs or {},
            "steps": user.get("steps"), "cfg": user.get("cfg"),
        }
        for k, v in user.items():
            ctx.setdefault(k, v)
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        url, task_id = extract_result_media("video", result)
        if not url and task_id:
            # 轮询接管流：用户代码只返回 task_id
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
        ctx: Dict[str, Any] = {
            "text": req.text,
            "voice_id": user.get("voice_id") or req.voice_id,
            "emotion": user.get("emotion") or req.emotion,
            "speed": user.get("speed") if user.get("speed") is not None else req.speed,
            "pitch": user.get("pitch") if user.get("pitch") is not None else req.pitch,
            "volume": user.get("volume"),
            "model": user.get("model") or self._default_model(self.definition, req),
            "api_key": api_key, "provider_id": self.id, "kind": "audio",
            "dynamic_inputs": req.dynamic_inputs or {},
        }
        for k, v in user.items():
            ctx.setdefault(k, v)
        result = await execute_code_provider(self.definition, ctx)
        url, _task = extract_result_media("audio", result)
        if not url:
            raise RuntimeError(f"代码未返回音频地址（需含 audio_url）: {str(result)[:600]}")
        storage_url, local_path = await persist_media(url, "audio", "tts")
        return AudioGenerateResult(audio_url=storage_url, local_path=local_path or storage_url, voice_id=req.voice_id,
                                   text=req.text, emotion=req.emotion, duration=1.0, provider=self.id,
                                   engine=self._engine(), status="ready", raw=result)
