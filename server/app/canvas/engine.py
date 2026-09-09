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


def _extract_url_from_src(src_res: Optional[Dict[str, Any]], src_data: Dict[str, Any], keys: tuple) -> Optional[str]:
    """从上游 result/data 中按候选考提取首个非空 URL"""
    if src_res:
        for k in keys:
            v = src_res.get(k)
            if v and isinstance(v, str) and v.strip():
                return v.strip()
    for k in keys:
        v = src_data.get(k)
        if v and isinstance(v, str) and v.strip():
            return v.strip()
    # 兜底：data.image / data.url
    for k in ("image", "url", "file_url", "thumb_url"):
        v = src_data.get(k)
        if v and isinstance(v, str) and v.strip():
            return v.strip()
    return None


def collect_upstream_data(node_id: str, nodes: List[Dict], edges: List[Dict], results: Dict[str, Any]) -> Dict[str, Any]:
    """收集上游节点已产生的可注入数据（全量 Provider 系统复用：动态句柄 + 多模态聚合）"""
    incoming = [e for e in edges if e.get("target")==node_id]
    data: Dict[str, Any] = {}
    id_to_node = {n["id"]: n for n in nodes}
    for e in incoming:
        src_id = e.get("source")
        tgt_handle = (e.get("targetHandle") or e.get("target_handle") or "").strip()
        src_node = id_to_node.get(src_id, {})
        src_type = src_node.get("type", "")
        src_res = results.get(src_id)
        src_data = src_node.get("data", {}) if isinstance(src_node.get("data"), dict) else {}
        # Provider 节点透传 provider_id / model
        if src_type in ("provider-image", "provider-video", "provider-audio", "provider", "provider-llm"):
            prov_id = (src_res.get("provider_id") if src_res else None) or src_data.get("provider_id") or src_data.get("providerId") or src_data.get("id") or src_id
            if not prov_id and isinstance(src_data.get("definition"), dict):
                prov_id = src_data["definition"].get("id")
            if prov_id:
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
                model = src_data.get("model") or src_data.get("default_model") or (src_res.get("model") if src_res else None) or (src_res.get("default_model") if src_res else None)
                if model:
                    data.setdefault("model", model)
                continue
        # 自定义节点源：按其产出内容推断句柄（视频→video，音频→audio，图像→参考集，文本→prompt）
        if src_type == "custom" and not tgt_handle:
            if src_res:
                if src_res.get("video_url"):
                    tgt_handle = "video"
                elif src_res.get("audio_url"):
                    tgt_handle = "audio"
                elif src_res.get("image_url") or src_res.get("result_url"):
                    tgt_handle = "reference_images"
                elif src_res.get("prompt") or src_res.get("text"):
                    tgt_handle = "prompt"
        # 若无显式 targetHandle，按源类型与目标节点类型推断
        if not tgt_handle:
            # 启发式：image 源 -> 若目标为 video 首帧优先 first_frame，否则 reference
            if src_type in ("image", "shot-card", "comfy-workflow", "load-image", "load-image-batch"):
                tgt_handle = "reference_images"
                # 若目标节点有 first_frame 且尚未注入，优先作为首帧
                tgt_node = id_to_node.get(node_id, {})
                if tgt_node.get("type") == "video" and "first_frame" not in data:
                    # 允许首个 image 作为首帧，后续作为参考
                    tgt_handle = "first_frame"
            elif src_type in ("prompt", "text-prompt", "brief", "script-split"):
                tgt_handle = "prompt"
            elif src_type in ("video", "video-node"):
                tgt_handle = "video"
            elif src_type in ("tts", "audio", "voice"):
                tgt_handle = "audio"
        # 按句柄精准分发
        if tgt_handle in ("reference_images", "images", "image_list", "reference"):
            url = _extract_url_from_src(src_res, src_data, ("image_url", "result_url", "file_url", "thumb_url"))
            if url:
                data.setdefault("reference_images", [])
                if url not in data["reference_images"]:
                    data["reference_images"].append(url)
                data.setdefault("image_url", url)
                # 兼容单 reference 字段
                data.setdefault("reference", url)
            continue
        if tgt_handle in ("first_frame", "first_frame_url"):
            url = _extract_url_from_src(src_res, src_data, ("image_url", "result_url", "file_url"))
            if url and "first_frame" not in data:
                data["first_frame"] = url
                data["first_frame_url"] = url
                data.setdefault("image_url", url)
                # 同时聚合到参考集以兼容 r2v 兜底
                data.setdefault("reference_images", [])
                if url not in data["reference_images"]:
                    data["reference_images"].append(url)
            continue
        if tgt_handle in ("last_frame", "last_frame_url"):
            url = _extract_url_from_src(src_res, src_data, ("image_url", "result_url", "file_url"))
            if url and "last_frame" not in data:
                data["last_frame"] = url
                data["last_frame_url"] = url
            continue
        if tgt_handle in ("reference_audios", "audios", "ref_audio", "ref_audio_path"):
            url = _extract_url_from_src(src_res, src_data, ("audio_url", "file_url"))
            if url:
                data.setdefault("reference_audios", [])
                if url not in data["reference_audios"]:
                    data["reference_audios"].append(url)
                data.setdefault("audio_url", url)
                data.setdefault("ref_audio", url)
            continue
        if tgt_handle in ("reference_videos", "videos"):
            url = _extract_url_from_src(src_res, src_data, ("video_url",))
            if url:
                data.setdefault("reference_videos", [])
                if url not in data["reference_videos"]:
                    data["reference_videos"].append(url)
                data.setdefault("video_url", url)
            continue
        if tgt_handle in ("prompt", "text", "brief", "image_prompt", "video_prompt"):
            txt = None
            if src_res:
                txt = src_res.get("prompt") or src_res.get("text") or src_res.get("brief") or src_res.get("image_prompt") or src_res.get("video_prompt")
            if not txt:
                txt = src_data.get("prompt") or src_data.get("text") or src_data.get("brief") or src_data.get("image_prompt")
            if txt and isinstance(txt, str) and txt.strip() and "prompt" not in data:
                data["prompt"] = txt.strip()
                data["text"] = txt.strip()
            continue
        if tgt_handle in ("ref", "reference_image"):
            url = _extract_url_from_src(src_res, src_data, ("image_url", "result_url", "file_url"))
            if url:
                data["reference"] = url
                data.setdefault("image_url", url)
                data.setdefault("reference_images", [])
                if url not in data["reference_images"]:
                    data["reference_images"].append(url)
            continue
        if tgt_handle in ("video","audio"):
            if tgt_handle=="video":
                url = src_res.get("video_url") if src_res else None
                if url:
                    data.setdefault("videos", [])
                    if url not in data["videos"]:
                        data["videos"].append(url)
                    data.setdefault("video_url", url)
            else:
                url = src_res.get("audio_url") if src_res else None
                if url:
                    data.setdefault("audios", [])
                    if url not in data["audios"]:
                        data["audios"].append(url)
                    data.setdefault("audio_url", url)
            if url:
                continue
        if tgt_handle in ("provider", "provider_video", "provider_image", "provider_audio"):
            pass
        if not src_res:
            continue
        # 兜底透传：仅当无显式句柄命中时，按白名单透传已产生的多模态结果
        for k in ("image_url","file_url","thumb_url","prompt","image_prompt","brief","audio_url","video_url","minimax_camera_prompt","provider","provider_id","model"):
            if src_res.get(k) and k not in data:
                data[k]=src_res[k]
        if src_res.get("provider_id"):
            data.setdefault("provider", src_res["provider_id"])
        if src_res.get("visual_prompt"):
            data.setdefault("visual_prompt", src_res["visual_prompt"])
        if src_res.get("result_url"):
            data.setdefault("image_url", src_res["result_url"])
    return data


