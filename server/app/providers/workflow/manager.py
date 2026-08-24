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


WORKFLOWS_DIR = os.path.join(settings.STORAGE_DIR, "workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)

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

# 允许的class_type白名单
ALLOWED_CLASS_TYPES = {
    "CheckpointLoaderSimple", "CheckpointLoader", "LoraLoader", "CLIPTextEncode",
    "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux", "EmptyLatentImage",
    "KSampler", "KSamplerAdvanced", "SamplerCustom",
    "VAEDecode", "VAEEncode", "SaveImage", "PreviewImage",
    "LoadImage", "ImageScale", "ImageResize",
    "ControlNetLoader", "ControlNetApply", "ControlNetApplyAdvanced",
    "IPAdapterModelLoader", "IPAdapterApply", "IPAdapterUnifiedLoader",
    "FluxGuidance", " conditioning",
    "UNETLoader", "VAELoader", "CLIPLoader",
    "ConditioningCombine", "ConditioningSetArea",
    "LatentUpscale", "ImageUpscaleWithModel",
    "SaveImageWebsocket", "ETN_CropImage",
}

def is_api_format_workflow(data: Dict[str, Any]) -> Tuple[bool, str]:
    if not isinstance(data, dict) or not data:
        return False, "工作流为空或非对象"
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
    return isinstance(data, dict) and "nodes" in data and isinstance(data["nodes"], list)


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


def convert_save_format_to_api_format(data: Dict[str, Any], object_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not is_save_format_workflow(data):
        raise ValueError("非 Save Format，无法转换")
    if object_info is None:
        object_info = _fetch_object_info()

    nodes: List[Dict[str, Any]] = data.get("nodes", [])
    links: List[List[Any]] = data.get("links", []) or []

    link_map: Dict[int, Tuple[Any, Any, Any, Any]] = {}
    for lk in links:
        if isinstance(lk, (list, tuple)) and len(lk) >= 5:
            lid, src_id, src_slot, dst_id, dst_slot = lk[0], lk[1], lk[2], lk[3], lk[4]
            link_map[lid] = (src_id, src_slot, dst_id, dst_slot)

    # Collect primitive values and reroute passthrough
    primitive_values: Dict[str, Any] = {}
    reroute_map: Dict[str, Tuple[Any, Any]] = {}
    node_by_id: Dict[str, Dict[str, Any]] = {}
    for n in nodes:
        nid = str(n.get("id"))
        node_by_id[nid] = n
        if n.get("type") == "PrimitiveNode":
            wv = n.get("widgets_values") or []
            if isinstance(wv, list) and wv:
                primitive_values[nid] = wv[0]
            elif isinstance(wv, dict) and wv:
                primitive_values[nid] = next(iter(wv.values()))
        if n.get("type") == "Reroute":
            # find its single input link
            for inp in (n.get("inputs") or []):
                lk = inp.get("link")
                if lk is not None and lk in link_map:
                    src_id, src_slot, _, _ = link_map[lk]
                    reroute_map[nid] = (str(src_id), src_slot)
                    break

    def resolve_reroute(src_id: str, src_slot: Any, depth: int = 0) -> Tuple[str, Any]:
        if depth > 20:
            return src_id, src_slot
        if src_id in reroute_map:
            inner_src, inner_slot = reroute_map[src_id]
            return resolve_reroute(inner_src, inner_slot, depth + 1)
        return src_id, src_slot

    def resolve_primitive(src_id: str, src_slot: Any) -> Tuple[Optional[str], Optional[Any], Optional[Any]]:
        # returns (resolved_id, resolved_slot, primitive_value_or_None)
        if src_id in primitive_values:
            return None, None, primitive_values[src_id]
        return src_id, src_slot, None

    api: Dict[str, Any] = {}

    for n in nodes:
        nid = str(n.get("id"))
        ntype = n.get("type")
        if not ntype or ntype in ("Note", "Reroute", "PrimitiveNode"):
            continue
        mode = n.get("mode", 0)
        if mode in (2, 4):
            continue

        widgets_values = n.get("widgets_values") or []
        if isinstance(widgets_values, dict):
            widgets_values = list(widgets_values.values())
        if not isinstance(widgets_values, list):
            widgets_values = []

        # Filter control_after_generate values that may be paired
        # Keep as-is for mapping; object_info will handle ordering

        # Build linked inputs
        linked: Dict[str, Any] = {}
        for inp in (n.get("inputs") or []):
            lk = inp.get("link")
            if lk is None:
                continue
            if lk not in link_map:
                continue
            src_id, src_slot, dst_id, dst_slot = link_map[lk]
            src_id_str = str(src_id)
            src_id_str, src_slot = resolve_reroute(src_id_str, src_slot)
            # Primitive inline
            _, _, prim_val = resolve_primitive(src_id_str, src_slot)
            if prim_val is not None:
                # Inline primitive value as widget-like
                # We'll treat as widget; need name to place
                # Defer: store as linked with primitive flag
                linked[inp.get("name")] = prim_val
                continue
            linked[inp.get("name")] = [src_id_str, int(src_slot) if isinstance(src_slot, int) else src_slot]

        # Determine widget names order
        widget_names = _widget_names_for_type(ntype, object_info)
        # If we have widget_names, assign widgets_values sequentially to those names not already linked
        # For nodes without known order, fallback to node inputs with widget=True or remaining
        inputs: Dict[str, Any] = {}
        # first, linked
        for k, v in linked.items():
            if isinstance(v, list):
                inputs[k] = v
            else:
                inputs[k] = v

        # Assign widgets_values
        if widget_names:
            # Control values filtering: remove control_after_generate strings that are paired
            filtered = []
            for v in widgets_values:
                if v in ("fixed", "increment", "decrement", "randomize"):
                    continue
                filtered.append(v)
            # Map filtered values to widget_names that are not yet in inputs
            pending = [w for w in widget_names if w not in inputs]
            for idx, val in enumerate(filtered):
                if idx < len(pending):
                    wname = pending[idx]
                    if wname not in inputs:
                        inputs[wname] = val
                else:
                    break
            # Any remaining widgets_values as dict entries with list/dict values (e.g., lora blocks)
            # Keep extra dict lora entries
            for val in widgets_values:
                if isinstance(val, dict) and val:
                    # find next pending lora slot
                    for p in pending:
                        if p.startswith("lora_") and p not in inputs:
                            inputs[p] = val
                            break
        else:
            # Fallback heuristic: remaining inputs not linked are widget slots; assign by order
            node_input_names = [inp.get("name") for inp in (n.get("inputs") or []) if inp.get("name")]
            # widget_inputs = those not in linked keys
            unlinked = [nm for nm in node_input_names if nm not in inputs]
            # For widget_values, try to assign to unlinked names if count matches, else create generic?
            for idx, val in enumerate(widgets_values):
                if isinstance(val, dict):
                    continue
                if val in ("fixed", "increment", "decrement", "randomize"):
                    continue
                if idx < len(unlinked):
                    inputs[unlinked[idx]] = val

        # Fill defaults for missing required combo/widget defaults if object_info available
        if object_info and ntype in object_info:
            try:
                info = object_info[ntype]
                for section in ("required", "optional"):
                    if section not in info.get("input", {}):
                        continue
                    for k, spec in info["input"][section].items():
                        if k in inputs or k in linked:
                            continue
                        if isinstance(spec, (list, tuple)) and len(spec) >= 2 and isinstance(spec[1], dict) and "default" in spec[1]:
                            inputs[k] = spec[1]["default"]
                        elif isinstance(spec, (list, tuple)) and isinstance(spec[0], list) and spec[0]:
                            inputs[k] = spec[0][0]
            except Exception:
                pass

        api[nid] = {"class_type": ntype, "inputs": inputs}
        # preserve title
        title = n.get("title") or n.get("properties", {}).get("Node name for S&R") or ntype
        api[nid]["_meta"] = {"title": title}

    if not api:
        raise ValueError("转换后无有效节点，请确认工作流包含可执行节点")
    return api


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

    def list_workflows(self, source: str = "all") -> List[Dict[str, Any]]:
        """
        source: all | internal | external
        默认 all 会合并内部+外部，外部可直接使用无需导入
        """
        internal = self.list_internal_workflows() if source in ("all", "internal") else []
        external = self.list_external_workflows() if source in ("all", "external") else []
        # 合并并按名称/时间排序，外部优先显示？
        all_wfs = internal + external
        # 按 source 和创建时间排序：内部在前或按时间倒序
        all_wfs.sort(key=lambda x: (x.get("source") != "internal", -x.get("created_at", 0)))
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
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                meta = json.load(f)
                meta["source"] = "internal"
                return meta
        if workflow_id.startswith("ext_"):
            for wf_meta in self.list_external_workflows():
                if wf_meta["id"] == workflow_id:
                    return wf_meta
        return None

    def get_workflow_with_meta(self, workflow_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        if workflow_id.startswith("ext_"):
            for wf_meta in self.list_external_workflows():
                if wf_meta["id"] == workflow_id:
                    fpath = wf_meta.get("file_path")
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
                                return data, wf_meta
                        return data, wf_meta
                    except Exception:
                        return None, None
            return None, None
        wf = self.get_workflow(workflow_id)
        meta = self.get_meta(workflow_id)
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

    def inject_params(self, workflow: Dict[str, Any], mapping: Dict[str, str], params: Dict[str, Any]) -> Dict[str, Any]:
        wf = copy.deepcopy(workflow)
        if "prompt" in params and params["prompt"]:
            prompt_text = params["prompt"]
            if params.get("style_suffix"):
                prompt_text = f"{prompt_text}, {params['style_suffix']}"
            pn = mapping.get("prompt_node")
            if pn and pn in wf and "text" in wf[pn]["inputs"]:
                wf[pn]["inputs"]["text"] = prompt_text
            else:
                for nid, node in wf.items():
                    if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux"):
                        wf[nid]["inputs"]["text"] = prompt_text
                        break
        if "negative_prompt" in params:
            nn = mapping.get("negative_node")
            if nn and nn in wf and "text" in wf[nn]["inputs"]:
                wf[nn]["inputs"]["text"] = params["negative_prompt"] or ""
        if "seed" in params and params["seed"] is not None:
            sn = mapping.get("seed_node")
            if sn and sn in wf and "seed" in wf[sn]["inputs"]:
                wf[sn]["inputs"]["seed"] = int(params["seed"])
            else:
                for nid, node in wf.items():
                    if "seed" in node.get("inputs", {}):
                        wf[nid]["inputs"]["seed"] = int(params["seed"])
                        break
        if "width" in params and "height" in params:
            dn = mapping.get("dim_node")
            if dn and dn in wf:
                if "width" in wf[dn]["inputs"]:
                    wf[dn]["inputs"]["width"] = int(params["width"])
                if "height" in wf[dn]["inputs"]:
                    wf[dn]["inputs"]["height"] = int(params["height"])
        if params.get("checkpoint"):
            cn = mapping.get("ckpt_node")
            if cn and cn in wf:
                inp = wf[cn]["inputs"]
                if "ckpt_name" in inp:
                    inp["ckpt_name"] = params["checkpoint"]
                elif "unet_name" in inp:
                    inp["unet_name"] = params["checkpoint"]
        if params.get("steps") is not None or params.get("cfg") is not None:
            for nid, node in wf.items():
                if node.get("class_type") in ("KSampler", "KSamplerAdvanced"):
                    if params.get("steps") is not None and "steps" in node["inputs"]:
                        node["inputs"]["steps"] = int(params["steps"])
                    if params.get("cfg") is not None and "cfg" in node["inputs"]:
                        node["inputs"]["cfg"] = float(params["cfg"])
                    break
        return wf


workflow_manager = ComfyWorkflowManager()
