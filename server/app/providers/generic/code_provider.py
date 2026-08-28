
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


async def _execute_python_code(code: str, entry: str, ctx: Dict[str, Any], timeout: int = 60) -> Dict[str, Any]:
    _validate_python_code(code)
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
    g: Dict[str, Any] = {
        "__builtins__": {
            "len": len, "str": str, "int": int, "float": float, "bool": bool,
            "dict": dict, "list": list, "set": set, "tuple": tuple,
            "range": range, "enumerate": enumerate, "zip": zip,
            "print": print, "isinstance": isinstance, "issubclass": issubclass,
            "hasattr": hasattr, "getattr": getattr, "setattr": setattr,
            "min": min, "max": max, "sum": sum, "sorted": sorted,
            "any": any, "all": all, "abs": abs, "round": round,
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
    timeout = definition.code_timeout or definition.transport.timeout or 60
    entry = definition.code_entry or "generate"
    lang = (definition.language or "python").lower()
    if lang == "python":
        return await _execute_python_code(definition.code, entry, ctx, timeout=timeout)
    elif lang in ("javascript", "js", "node"):
        return await _execute_js_code(definition.code, entry, ctx, timeout=timeout)
    else:
        raise RuntimeError(f"unsupported language: {lang}")


class GenericCodeImageProvider(ImageProvider):
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
        if not self.is_configured():
            return False
        code = self.definition.code or ""
        if self.language == "python":
            try:
                ast.parse(code)
                return True
            except Exception:
                return False
        return True
    def get_capabilities(self) -> Dict[str, Any]:
        base = super().get_capabilities()
        base.update({"id": self.id, "display_name": self.display_name, "kind": "image", "provider_type": "code", "language": self.language, "has_code": bool(self.definition.code), "is_configured": self.is_configured()})
        return base
    async def generate(self, req: ImageGenerateRequest) -> ImageGenerateResult:
        if not req.prompt or not req.prompt.strip():
            raise ValueError("prompt empty")
        api_key = _get_api_key_for_provider(self.id, self.definition)
        if self.definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} missing API Key")
        # 独立控件：resolution 下拉（480p/720p/1080p） + aspect_ratio 下拉（9:16/16:9/1:1） 不再手填 size
        RES_MAP = {
            "480p": {"9:16": (480, 832), "16:9": (832, 480), "1:1": (480, 480)},
            "720p": {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)},
            "1080p": {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)},
        }
        ar = getattr(req, 'aspect_ratio', None) or (req.extra or {}).get('aspect_ratio') or "9:16"
        res_label = getattr(req, 'resolution', None) or (req.extra or {}).get('resolution') or "720p"
        if req.width and req.height:
            width, height = req.width, req.height
        else:
            wh = RES_MAP.get(res_label, {}).get(ar)
            if wh:
                width, height = wh
            else:
                aspect_sizes = {"9:16": (832, 1216), "16:9": (1216, 832), "1:1": (1024, 1024)}
                width, height = aspect_sizes.get(ar, (1024, 1024))
        # 合并 extra 独立参数
        extra = req.extra or {}
        ctx: Dict[str, Any] = {
            "prompt": req.prompt.strip(),
            "negative_prompt": req.negative_prompt or "",
            "width": width, "height": height, "size": f"{width}x{height}",
            "aspect_ratio": ar,
            "resolution": res_label,
            "seed": req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little") % 9999999999,
            "model": req.model or self.definition.default_model or (self.definition.models[0] if self.definition.models else ""),
            "steps": req.steps if req.steps is not None else extra.get('steps', 20),
            "cfg": req.cfg if req.cfg is not None else extra.get('cfg', 7.0),
            "fps": getattr(req, 'fps', None) or extra.get('fps'),
            "duration": getattr(req, 'duration', None) or extra.get('duration'),
            "style_preset": req.style_preset or "",
            "api_key": api_key, "provider_id": self.id, "kind": "image",
            "dynamic_inputs": req.dynamic_inputs or {},
            "reference_images": (req.dynamic_inputs or {}).get("reference_images") or [],
            "api_key_env": self.definition.auth.key_env,
        }
        # 透传所有独立控件余量
        for k, v in extra.items():
            if k not in ctx:
                ctx[k] = v
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        image_url = result.get("image_url") or result.get("url") or result.get("output")
        if not image_url and result.get("image_urls"):
            image_url = result["image_urls"][0] if isinstance(result["image_urls"], list) else None
        if not image_url and result.get("b64_json"):
            import base64
            b64 = result["b64_json"].split(",")[-1]
            data = base64.b64decode(b64)
            gen_dir = _get_generated_dir()
            fname = f"code_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
            local_path = os.path.join(gen_dir, fname)
            with open(local_path, "wb") as f:
                f.write(data)
            storage_url = f"/storage/generated/{fname}"
            return ImageGenerateResult(image_url=storage_url, local_path=local_path, provider=self.id, seed=ctx["seed"], width=width, height=height, elapsed_ms=int((time.time()-started)*1000), engine=f"code:{self.id} ({self.language})", raw=result)
        if not image_url:
            raise RuntimeError(f"code must return image_url, got {str(result)[:600]}")
        if image_url.startswith("http"):
            storage_url, local_path = await _download_to_storage(image_url, prefix="code")
        elif image_url.startswith("data:"):
            import base64
            b64 = image_url.split(",")[-1]
            data = base64.b64decode(b64)
            gen_dir = _get_generated_dir()
            fname = f"code_{int(time.time())}_{uuidlib.uuid4().hex[:8]}.png"
            local_path = os.path.join(gen_dir, fname)
            with open(local_path, "wb") as f:
                f.write(data)
            storage_url = f"/storage/generated/{fname}"
        else:
            storage_url, local_path = image_url, None
        return ImageGenerateResult(image_url=storage_url, local_path=local_path or storage_url, provider=self.id, seed=ctx["seed"], width=width, height=height, elapsed_ms=int((time.time()-started)*1000), engine=f"code:{self.id} ({self.language})", raw=result)


