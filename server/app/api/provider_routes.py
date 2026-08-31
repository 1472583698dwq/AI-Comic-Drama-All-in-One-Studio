"""
Provider 管理路由 - 代码生成源唯一模式（彻底去 JSON）
支持 python / javascript 携程源码动态注册、编辑、升级、测试
"""
import os
import json
import re
import httpx
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field

from app.models.provider_definition import ProviderDefinition
from app.providers.custom.manager import custom_provider_manager
from app.core.config import settings

router = APIRouter()

# ---------- 代码模板 ----------

PY_IMAGE_TEMPLATE = '''import httpx

async def generate(ctx, api):
    """
    图像生成 - ctx: {prompt, negative_prompt, width, height, size, aspect_ratio, resolution, seed, model, style_preset, api_key, reference_images, dynamic_inputs}
    需返回 {"image_url": "https://..."} 或 {"b64_json": "..."}，框架会自动下载落盘
    支持独立控件：aspect_ratio[9:16/16:9/1:1] resolution[480p/720p/1080p] steps/cfg 下拉/滑杆
    """
    headers = {
        "Authorization": f"Bearer {ctx['api_key']}",
        "Content-Type": "application/json",
    }
    # 分辨率/比例 独立控件 -> 映射为 size/width/height，解决“工作流内是下拉，映射出来却是手填”
    RES_MAP = {
        "480p": {"9:16": (480, 832), "16:9": (832, 480), "1:1": (480, 480)},
        "720p": {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)},
        "1080p": {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)},
    }
    ar = ctx.get("aspect_ratio", "9:16")
    res = ctx.get("resolution", "720p")
    width, height = RES_MAP.get(res, {}).get(ar, (ctx.get("width", 720), ctx.get("height", 1280)))
    # 兼容部分 API 仍用 size 字符串
    size = f"{width}x{height}"
    payload = {
        "model": ctx.get("model") or "default",
        "prompt": ctx["prompt"],
        "negative_prompt": ctx.get("negative_prompt", ""),
        "size": ctx.get("size") or size,
        "width": width,
        "height": height,
        "aspect_ratio": ar,
        "resolution": res,
        "n": 1,
        "seed": ctx.get("seed", 0),
        "steps": ctx.get("steps", 20),
        "cfg": ctx.get("cfg", 7.0),
    }
    # 合并参考图（若API支持）
    if ctx.get("reference_images"):
        payload["reference_images"] = ctx["reference_images"]
    # 合并动态输入（独立控件透传）
    if ctx.get("dynamic_inputs"):
        payload.update({k: v for k, v in ctx["dynamic_inputs"].items() if k not in payload})
    # 合并 provider 独立参数（经 DynamicControl 透传的 provider_params）
    for k in ("aspect_ratio","resolution","steps","cfg","width","height"):
        if ctx.get(k) is not None and k not in payload:
            payload[k] = ctx[k]

    url = "https://api.example.com/v1/images/generations"  # TODO: 替换为真实 API 地址
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        # 按实际响应提取
        image_url = data.get("data", [{}])[0].get("url") or data.get("image_url") or data.get("url")
        if not image_url:
            raise RuntimeError(f"未找到 image_url: {str(data)[:500]}")
        return {"image_url": image_url}
'''

PY_VIDEO_TEMPLATE = '''import httpx
import asyncio
import re

async def generate(ctx, api):
    """
    视频生成 - ctx: {prompt, mode, first_frame_url, reference_images, duration, resolution, aspect_ratio, fps, api_key}
    需返回 {"video_url": "https://..."} 或 {"task_id": "..."}（轮询由框架二次处理，但此代码也可自行轮询后返回 video_url）
    独立控件：aspect_ratio[9:16/16:9/1:1] resolution[480p/720p/1080p] duration[3-15] fps[16/24/30] 均为下拉/滑杆
    """
    headers = {
        "Authorization": f"Bearer {ctx['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "prompt": ctx["prompt"],
        "duration": ctx.get("duration", 5),
        "resolution": ctx.get("resolution", "720p"),
        "aspect_ratio": ctx.get("aspect_ratio", "9:16"),
        "fps": ctx.get("fps", 24),
        "mode": ctx.get("mode", "i2v"),
    }
    if ctx.get("first_frame_url"):
        payload["first_frame_url"] = ctx["first_frame_url"]
    if ctx.get("reference_images"):
        payload["reference_images"] = ctx["reference_images"]

    url = "https://api.example.com/v1/videos/generations"  # TODO
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        # 同步返回
        video_url = data.get("video_url") or data.get("data", {}).get("video_url") or data.get("url")
        if video_url:
            return {"video_url": video_url}
        # 异步 task_id 轮询示例
        task_id = data.get("task_id") or data.get("data", {}).get("task_id") or data.get("id")
        if not task_id:
            raise RuntimeError(f"未找到 video_url/task_id: {str(data)[:600]}")
        # 轮询
        poll_url = f"https://api.example.com/v1/videos/status/{task_id}"
        for _ in range(40):
            await asyncio.sleep(3)
            pr = await client.get(poll_url, headers=headers)
            pr.raise_for_status()
            pj = pr.json()
            status = pj.get("status") or pj.get("data", {}).get("status", "")
            status = str(status).upper()
            if status in ("SUCCESS", "COMPLETED", "SUCCEEDED"):
                v = pj.get("video_url") or pj.get("data", {}).get("video_url") or pj.get("data", {}).get("results", [None])[0]
                if not v:
                    m = re.search(r"https?://[^\\s\"']+\\.(mp4|mov|webm)", str(pj))
                    if m: v = m.group(0)
                if v: return {"video_url": v}
            if status in ("FAILED", "ERROR"):
                raise RuntimeError(f"任务失败: {pj}")
        raise TimeoutError(f"轮询超时 task_id={task_id}")
'''

