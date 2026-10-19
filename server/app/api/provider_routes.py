"""
Provider 管理路由 - 代码生成源唯一模式（彻底去 JSON）
支持 python / javascript 携程源码动态注册、编辑、升级、测试
"""
import os
import json
import re
import time
import uuid
import asyncio
import logging
import httpx
from typing import Optional, Dict, Any, List, Callable
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field

from app.models.provider_definition import ProviderDefinition
from app.providers.custom.manager import custom_provider_manager
from app.providers import verification
from app.core.config import settings

logger = logging.getLogger(__name__)
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
        **(ctx.get("headers") or {}),
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
    async with httpx.AsyncClient(timeout=1200) as client:
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
        **(ctx.get("headers") or {}),
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
    async with httpx.AsyncClient(timeout=1200) as client:
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
        # 轮询（20分钟窗口）
        poll_url = f"https://api.example.com/v1/videos/status/{task_id}"
        for _ in range(400):
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
        **(ctx.get("headers") or {}),
    }
    payload = {
        "text": ctx["text"],
        "voice_id": ctx.get("voice_id", "default"),
        "emotion": ctx.get("emotion", "neutral"),
        "speed": ctx.get("speed", 1.0),
        "model": ctx.get("model") or "default",
    }
    url = "https://api.example.com/v1/audio/speech"  # TODO
    async with httpx.AsyncClient(timeout=1200) as client:
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
  // ctx: {prompt, width, height, size, aspect_ratio, resolution, steps, cfg, model, api_key, reference_images, headers}
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
    ...(ctx.headers || {}),
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
  // ctx: {prompt, duration, resolution, aspect_ratio, fps, mode, first_frame_url, reference_images, headers}
  const headers = {
    "Authorization": `Bearer ${ctx.api_key}`,
    "Content-Type": "application/json",
    ...(ctx.headers || {}),
  };
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
  for(let i=0;i<400;i++){
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
    # 存量自定义源缺 schema 时在读取路径兜底，但代码型不硬套通用模板以免与真实 API mismatch
    try:
        if pd.provider_type == "code":
            # 代码型：显式 > 代码尾注释 > 保持已存（不回落通用模板）
            explicit = info.get("params_schema")
            if explicit and isinstance(explicit, dict) and explicit.get("properties"):
                info["params_schema"] = _enrich_params_schema(explicit, pd.kind)
            else:
                extracted = _extract_params_schema_from_code(pd.code or "")
                if extracted:
                    info["params_schema"] = _enrich_params_schema(extracted, pd.kind)
                else:
                    # 无显式也无注释：保持空，避免通用 480p/720p 误套到 480p竖等真实接口
                    # 若存储本身已有通用残留（历史错误），则保留但前端会通过一键修正按钮提示
                    if not info.get("params_schema") or not isinstance(info.get("params_schema"), dict) or not info["params_schema"].get("properties"):
                        # 保持 None，让前端显示“无额外参数”而非错误参数
                        info["params_schema"] = info.get("params_schema")  # keep as is
                    else:
                        info["params_schema"] = _enrich_params_schema(info["params_schema"], pd.kind)
        else:
            info["params_schema"] = resolve_params_schema(pd.code, pd.kind, info.get("params_schema"))
        if not info.get("input_schema") or not info["input_schema"].get("properties"):
            info["input_schema"] = _default_input_schema(pd.kind)
        else:
            info["input_schema"] = _enrich_input_schema(info["input_schema"], pd.kind)
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


def _enrich_params_schema(schema: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """
    为 params_schema 补全 x-* 扩展（向下兼容存量无 x-* 的源）。
    缺省规则： layout→auto/basic  quality→suggest/advanced  audio→auto/basic  其余→suggest/advanced
    """
    if not schema or not isinstance(schema.get("properties"), dict):
        return schema
    # 按 kind 的默认 x-* 映射表
    defaults_map = {
        "aspect_ratio": {"x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
        "resolution":   {"x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
        "duration":     {"x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
        "fps":          {"x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 31},
        "steps":        {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 40},
        "cfg":          {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
        "seed":         {"x-category": "quality", "x-visibility": "advanced", "x-agent": "manual", "x-priority": 99},
        "negative_prompt": {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 42},
        "speed":        {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
        "pitch":        {"x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 20},
        "volume":       {"x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 21},
        "voice_id":     {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 5, "x-role": "voice"},
        "emotion":      {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 6, "x-role": "emotion"},
    }
    for key, prop in schema["properties"].items():
        if not isinstance(prop, dict):
            continue
        dm = defaults_map.get(key, {})
        # 模糊匹配：workflow 暴露键如 "49_aspect_ratio" 应命中 aspect_ratio
        if not dm:
            lk = key.lower()
            for k2, v2 in defaults_map.items():
                if k2 in lk:
                    dm = v2
                    break
        # 若已显式声明则保留，否则补默认值
        for xk, xv in dm.items():
            if xk not in prop:
                prop[xk] = xv
        # 兜底：未命中映射表的自定义参数
        if "x-category" not in prop:
            prop["x-category"] = "advanced"
        if "x-visibility" not in prop:
            prop["x-visibility"] = "advanced"
        if "x-agent" not in prop:
            prop["x-agent"] = "suggest"
        if "x-priority" not in prop:
            prop["x-priority"] = 50
    return schema


def resolve_params_schema(code: str, kind: str, explicit: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    params_schema 单点解析（全系统唯一规则）：
    显式声明 > 代码内 PARAMS_SCHEMA 注释 > kind 通用默认。
    创建/升级/导入/MCP/读取兜底 一律走这里，杜绝多处规则不一致。
    返回值已自动补全 x-*，保证前端分组与人机分工一致。
    """
    base: Optional[Dict[str, Any]] = None
    if explicit and explicit.get("properties"):
        base = explicit
    else:
        extracted = _extract_params_schema_from_code(code or "")
        if extracted:
            base = extracted
        else:
            base = _default_params_schema(kind)
    return _enrich_params_schema(base, kind)


def code_gen_system_prompt(kind: str, language: str, tmpl: str = "") -> str:
    """LLM 生成源代码的单一提示词源（MCP register_custom_provider 与 /providers/import 共用）。"""
    lang_label = "javascript" if language in ("javascript", "js", "node") else "python"
    return f"""你是生成源代码专家。用户提供了 {kind} 类 API 文档（{lang_label}），请直接生成可执行的携程源码。
要求：
- 输出 {lang_label} 代码，入口为 async def generate(ctx, api)（python）或 async function generate(ctx, api)（javascript）
- ctx 含 prompt/width/height/size/seed/model/style_preset/api_key/reference_images/first_frame_url/duration/resolution/aspect_ratio/fps/text/voice_id/emotion 等，api 含 httpx/asyncio/json/re/time/uuid/download(api.download(url,prefix)->(storage_url,local_path))；python 沙箱可 import 第三方库（aiohttp/requests/httpx）与 raise 异常
- 防御式解析（必须）：响应一律用 .get() 链取值；业务码非成功、data 缺失或为 null 时，必须 raise RuntimeError 并把服务端 code/msg/原始响应前300字符带出来，严禁对可能为 None 的值做 [] 下标取值
- 列表结果元素可能是对象（取其中的 url 字段）也可能是字符串，两种都兼容
- 必须包含完整请求、鉴权、payload、超时与错误处理；同步返回直接给 {{"image_url": url}} / {{"video_url": url}} / {{"audio_url": url}}
- **异步任务制 API（提交返 task_id/job_id，另有独立结果查询接口）必须实现"提交/查询"双分支**：框架 TaskCenter 会用「空 prompt + task_id」反复调用你的代码推进任务，缺查询分支任务必然超时：
  1) 提交分支（ctx 无 task_id）：POST 提交后**立即返回**，禁止在代码内 while/sleep 长轮询：{{"video_url": None, "task_id": <id>, "status": "SUBMITTED"}}（image 用 "image_url": None、audio 用 "audio_url": None）
  2) 查询分支（ctx 有 task_id 且 prompt 为空）：GET 结果接口查询；完成返回 {{"video_url": url}}（image→image_url、audio→audio_url）；未完成返回 {{"video_url": None, "task_id": <同一个id>, "status": "RUNNING"}}；失败 raise RuntimeError 或返回 status "FAILED"
  3) task_id 必须双路取：task_id = (ctx.get("task_id") or (ctx.get("dynamic_inputs") or {{}}).get("task_id") or "").strip()
  4) 查询分支必须返回**与传入相同**的 task_id；返回新 task_id 会被框架判定为"缺少查询分支"并直接失败
- 视频类即便同步 API 也不得在代码内阻塞超过 600s；长任务一律走上述双分支
- 可信源（trusted=True且全局STUDIO_TRUSTED_MODE=1）可用任意库与系统调用（os/subprocess/curl/ffmpeg/文件读写），普通沙箱仅可用httpx/aiohttp且禁os系导入
- 若该 API 有自己的参数枚举（分辨率档位/比例/时长档等），必须在代码最后一行追加单行注释（一行合法 JSON），并按标准标注分组与人机分工：
  # PARAMS_SCHEMA: {{"type":"object","properties":{{"resolution":{{"type":"string","title":"分辨率","enum":["...真实枚举..."],"default":"...","description":"...","x-category":"layout","x-visibility":"basic","x-agent":"auto","x-priority":20}}}}}}
  可用 x-category: layout/motion/quality/audio/advanced； x-visibility: basic/advanced/hidden； x-agent: auto(可代填)/suggest(建议)/manual(仅手填)； x-priority 越小越靠前。没有自定义枚举则省略此行
- 仅输出代码，不要 markdown、不要解释
模板参考：
{tmpl[:2000]}
"""


def _strip_code_fences(text: str) -> str:
    """去掉 markdown 代码围栏，返回纯代码。"""
    t = (text or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\s*\n", "", t)
    t = re.sub(r"\n```\s*$", "", t.strip())
    return t.strip()


async def llm_generate_code(kind: str, language: str, doc_text: str, name_hint: str = "",
                            on_stage: Optional[Callable[[str], None]] = None) -> str:
    """LLM 生成生成源代码的单点入口（MCP register 文档分支 / /providers/import / Creator 草稿共用）。

    优先走 Agent 适配器（流式 + 重试，兼容推理模型）：推理模型会把 max_tokens 烧在思考上，
    因此逐级放大预算（16384→32768）；输出为空且因长度截断时自动重试。失败再回落 llm_service。
    on_stage: 阶段进度回调（人话文案，供导入任务 / Agent tool_progress 透出）。
    """
    def _stage(msg: str) -> None:
        if on_stage:
            try:
                on_stage(msg)
            except Exception:
                pass

    lang = "javascript" if language in ("javascript", "js", "node") else "python"
    tmpl = CODE_TEMPLATES.get((lang, kind)) or CODE_TEMPLATES.get(("python", kind)) or ""
    system_prompt = code_gen_system_prompt(kind, lang, tmpl)
    user_prompt = f"kind: {kind}\nlanguage: {lang}\n" + (f"name_hint: {name_hint}\n" if name_hint else "") + f"\nAPI 文档:\n{(doc_text or '')[:6000]}"
    messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]
    last_err: Optional[Exception] = None
    # 1) Agent 适配器（与导演 Agent 同一运输层）
    try:
        from app.agent.llm.adapter import adapter
        for attempt, mt in enumerate((16384, 32768), start=1):
            _stage(f"正在调用 LLM 生成源代码（第 {attempt} 次）…")
            try:
                reply = await adapter.complete(messages, temperature=0.2, max_tokens=mt, timeout=600)
            except Exception as e:
                last_err = e
                _stage(f"LLM 调用异常：{str(e)[:120]}")
                break
            text = _strip_code_fences(reply.content or "")
            if len(text) >= 20:
                _stage("代码生成完成")
                return text
            last_err = RuntimeError(f"模型输出为空（finish={reply.finish_reason}，思考可能占满 max_tokens={mt}）")
            if reply.finish_reason != "length":
                break
            _stage("输出被截断，扩大输出重试…")
    except Exception as e:
        last_err = e
    # 2) llm_service 回落（老网关）
    _stage("正在用备用通道生成代码…")
    try:
        from app.pipelines.llm_service import llm_service
        text = _strip_code_fences(str(await llm_service.chat_completion(messages=messages, temperature=0.2) or ""))
        if len(text) >= 20:
            _stage("代码生成完成（备用通道）")
            return text
    except Exception as e:
        last_err = e
    logger.error("LLM 代码生成失败 kind=%s lang=%s: %s", kind, lang, str(last_err)[:300])
    raise RuntimeError(f"LLM 代码生成失败: {str(last_err)[:300]}")


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
    trusted: bool = False,
    headers: Optional[Dict[str, str]] = None,
    custom_headers: Optional[Dict[str, str]] = None,
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
        "code_timeout": max(1200, code_timeout or (600 if kind == "video" else 120)),
        "trusted": bool(trusted),
        "description": description or "动态代码生成源", "icon": icon,
        "scope": scope or "global", "enabled": True,
        "doc_text": (doc_text or "")[:4000], "raw_api_doc": (doc_text or "")[:4000],
    }
    hdrs = headers if headers is not None else custom_headers
    if hdrs:
        data["headers"] = hdrs
    if doc_url:
        data["doc_url"] = doc_url
    if models:
        data["models"] = models
    if default_model:
        data["default_model"] = default_model
    if api_key:
        data["auth"] = {"type": "bearer", "key_env": f"CUSTOM_PROVIDER_{pid}", "prefix": "Bearer "}
    pd = ProviderDefinition.model_validate(data)
    # schema 规整：代码型不套通用模板，优先用显式或代码尾 PARAMS_SCHEMA，否则保持空由一键修正或 LLM 填充
    if params_schema and params_schema.get("properties"):
        pd.params_schema = _enrich_params_schema(params_schema, kind)
    else:
        extracted = _extract_params_schema_from_code(pd.code or "")
        if extracted:
            pd.params_schema = _enrich_params_schema(extracted, kind)
        elif kind == "video":
            # 代码型 video 不硬套固定模板，避免与真实 API（如 4/6 分辨率、是否支持 fps/aspect_ratio）不一致
            # 保持为 None，前端显示“无额外参数”并提示一键修正；LLM 创建时会通过注释带真实枚举
            pd.params_schema = None
        else:
            # image/audio 仍用通用
            _def = _default_params_schema(kind)
            pd.params_schema = _enrich_params_schema(_def, kind)
    pd.input_schema = input_schema if (input_schema and input_schema.get("properties")) else _default_input_schema(pd.kind)
    pd.output_schema = output_schema if (output_schema and output_schema.get("properties")) else _default_output_schema(pd.kind)
    saved = custom_provider_manager.save_definition(pd)
    if api_key:
        _save_api_key(saved.id, api_key)
        os.environ[f"CUSTOM_PROVIDER_{saved.id}"] = api_key
    from app.providers.init_providers import register_single_custom_provider
    register_single_custom_provider(saved)
    # 创建即体检（零配额）：结果回传调用方（Agent 闭环），可信源按可信环境体检
    cc = compile_check_code(saved.language or "python", saved.code or "", saved.code_entry or "generate", trusted=bool(getattr(saved, "trusted", False)))
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

def _enrich_input_schema(schema: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """
    input_schema 单点补全：为媒体属性补 x-handle/x-slot、为文本属性补 x-role。
    原则：只做声明补全（缺省时按 type/format 推断），不改已声明值——前端插槽/句柄完全按此映射，不再猜属性名。
    """
    if not schema or not isinstance(schema.get("properties"), dict):
        return schema
    for key, prop in schema["properties"].items():
        if not isinstance(prop, dict):
            continue
        lk = str(key).lower()
        fmt = prop.get("format") or (prop.get("items", {}) or {}).get("format", "")
        if "x-handle" not in prop:
            if fmt == "uri":
                if "audio" in lk:
                    prop["x-handle"] = "audio"
                elif "video" in lk:
                    prop["x-handle"] = "video"
                else:
                    prop["x-handle"] = "image"
            elif prop.get("type") == "string":
                prop["x-handle"] = "text"
        if prop.get("x-handle") in ("image", "audio", "video") and "x-slot" not in prop:
            prop["x-slot"] = key
        if prop.get("x-handle") == "text" and "x-role" not in prop:
            if "negative" in lk:
                prop["x-role"] = "prompt_aux"
            elif lk in ("text", "dialogue", "voiceover"):
                prop["x-role"] = "dialogue"
            else:
                prop["x-role"] = "prompt"
    return schema


def _default_input_schema(kind: str) -> Dict[str, Any]:
    if kind == "image":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"画面提示词","x-handle":"text","x-role":"prompt"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考图","x-handle":"image","x-slot":"reference_images","maxItems":4,"minItems":0},
        },"required":["prompt"]}
    elif kind == "video":
        return {"type":"object","properties":{
            "prompt":{"type":"string","description":"运动描述","x-handle":"text","x-role":"prompt"},
            "first_frame":{"type":"string","format":"uri","description":"首帧（定格开头画面）","x-handle":"image","x-slot":"first_frame"},
            "reference_images":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考集，最多9张","x-handle":"image","x-slot":"reference_images","maxItems":9,"minItems":0},
            "reference_audios":{"type":"array","items":{"type":"string","format":"uri"},"description":"参考音频，最多3条","x-handle":"audio","x-slot":"ref_audio","maxItems":3,"minItems":0},
        },"required":["prompt"]}
    elif kind == "audio":
        return {"type":"object","properties":{
            "text":{"type":"string","description":"合成文本","x-handle":"text","x-role":"dialogue"},
            "reference_audio":{"type":"string","format":"uri","description":"参考音频","x-handle":"audio","x-slot":"ref_audio"},
        },"required":["text"]}
    else:
        return {"type":"object","properties":{"prompt":{"type":"string","x-handle":"text","x-role":"prompt"}},"required":["prompt"]}

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
            "aspect_ratio": {"type": "string","title": "画面比例","enum": ["9:16","16:9","1:1"],"default": "9:16","description": "输出画面比例，下游画布/分镜自动联动", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
            "resolution": {"type": "string","title": "分辨率","enum": ["480p","720p","1080p"],"default": "720p","description": "分辨率档位，框架自动映射为宽高", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
            "steps": {"type": "integer","title": "采样步数","default": 20,"minimum": 4,"maximum": 60,"description": "采样步数 4-60", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 40},
            "cfg": {"type": "number","title": "CFG","default": 7.0,"minimum": 1,"maximum": 15,"step": 0.5,"description": "CFG 1-15", "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
        }}
    elif kind == "video":
        return {"type": "object","properties": {
            "aspect_ratio": {"type": "string","title": "画面比例","enum": ["9:16","16:9","1:1"],"default": "9:16","description": "画面比例", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
            "resolution": {"type": "string","title": "分辨率","enum": ["480p","720p","1080p"],"default": "720p","description": "视频分辨率 480p/720p/1080p", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
            "duration": {"type": "integer","title": "时长","default": 5,"minimum": 3,"maximum": 15,"description": "时长秒 3-15", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
            "fps": {"type": "integer","title": "帧率","enum": [16,24,30],"default": 24,"description": "帧率", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 31},
        }}
    elif kind == "audio":
        return {"type": "object","properties": {
            "voice_id": {"type": "string","title": "音色","description": "音色ID", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 5},
            "emotion": {"type": "string","title": "情绪","enum": ["neutral","happy","sad","angry","whisper","excited"],"default": "neutral","description": "情感", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 6},
            "speed": {"type": "number","title": "语速","default": 1.0,"minimum": 0.5,"maximum": 2.0,"step": 0.1,"description": "语速 0.5-2.0", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
            "pitch": {"type": "number","title": "音调","default": 0,"minimum": -12,"maximum": 12,"step": 1,"description": "音调 -12~12", "x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 20},
            "volume": {"type": "number","title": "音量","default": 1.0,"minimum": 0,"maximum": 2.0,"step": 0.1,"description": "音量 0-2", "x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 21},
        }}
    else:
        return {"type": "object","properties": {}}


@router.get("/providers")
async def list_providers(kind: Optional[str] = None, scope: Optional[str] = None, include_builtin: bool = True, project_id: Optional[str] = None, production_only: bool = False):
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
                    # 内置源也支持「软停用」（扩展覆盖层）：状态如实回给前端，停用后不再进生产下拉
                    try:
                        from app.extensions.guard import is_enabled as _ext_is_enabled
                        _enabled = _ext_is_enabled("provider", pid)
                    except Exception:
                        _enabled = True
                    info["enabled"] = _enabled
                    # 生产可用口径：内置源 = 已配置（填了 Key）且未停用即上架，不再强制测试；
                    # 未配置 Key 的内置源不显示（配置端始终可见）。
                    info["verified"] = verification.is_verified(pid)
                    info["production_ready"] = bool(info.get("is_configured", True)) and _enabled
                    # 内置源也补 x-*，保证画布/分镜分组与人机徽标一致
                    try:
                        raw_ps = info.get("params_schema")
                        if raw_ps and raw_ps.get("properties"):
                            info["params_schema"] = _enrich_params_schema(raw_ps, reg_kind)
                        else:
                            info["params_schema"] = _default_params_schema(reg_kind)
                        # input_schema 兜底 + 声明补全（x-slot/x-role 单点，供前端纯接口映射）
                        if not info.get("input_schema") or not info["input_schema"].get("properties"):
                            info["input_schema"] = _default_input_schema(reg_kind)
                        else:
                            info["input_schema"] = _enrich_input_schema(info["input_schema"], reg_kind)
                    except Exception:
                        pass
                    result.append(info)
        except Exception as e:
            print(f"[ProviderRoutes] builtin list failed: {e}")
    try:
        customs = custom_provider_manager.list_definitions(kind=kind, scope=scope, project_id=project_id)
        for pd in customs:
            if scope and pd.scope != scope:
                continue
            info = _sanitize_for_frontend(pd)
            info["verified"] = verification.is_verified(pd.id)
            # 自定义源：启用即上架（不再以“测试联通”作为显示门槛）
            info["production_ready"] = bool(getattr(pd, "enabled", True))
            result.append(info)
    except Exception as e:
        print(f"[ProviderRoutes] custom list failed: {e}")
    if production_only:
        result = [p for p in result if p.get("production_ready")]
    order = {"image": 0, "video": 1, "audio": 2, "llm": 3}
    result.sort(key=lambda x: (order.get(x.get("kind", "image"), 99), x.get("id", "")))
    return {"providers": result, "total": len(result)}


@router.get("/providers/{provider_id}")
async def get_provider(provider_id: str):
    try:
        from app.providers.image.registry import image_registry
        from app.providers.audio.registry import audio_registry
        from app.providers.video.registry import video_registry
        for reg, reg_kind in [(image_registry, "image"), (video_registry, "video"), (audio_registry, "audio")]:
            prov = reg.get(provider_id)
            if prov and not (hasattr(reg, "is_custom") and reg.is_custom(provider_id)):
                info = prov.to_provider_info() if hasattr(prov, "to_provider_info") else {"id": provider_id}
                info["kind"] = reg_kind
                info["builtin"] = True
                info["provider_type"] = "builtin"
                # 与列表口径一致：schema 单点补全，前端只按接口映射
                try:
                    raw_ps = info.get("params_schema")
                    info["params_schema"] = _enrich_params_schema(raw_ps, reg_kind) if (raw_ps and raw_ps.get("properties")) else _default_params_schema(reg_kind)
                    if not info.get("input_schema") or not info["input_schema"].get("properties"):
                        info["input_schema"] = _default_input_schema(reg_kind)
                    else:
                        info["input_schema"] = _enrich_input_schema(info["input_schema"], reg_kind)
                except Exception:
                    pass
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
    code_timeout: int = 1200
    trusted: bool = False  # A档可信开关：True=跳出沙箱（需全局 STUDIO_TRUSTED_MODE=1）
    # 可选元数据
    models: List[str] = Field(default_factory=list)
    default_model: Optional[str] = None
    # 能力细分（为空则前端按 input_schema 插槽推断，不阻塞创建）
    capabilities: List[str] = Field(default_factory=list)
    params_schema: Optional[Dict[str, Any]] = None
    default_params: Dict[str, Any] = Field(default_factory=dict)
    input_schema: Optional[Dict[str, Any]] = None
    output_schema: Optional[Dict[str, Any]] = None
    doc_url: Optional[str] = None
    doc_text: Optional[str] = None
    raw_api_doc: Optional[str] = None
    enabled: bool = True
    api_key: Optional[str] = None
    # 自定义请求头 (Custom Headers)
    headers: Optional[Dict[str, str]] = None
    custom_headers: Optional[Dict[str, str]] = None



def _save_api_key(provider_id: str, api_key: str):
    """写入配置存储（单一实现已下沉到 inline_config.store_key：HTTP/MCP/迁移三处共用）。"""
    try:
        from app.providers.custom.inline_config import store_key
        store_key(provider_id, api_key)
    except Exception as e:
        print(f"[ProviderRoutes] save api_key failed: {e}")


@router.post("/providers")
async def create_provider(req: ProviderCreateRequest):
    if req.kind not in ("image", "video", "audio", "llm"):
        raise HTTPException(status_code=400, detail="kind 必须为 image/video/audio/llm")
    if req.language not in ("python", "javascript", "js"):
        raise HTTPException(status_code=400, detail="language 必须为 python/javascript")
    if not req.code or len(req.code.strip()) < 20:
        raise HTTPException(status_code=400, detail="代码模式为唯一方式：请提供 python/javascript 携程源码（含 async def generate(ctx, api)）；可先取 /providers/code/templates 模板")
    # 语法预检 python
    if req.language == "python":
        try:
            import ast
            ast.parse(req.code)
        except SyntaxError as e:
            raise HTTPException(status_code=400, detail=f"Python 语法错误: {e}")
    data: Dict[str, Any] = req.model_dump(exclude={"api_key"})
    hdrs = req.headers if req.headers is not None else req.custom_headers
    # 两者都没传时 model_dump 会给出 headers=None，而 ProviderDefinition.headers 要求 dict → 400
    data["headers"] = hdrs if hdrs is not None else {}
    data["language"] = "javascript" if req.language == "js" else req.language
    data["provider_type"] = "code"
    if not data.get("id"):
        import uuid
        data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
    else:
        # 与内置源冲突检测：动态查三注册表（不写死 id 名单）
        try:
            from app.providers.image.registry import image_registry as _ir
            from app.providers.video.registry import video_registry as _vr
            from app.providers.audio.registry import audio_registry as _ar
            if _ir.get(data["id"]) or _vr.get(data["id"]) or _ar.get(data["id"]):
                raise HTTPException(status_code=400, detail=f"id {data['id']} 与内置源冲突")
        except HTTPException:
            raise
        except Exception:
            pass
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
        # 代码型 provider 不自动套通用模板，避免与真实 API 不一致（见截图问题）
        if pd.provider_type == "code":
            if not pd.params_schema or not pd.params_schema.get("properties"):
                # 优先从代码尾 # PARAMS_SCHEMA 提取真实枚举
                extracted = _extract_params_schema_from_code(pd.code or "")
                if extracted:
                    pd.params_schema = _enrich_params_schema(extracted, pd.kind)
                elif pd.kind == "video":
                    # 最小可用模板：与截图真实 API 一致（4 分辨率，无 aspect_ratio/fps，带 seed）
                    pd.params_schema = {
                        "type": "object",
                        "properties": {
                            "resolution": {"type": "string","title": "分辨率","enum": ["480p竖","768p竖","480p横","768p横"],"default": "768p竖","description": "分辨率（竖=9:16 横=16:9）","x-category": "layout","x-visibility": "basic","x-agent": "auto","x-priority": 20},
                            "duration": {"type": "integer","title": "时长","default": 5,"minimum": 3,"maximum": 15,"description": "时长秒 3-15","x-category": "motion","x-visibility": "basic","x-agent": "auto","x-priority": 30},
                            "seed": {"type": "integer","title": "随机种子","description": "随机种子，留空随机","x-category": "quality","x-visibility": "advanced","x-agent": "manual","x-priority": 99}
                        }
                    }
                else:
                    pd.params_schema = _default_params_schema(pd.kind)
            if not pd.input_schema or not pd.input_schema.get("properties"):
                # 代码型 input 若未声明，尝试从代码 infer，或使用含 reference_audios 的新默认
                pd.input_schema = _default_input_schema(pd.kind)
        else:
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
            # 指示器同步：列表 has_key 由 auth.key_env 派生，清 Key 后必须置空（否则 UI 永远显示"已配置"）
            pd.auth.key_env = None
        else:
            _save_api_key(provider_id, api_key)
            # 回填 key_env（原先写进 body.auth 是死代码——下方 legacy 清理会把 auth 整个丢弃）
            pd.auth.key_env = f"CUSTOM_PROVIDER_{provider_id}"
    # 非代码模式已删除：legacy 字段不再接受更新，provider_type 不允许改写
    for _legacy_key in ("transport", "auth", "mapping", "health_check", "provider_type"):
        body.pop(_legacy_key, None)
    if "code" in body and not str(body.get("code") or "").strip():
        raise HTTPException(status_code=400, detail="非代码模式已删除：code 不能为空，请提供完整携程源码")
    # 语法预检
    if "code" in body and body["code"] and (body.get("language") or pd.language) == "python":
        try:
            import ast
            ast.parse(body["code"])
        except SyntaxError as e:
            raise HTTPException(status_code=400, detail=f"Python 语法错误: {e}")
    # 沙箱体检（先验后存）：坏码直接打回，避免改码后服务崩溃/变砖
    if "code" in body and body.get("code"):
        from app.providers.generic.code_provider import compile_check_code as _ccc_rest
        _lang_rest = body.get("language") or pd.language or "python"
        _trusted_rest = body.get("trusted", pd.trusted)
        if isinstance(_trusted_rest, str):
            _trusted_rest = _trusted_rest.strip().lower() in ("1", "true", "yes", "on")
        _cc_rest = _ccc_rest(_lang_rest, body["code"], body.get("code_entry") or pd.code_entry or "generate",
                             trusted=bool(_trusted_rest))
        if not _cc_rest.get("ok"):
            raise HTTPException(status_code=400, detail=f"代码未通过沙箱体检，已拒绝保存: {_cc_rest.get('error')}")
    current = pd.model_dump()
    # 深度合并（default_params 深合并，其余直接覆盖）
    for k, v in body.items():
        if k == "default_params" and isinstance(v, dict):
            current[k] = {**(current.get(k) or {}), **v}
        else:
            current[k] = v
    if "headers" in body or "custom_headers" in body:
        new_hdrs = body.get("headers") if "headers" in body else body.get("custom_headers")
        from app.models.provider_definition import normalize_headers
        cleaned_hdrs = normalize_headers(new_hdrs)
        current["headers"] = cleaned_hdrs
        if "transport" in current and isinstance(current["transport"], dict):
            current["transport"]["headers"] = cleaned_hdrs

    # 若更新了 code 且未显式传 params_schema，尝试从新 code 尾注释提取真实 schema 覆盖通用残留
    if "code" in body and "params_schema" not in body:
        try:
            ext = _extract_params_schema_from_code(body["code"] or "")
            if ext:
                current["params_schema"] = _enrich_params_schema(ext, current.get("kind", pd.kind))
        except Exception:
            pass
    # 若更新了 code 且未显式传 input_schema，且新 input 缺 reference_audios，尝试保留旧 input 的扩展字段
    # （由前端升级接口手动传 input_schema 覆盖，此处不自动清理）
    # 若更新了 code，强制标记代码型
    if "code" in body:
        current["provider_type"] = "code"
    # 统一 enrich，保证 x-* 完整（尤其手动修正后的 schema）
    if current.get("params_schema") and isinstance(current["params_schema"], dict) and current["params_schema"].get("properties"):
        try:
            current["params_schema"] = _enrich_params_schema(current["params_schema"], current.get("kind", pd.kind))
        except Exception:
            pass
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
    verification.clear(provider_id)  # 定义变更 → 需重新测试才可作为生产源
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


def _set_provider_enabled(provider_id: str, enabled: bool) -> Dict[str, Any]:
    """生成源启停（统一口径）：
    - 自定义源（含 ComfyUI 工作流派生 / 代码源）：原生生命周期 —— 改写定义 enabled + 注册/注销；
    - 内置源：软停用（扩展覆盖层，守卫在执行前拦截），定义在代码内，不做注册表增删。
    """
    from app.extensions import state as ext_state
    pd = custom_provider_manager.get_definition(provider_id)
    if pd is not None and not getattr(pd, "builtin", False):
        pd.enabled = bool(enabled)
        custom_provider_manager.save_definition(pd)
        try:
            from app.providers.init_providers import (
                register_single_custom_provider, unregister_single_custom_provider)
            if enabled:
                register_single_custom_provider(pd)
            else:
                unregister_single_custom_provider(pd.id, getattr(pd, "kind", "image"))
        except Exception as e:
            print(f"[ProviderRoutes] toggle register failed: {e}")
        return {"status": "success", "provider_id": provider_id, "enabled": bool(enabled),
                "mode": "native", "builtin": False}
    # 内置（或登记在注册表里的其它源）：软停用覆盖层
    registered = False
    try:
        from app.providers.image.registry import image_registry
        from app.providers.video.registry import video_registry
        from app.providers.audio.registry import audio_registry
        registered = any(provider_id in reg.list_ids() for reg in (image_registry, video_registry, audio_registry))
    except Exception:
        registered = False
    if registered or (pd is not None and getattr(pd, "builtin", False)):
        ext_state.set_disabled(f"provider:{provider_id}", not enabled, "")
        return {"status": "success", "provider_id": provider_id, "enabled": bool(enabled),
                "mode": "overlay", "builtin": True}
    raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")


@router.post("/providers/{provider_id}/enable")
async def enable_provider(provider_id: str):
    """启用生成源（自定义源重新注册；内置源解除软停用）。"""
    return _set_provider_enabled(provider_id, True)


@router.post("/providers/{provider_id}/disable")
async def disable_provider(provider_id: str):
    """停用生成源（自定义源注销注册；内置源软停用；定义保留，可随时再启用）。"""
    return _set_provider_enabled(provider_id, False)


class ProviderNotFound(ValueError):
    """测试/查询时生成源不存在（HTTP 404，MCP 直接透出错误）。"""


async def _live_probe_provider(kind: str, provider_id: str) -> tuple:
    """实测探针：真调一次最小生成请求（可能消耗额度），把上游的真实错误带回来。

    返回 (ok, detail)。超时按"提交已通过"处理（鉴权/参数在提交环节已验证）；
    失败时附行动建议（Key/余额/地址）。
    """
    import asyncio as _asyncio
    from app.providers.error_hints import provider_error_hint
    try:
        timeout_s = float(os.environ.get("PROVIDER_LIVE_TEST_TIMEOUT_S") or 180)
    except Exception:
        timeout_s = 180.0
    try:
        if kind == "image":
            from app.providers.image.registry import image_registry as _reg
            from app.providers.image.base import ImageGenerateRequest
            req = ImageGenerateRequest(prompt="connectivity test: a grey cube on white background", aspect_ratio="1:1")
            coro = _reg.generate(req, provider_id=provider_id)
        elif kind == "video":
            from app.providers.video.registry import video_registry as _reg
            from app.providers.video.base import VideoGenerateRequest
            req = VideoGenerateRequest(prompt="connectivity test: static shot, a grey cube on a table", mode="t2v", duration=4)
            coro = _reg.generate(req, provider_id=provider_id)
        else:
            from app.providers.audio.registry import audio_registry as _reg
            from app.providers.audio.base import AudioGenerateRequest
            req = AudioGenerateRequest(text="连通测试", voice_id="", emotion="")
            coro = _reg.generate(req, provider_id=provider_id)
        await _asyncio.wait_for(coro, timeout=timeout_s)
        return True, "实测通过（已真实调用上游一次，可能消耗少量额度）"
    except _asyncio.TimeoutError:
        return True, f"实测已提交但 {int(timeout_s)}s 内未返回终态（鉴权与提交环节已通过；生成结果以任务查询为准）"
    except Exception as e:
        msg = str(e)[:300]
        hint = provider_error_hint(msg)
        return False, f"实测失败：{msg}" + (f"｜建议：{hint}" if hint else "")


async def run_provider_test(provider_id: str, live: bool = False) -> Dict[str, Any]:
    """统一「连通测试 + 生产可用验证标记」的唯一实现（HTTP 路由与 MCP test_custom_provider 共用）。

    测试联通即授予生产端（画布/分镜选择器）可见资格；失败/改代码/改 Key 后撤销。
    诚实口径（probe 字段）：
      - compile：代码源只做了语法/沙箱编译体检，**没有真调上游**；
      - health ：内置源走自身健康探针（部分源仅校验配置存在，同样不一定真调上游）；
      - live   ：显式 live=True 才真调一次上游（可能消耗额度）。
    """
    pd = custom_provider_manager.get_definition(provider_id)
    prov = None
    kind = None
    compile_check = None
    code_probe = False
    if pd and not pd.code and getattr(pd, "provider_type", "") != "comfyui":
        # 非代码（JSON 模板）模式已删除：无代码的定义不可测试，需先升级为代码
        raise ValueError("该源为非代码（JSON 模板）模式，已废弃；请先升级为代码模式")
    if pd and pd.code:
        kind = pd.kind
        code_probe = True
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
            raise ValueError(f"创建 Provider 实例失败: {e}")
        # 免费深度体检先行：沙箱编译+入口定位（零配额），坏代码快速失败并给出确切原因
        from app.providers.generic.code_provider import compile_check_code
        cc = compile_check_code(pd.language or "python", pd.code, pd.code_entry or "generate")
        compile_check = cc
        if not cc.get("ok"):
            verification.mark(provider_id, False, f"代码体检未通过: {cc.get('error')}", kind or "")
            return {"provider_id": provider_id, "ok": False, "is_configured": True, "kind": kind,
                    "probe": "compile",
                    "detail": f"代码体检未通过: {cc.get('error')}", "compile_check": cc, "verified": False}
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
            raise ProviderNotFound(f"Provider 不存在: {provider_id}")
    try:
        ok = await prov.check_health()
        is_configured = prov.is_configured() if hasattr(prov, "is_configured") else True
        probe = "compile" if code_probe else "health"
        if ok and live:
            kind2 = kind or getattr(prov, "kind", "image")
            ok, detail = await _live_probe_provider(kind2, provider_id)
            probe = "live"
        elif not ok:
            detail = "检测未通过（检查代码/ Key/地址）"
        elif code_probe:
            detail = "代码体检通过（语法/沙箱编译 OK；未真实调用上游——点「实测」会真调一次，可能消耗额度）"
        else:
            detail = "配置/健康探针通过（部分内置源仅校验配置存在，不保证真连通；点「实测」可真调一次）"
        # 测试联通即授予“生产可用”资格；失败则撤销，未验证的源不会出现在生产端
        verified = bool(ok and is_configured)
        verification.mark(provider_id, verified, detail, kind or getattr(prov, "id", ""))
        resp = {"provider_id": provider_id, "ok": ok, "is_configured": is_configured,
                "verified": verified, "probe": probe,
                "kind": kind or getattr(prov, "kind", "unknown"),
                "detail": detail}
        if not ok:
            from app.providers.error_hints import provider_error_hint
            hint = provider_error_hint(detail)
            if hint:
                resp["hint"] = hint
        if compile_check is not None:
            resp["compile_check"] = compile_check
        return resp
    except Exception as e:
        verification.mark(provider_id, False, f"检测异常: {e}", kind or "")
        from app.providers.error_hints import provider_error_hint
        hint = provider_error_hint(str(e))
        out = {"provider_id": provider_id, "ok": False, "verified": False, "detail": f"检测异常: {e}"}
        if hint:
            out["hint"] = hint
        return out


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: str, body: Optional[Dict[str, Any]] = Body(None)):
    """HTTP 连通测试（与 MCP test_custom_provider 共用同一实现，保证验证语义一致）。

    body: {"live": true} 时真调一次上游最小请求（可能消耗额度）；缺省只做体检/配置检查。
    """
    try:
        live = bool((body or {}).get("live"))
        return await run_provider_test(provider_id, live=live)
    except ProviderNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
    trusted: bool = False  # A档可信开关
    async_task: bool = False  # True=后台任务化（立即返回 task_id，前端轮询 /providers/import/tasks/{id}）


# ─────────────────── 文档导入任务化（长 LLM 调用期间给前端阶段进度）───────────────────
# 单机应用：内存任务表 + TTL 清理即可；不复用 task_center（其面向生成任务的轮询器/持久化）。
_IMPORT_TASKS: Dict[str, Dict[str, Any]] = {}
_IMPORT_TASK_TTL_S = 3600


def _import_task_create() -> str:
    tid = f"imp_{uuid.uuid4().hex[:10]}"
    now = time.time()
    for k in [k for k, v in _IMPORT_TASKS.items() if now - float(v.get("updated_at") or 0) > _IMPORT_TASK_TTL_S]:
        _IMPORT_TASKS.pop(k, None)
    _IMPORT_TASKS[tid] = {
        "task_id": tid, "stage": "queued", "stage_label": "排队中…",
        "log": [], "created_at": now, "updated_at": now,
        "done": False, "provider": None, "error": None, "result_status": None,
    }
    return tid


def _import_task_update(tid: str, **kw: Any) -> None:
    rec = _IMPORT_TASKS.get(tid)
    if not rec:
        return
    log_line = kw.pop("log_line", None)
    if log_line:
        rec["log"].append({"t": time.time(), "text": str(log_line)[:300]})
    rec.update(kw)
    rec["updated_at"] = time.time()


async def _import_from_doc_core(req: ProviderImportRequest, on_stage: Optional[Callable[[str], None]] = None) -> Dict[str, Any]:
    """文档导入核心（同步路径与任务化路径共用）：取文档 → LLM 生成代码 → 统一创建注册。"""
    def _stage(msg: str) -> None:
        if on_stage:
            try:
                on_stage(msg)
            except Exception:
                pass

    _stage("正在获取 API 文档…")
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
        raise ValueError("请提供 doc_text / doc_url / curl / openapi_url 或 definition")
    # LLM 生成代码（单点：优先 Agent 适配器，抗推理模型烧光 max_tokens）
    lang = (req.language or "python").lower()
    if lang == "js": lang = "javascript"
    code_text = await llm_generate_code(req.kind, lang, doc_content, req.name or "", on_stage=on_stage)
    if len((code_text or "").strip()) < 50:
        raise ValueError("LLM 生成代码过短")
    inferred = _infer_kind_from_doc(doc_content, "")
    final_kind = req.kind
    if inferred and inferred != req.kind and req.kind in (None, "", "image") and inferred == "video":
        final_kind = inferred
    _stage("正在注册生成源（schema 规整 / 编译体检）…")
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
        trusted=bool(getattr(req, "trusted", False)),
    )
    _stage("注册完成")
    return {"status": "success" if created["compile_check"].get("ok") else "compile_failed",
            "provider": created["provider"], "mode": "llm_code", "code": created["code"],
            "compile_check": created["compile_check"],
            **({"hint": "生成的代码未通过沙箱编译体检，请根据 compile_check.error 修正后重试"} if not created["compile_check"].get("ok") else {})}


async def _import_task_run(tid: str, req: ProviderImportRequest) -> None:
    def _on_stage(msg: str) -> None:
        logger.info("导入任务 %s: %s", tid, msg)
        _import_task_update(tid, stage_label=msg, log_line=msg)

    try:
        _import_task_update(tid, stage="fetching_docs", stage_label="正在获取 API 文档…", log_line="任务开始")
        res = await _import_from_doc_core(req, on_stage=_on_stage)
        _import_task_update(tid, stage="done", stage_label="完成", done=True,
                            provider=res.get("provider"), result_status=res.get("status"),
                            log_line=f"完成：{res.get('status')}")
    except Exception as e:
        logger.exception("文档导入任务失败 %s", tid)
        _import_task_update(tid, stage="failed", stage_label="失败", done=True,
                            error=str(e)[:600], log_line=f"失败：{str(e)[:200]}")


@router.post("/providers/import")
async def import_provider_from_doc(req: ProviderImportRequest):
    """从文档/cURL/OpenAPI 通过 LLM 生成代码 Provider（导演自动调用）。

    async_task=True 时后台任务化执行并立即返回 task_id（LLM 生成可达数分钟，
    前端轮询 GET /providers/import/tasks/{task_id} 拿阶段进度与结果）。
    """
    if req.definition:
        try:
            data = req.definition
            if not data.get("id"):
                data["id"] = f"prov_{uuid.uuid4().hex[:8]}"
            data["kind"] = req.kind or data.get("kind", "image")
            if req.name:
                data["name"] = req.name
            # 非代码模式已删除：definition 必须内联完整 code（旧 transport 自动迁移路径已移除）
            code_in = str(data.get("code") or "").strip()
            if len(code_in) < 20:
                raise HTTPException(status_code=400, detail="非代码模式已删除：definition 必须包含完整 code（async def generate(ctx, api)）")
            data["provider_type"] = "code"
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
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"definition 导入失败: {e}")

    # 任务化：立即返回 task_id，后台跑完整导入（含长 LLM 调用）
    if req.async_task:
        tid = _import_task_create()
        asyncio.create_task(_import_task_run(tid, req))
        return {"status": "queued", "task_id": tid, "mode": "llm_code"}

    # 同步路径（向后兼容：Agent/脚本旧调用）
    try:
        return await _import_from_doc_core(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM 生成代码失败: {e}")


@router.get("/providers/import/tasks/{task_id}")
async def get_import_task(task_id: str):
    """查询文档导入任务的阶段进度与结果（前端轮询）。"""
    rec = _IMPORT_TASKS.get(task_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"导入任务不存在或已过期: {task_id}")
    return rec


@router.post("/providers/{provider_id}/api-key")
async def set_provider_api_key(provider_id: str, body: Dict[str, Any] = Body(...)):
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    api_key = body.get("api_key", "")
    if not api_key or not str(api_key).strip():
        raise HTTPException(status_code=400, detail="api_key 不能为空")
    _save_api_key(provider_id, str(api_key).strip())
    verification.clear(provider_id)  # Key 变更 → 需重新测试
    if not pd.auth.key_env:
        pd.auth.key_env = f"CUSTOM_PROVIDER_{provider_id}"
        custom_provider_manager.save_definition(pd)
    return {"status": "success", "provider_id": provider_id, "has_key": True}


# ─────────────────── 代码源「隐式配置」显式化（见 custom/inline_config.py）───────────────────
#
# 代码型生成源常把 Key / 网关地址 / 工作流 ID 写在代码里，设置页只能看到一个空 Key 输入框：
# 用户不知道这个源实际用哪个 Key、连哪个网关，想更换还得翻代码，且明文值随定义落盘。
# 两个接口把「配置里存的」与「代码里写的」一起摊开，并支持把内联 Key 迁到配置存储。
class MigrateInlineKeyRequest(BaseModel):
    rewrite_code: bool = True


@router.get("/providers/{provider_id}/effective-config")
async def get_provider_effective_config(provider_id: str):
    """自定义代码源的生效配置：Key 来源（配置存储 / 代码内联 / 未配置）+ 代码里写死的常量。
    与 GET /config 同一口径（本地桌面默认明文），明文与掩码两份都返回，由前端决定默认展示。
    """
    from app.providers.custom.inline_config import effective_config
    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise HTTPException(status_code=404, detail=f"Provider 不存在: {provider_id}")
    if getattr(pd, "provider_type", "") != "code":
        raise HTTPException(status_code=400, detail="仅代码型自定义源存在「隐式配置」")
    return {"effective": effective_config(pd)}


@router.post("/providers/{provider_id}/migrate-inline-key")
async def migrate_provider_inline_key(provider_id: str, body: Optional[MigrateInlineKeyRequest] = Body(None)):
    """把代码里的内联 Key 迁到配置存储 CUSTOM_PROVIDER_<id>，可选同时改写代码（改从 ctx 读）。

    实现已下沉到 inline_config.migrate_inline_key（HTTP 与 MCP 工具共用，返回体只有掩码）。
    """
    from app.providers.custom.inline_config import migrate_inline_key as _migrate
    rewrite = True if body is None else bool(body.rewrite_code)
    try:
        res = _migrate(provider_id, rewrite_code=rewrite)
    except ValueError as e:
        msg = str(e)
        status = 404 if msg.startswith("Provider 不存在") else 400
        raise HTTPException(status_code=status, detail=msg)
    if res.get("status") == "noop":
        raise HTTPException(status_code=400, detail=res.get("note") or "代码里没有找到内联 Key，无需迁移")
    return res


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
    if pd.code:
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
    pd.provider_type = "code"
    saved = custom_provider_manager.save_definition(pd)
    from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
    unregister_single_custom_provider(provider_id, kind=pd.kind)
    register_single_custom_provider(saved)
    return {"status": "upgraded", "provider": _sanitize_for_frontend(saved)}