class GenericCodeVideoProvider(VideoProvider):
    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.language = definition.language or "python"
    def is_configured(self) -> bool:
        if not self.definition.code or not self.definition.code.strip():
            return False
        if self.definition.auth.type != "none":
            return bool(_get_api_key_for_provider(self.id, self.definition))
        return True
    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        if self.language == "python":
            try:
                ast.parse(self.definition.code or "")
                return True
            except Exception:
                return False
        return True
    def get_capabilities(self):
        base = super().get_capabilities()
        base.update({"id": self.id, "display_name": self.definition.get_display_name(), "kind": "video", "provider_type": "code", "language": self.language, "has_code": bool(self.definition.code)})
        return base
    async def generate(self, req: VideoGenerateRequest) -> VideoGenerateResult:
        api_key = _get_api_key_for_provider(self.id, self.definition)
        if self.definition.auth.type != "none" and not api_key:
            raise RuntimeError(f"Provider {self.id} missing API Key")
        extra = req.extra or {}
        # 合并 dynamic_inputs 中的独立参数（若前端走 dynamic_inputs 透传）
        dyn = req.dynamic_inputs or {}
        for k in ("fps","steps","cfg","width","height","resolution","aspect_ratio","duration"):
            if k in dyn and k not in extra:
                extra[k] = dyn[k]
        ctx: Dict[str, Any] = {
            "prompt": req.prompt, "mode": req.mode,
            "first_frame_url": req.first_frame_url or "",
            "reference_images": req.reference_images or [],
            "duration": req.duration or extra.get("duration") or 5,
            "aspect_ratio": req.aspect_ratio or extra.get("aspect_ratio") or "9:16",
            "resolution": getattr(req, "resolution", None) or extra.get("resolution") or "720p",
            "fps": getattr(req, "fps", None) or extra.get("fps") or 24,
            "seed": getattr(req, "seed", 0),
            "model": req.provider or self.definition.default_model or "",
            "api_key": api_key, "provider_id": self.id, "kind": "video",
            "dynamic_inputs": req.dynamic_inputs or {},
            "steps": extra.get("steps"),
            "cfg": extra.get("cfg"),
        }
        for k, v in extra.items():
            if k not in ctx:
                ctx[k] = v
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        video_url = result.get("video_url") or result.get("url") or result.get("output")
        if not video_url and result.get("video_urls"):
            video_url = result["video_urls"][0] if isinstance(result["video_urls"], list) else None
        task_id = result.get("task_id") or result.get("id")
        if not video_url and task_id:
            return VideoGenerateResult(video_url="", local_path=None, provider=self.id, engine=f"code:{self.id} ({self.language})", duration=req.duration or 5, elapsed_ms=int((time.time()-started)*1000), task_id=task_id, raw=result)
        if not video_url:
            raise RuntimeError(f"code must return video_url, got {str(result)[:600]}")
        if video_url.startswith("http"):
            storage_url, local_path = await _download_to_storage(video_url, prefix="vid")
            video_url = storage_url
        else:
            local_path = None
        return VideoGenerateResult(video_url=video_url, local_path=local_path or video_url, provider=self.id, engine=f"code:{self.id} ({self.language})", duration=req.duration or 5, elapsed_ms=int((time.time()-started)*1000), task_id=task_id, raw=result)


