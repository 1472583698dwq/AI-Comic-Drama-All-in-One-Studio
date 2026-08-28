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


def _fetch_object_info(timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    global _OBJECT_INFO_CACHE, _OBJECT_INFO_CACHE_TS
    if _OBJECT_INFO_CACHE is not None and time.time() - _OBJECT_INFO_CACHE_TS < 300:
        return _OBJECT_INFO_CACHE
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
    return None


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
        "CR Note", "CR Text", "Markdown", "Reroute", "PrimitiveNode"
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
    返回 ComfyUI 内部引用的文件名 (如 upload_abc123.png)
    """
    if not image_source:
        return ""
    
    if not server_url:
        server_url = (getattr(settings, "COMFYUI_SERVER_URL", "") or "http://127.0.0.1:8188").rstrip("/")

    import httpx
    import base64
    import uuid as uuidlib

    filename = f"upload_{uuidlib.uuid4().hex[:8]}.png"
    file_bytes = None

    if image_source.startswith("data:image/"):
        # Base64 Data URL
        try:
            header, b64data = image_source.split(",", 1)
            file_bytes = base64.b64decode(b64data)
            if "image/jpeg" in header or "image/jpg" in header:
                filename = f"upload_{uuidlib.uuid4().hex[:8]}.jpg"
            elif "image/webp" in header:
                filename = f"upload_{uuidlib.uuid4().hex[:8]}.webp"
        except Exception as e:
            raise ValueError(f"解析 Base64 图片失败: {e}")
    elif image_source.startswith("/storage/"):
        # 本地存储相对路径
        rel = image_source[len("/storage/"):]
        local_path = os.path.join(settings.STORAGE_DIR, rel)
        if os.path.exists(local_path):
            with open(local_path, "rb") as f:
                file_bytes = f.read()
            filename = os.path.basename(local_path)
        else:
            raise FileNotFoundError(f"本地素材不存在: {image_source}")
    elif os.path.exists(image_source) and os.path.isfile(image_source):
        # 绝对文件路径
        with open(image_source, "rb") as f:
            file_bytes = f.read()
        filename = os.path.basename(image_source)
    elif image_source.startswith("http://") or image_source.startswith("https://"):
        # 远程 HTTP URL
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(image_source)
            r.raise_for_status()
            file_bytes = r.content
            filename = os.path.basename(image_source.split("?")[0]) or filename
    else:
        # 已是纯文件名 (如已经在 ComfyUI input 目录中)
        return image_source

    if not file_bytes:
        raise ValueError(f"无法读取图片内容: {image_source}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        files = {"image": (filename, file_bytes, "image/png")}
        r = await client.post(f"{server_url}/upload/image", files=files)
        r.raise_for_status()
        res_data = r.json()
        return res_data.get("name") or filename


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

        # 1. 探测图片输入 (LoadImage / LoadImageMask)
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
                    "description": "支持上传角色立绘、构图草图或姿态参考图",
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
                        exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"采样器 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "euler", "description": "采样器", "options": VALID_SAMPLERS})
                    elif pname == "scheduler":
                        exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"调度器 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "normal", "description": "调度器", "options": VALID_SCHEDULERS})
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
        # 2.3.1 探测 VAELoader（模型下拉而非手填）
        elif ct == "VAELoader":
            if "vae_name" in inputs:
                pval = inputs.get("vae_name")
                is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                if not is_linked:
                    exposed.append({"id": f"combo_{nid}_vae_name", "node_id": str(nid), "param_name": "vae_name", "label": f"VAE模型 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "qwen_image_vae.safetensors", "description": "VAE模型，下拉选择而非手填", "options": []})
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
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"画面比例 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "1:1 (Square)", "description": "画面比例 下拉", "options": ["1:1 (Square)","9:16 (Portrait)","16:9 (Landscape)","3:2","4:3","21:9"]})
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
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"分辨率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "720p", "description": "分辨率 480p/720p/1080p 下拉", "options": ["480p","720p","1080p"]})
                elif pname in ("duration",):
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"时长秒 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 5, "description": "时长 3-15 秒", "min": 3, "max": 15, "step": 1})
                elif pname in ("length", "num_frames", "frames"):
                    # 帧数按 duration 推导，但仍暴露为独立滑杆
                    dv = int(pval) if isinstance(pval, (int,float)) else 81
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": dv, "description": "帧数 16~241", "min": 16, "max": 241, "step": 1})
                elif pname in ("fps", "frame_rate"):
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"帧率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "24", "description": "帧率", "options": ["16","24","30"]})
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
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"分辨率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "720p", "description": "480p/720p/1080p", "options": ["480p","720p","1080p"]})
                elif pname == "duration":
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"时长 ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval, (int,float)) else 5, "description": "3-15秒", "min": 3, "max": 15, "step": 1})
                elif pname in ("fps",):
                    exposed.append({"id": f"combo_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"帧率 ({title})", "type": "combo", "required": False, "default_value": str(pval) if pval else "24", "description": "帧率", "options": ["16","24","30"]})
                else:
                    exposed.append({"id": f"num_{nid}_{pname}", "node_id": str(nid), "param_name": pname, "label": f"{pname} ({title})", "type": "number", "required": False, "default_value": int(pval) if isinstance(pval,(int,float)) else 720, "description": pname, "min": 256, "max": 2048, "step": 64})
        # 3. 通用子图/自定义节点：保持为单节点的子图，其输入即暴露参数
        #    区分输入节点（linked）与参数节点（direct）：即使已链接也暴露，允许用户覆盖外部输入
        else:
            # 仅对疑似子图或未在白名单的自定义节点进行通用暴露，避免过度暴露
            if any(h in ct.lower() for h in ("video", "wan", "hunyuan", "cogvideo", "mochi")) or ct not in ALLOWED_CLASS_TYPES:
                for pname, pval in inputs.items():
                    is_linked = isinstance(pval, list) and len(pval) == 2 and isinstance(pval[0], str)
                    # 仅暴露关键可编辑输入，避免噪音
                    if pname in ("prompt", "text", "negative_prompt", "image", "reference_image", "first_frame", "last_frame", "start_image", "value", "string"):
                        ptype = "image" if any(k in pname.lower() for k in ("image", "frame")) else "text"
                        # 对于子图，即使已链接也暴露，允许覆盖
                        exposed.append({
                            "id": f"exp_{nid}_{pname}",
                            "node_id": str(nid),
                            "param_name": pname,
                            "label": f"{pname} ({title})",
                            "type": ptype,
                            "required": False,
                            "default_value": "" if is_linked else (str(pval)[:200] if isinstance(pval, str) else ""),
                            "description": f"子图节点 {title} 的 {pname} 输入（{'已链接外部' if is_linked else '直连参数'}，可覆盖）",
                        })

    return exposed


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
        all_wfs.sort(key=lambda x: (x.get("source") != "internal", -x.get("created_at", 0)))
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

    def save_workflow(self, name: str, workflow_json: Dict[str, Any], mapping: Optional[Dict[str, str]] = None, description: str = "") -> Dict[str, Any]:
        converted = False
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
        }
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    def import_external_workflow(self, external_id: str, new_name: Optional[str] = None) -> Dict[str, Any]:
        """将外部工作流导入为内部持久化工作流"""
        wf, meta = self.get_workflow_with_meta(external_id)
        if not wf or not meta:
            raise FileNotFoundError(f"外部工作流不存在: {external_id}")
        if not meta.get("is_api_format"):
            raise ValueError(f"该外部工作流非API Format，无法导入: {meta.get('error')}")
        return self.save_workflow(name=new_name or meta.get("name", "imported"), workflow_json=wf, mapping=meta.get("mapping"), description=f"从 {meta.get('file_path')} 导入")

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
        # 扩展：本项目历史过滤的注释类型
        NON_EXECUTABLE_CLASSES = CLI_UI_ONLY | {
            "TextNote", "WorkflowNotes", "GroupNote",
            "Comment", "DisplayNote", "PrimitiveNodeNote", "EasyMarkdown",
            "CR Note", "CR Text", "Markdown", "LoadImageOutput"
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

        # 2. 应用用户自定义节点参数覆写
        if node_overrides:
            for nid, overrides in node_overrides.items():
                if str(nid) in wf and isinstance(overrides, dict):
                    node_inputs = wf[str(nid)].setdefault("inputs", {})
                    for k, v in overrides.items():
                        if v is not None:
                            node_inputs[k] = v

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
                # 全量模式才回退扫描：优先检查 PrimitiveStringMultiline 等
                for nid, node in wf.items():
                    if node.get("class_type") in ("PrimitiveStringMultiline", "PrimitiveNode", "CR Text", "StringLiteral"):
                        val_inp = node.get("inputs", {}).get("value")
                        if val_inp is not None and not (isinstance(val_inp, list) and len(val_inp) == 2):
                            node["inputs"]["value"] = prompt_text
                            injected_prompt = True
                            break
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
        # 7. 最后应用外部动态输入（暴露输入优先，确保用户在画布/素材库中对提示词/垫图的修改最终生效）
        if dynamic_inputs and isinstance(dynamic_inputs, dict):
            for k, val in dynamic_inputs.items():
                if val is None or val == "":
                    continue
                if isinstance(val, dict):
                    if str(k) in wf:
                        node_inputs = wf[str(k)].setdefault("inputs", {})
                        for param_k, param_v in val.items():
                            if param_v is not None:
                                node_inputs[param_k] = param_v
                elif str(k).startswith("exp_"):
                    exp_rest = str(k)[len("exp_"):]
                    found = False
                    for existing_nid in wf.keys():
                        if exp_rest.startswith(f"{existing_nid}_"):
                            pname = exp_rest[len(f"{existing_nid}_"):]
                            if pname and pname != "undefined":
                                wf[existing_nid].setdefault("inputs", {})[pname] = val
                            found = True
                            break
                    if not found and "_" in exp_rest:
                        parts = exp_rest.rsplit("_", 1)
                        if parts[0] in wf and parts[1] and parts[1] != "undefined":
                            wf[parts[0]].setdefault("inputs", {})[parts[1]] = val
                elif str(k).startswith("img_") or str(k).startswith("txt_"):
                    try:
                        prefix, target_nid = str(k).split("_", 1)
                    except ValueError:
                        continue
                    if target_nid in wf:
                        n_inps = wf[target_nid].setdefault("inputs", {})
                        if prefix == "img":
                            n_inps["image"] = val
                        elif prefix == "txt":
                            if "text" in n_inps:
                                n_inps["text"] = val
                            elif "string" in n_inps:
                                n_inps["string"] = val
                            else:
                                n_inps["text"] = val
                elif str(k) in wf:
                    n_inps = wf[str(k)].setdefault("inputs", {})
                    if "image" in n_inps:
                        n_inps["image"] = val
                    elif "text" in n_inps:
                        n_inps["text"] = val
                    elif "string" in n_inps:
                        n_inps["string"] = val
                    elif "value" in n_inps:
                        n_inps["value"] = val
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
                            wf[str(nid)]["inputs"][k] = v

        # 2. 动态输入（若提供，已在上层完成上传，此处直接覆盖）
        if dynamic_inputs and isinstance(dynamic_inputs, dict):
            for k, val in dynamic_inputs.items():
                if val is None or val == "":
                    continue
                if isinstance(val, dict) and str(k) in wf:
                    for pk, pv in val.items():
                        if pv is not None:
                            wf[str(k)]["inputs"][pk] = pv
                elif str(k).startswith("exp_"):
                    exp_rest = str(k)[len("exp_"):]
                    for nid in wf.keys():
                        if exp_rest.startswith(f"{nid}_"):
                            pname = exp_rest[len(f"{nid}_"):]
                            if pname and pname != "undefined":
                                wf[nid]["inputs"][pname] = val
                            break
                elif str(k).startswith("img_") or str(k).startswith("txt_"):
                    try:
                        prefix, target_nid = str(k).split("_", 1)
                        if target_nid in wf:
                            if prefix == "img":
                                wf[target_nid]["inputs"]["image"] = val
                            elif prefix == "txt":
                                wf[target_nid]["inputs"]["text" if "text" in wf[target_nid]["inputs"] else "string"] = val
                    except ValueError:
                        pass
                elif str(k) in wf:
                    # 直接覆盖，智能判断
                    inp = wf[str(k)]["inputs"]
                    if "image" in inp:
                        inp["image"] = val
                    elif "text" in inp:
                        inp["text"] = val
                    elif "string" in inp:
                        inp["string"] = val

        # 3. Prompt 注入（视频运动描述）
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
                    for nid, node in wf.items():
                        if node.get("class_type") in ("PrimitiveStringMultiline", "StringLiteral"):
                            if "value" in node.get("inputs", {}) and not isinstance(node["inputs"]["value"], list):
                                node["inputs"]["value"] = prompt_text
                                break

        if params.get("negative_prompt") and not is_api_frugally:
            nn = mapping.get("negative_node")
            if nn and str(nn) in wf and "text" in wf[str(nn)].get("inputs", {}):
                wf[str(nn)]["inputs"]["text"] = params["negative_prompt"] or ""

        # 4. 图像注入：I2V/R2V 适配
        # first_frame_url 已在上层上传为文件名，params 中以 image 名称形式传入
        # 尝试匹配所有 LoadImage / LoadImageMask / CreateVideo image 等
        image_sources = []
        if params.get("first_frame_url"):
            image_sources.append(("first", params["first_frame_url"]))
        if params.get("last_frame_url"):
            image_sources.append(("last", params["last_frame_url"]))
        if params.get("reference_images"):
            for idx, ref in enumerate(params["reference_images"]):
                image_sources.append((f"ref_{idx}", ref))

        if image_sources:
            # 收集所有可注入图像的节点
            load_nodes = []
            for nid, node in wf.items():
                ct = node.get("class_type", "")
                inputs = node.get("inputs", {})
                # 常见图像输入节点
                if ct in ("LoadImage", "LoadImageMask", "LoadImageOutput", "ImageLoad", "VHS_LoadVideo", "LoadVideo"):
                    if "image" in inputs or "video" in inputs:
                        load_nodes.append(nid)
                elif ct in ("WanImageToVideo", "WanVaceToVideo", "WanFirstMiddleLastFrameToVideo", "CreateVideo"):
                    # 这些节点直接接受 image/video 输入
                    if any(k in inputs for k in ("image", "first_frame", "last_frame", "reference_image", "start_image")):
                        load_nodes.append(nid)
            # 优先按 order 分配
            # I2V:首帧 -> 第一个 LoadImage
            # R2V:多参考 -> 依次分配
            # 若工作流本身只有 1 个 LoadImage 但传入多张参考，则后续参考将通过 dynamic_inputs 注入（已处理），此处仅处理首帧
            for idx, (role, img_name) in enumerate(image_sources):
                if idx < len(load_nodes):
                    nid = load_nodes[idx]
                    node = wf[nid]
                    # 选择正确的输入键
                    inputs = node["inputs"]
                    if "image" in inputs:
                        # 若已是连线，跳过（节俭模式保留连线）
                        if is_api_frugally and isinstance(inputs["image"], list) and len(inputs["image"]) == 2:
                            continue
                        inputs["image"] = img_name
                    elif "first_frame" in inputs and role == "first":
                        inputs["first_frame"] = img_name
                    elif "last_frame" in inputs and role == "last":
                        inputs["last_frame"] = img_name
                    elif "reference_image" in inputs:
                        inputs["reference_image"] = img_name
                    elif "video" in inputs:
                        inputs["video"] = img_name
                elif not is_api_frugally:
                    # 全量模式：若仍有剩余参考图，尝试创建虚拟注入到首个可接受多图的节点
                    # 例如 WanVaceToVideo 的 reference_images 为列表
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
                if isinstance(spec, (list, tuple)) and len(spec) > 0:
                    t_info = spec[0]
                    if isinstance(t_info, list):
                        ptype = "COMBO"
                        choices = t_info
                    elif isinstance(t_info, str):
                        ptype = t_info
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

        current_mapping = (meta.get("mapping") if meta else None) or auto_generate_mapping(analyze_workflow(clean_wf))
        exposed_inputs = (meta.get("exposed_inputs") if meta else None)
        if exposed_inputs is None:
            exposed_inputs = auto_detect_exposed_inputs(clean_wf, current_mapping)

        return {
            "workflow_id": workflow_id,
            "name": meta.get("name", workflow_id) if meta else workflow_id,
            "description": meta.get("description", "") if meta else "",
            "source": meta.get("source", "internal") if meta else "internal",
            "mapping": current_mapping,
            "node_overrides": node_overrides,
            "exposed_inputs": exposed_inputs,
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
        meta = self.get_meta(workflow_id)
        if not meta:
            raise FileNotFoundError(f"工作流不存在: {workflow_id}")

        if mapping is not None:
            meta["mapping"] = mapping
        if node_overrides is not None:
            meta["node_overrides"] = node_overrides
        if exposed_inputs is not None:
            meta["exposed_inputs"] = exposed_inputs
        meta["updated_at"] = time.time()

        os.makedirs(WORKFLOWS_DIR, exist_ok=True)
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

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
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(f"{server_url}/prompt", json={"prompt": injected, "client_id": "test_validate"})
                if r.status_code == 200:
                    return {"valid": True, "node_count": len(injected), "prompt_id": r.json().get("prompt_id")}

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
