"""
画布 DAG 执行引擎 — 复用现有 Providers + MCP 工具
节点类型映射到真实生成能力：
  brief / script-split -> llm_service / script_agent
  shot-card -> image_registry (可选 workflow)
  comfy-workflow -> image_registry (workflow_id 必选)
  video -> video_registry (i2v/r2v/t2v)
  tts -> audio_registry
  director3d -> mcp director_3d_stage_plan
  asset -> 透传
支持拓扑排序、逐节点执行、连线自动注入（image/prompt/asset）
"""
import time
import asyncio
from typing import Dict, Any, List, Optional, Set, Tuple


def topo_sort(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> List[str]:
    """Kahn 拓扑排序，环则按 x 排序回退"""
    id_to_node = {n["id"]: n for n in nodes}
    indeg: Dict[str,int] = {n["id"]:0 for n in nodes}
    adj: Dict[str, List[str]] = {n["id"]:[] for n in nodes}
    for e in edges:
        s = e.get("source"); t = e.get("target")
        if s in indeg and t in indeg:
            adj[s].append(t)
            indeg[t]+=1
    q = [nid for nid,d in indeg.items() if d==0]
    # 按 x 排序保证确定性
    q.sort(key=lambda nid: id_to_node[nid].get("position",{}).get("x",0))
    order: List[str]=[]
    while q:
        nid = q.pop(0)
        order.append(nid)
        for nb in adj[nid]:
            indeg[nb]-=1
            if indeg[nb]==0:
                q.append(nb)
        q.sort(key=lambda nid: id_to_node[nid].get("position",{}).get("x",0))
    if len(order)!=len(nodes):
        # 有环，回退按 x 排序
        return sorted([n["id"] for n in nodes], key=lambda nid: id_to_node[nid].get("position",{}).get("x",0))
    return order


def collect_upstream_data(node_id: str, nodes: List[Dict], edges: List[Dict], results: Dict[str, Any]) -> Dict[str, Any]:
    """收集上游节点已产生的可注入数据（支持 Provider 连线）"""
    incoming = [e for e in edges if e.get("target")==node_id]
    data: Dict[str, Any] = {}
    # 记录上游节点类型，便于 Provider 识别
    id_to_node = {n["id"]: n for n in nodes}
    for e in incoming:
        src_id = e.get("source")
        src_node = id_to_node.get(src_id, {})
        src_type = src_node.get("type", "")
        src_res = results.get(src_id)
        # 兼容部分节点未产生 result 但 data 中有 provider 配置（provider 节点）
        src_data = src_node.get("data", {}) if isinstance(src_node.get("data"), dict) else {}
        # Provider 节点特殊处理：透传 provider_id
        if src_type in ("provider-image", "provider-video", "provider-audio", "provider", "provider-llm"):
            prov_id = (src_res.get("provider_id") if src_res else None) or src_data.get("provider_id") or src_data.get("providerId") or src_data.get("id") or src_id
            # 同时尝试从 node data 的 definition 提取
            if not prov_id and isinstance(src_data.get("definition"), dict):
                prov_id = src_data["definition"].get("id")
            if prov_id:
                # 按类型分发
                if src_type == "provider-image" or (src_type == "provider" and (src_data.get("kind") or (src_res.get("kind") if src_res else None)) == "image"):
                    data.setdefault("provider", prov_id)
                    data.setdefault("provider_image", prov_id)
                elif src_type == "provider-video":
                    data.setdefault("provider", prov_id)
                    data.setdefault("provider_video", prov_id)
                    data.setdefault("video_provider", prov_id)
                elif src_type == "provider-audio":
                    data.setdefault("provider", prov_id)
                    data.setdefault("provider_audio", prov_id)
                    data.setdefault("audio_provider", prov_id)
                else:
                    # 通用 provider，按 kind
                    kind = src_data.get("kind") or (src_res.get("kind") if src_res else None) or "image"
                    if kind == "image":
                        data.setdefault("provider", prov_id)
                        data.setdefault("provider_image", prov_id)
                    elif kind == "video":
                        data.setdefault("provider_video", prov_id)
                    elif kind == "audio":
                        data.setdefault("provider_audio", prov_id)
                        data.setdefault("audio_provider", prov_id)
                    else:
                        data.setdefault("provider", prov_id)
                # 透传 model
                model = src_data.get("model") or src_data.get("default_model") or (src_res.get("model") if src_res else None) or (src_res.get("default_model") if src_res else None)
                if model:
                    data.setdefault("model", model)
                continue
        if not src_res:
            continue
        # 透传 image_url / prompt / audio_url / video_url / asset
        for k in ("image_url","file_url","thumb_url","prompt","image_prompt","brief","audio_url","video_url","minimax_camera_prompt","provider","provider_id","model"):
            if src_res.get(k):
                if k not in data:
                    data[k]=src_res[k]
        # 若上游显式返回 provider/provider_id，透传
        if src_res.get("provider_id"):
            data.setdefault("provider", src_res["provider_id"])
        # 若上游是 asset，直接透传 visual_prompt
        if src_res.get("visual_prompt"):
            data.setdefault("visual_prompt", src_res["visual_prompt"])
        if src_res.get("result_url"):
            data.setdefault("image_url", src_res["result_url"])
        # Provider result 透传（provider-image 节点产生的）
        if src_res.get("provider_id"):
            data.setdefault("provider", src_res["provider_id"])
    return data


async def execute_node(node: Dict[str, Any], upstream: Dict[str, Any], project_id: Optional[str]=None) -> Dict[str, Any]:
    ntype = node.get("type")
    data = dict(node.get("data") or {})
    # 合并上游数据到 data（下游优先）
    merged = {**upstream, **{k:v for k,v in data.items() if v not in (None,"")}}
    # 将 upstream 额外注入便于调试
    merged["_upstream"] = upstream
    start = time.time()
    try:
        if ntype in ("provider-image", "provider-video", "provider-audio", "provider", "provider-llm"):
            # Provider 节点：仅透传配置，不执行生成
            prov_id = data.get("provider_id") or data.get("providerId") or node.get("id")
            if isinstance(data.get("definition"), dict):
                prov_id = data["definition"].get("id") or prov_id
            kind = data.get("kind") or ("image" if ntype=="provider-image" else "video" if ntype=="provider-video" else "audio" if ntype=="provider-audio" else "image")
            model = data.get("model") or data.get("default_model")
            return {"status":"success","provider_id": prov_id, "provider": prov_id, "kind": kind, "model": model, "definition": data.get("definition"), "elapsed_ms": int((time.time()-start)*1000)}
        elif ntype == "brief":
            return {"status":"success","brief": data.get("brief",""), "elapsed_ms": int((time.time()-start)*1000)}
        elif ntype == "script-split":
            brief = upstream.get("brief") or data.get("brief") or ""
            if not brief.strip():
                return {"status":"error","error":"简报为空，无法拆解"}
            from app.pipelines.llm_service import llm_service, LLMServiceError
            from app.pipelines.script_agent import script_agent
            style = data.get("style_preset") or upstream.get("style_preset") or "donghua_xianxia"
            ratio = data.get("aspect_ratio") or upstream.get("aspect_ratio") or "9:16"
            try:
                proj = await script_agent.parse_novel_to_project(brief, style, ratio)
                return {"status":"success","project": proj.model_dump(), "elapsed_ms": int((time.time()-start)*1000)}
            except LLMServiceError as e:
                return {"status":"error","error": str(e)}
        elif ntype in ("shot-card","image","generate-image"):
            prompt = merged.get("image_prompt") or merged.get("prompt") or merged.get("brief") or ""
            if not prompt.strip():
                return {"status":"error","error":"提示词为空"}
            # 若上游有 visual_prompt（角色/资产），拼接增强一致性
            if upstream.get("visual_prompt") and upstream["visual_prompt"] not in prompt:
                prompt = f"{prompt}, {upstream['visual_prompt']}"
            from app.providers.image.registry import image_registry
            from app.providers.image.base import ImageGenerateRequest
            prov = merged.get("provider") or merged.get("provider_image") or upstream.get("provider") or upstream.get("provider_image") or data.get("provider") or data.get("provider_id")
            model = merged.get("model") or data.get("model")
            req = ImageGenerateRequest(
                prompt=prompt,
                negative_prompt=merged.get("negative_prompt") or "",
                aspect_ratio=merged.get("aspect_ratio") or "9:16",
                style_preset=merged.get("style_preset"),
                seed=merged.get("seed"),
                workflow_id=merged.get("workflow_id"),
                dynamic_inputs=merged.get("dynamic_inputs"),
                model=model,
            )
            res = await image_registry.generate(req, provider_id=prov if prov else None)
            return {"status":"success","image_url": res.image_url, "local_path": res.local_path, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
        elif ntype == "comfy-workflow":
            wf_id = merged.get("workflow_id")
            if not wf_id:
                return {"status":"error","error":"未选择工作流"}
            prompt = merged.get("prompt") or merged.get("image_prompt") or merged.get("brief") or "masterpiece"
            if upstream.get("visual_prompt") and upstream["visual_prompt"] not in prompt:
                prompt = f"{prompt}, {upstream['visual_prompt']}"
            from app.providers.image.registry import image_registry
            from app.providers.image.base import ImageGenerateRequest
            req = ImageGenerateRequest(prompt=prompt, aspect_ratio="9:16", workflow_id=wf_id, dynamic_inputs=merged.get("dynamic_inputs"))
            res = await image_registry.generate(req, provider_id="comfyui")
            return {"status":"success","image_url": res.image_url, "result_url": res.image_url, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
        elif ntype in ("video","video-node"):
            prompt = merged.get("video_prompt") or merged.get("prompt") or merged.get("action_desc") or "cinematic motion"
            mode = merged.get("mode") or "i2v"
            first_frame = merged.get("image_url") or merged.get("first_frame_url") or upstream.get("image_url")
            if mode=="i2v" and not first_frame:
                return {"status":"error","error":"I2V 模式需要首帧图像（请连入上游 image）"}
            from app.providers.video.registry import video_registry
            from app.providers.video.base import VideoGenerateRequest
            prov = merged.get("provider") or merged.get("video_provider") or merged.get("provider_video") or upstream.get("provider_video") or upstream.get("provider") or data.get("provider") or data.get("provider_id")
            model = merged.get("model") or data.get("model")
            req = VideoGenerateRequest(prompt=prompt, mode=mode, first_frame_url=first_frame, duration=int(merged.get("duration") or 5), provider=prov, dynamic_inputs=merged.get("dynamic_inputs"))
            if model:
                req.provider = prov
                # 将 model 透传至 extra
                req.extra = {"model": model}
            res = await video_registry.generate(req, provider_id=prov if prov else None)
            return {"status":"success","video_url": res.video_url, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
        elif ntype in ("tts","audio","voice"):
            text = merged.get("text") or merged.get("dialogue") or merged.get("subtitle_text") or merged.get("brief") or ""
            if not text.strip():
                return {"status":"error","error":"配音文本为空"}
            from app.providers.audio.registry import audio_registry
            from app.providers.audio.base import AudioGenerateRequest
            prov = merged.get("provider") or merged.get("audio_provider") or merged.get("provider_audio") or upstream.get("provider_audio") or upstream.get("provider") or data.get("provider") or data.get("provider_id") or "minimax"
            model = merged.get("model") or data.get("model")
            req = AudioGenerateRequest(text=text, voice_id=merged.get("voice_id") or "male-qn-qingse", emotion=merged.get("emotion") or "neutral", speed=float(merged.get("speed") or 1.0), model=model)
            res = await audio_registry.generate(req, provider_id=prov)
            return {"status":"success","audio_url": res.audio_url, "provider": res.provider, "elapsed_ms": int((time.time()-start)*1000)}
        elif ntype == "director3d":
            from app.mcp.server import mcp_registry
            r = await mcp_registry.execute_tool("director_3d_stage_plan", {
                "framing": merged.get("framing") or "medium",
                "motion": merged.get("motion") or "push_in",
                "pose": merged.get("pose") or "stand",
                "focal_length_mm": float(merged.get("focal_length_mm") or 35),
                "camera_roll_deg": float(merged.get("camera_roll_deg") or 0),
                "cast_layout": merged.get("cast_layout") or "solo",
                "ai_directive": merged.get("ai_directive") or "",
            })
            if r.status=="success":
                return {"status":"success","minimax_camera_prompt": r.result.get("minimax_camera_prompt"), "result": r.result, "elapsed_ms": r.execution_time_ms}
            return {"status":"error","error": r.error}
        elif ntype == "asset":
            # 透传资产本身
            return {"status":"success","image_url": data.get("file_url") or data.get("thumb_url"), "visual_prompt": data.get("visual_prompt"), "asset": data}
        else:
            # 通用：若有 prompt 则尝试生图
            if merged.get("prompt") or merged.get("image_prompt") or merged.get("brief"):
                prompt = merged.get("prompt") or merged.get("image_prompt") or merged.get("brief") or ""
                from app.providers.image.registry import image_registry
                from app.providers.image.base import ImageGenerateRequest
                req = ImageGenerateRequest(prompt=prompt)
                res = await image_registry.generate(req)
                return {"status":"success","image_url": res.image_url, "elapsed_ms": int((time.time()-start)*1000)}
            return {"status":"success","elapsed_ms": int((time.time()-start)*1000)}
    except Exception as e:
        return {"status":"error","error": str(e), "elapsed_ms": int((time.time()-start)*1000)}


class CanvasEngine:
    async def execute_dag(self, nodes: List[Dict], edges: List[Dict], project_id: Optional[str]=None, target_ids: Optional[List[str]]=None, on_progress=None) -> Dict[str, Any]:
        """
        执行画布 DAG
        - target_ids: 仅执行这些节点及其下游（为 None 则执行全部拓扑序）
        """
        if not nodes:
            return {"results":{}, "order":[]}
        # 若指定 target_ids，计算闭包（target + 下游）
        if target_ids:
            # BFS 下游
            adj: Dict[str,List[str]]={}
            for n in nodes: adj[n["id"]]=[]
            for e in edges:
                if e.get("source") in adj:
                    adj[e["source"]].append(e.get("target"))
            closure=set(target_ids)
            q=list(target_ids)
            while q:
                cur=q.pop(0)
                for nb in adj.get(cur,[]):
                    if nb not in closure:
                        closure.add(nb); q.append(nb)
            nodes = [n for n in nodes if n["id"] in closure]
            edges = [e for e in edges if e.get("source") in closure and e.get("target") in closure]

        order = topo_sort(nodes, edges)
        results: Dict[str, Any] = {}
        for nid in order:
            node = next((n for n in nodes if n["id"]==nid), None)
            if not node:
                continue
            upstream = collect_upstream_data(nid, nodes, edges, results)
            if on_progress:
                try: await on_progress({"event":"node_start","node_id":nid,"type":node.get("type")})
                except: pass
            res = await execute_node(node, upstream, project_id=project_id)
            results[nid]=res
            # 将结果写回 node data 便于前端展示（不持久化，由前端决定）
            if on_progress:
                try: await on_progress({"event":"node_done","node_id":nid,"result":res})
                except: pass
        return {"results": results, "order": order}


canvas_engine = CanvasEngine()