PY_AUDIO_TEMPLATE = '''import httpx

async def generate(ctx, api):
    """
    音频生成 - ctx: {text, voice_id, emotion, speed, pitch, model, api_key}
    需返回 {"audio_url": "https://..."} 或 {"b64": "..."}
    """
    headers = {
        "Authorization": f"Bearer {ctx['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "text": ctx["text"],
        "voice_id": ctx.get("voice_id", "default"),
        "emotion": ctx.get("emotion", "neutral"),
        "speed": ctx.get("speed", 1.0),
        "model": ctx.get("model") or "default",
    }
    url = "https://api.example.com/v1/audio/speech"  # TODO
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.post(url, headers=headers, json=payload)
        # 部分API直接返回二进制
        if resp.headers.get("content-type","").startswith("audio"):
            import uuid, os
            from app.core.config import settings
            fname = f"tts_{uuid.uuid4().hex[:8]}.mp3"
            path = os.path.join(settings.STORAGE_DIR, fname)
            with open(path, "wb") as f:
                f.write(resp.content)
            return {"audio_url": f"/storage/{fname}"}
        resp.raise_for_status()
        data = resp.json()
        audio_url = data.get("audio_url") or data.get("url") or data.get("data", {}).get("audio_url")
        if not audio_url:
            raise RuntimeError(f"未找到 audio_url: {str(data)[:500]}")
        return {"audio_url": audio_url}
'''

JS_IMAGE_TEMPLATE = '''async function generate(ctx, api) {
  // ctx: {prompt, width, height, size, aspect_ratio, resolution, steps, cfg, model, api_key, reference_images}
  // 独立控件：aspect_ratio[9:16/16:9/1:1] resolution[480p/720p/1080p] 为下拉，不再手填 size
  const RES_MAP = {
    "480p": {"9:16": [480,832], "16:9": [832,480], "1:1": [480,480]},
    "720p": {"9:16": [720,1280], "16:9": [1280,720], "1:1": [720,720]},
    "1080p": {"9:16": [1080,1920], "16:9": [1920,1080], "1:1": [1080,1080]},
  };
  const ar = ctx.aspect_ratio || "9:16";
  const res = ctx.resolution || "720p";
  const wh = (RES_MAP[res]||RES_MAP["720p"])[ar] || [720,1280];
  const headers = {
    "Authorization": `Bearer ${ctx.api_key}`,
    "Content-Type": "application/json",
  };
  const payload = {
    model: ctx.model || "default",
    prompt: ctx.prompt,
    size: ctx.size || `${wh[0]}x${wh[1]}`,
    width: wh[0], height: wh[1],
    aspect_ratio: ar, resolution: res,
    steps: ctx.steps||20, cfg: ctx.cfg||7,
    seed: ctx.seed,
  };
  const url = "https://api.example.com/v1/images/generations"; // TODO
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const image_url = data?.data?.[0]?.url || data.image_url || data.url;
  if (!image_url) throw new Error("未找到 image_url: " + JSON.stringify(data).slice(0,500));
  return { image_url };
}
module.exports = { generate };
'''

JS_VIDEO_TEMPLATE = '''async function generate(ctx, api) {
  // ctx: {prompt, duration, resolution, aspect_ratio, fps, mode, first_frame_url, reference_images}
  const headers = { "Authorization": `Bearer ${ctx.api_key}`, "Content-Type": "application/json" };
  const payload = { prompt: ctx.prompt, duration: ctx.duration||5, resolution: ctx.resolution||"720p", aspect_ratio: ctx.aspect_ratio||"9:16", fps: ctx.fps||24, mode: ctx.mode||"i2v" };
  if (ctx.first_frame_url) payload.first_frame_url = ctx.first_frame_url;
  if (ctx.reference_images) payload.reference_images = ctx.reference_images;
  const url = "https://api.example.com/v1/videos/generations"; // TODO
  let res = await fetch(url, { method:"POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text());
  let data = await res.json();
  let video_url = data.video_url || data?.data?.video_url;
  if (video_url) return { video_url };
  let task_id = data.task_id || data?.data?.task_id || data.id;
  if (!task_id) throw new Error("未找到 video_url/task_id");
  const poll_url = `https://api.example.com/v1/videos/status/${task_id}`;
  for(let i=0;i<40;i++){
    await new Promise(r=> setTimeout(r, 3000));
    let pr = await fetch(poll_url, { headers });
    let pj = await pr.json();
    let status = (pj.status || pj?.data?.status || "").toUpperCase();
    if(status==="SUCCESS" || status==="COMPLETED"){
      let v = pj.video_url || pj?.data?.video_url || (Array.isArray(pj?.data?.results)? pj.data.results[0]:null);
      if(v) return { video_url: v };
    }
    if(status==="FAILED") throw new Error(JSON.stringify(pj));
  }
  throw new Error("轮询超时 task_id="+task_id);
}
module.exports = { generate };
'''

CODE_TEMPLATES = {
    ("python","image"): PY_IMAGE_TEMPLATE,
    ("python","video"): PY_VIDEO_TEMPLATE,
    ("python","audio"): PY_AUDIO_TEMPLATE,
    ("javascript","image"): JS_IMAGE_TEMPLATE,
    ("javascript","video"): JS_VIDEO_TEMPLATE,
    ("javascript","audio"): PY_AUDIO_TEMPLATE,  # 复用 python 模板占位
}