def _ensure_provider_registered(provider_id: Optional[str], kind: str = "image"):
    if not provider_id:
        return
    from app.providers.image.registry import image_registry
    from app.providers.video.registry import video_registry
    from app.providers.audio.registry import audio_registry
    # 兼容：kind 为 llm 或未知时按 provider_id 探测所有注册表
    registries = []
    if kind == "image":
        registries = [image_registry]
    elif kind == "video":
        registries = [video_registry]
    elif kind == "audio":
        registries = [audio_registry]
    else:
        registries = [image_registry, video_registry, audio_registry]
    # 已在任一表即视为已注册
    for reg in registries:
        if provider_id in reg._providers:
            return
    # 未命中则尝试从持久化加载并按 definition.kind 精确注册
    try:
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.init_providers import register_single_custom_provider
        defn = custom_provider_manager.get_definition(provider_id)
        if defn:
            register_single_custom_provider(defn)
            # 二次校验：若 kind 与 defn.kind 不一致，仍保证注册成功
            return
        # 兜底：未找到自定义定义时，全量初始化一次内置注册表（不写死任何内置 id 名单）
        from app.providers.init_providers import init_all_providers
        try:
            init_all_providers()
        except Exception:
            pass
    except Exception as e:
        print(f"[CanvasEngine] Failed to auto-register dynamic provider {provider_id} (kind={kind}): {e}")


