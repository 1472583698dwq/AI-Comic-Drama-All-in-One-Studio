"""
ComfyUI 工作流模板管理器 - 支持外部目录直读
- 内部目录: storage/workflows (导入后持久化，可编辑映射)
- 外部目录: COMFYUI_WORKFLOWS_DIR 配置的ComfyUI工作流目录（直读，无需导入，直接可用）
"""
import os
import json
import time
import uuid
import copy
import hashlib
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path

from app.core.config import settings
import logging

logger = logging.getLogger(__name__)

# 引入官方 CLI 的转换器（Comfy-Org/comfy-cli/workflow_to_api.py 的完整移植）
# 提供 object_info 驱动的精准转换，支持 Reroute/GetNode/SetNode/Primitive/Bypass/Subgraph 等
try:
    from . import converter_cli as _cli_converter
    _HAS_CLI_CONVERTER = True
except Exception as _e:
    _cli_converter = None  # type: ignore
    _HAS_CLI_CONVERTER = False
    print(f"[WorkflowManager] CLI converter not available: {_e}")


WORKFLOWS_DIR = os.path.join(settings.STORAGE_DIR, "workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)

# 已知合法的采样器与调度器（用于修复错乱的工作流）
VALID_SAMPLERS = ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_2m", "dpmpp_2m_sde", "ddim", "uni_pc", "uni_pc_bh2"]
VALID_SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"]

def _fix_ksampler_node(node: Dict[str, Any]) -> bool:
    """修复 KSampler/KsamplerAdvanced 的类型错乱，返回是否发生修复"""
    if node.get("class_type") not in ("KSampler", "KSamplerAdvanced"):
        return False
    inputs = node.get("inputs", {})
    fixed = False
    # seed -> int
    if "seed" in inputs:
        try:
            v = inputs["seed"]
            if isinstance(v, str) and v in ("randomize", "fixed", "increment", "decrement"):
                inputs["seed"] = int.from_bytes(os.urandom(4), "little")
                fixed = True
            else:
                inputs["seed"] = int(v)
        except Exception:
            inputs["seed"] = int.from_bytes(os.urandom(4), "little")
            fixed = True
    # steps -> int 8-50
    if "steps" in inputs:
        v = inputs["steps"]
        if isinstance(v, str):
            if v in ("randomize", "fixed", "increment", "decrement", "simple"):
                inputs["steps"] = 20
                fixed = True
            else:
                try:
                    inputs["steps"] = int(float(v))
                    fixed = True
                except Exception:
                    inputs["steps"] = 20
                    fixed = True
        else:
            try:
                iv = int(v)
                if iv < 1 or iv > 100:
                    inputs["steps"] = 20
                    fixed = True
                else:
                    inputs["steps"] = max(4, min(60, iv))
            except Exception:
                inputs["steps"] = 20
                fixed = True
    # cfg -> float
    if "cfg" in inputs:
        try:
            fv = float(inputs["cfg"])
            if fv < 0 or fv > 30:
                inputs["cfg"] = 7.0
                fixed = True
            else:
                inputs["cfg"] = fv
        except Exception:
            inputs["cfg"] = 7.0
            fixed = True
    # sampler_name -> string
    if "sampler_name" in inputs:
        v = inputs["sampler_name"]
        if isinstance(v, int):
            # 旧工作流中 1 可能代表 euler
            try:
                inputs["sampler_name"] = VALID_SAMPLERS[v] if 0 <= v < len(VALID_SAMPLERS) else "euler"
                fixed = True
            except Exception:
                inputs["sampler_name"] = "euler"
                fixed = True
        elif isinstance(v, str) and v not in VALID_SAMPLERS:
            # 尝试大小写不敏感匹配
            low = v.lower()
            found = next((s for s in VALID_SAMPLERS if s.lower() == low), None)
            if found:
                inputs["sampler_name"] = found
            else:
                # 数字字符串也尝试
                try:
                    idx = int(v)
                    inputs["sampler_name"] = VALID_SAMPLERS[idx] if 0 <= idx < len(VALID_SAMPLERS) else "euler"
                    fixed = True
                except Exception:
                    inputs["sampler_name"] = "euler"
                    fixed = True
    # scheduler -> string
    if "scheduler" in inputs:
        v = inputs["scheduler"]
        if v not in VALID_SCHEDULERS:
            low = str(v).lower()
            found = next((s for s in VALID_SCHEDULERS if s.lower() == low), None)
            if found:
                inputs["scheduler"] = found
            else:
                inputs["scheduler"] = "normal"
                fixed = True
    # denoise -> float
    if "denoise" in inputs:
        try:
            v = inputs["denoise"]
            if isinstance(v, str):
                if v.lower() == "simple":
                    inputs["denoise"] = 1.0
                    fixed = True
                else:
                    inputs["denoise"] = float(v)
            else:
                fv = float(v)
                inputs["denoise"] = max(0.0, min(1.0, fv))
        except Exception:
            inputs["denoise"] = 1.0
            fixed = True
    return fixed

def _fix_workflow_ksamplers(workflow: Dict[str, Any]) -> int:
    """批量修复工作流中所有 KSampler 节点，返回修复数量"""
    cnt = 0
    for nid, node in workflow.items():
        if isinstance(node, dict) and _fix_ksampler_node(node):
            cnt += 1
    if cnt:
        logger.info(f"[WorkflowManager] 已自动修复 {cnt} 个 KSampler 节点类型错乱")
    return cnt

def _get_external_workflows_dir() -> Optional[str]:
    """获取用户配置的ComfyUI工作流外部目录"""
    cfg_dir = getattr(settings, "COMFYUI_WORKFLOWS_DIR", "") or ""
    if cfg_dir and os.path.exists(cfg_dir) and os.path.isdir(cfg_dir):
        return os.path.abspath(cfg_dir)
    # 尝试自动探测常见ComfyUI路径（不强制）
    candidates = [
        os.path.join(os.path.dirname(settings.STORAGE_DIR), "ComfyUI", "workflows"),
        os.path.join(os.path.dirname(settings.STORAGE_DIR), "ComfyUI", "user", "default", "workflows"),
        "C:/ComfyUI/workflows",
        "D:/ComfyUI/workflows",
        "D:/ComfyUI/user/default/workflows",
    ]
    for c in candidates:
        if os.path.exists(c) and os.path.isdir(c):
            return os.path.abspath(c)
    return None

# 允许的class_type白名单（仅作警告提示，不再硬性拦截，兼容任意自定义节点）
ALLOWED_CLASS_TYPES = {
    "CheckpointLoaderSimple", "CheckpointLoader", "LoraLoader", "CLIPTextEncode",
    "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux", "EmptyLatentImage",
    "KSampler", "KSamplerAdvanced", "SamplerCustom",
    "VAEDecode", "VAEEncode", "SaveImage", "PreviewImage",
    "LoadImage", "ImageScale", "ImageResize",
    "ControlNetLoader", "ControlNetApply", "ControlNetApplyAdvanced",
    "IPAdapterModelLoader", "IPAdapterApply", "IPAdapterUnifiedLoader",
    "FluxGuidance",
    "UNETLoader", "VAELoader", "CLIPLoader",
    "ConditioningCombine", "ConditioningSetArea",
    "LatentUpscale", "ImageUpscaleWithModel",
    "SaveImageWebsocket", "ETN_CropImage",
    # 常见视频/音频/辅助节点（避免误报）
    "VHS_VideoCombine", "SaveAnimatedWEBP", "VideoCombine", "SaveAudio",
    "SaveImageAdvanced", "ImageSave", "UNETLoader", "KSamplerSelect",
}

def is_api_format_workflow(data: Dict[str, Any]) -> Tuple[bool, str]:
    """兼容官方 CLI 的 is_api_format 逻辑 + 本地校验"""
    if not isinstance(data, dict) or not data:
        return False, "工作流为空或非对象"
    # 优先用官方转换器的判断（支持 prompt/extra_data/client_id 透传）
    if _HAS_CLI_CONVERTER and _cli_converter.is_api_format(data):
        # 进一步校验每个节点结构
        for key, val in data.items():
            if key in ("prompt", "extra_data", "client_id"):
                continue
            if not isinstance(val, dict):
                return False, f"节点 {key} 格式错误，期望对象"
            if "class_type" not in val or "inputs" not in val:
                return False, f"节点 {key} 缺少 class_type/inputs，确认是 API Format"
            if not isinstance(val["inputs"], dict):
                return False, f"节点 {key}.inputs 非对象"
        return True, "ok"
    # Save Format 特征直接判否
    if "nodes" in data or "links" in data or "groups" in data:
        return False, "检测到 Save Format（包含 nodes/links），将自动转换为 API Format"
    for key, val in data.items():
        if not isinstance(val, dict):
            return False, f"节点 {key} 格式错误，期望对象"
        if "class_type" not in val or "inputs" not in val:
            return False, f"节点 {key} 缺少 class_type/inputs，确认是 API Format"
        if not isinstance(val["inputs"], dict):
            return False, f"节点 {key}.inputs 非对象"
    return True, "ok"


def is_save_format_workflow(data: Dict[str, Any]) -> bool:
    """判断是否为前端 Save Format；兼容 definitions.subgraphs 等新结构"""
    if not isinstance(data, dict):
        return False
    if "nodes" in data and isinstance(data["nodes"], list):
        return True
    # 某些新版前端导出可能仅含 definitions + nodes
    if "definitions" in data and "nodes" in data:
        return True
    return False


_OBJECT_INFO_CACHE: Optional[Dict[str, Any]] = None
_OBJECT_INFO_CACHE_TS: float = 0
# ComfyUI 离线时的失败短缓存：启动期十余个 combo 参数会轮询 object_info，
# 无缓存时每次卡满 timeout（约 3s），累计 30s+ 拖慢服务就绪。失败只缓存 60s，
# ComfyUI 上线后最多 1 分钟即恢复精准枚举。
_OBJECT_INFO_FAIL_TS: float = 0
_OBJECT_INFO_FAIL_TTL: float = 60.0


def _fetch_object_info(timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    global _OBJECT_INFO_CACHE, _OBJECT_INFO_CACHE_TS, _OBJECT_INFO_FAIL_TS
    if _OBJECT_INFO_CACHE is not None and time.time() - _OBJECT_INFO_CACHE_TS < 300:
        return _OBJECT_INFO_CACHE
    if time.time() - _OBJECT_INFO_FAIL_TS < _OBJECT_INFO_FAIL_TTL:
        return None
    url = (getattr(settings, "COMFYUI_SERVER_URL", "") or "http://127.0.0.1:8188").rstrip("/")
    try:
        import httpx
        with httpx.Client(timeout=timeout) as c:
            r = c.get(f"{url}/object_info")
            if r.status_code == 200:
                _OBJECT_INFO_CACHE = r.json()
                _OBJECT_INFO_CACHE_TS = time.time()
                return _OBJECT_INFO_CACHE
    except Exception:
        pass
    _OBJECT_INFO_FAIL_TS = time.time()
    return None


# 视为图像输出的节点类型（用于输出捕获与剪枝诊断）
OUTPUT_NODE_CLASSES = {
    "SaveImage", "PreviewImage", "SaveImageWebsocket",
    "VHS_VideoCombine", "SaveAnimatedWEBP", "VideoCombine", "SaveAnimatedPNG",
    "SaveAudio", "ImageSave", "SaveImageAdvanced",
}

# 媒体参数名与媒体输入节点类型：属于动态外部文件或用户上传，严禁受静态 object_info 枚举拦截
MEDIA_PARAM_NAMES = {
    "image", "audio", "video", "filename", "file", "media",
    "image_path", "video_path", "audio_path", "first_frame", "last_frame",
}
MEDIA_NODE_CLASSES = {
    "LoadImage", "LoadImageMask", "LoadImageForInpaint", "ImageLoad", "LoadImageFromPath", "LoadImageOutput",
    "LoadAudio", "LoadAudio2", "AudioLoad", "VHS_LoadAudio", "VHS_LoadAudioUpload",
    "LoadVideo", "VHS_LoadVideo", "VHS_LoadVideoPath", "VideoLoad", "VHS_LoadImages", "VHS_LoadImagesPath",
}


def _combo_choices_from_oi(ct: str, pname: str, current: Any = None) -> Optional[List[str]]:
    """
    从 ComfyUI object_info 取某节点某参数的真实下拉枚举。
    兼容两种 schema：旧式 (choices_list, {...}) 与新式 ("COMBO", {"options": [...], ...})。
    ComfyUI 离线或参数无枚举时返回 None（调用方回退到内置预设）。
    媒体输入节点与媒体参数动态上传，无固定枚举，返回 None。
    """
    if ct in MEDIA_NODE_CLASSES or pname.lower() in MEDIA_PARAM_NAMES or any(pname.lower().endswith(s) for s in ("_image", "_video", "_audio", "_file", "_path")):
        return None
    oi = _fetch_object_info()
    if not oi:
        return None
    try:
        node_spec = oi.get(ct, {}).get("input", {})
        spec = {**node_spec.get("required", {}), **node_spec.get("optional", {})}.get(pname)
        if not isinstance(spec, (list, tuple)) or len(spec) == 0:
            return None
        choices: List[str] = []
        if isinstance(spec[0], (list, tuple)):
            choices = [str(x) for x in spec[0]]
        elif isinstance(spec[0], str) and len(spec) > 1 and isinstance(spec[1], dict) and isinstance(spec[1].get("options"), list):
            choices = [str(x) for x in spec[1]["options"]]
        # 剔除新版 object_info 的字典式嵌套选项（"{'key': 'on', 'inputs': ...}"，如 TextGenerate.sampling_mode）：
        # 它们是子控件 schema 而非合法枚举，stringify 后会误导模糊匹配把垃圾写回工作流（致 execution_error）。
        # 与前端 schema 构建侧（combo 分支）过滤口径一致。
        choices = [c for c in choices if not c.startswith("{") and "'inputs':" not in c]
        if not choices:
            return None
        choices = choices[:80]
        if current is not None and str(current) not in choices:
            choices = [str(current)] + choices
        return choices
    except Exception:
        return None


def _normalize_combo_value(val: Any, valid: List[str]) -> Any:
    """将短值/旧值自动映射到真实枚举，如 9:16 → 9:16 (Portrait Widescreen)"""
    s = str(val).strip()
    if s in valid:
        return s
    # 前缀匹配：9:16 匹配 9:16 (...)
    prefix = s.split(" ")[0].split("(")[0].strip()
    for v in valid:
        v_prefix = v.split(" ")[0].split("(")[0].strip()
        if v_prefix == prefix or v_prefix == s or v.startswith(s) or s.startswith(v_prefix):
            return v
    # 旧值兼容：9:16 (Portrait) → 9:16 (Portrait Widescreen)
    # 短字符串（如 "on"/"off"）跳过子串兜底，避免误命中长选项内的子串（如 "{'key': 'on', ...}" 残留）。
    if len(s) >= 3 and len(prefix) >= 3:
        for v in valid:
            if prefix in v or s in v:
                return v
    return None


def _set_input_guarded(wf: Dict[str, Any], nid: str, pname: str, val: Any) -> None:
    """
    带枚举护栏的参数写入：值不在 ComfyUI 真实枚举内时尝试自动映射，仍不匹配则拒绝写入。
    背景：新版 ComfyUI 对非法 combo 值不报错，而是把整条输出分支软剪枝（状态仍 success），
    表现为"工作流已完成但未捕获到图像输出"。离线（拿不到 object_info）时不拦截。
    媒体参数（LoadImage、image/audio/video）为动态上传文件，豁免枚举校验。
    """
    node = wf.get(str(nid))
    if not isinstance(node, dict):
        return
    ct = str(node.get("class_type", ""))
    # 媒体节点或媒体入参（LoadImage、image/video/audio 等）：为动态媒体/用户上传路径，严禁枚举检查
    if ct in MEDIA_NODE_CLASSES or pname.lower() in MEDIA_PARAM_NAMES or any(pname.lower().endswith(s) for s in ("_image", "_video", "_audio", "_file", "_path")):
        node.setdefault("inputs", {})[pname] = val
        return
    valid = _combo_choices_from_oi(ct, pname)
    if valid is not None and str(val) not in valid:
        mapped = _normalize_combo_value(val, valid)
        if mapped is not None and mapped in valid:
            print(f"[Workflow] 枚举自动映射: #{nid} {ct}.{pname} {val!r} → {mapped!r}")
            val = mapped
        else:
            print(f"[Workflow] 已拦截非法枚举注入: #{nid} {ct}.{pname} = {val!r}（不在 ComfyUI 枚举内，避免输出分支被剪枝）")
            return
    node.setdefault("inputs", {})[pname] = val


def _write_exposed(wf: Dict[str, Any], nid: str, pname: str, val: Any) -> None:
    """
    写入暴露项参数；支持嵌套 widget（如 TextGenerate 的 sampling_mode.temperature）。
    带点号的名字先尝试当作独立 widget 写入；不存在时折叠进父 widget 的 dict / JSON 字符串子字段，
    父项也不存在则拒绝写入 —— 避免伪造出 ComfyUI 不认的扁平键。
    """
    node = wf.get(str(nid))
    if not isinstance(node, dict):
        return
    inputs = node.setdefault("inputs", {})
    if "." not in pname:
        _set_input_guarded(wf, nid, pname, val)
        return
    if pname in inputs:
        _set_input_guarded(wf, nid, pname, val)
        return
    parent, child = pname.split(".", 1)
    if parent not in inputs:
        print(f"[Workflow] 跳过未知嵌套参数 #{nid} {pname}（父 widget {parent} 不存在）")
        return
    holder = inputs[parent]
    if isinstance(holder, dict):
        holder[child] = val
        return
    if isinstance(holder, str):
        try:
            parsed = json.loads(holder)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            parsed[child] = val
            inputs[parent] = json.dumps(parsed, ensure_ascii=False)
            return
    print(f"[Workflow] 跳过嵌套参数 #{nid} {pname}（父 widget {parent} 非可写字典）")


def _is_link(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def _writable_text_source(nid: str, node: Dict[str, Any]) -> Optional[Tuple[str, str, str]]:
    """节点自身是否为可写文本源：返回 (输入键, 标题, class_type)"""
    ct = str(node.get("class_type", ""))
    inputs = node.get("inputs", {}) or {}
    title = str((node.get("_meta") or {}).get("title", "") or "")
    if ct in ("PrimitiveStringMultiline", "PrimitiveString", "PrimitiveNode", "StringLiteral", "TextString", "String", "CR Text", "CR Text Input"):
        if isinstance(inputs.get("value"), str):
            return ("value", title or ct, ct)
    if ct in ("TextGenerate", "WanVideoTextEncode", "LongCLIPTextEncode") and isinstance(inputs.get("prompt"), str):
        return ("prompt", title or ct, ct)
    if ct in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux"):
        if isinstance(inputs.get("text"), str):
            return ("text", title or ct, ct)
    return None


def _find_writable_prompt_target(wf: Dict[str, Any], start_ids: Optional[List[str]] = None, max_depth: int = 8) -> Optional[Tuple[str, str]]:
    """
    沿连线(BFS)追溯 prompt_node 上游,找到真正可写的文本源节点
    (Switch/Concat/TextEncode 链路的源头通常才是用户提示词入口)。
    找不到链路源时,回落全局扫描未连线文本节点,按标题含 user/prompt/提示词 优先。
    返回 (node_id, input_key) 或 None。
    """
    from collections import deque
    start = [str(s) for s in (start_ids or []) if s]
    cands: List[Tuple[str, str, str, str]] = []
    seen = set()
    q = deque([(s, 0) for s in start])
    while q:
        nid, depth = q.popleft()
        if nid in seen or depth > max_depth or nid not in wf:
            continue
        seen.add(nid)
        node = wf[nid]
        if nid not in start:
            w = _writable_text_source(nid, node)
            if w:
                cands.append((nid, w[0], w[1], w[2]))
                continue
        for v in (node.get("inputs") or {}).values():
            if _is_link(v):
                q.append((str(v[0]), depth + 1))
    if not cands:
        # 全局扫描:未被 mapping 起点链覆盖的孤立可写文本节点
        for nid, node in wf.items():
            if str(nid) in seen:
                continue
            w = _writable_text_source(str(nid), node)
            if w:
                cands.append((str(nid), w[0], w[1], w[2]))
    if not cands:
        return None

    def _score(c: Tuple[str, str, str, str]) -> int:
        title = (c[2] or "").lower()
        s = 0
        if "user" in title or "用户" in c[2]:
            s -= 10
        if "prompt" in title or "提示词" in c[2]:
            s -= 5
        if c[1] == "value":
            s -= 2
        if c[3] == "PrimitiveStringMultiline":
            s -= 1
        return s

    cands.sort(key=_score)
    return (cands[0][0], cands[0][1])


def _apply_dynamic_inputs(wf: Dict[str, Any], dynamic_inputs: Optional[Dict[str, Any]]) -> None:
    """
    将暴露项动态输入写入工作流（图像/视频注入共用）。
    支持前缀：exp_/combo_/num_ → "{nid}_{param}"（nid 可含冒号的子图复合 id）、
    img_/txt_/aud_/vid_ → "{nid}"（txt 写入节点已有文本参数，不伪造不存在的键）、
    或 key 直接为节点 id（按 image/audio/video/text/value 顺序择写）。
    所有写入均走 _set_input_guarded 枚举护栏。
    """
    if not dynamic_inputs or not isinstance(dynamic_inputs, dict):
        return

    def _nid_param(rest: str) -> Optional[tuple]:
        for existing_nid in sorted(wf.keys(), key=lambda x: len(str(x)), reverse=True):
            if rest.startswith(f"{existing_nid}_"):
                pname = rest[len(f"{existing_nid}_"):]
                if pname and pname != "undefined":
                    return existing_nid, pname
                return None
        return None

    for k, val in dynamic_inputs.items():
        if val is None or val == "":
            continue
        ks = str(k)
        if isinstance(val, dict):
            if ks in wf:
                for pk, pv in val.items():
                    if pv is not None:
                        _set_input_guarded(wf, ks, pk, pv)
            continue
        # 如果是单项列表且目标不是明确要求列表的参数，解包出首项
        media_val = val[0] if (isinstance(val, list) and len(val) > 0 and isinstance(val[0], str)) else val
        if ks.startswith(("exp_", "combo_", "num_")):
            parsed = _nid_param(ks.split("_", 1)[1]) if "_" in ks else None
            if parsed:
                _write_exposed(wf, parsed[0], parsed[1], val)
        elif ks.startswith(("img_", "txt_", "aud_", "vid_")):
            prefix, rest = ks.split("_", 1)
            # 暴露项 id 可能带参数后缀（如 txt_30:27_string_b → 节点 30:27 的 string_b），
            # 先按 {节点}_{参数} 解析，解析不出再把 rest 整体当节点 id。
            parsed_media = _nid_param(rest)
            if parsed_media:
                _write_exposed(wf, parsed_media[0], parsed_media[1], media_val)
                continue
            target_nid = rest
            node = wf.get(target_nid)
            if not isinstance(node, dict):
                continue
            n_inps = node.setdefault("inputs", {})
            if prefix == "img":
                _set_input_guarded(wf, target_nid, "image", media_val)
            elif prefix == "aud":
                target = "audio" if "audio" in n_inps else "reference_audio" if "reference_audio" in n_inps else "audio"
                _set_input_guarded(wf, target_nid, target, media_val)
            elif prefix == "vid":
                target = "video" if "video" in n_inps else "image" if "image" in n_inps else "video"
                _set_input_guarded(wf, target_nid, target, media_val)
            else:  # txt：优先写入节点已有的文本参数（PrimitiveString* 用 value，CLIPTextEncode 用 text）
                target = next((c for c in ("value", "text", "string") if c in n_inps), "text")
                _set_input_guarded(wf, target_nid, target, media_val)
        elif ks in wf:
            n_inps = wf[ks].setdefault("inputs", {})
            target = next((c for c in ("image", "audio", "video", "text", "string", "value") if c in n_inps), None)
            if target:
                _set_input_guarded(wf, ks, target, media_val)


COMMON_WIDGET_ORDER: Dict[str, List[str]] = {
    "CheckpointLoaderSimple": ["ckpt_name"],
    "CheckpointLoader": ["ckpt_name"],
    "LoraLoader": ["lora_name", "strength_model", "strength_clip"],
    "LoraLoaderModelOnly": ["lora_name", "strength_model"],
    "CLIPTextEncode": ["text"],
    "CLIPTextEncodeSDXL": ["width", "height", "crop_w", "crop_h", "target_width", "target_height", "text_g", "text_l"],
    "CLIPTextEncodeFlux": ["clip_l", "t5xxl", "guidance"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "KSampler": ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    "KSamplerAdvanced": ["add_noise", "noise_seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
    "VAEDecode": [],
    "VAEEncode": [],
    "SaveImage": ["filename_prefix"],
    "PreviewImage": ["filename_prefix"],
    "LoadImage": ["image", "upload"],
    "UNETLoader": ["unet_name", "weight_dtype"],
    "VAELoader": ["vae_name"],
    "CLIPLoader": ["clip_name", "type"],
    "ControlNetLoader": ["control_net_name"],
    "IPAdapterModelLoader": ["ipadapter_file"],
    "FluxGuidance": ["guidance", "conditioning"],
}


def _widget_names_for_type(node_type: str, object_info: Optional[Dict[str, Any]]) -> List[str]:
    if object_info and node_type in object_info:
        try:
            info = object_info[node_type]
            inp = info.get("input", {})
            names: List[str] = []
            for section in ("required", "optional"):
                if section in inp:
                    for k, spec in inp[section].items():
                        if not isinstance(spec, (list, tuple)) or len(spec) == 0:
                            continue
                        t = spec[0]
                        # widget if combo list or primitive string type
                        if isinstance(t, list):
                            names.append(k)
                        elif isinstance(t, str) and t in ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"):
                            names.append(k)
                        elif isinstance(t, str) and t.startswith("COMFY_"):
                            names.append(k)
                        elif isinstance(t, str) and not t.isupper():
                            names.append(k)
            if names:
                return names
        except Exception:
            pass
    return COMMON_WIDGET_ORDER.get(node_type, [])


def _normalize_save_link(lk: Any) -> Optional[List[Any]]:
    if isinstance(lk, dict):
        return [
            lk.get("id"),
            lk.get("origin_id"),
            lk.get("origin_slot"),
            lk.get("target_id"),
            lk.get("target_slot"),
            lk.get("type", "*"),
        ]
    elif isinstance(lk, (list, tuple)):
        return list(lk)
    return None


def expand_subgraphs(data: Dict[str, Any]) -> Dict[str, Any]:
    """递归展开 ComfyUI Save Format 中的子图 (Subgraphs) 为扁平标准节点与连线"""
    data = copy.deepcopy(data)
    subgraph_defs = {sg["id"]: sg for sg in data.get("definitions", {}).get("subgraphs", [])}
    if not subgraph_defs:
        return data

    nodes = data.get("nodes", [])
    raw_links = data.get("links", []) or []

    # link_map: link_id -> [link_id, src_id, src_slot, dst_id, dst_slot, type]
    link_map = {}
    for lk in raw_links:
        norm = _normalize_save_link(lk)
        if norm and len(norm) >= 5:
            link_map[norm[0]] = norm

    expanded = True
    iteration = 0
    int_link_ids = [int(lk[0]) for lk in link_map.values() if isinstance(lk[0], int)]
    next_link_id = (max(int_link_ids) if int_link_ids else 1000) + 1

    # 子图保留策略：视频类等复杂子图保持为单节点，避免拆开后参数暴露失效
    VIDEO_SUBGRAPH_HINTS = ("video", "wan", "hunyuan", "cogvideo", "mochi")
    def _should_keep_subgraph(sg_id: str, sg_def: dict) -> bool:
        low = sg_id.lower()
        if any(h in low for h in VIDEO_SUBGRAPH_HINTS):
            return True
        inner = sg_def.get("nodes", []) or []
        for in_n in inner:
            ct = str(in_n.get("type", "")).lower()
            if any(h in ct for h in ("wan", "video", "vhs")):
                return True
        return False

    while expanded and iteration < 10:
        expanded = False
        iteration += 1
        new_nodes = []
        for n in nodes:
            ntype = str(n.get("type"))
            if ntype in subgraph_defs and not _should_keep_subgraph(ntype, subgraph_defs[ntype]):
                expanded = True
                sg = copy.deepcopy(subgraph_defs[ntype])
                sg_prefix = f"sg{n.get('id')}_"

                sg_inputs = sg.get("inputs", [])
                sg_outputs = sg.get("outputs", [])
                inner_nodes = sg.get("nodes", [])
                inner_links_raw = sg.get("links", [])

                inner_link_map = {}
                for lk in inner_links_raw:
                    norm = _normalize_save_link(lk)
                    if norm and len(norm) >= 5:
                        inner_link_map[norm[0]] = norm

                # 1. 拷贝并重命名子图内部节点
                for in_node in inner_nodes:
                    orig_id = in_node["id"]
                    in_node["id"] = f"{sg_prefix}{orig_id}"
                    for inp in in_node.get("inputs", []):
                        if inp.get("link") in inner_link_map:
                            inp["link"] = f"{sg_prefix}{inp['link']}"
                    new_nodes.append(in_node)

                # 2. 拷贝并重命名子图内部连线
                for lk_id_orig, norm in inner_link_map.items():
                    lk_id = f"{sg_prefix}{norm[0]}"
                    src_id = f"{sg_prefix}{norm[1]}" if (isinstance(norm[1], int) and norm[1] > 0) else norm[1]
                    dst_id = f"{sg_prefix}{norm[3]}" if (isinstance(norm[3], int) and norm[3] > 0) else norm[3]
                    link_map[lk_id] = [lk_id, src_id, norm[2], dst_id, norm[4], norm[5] if len(norm) > 5 else "*"]

                # 3. 映射子图入参 (Outer Node Inputs / Widgets -> Inner Nodes)
                outer_inputs = n.get("inputs", [])
                outer_widgets = n.get("widgets_values", [])

                for idx, sg_in in enumerate(sg_inputs):
                    outer_link_id = None
                    if idx < len(outer_inputs):
                        outer_link_id = outer_inputs[idx].get("link")

                    target_link_ids = sg_in.get("linkIds", [])
                    for t_lid in target_link_ids:
                        if t_lid in inner_link_map:
                            in_lk = inner_link_map[t_lid]
                            # origin_id == -10 (inputNode)
                            if in_lk[1] == -10:
                                target_node_id = f"{sg_prefix}{in_lk[3]}"
                                target_slot = in_lk[4]

                                if outer_link_id is not None and outer_link_id in link_map:
                                    outer_src = link_map[outer_link_id]
                                    new_lid = f"bridge_{next_link_id}"
                                    next_link_id += 1
                                    link_map[new_lid] = [new_lid, outer_src[1], outer_src[2], target_node_id, target_slot, outer_src[5] if len(outer_src) > 5 else "*"]
                                    for in_n in new_nodes:
                                        if in_n["id"] == target_node_id:
                                            for in_inp in in_n.get("inputs", []):
                                                if str(in_inp.get("link")) == f"{sg_prefix}{t_lid}":
                                                    in_inp["link"] = new_lid
                                elif idx < len(outer_widgets):
                                    val = outer_widgets[idx]
                                    for in_n in new_nodes:
                                        if in_n["id"] == target_node_id:
                                            in_inps = in_n.get("inputs", [])
                                            widget_name = None
                                            if target_slot < len(in_inps):
                                                in_inp = in_inps[target_slot]
                                                in_inp["link"] = None
                                                widget_name = in_inp.get("widget", {}).get("name") or in_inp.get("name")
                                            if widget_name:
                                                in_n.setdefault("widget_overrides", {})[widget_name] = val

                # 4. 映射子图出参 (Inner Nodes Outputs -> Outer Downstream Nodes)
                for idx, sg_out in enumerate(sg_outputs):
                    target_link_ids = sg_out.get("linkIds", [])
                    inner_src_id = None
                    inner_src_slot = None
                    for t_lid in target_link_ids:
                        if t_lid in inner_link_map:
                            in_lk = inner_link_map[t_lid]
                            inner_src_id = f"{sg_prefix}{in_lk[1]}"
                            inner_src_slot = in_lk[2]
                            break

                    if inner_src_id is not None:
                        for lk_id, lk_val in list(link_map.items()):
                            if str(lk_val[1]) == str(n.get("id")) and lk_val[2] == idx:
                                lk_val[1] = inner_src_id
                                lk_val[2] = inner_src_slot
            else:
                new_nodes.append(n)
        nodes = new_nodes

    data["nodes"] = nodes
    data["links"] = list(link_map.values())
    return data


def _legacy_convert_save_format_to_api_format(data: Dict[str, Any], object_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """旧版本地转换逻辑（无 object_info 时的离线 fallback）"""
    if not is_save_format_workflow(data):
        raise ValueError("非 Save Format，无法转换")
    if object_info is None:
        object_info = _fetch_object_info()

    # 1. 递归展开可能存在的子图 (Subgraphs)
    expanded_data = expand_subgraphs(data)

    nodes: List[Dict[str, Any]] = expanded_data.get("nodes", [])
    links: List[List[Any]] = expanded_data.get("links", []) or []

    link_map: Dict[Any, List[Any]] = {}
    for lk in links:
        norm = _normalize_save_link(lk)
        if norm and len(norm) >= 5:
            link_map[norm[0]] = norm

    NON_EXECUTABLE = {
        "MarkdownNote", "Note", "TextNote", "WorkflowNotes", "GroupNote",
        "Comment", "DisplayNote", "PrimitiveNodeNote", "EasyMarkdown",
        "CR Note", "CR Text", "Markdown", "Reroute", "PrimitiveNode",
        "Label",  # rgthree-comfy 标题装饰节点
    }

    # 收集 PrimitiveNode 的真实值与 Reroute
    primitive_values: Dict[str, Any] = {}
    reroute_map: Dict[str, Tuple[str, Any]] = {}
    for n in nodes:
        nid = str(n.get("id"))
        ntype = n.get("type")
        if ntype in ("PrimitiveNode", "PrimitiveStringMultiline", "PrimitiveBoolean", "PrimitiveInt", "PrimitiveFloat"):
            wv = n.get("widgets_values")
            if isinstance(wv, list) and wv:
                primitive_values[nid] = wv[0]
            elif isinstance(wv, dict) and wv:
                primitive_values[nid] = next(iter(wv.values()))
        if ntype == "Reroute":
            for inp in (n.get("inputs") or []):
                lk = inp.get("link")
                if lk is not None and lk in link_map:
                    reroute_map[nid] = (str(link_map[lk][1]), link_map[lk][2])
                    break

    def resolve_source(src_id: str, src_slot: Any, depth: int = 0) -> Tuple[Optional[str], Optional[Any], Optional[Any]]:
        if depth > 20:
            return src_id, src_slot, None
        if src_id in reroute_map:
            r_src, r_slot = reroute_map[src_id]
            return resolve_source(r_src, r_slot, depth + 1)
        if src_id in primitive_values:
            return None, None, primitive_values[src_id]
        return src_id, src_slot, None

    api_dict: Dict[str, Any] = {}

    for n in nodes:
        nid = str(n.get("id"))
        ntype = n.get("type")
        if not ntype or ntype in NON_EXECUTABLE:
            continue
        if n.get("mode", 0) in (2, 4):  # Muted / Bypassed
            continue

        inputs: Dict[str, Any] = {}

        # 1. 基础 Widget 参数映射（优先使用准确的 COMMON_WIDGET_ORDER 映射）
        wv = n.get("widgets_values") or []
        if isinstance(wv, dict):
            wv = list(wv.values())
        if not isinstance(wv, list):
            wv = []

        if ntype in COMMON_WIDGET_ORDER:
            order = COMMON_WIDGET_ORDER[ntype]
            for idx, wname in enumerate(order):
                if idx < len(wv):
                    if wname in ("control_after_generate", "upload"):
                        continue
                    inputs[wname] = wv[idx]
        elif ntype == "KSampler":
            if len(wv) >= 7:
                inputs["seed"] = wv[0]
                inputs["steps"] = wv[2]
                inputs["cfg"] = wv[3]
                inputs["sampler_name"] = wv[4]
                inputs["scheduler"] = wv[5]
                inputs["denoise"] = wv[6]
        elif ntype == "KSamplerAdvanced":
            if len(wv) >= 10:
                inputs["add_noise"] = wv[0]
                inputs["noise_seed"] = wv[1]
                inputs["steps"] = wv[3]
                inputs["cfg"] = wv[4]
                inputs["sampler_name"] = wv[5]
                inputs["scheduler"] = wv[6]
                inputs["start_at_step"] = wv[7]
                inputs["end_at_step"] = wv[8]
                inputs["return_with_leftover_noise"] = wv[9]
        elif ntype in ("CheckpointLoaderSimple", "CheckpointLoader"):
            if wv:
                inputs["ckpt_name"] = str(wv[0])
        elif ntype == "UNETLoader":
            if wv:
                inputs["unet_name"] = str(wv[0])
            if len(wv) > 1:
                inputs["weight_dtype"] = str(wv[1])
        elif ntype == "CLIPLoader":
            if wv:
                inputs["clip_name"] = str(wv[0])
            if len(wv) > 1:
                inputs["type"] = str(wv[1])
        elif ntype == "VAELoader":
            if wv:
                inputs["vae_name"] = str(wv[0])
        elif ntype in ("LoraLoader", "LoraLoaderModelOnly"):
            if wv:
                inputs["lora_name"] = str(wv[0])
            if len(wv) > 1:
                inputs["strength_model"] = float(wv[1])
            if len(wv) > 2:
                inputs["strength_clip"] = float(wv[2])
        elif ntype == "EmptyLatentImage":
            if len(wv) >= 3:
                inputs["width"] = int(wv[0])
                inputs["height"] = int(wv[1])
                inputs["batch_size"] = int(wv[2])
        elif ntype in ("SaveImage", "PreviewImage"):
            if wv:
                inputs["filename_prefix"] = str(wv[0])
        elif ntype == "CLIPTextEncode":
            if wv:
                inputs["text"] = str(wv[0])
        elif ntype == "ResolutionSelector":
            if len(wv) >= 3:
                inputs["aspect_ratio"] = str(wv[0])
                inputs["megapixels"] = float(wv[1])
                inputs["multiple"] = int(wv[2])
        elif ntype == "StringConcatenate":
            if len(wv) >= 3:
                inputs["string_a"] = str(wv[0])
                inputs["string_b"] = str(wv[1])
                inputs["delimiter"] = str(wv[2])
        elif ntype == "ComfySwitchNode":
            if wv:
                inputs["switch"] = bool(wv[0])
        elif ntype == "TextGenerate":
            if wv:
                if len(wv) > 0: inputs["prompt"] = str(wv[0])
                if len(wv) > 1: inputs["max_length"] = int(wv[1])
                if len(wv) > 2: inputs["sampling_mode"] = str(wv[2])
                if len(wv) > 3: inputs["sampling_mode.temperature"] = float(wv[3])
                if len(wv) > 4: inputs["sampling_mode.top_k"] = int(wv[4])
                if len(wv) > 5: inputs["sampling_mode.top_p"] = float(wv[5])
                if len(wv) > 6: inputs["sampling_mode.min_p"] = float(wv[6])
                if len(wv) > 7: inputs["sampling_mode.repetition_penalty"] = float(wv[7])
                if len(wv) > 8: inputs["sampling_mode.seed"] = int(wv[8])
                if len(wv) > 9: inputs["sampling_mode.presence_penalty"] = float(wv[9])
                if len(wv) > 10: inputs["thinking"] = bool(wv[10])
                if len(wv) > 11: inputs["use_default_template"] = bool(wv[11])
        else:
            widget_inputs = [inp for inp in (n.get("inputs") or []) if inp.get("widget")]
            if widget_inputs and wv:
                for idx, winp in enumerate(widget_inputs):
                    wname = winp.get("widget", {}).get("name") or winp.get("name")
                    if idx < len(wv):
                        inputs[wname] = wv[idx]
            else:
                unlinked_names = [inp.get("name") for inp in (n.get("inputs") or []) if inp.get("name") and inp.get("name") not in inputs]
                for idx, val in enumerate(wv):
                    if val in ("fixed", "increment", "decrement", "randomize"):
                        continue
                    if idx < len(unlinked_names):
                        inputs[unlinked_names[idx]] = val

        # 针对采样器做严格类型纠偏，防止 ComfyUI 校验失败
        if ntype in ("KSampler", "KSamplerAdvanced"):
            if "seed" in inputs:
                try: inputs["seed"] = int(inputs["seed"])
                except Exception: pass
            if "steps" in inputs:
                try: inputs["steps"] = int(inputs["steps"])
                except Exception: pass
            if "cfg" in inputs:
                try: inputs["cfg"] = float(inputs["cfg"])
                except Exception: pass
            if "denoise" in inputs:
                try: inputs["denoise"] = float(inputs["denoise"])
                except Exception: pass
            if "sampler_name" in inputs:
                inputs["sampler_name"] = str(inputs["sampler_name"])
            if "scheduler" in inputs:
                inputs["scheduler"] = str(inputs["scheduler"])

        # 2. 应用来自子图映射的外部参数覆写
        if "widget_overrides" in n:
            inputs.update(n["widget_overrides"])

        # 3. 连线输入覆盖（若上游连线存在，以连线为准）
        for inp in (n.get("inputs") or []):
            inp_name = inp.get("name")
            lk = inp.get("link")
            if not inp_name or lk is None or lk not in link_map:
                continue
            norm_lk = link_map[lk]
            src_id = norm_lk[1]
            src_slot = norm_lk[2]
            src_id_str = str(src_id)
            if src_id_str == "-10":
                continue
            res_id, res_slot, prim_val = resolve_source(src_id_str, src_slot)
            if prim_val is not None:
                inputs[inp_name] = prim_val
            elif res_id is not None:
                inputs[inp_name] = [res_id, int(res_slot) if isinstance(res_slot, int) else res_slot]

        title = n.get("title") or n.get("properties", {}).get("Node name for S&R") or ntype
        api_dict[nid] = {
            "class_type": ntype,
            "inputs": inputs,
            "_meta": {"title": title}
        }

    if not api_dict:
        raise ValueError("转换后无有效节点，请确认工作流包含可执行节点")
    return api_dict


def convert_save_format_to_api_format(data: Dict[str, Any], object_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    优先使用官方 CLI 的 object_info 驱动精准转换（支持 Reroute/GetNode/SetNode/Primitive/Bypass/Subgraph/control_after_generate/动态Combo 等）
    失败时回退至本地离线逻辑，确保无 ComfyUI 服务时仍可转换简单工作流
    """
    if not is_save_format_workflow(data):
        raise ValueError("非 Save Format，无法转换")
    # 优先尝试官方转换器
    if _HAS_CLI_CONVERTER:
        if object_info is None:
            object_info = _fetch_object_info()
        # 若能获取到 object_info，则用精准模式；否则仍尝试用空 schema 走一遍（CLI 会自动跳过未知类型的 widget 映射）
        try:
            if object_info and isinstance(object_info, dict) and len(object_info) > 0:
                converted = _cli_converter.convert_ui_to_api(data, object_info)
                if converted and isinstance(converted, dict) and len(converted) > 0:
                    logger.info(f"[WorkflowConverter] 官方 CLI 转换成功: {len(converted)} nodes (object_info={len(object_info)} types)")
                    return converted
            else:
                # 无 object_info 时仍尝试，但传入空字典会触发 CLI 的防御性处理，失败则回退
                logger.warning("[WorkflowConverter] object_info 为空，尝试离线转换，回退至 legacy 逻辑")
        except Exception as e:
            logger.warning(f"[WorkflowConverter] 官方 CLI 转换失败，回退至 legacy: {e}")
    # 回退至本地实现
    return _legacy_convert_save_format_to_api_format(data, object_info)


def ensure_api_format(data: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    ok, _ = is_api_format_workflow(data)
    if ok:
        return data, False
    if is_save_format_workflow(data):
        converted = convert_save_format_to_api_format(data)
        return converted, True
    raise ValueError("无法识别的工作流格式")

def _meta_path(workflow_id: str) -> str:
    return os.path.join(WORKFLOWS_DIR, f"{workflow_id}.meta.json")

def _json_path(workflow_id: str) -> str:
    return os.path.join(WORKFLOWS_DIR, f"{workflow_id}.json")

def _external_id_for_path(file_path: str) -> str:
    """为外部文件生成稳定ID: ext_ + 8位hash + 文件名"""
    h = hashlib.md5(file_path.encode('utf-8')).hexdigest()[:8]
    base = os.path.splitext(os.path.basename(file_path))[0]
    # 清理文件名非法字符
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in base)[:20]
    return f"ext_{h}_{safe}"

def analyze_workflow(workflow: Dict[str, Any]) -> Dict[str, Any]:
    prompts = []
    seeds = []
    dims = []
    checkpoints = []
    save_nodes = []
    for nid, node in workflow.items():
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")
        if ct in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux"):
            prompts.append({"node_id": nid, "title": title, "class_type": ct, "current_text": inputs.get("text", "")[:80]})
        if ct in ("KSampler", "KSamplerAdvanced", "SamplerCustom"):
            if "seed" in inputs:
                seeds.append({"node_id": nid, "title": title, "class_type": ct, "seed": inputs.get("seed")})
        if ct == "EmptyLatentImage":
            dims.append({"node_id": nid, "title": title, "width": inputs.get("width"), "height": inputs.get("height")})
        if ct in ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader"):
            ckpt_key = "ckpt_name" if "ckpt_name" in inputs else "unet_name"
            checkpoints.append({"node_id": nid, "title": title, "class_type": ct, "ckpt": inputs.get(ckpt_key, "")})
        if ct in ("SaveImage", "PreviewImage", "SaveImageWebsocket"):
            save_nodes.append({"node_id": nid, "title": title, "class_type": ct})
    return {
        "prompts": prompts,
        "seeds": seeds,
        "dims": dims,
        "checkpoints": checkpoints,
        "save_nodes": save_nodes,
        "total_nodes": len(workflow),
    }

def auto_generate_mapping(analysis: Dict[str, Any]) -> Dict[str, str]:
    mapping = {}
    if analysis["prompts"]:
        mapping["prompt_node"] = analysis["prompts"][0]["node_id"]
        if len(analysis["prompts"]) > 1:
            mapping["negative_node"] = analysis["prompts"][1]["node_id"]
    if analysis["seeds"]:
        mapping["seed_node"] = analysis["seeds"][0]["node_id"]
    if analysis["dims"]:
        mapping["dim_node"] = analysis["dims"][0]["node_id"]
    if analysis["checkpoints"]:
        mapping["ckpt_node"] = analysis["checkpoints"][0]["node_id"]
    if analysis["save_nodes"]:
        mapping["save_node"] = analysis["save_nodes"][0]["node_id"]
    return mapping


async def upload_image_to_comfyui(image_source: str, server_url: Optional[str] = None) -> str:
    """
    将本地文件、/storage/ 相对路径、网络 URL 或 base64 数据上传至 ComfyUI /upload/image
    支持图片、音频、视频文件，返回 ComfyUI 内部引用的文件名 (如 upload_abc123.png)
    """
    if not image_source:
        return ""
    
    if not server_url:
        server_url = (getattr(settings, "COMFYUI_SERVER_URL", "") or "http://127.0.0.1:8188").rstrip("/")

    import httpx
    import base64
    import uuid as uuidlib
    import mimetypes

    filename = f"upload_{uuidlib.uuid4().hex[:8]}.png"
    file_bytes = None
    mime_type = "image/png"

    if image_source.startswith("data:"):
        # Base64 Data URL (image/audio/video)
        try:
            header, b64data = image_source.split(",", 1)
            file_bytes = base64.b64decode(b64data)
            header_mime = header.split(";")[0].replace("data:", "").strip().lower()
            if header_mime:
                mime_type = header_mime
                ext = mimetypes.guess_extension(header_mime) or ""
                if not ext:
                    if "wav" in header_mime: ext = ".wav"
                    elif "mp3" in header_mime: ext = ".mp3"
                    elif "mp4" in header_mime: ext = ".mp4"
                    elif "webp" in header_mime: ext = ".webp"
                    elif "jpeg" in header_mime or "jpg" in header_mime: ext = ".jpg"
                    elif "webm" in header_mime: ext = ".webm"
                    elif "ogg" in header_mime: ext = ".ogg"
                    else: ext = ".png"
                if ext == ".jpe": ext = ".jpg"
                filename = f"upload_{uuidlib.uuid4().hex[:8]}{ext}"
        except Exception as e:
            raise ValueError(f"解析 Base64 媒体数据失败: {e}")
    elif image_source.startswith("/storage/"):
        # 本地存储相对路径
        rel = image_source[len("/storage/"):]
        local_path = os.path.join(settings.STORAGE_DIR, rel)
        if os.path.exists(local_path):
            with open(local_path, "rb") as f:
                file_bytes = f.read()
            filename = os.path.basename(local_path)
            mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        else:
            raise FileNotFoundError(f"本地素材不存在: {image_source}")
    elif os.path.exists(image_source) and os.path.isfile(image_source):
        # 绝对文件路径
        with open(image_source, "rb") as f:
            file_bytes = f.read()
        filename = os.path.basename(image_source)
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    elif image_source.startswith("http://") or image_source.startswith("https://"):
        # 远程 HTTP URL
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(image_source)
            r.raise_for_status()
            file_bytes = r.content
            clean_url = image_source.split("?")[0]
            filename = os.path.basename(clean_url) or filename
            mime_type = r.headers.get("content-type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
            if ";" in mime_type:
                mime_type = mime_type.split(";")[0].strip()
    else:
        # 已是纯文件名 (如已经在 ComfyUI input 目录中)
        return image_source

    if not file_bytes:
        raise ValueError(f"无法读取媒体内容: {image_source}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        files = {"image": (filename, file_bytes, mime_type)}
        data = {"overwrite": "true"}
        r = await client.post(f"{server_url}/upload/image", files=files, data=data)
        r.raise_for_status()
        res_data = r.json()
        name = res_data.get("name") or filename
        sub = res_data.get("subfolder") or ""
        return f"{sub}/{name}" if sub else name



def auto_detect_exposed_inputs(clean_wf: Dict[str, Any], mapping: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """
    自动推导可暴露给外部表单的输入插槽 (LoadImage 垫图/参考图、额外提示词、触发词等)
    """
    exposed: List[Dict[str, Any]] = []
    mapping = mapping or {}
    primary_prompt_nid = str(mapping.get("prompt_node", ""))
    primary_neg_nid = str(mapping.get("negative_node", ""))

    for nid, node in clean_wf.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        title = node.get("_meta", {}).get("title") or ct
        inputs = node.get("inputs", {})

        # 1. 探测图片/音频/视频输入 (LoadImage / LoadAudio / LoadVideo)
        if ct in ("LoadImage", "LoadImageMask", "LoadImageForInpaint", "ImageLoad"):
            pval = inputs.get("image")
            is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
            if not is_linked:
                exposed.append({
                    "id": f"img_{nid}",
                    "node_id": str(nid),
                    "param_name": "image",
                    "label": f"参考垫图 ({title})",
                    "type": "image",
                    "required": False,
                    "default_value": pval if isinstance(pval, str) else "",
                    "description": "支持上传角色立绘、构图草图或姿态参考图，弹出文件系统",
                })
        elif ct in ("LoadAudio", "LoadAudio2", "AudioLoad"):
            pval = inputs.get("audio") or inputs.get("reference_audio")
            pname = "audio" if "audio" in inputs else "reference_audio"
            is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
            if not is_linked:
                exposed.append({
                    "id": f"aud_{nid}",
                    "node_id": str(nid),
                    "param_name": pname,
                    "label": f"参考音频 ({title})",
                    "type": "audio",
                    "required": False,
                    "default_value": pval if isinstance(pval, str) else "",
                    "description": "支持上传参考音频，弹出文件系统",
                })
        elif ct in ("LoadVideo", "VHS_LoadVideo", "VideoLoad"):
            pval = inputs.get("video") or inputs.get("image")
            pname = "video" if "video" in inputs else "image"
            is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
            if not is_linked:
                exposed.append({
                    "id": f"vid_{nid}",
                    "node_id": str(nid),
                    "param_name": pname,
                    "label": f"参考视频 ({title})",
                    "type": "video",
                    "required": False,
                    "default_value": pval if isinstance(pval, str) else "",
                    "description": "支持上传参考视频，弹出文件系统",
                })

        # 2. 探测独立文本提示词 (CLIPTextEncode / TextString / Primitive)
        elif ct in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux", "TextString", "PrimitiveStringMultiline", "PrimitiveString", "StringLiteral"):
            if str(nid) != primary_prompt_nid and str(nid) != primary_neg_nid:
                # 兼容 PrimitiveStringMultiline 的 value 字段
                if "value" in inputs:
                    pname = "value"
                elif "text" in inputs:
                    pname = "text"
                else:
                    pname = "string"
                pval = inputs.get(pname, "")
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if not is_linked:
                    exposed.append({
                        "id": f"txt_{nid}",
                        "node_id": str(nid),
                        "param_name": pname,
                        "label": f"风格/触发词 ({title})",
                        "type": "text",
                        "required": False,
                        "default_value": str(pval) if pval else "",
                        "description": "可在此输入额外的角色 LoRA 触发词或局部描述",
                    })

        # 2.1 探测 StringConcatenate 的可编辑文本段
        elif ct == "StringConcatenate":
            for sub_key in ("string_a", "string_b"):
                if sub_key in inputs:
                    pval = inputs.get(sub_key, "")
                    is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                    if not is_linked and isinstance(pval, str):
                        # 仅暴露非空或作为用户可编辑的 prompt 段
                        exposed.append({
                            "id": f"txt_{nid}_{sub_key}",
                            "node_id": str(nid),
                            "param_name": sub_key,
                            "label": f"文本段 {sub_key} ({title})",
                            "type": "text",
                            "required": False,
                            "default_value": str(pval)[:200] if pval else "",
                            "description": f"工作流中 {title} 节点的 {sub_key} 文本，可用于覆盖原始提示词",
                        })
        # 2.2 探测 KSampler 系采样参数（独立控件：steps/cfg/sampler/scheduler）
        elif ct in ("KSampler", "KSamplerAdvanced", "SamplerCustom"):
            for pname in ("steps", "cfg", "sampler_name", "scheduler", "denoise"):
                if pname in inputs:
                    pval = inputs.get(pname)
                    is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                    if is_linked:
                        continue
                    if pname == "steps":
                        exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"采样步数 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 20, "description": "采样步数 4-60", "min": 4, "max": 60, "step": 1})
                    elif pname == "cfg":
                        exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"CFG ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 7.0, "description": "CFG 1-15", "min": 1, "max": 15, "step": 0.5})
                    elif pname == "sampler_name":
                        exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"采样器 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "euler", "description": "采样器", "options": _combo_choices_from_oi(ct, pname, pval) or VALID_SAMPLERS})
                    elif pname == "scheduler":
                        exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"调度器 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "normal", "description": "调度器", "options": _combo_choices_from_oi(ct, pname, pval) or VALID_SCHEDULERS})
                    elif pname == "denoise":
                        exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"去噪 ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 1.0, "description": "去噪 0-1", "min": 0, "max": 1, "step": 0.05})
        # 2.3 探测 EmptyLatentImage 分辨率
        elif ct == "EmptyLatentImage":
            for pname in ("width", "height", "batch_size"):
                if pname in inputs:
                    pval = inputs.get(pname)
                    is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                    if not is_linked:
                        if pname in ("width","height"):
                            exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 1024, "description": "分辨率", "min": 256, "max": 2048, "step": 64})
                        else:
                            exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 1, "description": "", "min": 1, "max": 4, "step": 1})
        # 2.3.1 探测 VAELoader/LoraLoader/CheckpointLoader（模型下拉而非手填，原白名单选择项恢复）
        elif ct == "VAELoader":
            if "vae_name" in inputs:
                pval = inputs.get("vae_name")
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if not is_linked:
                    # 优先 ComfyUI object_info 真实枚举，离线时兜底当前值
                    vae_choices = _combo_choices_from_oi(ct, "vae_name", pval) or ([str(pval)] if pval else [])
                    exposed.append({"id": f"combo_{nid}_vae_name", "node_id": str(nid), "param_name": "vae_name", "label": f"VAE模型 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "qwen_image_vae.safetensors", "description": "VAE模型，下拉选择而非手填", "options": vae_choices[:50]})
        elif ct in ("LoraLoader", "LoraLoaderModelOnly"):
            for pname in ("lora_name", "strength_model", "strength_clip"):
                if pname not in inputs:
                    continue
                pval = inputs.get(pname)
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if is_linked:
                    continue
                if pname == "lora_name":
                    lora_choices = _combo_choices_from_oi(ct, "lora_name", pval) or ([str(pval)] if pval else [])
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"LoRA模型 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "", "description": "LoRA模型，下拉选择", "options": lora_choices[:50]})
                elif pname == "strength_model":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"LoRA强度-模型 ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 0.8, "description": "0-2", "min": 0, "max": 2, "step": 0.05})
                elif pname == "strength_clip":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"LoRA强度-CLIP ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 0.8, "description": "0-2", "min": 0, "max": 2, "step": 0.05})
        elif ct in ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader"):
            ckpt_key = "ckpt_name" if "ckpt_name" in inputs else "unet_name" if "unet_name" in inputs else None
            if ckpt_key:
                pval = inputs.get(ckpt_key)
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if not is_linked:
                    ckpt_choices = _combo_choices_from_oi(ct, ckpt_key, pval) or ([str(pval)] if pval else [])
                    exposed.append({"id": f"combo_{nid}_{ckpt_key}", "node_id": str(nid), "param_name": ckpt_key, "label": f"底模 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "", "description": "底模/UNet，下拉选择", "options": ckpt_choices[:50]})
        # 2.3.2 探测 ResolutionSelector（分辨率三件套独立控件，下拉/滑杆而非手填）
        elif ct == "ResolutionSelector":
            for pname in ("aspect_ratio", "megapixels", "multiple"):
                if pname not in inputs:
                    continue
                pval = inputs.get(pname)
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if is_linked:
                    continue
                if pname == "aspect_ratio":
                    # 枚举必须与 ComfyUI object_info 一致（如 "9:16 (Portrait Widescreen)"），
                    # 硬编码错值会被 ComfyUI 校验拒绝并软剪枝整条图像分支（表现为执行完成但无图）
                    ar_choices = _combo_choices_from_oi(ct, pname, pval) or ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "3:2 (Photo)", "4:3 (Standard)", "21:9 (Ultrawide)"]
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"画面比例 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "1:1 (Square)", "description": "画面比例 下拉", "options": ar_choices})
                elif pname == "megapixels":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"百万像素 ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 1.0, "description": "百万像素 0.5-4", "min": 0.5, "max": 4, "step": 0.5})
                elif pname == "multiple":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"倍数对齐 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 8, "description": "分辨率倍数对齐", "min": 1, "max": 64, "step": 1})
        # 2.4 探测 Wan 视频系（分辨率/时长/帧率 独立控件，下拉而非手填）
        elif ct in ("WanImageToVideo", "WanVaceToVideo", "WanFirstMiddleLastFrameToVideo", "CreateVideo", "WanVideoSampler"):
            for pname in ("width", "height", "resolution", "duration", "length", "num_frames", "frames", "fps", "frame_rate", "steps", "cfg", "seed"):
                if pname not in inputs:
                    continue
                pval = inputs.get(pname)
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if is_linked:
                    continue
                if pname in ("resolution",):
                    res_choices = _combo_choices_from_oi(ct, pname, pval) or ["480p", "720p", "1080p"]
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"分辨率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "720p", "description": "分辨率 480p/720p/1080p 下拉", "options": res_choices})
                elif pname in ("duration",):
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"时长秒 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 5, "description": "时长 3-15 秒", "min": 3, "max": 15, "step": 1})
                elif pname in ("length", "num_frames", "frames"):
                    # 帧数按 duration 推导，但仍暴露为独立滑杆
                    dv = int(pval) if isinstance(pval, (int,float)) else 81
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": dv, "description": "帧数 16~241", "min": 16, "max": 241, "step": 1})
                elif pname in ("fps", "frame_rate"):
                    fps_choices = _combo_choices_from_oi(ct, pname, pval) or ["16", "24", "30"]
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"帧率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "24", "description": "帧率", "options": fps_choices})
                elif pname in ("width", "height"):
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 720, "description": "分辨率宽/高", "min": 256, "max": 2048, "step": 64})
                elif pname == "steps":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"步数 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 20, "description": "步数 4-60", "min": 4, "max": 60, "step": 1})
                elif pname == "cfg":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"CFG ({title})", "type": "number", "required": False, "default_value": float(pval) if isinstance(pval, (int,float)) else 7.0, "description": "CFG 1-15", "min": 1, "max": 15, "step": 0.5})
                elif pname == "seed":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"随机种子 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 0, "description": "种子", "min": 0, "max": 9999999999, "step": 1})
        # 2.5 兜底：Wan 前缀的其它自定义视频节点（含 resolution/duration 通用暴露）
        elif ct.lower().startswith("wan"):
            for pname in ("resolution", "duration", "fps", "width", "height", "length", "frames"):
                if pname not in inputs:
                    continue
                pval = inputs.get(pname)
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if is_linked:
                    continue
                if pname == "resolution":
                    res_choices = _combo_choices_from_oi(ct, pname, pval) or ["480p", "720p", "1080p"]
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"分辨率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "720p", "description": "480p/720p/1080p", "options": res_choices})
                elif pname == "duration":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"时长 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 5, "description": "3-15秒", "min": 3, "max": 15, "step": 1})
                elif pname in ("fps",):
                    fps_choices = _combo_choices_from_oi(ct, pname, pval) or ["16", "24", "30"]
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"帧率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "24", "description": "帧率", "options": fps_choices})
                else:
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval,(int,float)) else 720, "description": pname, "min": 256, "max": 2048, "step": 64})
        # 3. 通用：暴露所有未链接的可编辑参数（而非仅用户选择暴露的），确保全部参数均有独立控件
        else:
            for pname, pval in inputs.items():
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if is_linked:
                    continue
                if pval is None:
                    continue
                options: Optional[List[str]] = None
                if isinstance(pval, bool):
                    ptype = "boolean"
                    default = pval
                elif isinstance(pval, (int, float)):
                    ptype = "number"
                    default = pval
                elif isinstance(pval, str):
                    # 优先以 object_info 判定 COMBO（新旧两种 schema：list 或 "COMBO"+options），原工作流的下拉选择项暴露后仍为下拉
                    combo_choices = _combo_choices_from_oi(ct, pname, pval)
                    if combo_choices:
                        ptype = "combo"
                        default = pval
                        options = combo_choices
                    elif any(k in pname.lower() for k in ("image", "frame", "video", "audio", "mask")):
                        if "image" in pname.lower() or "frame" in pname.lower():
                            ptype = "image"
                        elif "audio" in pname.lower():
                            ptype = "audio"
                        elif "video" in pname.lower():
                            ptype = "video"
                        else:
                            ptype = "image"
                        default = pval
                    elif pval.endswith((".safetensors", ".ckpt", ".pth", ".bin", ".pt")) or "vae" in pname.lower() or "ckpt" in pname.lower() or "lora" in pname.lower() or "unet" in pname.lower():
                        ptype = "combo"
                        default = pval
                    else:
                        ptype = "text"
                        default = pval
                    if isinstance(default, str) and len(default) > 500:
                        default = default[:500]
                else:
                    continue
                # 长文本截断
                if isinstance(default, str) and len(default) > 200 and ptype == "text":
                    default = default[:200]
                item = {
                    "id": f"exp_{nid}_{pname}",
                    "node_id": str(nid),
                    "param_name": pname,
                    "label": f"{pname} ({title})",
                    "type": ptype,
                    "required": False,
                    "default_value": default,
                    "description": f"{title} 的 {pname} 参数",
                }
                if options:
                    item["options"] = options
                exposed.append(item)

    return exposed


# ========== 暴露清单单点解析（工作流 = 生成源，两侧必须同源） ==========
def resolve_exposed_inputs(clean_wf: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    解析某工作流的最终暴露清单与映射，全系统唯一口径。
    白名单默认全关（空），只有用户在参数面板显式保存过的 exposed_inputs（exposed_source=user）才生效；
    随后叠加官方 App Mode 契约（meta.app_contract，来自工作流的 extra.linearData）：
    被契约声明的项拿到作者显示名与顺序并标记 declared，
    未被声明的项由 schema 生成侧收进隐藏层，从而不再把整张图摊平成参数表。
    """
    exposed, mapping = _resolve_exposed_raw(clean_wf, meta)
    try:
        apply_app_contract(exposed, (meta or {}).get("app_contract"))
    except Exception:
        pass
    return exposed, mapping


def _resolve_exposed_raw(clean_wf: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    暴露白名单默认全关：仅当用户在参数面板显式保存过清单（meta.exposed_source == "user"）时，
    已存的 exposed_inputs 才是权威白名单；auto_detect 的新鲜探测只用于刷新白名单条目的
    真实控件类型、步长/范围与枚举项，绝不再作为默认暴露来源，也绝不倒灌未勾选的参数！
    """
    meta = meta or {}
    try:
        current_mapping = meta.get("mapping") or auto_generate_mapping(analyze_workflow(clean_wf))
    except Exception:
        current_mapping = {}

    # 默认不暴露任何输入：未由用户显式配置过白名单的工作流一律返回空清单
    if meta.get("exposed_source") != "user":
        return [], current_mapping
    saved_exposed = meta.get("exposed_inputs")
    if not saved_exposed:
        return [], current_mapping

    # 过滤掉 undefined 脏项
    valid_saved = [
        e for e in saved_exposed
        if isinstance(e, dict) and e.get('param_name') and e.get('param_name') != 'undefined' and not str(e.get('id', '')).endswith('_undefined')
    ]
    if not valid_saved:
        return [], current_mapping

    try:
        fresh_exposed = auto_detect_exposed_inputs(clean_wf, current_mapping)
    except Exception:
        fresh_exposed = []

    # 用户已保存的 exposed_inputs 即为唯一的权威白名单！
    type_fix_map = {f"{e['node_id']}_{e['param_name']}": e for e in fresh_exposed if isinstance(e, dict)}
    keep_user_keys = ('label', 'alias', 'description', 'default_value', 'required', 'display_order', 'group', 'declared', 'app_order')
    exposed_inputs: List[Dict[str, Any]] = []

    for se in valid_saved:
        key = f"{se.get('node_id')}_{se.get('param_name')}"
        fe = type_fix_map.get(key)
        if fe:
            merged = {**fe}
            for k in keep_user_keys:
                v = se.get(k)
                if v not in (None, ''):
                    merged[k] = v
            # ComfyUI 离线时新鲜探测会把 combo/number 退化成 text（id 前缀也随之从 combo_ 掉成 exp_），
            # 此时必须保留已存条目的类型与 id，否则下拉框会整体退化为手填输入。
            if fe.get('type') == 'text' and se.get('type') in ('combo', 'number', 'boolean', 'image', 'video', 'audio'):
                merged['type'] = se['type']
                if se.get('id'):
                    merged['id'] = se['id']
            fresh_opts = [str(o) for o in (fe.get('options') or fe.get('choices') or [])]
            user_opts = [str(o) for o in (se.get('options') or se.get('choices') or []) if o not in fresh_opts]
            opts = list(dict.fromkeys(fresh_opts + user_opts))
            if opts:
                merged['options'] = opts
                merged['choices'] = opts
            for mk in ("min", "max", "step"):
                if fe.get(mk) is not None:
                    merged[mk] = fe[mk]
            exposed_inputs.append(merged)
        else:
            exposed_inputs.append(se)

    return exposed_inputs, current_mapping


# 标准参数语义表：命中则决定分组/暴露级别/人机分工，未命中一律 advanced + suggest
WF_PARAM_SEMANTICS: Dict[str, Dict[str, Any]] = {
    "aspect_ratio":     {"x-category": "layout",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 10},
    "resolution":       {"x-category": "layout",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 20},
    "width":            {"x-category": "layout",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 21},
    "height":           {"x-category": "layout",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 22},
    "duration":         {"x-category": "motion",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 30},
    "frame_rate":       {"x-category": "motion",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 31},
    "fps":              {"x-category": "motion",  "x-visibility": "basic",    "x-agent": "auto",    "x-priority": 31},
    "steps":            {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 40},
    "cfg":              {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
    "denoise":          {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 43},
    "sampler_name":     {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 44},
    "scheduler":        {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 45},
    "unet_name":        {"x-category": "quality", "x-visibility": "basic",    "x-agent": "manual",  "x-priority": 4},
    "ckpt_name":        {"x-category": "quality", "x-visibility": "basic",    "x-agent": "manual",  "x-priority": 3},
    "clip_name":        {"x-category": "quality", "x-visibility": "advanced", "x-agent": "manual",  "x-priority": 46},
    "vae_name":         {"x-category": "quality", "x-visibility": "basic",    "x-agent": "manual",  "x-priority": 5},
    "lora_name":        {"x-category": "quality", "x-visibility": "basic",    "x-agent": "manual",  "x-priority": 6},
    "seed":             {"x-category": "quality", "x-visibility": "advanced", "x-agent": "manual",  "x-priority": 99},
    "filename_prefix":  {"x-category": "advanced", "x-visibility": "hidden",  "x-agent": "manual",  "x-priority": 200},
}


def wf_std_alias(pname: str) -> Optional[str]:
    """暴露项参数名 → 标准名（先精确后包含，长名优先以免 fps 抢先命中 frame_rate 之类）"""
    low = str(pname or "").lower()
    if not low:
        return None
    if low in WF_PARAM_SEMANTICS:
        return low
    for k in sorted(WF_PARAM_SEMANTICS.keys(), key=len, reverse=True):
        if k in low:
            return k
    return None


NON_PROMPT_TEXT_PARAMS = ("filename", "prefix", "name", "path", "directory", "folder", "seed")
SYSTEM_PROMPT_MARKERS = ("system", "系统")
USER_PROMPT_MARKERS = ("user", "用户", "正向")


def pick_prompt_text_slot(exposed: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    选出工作流真正承接用户提示词的文本暴露项（单点规则，init_providers 注入与此必须一致）。
    两条陷阱必须避开：
    ① 文本型暴露项还包含 filename_prefix / 路径等非创作输入，要先排除，否则 prompt 会绑到 SaveImage 参数上；
    ② "System Prompt" 与 "User Prompt" 都含 prompt 字样，若按 prompt 匹配会把用户输入写进系统提示词节点，
       因此用户标记优先命中，系统标记项排到最后。
    """
    def _is_mechanical(e: Dict[str, Any]) -> bool:
        pname = str(e.get("param_name", "")).lower()
        if any(t in pname for t in NON_PROMPT_TEXT_PARAMS):
            return True
        return wf_std_alias(pname) is not None

    def _lab(e: Dict[str, Any]) -> str:
        return f"{e.get('label', '') or ''}{e.get('alias', '') or ''}{e.get('description', '') or ''}".lower()

    candidates = [e for e in (exposed or []) if str(e.get("type")) == "text" and not _is_mechanical(e)]
    if not candidates:
        return None
    for e in candidates:
        if any(m in _lab(e) for m in USER_PROMPT_MARKERS) or "提示词" in _lab(e):
            return e
    for e in candidates:
        pn = str(e.get("param_name", "")).lower()
        if pn in ("prompt", "value", "text", "string") or pn.startswith("string_"):
            return e
    free = [e for e in candidates if not any(m in _lab(e) for m in SYSTEM_PROMPT_MARKERS)]
    if free:
        return free[0]
    return candidates[0]


# ========== ComfyUI 官方 App Mode 契约（extra.linearMode / extra.linearData） ==========
# 官方结构：extra.linearData = { "inputs": [ [WidgetId, 显示名, config?] ], "outputs": [NodeId] }
#           WidgetId = "graphId:nodeId:widgetName"（子图节点 id 自身含冒号，故 node 取中段重拼）
def parse_linear_widget_id(widget_id: str) -> Tuple[Optional[str], Optional[str]]:
    """WidgetId → (node_id, widget_name)；解析失败返回 (None, None)"""
    parts = str(widget_id or "").split(":")
    if len(parts) < 3:
        return None, None
    node_id = ":".join(parts[1:-1]).strip()
    widget = parts[-1].strip()
    return (node_id or None), (widget or None)


def extract_app_contract(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    从 UI/Save 格式工作流里抽取 App Mode 契约。
    API 格式导出（顶层即节点表）不含 extra，因此必须在转换前抽取、或从外部原始文件回读，
    随后作为 meta.app_contract 持久化 —— 图文件本身始终保持纯节点表。
    """
    if not isinstance(data, dict):
        return None
    extra = data.get("extra")
    if not isinstance(extra, dict):
        return None
    ld = extra.get("linearData")
    if not isinstance(ld, dict):
        return None
    raw_inputs = ld.get("inputs") or []
    raw_outputs = ld.get("outputs") or []
    inputs: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw_inputs):
        if isinstance(item, (list, tuple)):
            wid = str(item[0]) if len(item) > 0 else ""
            name = str(item[1]) if len(item) > 1 and item[1] else ""
            config = item[2] if len(item) > 2 and isinstance(item[2], dict) else {}
        elif isinstance(item, dict):
            wid = str(item.get("id") or item.get("widgetId") or "")
            name = str(item.get("name") or item.get("label") or "")
            config = {k: v for k, v in item.items() if k not in ("id", "widgetId", "name", "label")}
        else:
            continue
        node_id, widget = parse_linear_widget_id(wid)
        if not node_id or not widget:
            continue
        inputs.append({
            "widget_id": wid, "node_id": node_id, "param_name": widget,
            "display_name": name, "order": idx, "config": config,
        })
    outputs = [{"node_id": str(n)} for n in raw_outputs if str(n).strip()]
    if not inputs and not outputs:
        return None
    return {"linear_mode": bool(extra.get("linearMode")), "inputs": inputs, "outputs": outputs}


def apply_app_contract(exposed: List[Dict[str, Any]], contract: Optional[Dict[str, Any]]) -> bool:
    """
    把契约标注到暴露项上：declared=True / 作者显示名 / 契约顺序（决定 x-priority）。
    返回是否存在有效契约（决定未声明项是否该收进隐藏层）。
    """
    inputs = (contract or {}).get("inputs") or []
    if not inputs:
        return False
    by_key = {(str(i.get("node_id")), str(i.get("param_name"))): i for i in inputs}
    for exp in exposed:
        hit = by_key.get((str(exp.get("node_id")), str(exp.get("param_name"))))
        if not hit:
            continue
        exp["declared"] = True
        exp["app_order"] = hit.get("order")
        dn = str(hit.get("display_name") or "").strip()
        if dn:
            exp["label"] = dn
            exp["alias"] = dn
        cfg = hit.get("config") or {}
        if isinstance(cfg.get("description"), str) and cfg["description"].strip():
            exp["description"] = cfg["description"].strip()
    return any(e.get("declared") for e in exposed)


class ComfyWorkflowManager:
    # ----- 内部工作流 -----
    def list_internal_workflows(self) -> List[Dict[str, Any]]:
        result = []
        if not os.path.exists(WORKFLOWS_DIR):
            return result
        for fname in os.listdir(WORKFLOWS_DIR):
            if fname.endswith(".meta.json"):
                try:
                    with open(os.path.join(WORKFLOWS_DIR, fname), "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    meta["source"] = "internal"
                    result.append(meta)
                except Exception:
                    continue
        for fname in os.listdir(WORKFLOWS_DIR):
            if fname.endswith(".json") and not fname.endswith(".meta.json"):
                wid = fname[:-5]
                if not os.path.exists(_meta_path(wid)):
                    try:
                        with open(os.path.join(WORKFLOWS_DIR, fname), "r", encoding="utf-8") as f:
                            wf = json.load(f)
                        analysis = analyze_workflow(wf)
                        meta = {
                            "id": wid,
                            "name": wid,
                            "description": "自动识别",
                            "created_at": os.path.getmtime(os.path.join(WORKFLOWS_DIR, fname)),
                            "mapping": auto_generate_mapping(analysis),
                            "analysis": analysis,
                            "node_count": len(wf),
                            "source": "internal",
                        }
                        result.append(meta)
                    except Exception:
                        pass
        return result

    # ----- 外部目录直读 -----
    def list_external_workflows(self) -> List[Dict[str, Any]]:
        ext_dir = _get_external_workflows_dir()
        if not ext_dir or not os.path.exists(ext_dir):
            return []
        # 慢盘保护：网盘/OneDrive 等同步盘可能极慢，限制扫描
        if any(k in ext_dir for k in ["网盘", "OneDrive", "BaiduNetdisk"]):
            # 仅扫描顶层 1 层，不递归，且限 50 文件
            result = []
            try:
                for entry in os.scandir(ext_dir):
                    if entry.is_file() and entry.name.lower().endswith(".json"):
                        fpath = entry.path
                        rel = os.path.relpath(fpath, ext_dir)
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                data = __import__("json").load(f)
                        except Exception as e:
                            result.append({"id": _external_id_for_path(fpath), "name": os.path.splitext(entry.name)[0], "file_path": fpath, "relative_path": rel, "source": "external", "is_api_format": False, "error": f"JSON解析失败: {e}", "node_count": 0})
                            continue
                        ok, msg = is_api_format_workflow(data)
                        if ok:
                            analysis = analyze_workflow(data)
                            result.append({"id": _external_id_for_path(fpath), "name": os.path.splitext(entry.name)[0], "file_path": fpath, "relative_path": rel, "source": "external", "is_api_format": True, "analysis": analysis, "mapping": auto_generate_mapping(analysis), "node_count": len(data), "created_at": os.path.getmtime(fpath), "warnings": [], "auto_converted": False})
                        elif is_save_format_workflow(data):
                            try:
                                converted = convert_save_format_to_api_format(data)
                                analysis = analyze_workflow(converted)
                                result.append({"id": _external_id_for_path(fpath), "name": os.path.splitext(entry.name)[0], "file_path": fpath, "relative_path": rel, "source": "external", "is_api_format": True, "analysis": analysis, "mapping": auto_generate_mapping(analysis), "node_count": len(converted), "created_at": os.path.getmtime(fpath), "warnings": [], "auto_converted": True})
                            except Exception as ce:
                                result.append({"id": _external_id_for_path(fpath), "name": os.path.splitext(entry.name)[0], "file_path": fpath, "relative_path": rel, "source": "external", "is_api_format": False, "error": f"自动转换失败: {ce}", "node_count": 0, "hint": "请在ComfyUI中打开后 File→Export (API Format) 另存为API格式"})
                        else:
                            result.append({"id": _external_id_for_path(fpath), "name": os.path.splitext(entry.name)[0], "file_path": fpath, "relative_path": rel, "source": "external", "is_api_format": False, "error": msg, "node_count": 0, "hint": "不支持的工作流格式"})
                        if len(result) >= 50:
                            break
            except Exception as e:
                import logging; logging.getLogger(__name__).warning(f"[WorkflowManager] slow dir scan skipped {ext_dir}: {e}")
                return []
            return result
        result = []
        for root, _, files in os.walk(ext_dir):
            for fname in files:
                if not fname.lower().endswith(".json"):
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, ext_dir)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except Exception as e:
                    result.append({
                        "id": _external_id_for_path(fpath),
                        "name": os.path.splitext(fname)[0],
                        "file_path": fpath,
                        "relative_path": rel,
                        "source": "external",
                        "is_api_format": False,
                        "error": f"JSON解析失败: {e}",
                        "node_count": 0,
                    })
                    continue
                ok, msg = is_api_format_workflow(data)
                if ok:
                    analysis = analyze_workflow(data)
                    result.append({
                        "id": _external_id_for_path(fpath),
                        "name": os.path.splitext(fname)[0],
                        "file_path": fpath,
                        "relative_path": rel,
                        "source": "external",
                        "is_api_format": True,
                        "analysis": analysis,
                        "mapping": auto_generate_mapping(analysis),
                        "node_count": len(data),
                        "created_at": os.path.getmtime(fpath),
                        "warnings": [],
                        "auto_converted": False,
                    })
                elif is_save_format_workflow(data):
                    try:
                        converted = convert_save_format_to_api_format(data)
                        analysis = analyze_workflow(converted)
                        result.append({
                            "id": _external_id_for_path(fpath),
                            "name": os.path.splitext(fname)[0],
                            "file_path": fpath,
                            "relative_path": rel,
                            "source": "external",
                            "is_api_format": True,
                            "analysis": analysis,
                            "mapping": auto_generate_mapping(analysis),
                            "node_count": len(converted),
                            "created_at": os.path.getmtime(fpath),
                            "warnings": [],
                            "auto_converted": True,
                        })
                    except Exception as ce:
                        result.append({
                            "id": _external_id_for_path(fpath),
                            "name": os.path.splitext(fname)[0],
                            "file_path": fpath,
                            "relative_path": rel,
                            "source": "external",
                            "is_api_format": False,
                            "error": f"自动转换失败: {ce}",
                            "node_count": 0,
                            "hint": "请在ComfyUI中打开后 File→Export (API Format) 另存为API格式",
                        })
                else:
                    result.append({
                        "id": _external_id_for_path(fpath),
                        "name": os.path.splitext(fname)[0],
                        "file_path": fpath,
                        "relative_path": rel,
                        "source": "external",
                        "is_api_format": False,
                        "error": msg,
                        "node_count": 0,
                        "hint": "不支持的工作流格式",
                    })
        return result

    _list_cache: Optional[List[Dict[str, Any]]] = None
    _list_cache_ts: float = 0
    _list_cache_ttl: float = 12.0

    def list_workflows(self, source: str = "all") -> List[Dict[str, Any]]:
        """
        source: all | internal | external
        默认 all 会合并内部+外部，外部可直接使用无需导入
        带 12s 缓存，避免 D:/网盘 等慢盘反复 os.walk 阻塞事件循环
        """
        # 缓存仅对 all 生效，internal/external 仍实时
        if source == "all" and self._list_cache is not None and (time.time() - self._list_cache_ts) < self._list_cache_ttl:
            return self._list_cache
        internal = self.list_internal_workflows() if source in ("all", "internal") else []
        # 外部目录可能在慢盘，捕获异常并限时
        try:
            external = self.list_external_workflows() if source in ("all", "external") else []
        except Exception as e:
            logger.warning(f"[WorkflowManager] list_external failed: {e}")
            external = []
        all_wfs = internal + external
        # 去重：同一 id 的工作流（外部直读 vs 已导入内部）优先保留内部（已保存的配置），避免出现两个
        seen = {}
        deduped = []
        for wf in all_wfs:
            wid = wf.get("id")
            if wid not in seen:
                seen[wid] = wf
                deduped.append(wf)
            else:
                existing = seen[wid]
                # 已有同 id，保留内部优先（已保存的配置）
                if existing.get("source") != "internal" and wf.get("source") == "internal":
                    idx = deduped.index(existing)
                    deduped[idx] = wf
                    seen[wid] = wf
        deduped.sort(key=lambda x: (x.get("source") != "internal", -x.get("created_at", 0)))
        all_wfs = deduped
        if source == "all":
            self._list_cache = all_wfs
            self._list_cache_ts = time.time()
        return all_wfs

    def get_external_dir(self) -> Optional[str]:
        return _get_external_workflows_dir()

    def get_workflow(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        path = _json_path(workflow_id)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        if workflow_id.startswith("ext_"):
            for wf_meta in self.list_external_workflows():
                if wf_meta["id"] == workflow_id:
                    fpath = wf_meta.get("file_path")
                    if fpath and os.path.exists(fpath):
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                data = json.load(f)
                            ok, _ = is_api_format_workflow(data)
                            if ok:
                                return data
                            if is_save_format_workflow(data):
                                try:
                                    return convert_save_format_to_api_format(data)
                                except Exception:
                                    return None
                        except Exception:
                            return None
        return None

    def get_meta(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        path = _meta_path(workflow_id)
        saved_meta = None
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    saved_meta = json.load(f)
            except Exception:
                saved_meta = None

        if workflow_id.startswith("ext_"):
            found_ext = None
            for wf_meta in self.list_external_workflows():
                if wf_meta["id"] == workflow_id:
                    found_ext = copy.deepcopy(wf_meta)
                    break
            if found_ext:
                if saved_meta:
                    if "mapping" in saved_meta:
                        found_ext["mapping"] = saved_meta["mapping"]
                    if "node_overrides" in saved_meta:
                        found_ext["node_overrides"] = saved_meta["node_overrides"]
                    if "exposed_inputs" in saved_meta:
                        found_ext["exposed_inputs"] = saved_meta["exposed_inputs"]
                    if "exposed_source" in saved_meta:
                        found_ext["exposed_source"] = saved_meta["exposed_source"]
                return found_ext
            return saved_meta

        if saved_meta:
            saved_meta["source"] = "internal"
            return saved_meta
        return None

    def get_workflow_with_meta(self, workflow_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        meta = self.get_meta(workflow_id)
        if workflow_id.startswith("ext_"):
            fpath = meta.get("file_path") if meta else None
            if not fpath:
                for wf_meta in self.list_external_workflows():
                    if wf_meta["id"] == workflow_id:
                        fpath = wf_meta.get("file_path")
                        break
            if not fpath or not os.path.exists(fpath):
                return None, None
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                ok, _ = is_api_format_workflow(data)
                if not ok and is_save_format_workflow(data):
                    try:
                        data = convert_save_format_to_api_format(data)
                    except Exception:
                        return data, meta
                return data, meta
            except Exception:
                return None, None
        wf = self.get_workflow(workflow_id)
        return wf, meta

    def save_workflow(self, name: str, workflow_json: Dict[str, Any], mapping: Optional[Dict[str, str]] = None, description: str = "",
                      app_contract: Optional[Dict[str, Any]] = None, source_file: Optional[str] = None) -> Dict[str, Any]:
        converted = False
        # App Mode 契约只存在于 UI/Save 格式，转成 API 格式前必须先抽取
        if app_contract is None:
            app_contract = extract_app_contract(workflow_json)
        if is_save_format_workflow(workflow_json):
            try:
                workflow_json = convert_save_format_to_api_format(workflow_json)
                converted = True
            except Exception as ce:
                raise ValueError(f"Save Format 自动转换失败: {ce}，请在 ComfyUI 中用 File→Export (API Format) 重新导出")
        else:
            ok, msg = is_api_format_workflow(workflow_json)
            if not ok:
                raise ValueError(msg)
        warnings = []
        for nid, node in workflow_json.items():
            ct = node.get("class_type", "")
            if ct not in ALLOWED_CLASS_TYPES and ct not in ("ConditioningCombine",):
                warnings.append(f"节点 {nid} 使用非常规类型 {ct}，请确认ComfyUI已安装对应插件")
        workflow_id = f"wf_{uuid.uuid4().hex[:8]}"
        if not name:
            name = workflow_id
        json_path = _json_path(workflow_id)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(workflow_json, f, ensure_ascii=False, indent=2)
        analysis = analyze_workflow(workflow_json)
        if mapping is None:
            mapping = auto_generate_mapping(analysis)
        for k, nid in list(mapping.items()):
            if nid not in workflow_json:
                mapping.pop(k)
                warnings.append(f"映射 {k}->{nid} 节点不存在已移除")
        if converted:
            warnings.insert(0, "已自动将 Save Format 转换为 API Format")
        meta = {
            "id": workflow_id,
            "name": name,
            "description": description,
            "created_at": time.time(),
            "updated_at": time.time(),
            "mapping": mapping,
            "analysis": analysis,
            "node_count": len(workflow_json),
            "warnings": warnings,
            "source": "internal",
            "auto_converted": converted,
            "app_contract": app_contract,
            "source_file": source_file,
        }
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        # 同步为独立生成源 Provider（每工作流一源）
        try:
            sync_workflow_provider(workflow_id)
        except Exception:
            pass
        return meta

    def import_external_workflow(self, external_id: str, new_name: Optional[str] = None) -> Dict[str, Any]:
        """将外部工作流导入为内部持久化工作流"""
        wf, meta = self.get_workflow_with_meta(external_id)
        if not wf or not meta:
            raise FileNotFoundError(f"外部工作流不存在: {external_id}")
        if not meta.get("is_api_format"):
            raise ValueError(f"该外部工作流非API Format，无法导入: {meta.get('error')}")
        # 外部原文件是 UI 格式才含 extra.linearData；转成 API 格式后契约即丢失，必须回读原文件抽取
        contract = self._contract_from_file(meta.get("file_path"))
        return self.save_workflow(
            name=new_name or meta.get("name", "imported"),
            workflow_json=wf,
            mapping=meta.get("mapping"),
            description=f"从 {meta.get('file_path')} 导入",
            app_contract=contract,
            source_file=meta.get("file_path"),
        )

    @staticmethod
    def _contract_from_file(file_path: Optional[str]) -> Optional[Dict[str, Any]]:
        if not file_path or not os.path.exists(file_path):
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return extract_app_contract(json.load(f))
        except Exception:
            return None

    def refresh_app_contract(self, workflow_id: str) -> Dict[str, Any]:
        """
        重新从来源文件读取 App Mode 契约（用户在 ComfyUI App Builder 里改完勾选后调用）。
        找不到来源文件时清空契约，回落到"高级/隐藏"分层策略。
        """
        if workflow_id.startswith("ext_"):
            raise ValueError("外部工作流为只读，请先导入为内部工作流")
        meta = self.get_meta(workflow_id)
        if not meta:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        contract = self._contract_from_file(meta.get("source_file"))
        meta["app_contract"] = contract
        # 白名单默认全关；用户点击"读取 App 契约"即视为显式选择：把作者声明的输入播种进白名单
        if contract and contract.get("inputs") and meta.get("exposed_source") != "user":
            try:
                wf = self.get_workflow(workflow_id)
                if wf:
                    clean_wf = self.sanitize_workflow(copy.deepcopy(wf))
                    fresh = auto_detect_exposed_inputs(clean_wf, meta.get("mapping") or {})
                    declared = {(str(i.get("node_id")), str(i.get("param_name"))) for i in contract["inputs"]}
                    picked = [e for e in fresh if (str(e.get("node_id")), str(e.get("param_name"))) in declared]
                    if picked:
                        meta["exposed_inputs"] = picked
                        meta["exposed_source"] = "user"
            except Exception:
                pass
        meta["updated_at"] = time.time()
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        try:
            sync_workflow_provider(workflow_id, force=True)
        except Exception:
            pass
        return {"workflow_id": workflow_id, "app_contract": contract}

    def update_mapping(self, workflow_id: str, mapping: Dict[str, str]) -> Dict[str, Any]:
        # 外部工作流的映射仅内存生效，不持久化到外部文件；如需持久化请先导入
        if workflow_id.startswith("ext_"):
            raise ValueError("外部工作流映射为只读，请先调用 /images/workflows/import/{id} 导入为内部工作流后再编辑")
        meta = self.get_meta(workflow_id)
        if not meta:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        wf = self.get_workflow(workflow_id)
        for k, nid in mapping.items():
            if nid not in wf:
                raise ValueError(f"映射节点 {nid} 不存在于工作流中")
        meta["mapping"] = mapping
        meta["updated_at"] = time.time()
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    def delete_workflow(self, workflow_id: str):
        if workflow_id.startswith("ext_"):
            raise ValueError("外部工作流为只读，不能删除。请直接在文件系统中删除对应JSON文件")
        jp = _json_path(workflow_id)
        mp = _meta_path(workflow_id)
        if os.path.exists(jp):
            os.remove(jp)
        if os.path.exists(mp):
            os.remove(mp)
        # 同步删除对应 Provider
        try:
            remove_workflow_provider(workflow_id)
        except Exception:
            pass

    def sanitize_workflow(self, workflow: Dict[str, Any], aggressive: bool = False) -> Dict[str, Any]:
        """
        智能清理工作流（参考官方 CLI 逻辑）：
        - 基础模式（aggressive=False，默认）：仅剥离 UI 注释节点 + 清理孤儿连线，保留所有可执行节点（与前端 graphToPrompt 一致，防误删）
        - 激进模式（aggressive=True）：额外基于终端输出节点逆向追踪可达依赖图，剔除悬空孤立节点以避免缺少自定义插件导致 400

        兼容官方 CLI 的 _UI_ONLY_NODE_TYPES 与 _strip_orphan_link_inputs 逻辑。
        """
        if not isinstance(workflow, dict) or not workflow:
            return workflow

        # 1. 官方 CLI 定义的 UI-only 类型（永远不出现在 API 输出中）
        CLI_UI_ONLY = {"Note", "MarkdownNote", "PrimitiveNode", "GetNode", "SetNode", "Reroute"}
        # 扩展：本项目历史过滤的注释类型（含 rgthree-comfy 的 Label 标题装饰节点，无输入输出，缺插件会导致 missing_node_type）
        NON_EXECUTABLE_CLASSES = CLI_UI_ONLY | {
            "TextNote", "WorkflowNotes", "GroupNote",
            "Comment", "DisplayNote", "PrimitiveNodeNote", "EasyMarkdown",
            "CR Note", "CR Text", "Markdown", "LoadImageOutput",
            "Label",
        }

        # 先过滤纯注释节点
        filtered = {
            k: v for k, v in workflow.items()
            if isinstance(v, dict) and v.get("class_type") not in NON_EXECUTABLE_CLASSES
        }
        if not filtered:
            # 若过滤后为空（极端情况），至少尝试仅过滤最严格的 CLI_UI_ONLY，保留其他
            filtered = {
                k: v for k, v in workflow.items()
                if isinstance(v, dict) and v.get("class_type") not in CLI_UI_ONLY
            }
            if not filtered:
                return workflow

        # 1.5 自动修复 KSampler 类型错乱（历史脏数据）
        try:
            _fix_workflow_ksamplers(filtered)
        except Exception:
            pass

        # 2. 清理孤儿连线（引用了不存在节点的输入），与官方 CLI 的 _strip_orphan_link_inputs 保持一致
        if _HAS_CLI_CONVERTER:
            try:
                _cli_converter._strip_orphan_link_inputs(filtered)
            except Exception:
                # 回退：手工清理
                for node in filtered.values():
                    inputs = node.get("inputs")
                    if not isinstance(inputs, dict):
                        continue
                    for name in list(inputs):
                        val = inputs[name]
                        if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] not in filtered:
                            del inputs[name]
        else:
            for node in filtered.values():
                inputs = node.get("inputs")
                if not isinstance(inputs, dict):
                    continue
                for name in list(inputs):
                    val = inputs[name]
                    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] not in filtered:
                        del inputs[name]

        # 3. 非激进模式直接返回（官方推荐：保留所有非虚拟节点，避免误删）
        if not aggressive:
            return filtered

        # 4. 激进模式：基于终端输出节点做可达性剪枝
        OUTPUT_CLASSES = {
            "SaveImage", "PreviewImage", "SaveImageWebsocket",
            "VHS_VideoCombine", "SaveAnimatedWEBP", "VideoCombine", "SaveAudio",
            "SaveImageAdvanced", "ImageSave"
        }
        output_nodes = {str(nid) for nid, node in filtered.items() if node.get("class_type") in OUTPUT_CLASSES}
        if output_nodes:
            reachable = set(output_nodes)
            queue = list(output_nodes)
            while queue:
                curr_id = queue.pop(0)
                node = filtered.get(curr_id)
                if not isinstance(node, dict):
                    continue
                for in_val in node.get("inputs", {}).values():
                    if isinstance(in_val, list) and len(in_val) == 2:
                        src_id = str(in_val[0])
                        if src_id in filtered and src_id not in reachable:
                            reachable.add(src_id)
                            queue.append(src_id)
            cleaned = {k: v for k, v in filtered.items() if str(k) in reachable}
            if cleaned:
                # 再次清理孤儿连线（剪枝后可能产生新孤儿）
                if _HAS_CLI_CONVERTER:
                    try:
                        _cli_converter._strip_orphan_link_inputs(cleaned)
                    except Exception:
                        pass
                return cleaned
        return filtered

    # 提交前可安全剥离的装饰类节点（无输入输出、纯画布装饰）
    DECORATIVE_NODE_TYPES = frozenset({"Label"})

    def strip_unsupported_nodes(self, prompt, object_info=None):
        """提交 /prompt 前最后一道防线（输入为 API-format prompt）。

        - 装饰类（Label 等）：一律剥离并清理孤儿引用；
        - object_info 中不存在的 class_type：无任何连线引用则剥离（保主链路不断），
          被其他节点引用则抛 RuntimeError，明确提示安装对应插件（fail fast，
          比 ComfyUI 400 更易懂）；
        - object_info 取不到（服务器离线）时只做装饰剥离，不做未知判定。

        返回 (cleaned_prompt, stripped[{id, class_type, title}])。
        """
        if not isinstance(prompt, dict) or not prompt:
            return prompt, []
        cleaned = {k: v for k, v in prompt.items() if isinstance(v, dict)}
        stripped = []
        for nid in [k for k, v in cleaned.items() if v.get("class_type") in self.DECORATIVE_NODE_TYPES]:
            node = cleaned[nid]
            stripped.append({
                "id": str(nid),
                "class_type": node.get("class_type"),
                "title": str((node.get("_meta") or {}).get("title", "") or ""),
            })
            del cleaned[nid]
        # 收集被其他节点输入引用的 id
        referenced = set()
        for node in cleaned.values():
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for val in inputs.values():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], (str, int)):
                    referenced.add(str(val[0]))
        if object_info is None:
            try:
                object_info = _fetch_object_info()
            except Exception:
                object_info = None
        if isinstance(object_info, dict) and object_info:
            known = set(object_info.keys())
            for nid, node in list(cleaned.items()):
                ct = node.get("class_type")
                if not ct or ct in known:
                    continue
                title = str((node.get("_meta") or {}).get("title", "") or "") or ct
                if str(nid) in referenced:
                    raise RuntimeError(
                        f"ComfyUI 缺少运行此工作流所需的自定义插件节点 [{ct}] (节点: '{title}', ID #{nid})。\n"
                        f"💡 解决方法：\n"
                        f"1. 请在 ComfyUI Manager (插件管理器) 中搜索并安装包含 '{ct}' 的插件包后重启 ComfyUI；\n"
                        f"2. 或在 ComfyUI 画布中移除或替换此节点后重新导出/重新导入工作流。"
                    )
                stripped.append({"id": str(nid), "class_type": ct, "title": title})
                del cleaned[nid]
        # 清理剥离后产生的孤儿引用
        for node in cleaned.values():
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for name in list(inputs):
                val = inputs[name]
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], (str, int)) and str(val[0]) not in cleaned:
                    del inputs[name]
        return cleaned, stripped

    def inject_params(
        self,
        workflow: Dict[str, Any],
        mapping: Dict[str, str],
        params: Dict[str, Any],
        node_overrides: Optional[Dict[str, Dict[str, Any]]] = None,
        dynamic_inputs: Optional[Dict[str, Any]] = None,
        is_api_frugally: bool = False,
    ) -> Dict[str, Any]:
        """
        通用参数注入（图像等）
        - is_api_frugally=True  (API原生)：仅注入 mapping 指向节点与 node_overrides，保留其他原值（节俭）
        - is_api_frugally=False (UI转换后)：全量覆盖，页面参数覆盖原值
        """
        # 1. 先进行智能节点清洗，剥离注释与悬空孤立节点（节俭模式用非激进清理）
        wf = self.sanitize_workflow(copy.deepcopy(workflow), aggressive=False)

        # 2. 应用用户自定义节点参数覆写（带枚举护栏）
        if node_overrides:
            for nid, overrides in node_overrides.items():
                if str(nid) in wf and isinstance(overrides, dict):
                    for k, v in overrides.items():
                        if v is not None:
                            _set_input_guarded(wf, str(nid), k, v)

        # 3. 外部动态输入延后至最后处理（确保暴露输入最终生效，见步骤 7）

        if "prompt" in params and params["prompt"]:
            prompt_text = params["prompt"]
            if params.get("style_suffix"):
                prompt_text = f"{prompt_text}, {params['style_suffix']}"
            # 兼容 CLI 的动态提示词语法 {a|b|c}：若存在则随机解析为一项（与前端一致）
            if _HAS_CLI_CONVERTER and isinstance(prompt_text, str) and "{" in prompt_text and "|" in prompt_text:
                try:
                    prompt_text = _cli_converter.process_dynamic_prompt(prompt_text)
                except Exception:
                    pass
            pn = mapping.get("prompt_node")
            injected_prompt = False
            if pn and str(pn) in wf:
                pnode = wf[str(pn)]
                p_inps = pnode.setdefault("inputs", {})
                if "text" in p_inps:
                    # 若 text 是连线引用，优先定位并更新上游源节点
                    if isinstance(p_inps["text"], list) and len(p_inps["text"]) == 2:
                        src_nid = str(p_inps["text"][0])
                        if src_nid in wf and "value" in wf[src_nid].get("inputs", {}):
                            wf[src_nid]["inputs"]["value"] = prompt_text
                            injected_prompt = True
                        elif src_nid in wf and "text" in wf[src_nid].get("inputs", {}):
                            wf[src_nid]["inputs"]["text"] = prompt_text
                            injected_prompt = True
                    else:
                        p_inps["text"] = prompt_text
                        injected_prompt = True
                elif "value" in p_inps:
                    p_inps["value"] = prompt_text
                    injected_prompt = True

            if not injected_prompt and not is_api_frugally:
                # 全量模式：优先用户提示词 Primitive（按标题/内容打分，系统提示词排后）
                cands = []
                for nid, node in wf.items():
                    if node.get("class_type") in ("PrimitiveStringMultiline", "PrimitiveNode", "CR Text", "StringLiteral", "PrimitiveString"):
                        if "value" in node.get("inputs", {}) and not isinstance(node["inputs"]["value"], list):
                            cands.append((str(nid), node))
                if cands:
                    def _t_score(item):
                        title = str((item[1].get("_meta") or {}).get("title", "") or "")
                        val = str(item[1].get("inputs", {}).get("value", "") or "")
                        s = 0
                        if "user" in title.lower() or "用户" in title: s -= 10
                        if "prompt" in title.lower() or "提示词" in title: s -= 5
                        if "prompt engineer" in val.lower() or "Think step by step" in val: s += 20
                        return s
                    cands.sort(key=_t_score)
                    cands[0][1]["inputs"]["value"] = prompt_text
                    injected_prompt = True
                if not injected_prompt:
                        for nid, node in wf.items():
                            if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux"):
                                txt_inp = node.get("inputs", {}).get("text")
                                if txt_inp is not None and not (isinstance(txt_inp, list) and len(txt_inp) == 2):
                                    node["inputs"]["text"] = prompt_text
                                    injected_prompt = True
                                    break
            elif not injected_prompt and is_api_frugally:
                # 智能节俭回退：API 工作流未配置 prompt_node 但仅有唯一未连线的文本节点时，仍注入
                candidates = [ (nid, n) for nid, n in wf.items() if n.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux") and "text" in n.get("inputs", {}) and not isinstance(n["inputs"]["text"], list) ]
                if len(candidates) == 1:
                    candidates[0][1]["inputs"]["text"] = prompt_text
                    injected_prompt = True
                else:
                    # 尝试 Primitive 单一
                    cand2 = [ (nid, n) for nid, n in wf.items() if n.get("class_type") in ("PrimitiveStringMultiline", "PrimitiveNode") and "value" in n.get("inputs", {}) and not isinstance(n["inputs"]["value"], list) ]
                    if len(cand2) == 1:
                        cand2[0][1]["inputs"]["value"] = prompt_text
                        injected_prompt = True
            if not injected_prompt:
                # 链路追溯兜底：prompt_node 的 text 是连线(经 Switch/Concat/TextGenerate)时,
                # BFS 找到真正的可写文本源头(通常是 PrimitiveStringMultiline value / TextGenerate prompt),
                # 否则工作流将以其内置默认画面文本运行(表现为"输入的提示词没有效果")
                tgt = _find_writable_prompt_target(wf, start_ids=([str(pn)] if pn else None))
                if tgt and tgt[0] in wf:
                    tid, tkey = tgt
                    wf[tid].setdefault("inputs", {})[tkey] = prompt_text
                    injected_prompt = True
                    print(f"[Workflow] prompt 已沿连线追溯注入源节点 #{tid} ({tkey})")
                else:
                    print("[Workflow] 未找到可写文本源节点, prompt 未注入(工作流将以默认文本运行)")
        if "negative_prompt" in params:
            nn = mapping.get("negative_node")
            if nn and str(nn) in wf and "text" in wf[str(nn)].get("inputs", {}):
                wf[str(nn)]["inputs"]["text"] = params["negative_prompt"] or ""
            elif not is_api_frugally and params["negative_prompt"]:
                # 全量模式：尝试第二负向
                for nid, node in wf.items():
                    if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL"):
                        if "text" in node.get("inputs", {}) and str(nid) != mapping.get("prompt_node"):
                            if not isinstance(node["inputs"]["text"], list):
                                node["inputs"]["text"] = params["negative_prompt"] or ""
                                break
        if "seed" in params and params["seed"] is not None:
            sn = mapping.get("seed_node")
            if sn and str(sn) in wf and "seed" in wf[str(sn)].get("inputs", {}):
                if not (is_api_frugally and isinstance(wf[str(sn)]["inputs"]["seed"], list)):
                    wf[str(sn)]["inputs"]["seed"] = int(params["seed"])
            elif not is_api_frugally:
                for nid, node in wf.items():
                    if "seed" in node.get("inputs", {}):
                        if isinstance(node["inputs"]["seed"], list):
                            continue
                        node["inputs"]["seed"] = int(params["seed"])
                        break
            elif is_api_frugally:
                # 智能节俭回退：API 工作流若未配置 seed 映射，但仅有唯一未连线的 seed 节点，仍注入以保证页面参数生效
                candidates = [ (nid, n) for nid, n in wf.items() if "seed" in n.get("inputs", {}) and not isinstance(n["inputs"]["seed"], list) ]
                if len(candidates) == 1:
                    candidates[0][1]["inputs"]["seed"] = int(params["seed"])
        if "width" in params and "height" in params:
            dn = mapping.get("dim_node")
            if dn and str(dn) in wf:
                if "width" in wf[str(dn)].get("inputs", {}):
                    if not (is_api_frugally and isinstance(wf[str(dn)]["inputs"]["width"], list)):
                        wf[str(dn)]["inputs"]["width"] = int(params["width"])
                if "height" in wf[str(dn)].get("inputs", {}):
                    if not (is_api_frugally and isinstance(wf[str(dn)]["inputs"]["height"], list)):
                        wf[str(dn)]["inputs"]["height"] = int(params["height"])
            elif not is_api_frugally:
                for nid, node in wf.items():
                    if node.get("class_type") in ("EmptyLatentImage", "WanImageToVideo", "WanVaceToVideo"):
                        if "width" in node.get("inputs", {}) and "height" in node.get("inputs", {}):
                            if not isinstance(node["inputs"]["width"], list):
                                node["inputs"]["width"] = int(params["width"])
                                node["inputs"]["height"] = int(params["height"])
                                break
            elif is_api_frugally:
                # 智能节俭回退：唯一未连线的尺寸节点
                candidates = [ (nid, n) for nid, n in wf.items() if n.get("class_type") in ("EmptyLatentImage", "WanImageToVideo", "WanVaceToVideo") and "width" in n.get("inputs", {}) and "height" in n.get("inputs", {}) and not isinstance(n["inputs"]["width"], list) ]
                if len(candidates) == 1:
                    candidates[0][1]["inputs"]["width"] = int(params["width"])
                    candidates[0][1]["inputs"]["height"] = int(params["height"])
        if params.get("checkpoint"):
            cn = mapping.get("ckpt_node")
            if cn and str(cn) in wf:
                inp = wf[str(cn)].get("inputs", {})
                if "ckpt_name" in inp and not (is_api_frugally and isinstance(inp["ckpt_name"], list)):
                    inp["ckpt_name"] = params["checkpoint"]
                elif "unet_name" in inp and not (is_api_frugally and isinstance(inp["unet_name"], list)):
                    inp["unet_name"] = params["checkpoint"]
            elif not is_api_frugally:
                for nid, node in wf.items():
                    if node.get("class_type") in ("CheckpointLoaderSimple", "UNETLoader"):
                        if "ckpt_name" in node.get("inputs", {}):
                            if not isinstance(node["inputs"]["ckpt_name"], list):
                                node["inputs"]["ckpt_name"] = params["checkpoint"]
                                break
                        if "unet_name" in node.get("inputs", {}):
                            if not isinstance(node["inputs"]["unet_name"], list):
                                node["inputs"]["unet_name"] = params["checkpoint"]
                                break
            elif is_api_frugally:
                cands = [ (nid, n) for nid, n in wf.items() if n.get("class_type") in ("CheckpointLoaderSimple", "UNETLoader") and ("ckpt_name" in n.get("inputs", {}) or "unet_name" in n.get("inputs", {})) and not isinstance(n["inputs"].get("ckpt_name" if "ckpt_name" in n["inputs"] else "unet_name"), list) ]
                if len(cands) == 1:
                    nid, n = cands[0]
                    if "ckpt_name" in n["inputs"]:
                        n["inputs"]["ckpt_name"] = params["checkpoint"]
                    elif "unet_name" in n["inputs"]:
                        n["inputs"]["unet_name"] = params["checkpoint"]
        if params.get("steps") is not None or params.get("cfg") is not None:
            if not is_api_frugally:
                for nid, node in wf.items():
                    if node.get("class_type") in ("KSampler", "KSamplerAdvanced"):
                        if params.get("steps") is not None and "steps" in node.get("inputs", {}):
                            if not isinstance(node["inputs"]["steps"], list):
                                node["inputs"]["steps"] = int(params["steps"])
                        if params.get("cfg") is not None and "cfg" in node.get("inputs", {}):
                            if not isinstance(node["inputs"]["cfg"], list):
                                node["inputs"]["cfg"] = float(params["cfg"])
                        break
            elif is_api_frugally:
                cands = [ (nid, n) for nid, n in wf.items() if n.get("class_type") in ("KSampler", "KSamplerAdvanced") and ("steps" in n.get("inputs", {}) or "cfg" in n.get("inputs", {})) and not isinstance(n["inputs"].get("steps" if "steps" in n["inputs"] else "cfg"), list) ]
                if len(cands) == 1:
                    nid, n = cands[0]
                    if params.get("steps") is not None and "steps" in n["inputs"] and not isinstance(n["inputs"]["steps"], list):
                        n["inputs"]["steps"] = int(params["steps"])
                    if params.get("cfg") is not None and "cfg" in n["inputs"] and not isinstance(n["inputs"]["cfg"], list):
                        n["inputs"]["cfg"] = float(params["cfg"])

        # 6.5 图像输入注入 (参考生图/图生图/多参考图/垫图)
        ref_imgs: List[str] = []
        if params.get("image_url"):
            ref_imgs.append(str(params["image_url"]))
        elif params.get("image"):
            ref_imgs.append(str(params["image"]))
        if params.get("reference_images") and isinstance(params["reference_images"], (list, tuple)):
            for r in params["reference_images"]:
                if r and str(r) not in ref_imgs:
                    ref_imgs.append(str(r))
        if dynamic_inputs and dynamic_inputs.get("reference_images") and isinstance(dynamic_inputs["reference_images"], (list, tuple)):
            for r in dynamic_inputs["reference_images"]:
                if r and str(r) not in ref_imgs:
                    ref_imgs.append(str(r))

        if ref_imgs:
            img_nodes: List[str] = []
            for nid, node in wf.items():
                if not isinstance(node, dict):
                    continue
                ct = node.get("class_type", "")
                if ct in ("LoadImage", "LoadImageMask", "LoadImageForInpaint", "ImageLoad", "LoadImageOutput"):
                    img_nodes.append(str(nid))

            assigned_nids = set()
            if dynamic_inputs:
                for k in dynamic_inputs.keys():
                    ks = str(k)
                    if ks.startswith("img_"):
                        assigned_nids.add(ks.split("_", 1)[1].split("_")[0])
                    elif ks in wf:
                        assigned_nids.add(ks)
            if node_overrides:
                for nid in node_overrides.keys():
                    assigned_nids.add(str(nid))

            unassigned_img_nodes = [nid for nid in img_nodes if nid not in assigned_nids]

            img_idx = 0
            primary_img_nid = mapping.get("image_node")
            if primary_img_nid and str(primary_img_nid) in wf and str(primary_img_nid) not in assigned_nids:
                wf[str(primary_img_nid)].setdefault("inputs", {})["image"] = ref_imgs[0]
                img_idx += 1
                if str(primary_img_nid) in unassigned_img_nodes:
                    unassigned_img_nodes.remove(str(primary_img_nid))

            for nid in unassigned_img_nodes:
                if img_idx < len(ref_imgs):
                    inp = wf[nid].setdefault("inputs", {})
                    if is_api_frugally and isinstance(inp.get("image"), list) and len(inp["image"]) == 2:
                        continue
                    inp["image"] = ref_imgs[img_idx]
                    img_idx += 1

        # 7. 最后应用外部动态输入（暴露输入优先；带枚举护栏与 combo_/num_/aud_/vid_ 解析）
        _apply_dynamic_inputs(wf, dynamic_inputs)
        return wf

    def inject_video_params(
        self,
        workflow: Dict[str, Any],
        mapping: Dict[str, str],
        params: Dict[str, Any],
        node_overrides: Optional[Dict[str, Dict[str, Any]]] = None,
        dynamic_inputs: Optional[Dict[str, Any]] = None,
        is_api_frugally: bool = False,
    ) -> Dict[str, Any]:
        """
        视频工作流参数注入（支持节俭模式与 I2V/R2V 适配）

        - is_api_frugally=True  (API Format 原生)：仅注入 mapping 指向的节点与 node_overrides，保留工作流原有其他参数（节俭）
        - is_api_frugally=False (UI 转换后)：全量覆盖，页面输入参数覆盖工作流原值（原始覆盖）

        适配：
        - I2V:首帧图注入到首个 LoadImage / WanImageToVideo.image
        - R2V:多参考图依次注入到所有 LoadImage /参考槽位
        - T2V:仅 prompt
        - 通用:prompt/negative/seed/width/height/duration->length/frames/num_frames
        """
        wf = self.sanitize_workflow(copy.deepcopy(workflow), aggressive=False)

        # 1. 节俭 vs 全量：先应用 node_overrides（始终应用）
        if node_overrides:
            for nid, overrides in node_overrides.items():
                if str(nid) in wf and isinstance(overrides, dict):
                    for k, v in overrides.items():
                        if v is not None:
                            # 处理动态提示词
                            if _HAS_CLI_CONVERTER and isinstance(v, str) and "{" in v and "|" in v:
                                try:
                                    v = _cli_converter.process_dynamic_prompt(v)
                                except Exception:
                                    pass
                            # list 包装区分连线
                            if _HAS_CLI_CONVERTER and isinstance(v, list):
                                v = _cli_converter._wrap_widget_value(v)
                                if isinstance(v, dict) and "__value__" in v:
                                    v = v["__value__"]
                            _set_input_guarded(wf, str(nid), k, v)

        # 2. Prompt 注入（视频运动描述）
        if params.get("prompt"):
            prompt_text = params["prompt"]
            if _HAS_CLI_CONVERTER and isinstance(prompt_text, str) and "{" in prompt_text and "|" in prompt_text:
                try:
                    prompt_text = _cli_converter.process_dynamic_prompt(prompt_text)
                except Exception:
                    pass
            pn = mapping.get("prompt_node")
            injected = False
            if pn and str(pn) in wf:
                pnode = wf[str(pn)]
                if "text" in pnode.get("inputs", {}):
                    # 若为连线，追溯上游
                    if isinstance(pnode["inputs"]["text"], list) and len(pnode["inputs"]["text"]) == 2:
                        src = str(pnode["inputs"]["text"][0])
                        if src in wf and "value" in wf[src].get("inputs", {}):
                            wf[src]["inputs"]["value"] = prompt_text
                            injected = True
                        elif src in wf and "text" in wf[src].get("inputs", {}):
                            wf[src]["inputs"]["text"] = prompt_text
                            injected = True
                    else:
                        pnode["inputs"]["text"] = prompt_text
                        injected = True
                elif "prompt" in pnode.get("inputs", {}):
                    pnode["inputs"]["prompt"] = prompt_text
                    injected = True
                elif "value" in pnode.get("inputs", {}):
                    pnode["inputs"]["value"] = prompt_text
                    injected = True
            if not injected and not is_api_frugally:
                # 全量模式：回退扫描所有文本节点
                for nid, node in wf.items():
                    if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux", "TextGenerate", "WanVideoTextEncode"):
                        if "text" in node.get("inputs", {}) and not isinstance(node["inputs"]["text"], list):
                            node["inputs"]["text"] = prompt_text
                            injected = True
                            break
                if not injected:
                    cands2 = []
                    for nid, node in wf.items():
                        if node.get("class_type") in ("PrimitiveStringMultiline", "StringLiteral", "PrimitiveString", "PrimitiveNode"):
                            if "value" in node.get("inputs", {}) and not isinstance(node["inputs"]["value"], list):
                                cands2.append((str(nid), node))
                    if cands2:
                        def _t2_score(item):
                            title = str((item[1].get("_meta") or {}).get("title", "") or "")
                            val = str(item[1].get("inputs", {}).get("value", "") or "")
                            s = 0
                            if "user" in title.lower() or "用户" in title: s -= 10
                            if "prompt" in title.lower() or "提示词" in title: s -= 5
                            if "prompt engineer" in val.lower() or "Think step by step" in val: s += 20
                            return s
                        cands2.sort(key=_t2_score)
                        cands2[0][1]["inputs"]["value"] = prompt_text
                        injected = True
            if not injected:
                tgt = _find_writable_prompt_target(wf, start_ids=([str(mapping.get("prompt_node"))] if mapping.get("prompt_node") else None))
                if not tgt:
                    tgt = _find_writable_prompt_target(wf, start_ids=None)
                if tgt and tgt[0] in wf:
                    tid, tkey = tgt
                    wf[tid].setdefault("inputs", {})[tkey] = prompt_text
                    injected = True
                    print(f"[Workflow] video prompt 已沿连线追溯注入源节点 #{tid} ({tkey})")

        if params.get("negative_prompt") and not is_api_frugally:
            nn = mapping.get("negative_node")
            if nn and str(nn) in wf and "text" in wf[str(nn)].get("inputs", {}):
                wf[str(nn)]["inputs"]["text"] = params["negative_prompt"] or ""

        # 收集被 dynamic_inputs 或 node_overrides 显式指定的节点，避免顺序分配覆盖
        assigned_nids = set()
        if dynamic_inputs:
            for k in dynamic_inputs.keys():
                ks = str(k)
                if ks.startswith(("img_", "vid_", "aud_")):
                    assigned_nids.add(ks.split("_", 1)[1].split("_")[0])
                elif ks in wf:
                    assigned_nids.add(ks)
        if node_overrides:
            for nid in node_overrides.keys():
                assigned_nids.add(str(nid))

        # 4. 图像注入：I2V/R2V 适配（仅针对 LoadImage 与 Wan 图像输入，绝不向视频/音频节点乱填）
        image_sources = []
        if params.get("first_frame_url"):
            image_sources.append(("first", params["first_frame_url"]))
        if params.get("last_frame_url"):
            image_sources.append(("last", params["last_frame_url"]))
        if params.get("reference_images"):
            for idx, ref in enumerate(params["reference_images"]):
                image_sources.append((f"ref_{idx}", ref))

        if image_sources:
            img_nodes = []
            wan_img_nodes = []
            for nid, node in wf.items():
                if str(nid) in assigned_nids:
                    continue
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                if ct in ("LoadImage", "LoadImageMask", "LoadImageOutput", "ImageLoad", "LoadImageForInpaint"):
                    if "image" in inputs:
                        img_nodes.append(str(nid))
                elif ct in ("WanImageToVideo", "WanVaceToVideo", "WanFirstMiddleLastFrameToVideo", "CreateVideo"):
                    if any(k in inputs for k in ("image", "first_frame", "last_frame", "reference_image", "start_image")):
                        wan_img_nodes.append(str(nid))

            for idx, (role, img_name) in enumerate(image_sources):
                if idx < len(img_nodes):
                    nid = img_nodes[idx]
                    node = wf[nid]
                    inputs = node.setdefault("inputs", {})
                    if is_api_frugally and isinstance(inputs.get("image"), list) and len(inputs["image"]) == 2:
                        continue
                    inputs["image"] = img_name
                elif idx < len(img_nodes) + len(wan_img_nodes):
                    w_idx = idx - len(img_nodes)
                    nid = wan_img_nodes[w_idx]
                    node = wf[nid]
                    inputs = node.setdefault("inputs", {})
                    if "first_frame" in inputs and role == "first":
                        inputs["first_frame"] = img_name
                    elif "last_frame" in inputs and role == "last":
                        inputs["last_frame"] = img_name
                    elif "reference_image" in inputs:
                        inputs["reference_image"] = img_name
                    elif "image" in inputs:
                        inputs["image"] = img_name
                elif not is_api_frugally:
                    for nid, node in wf.items():
                        if node.get("class_type") in ("WanVaceToVideo", "WanImageToVideo"):
                            if "reference_images" in node.get("inputs", {}):
                                cur = node["inputs"]["reference_images"]
                                if isinstance(cur, list) and len(cur) == 2:
                                    continue
                                if not isinstance(cur, list):
                                    node["inputs"]["reference_images"] = [img_name]
                                else:
                                    node["inputs"]["reference_images"].append(img_name)
                                break

        # 4.1 视频注入 (Video-to-Video / 动作参考 / VHS_LoadVideo)
        video_sources = []
        if params.get("video_url"):
            video_sources.append(params["video_url"])
        if params.get("reference_videos"):
            for v in params["reference_videos"]:
                if v and v not in video_sources:
                    video_sources.append(v)

        if video_sources:
            vid_nodes = []
            for nid, node in wf.items():
                if str(nid) in assigned_nids:
                    continue
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                if ct in ("VHS_LoadVideo", "LoadVideo", "VideoLoad"):
                    if "video" in inputs or "image" in inputs:
                        vid_nodes.append(str(nid))
            for idx, vid_name in enumerate(video_sources):
                if idx < len(vid_nodes):
                    nid = vid_nodes[idx]
                    node = wf[nid]
                    inputs = node.setdefault("inputs", {})
                    if "video" in inputs:
                        if not (is_api_frugally and isinstance(inputs["video"], list) and len(inputs["video"]) == 2):
                            inputs["video"] = vid_name
                    elif "image" in inputs:
                        if not (is_api_frugally and isinstance(inputs["image"], list) and len(inputs["image"]) == 2):
                            inputs["image"] = vid_name

        # 4.2 音频注入 (配音 / 对齐 / LoadAudio)
        audio_sources = []
        if params.get("audio_url"):
            audio_sources.append(params["audio_url"])
        if params.get("reference_audios"):
            for a in params["reference_audios"]:
                if a and a not in audio_sources:
                    audio_sources.append(a)

        if audio_sources:
            aud_nodes = []
            for nid, node in wf.items():
                if str(nid) in assigned_nids:
                    continue
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                if ct in ("LoadAudio", "LoadAudio2", "AudioLoad"):
                    if "audio" in inputs or "reference_audio" in inputs:
                        aud_nodes.append(str(nid))
            for idx, aud_name in enumerate(audio_sources):
                if idx < len(aud_nodes):
                    nid = aud_nodes[idx]
                    node = wf[nid]
                    inputs = node.setdefault("inputs", {})
                    target_key = "audio" if "audio" in inputs else "reference_audio"
                    if not (is_api_frugally and isinstance(inputs.get(target_key), list) and len(inputs[target_key]) == 2):
                        inputs[target_key] = aud_name

        # 5. 分辨率/尺寸注入
        # 支持 720p/1080p -> 具体宽高，或直接 width/height
        width = params.get("width")
        height = params.get("height")
        if not width or not height:
            # 从 resolution/aspect_ratio 推导
            res = params.get("resolution") or "720p"
            ar = params.get("aspect_ratio") or "9:16"
            # 常用映射
            RES_MAP = {
                "720p": {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)},
                "1080p": {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)},
                "480p": {"9:16": (480, 832), "16:9": (832, 480), "1:1": (480, 480)},
            }
            if res in RES_MAP and ar in RES_MAP[res]:
                width, height = RES_MAP[res][ar]
            else:
                # fallback to image ASPECT_SIZES
                ASPECT_SIZES = {"9:16": (832, 1216), "16:9": (1216, 832), "1:1": (1024, 1024)}
                width, height = ASPECT_SIZES.get(ar, (720, 1280))
        if width and height:
            width, height = int(width), int(height)
            # 查找所有尺寸相关节点
            for nid, node in wf.items():
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                if ct in ("WanImageToVideo", "WanVaceToVideo", "WanFirstMiddleLastFrameToVideo", "WanVideoSampler", "CreateVideo") or ct.startswith("Wan"):
                    if not is_api_frugally or ct.startswith("Wan") or ct == "CreateVideo":
                        if "width" in inputs:
                            if is_api_frugally and isinstance(inputs["width"], list):
                                continue
                            inputs["width"] = width
                        if "height" in inputs:
                            if is_api_frugally and isinstance(inputs["height"], list):
                                continue
                            inputs["height"] = height
                        # Wan 的 width/height 可能为 int，需覆盖
                elif ct == "EmptyLatentImage" and not is_api_frugally:
                    if "width" in inputs:
                        inputs["width"] = width
                    if "height" in inputs:
                        inputs["height"] = height
                elif ct == "ResolutionSelector" and not is_api_frugally:
                    # 保持原有，但可通过 megapixels 调整
                    pass
            # 若为节俭模式且未命中，通过 mapping 的 dim_node 注入
            if is_api_frugally:
                dn = mapping.get("dim_node")
                if dn and str(dn) in wf:
                    if "width" in wf[str(dn)].get("inputs", {}):
                        wf[str(dn)]["inputs"]["width"] = width
                    if "height" in wf[str(dn)].get("inputs", {}):
                        wf[str(dn)]["inputs"]["height"] = height

        # 6. 时长/帧数注入
        duration = params.get("duration")
        if duration is not None:
            try:
                duration = int(duration)
            except Exception:
                duration = 5
            duration = max(1, min(15, duration))
            # 推导帧数：Wan 常用 81 帧对应 5s (~16fps)，CreateVideo 用 frames
            for nid, node in wf.items():
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                # WanImageToVideo: length (frames)
                if ct in ("WanImageToVideo", "WanVaceToVideo"):
                    if "length" in inputs:
                        if is_api_frugally and isinstance(inputs["length"], list):
                            continue
                        # 81 帧 =5s, 按比例
                        frames = int(duration * 16) + 1  # +1 保证首帧
                        if frames % 2 == 0:
                            frames += 1
                        inputs["length"] = frames
                    if "num_frames" in inputs:
                        inputs["num_frames"] = int(duration * 16) + 1
                elif ct == "CreateVideo":
                    if "frames" in inputs:
                        inputs["frames"] = int(duration * 24)  # 24fps
                    if "fps" in inputs and not is_api_frugally:
                        # 保持原 fps，仅调整 frames
                        pass
                    if "duration" in inputs:
                        inputs["duration"] = duration
                elif ct in ("VHS_VideoCombine", "SaveVideo"):
                    if "frame_rate" in inputs and not is_api_frugally:
                        pass
            # 节俭模式下若无上述节点，尝试通过动态参数注入
            if is_api_frugally and "length" not in str(wf):
                # 不强制，保持原值
                pass

        # 7. Seed 注入
        if params.get("seed") is not None:
            seed_val = int(params["seed"])
            sn = mapping.get("seed_node")
            if sn and str(sn) in wf and "seed" in wf[str(sn)].get("inputs", {}):
                if not (is_api_frugally and isinstance(wf[str(sn)]["inputs"]["seed"], list)):
                    wf[str(sn)]["inputs"]["seed"] = seed_val
            elif not is_api_frugally:
                for nid, node in wf.items():
                    if "seed" in node.get("inputs", {}):
                        if isinstance(node["inputs"]["seed"], list):
                            continue
                        node["inputs"]["seed"] = seed_val
                        break

        # 8. 文生视频/图生视频模式切换：若工作流为 T2V 但请求为 I2V，尝试激活首帧路径
        # 仅在全量模式下进行，以避免破坏 API 节俭工作流的既定结构
        if not is_api_frugally and params.get("mode") == "i2v" and params.get("first_frame_url"):
            # 确保至少有一个 LoadImage 被正确连接
            has_load = any(n.get("class_type") == "LoadImage" for n in wf.values())
            if not has_load:
                logger.warning(f"[VideoInject] I2V 模式但工作流中无 LoadImage 节点，可能需手动检查工作流 {mapping}")
        if not is_api_frugally and params.get("mode") == "r2v" and params.get("reference_images"):
            # R2V 需要多个参考，检查
            ref_count = len(params.get("reference_images", []))
            load_count = sum(1 for n in wf.values() if n.get("class_type") in ("LoadImage", "WanVaceToVideo"))
            if ref_count > load_count:
                logger.warning(f"[VideoInject] R2V 传入 {ref_count} 张参考图，但工作流仅有 {load_count} 个可注入节点")

        # 9. 最后应用外部动态输入（暴露输入优先；带枚举护栏与 combo_/num_/aud_/vid_ 解析）
        _apply_dynamic_inputs(wf, dynamic_inputs)
        return wf

    def inspect_workflow_nodes(self, workflow_id: str) -> Dict[str, Any]:
        """
        深度解析工作流的所有可配置节点、参数类型与 ComfyUI 可用模型选项
        """
        wf, meta = self.get_workflow_with_meta(workflow_id)
        if not wf:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")

        clean_wf = self.sanitize_workflow(copy.deepcopy(wf))
        object_info = _fetch_object_info() or {}

        available_models = {
            "checkpoints": [],
            "unets": [],
            "loras": [],
            "vaes": [],
            "clips": [],
            "samplers": [],
            "schedulers": [],
        }
        if object_info:
            try:
                available_models["checkpoints"] = object_info.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {}).get("ckpt_name", [[]])[0] or []
                available_models["unets"] = object_info.get("UNETLoader", {}).get("input", {}).get("required", {}).get("unet_name", [[]])[0] or []
                available_models["loras"] = object_info.get("LoraLoader", {}).get("input", {}).get("required", {}).get("lora_name", [[]])[0] or []
                available_models["vaes"] = object_info.get("VAELoader", {}).get("input", {}).get("required", {}).get("vae_name", [[]])[0] or []
                available_models["clips"] = object_info.get("CLIPLoader", {}).get("input", {}).get("required", {}).get("clip_name", [[]])[0] or []
                available_models["samplers"] = object_info.get("KSampler", {}).get("input", {}).get("required", {}).get("sampler_name", [[]])[0] or []
                available_models["schedulers"] = object_info.get("KSampler", {}).get("input", {}).get("required", {}).get("scheduler", [[]])[0] or []
            except Exception:
                pass

        def get_category(ct: str) -> str:
            if "Loader" in ct or ct in ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader", "CLIPLoader", "VAELoader", "LoraLoader", "LoraLoaderModelOnly"):
                return "model_loader"
            if "Sampler" in ct or ct in ("KSampler", "KSamplerAdvanced"):
                return "sampler"
            if "CLIPTextEncode" in ct or "Prompt" in ct or "Text" in ct:
                return "prompt"
            if "Latent" in ct or "Resolution" in ct or ct in ("EmptyLatentImage", "ResolutionSelector"):
                return "latent"
            if "Save" in ct or "Preview" in ct:
                return "output"
            return "utility"

        nodes_list = []
        node_overrides = meta.get("node_overrides", {}) if meta else {}

        for nid, node in clean_wf.items():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type", "")
            title = node.get("_meta", {}).get("title") or ct
            inputs = node.get("inputs", {})
            category = get_category(ct)

            node_spec = object_info.get(ct, {}).get("input", {}) if object_info else {}
            req_spec = node_spec.get("required", {})
            opt_spec = node_spec.get("optional", {})
            all_spec = {**req_spec, **opt_spec}

            param_items = []
            for pname, pval in inputs.items():
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                spec = all_spec.get(pname, [])
                ptype = "STRING"
                choices = []
                widget_meta = {}
                if isinstance(spec, (list, tuple)) and len(spec) > 0:
                    t_info = spec[0]
                    if isinstance(t_info, list):
                        ptype = "COMBO"
                        choices = t_info
                    elif isinstance(t_info, str):
                        ptype = t_info
                        # 新式 COMBO schema：("COMBO", {"options": [...]}) —— ResolutionSelector 等新内置节点
                        if t_info == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict) and isinstance(spec[1].get("options"), list):
                            choices = [str(x) for x in spec[1]["options"]]
                    if len(spec) > 1 and isinstance(spec[1], dict):
                        widget_meta = spec[1]
                else:
                    if isinstance(pval, bool):
                        ptype = "BOOLEAN"
                    elif isinstance(pval, int):
                        ptype = "INT"
                    elif isinstance(pval, float):
                        ptype = "FLOAT"
                    elif isinstance(pval, str):
                        ptype = "STRING"

                # 动态补充模型候选列表
                if not choices:
                    if pname in ("ckpt_name", "checkpoint"):
                        choices = available_models["checkpoints"]
                        ptype = "COMBO"
                    elif pname == "unet_name":
                        choices = available_models["unets"]
                        ptype = "COMBO"
                    elif pname in ("lora_name", "lora"):
                        choices = available_models["loras"]
                        ptype = "COMBO"
                    elif pname in ("vae_name", "vae"):
                        choices = available_models["vaes"]
                        ptype = "COMBO"
                    elif pname == "clip_name":
                        choices = available_models["clips"]
                        ptype = "COMBO"
                    elif pname == "sampler_name":
                        choices = available_models["samplers"]
                        ptype = "COMBO"
                    elif pname == "scheduler":
                        choices = available_models["schedulers"]
                        ptype = "COMBO"

                # 当前覆写值优先
                current_val = pval
                if str(nid) in node_overrides and pname in node_overrides[str(nid)]:
                    current_val = node_overrides[str(nid)][pname]

                param_items.append({
                    "name": pname,
                    "type": ptype,
                    "value": current_val if not is_linked else None,
                    "is_linked": is_linked,
                    "link_source": pval if is_linked else None,
                    "choices": choices,
                    "min": widget_meta.get("min"),
                    "max": widget_meta.get("max"),
                    "step": widget_meta.get("step", widget_meta.get("round")),
                })

            nid_str = str(nid)
            is_subgraph_node = False
            subgraph_id = None
            subgraph_name = None
            if nid_str.startswith("sg") and "_" in nid_str:
                is_subgraph_node = True
                sg_part = nid_str.split("_")[0]
                subgraph_id = sg_part
                subgraph_name = f"子图模块 #{sg_part[2:]}"

            nodes_list.append({
                "node_id": str(nid),
                "title": title,
                "class_type": ct,
                "category": category,
                "is_subgraph_node": is_subgraph_node,
                "subgraph_id": subgraph_id,
                "subgraph_name": subgraph_name,
                "parameters": param_items,
            })

        # 汇总子图复合模块 (Subgraphs Aggregation)
        subgraphs_map = {}
        for node in nodes_list:
            if node.get("is_subgraph_node") and node.get("subgraph_id"):
                sg_id = node["subgraph_id"]
                if sg_id not in subgraphs_map:
                    subgraphs_map[sg_id] = {
                        "id": sg_id,
                        "title": node.get("subgraph_name") or f"子图模块 #{sg_id[2:]}",
                        "node_count": 0,
                        "inner_node_ids": [],
                        "exposed_params": [],
                    }
                subgraphs_map[sg_id]["node_count"] += 1
                subgraphs_map[sg_id]["inner_node_ids"].append(node["node_id"])
                for p in node.get("parameters", []):
                    if not p.get("is_linked"):
                        subgraphs_map[sg_id]["exposed_params"].append({
                            "node_id": node["node_id"],
                            "node_title": node["title"],
                            "param_name": p["name"],
                            "type": p["type"],
                            "value": p["value"],
                            "choices": p.get("choices"),
                        })

        exposed_inputs, current_mapping = resolve_exposed_inputs(clean_wf, meta)

        return {
            "workflow_id": workflow_id,
            "name": meta.get("name", workflow_id) if meta else workflow_id,
            "description": meta.get("description", "") if meta else "",
            "source": meta.get("source", "internal") if meta else "internal",
            "mapping": current_mapping,
            "node_overrides": node_overrides,
            "exposed_inputs": exposed_inputs,
            "app_contract": (meta or {}).get("app_contract"),
            "source_file": (meta or {}).get("source_file"),
            "subgraphs": list(subgraphs_map.values()),
            "nodes": nodes_list,
            "available_models": available_models,
        }

    def save_workflow_overrides(
        self,
        workflow_id: str,
        mapping: Optional[Dict[str, str]] = None,
        node_overrides: Optional[Dict[str, Dict[str, Any]]] = None,
        exposed_inputs: Optional[List[Dict[str, Any]]] = None,
        auto_import_if_ext: bool = False
    ) -> Dict[str, Any]:
        """
        保存工作流的标准槽位映射、指定节点参数覆写与外部暴露输入项
        """
        # 若为外部工作流且要求自动导入为内部，则先导入
        if workflow_id.startswith("ext_") and auto_import_if_ext:
            try:
                imported = self.import_external_workflow(workflow_id)
                workflow_id = imported["id"]
                meta = self.get_meta(workflow_id)
                if not meta:
                    meta = imported
            except Exception as e:
                # 导入失败则回退到原 id 直接保存
                meta = self.get_meta(workflow_id)
                if not meta:
                    raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        else:
            meta = self.get_meta(workflow_id)
            if not meta:
                raise FileNotFoundError(f"工作流不存在: {workflow_id}")

        if mapping is not None:
            meta["mapping"] = mapping
        if node_overrides is not None:
            meta["node_overrides"] = node_overrides
        if exposed_inputs is not None:
            meta["exposed_inputs"] = exposed_inputs
            # 显式标记：这是用户亲手选择的白名单，才允许在解析时生效（默认全关）
            meta["exposed_source"] = "user"
        meta["updated_at"] = time.time()

        os.makedirs(WORKFLOWS_DIR, exist_ok=True)
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        # 清除列表缓存，确保下次 list_workflows 能看到更新
        self._list_cache = None
        self._list_cache_ts = 0
        # 同步 Provider 输入/参数 Schema（exposed 变更；force 跳过快路径，保证白名单立即生效）
        try:
            sync_workflow_provider(workflow_id, force=True)
        except Exception:
            pass
        return meta

    async def validate_workflow_against_comfyui(self, workflow_id: str) -> Dict[str, Any]:
        """
        向本地/远程 ComfyUI 发起真实校验探测，定位缺失的模型文件或节点
        """
        wf, meta = self.get_workflow_with_meta(workflow_id)
        if not wf:
            return {"valid": False, "errors": [{"message": f"工作流不存在: {workflow_id}"}]}

        clean_wf = self.sanitize_workflow(copy.deepcopy(wf))
        node_overrides = meta.get("node_overrides", {}) if meta else {}
        mapping = meta.get("mapping", {}) if meta else {}

        injected = self.inject_params(
            clean_wf,
            mapping,
            {"prompt": "Validation prompt test", "negative_prompt": "low quality", "seed": 12345},
            node_overrides=node_overrides
        )

        server_url = (getattr(settings, "COMFYUI_SERVER_URL", "") or "http://127.0.0.1:8188").rstrip("/")
        try:
            import httpx
            # 校验同样先过提交前防线：装饰节点剥离后不再误报，真实缺插件直接返回友好错误
            stripped = []
            try:
                injected, stripped = self.strip_unsupported_nodes(injected)
            except RuntimeError as pre_e:
                return {"valid": False, "errors": [{"message": str(pre_e), "suggested_fix": "请在 ComfyUI Manager 中安装缺失的插件包后重启"}], "stripped": stripped}
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(f"{server_url}/prompt", json={"prompt": injected, "client_id": "test_validate"})
                if r.status_code == 200:
                    return {"valid": True, "node_count": len(injected), "prompt_id": r.json().get("prompt_id"), "stripped": stripped}

                err = r.json()
                errors = []
                node_errors = err.get("node_errors", {})
                for nid, ninfo in node_errors.items():
                    ct = ninfo.get("class_type", "")
                    for e in ninfo.get("errors", []):
                        errors.append({
                            "node_id": str(nid),
                            "class_type": ct,
                            "type": e.get("type", "node_error"),
                            "message": e.get("message", str(e)),
                            "details": e.get("details", ""),
                            "suggested_fix": f"请在参数配置中修改节点 #{nid} ({ct}) 的模型或参数",
                        })
                if not errors:
                    err_msg = err.get("error", {}).get("message") if isinstance(err.get("error"), dict) else err.get("error") or err.get("message") or r.text
                    errors.append({"message": str(err_msg), "suggested_fix": "请检查 ComfyUI 服务状态与节点配置"})
                return {"valid": False, "status_code": r.status_code, "errors": errors}
        except Exception as e:
            return {"valid": False, "errors": [{"message": f"连接 ComfyUI 服务失败: {e}", "suggested_fix": "请确保本地 ComfyUI 已启动且地址正确"}]}

    # ------------------------------------------------------------------
    # 兼容 CLI 的 workflow 编辑能力（参考 comfy workflow set-slot / compose）
    # ------------------------------------------------------------------
    def list_workflow_slots(self, workflow_id: str) -> List[Dict[str, Any]]:
        """
        列出工作流中所有可直接编辑的槽位（等价于 `comfy workflow slots`）
        返回每个可编辑参数的 node_id/param_name/label/type/default/value
        """
        wf, meta = self.get_workflow_with_meta(workflow_id)
        if not wf:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        clean_wf = self.sanitize_workflow(copy.deepcopy(wf))
        object_info = _fetch_object_info() or {}
        mapping = (meta or {}).get("mapping", {})

        # 1. 优先使用 auto_detect_exposed_inputs 的外部表单槽位
        exposed = auto_detect_exposed_inputs(clean_wf, mapping)

        # 2. 叠加所有非连线的 widget 参数作为 slots（更全量视图）
        available = []
        try:
            inspected = self.inspect_workflow_nodes(workflow_id)
            for node in inspected.get("nodes", []):
                for p in node.get("parameters", []):
                    if not p.get("is_linked"):
                        available.append({
                            "node_id": node["node_id"],
                            "param_name": p["name"],
                            "label": f"{node['title']}.{p['name']}",
                            "type": p["type"],
                            "value": p["value"],
                            "choices": p.get("choices", []),
                            "class_type": node["class_type"],
                            "category": node["category"],
                        })
        except Exception:
            pass

        # 合并去重：优先保留 exposed 的描述更友好的 label
        seen = set()
        merged: List[Dict[str, Any]] = []
        for e in exposed:
            key = (str(e["node_id"]), e["param_name"])
            seen.add(key)
            merged.append({
                "node_id": str(e["node_id"]),
                "param_name": e["param_name"],
                "label": e.get("label", f"{e['node_id']}.{e['param_name']}"),
                "type": e.get("type", "STRING"),
                "value": e.get("default_value", ""),
                "choices": [],
                "description": e.get("description", ""),
                "source": "exposed",
            })
        for a in available:
            key = (str(a["node_id"]), a["param_name"])
            if key not in seen:
                merged.append({**a, "source": "inspected"})
                seen.add(key)
        return merged

    def set_workflow_node_param(self, workflow_id: str, node_id: str, param_name: str, value: Any) -> Dict[str, Any]:
        """
        直接编辑工作流中指定节点的参数（等价于 `comfy workflow set-slot`）
        支持 API 格式与 UI 格式（自动转换后编辑再保存）
        value 会尝试按 object_info 自动类型纠偏（INT/FLOAT/BOOLEAN）
        """
        # 读取原始 workflow（可能是 ext_* 外部文件）
        wf, meta = self.get_workflow_with_meta(workflow_id)
        if not wf:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")
        if str(node_id) not in wf:
            raise ValueError(f"节点 {node_id} 不存在于工作流中")
        node = wf[str(node_id)]
        if not isinstance(node, dict) or "inputs" not in node:
            raise ValueError(f"节点 {node_id} 结构异常")

        # 类型纠偏：参考 object_info
        object_info = _fetch_object_info() or {}
        class_type = node.get("class_type", "")
        spec = {}
        if object_info and class_type in object_info:
            try:
                schema = object_info[class_type].get("input", {})
                for section in ("required", "optional"):
                    if param_name in schema.get(section, {}):
                        spec = schema[section][param_name]
                        break
            except Exception:
                pass
        # 根据 spec 推断并转换类型
        if spec and isinstance(spec, (list, tuple)) and len(spec) >= 1:
            t = spec[0]
            if t == "INT" and isinstance(t, str):
                try:
                    value = int(value)
                except Exception:
                    pass
            elif t == "FLOAT" and isinstance(t, str):
                try:
                    value = float(value)
                except Exception:
                    pass
            elif t == "BOOLEAN" and isinstance(t, str):
                if isinstance(value, str):
                    value = value.lower() in ("1", "true", "yes", "on")
                else:
                    value = bool(value)
            elif isinstance(t, list) and isinstance(value, str):
                # COMBO：校验合法性（仅警告，不强制拦截）
                if value not in t:
                    logger.warning(f"[WorkflowManager] 参数值 '{value}' 不在 {param_name} 的可选列表 {t[:5]} 中")

        # 对于 list 类型的 widget 值，需包裹 __value__ 以区分连线
        if isinstance(value, list) and _HAS_CLI_CONVERTER:
            try:
                value = _cli_converter._wrap_widget_value(value)
                # unwrap check: internal uses direct list, but API expects direct; CLI wraps only for sending?
                # 实际上直接存原始 list 即可，发送时会由 _wrap 处理，这里保持原值
                if isinstance(value, dict) and "__value__" in value:
                    value = value["__value__"]
            except Exception:
                pass

        # 处理外部工作流：若是 ext_*，需先导入为内部
        if workflow_id.startswith("ext_"):
            raise ValueError("外部工作流为只读，请先调用 /images/workflows/import/{id} 导入为内部工作流后再编辑")

        # 更新存储的 API JSON
        wf[str(node_id)]["inputs"][param_name] = value

        # 同步更新 node_overrides 分层（保持与 inspect 一致）
        meta_overrides = meta.get("node_overrides", {}) if meta else {}
        meta_overrides.setdefault(str(node_id), {})[param_name] = value
        meta["node_overrides"] = meta_overrides
        meta["updated_at"] = time.time()

        # 落盘
        json_path = _json_path(workflow_id)
        meta_path = _meta_path(workflow_id)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False, indent=2)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        return {"workflow_id": workflow_id, "node_id": str(node_id), "param_name": param_name, "value": value, "meta": meta}

    def compose_workflow_from_fragments(self, fragments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        将多个片段组合为单一工作流（参考 `comfy workflow compose` 与 fragments 模式）
        每个 fragment 形如 {"workflow_id": "...", "prefix": "frag1_"}，会将对应工作流的节点 ID 前缀化后合并
        用于将常用子图（如角色一致性、光照、ControlNet）快速编排为新工作流
        """
        composed: Dict[str, Any] = {}
        for frag in fragments:
            fid = frag.get("workflow_id")
            prefix = frag.get("prefix") or f"{fid}_"
            wf = self.get_workflow(fid) if fid else None
            if not wf:
                raise FileNotFoundError(f"片段工作流不存在: {fid}")
            for nid, node in wf.items():
                new_id = f"{prefix}{nid}"
                new_node = copy.deepcopy(node)
                # 重写内部连线引用
                for inp_name, val in list(new_node.get("inputs", {}).items()):
                    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                        if val[0] in wf:
                            new_node["inputs"][inp_name] = [f"{prefix}{val[0]}", val[1]]
                composed[new_id] = new_node
        # 清理孤儿连线
        if _HAS_CLI_CONVERTER:
            try:
                _cli_converter._strip_orphan_link_inputs(composed)
            except Exception:
                pass
        return composed


workflow_manager = ComfyWorkflowManager()


# ========== 每条工作流独立抽象为生成源 Provider ==========
def _workflow_provider_id(workflow_id: str) -> str:
    # 稳定映射：内部 wf_xxx 保持原样，外部 ext_xxx 转为 wf_xxx
    if workflow_id.startswith("wf_"):
        return f"comfyui_{workflow_id}"
    if workflow_id.startswith("ext_"):
        return f"comfyui_{workflow_id}"
    return f"comfyui_wf_{workflow_id}"


def _detect_workflow_kind(workflow: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> str:
    # 依据节点类型判定 image/video/audio
    video_hints = ("VHS_", "VideoCombine", "SaveAnimated", "Wan", "AnimateDiff", "Video", "CreateVideo")
    audio_hints = ("SaveAudio", "AudioSave", "CosyVoice", "F5TTS", "AudioOutput", "LoadAudio")
    is_video = False
    is_audio = False
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", ""))
        if any(h in ct for h in video_hints):
            is_video = True
        if any(h in ct for h in audio_hints):
            is_audio = True
    if is_video:
        return "video"
    if is_audio:
        return "audio"
    if meta:
        desc = f"{meta.get('name','')} {meta.get('description','')}".lower()
        if any(k in desc for k in ("video", "视频", "i2v", "t2v", "r2v")):
            return "video"
        if any(k in desc for k in ("audio", "voice", "sound", "tts", "音频", "声音", "配音")):
            return "audio"
    return "image"


MEDIA_ROLE_KEYWORDS: List[Tuple[str, Tuple[str, ...]]] = [
    ("first_frame",  ("首帧", "first", "start_image", "起始")),
    ("last_frame",   ("尾帧", "last", "end_image", "结束")),
    ("character_ref", ("角色", "人物", "立绘", "face", "character", "idol", "identity")),
    ("scene_ref",    ("场景", "背景", "scene", "background", "环境")),
    ("pose_ref",     ("姿态", "动作", "骨架", "pose", "openpose", "depth")),
    ("control_ref",  ("控制", "controlnet", "canny", "lineart", "scribble", "mask")),
    ("style_ref",    ("风格", "style", "参考风格", "垫图风格")),
    ("ipadapter_ref", ("ipadapter", "ip_adapter", "一致性")),
    ("audio_ref",    ("音频", "语音", "声音", "配音", "audio", "voice", "speech", "sound", "wav", "mp3")),
    ("video_ref",    ("视频", "video", "motion", "动图", "动态", "vhs", "mp4")),
]


def infer_media_role(exp: Dict[str, Any]) -> str:
    """
    推断媒体暴露项的语义角色。作者命名（label/alias）优先，其次参数名（如 mask）；
    不使用自动探测的通用描述做判据 —— 所有 LoadImage 共用一段"支持上传角色立绘、构图草图…"文案，
    用它会让多参考工作流的每个槽都被判成同一角色。
    若声明了音频/视频类型，优先归入对应媒体角色，避免被图像角色（如角色配音->character_ref）误拦截。
    """
    strong = f"{exp.get('label','')} {exp.get('alias','')}".lower()
    weak = str(exp.get('param_name', '') or "").lower()
    etype = str(exp.get("type") or "").lower()

    # 音频专属优先拦截（如“角色配音”归入 audio_ref，而非 character_ref）
    if any(k in strong or k in weak for k in ("音频", "语音", "声音", "配音", "audio", "voice", "speech", "sound")):
        return "audio_ref"

    # 视频专属优先拦截（如“动作参考视频”归入 video_ref，而非 pose_ref）
    if any(k in strong or k in weak for k in ("视频", "video", "motion", "vhs", "动图", "动态")):
        return "video_ref"

    for role, kws in MEDIA_ROLE_KEYWORDS:
        if any(k.lower() in strong for k in kws):
            return role
    for role, kws in MEDIA_ROLE_KEYWORDS:
        if any(k.lower() in weak for k in kws):
            return role

    if etype == "audio":
        return "reference_audios"
    if etype == "video":
        return "reference_videos"
    return "reference_images"


def _build_provider_schemas_from_workflow(workflow: Dict[str, Any], meta: Optional[Dict[str, Any]] = None):
    """
    工作流 → 生成源 schema（全量同源，零固定模板）

    - input_schema：仅标准句柄（prompt / reference_images / first_frame / last_frame / reference_videos / reference_audios），供画布连线与
      节点 Agent 自动装配；prompt 的展示名取自该工作流真实文本入口，不再假设"所有源都有一个正向提示词"。
    - params_schema：**逐条**来自暴露清单（number/combo/boolean/text 全收），key 一律使用暴露项原生 id
      （num_30:3_steps / combo_49_aspect_ratio / txt_30:18），这样前端填的值可被 _apply_dynamic_inputs
      直接写进节点，无需任何标准名映射；title 取真实中文标签，x-* 由 WF_PARAM_SEMANTICS 决定分组与人机分工。
      不再做"steps/cfg/seed 白名单"筛选，也不在清单为空时回落 seed/steps/cfg 假参数。
    """
    kind = _detect_workflow_kind(workflow, meta)
    try:
        exposed, _mapping = resolve_exposed_inputs(workflow, meta)
    except Exception:
        exposed = []
    prompt_slot = pick_prompt_text_slot(exposed)

    if kind == "video":
        input_props: Dict[str, Any] = {
            "prompt": {"type": "string", "description": "运动/提示词", "x-handle": "text", "x-role": "prompt"},
            "first_frame": {"type": "string", "format": "uri", "description": "首帧", "x-handle": "image", "x-slot": "first_frame"},
            "last_frame": {"type": "string", "format": "uri", "description": "尾帧", "x-handle": "image", "x-slot": "last_frame"},
            "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图组", "x-handle": "image", "x-slot": "reference_images"},
            "reference_videos": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考视频组", "x-handle": "video", "x-slot": "reference_videos"},
            "reference_audios": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考音频组", "x-handle": "audio", "x-slot": "reference_audios"},
        }
        input_required = ["prompt"]
    elif kind == "audio":
        input_props = {
            "prompt": {"type": "string", "description": "语音文本/提示词", "x-handle": "text", "x-role": "prompt"},
            "reference_audios": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考音频", "x-handle": "audio", "x-slot": "reference_audios"},
        }
        input_required = ["prompt"]
    elif kind == "image":
        input_props = {
            "prompt": {"type": "string", "description": "画面提示词", "x-handle": "text", "x-role": "prompt"},
            "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图/垫图", "x-handle": "image", "x-slot": "reference_images"},
        }
        input_required = ["prompt"]
    else:
        input_props = {"prompt": {"type": "string", "description": "提示词", "x-handle": "text", "x-role": "prompt"}}
        input_required = ["prompt"]

    # 用工作流真实文本入口的名称覆盖标准 prompt（前端据此显示，不再出现写死的"正向生图提示词"）
    if prompt_slot:
        real_label = str(prompt_slot.get("alias") or prompt_slot.get("label") or "").strip()
        if real_label:
            input_props["prompt"]["title"] = real_label
            input_props["prompt"]["description"] = real_label
        input_props["prompt"]["x-comfy-id"] = prompt_slot.get("id")

    # 逐个媒体暴露项出独立槽位：多参考工作流因此有"角色图/场景图/姿态图"各一个槽，
    # 而不是一个靠位置猜的参考图数组。标准句柄（上方 prompt/reference_images 等）保留给画布连线与 Agent，
    # 标注 x-aggregate 供前端在已有独立槽时不重复渲染。
    has_per_node_media = False
    for exp in exposed:
        etype = str(exp.get("type") or "")
        if etype not in ("image", "audio", "video"):
            continue
        eid = str(exp.get("id") or f"{exp.get('node_id')}_{exp.get('param_name')}")
        if not eid or eid in input_props:
            continue
        has_per_node_media = True
        label = str(exp.get("alias") or exp.get("label") or eid)
        input_props[eid] = {
            "type": "string",
            "format": "uri",
            "title": label,
            "description": label,
            "x-handle": etype,
            "x-slot": eid,
            "x-role": infer_media_role(exp),
            "x-comfy-id": eid,
            "x-comfy-param": exp.get("param_name"),
            "x-comfy-node": exp.get("node_id"),
            "required": bool(exp.get("required")),
        }

    # 存在独立槽位时，把标准聚合句柄标记为 x-aggregate，前端据此不再重复画一个泛化多选槽
    if has_per_node_media:
        for agg in ("reference_images", "first_frame", "last_frame", "reference_videos", "reference_audios"):
            if agg in input_props:
                input_props[agg]["x-aggregate"] = True

    # 契约决定可见性：被 App Mode 声明的项按声明顺序排在基础层；
    # 有契约时未声明项一律收进隐藏层（仍暴露给 Agent 与"全部参数"抽屉），无契约时只保留能语义命名的项。
    has_contract = any(bool(e.get("declared")) for e in exposed)

    params_props: Dict[str, Any] = {}
    for exp in exposed:
        etype = str(exp.get("type") or "")
        if etype not in ("number", "combo", "boolean", "text"):
            continue  # image/audio/video 已由 input_schema 槽位承载
        eid = str(exp.get("id") or f"{exp.get('node_id')}_{exp.get('param_name')}")
        if not eid or eid.endswith("_undefined") or "undefined" in eid:
            continue
        if prompt_slot is exp:
            continue  # 正向提示词的唯一入口，避免与标准 prompt 重复成两个输入框
        pname = str(exp.get("param_name", "") or "")
        label = str(exp.get("alias") or exp.get("label") or pname or eid)
        desc = str(exp.get("description") or "") or label
        std = wf_std_alias(pname)
        default_value = exp.get("default_value")

        if etype == "number":
            step = exp.get("step")
            is_int = step in (1, 1.0) or (isinstance(default_value, int) and not isinstance(default_value, bool))
            prop: Dict[str, Any] = {"type": "integer" if is_int else "number", "title": label, "description": desc}
            if default_value is not None:
                prop["default"] = int(default_value) if is_int else default_value
            if exp.get("min") is not None:
                prop["minimum"] = exp["min"]
            if exp.get("max") is not None:
                prop["maximum"] = exp["max"]
            if step is not None:
                prop["step"] = step
        elif etype == "combo":
            raw_opts = [str(o) for o in (exp.get("options") or exp.get("choices") or [])]
            # 剔除 object_info 偶发返回的字典式选项（"{'key': 'on', 'inputs': ...}"），否则下拉出现乱码项
            opts = [o for o in raw_opts if not o.startswith("{") and "'inputs':" not in o]
            if default_value is not None and str(default_value) not in opts:
                opts = [str(default_value)] + opts
            prop = {"type": "string", "title": label, "description": desc, "x-control": "select"}
            if opts:
                prop["enum"] = opts[:60]
            if default_value is not None:
                prop["default"] = str(default_value)
        elif etype == "boolean":
            prop = {"type": "boolean", "title": label, "description": desc,
                    "default": bool(default_value), "x-control": "toggle"}
        else:  # text
            prop = {"type": "string", "title": label, "description": desc, "x-control": "input"}
            if default_value:
                prop["default"] = str(default_value)

        sem = WF_PARAM_SEMANTICS.get(std or "", {})
        if exp.get("declared"):
            # 作者显式声明：顺序即界面顺序，一律进基础层
            category, visibility, agent, priority = "advanced", "basic", "auto", int(exp.get("app_order") or 0) * 10
        elif has_contract:
            # 已有契约却未被声明：属于图内部件，不占创作界面
            category, visibility, agent, priority = "advanced", "hidden", "suggest", 500
        elif std:
            category = sem.get("x-category", "advanced")
            visibility = sem.get("x-visibility", "advanced")
            agent = sem.get("x-agent", "suggest")
            priority = sem.get("x-priority", 50)
        elif etype == "text":
            # 额外文本入口本身就是可创作内容，未命名也保留在高级层
            category, visibility, agent, priority = "advanced", "advanced", "suggest", 70
        else:
            category, visibility, agent, priority = "advanced", "hidden", "suggest", 500
        prop["x-category"] = category
        prop["x-visibility"] = visibility
        prop["x-agent"] = agent
        prop["x-priority"] = priority
        if std:
            prop["x-std-key"] = std
        params_props[eid] = prop

    input_schema = {"type": "object", "properties": input_props, "required": input_required}
    params_schema = {"type": "object", "properties": params_props}
    if kind == "video":
        output_schema = {"type": "object", "properties": {"video_url": {"type": "string", "format": "uri", "x-handle": "video"}}, "required": ["video_url"]}
    elif kind == "audio":
        output_schema = {"type": "object", "properties": {"audio_url": {"type": "string", "format": "uri", "x-handle": "audio"}}, "required": ["audio_url"]}
    else:
        output_schema = {"type": "object", "properties": {"image_url": {"type": "string", "format": "uri", "x-handle": "image"}}, "required": ["image_url"]}
    return kind, input_schema, params_schema, output_schema, exposed


# 工作流→生成源的 Schema 生成规则版本：resolve/auto_detect/_build_* 等规则变更时 +1，
# 存量源在下次启动时自动重建一次。启动 fast path 靠它判断，未变更时全程零网络。
WORKFLOW_SCHEMA_VERSION = 3


def sync_workflow_provider(workflow_id: str, force: bool = False):
    """将单条工作流同步为独立 Provider（comfyui_<id>），仅内部已导出工作流可成为生成源。
    force=True 时跳过快路径强制重建（用户保存白名单 / 读取 App 契约后必须立即生效）。"""
    try:
        # 仅内部工作流可成为独立生成源，外部直读需先“导出为内部”才能在画布作为生成源
        if workflow_id.startswith("ext_"):
            return None
        wf, meta = workflow_manager.get_workflow_with_meta(workflow_id)
        if not wf:
            return None
        if not meta or meta.get("source") != "internal":
            return None
        # Fast path（无 ComfyUI 也能秒级启动的关键）：工作流内容未变、规则版本一致时直接复用存量定义。
        # 白名单默认全关后 exposed 合法为空，不再以"清单非空"作为复用条件；白名单变更走 force 重建。
        content_hash = hashlib.md5(json.dumps(wf, sort_keys=True).encode("utf-8")).hexdigest()[:8]
        pid = _workflow_provider_id(workflow_id)
        from app.providers.custom.manager import custom_provider_manager
        existing = custom_provider_manager.get_definition(pid)
        if (not force
                and existing is not None
                and getattr(existing, "workflow_hash", None) == content_hash
                and getattr(existing, "workflow_id", None) == workflow_id
                and (getattr(existing, "schema_version", None) or 0) == WORKFLOW_SCHEMA_VERSION):
            return existing
        # 内容变更 / 首次同步 / 规则升级 / 用户显式保存白名单：走完整构建（含 ComfyUI 在线探测；
        # 离线时自动降级：白名单内条目保留已存类型与枚举）
        kind, input_schema, params_schema, output_schema, exposed = _build_provider_schemas_from_workflow(wf, meta)
        # 构造 ProviderDefinition
        from app.models.provider_definition import ProviderDefinition
        # 已存在且 hash、暴露清单、输入与参数 schema、规则版本全部未变才跳过
        # （schema 规则升级后需自动重建存量源；版本不一致时落到下方重新保存以盖戳）
        if existing and getattr(existing, "workflow_hash", None) == content_hash and existing.workflow_id == workflow_id:
            same = (
                getattr(existing, "workflow_exposed", None) == exposed
                and (getattr(existing, "params_schema", None) or {}).get("properties") == params_schema.get("properties")
                and (getattr(existing, "input_schema", None) or {}).get("properties") == input_schema.get("properties")
                and (getattr(existing, "schema_version", None) or 0) == WORKFLOW_SCHEMA_VERSION
            )
            if same:
                return existing
        name = (meta or {}).get("name") or workflow_id
        desc = (meta or {}).get("description") or f"ComfyUI 工作流 {workflow_id} 抽象的独立生成源"
        # 模型列表尝试从 ckpt 节点提取
        models: List[str] = []
        try:
            analysis = (meta or {}).get("analysis") or analyze_workflow(wf)
            for ckpt in (analysis.get("checkpoints") or []):
                if ckpt.get("ckpt"):
                    models.append(str(ckpt["ckpt"]))
        except Exception:
            pass
        data: Dict[str, Any] = {
            "id": pid,
            "name": f"ComfyUI {name}",
            "display_name": f"ComfyUI·{name}",
            "kind": kind,
            "provider_type": "comfyui",
            "description": desc,
            "icon": "Workflow",
            "scope": "global",
            "builtin": False,
            "enabled": True,
            "workflow_id": workflow_id,
            "workflow_hash": content_hash,
            "workflow_exposed": exposed,
            "schema_version": WORKFLOW_SCHEMA_VERSION,
            "models": models[:5],
            "default_model": models[0] if models else None,
            "params_schema": params_schema,
            "default_params": {},
            "input_schema": input_schema,
            "output_schema": output_schema,
            "language": "python",
            "code": None,
            "code_entry": "generate",
        }
        pd = ProviderDefinition.model_validate(data)
        saved = custom_provider_manager.save_definition(pd)
        # 热注册到 Registry + MCP
        try:
            from app.providers.init_providers import register_single_custom_provider
            register_single_custom_provider(saved)
        except Exception as e:
            print(f"[WorkflowProvider] hot register failed {pid}: {e}")
        # MCP 刷新已在 register_single 内完成
        return saved
    except Exception as e:
        print(f"[WorkflowProvider] sync {workflow_id} failed: {e}")
        return None


def sync_all_workflow_providers():
    """启动时仅同步已导出的内部工作流为独立生成源（外部直读不自动成源）"""
    try:
        all_wfs = workflow_manager.list_workflows(source="internal")
        cnt = 0
        for wf_meta in all_wfs:
            wid = wf_meta.get("id")
            if not wid:
                continue
            if sync_workflow_provider(wid):
                cnt += 1
        print(f"[WorkflowProvider] 已同步 {cnt}/{len(all_wfs)} 条内部工作流为独立生成源（外部需先导出）")
    except Exception as e:
        print(f"[WorkflowProvider] sync_all failed: {e}")


def remove_workflow_provider(workflow_id: str):
    """删除工作流时同步删除对应 Provider"""
    try:
        pid = _workflow_provider_id(workflow_id)
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.init_providers import unregister_single_custom_provider
        # 推断 kind
        kind = "image"
        try:
            wf, meta = workflow_manager.get_workflow_with_meta(workflow_id)
            if wf:
                kind, _, _, _ = _build_provider_schemas_from_workflow(wf, meta)
        except Exception:
            pass
        # 尝试从已有 definition 取 kind
        existing = custom_provider_manager.get_definition(pid)
        if existing:
            kind = getattr(existing, "kind", kind)
        custom_provider_manager.delete_definition(pid)
        unregister_single_custom_provider(pid, kind=kind)
        print(f"[WorkflowProvider] 已删除 {pid}")
    except Exception as e:
        # 不存在则忽略
        pass