def _sanitize_for_frontend(pd: ProviderDefinition) -> Dict[str, Any]:
    info = pd.to_provider_info(include_code=True)
    if info.get("code") and len(info["code"]) > 8000:
        info["code_preview"] = info["code"][:8000] + "\n... (truncated, full code via GET /providers/{id})"
    # 存量自定义源缺 schema 时在读取路径兜底（唯一规则入口 resolve_params_schema，不落盘），
    # 否则 params_schema=null 导致分镜/画布渲染不出独立控件、参数无法透传
    try:
        info["params_schema"] = resolve_params_schema(pd.code, pd.kind, info.get("params_schema"))
        if not info.get("input_schema") or not info["input_schema"].get("properties"):
            info["input_schema"] = _default_input_schema(pd.kind)
        if not info.get("output_schema") or not info["output_schema"].get("properties"):
            info["output_schema"] = _default_output_schema(pd.kind)
    except Exception:
        pass
    return info

def _extract_params_schema_from_code(code_text: str) -> Optional[Dict[str, Any]]:
    """
    从生成代码尾部的 `# PARAMS_SCHEMA: {...}` / `// PARAMS_SCHEMA: {...}` 单行注释解析该源自己的独立参数 schema。
    目的：AI 生成源时带上 API 真实枚举（如 "480p竖"），避免通用默认枚举（"480p"）与实际 API 不符导致请求被拒。
    """
    if not code_text:
        return None
    m = re.search(r"(?:#|//)\s*PARAMS_SCHEMA:\s*(\{.*)", code_text, re.MULTILINE)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(1).strip())
        if isinstance(parsed, dict) and parsed.get("properties"):
            return parsed
    except Exception:
        pass
    return None


