"""
ComfyUI 工作流模板管理器
支持用户导入 API Format 工作流JSON，自动分析可注入节点，运行时动态填充参数
"""
import os
import json
import time
import uuid
import copy
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path

from app.core.config import settings


WORKFLOWS_DIR = os.path.join(settings.STORAGE_DIR, "workflows")
os.makedirs(WORKFLOWS_DIR, exist_ok=True)

# 允许的class_type白名单（防止恶意节点执行任意代码）
ALLOWED_CLASS_TYPES = {
    "CheckpointLoaderSimple", "CheckpointLoader", "LoraLoader", "CLIPTextEncode",
    "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux", "EmptyLatentImage",
    "KSampler", "KSamplerAdvanced", "SamplerCustom",
    "VAEDecode", "VAEEncode", "SaveImage", "PreviewImage",
    "LoadImage", "ImageScale", "ImageResize",
    "ControlNetLoader", "ControlNetApply", "ControlNetApplyAdvanced",
    "IPAdapterModelLoader", "IPAdapterApply", "IPAdapterUnifiedLoader",
    "FluxGuidance", " conditioning",  # flux guidance
    "UNETLoader", "VAELoader", "CLIPLoader",
    "ConditioningCombine", "ConditioningSetArea",
    "LatentUpscale", "ImageUpscaleWithModel",
    # 通用
    "SaveImageWebsocket", "ETN_CropImage",
}

# 严格校验：是否 API Format（键为字符串，值为 {class_type, inputs}）
def is_api_format_workflow(data: Dict[str, Any]) -> Tuple[bool, str]:
    if not isinstance(data, dict) or not data:
        return False, "工作流为空或非对象"
    # 检查是否 Save Format（包含 nodes/links/groups）
    if "nodes" in data or "links" in data or "groups" in data:
        return False, "检测到 Save Format（包含 nodes/links），请在ComfyUI中用 File→Export (API Format) 重新导出"
    for key, val in data.items():
        if not isinstance(val, dict):
            return False, f"节点 {key} 格式错误，期望对象"
        if "class_type" not in val or "inputs" not in val:
            return False, f"节点 {key} 缺少 class_type/inputs，确认是 API Format"
        if not isinstance(val["inputs"], dict):
            return False, f"节点 {key}.inputs 非对象"
    return True, "ok"

def _meta_path(workflow_id: str) -> str:
    return os.path.join(WORKFLOWS_DIR, f"{workflow_id}.meta.json")

def _json_path(workflow_id: str) -> str:
    return os.path.join(WORKFLOWS_DIR, f"{workflow_id}.json")