async def execute_node(node: Dict[str, Any], upstream: Dict[str, Any], project_id: Optional[str]=None) -> Dict[str, Any]:
    ntype = node.get("type")
    data = dict(node.get("data") or {})
    # 合并上游数据到 data（下游优先）
    merged = {**upstream, **{k:v for k,v in data.items() if v not in (None,"")}}
    # 将 upstream 额外注入便于调试
    merged["_upstream"] = upstream
    start = time.time()
    try:
        # 新 6 核心：prompt 智能体能力分发
        if ntype == "prompt":
            txt = data.get("prompt") or data.get("text") or upstream.get("prompt") or upstream.get("text") or ""
            if not txt.strip() and upstream.get("prompt"):
                txt = upstream.get("prompt")
            skill_id = data.get("skill_id") or merged.get("skill_id")
            if skill_id == "script_generation" and txt.strip():
                try:
                    from app.pipelines.script_agent import script_agent
                    style = data.get("style_preset") or merged.get("style_preset") or "donghua_xianxia"
                    ratio = data.get("aspect_ratio") or merged.get("aspect_ratio") or "9:16"
                    proj = await script_agent.parse_novel_to_project(txt, style, ratio)
                    script_lines = []
                    for s in proj.scenes:
                        script_lines.append(f"【场景 {s.scene_index}】")
                        for sh in s.shots:
                            script_lines.append(f"镜头 {sh.shot_index}: [{sh.camera_framing}] {sh.action_desc}\n台词: {sh.dialogue or '（无对白）'}")
                    script_text = "\n\n".join(script_lines)
                    return {"status": "success", "prompt": script_text, "text": script_text, "script_data": proj.model_dump(), "elapsed_ms": int((time.time()-start)*1000)}
                except Exception as e:
                    print(f"[Canvas] script_generation failed: {e}")
            elif skill_id == "proposal_generation" and txt.strip():
                try:
                    from app.pipelines.llm_service import llm_service
                    res = await llm_service.chat_completion(
                        messages=[
                            {"role": "system", "content": "你是一位金牌影视与漫剧总策划。根据用户输入的主题或题材，生成一份高吸引力的策划案，包括世界观、主角人设、核心矛盾与前三集爆点大纲。"},
                            {"role": "user", "content": txt}
                        ]
                    )
                    content = res.get("content", txt)
                    return {"status": "success", "prompt": content, "text": content, "elapsed_ms": int((time.time()-start)*1000)}
                except Exception as e:
                    print(f"[Canvas] proposal_generation failed: {e}")
            elif skill_id == "prompt_expansion" and txt.strip():
                try:
                    from app.pipelines.llm_service import llm_service
                    res = await llm_service.chat_completion(
                        messages=[
                            {"role": "system", "content": "你是一位电影级视觉提示词工程师。请将用户的简要描述扩写为细节丰富、电影质感强烈的专业提示词（包含景别、光影、构图、色温与胶片颗粒感）。直接输出提示词。"},
                            {"role": "user", "content": txt}
                        ]
                    )
                    content = res.get("content", txt)
                    return {"status": "success", "prompt": content, "text": content, "elapsed_ms": int((time.time()-start)*1000)}
                except Exception as e:
                    print(f"[Canvas] prompt_expansion failed: {e}")
            return {"status":"success","prompt": txt, "text": txt, "elapsed_ms": int((time.time()-start)*1000)}
        if ntype == "export":
            # 聚合上游视频/音频/图片，透传即可，真实导出由前端触发 saveProjectContent/ exportJianYing
            vids = []
            auds = []
            imgs = []
            for k in ["video_url","videos","reference_videos"]:
                v = upstream.get(k)
                if isinstance(v, list): vids.extend(v)
                elif isinstance(v, str) and v: vids.append(v)
            for k in ["audio_url","audios","reference_audios"]:
                v = upstream.get(k)
                if isinstance(v, list): auds.extend(v)
                elif isinstance(v, str) and v: auds.append(v)
            for k in ["image_url","images","reference_images"]:
                v = upstream.get(k)
                if isinstance(v, list): imgs.extend(v)
                elif isinstance(v, str) and v: imgs.append(v)
            # 兼容部分节点 result 中单独的 image_url
            single_vid = upstream.get("video_url") or merged.get("video_url")
            if single_vid and single_vid not in vids: vids.append(single_vid)
            return {"status":"success","videos": vids, "audios": auds, "images": imgs, "prompt": upstream.get("prompt") or merged.get("prompt"), "elapsed_ms": int((time.time()-start)*1000)}
        if ntype in ("provider-image", "provider-video", "provider-audio", "provider", "provider-llm"):
            prov_id = data.get("provider_id") or data.get("providerId") or node.get("id")
            if isinstance(data.get("definition"), dict):
                prov_id = data["definition"].get("id") or prov_id
            kind = data.get("kind") or ("image" if ntype=="provider-image" else "video" if ntype=="provider-video" else "audio" if ntype=="provider-audio" else "image")
            model = data.get("model") or data.get("default_model")
            # 若上游已传入生成所需输入（prompt/text），则直接在此节点生成，实现“文本→图像/视频/音频”直连
            has_prompt = bool(upstream.get("prompt") or merged.get("prompt") or data.get("prompt") or upstream.get("text") or merged.get("text"))
            has_image = bool(upstream.get("image") or upstream.get("image_url") or upstream.get("reference_images"))
            # 仅当有输入时才执行生成，否则仅透传配置供下游消费
            if kind == "image" and (has_prompt or has_image):
                try:
                    prompt = upstream.get("prompt") or merged.get("prompt") or data.get("prompt") or merged.get("image_prompt") or ""
                    if prompt.strip():
                        from app.providers.image.registry import image_registry
                        from app.providers.image.base import ImageGenerateRequest
                        # 多参考图聚合：收集上游 image[]（load-image-batch 等）
                        ref_imgs = []
                        for k in ["reference_images", "images", "image_list"]:
                            v = upstream.get(k) or merged.get(k)
                            if isinstance(v, list): ref_imgs.extend(v)
                            elif isinstance(v, str) and v: ref_imgs.append(v)
                        # 单图
                        single = upstream.get("image") or upstream.get("image_url")
                        if single and single not in ref_imgs:
                            ref_imgs.append(single)
                        req = ImageGenerateRequest(prompt=prompt, aspect_ratio=merged.get("aspect_ratio") or "9:16", model=model, dynamic_inputs={"reference_images": ref_imgs} if ref_imgs else None)
                        res = await image_registry.generate(req, provider_id=prov_id if prov_id else None)
                        return {"status":"success","provider_id": prov_id, "provider": prov_id, "kind": kind, "model": model, "definition": data.get("definition"), "image_url": res.image_url, "result_url": res.image_url, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
                except Exception as e:
                    # 生成失败则回退为透传，避免阻断 DAG
                    print(f"[Canvas] provider-image generate failed, fallback to passthrough: {e}")
            elif kind == "video" and has_prompt:
                try:
                    prompt = upstream.get("prompt") or merged.get("prompt") or data.get("prompt") or ""
                    if prompt.strip():
                        from app.providers.video.registry import video_registry
                        from app.providers.video.base import VideoGenerateRequest
                        ref_imgs = []
                        for k in ["reference_images", "images"]:
                            v = upstream.get(k) or merged.get(k)
                            if isinstance(v, list): ref_imgs.extend(v)
                            elif isinstance(v, str) and v: ref_imgs.append(v)
                        first = upstream.get("first_frame") or upstream.get("image") or upstream.get("image_url")
                        if first and not ref_imgs:
                            # 单图作为首帧
                            pass
                        req = VideoGenerateRequest(prompt=prompt, mode=merged.get("mode") or "t2v" if not first and not ref_imgs else ("r2v" if ref_imgs else "i2v"), first_frame_url=first, reference_images=ref_imgs if ref_imgs else None, duration=int(merged.get("duration") or 5), provider=prov_id)
                        res = await video_registry.generate(req, provider_id=prov_id if prov_id else None)
                        return {"status":"success","provider_id": prov_id, "provider": prov_id, "kind": kind, "model": model, "video_url": res.video_url, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
                except Exception as e:
                    print(f"[Canvas] provider-video generate failed, fallback: {e}")
            elif kind == "audio" and (upstream.get("text") or merged.get("text") or data.get("text")):
                try:
                    text = upstream.get("text") or merged.get("text") or data.get("text") or ""
                    if text.strip():
                        from app.providers.audio.registry import audio_registry
                        from app.providers.audio.base import AudioGenerateRequest
                        req = AudioGenerateRequest(text=text, voice_id=merged.get("voice_id") or "", emotion=merged.get("emotion") or "")
                        res = await audio_registry.generate(req, provider_id=prov_id if prov_id else None)
                        return {"status":"success","provider_id": prov_id, "provider": prov_id, "kind": kind, "audio_url": res.audio_url, "elapsed_ms": int((time.time()-start)*1000)}
                except Exception as e:
                    print(f"[Canvas] provider-audio generate failed, fallback: {e}")
            return {"status":"success","provider_id": prov_id, "provider": prov_id, "kind": kind, "model": model, "definition": data.get("definition"), "elapsed_ms": int((time.time()-start)*1000)}
        elif ntype == "custom":
            # 自定义代码节点：按其 input_schema 收集上游 → run(inputs, params) → 结果透传
            cnid = data.get("custom_node_id") or data.get("customNodeId") or ""
            if not cnid:
                return {"status":"error","error":"未绑定自定义节点（custom_node_id 为空）"}
            try:
                from app.custom_nodes.manager import custom_node_manager, run_custom_node
                definition = custom_node_manager.get(cnid)
                if not definition:
                    return {"status":"error","error":f"自定义节点不存在: {cnid}"}
                if not definition.enabled:
                    return {"status":"error","error":f"自定义节点已禁用: {cnid}"}
                declared_in = list(((definition.input_schema or {}).get("properties") or {}).keys())
                inputs: Dict[str, Any] = {}
                for k in declared_in:
                    v = upstream.get(k, merged.get(k, None))
                    if v not in (None, ""):
                        inputs[k] = v
                # 文本兜底：prompt/text 互通
                if "prompt" not in inputs and (upstream.get("prompt") or merged.get("prompt")):
                    inputs["prompt"] = upstream.get("prompt") or merged.get("prompt")
                if "text" not in inputs and (upstream.get("text") or merged.get("text")):
                    inputs["text"] = upstream.get("text") or merged.get("text")
                declared_params = list(((definition.params_schema or {}).get("properties") or {}).keys())
                params: Dict[str, Any] = {}
                for k in declared_params:
                    v = merged.get(k, None)
                    if v not in (None, ""):
                        params[k] = v
                # 节点内 params 字典整体透传（与 provider 节点一致）
                if isinstance(merged.get("params"), dict):
                    for k, v in merged["params"].items():
                        if v not in (None, "") and k not in params:
                            params[k] = v
                result = await run_custom_node(definition, inputs, params, {"project_id": project_id})
                if not isinstance(result, dict):
                    return {"status":"error","error":"自定义节点须返回dict"}
                out = {"status":"success","custom_node_id": cnid, "kind": definition.kind, "elapsed_ms": int((time.time()-start)*1000)}
                out.update(result)
                return out
            except Exception as e:
                return {"status":"error","error":f"自定义节点执行失败: {e}"}
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
            if upstream.get("visual_prompt") and upstream["visual_prompt"] not in prompt:
                prompt = f"{prompt}, {upstream['visual_prompt']}"
            from app.providers.image.registry import image_registry
            from app.providers.image.base import ImageGenerateRequest
            prov = merged.get("provider_id") or merged.get("provider") or merged.get("provider_image") or upstream.get("provider_id") or upstream.get("provider") or upstream.get("provider_image") or data.get("provider_id") or data.get("provider")
            model = merged.get("model") or data.get("model") or merged.get("default_model")
            dyn = dict(merged.get("dynamic_inputs") or {})
            ref_sources = []
            for k in ("reference_images", "reference", "reference_image", "first_frame", "first_frame_url"):
                v = merged.get(k) or upstream.get(k)
                if isinstance(v, list):
                    ref_sources.extend([x for x in v if isinstance(x, str) and x.strip()])
                elif isinstance(v, str) and v.strip():
                    ref_sources.append(v.strip())
            seen = set()
            uniq_refs = []
            for u in ref_sources:
                if u not in seen:
                    seen.add(u); uniq_refs.append(u)
            if uniq_refs:
                existing = dyn.get("reference_images") or []
                if isinstance(existing, str):
                    existing = [existing]
                merged_refs = []
                seen2 = set()
                for u in list(existing) + uniq_refs:
                    if isinstance(u, str) and u.strip() and u not in seen2:
                        seen2.add(u); merged_refs.append(u)
                dyn["reference_images"] = merged_refs
            for k in ("last_frame", "last_frame_url"):
                v = merged.get(k) or upstream.get(k)
                if v and isinstance(v, str) and v.strip():
                    dyn.setdefault("last_frame_url", v.strip())
            extra: Dict[str, Any] = {}
            for pk in ("aspect_ratio", "resolution", "steps", "cfg", "width", "height", "seed", "model", "style_preset", "negative_prompt", "fps", "duration"):
                vv = merged.get(pk)
                if vv in (None, ""):
                    vv = data.get(pk)
                if vv not in (None, ""):
                    extra[pk] = vv
            for bag in (merged.get("params"), merged.get("provider_params")):
                if isinstance(bag, dict):
                    for kk, vv in bag.items():
                        if vv not in (None, "") and kk not in extra:
                            extra[kk] = vv
            for kk, vv in extra.items():
                if kk not in dyn:
                    dyn[kk] = vv
            req = ImageGenerateRequest(
                prompt=prompt,
                negative_prompt=extra.get("negative_prompt") or merged.get("negative_prompt") or "",
                aspect_ratio=extra.get("aspect_ratio") or merged.get("aspect_ratio") or "9:16",
                resolution=extra.get("resolution"),
                style_preset=extra.get("style_preset") or merged.get("style_preset"),
                seed=extra.get("seed") if extra.get("seed") is not None else merged.get("seed"),
                width=extra.get("width") or merged.get("width"),
                height=extra.get("height") or merged.get("height"),
                steps=extra.get("steps") or merged.get("steps"),
                cfg=extra.get("cfg") or merged.get("cfg"),
                workflow_id=merged.get("workflow_id") or extra.get("workflow_id"),
                dynamic_inputs=dyn if dyn else None,
                model=model or extra.get("model"),
                extra=extra if extra else None,
            )
            _ensure_provider_registered(prov, "image")
            # 统一 MCP 动态调度：节点Agent按 provider_xxx Tool 调度（异构参数即输入），底层仍走同一 registry，模型可动态选
            if prov:
                try:
                    from app.mcp.server import mcp_registry as _mcp
                    mcp_args: Dict[str, Any] = {"prompt": prompt}
                    if extra.get("negative_prompt"): mcp_args["negative_prompt"] = extra["negative_prompt"]
                    if extra.get("aspect_ratio"): mcp_args["aspect_ratio"] = extra["aspect_ratio"]
                    if extra.get("resolution"): mcp_args["resolution"] = extra["resolution"]
                    if extra.get("steps") is not None: mcp_args["steps"] = extra["steps"]
                    if extra.get("cfg") is not None: mcp_args["cfg"] = extra["cfg"]
                    if extra.get("seed") is not None: mcp_args["seed"] = extra["seed"]
                    if extra.get("style_preset"): mcp_args["style_preset"] = extra["style_preset"]
                    if model: mcp_args["model"] = model
                    if dyn.get("reference_images"): mcp_args["reference_images"] = dyn["reference_images"]
                    # 其余异构透传
                    for k,v in extra.items():
                        if k not in mcp_args and v not in (None,""):
                            mcp_args[k] = v
                    # 清理空
                    mcp_args = {k:v for k,v in mcp_args.items() if v not in (None,"")}
                    mcp_res = await _mcp.execute_tool(f"provider_{prov}", mcp_args)
                    if mcp_res.status == "success" and mcp_res.result and (mcp_res.result.get("image_url") or mcp_res.result.get("url")):
                        img_url = mcp_res.result.get("image_url") or mcp_res.result.get("url")
                        return {"status":"success","image_url": img_url, "local_path": mcp_res.result.get("local_path") or img_url, "provider": prov, "elapsed_ms": mcp_res.execution_time_ms or int((time.time()-start)*1000)}
                except Exception as _e:
                    print(f"[CanvasEngine] MCP provider_{prov} image fallback: {_e}")
            res = await image_registry.generate(req, provider_id=prov if prov else None)
            return {"status":"success","image_url": res.image_url, "local_path": res.local_path, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
        elif ntype == "comfy-workflow":
            wf_id = merged.get("workflow_id") or merged.get("workflowId") or data.get("workflow_id")
            if not wf_id:
                return {"status":"error","error":"未选择工作流"}
            prompt = merged.get("prompt") or merged.get("image_prompt") or merged.get("brief") or "masterpiece"
            if upstream.get("visual_prompt") and upstream["visual_prompt"] not in prompt:
                prompt = f"{prompt}, {upstream['visual_prompt']}"
            from app.providers.image.registry import image_registry
            from app.providers.image.base import ImageGenerateRequest
            # 复用 Provider 系统：透传 workflow 动态参数与全局 params
            dyn = dict(merged.get("dynamic_inputs") or {})
            for k in ("reference_images", "reference", "first_frame"):
                v = merged.get(k) or upstream.get(k)
                if v:
                    if isinstance(v, list):
                        dyn.setdefault("reference_images", [])
                        for uu in v:
                            if uu not in dyn["reference_images"]:
                                dyn["reference_images"].append(uu)
                    elif isinstance(v, str) and v.strip():
                        dyn.setdefault("reference_images", [])
                        if v.strip() not in dyn["reference_images"]:
                            dyn["reference_images"].append(v.strip())
            extra: Dict[str, Any] = {}
            for pk in ("aspect_ratio", "resolution", "steps", "cfg", "seed", "style_preset"):
                vv = merged.get(pk)
                if vv not in (None, ""):
                    extra[pk] = vv
            req = ImageGenerateRequest(
                prompt=prompt,
                aspect_ratio=extra.get("aspect_ratio") or merged.get("aspect_ratio") or "9:16",
                resolution=extra.get("resolution"),
                style_preset=extra.get("style_preset"),
                seed=extra.get("seed") if extra.get("seed") is not None else merged.get("seed"),
                steps=extra.get("steps") or merged.get("steps"),
                cfg=extra.get("cfg") or merged.get("cfg"),
                workflow_id=wf_id,
                dynamic_inputs=dyn if dyn else merged.get("dynamic_inputs"),
                extra=extra if extra else None,
            )
            _ensure_provider_registered("comfyui", "image")
            res = await image_registry.generate(req, provider_id="comfyui")
            return {"status":"success","image_url": res.image_url, "result_url": res.image_url, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000)}
        elif ntype in ("video","video-node"):
            prompt = merged.get("video_prompt") or merged.get("prompt") or merged.get("image_prompt") or merged.get("action_desc") or upstream.get("prompt") or "cinematic motion"
            mode = merged.get("mode") or "i2v"
            first_frame = merged.get("first_frame") or merged.get("first_frame_url") or merged.get("image_url") or upstream.get("first_frame") or upstream.get("first_frame_url") or upstream.get("image_url") or upstream.get("reference")
            last_frame = merged.get("last_frame") or merged.get("last_frame_url") or upstream.get("last_frame") or upstream.get("last_frame_url") or (merged.get("dynamic_inputs") or {}).get("last_frame_url")
            ref_imgs = merged.get("reference_images") or upstream.get("reference_images") or merged.get("reference") or upstream.get("reference")
            if isinstance(ref_imgs, str) and ref_imgs.strip():
                ref_imgs = [ref_imgs.strip()]
            elif not isinstance(ref_imgs, list):
                ref_imgs = None
            skill_id = data.get("skill_id") or merged.get("skill_id")
            if skill_id == "all_round_reference" or (ref_imgs and not first_frame):
                mode = "r2v"
            elif skill_id == "first_last_frame" or (first_frame and last_frame):
                mode = "i2v"
            if mode == "i2v" and not first_frame and not ref_imgs:
                return {"status":"error","error":"视频生成需要首帧图像或参考图（请连入上游 image 或在底部控制台挂载）"}
            from app.providers.video.registry import video_registry
            from app.providers.video.base import VideoGenerateRequest
            prov = merged.get("provider_id") or merged.get("provider") or merged.get("video_provider") or merged.get("provider_video") or upstream.get("provider_id") or upstream.get("provider_video") or upstream.get("provider") or data.get("provider_id") or data.get("provider")
            model = merged.get("model") or data.get("model") or merged.get("default_model")
            # 动态参数与 provider 复用
            extra: Dict[str, Any] = {}
            for pk in ("duration", "resolution", "aspect_ratio", "fps", "seed", "model", "workflow_id", "steps", "cfg"):
                vv = merged.get(pk)
                if vv in (None, ""):
                    vv = data.get(pk)
                if vv not in (None, ""):
                    extra[pk] = vv
            for bag in (merged.get("params"), merged.get("provider_params")):
                if isinstance(bag, dict):
                    for kk, vv in bag.items():
                        if vv not in (None, "") and kk not in extra:
                            extra[kk] = vv
            dyn = dict(merged.get("dynamic_inputs") or {})
            if last_frame and isinstance(last_frame, str) and last_frame.strip():
                dyn["last_frame_url"] = last_frame.strip()
            # 将 extra 同步到 dyn 以便 GenericCodeVideoProvider 捕获
            for kk, vv in extra.items():
                if kk not in dyn:
                    dyn[kk] = vv
            duration = int(extra.get("duration") or merged.get("duration") or 5)
            resolution = extra.get("resolution") or merged.get("resolution") or "720p"
            aspect_ratio = extra.get("aspect_ratio") or merged.get("aspect_ratio") or "9:16"
            fps = extra.get("fps") or merged.get("fps")
            req = VideoGenerateRequest(
                prompt=prompt,
                mode=mode,
                first_frame_url=first_frame if isinstance(first_frame, str) and first_frame.strip() else None,
                last_frame_url=last_frame if isinstance(last_frame, str) and last_frame.strip() else None,
                reference_images=ref_imgs if isinstance(ref_imgs, list) and ref_imgs else None,
                duration=duration,
                resolution=resolution,
                aspect_ratio=aspect_ratio,
                fps=int(fps) if fps not in (None, "") else None,
                provider=prov,
                dynamic_inputs=dyn if dyn else None,
                extra=extra if extra else None,
            )
            # 兼容：部分 registry 仍通过 extra.provider 读取
            if model:
                req.extra = {**(req.extra or {}), "model": model}
                req.provider = prov
            _ensure_provider_registered(prov, "video")
            if prov:
                try:
                    from app.mcp.server import mcp_registry as _mcp2
                    mcp_args_v: Dict[str, Any] = {
                        "prompt": prompt,
                        "mode": mode,
                        "first_frame": first_frame,
                        "first_frame_url": first_frame,
                        "reference_images": ref_imgs if isinstance(ref_imgs, list) and ref_imgs else None,
                        "duration": duration,
                        "resolution": resolution,
                        "aspect_ratio": aspect_ratio,
                    }
                    if fps is not None: mcp_args_v["fps"] = fps
                    if model: mcp_args_v["model"] = model
                    # 透传其余
                    for k,v in extra.items():
                        if k not in mcp_args_v and v not in (None,""):
                            mcp_args_v[k] = v
                    mcp_args_v = {k:v for k,v in mcp_args_v.items() if v not in (None,"",[])}
                    mcp_res_v = await _mcp2.execute_tool(f"provider_{prov}", mcp_args_v)
                    if mcp_res_v.status == "success" and mcp_res_v.result and (mcp_res_v.result.get("video_url") or mcp_res_v.result.get("url")):
                        v_url = mcp_res_v.result.get("video_url") or mcp_res_v.result.get("url")
                        return {"status":"success","video_url": v_url, "provider": prov, "elapsed_ms": mcp_res_v.execution_time_ms or int((time.time()-start)*1000), "task_id": mcp_res_v.result.get("task_id")}
                    if mcp_res_v.status == "success" and mcp_res_v.result and mcp_res_v.result.get("task_id"):
                        return {"status":"success","video_url": "", "provider": prov, "elapsed_ms": mcp_res_v.execution_time_ms or int((time.time()-start)*1000), "task_id": mcp_res_v.result.get("task_id")}
                except Exception as _e2:
                    print(f"[CanvasEngine] MCP provider_{prov} video fallback: {_e2}")
            res = await video_registry.generate(req, provider_id=prov if prov else None)
            # 处理异步排队（AutoDL）：若仅返回 task_id 则轮询至完成
            if not getattr(res, 'video_url', None) and getattr(res, 'task_id', None):
                task_id = res.task_id
                for _ in range(120):
                    await asyncio.sleep(3)
                    try:
                        from app.providers.generic.http_provider import get_custom_video_task
                        st = get_custom_video_task(task_id)
                        if st and st.get("status") in ("SUCCESS", "COMPLETED") and st.get("video_url"):
                            return {"status":"success","video_url": st["video_url"], "provider": res.provider, "elapsed_ms": int((time.time()-start)*1000), "task_id": task_id}
                        if st and st.get("status") in ("FAILED", "FAIL", "ERROR"):
                            return {"status":"error","error": st.get("error") or "视频任务失败"}
                    except Exception:
                        pass
                return {"status":"error","error": f"视频排队超时 task_id={task_id}，请稍后在画布重试或查看 /storage/videos/"}
            return {"status":"success","video_url": res.video_url, "provider": res.provider, "elapsed_ms": res.elapsed_ms or int((time.time()-start)*1000), "task_id": getattr(res, 'task_id', None)}
        elif ntype in ("tts","audio","voice"):
            text = merged.get("text") or merged.get("prompt") or merged.get("image_prompt") or merged.get("dialogue") or merged.get("subtitle_text") or merged.get("brief") or upstream.get("prompt") or upstream.get("text") or ""
            if not text.strip():
                return {"status":"error","error":"配音文本为空"}
            from app.providers.audio.registry import audio_registry
            from app.providers.audio.base import AudioGenerateRequest
            prov = merged.get("provider_id") or merged.get("provider") or merged.get("audio_provider") or merged.get("provider_audio") or upstream.get("provider_id") or upstream.get("provider_audio") or upstream.get("provider") or data.get("provider_id") or data.get("provider") or "minimax"
            model = merged.get("model") or data.get("model") or merged.get("default_model")
            # 透传 provider 参数与参考音频
            extra: Dict[str, Any] = {}
            for pk in ("speed", "pitch", "volume", "voice_id", "emotion", "model", "ref_audio_path", "ref_audio", "reference_audio", "style_preset"):
                vv = merged.get(pk)
                if vv in (None, ""):
                    vv = data.get(pk)
                if vv not in (None, ""):
                    extra[pk] = vv
            for bag in (merged.get("params"), merged.get("provider_params")):
                if isinstance(bag, dict):
                    for kk, vv in bag.items():
                        if vv not in (None, "") and kk not in extra:
                            extra[kk] = vv
            # upstream 参考音频注入
            ref_audio = merged.get("ref_audio") or merged.get("ref_audio_path") or upstream.get("ref_audio") or upstream.get("reference_audios") or upstream.get("audio_url")
            if isinstance(ref_audio, list) and ref_audio:
                ref_audio = ref_audio[0]
            if isinstance(ref_audio, str) and ref_audio.strip():
                extra.setdefault("ref_audio_path", ref_audio.strip())
            # 参数归一：音色/情绪缺省留空，由所选源自身声明兜底（不再写死 male-qn-qingse/neutral）
            voice_id = extra.get("voice_id") or merged.get("voice_id") or ""
            emotion = extra.get("emotion") or merged.get("emotion") or ""
            try:
                speed = float(extra.get("speed") if extra.get("speed") not in (None, "") else merged.get("speed") if merged.get("speed") not in (None, "") else 1.0)
            except:
                speed = 1.0
            pitch_val = extra.get("pitch")
            if pitch_val not in (None, ""):
                try:
                    pitch_val = float(pitch_val)
                except:
                    pitch_val = 0.0
            else:
                pitch_val = float(merged.get("pitch") or 0.0)
            req = AudioGenerateRequest(
                text=text.strip(),
                voice_id=voice_id,
                emotion=emotion,
                speed=speed,
                pitch=pitch_val,
                ref_audio_path=extra.get("ref_audio_path") or extra.get("ref_audio"),
                ref_text=extra.get("ref_text"),
                model=model or extra.get("model"),
                extra=extra if extra else None,
            )
            _ensure_provider_registered(prov, "audio")
            if prov:
                try:
                    from app.mcp.server import mcp_registry as _mcp3
                    mcp_args_a: Dict[str, Any] = {
                        "text": text.strip(),
                        "voice_id": voice_id,
                        "emotion": emotion,
                        "speed": speed,
                        "pitch": pitch_val,
                    }
                    if extra.get("ref_audio_path"): mcp_args_a["ref_audio"] = extra["ref_audio_path"]
                    if model: mcp_args_a["model"] = model
                    mcp_args_a = {k:v for k,v in mcp_args_a.items() if v not in (None,"")}
                    mcp_res_a = await _mcp3.execute_tool(f"provider_{prov}", mcp_args_a)
                    if mcp_res_a.status == "success" and mcp_res_a.result and (mcp_res_a.result.get("audio_url") or mcp_res_a.result.get("url")):
                        a_url = mcp_res_a.result.get("audio_url") or mcp_res_a.result.get("url")
                        return {"status":"success","audio_url": a_url, "provider": prov, "elapsed_ms": mcp_res_a.execution_time_ms or int((time.time()-start)*1000)}
                except Exception as _e3:
                    print(f"[CanvasEngine] MCP provider_{prov} audio fallback: {_e3}")
            res = await audio_registry.generate(req, provider_id=prov if prov else None)
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
            # 计算闭包：上游依赖 + 下游影响，确保单点执行时上游数据可注入
            adj: Dict[str,List[str]]={}
            rev: Dict[str,List[str]]={}
            for n in nodes:
                adj[n["id"]]=[]
                rev[n["id"]]=[]
            for e in edges:
                s = e.get("source"); t = e.get("target")
                if s in adj and t in adj:
                    adj[s].append(t)
                    rev[t].append(s)
            # 1) 上游祖先
            closure=set(target_ids)
            q=list(target_ids)
            while q:
                cur=q.pop(0)
                for pre in rev.get(cur,[]):
                    if pre not in closure:
                        closure.add(pre); q.append(pre)
            # 2) 下游后继（基于已包含上游的闭包）
            q=list(closure)
            visited_down=set(closure)
            while q:
                cur=q.pop(0)
                for nb in adj.get(cur,[]):
                    if nb not in visited_down:
                        visited_down.add(nb); q.append(nb)
                        closure.add(nb)
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