def resolve_params_schema(code: str, kind: str, explicit: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    params_schema 单点解析（全系统唯一规则）：
    显式声明 > 代码内 PARAMS_SCHEMA 注释 > kind 通用默认。
    创建/升级/导入/MCP/读取兜底 一律走这里，杜绝多处规则不一致。
    """
    if explicit and explicit.get("properties"):
        return explicit
    extracted = _extract_params_schema_from_code(code or "")
    if extracted:
        return extracted
    return _default_params_schema(kind)


def code_gen_system_prompt(kind: str, language: str, tmpl: str = "") -> str:
    """LLM 生成源代码的单一提示词源（MCP register_custom_provider 与 /providers/import 共用）。"""
    lang_label = "javascript" if language in ("javascript", "js", "node") else "python"
    return f"""你是生成源代码专家。用户提供了 {kind} 类 API 文档（{lang_label}），请直接生成可执行的携程源码。
要求：
- 输出 {lang_label} 代码，入口为 async def generate(ctx, api)（python）或 async function generate(ctx, api)（javascript）
- ctx 含 prompt/width/height/size/seed/model/style_preset/api_key/reference_images/first_frame_url/duration/resolution/aspect_ratio/fps/text/voice_id/emotion 等，api 含 httpx/asyncio/json/re/time/uuid/download(api.download(url,prefix)->(storage_url,local_path))；python 沙箱可 import 第三方库（aiohttp/requests/httpx）与 raise 异常
- 防御式解析（必须）：响应一律用 .get() 链取值；业务码非成功、data 缺失或为 null 时，必须 raise RuntimeError 并把服务端 code/msg/原始响应前300字符带出来，严禁对可能为 None 的值做 [] 下标取值
- 列表结果元素可能是对象（取其中的 url 字段）也可能是字符串，两种都兼容
- 必须包含完整请求、鉴权、payload、轮询（视频类用 while/for+sleep 并设最大轮询次数）、错误处理
- 成功返回 {{"image_url": url}} / {{"video_url": url}} / {{"audio_url": url}}，轮询场景可先返回 task_id 再由框架接管
- 若该 API 有自己的参数枚举（分辨率档位/比例/时长档等），必须在代码最后一行追加单行注释（一行合法 JSON）：
  # PARAMS_SCHEMA: {{"type":"object","properties":{{"resolution":{{"type":"string","title":"分辨率","enum":["...真实枚举..."],"default":"...","description":"..."}}}}}}
  框架会把它解析为该源的独立参数控件；没有自定义枚举则省略此行
- 仅输出代码，不要 markdown、不要解释
模板参考：
{tmpl[:2000]}
"""


def create_code_source(
    *,
    name: str,
    kind: str,
    code: str,
    language: str = "python",
    code_entry: Optional[str] = None,
    description: str = "",
    scope: str = "global",
    project_id: Optional[str] = None,
    api_key: Optional[str] = None,
    doc_text: str = "",
    doc_url: str = "",
    params_schema: Optional[Dict[str, Any]] = None,
    input_schema: Optional[Dict[str, Any]] = None,
    output_schema: Optional[Dict[str, Any]] = None,
    models: Optional[list] = None,
    default_model: Optional[str] = None,
    code_timeout: Optional[int] = None,
    provider_id: Optional[str] = None,
    icon: str = "Zap",
) -> Dict[str, Any]:
    """
    动态生成源统一创建入口（MCP 直建/带定义/文档 LLM 生成、/providers/import 共用）：
    代码清洗（去 markdown 围栏）→ schema 规整（resolve_params_schema 单点）→ 超时策略 → 保存注册 → Key 落盘 → 沙箱体检。
    返回 {"id", "provider": info, "compile_check": {...}}；体检失败不回滚，由调用方决定提示/重试。
    """
    import uuid as _uuid
    import re as _re
    from app.models.provider_definition import ProviderDefinition
    from app.providers.custom.manager import custom_provider_manager
    from app.providers.generic.code_provider import compile_check_code

    # 清理 markdown 包裹
    code = _re.sub(r"^```[a-z]*\n", "", (code or "").strip())
    code = _re.sub(r"\n```$", "", code.strip())
    if len(code) < 20:
        raise ValueError("代码内容过短")

    pid = provider_id or f"prov_{_uuid.uuid4().hex[:8]}"
    lang = "javascript" if language in ("javascript", "js", "node") else "python"
    data: Dict[str, Any] = {
        "id": pid, "name": name or f"自定义{kind}源", "kind": kind,
        "provider_type": "code", "language": lang, "code": code,
        "code_entry": code_entry or "generate",
        "code_timeout": code_timeout or (600 if kind == "video" else 120),
        "description": description or "动态代码生成源", "icon": icon,
        "scope": scope or "global", "enabled": True,
        "doc_text": (doc_text or "")[:4000], "raw_api_doc": (doc_text or "")[:4000],
    }
    if doc_url:
        data["doc_url"] = doc_url
    if models:
        data["models"] = models
    if default_model:
        data["default_model"] = default_model
    if api_key:
        data["auth"] = {"type": "bearer", "key_env": f"CUSTOM_PROVIDER_{pid}", "prefix": "Bearer "}
    pd = ProviderDefinition.model_validate(data)
    # schema 规整：唯一规则入口
    pd.params_schema = resolve_params_schema(pd.code, pd.kind, params_schema)
    pd.input_schema = input_schema if (input_schema and input_schema.get("properties")) else _default_input_schema(pd.kind)
    pd.output_schema = output_schema if (output_schema and output_schema.get("properties")) else _default_output_schema(pd.kind)
    saved = custom_provider_manager.save_definition(pd)
    if api_key:
        _save_api_key(saved.id, api_key)
        os.environ[f"CUSTOM_PROVIDER_{saved.id}"] = api_key
    from app.providers.init_providers import register_single_custom_provider
    register_single_custom_provider(saved)
    # 创建即体检（零配额）：结果回传调用方（Agent 闭环）
    cc = compile_check_code(saved.language or "python", saved.code or "", saved.code_entry or "generate")
    if not cc.get("ok"):
        print(f"[ProviderRoutes] 新建源 {saved.id} 体检未通过: {cc.get('error')}")
    return {"id": saved.id, "provider": _sanitize_for_frontend(saved), "compile_check": cc, "code": code}


def _infer_kind_from_doc(doc: str, url: str = "") -> Optional[str]:
    low = f"{doc or ''} {url or ''}".lower()
    if any(k in low for k in ["video", "minimax_h3", "lightx2v", "kling", "vidu", "hailuo", "wanx", "r2v", "i2v", "t2v", "comfyui_workflow"]):
        if "image" in low and "video" not in low:
            return "image"
        if any(v in low for v in ["video", "h3", "lightx2v", "kling"]):
            return "video"
    if any(k in low for k in ["audio", "tts", "voice", "speech", "sovits", "cosyvoice"]):
        return "audio"
    return None

def _default_input_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"画面提示词","x-handle":"text"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考图","x-handle":"image"},
        },"required":["prompt"]}
    elif kind == "video":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"运动描述","x-handle":"text"},
            "first_frame":{"type":"string","format":"uri","description":"首帧","x-handle":"image"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考集","x-handle":"image"},
        },"required":["prompt"]}
    elif kind == "audio":
        return {"type":"object","properties":{
            "text":{"type":"string","description":"合成文本","x-handle":"text"},
        },"required":["text"]}
    else:
        return {"type":"object","properties":{"prompt":{"type":"string","x-handle":"text"}},"required":["prompt"]}

def _default_output_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type":"object","properties":{"image_url":{"type":"string","format":"uri","x-handle":"image"}},"required":["image_url"]}
    elif kind == "video":
        return {"type":"object","properties":{"video_url":{"type":"string","format":"uri","x-handle":"video"}},"required":["video_url"]}
    elif kind == "audio":
        return {"type":"object","properties":{"audio_url":{"type":"string","format":"uri","x-handle":"audio"}},"required":["audio_url"]}
    else:
        return {"type":"object","properties":{"output":{"type":"string","x-handle":"text"}}}

def _default_params_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type": "object","properties": {
            "aspect_ratio": {"type": "string","title": "画面比例","enum": ["9:16","16:9","1:1"],"default": "9:16","description": "输出画面比例，下游画布/分镜自动联动"},
            "resolution": {"type": "string","title": "分辨率","enum": ["480p","720p","1080p"],"default": "720p","description": "分辨率档位，框架自动映射为宽高"},
            "steps": {"type": "integer","title": "采样步数","default": 20,"minimum": 4,"maximum": 60,"description": "采样步数 4-60"},
            "cfg": {"type": "number","title": "CFG","default": 7.0,"minimum": 1,"maximum": 15,"step": 0.5,"description": "CFG 1-15"},
        }}
    elif kind == "video":
        return {"type": "object","properties": {
            "aspect_ratio": {"type": "string","title": "画面比例","enum": ["9:16","16:9","1:1"],"default": "9:16","description": "画面比例"},
            "resolution": {"type": "string","title": "分辨率","enum": ["480p","720p","1080p"],"default": "720p","description": "视频分辨率 480p/720p/1080p"},
            "duration": {"type": "integer","title": "时长","default": 5,"minimum": 3,"maximum": 15,"description": "时长秒 3-15"},
            "fps": {"type": "integer","title": "帧率","enum": [16,24,30],"default": 24,"description": "帧率"},
        }}
    elif kind == "audio":
        return {"type": "object","properties": {
            "speed": {"type": "number","title": "语速","default": 1.0,"minimum": 0.5,"maximum": 2.0,"step": 0.1,"description": "语速 0.5-2.0"},
            "pitch": {"type": "number","title": "音调","default": 0,"minimum": -12,"maximum": 12,"step": 1,"description": "音调 -12~12"},
            "volume": {"type": "number","title": "音量","default": 1.0,"minimum": 0,"maximum": 2.0,"step": 0.1,"description": "音量 0-2"},
        }}
    else:
        return {"type": "object","properties": {}}


@router.get("/providers")
async def list_providers(kind: Optional[str] = None, scope: Optional[str] = None, include_builtin: bool = True, project_id: Optional[str] = None):
    result: List[Dict[str, Any]] = []
    if include_builtin:
        try:
            from app.providers.image.registry import image_registry
            from app.providers.audio.registry import audio_registry
            from app.providers.video.registry import video_registry
            if not image_registry.list_ids():
                from app.providers.init_providers import init_all_providers
                try:
                    init_all_providers()
                except Exception:
                    pass
            for reg, reg_kind in [(image_registry, "image"), (audio_registry, "audio"), (video_registry, "video")]:
                if kind and kind != reg_kind:
                    continue
                for pid in reg.list_ids():
                    prov = reg.get(pid)
                    if not prov:
                        continue
                    if hasattr(reg, "is_custom") and reg.is_custom(pid):
                        continue
                    info = prov.to_provider_info() if hasattr(prov, "to_provider_info") else {"id": pid}
                    info["kind"] = reg_kind
                    info["builtin"] = True
                    info["provider_type"] = "builtin"
                    info["enabled"] = True
                    result.append(info)
        except Exception as e:
            print(f"[ProviderRoutes] builtin list failed: {e}")
    try:
        customs = custom_provider_manager.list_definitions(kind=kind, scope=scope, project_id=project_id)
        for pd in customs:
            if scope and pd.scope != scope:
                continue
            result.append(_sanitize_for_frontend(pd))
    except Exception as e:
        print(f"[ProviderRoutes] custom list failed: {e}")
    order = {"image": 0, "video": 1, "audio": 2, "llm": 3}
    result.sort(key=lambda x: (order.get(x.get("kind", "image"), 99), x.get("id", "")))
    return {"providers": result, "total": len(result)}


@router.get("/providers/{provider_id}")
async def get_provider(provider_id: str):
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        from app.providers.video.registry import video_registry
        for reg in (image_registry, audio_registry, video_registry):
            prov = reg.get(provider_id)
            if prov and not (hasattr(reg, "is_custom") and reg.is_custom(provider_id)):
                info = prov.to_provider_info() if hasattr(prov, "to_provider_info") else {"id": provider_id}
                info["builtin"] = True
                return {"provider": info}
    except Exception:
        pass
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    return {"provider": _sanitize_for_frontend(pd), "raw": pd.model_dump()}


class ProviderCreateRequest(BaseModel):
    id: Optional[str] = None
    name: str
    kind: str = "image"
    provider_type: str = "code"
    description: Optional[str] = ""
    icon: Optional[str] = "Zap"
    scope: Optional[str] = "global"
    project_id: Optional[str] = None
    # 代码为唯一执行方式
    language: str = "python"  # python | javascript
    code: str = ""
    code_entry: str = "generate"
    code_timeout: int = 60
    # 可选元数据
    models: List[str] = Field(default_factory=list)
    default_model: Optional[str] = None
    params_schema: Optional[Dict[str, Any]] = None
    default_params: Dict[str, Any] = Field(default_factory=dict)
    input_schema: Optional[Dict[str, Any]] = None
    output_schema: Optional[Dict[str, Any]] = None
    doc_url: Optional[str] = None
    doc_text: Optional[str] = None
    raw_api_doc: Optional[str] = None
    enabled: bool = True
    api_key: Optional[str] = None


def _save_api_key(provider_id: str, api_key: str):
    if not api_key:
        return
    try:
        import json as _json
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        data: Dict[str, Any] = {}
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                try:
                    data = _json.load(f)
                except Exception:
                    data = {}
        if "custom_providers" not in data or not isinstance(data["custom_providers"], dict):
            data["custom_providers"] = {}
        data["custom_providers"][provider_id] = {"api_key": api_key}
        data[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
        with open(cfg_path, "w", encoding="utf-8") as f:
            _json.dump(data, f, ensure_ascii=False, indent=2)
        os.environ[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
    except Exception as e:
        print(f"[ProviderRoutes] save api_key failed: {e}")


@router.post("/providers")
async def create_provider(req: ProviderCreateRequest):
    if req.kind not in ("image", "video", "audio", "llm"):
        raise HTTPException(status_code=400, detail="kind 必须为 image/video/audio/llm")
    if req.language not in ("python", "javascript", "js"):
        raise HTTPException(status_code=400, detail="language 必须为 python/javascript")
    if not req.code or len(req.code.strip()) < 20:
        # 若未提供代码，自动用模板补齐
        tmpl = CODE_TEMPLATES.get((req.language, req.kind)) or CODE_TEMPLATES.get(("python", req.kind)) or ""
        if tmpl:
            req.code = tmpl
        else:
            raise HTTPException(status_code=400, detail="code 不能为空，请提供 python/javascript 携程源码（含 async def generate(ctx, api)）")
    # 语法预检 python
    if req.language == "python":
        try:
            import ast
            ast.parse(req.code)
        except SyntaxError as e:
            raise HTTPException(status_code=400, detail=f"Python 语法错误: {e}")
    data: Dict[str, Any] = req.model_dump(exclude={"api_key"})
    data["language"] = "javascript" if req.language == "js" else req.language
    data["provider_type"] = "code"
    data["legacy_json_mode"] = False
    if not data.get("id"):
        import uuid
        data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
    else:
        if data["id"] in ("comfyui", "siliconflow", "dashscope", "openai_compat", "minimax", "elevenlabs", "cosyvoice", "gpt_sovits", "comfyui_video", "minimax_video"):
            raise HTTPException(status_code=400, detail=f"id {data['id']} 与内置冲突")
    if custom_provider_manager.get_definition(data["id"]):
        raise HTTPException(status_code=409, detail=f"Provider 已存在: {data['id']}")
    if req.api_key:
        data.setdefault("auth", {})  # 保持兼容，实际走 env
        # auth 兼容字段
        data["auth"] = {"type": "bearer" if req.api_key else "none", "key_env": f"CUSTOM_PROVIDER_{data['id']}", "prefix": "Bearer "}
    else:
        data["auth"] = {"type": "none", "key_env": None, "prefix": "Bearer "}
    try:
        pd = ProviderDefinition.model_validate(data)
        if not pd.params_schema or not pd.params_schema.get("properties"):
            pd.params_schema = _default_params_schema(pd.kind)
        if not pd.input_schema or not pd.input_schema.get("properties"):
            pd.input_schema = _default_input_schema(pd.kind)
        if not pd.output_schema or not pd.output_schema.get("properties"):
            pd.output_schema = _default_output_schema(pd.kind)
        # 规范化 code_entry
        if not pd.code_entry:
            pd.code_entry = "generate"
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校验失败: {e}")
    try:
        saved = custom_provider_manager.save_definition(pd)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    if req.api_key:
        _save_api_key(saved.id, req.api_key)
    try:
        from app.providers.init_providers import register_single_custom_provider
        register_single_custom_provider(saved)
    except Exception as e:
        print(f"[ProviderRoutes] hot register failed: {e}")
    return {"status": "success", "provider": _sanitize_for_frontend(saved)}


@router.put("/providers/{provider_id}")
async def update_provider(provider_id: str, body: Dict[str, Any] = Body(...)):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if pd.builtin:
        raise HTTPException(status_code=403, detail="内置 Provider 不可编辑")
    api_key = body.pop("api_key", None)
    if api_key is not None:
        if api_key == "":
            try:
                import json as _json
                cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
                if os.path.exists(cfg_path):
                    with open(cfg_path, "r", encoding="utf-8") as f:
                        data = _json.load(f)
                    if "custom_providers" in data and provider_id in data["custom_providers"]:
                        data["custom_providers"].pop(provider_id, None)
                    data.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
                    with open(cfg_path, "w", encoding="utf-8") as f:
                        _json.dump(data, f, ensure_ascii=False, indent=2)
                    os.environ.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
            except Exception as e:
                print(f"[ProviderRoutes] clear api_key failed: {e}")
        else:
            _save_api_key(provider_id, api_key)
            body.setdefault("auth", {})["key_env"] = f"CUSTOM_PROVIDER_{provider_id}"
    # 语法预检
    if "code" in body and body["code"] and (body.get("language") or pd.language) == "python":
        try:
            import ast
            ast.parse(body["code"])
        except SyntaxError as e:
            raise HTTPException(status_code=400, detail=f"Python 语法错误: {e}")
    current = pd.model_dump()
    # 深度合并
    for k, v in body.items():
        if k in ("transport", "auth", "mapping", "health_check", "default_params") and isinstance(v, dict):
            current[k] = {**(current.get(k) or {}), **v}
        else:
            current[k] = v
    # 若更新了 code，强制标记非 legacy
    if "code" in body:
        current["legacy_json_mode"] = False
        current["provider_type"] = "code"
    try:
        updated = ProviderDefinition.model_validate(current)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校验失败: {e}")
    try:
        saved = custom_provider_manager.save_definition(updated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    try:
        from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
        unregister_single_custom_provider(provider_id, kind=pd.kind)
        register_single_custom_provider(saved)
    except Exception as e:
        print(f"[ProviderRoutes] hot reload failed: {e}")
    return {"status": "success", "provider": _sanitize_for_frontend(saved)}


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if pd.builtin:
        raise HTTPException(status_code=403, detail="内置 Provider 不可删除")
    kind = pd.kind
    try:
        custom_provider_manager.delete_definition(provider_id)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    try:
        import json as _json
        cfg_path = os.path.join(settings.STORAGE_DIR, "config_store.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = _json.load(f)
            if "custom_providers" in data and provider_id in data["custom_providers"]:
                data["custom_providers"].pop(provider_id, None)
            data.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
            with open(cfg_path, "w", encoding="utf-8") as f:
                _json.dump(data, f, ensure_ascii=False, indent=2)
            os.environ.pop(f"CUSTOM_PROVIDER_{provider_id}", None)
    except Exception:
        pass
    try:
        from app.providers.init_providers import unregister_single_custom_provider
        unregister_single_custom_provider(provider_id, kind=kind)
    except Exception as e:
        print(f"[ProviderRoutes] unregister failed: {e}")
    return {"status": "deleted", "provider_id": provider_id}


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: str, body: Optional[Dict[str, Any]] = Body(None)):
    pd = custom_provider_manager.get_definition(provider_id)
    prov = None
    kind = None
    compile_check = None
    if pd:
        kind = pd.kind
        try:
            from app.providers.generic.code_provider import GenericCodeImageProvider, GenericCodeAudioProvider, GenericCodeVideoProvider
            if kind == "image":
                prov = GenericCodeImageProvider(pd)
            elif kind == "audio":
                prov = GenericCodeAudioProvider(pd)
            elif kind == "video":
                prov = GenericCodeVideoProvider(pd)
            else:
                prov = GenericCodeImageProvider(pd)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"创建 Provider 实例失败: {e}")
        # 免费深度体检先行：沙箱编译+入口定位（零配额），坏代码快速失败并给出确切原因
        if pd.code:
            from app.providers.generic.code_provider import compile_check_code
            cc = compile_check_code(pd.language or "python", pd.code, pd.code_entry or "generate")
            compile_check = cc
            if not cc.get("ok"):
                return {"provider_id": provider_id, "ok": False, "is_configured": True, "kind": kind,
                        "detail": f"代码体检未通过: {cc.get('error')}", "compile_check": cc}
        # 兼容：若仍是 legacy JSON 且无 code，尝试用 http_provider
        if not pd.code and pd.legacy_json_mode:
            try:
                from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
                if kind == "image":
                    prov = GenericHttpImageProvider(pd)
                elif kind == "audio":
                    prov = GenericHttpAudioProvider(pd)
                elif kind == "video":
                    prov = GenericHttpVideoProvider(pd)
            except Exception:
                pass
    else:
        try:
            from app.providers.image.registry import image_registry
            from app.providers.audio.registry import audio_registry
            from app.providers.video.registry import video_registry
            for reg in (image_registry, audio_registry, video_registry):
                p = reg.get(provider_id)
                if p:
                    prov = p
                    break
        except Exception:
            pass
        if not prov:
            raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    try:
        ok = await prov.check_health()
        is_configured = prov.is_configured() if hasattr(prov, "is_configured") else True
        resp = {"provider_id": provider_id, "ok": ok, "is_configured": is_configured, "kind": kind or getattr(prov, "kind", "unknown"), "detail": "连通正常" if ok else "检测未通过（检查代码/ Key/地址）"}
        if compile_check is not None:
            resp["compile_check"] = compile_check
        return resp
    except Exception as e:
        return {"provider_id": provider_id, "ok": False, "detail": f"检测异常: {e}"}


class ProviderImportRequest(BaseModel):
    kind: str = "image"
    name: Optional[str] = None
    doc_text: Optional[str] = None
    doc_url: Optional[str] = None
    curl: Optional[str] = None
    openapi_url: Optional[str] = None
    api_key: Optional[str] = None
    language: Optional[str] = "python"  # python | javascript
    definition: Optional[Dict[str, Any]] = None


@router.post("/providers/import")
async def import_provider_from_doc(req: ProviderImportRequest):
    """从文档/cURL/OpenAPI 通过 LLM 生成代码 Provider（导演自动调用）"""
    if req.definition:
        try:
            data = req.definition
            if not data.get("id"):
                import uuid
                data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
            data["kind"] = req.kind or data.get("kind", "image")
            if req.name:
                data["name"] = req.name
            # 若 definition 含 transport 但无 code，尝试迁移为代码（兼容旧 JSON）
            if not data.get("code") and data.get("transport", {}).get("url"):
                # 生成极简代码包裹旧模板（过渡）
                url = data["transport"]["url"]
                data["language"] = req.language or "python"
                data["code"] = CODE_TEMPLATES.get((data["language"], data["kind"]), PY_IMAGE_TEMPLATE).replace("https://api.example.com/v1/images/generations", url)
            pd = ProviderDefinition.model_validate(data)
            if not pd.params_schema or not pd.params_schema.get("properties"):
                pd.params_schema = _default_params_schema(pd.kind)
            if not pd.input_schema or not pd.input_schema.get("properties"):
                pd.input_schema = _default_input_schema(pd.kind)
            if not pd.output_schema or not pd.output_schema.get("properties"):
                pd.output_schema = _default_output_schema(pd.kind)
            saved = custom_provider_manager.save_definition(pd)
            if req.api_key:
                _save_api_key(saved.id, req.api_key)
                saved.auth.key_env = f"CUSTOM_PROVIDER_{saved.id}"
                custom_provider_manager.save_definition(saved)
            from app.providers.init_providers import register_single_custom_provider
            register_single_custom_provider(saved)
            return {"status": "success", "provider": _sanitize_for_frontend(saved), "mode": "direct_definition"}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"definition 导入失败: {e}")

    doc_content = req.doc_text or ""
    if req.curl:
        doc_content += f"\n\nCURL:\n{req.curl}"
    if req.doc_url and not doc_content:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(req.doc_url, timeout=10.0)
                if r.status_code == 200:
                    doc_content = r.text[:8000]
                    if len(r.text) > 8000:
                        doc_content += "\n...(truncated)"
                else:
                    doc_content = f"doc_url: {req.doc_url} (fetch HTTP {r.status_code})"
        except Exception as e:
            doc_content = f"doc_url: {req.doc_url} (fetch failed: {e})"
    if req.openapi_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(req.openapi_url, timeout=10.0)
                if r.status_code == 200:
                    doc_content += f"\n\nOpenAPI:\n{r.text[:8000]}"
        except Exception as e:
            doc_content += f"\nOpenAPI fetch failed: {e}"
    if not doc_content or len(doc_content.strip()) < 10:
        raise HTTPException(status_code=400, detail="请提供 doc_text / doc_url / curl / openapi_url 或 definition")
    # LLM 生成代码
    try:
        from app.pipelines.llm_service import llm_service
        lang = (req.language or "python").lower()
        if lang == "js": lang = "javascript"
        tmpl = CODE_TEMPLATES.get((lang, req.kind)) or CODE_TEMPLATES.get(("python", req.kind)) or ""
        system_prompt = code_gen_system_prompt(req.kind, lang, tmpl)
        user_prompt = f"kind: {req.kind}\nlanguage: {lang}\nname_hint: {req.name or ''}\n\nAPI 文档:\n{doc_content[:6000]}"
        code_text = await llm_service.chat_completion(
            messages=[{"role":"system","content":system_prompt},{"role":"user","content":user_prompt}],
            temperature=0.2
        )
        if len((code_text or "").strip()) < 50:
            raise ValueError("LLM 生成代码过短")
        inferred = _infer_kind_from_doc(doc_content, "")
        final_kind = req.kind
        if inferred and inferred != req.kind and req.kind in (None, "", "image") and inferred == "video":
            final_kind = inferred
        # 统一创建入口：schema 规整/超时策略/保存注册/Key 落盘/沙箱体检 一条龙
        created = create_code_source(
            name=req.name or f"自定义{final_kind}源",
            kind=final_kind,
            code=code_text,
            language=lang,
            description=f"由导演从文档自动生成（{lang}）",
            api_key=req.api_key,
            doc_text=doc_content,
            doc_url=req.doc_url or "",
        )
        return {"status": "success" if created["compile_check"].get("ok") else "compile_failed",
                "provider": created["provider"], "mode": "llm_code", "code": created["code"],
                "compile_check": created["compile_check"],
                **({"hint": "生成的代码未通过沙箱编译体检，请根据 compile_check.error 修正后重试"} if not created["compile_check"].get("ok") else {})}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM 生成代码失败: {e}")


@router.post("/providers/{provider_id}/api-key")
async def set_provider_api_key(provider_id: str, body: Dict[str, Any] = Body(...)):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    api_key = body.get("api_key", "")
    if not api_key or not str(api_key).strip():
        raise HTTPException(status_code=400, detail="api_key 不能为空")
    _save_api_key(provider_id, str(api_key).strip())
    if not pd.auth.key_env:
        pd.auth.key_env = f"CUSTOM_PROVIDER_{provider_id}"
        custom_provider_manager.save_definition(pd)
    return {"status": "success", "provider_id": provider_id, "has_key": True}


@router.get("/providers/custom/stats")
async def custom_provider_stats():
    customs = custom_provider_manager.list_definitions()
    by_kind: Dict[str, int] = {}
    by_lang: Dict[str, int] = {}
    for pd in customs:
        by_kind[pd.kind] = by_kind.get(pd.kind, 0) + 1
        by_lang[pd.language] = by_lang.get(pd.language, 0) + 1
    return {"total": len(customs), "by_kind": by_kind, "by_lang": by_lang}


@router.get("/providers/code/templates")
async def list_code_templates(language: Optional[str] = None, kind: Optional[str] = None):
    """获取代码模板（供前端新建时填充）"""
    if language and kind:
        key = (language, kind)
        tmpl = CODE_TEMPLATES.get(key)
        if tmpl:
            return {"template": tmpl, "language": language, "kind": kind}
        raise HTTPException(status_code=404, detail="模板不存在")
    # 返回全部
    result = []
    for (lang, k), tmpl in CODE_TEMPLATES.items():
        result.append({"language": lang, "kind": k, "code": tmpl})
    return {"templates": result}


@router.post("/providers/{provider_id}/upgrade-to-code")
async def upgrade_legacy_to_code(provider_id: str, body: Optional[Dict[str, Any]] = Body(None)):
    """将存量 JSON 模板一键升级为代码（自动迁移）"""
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if pd.code and not pd.legacy_json_mode:
        return {"status": "already_code", "provider": _sanitize_for_frontend(pd)}
    # 根据旧 transport/mapping 生成代码
    lang = (body or {}).get("language") or "python"
    url = pd.transport.url or "https://api.example.com/v1/generate"
    # 用模板+旧参数缝合
    base_tmpl = CODE_TEMPLATES.get((lang, pd.kind)) or CODE_TEMPLATES.get(("python", pd.kind)) or ""
    migrated_code = base_tmpl.replace("https://api.example.com/v1/images/generations", url).replace("https://api.example.com/v1/videos/generations", url).replace("https://api.example.com/v1/audio/speech", url)
    pd.language = lang
    pd.code = migrated_code
    pd.code_entry = "generate"
    pd.legacy_json_mode = False
    pd.provider_type = "code"
    saved = custom_provider_manager.save_definition(pd)
    from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
    unregister_single_custom_provider(provider_id, kind=pd.kind)
    register_single_custom_provider(saved)
    return {"status": "upgraded", "provider": _sanitize_for_frontend(saved)}