class GenericCodeAudioProvider(AudioProvider):
    def __init__(self, definition: ProviderDefinition):
        self.definition = definition
        self.id = definition.id
        self.language = definition.language or "python"
    def is_configured(self) -> bool:
        if not self.definition.code or not self.definition.code.strip():
            return False
        if self.definition.auth.type != "none":
            return bool(_get_api_key_for_provider(self.id, self.definition))
        return True
    async def check_health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            ast.parse(self.definition.code or "")
            return True
        except Exception:
            return False
    def get_capabilities(self):
        base = super().get_capabilities()
        base.update({"id": self.id, "display_name": self.definition.get_display_name(), "kind": "audio", "provider_type": "code", "language": self.language})
        return base
    async def list_voices(self):
        if self.definition.models:
            return [{"id": m, "name": m} for m in self.definition.models]
        return []
    async def generate(self, req: AudioGenerateRequest) -> AudioGenerateResult:
        api_key = _get_api_key_for_provider(self.id, self.definition)
        ctx: Dict[str, Any] = {"text": req.text, "voice_id": req.voice_id, "emotion": req.emotion, "speed": req.speed, "pitch": req.pitch, "model": req.model or self.definition.default_model or "", "api_key": api_key, "provider_id": self.id, "kind": "audio"}
        started = time.time()
        result = await execute_code_provider(self.definition, ctx)
        audio_url = result.get("audio_url") or result.get("url")
        if not audio_url and result.get("b64"):
            import base64
            b64 = result["b64"].split(",")[-1]
            data = base64.b64decode(b64)
            from app.core.config import settings
            fname = f"tts_{uuidlib.uuid4().hex[:8]}.mp3"
            local_path = os.path.join(settings.STORAGE_DIR, fname)
            with open(local_path, "wb") as f:
                f.write(data)
            storage_url = f"/storage/{fname}"
            return AudioGenerateResult(audio_url=storage_url, local_path=local_path, voice_id=req.voice_id, text=req.text, emotion=req.emotion, duration=1.0, provider=self.id, engine=f"code:{self.id}", status="ready", raw=result)
        if not audio_url:
            raise RuntimeError(f"code must return audio_url: {str(result)[:600]}")
        if audio_url.startswith("http"):
            storage_url, local_path = await _download_to_storage(audio_url, prefix="tts")
            audio_url = storage_url
        else:
            local_path = audio_url
        return AudioGenerateResult(audio_url=audio_url, local_path=local_path, voice_id=req.voice_id, text=req.text, emotion=req.emotion, duration=1.0, provider=self.id, engine=f"code:{self.id}", status="ready", raw=result)