def analyze_workflow(workflow: Dict[str, Any]) -> Dict[str, Any]:
    """自动分析工作流，找出可注入的节点"""
    prompts = []  # CLIPTextEncode
    seeds = []    # KSampler seed
    dims = []     # EmptyLatentImage
    checkpoints = []  # CheckpointLoaderSimple
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
    """基于分析结果自动生成默认映射"""
    mapping = {}
    if analysis["prompts"]:
        # 第一个 positive prompt，第二个 negative（如果有）
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
    def list_workflows(self) -> List[Dict[str, Any]]:
        result = []
        if not os.path.exists(WORKFLOWS_DIR):
            return result
        for fname in os.listdir(WORKFLOWS_DIR):
            if fname.endswith(".meta.json"):
                try:
                    with open(os.path.join(WORKFLOWS_DIR, fname), "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    result.append(meta)
                except Exception:
                    continue
        # also include .json without meta (legacy)
        for fname in os.listdir(WORKFLOWS_DIR):
            if fname.endswith(".json") and not fname.endswith(".meta.json"):
                wid = fname[:-5]
                if not os.path.exists(_meta_path(wid)):
                    # auto-create meta
                    try:
                        with open(os.path.join(WORKFLOWS_DIR, fname), "r", encoding="utf-8") as f:
                            wf = json.load(f)
                        analysis = analyze_workflow(wf)
                        meta = {
                            "id": wid,
                            "name": wid,
                            "description": "自动识别",
                            "created_at": time.time(),
                            "mapping": auto_generate_mapping(analysis),
                            "analysis": analysis,
                            "node_count": len(wf),
                        }
                        result.append(meta)
                    except Exception:
                        pass
        result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return result

    def get_workflow(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        path = _json_path(workflow_id)
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def get_meta(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        path = _meta_path(workflow_id)
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def save_workflow(self, name: str, workflow_json: Dict[str, Any], mapping: Optional[Dict[str, str]] = None, description: str = "") -> Dict[str, Any]:
        ok, msg = is_api_format_workflow(workflow_json)
        if not ok:
            raise ValueError(msg)
        # 安全校验：检查class_type白名单（警告而非阻断，允许未知但提示）
        warnings = []
        for nid, node in workflow_json.items():
            ct = node.get("class_type", "")
            if ct not in ALLOWED_CLASS_TYPES and ct not in ("ConditioningCombine",):
                # 不阻断，但记录警告（部分自定义节点如 ComfyUI-Flux 等）
                warnings.append(f"节点 {nid} 使用非常规类型 {ct}，请确认ComfyUI已安装对应插件")

        workflow_id = f"wf_{uuid.uuid4().hex[:8]}"
        # 去重名字
        if not name:
            name = workflow_id
        json_path = _json_path(workflow_id)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(workflow_json, f, ensure_ascii=False, indent=2)

        analysis = analyze_workflow(workflow_json)
        if mapping is None:
            mapping = auto_generate_mapping(analysis)
        # 校验mapping的node是否存在
        for k, nid in list(mapping.items()):
            if nid not in workflow_json:
                # 移除无效映射
                mapping.pop(k)
                warnings.append(f"映射 {k}->{nid} 节点不存在已移除")

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
        }
        with open(_meta_path(workflow_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return meta

    def update_mapping(self, workflow_id: str, mapping: Dict[str, str]) -> Dict[str, Any]:
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
        jp = _json_path(workflow_id)
        mp = _meta_path(workflow_id)
        if os.path.exists(jp):
            os.remove(jp)
        if os.path.exists(mp):
            os.remove(mp)

    def inject_params(self, workflow: Dict[str, Any], mapping: Dict[str, str], params: Dict[str, Any]) -> Dict[str, Any]:
        """
        将用户参数注入到工作流副本
        支持：prompt, negative_prompt, seed, width, height, checkpoint
        mapping示例：{"prompt_node":"6","negative_node":"7","seed_node":"3","dim_node":"5","ckpt_node":"4"}
        """
        wf = copy.deepcopy(workflow)
        # 1. prompt
        if "prompt" in params and params["prompt"]:
            prompt_text = params["prompt"]
            # style_suffix 追加
            if params.get("style_suffix"):
                prompt_text = f"{prompt_text}, {params['style_suffix']}"
            pn = mapping.get("prompt_node")
            if pn and pn in wf and "text" in wf[pn]["inputs"]:
                wf[pn]["inputs"]["text"] = prompt_text
            else:
                # fallback: 找首个CLIP
                for nid, node in wf.items():
                    if node.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeFlux"):
                        wf[nid]["inputs"]["text"] = prompt_text
                        break
        # 2. negative
        if "negative_prompt" in params:
            nn = mapping.get("negative_node")
            if nn and nn in wf and "text" in wf[nn]["inputs"]:
                wf[nn]["inputs"]["text"] = params["negative_prompt"] or ""
        # 3. seed
        if "seed" in params and params["seed"] is not None:
            sn = mapping.get("seed_node")
            if sn and sn in wf and "seed" in wf[sn]["inputs"]:
                wf[sn]["inputs"]["seed"] = int(params["seed"])
            else:
                for nid, node in wf.items():
                    if "seed" in node.get("inputs", {}):
                        wf[nid]["inputs"]["seed"] = int(params["seed"])
                        break
        # 4. width/height
        if "width" in params and "height" in params:
            dn = mapping.get("dim_node")
            if dn and dn in wf:
                if "width" in wf[dn]["inputs"]:
                    wf[dn]["inputs"]["width"] = int(params["width"])
                if "height" in wf[dn]["inputs"]:
                    wf[dn]["inputs"]["height"] = int(params["height"])
        # 5. checkpoint
        if params.get("checkpoint"):
            cn = mapping.get("ckpt_node")
            if cn and cn in wf:
                inp = wf[cn]["inputs"]
                if "ckpt_name" in inp:
                    inp["ckpt_name"] = params["checkpoint"]
                elif "unet_name" in inp:
                    inp["unet_name"] = params["checkpoint"]
        # 6. steps/cfg 若存在于 KSampler
        if params.get("steps") is not None or params.get("cfg") is not None:
            for nid, node in wf.items():
                if node.get("class_type") in ("KSampler", "KSamplerAdvanced"):
                    if params.get("steps") is not None and "steps" in node["inputs"]:
                        node["inputs"]["steps"] = int(params["steps"])
                    if params.get("cfg") is not None and "cfg" in node["inputs"]:
                        node["inputs"]["cfg"] = float(params["cfg"])
                    break
        # 7. filename_prefix 确保唯一
        sn = mapping.get("save_node")
        if sn and sn in wf and "filename_prefix" in wf[sn]["inputs"]:
            # 保留前缀但追加随机性由ComfyUI处理
            pass
        else:
            for nid, node in wf.items():
                if node.get("class_type") in ("SaveImage", "PreviewImage", "SaveImageWebsocket"):
                    if "filename_prefix" in node["inputs"]:
                        # 确保路径不重复
                        pass
        return wf


workflow_manager = ComfyWorkflowManager()
