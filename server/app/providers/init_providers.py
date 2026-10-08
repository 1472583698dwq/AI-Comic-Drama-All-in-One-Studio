"""
Provider 初始化 - 代码生成源为唯一方式（彻底去 JSON 模板）
"""


def _inject_workflow_prompt(dyn: dict, req, exposed: list) -> dict:
    """
    标准 prompt → 工作流真实文本入口（选择规则与 schema 生成同源，见 pick_prompt_text_slot）。
    用户已显式填写该槽位（dyn 中存在）时不覆盖，保证"生成源参数列表"优先于隐式提示词。
    """
    try:
        txt = (getattr(req, "prompt", None) or "").strip() if getattr(req, "prompt", None) else ""
        if not txt:
            return dyn
        from app.providers.workflow.manager import pick_prompt_text_slot
        chosen = pick_prompt_text_slot(exposed or [])
        if chosen and chosen.get("id") and chosen["id"] not in dyn:
            dyn[chosen["id"]] = txt
    except Exception:
        pass
    return dyn


def _make_provider(definition):
    """代码执行器唯一入口；非代码（JSON 模板/http）模式已删除，无代码定义一律拒绝注册"""
    kind = getattr(definition, "kind", "image")
    has_code = bool(getattr(definition, "code", None) and definition.code.strip())
    # 优先代码
    if has_code:
        from app.providers.generic.code_provider import GenericCodeImageProvider, GenericCodeVideoProvider, GenericCodeAudioProvider
        if kind == "image":
            return GenericCodeImageProvider(definition)
        elif kind == "audio":
            return GenericCodeAudioProvider(definition)
        elif kind == "video":
            return GenericCodeVideoProvider(definition)
        elif kind == "llm":
            return None
        else:
            return GenericCodeImageProvider(definition)
    # ComfyUI 工作流独立 Provider（每工作流一源，provider_type=comfyui + workflow_id）
    # 标准化输入（prompt/reference_images）→ 工作流具体暴露槽位（img_12/txt_*）的映射在 wrapper 内完成
    if getattr(definition, "provider_type", "") == "comfyui" and getattr(definition, "workflow_id", None):
        wkid = getattr(definition, "workflow_id")
        w_exposed = getattr(definition, "workflow_exposed", None) or []
        # 建立标准 key → 工作流具体 id 的映射（用于 params）
        _std_to_exp = {}
        for exp in (w_exposed or []):
            nid = str(exp.get("node_id",""))
            pname = str(exp.get("param_name",""))
            eid = str(exp.get("id",""))
            low = pname.lower()
            std = None
            if "aspect_ratio" in low: std = "aspect_ratio"
            elif low == "steps" or "steps" in low: std = "steps"
            elif low == "cfg": std = "cfg"
            elif "seed" in low: std = "seed"
            elif "sampler_name" in low: std = "sampler_name"
            elif "scheduler" in low: std = "scheduler"
            elif "width" in low: std = "width"
            elif "height" in low: std = "height"
            elif "duration" in low: std = "duration"
            elif "resolution" in low: std = "resolution"
            elif low in ("fps","frame_rate"): std = "fps"
            elif "denoise" in low: std = "denoise"
            if std and eid not in _std_to_exp.values():
                # 优先保留首个映射
                if std not in _std_to_exp:
                    _std_to_exp[std] = eid
        if kind == "video":
            from app.providers.video.comfyui_video import ComfyUIVideoProvider
            base = ComfyUIVideoProvider()
            base.id = definition.id
            base.display_name = definition.get_display_name()
            base.workflow_id = wkid  # type: ignore
            orig = base.generate
            async def _gen(req, _orig=orig, _wkid=wkid, _exposed=w_exposed, _map=_std_to_exp):
                if not getattr(req, "workflow_id", None):
                    req.workflow_id = _wkid
                try:
                    dyn = dict(getattr(req, "dynamic_inputs", None) or {})
                    # 图像映射
                    std_refs = getattr(req, "reference_images", None)
                    if not std_refs: std_refs = dyn.get("reference_images")
                    if not std_refs: std_refs = getattr(req, "dynamic_inputs", {}).get("reference_images") if getattr(req, "dynamic_inputs", None) else None
                    img_slots = [e for e in (_exposed or []) if e.get("type")=="image"]
                    if std_refs and img_slots:
                        if isinstance(std_refs, str): std_refs = [std_refs]
                        dyn.pop("reference_images", None)
                        for idx, exp in enumerate(img_slots):
                            k = exp.get("id")
                            if k in dyn:
                                continue  # 用户已按节点显式挂载的独立槽优先，位置映射不覆盖
                            if idx < len(std_refs) and std_refs[idx]:
                                dyn[k] = std_refs[idx]
                            elif idx == 0 and std_refs and std_refs[0]:
                                dyn[k] = std_refs[0]
                        req.dynamic_inputs = dyn

                    # 视频映射 (reference_videos)
                    std_vids = getattr(req, "reference_videos", None)
                    if not std_vids: std_vids = dyn.get("reference_videos")
                    vid_slots = [e for e in (_exposed or []) if e.get("type") == "video"]
                    if std_vids and vid_slots:
                        if isinstance(std_vids, str): std_vids = [std_vids]
                        dyn.pop("reference_videos", None)
                        for idx, exp in enumerate(vid_slots):
                            k = exp.get("id")
                            if k in dyn:
                                continue
                            if idx < len(std_vids) and std_vids[idx]:
                                dyn[k] = std_vids[idx]
                            elif idx == 0 and std_vids and std_vids[0]:
                                dyn[k] = std_vids[0]
                        req.dynamic_inputs = dyn

                    # 音频映射 (reference_audios)
                    std_auds = getattr(req, "reference_audios", None)
                    if not std_auds: std_auds = dyn.get("reference_audios")
                    aud_slots = [e for e in (_exposed or []) if e.get("type") == "audio"]
                    if std_auds and aud_slots:
                        if isinstance(std_auds, str): std_auds = [std_auds]
                        dyn.pop("reference_audios", None)
                        for idx, exp in enumerate(aud_slots):
                            k = exp.get("id")
                            if k in dyn:
                                continue
                            if idx < len(std_auds) and std_auds[idx]:
                                dyn[k] = std_auds[idx]
                            elif idx == 0 and std_auds and std_auds[0]:
                                dyn[k] = std_auds[0]
                        req.dynamic_inputs = dyn

                    # 标准 params → 工作流具体 id
                    for std_key, exp_id in _map.items():
                        val = getattr(req, std_key, None)
                        if val is None: val = dyn.get(std_key)
                        if val is None and hasattr(req, "extra") and isinstance(getattr(req,"extra"), dict):
                            val = getattr(req,"extra").get(std_key)
                        if val is not None and exp_id not in dyn:
                            dyn[exp_id] = val
                            # 清理顶层避免重复
                            if hasattr(req, std_key):
                                try: setattr(req, std_key, None)
                                except: pass
                    # 合并剩余 extra 到 dyn
                    if hasattr(req, "extra") and isinstance(getattr(req,"extra"), dict):
                        for k,v in list(getattr(req,"extra").items()):
                            if k in _map and _map[k] not in dyn and v not in (None,""):
                                dyn[_map[k]] = v
                    # 文本提示词 → 工作流真实文本入口（单点规则，与生成源 schema 同源）
                    dyn = _inject_workflow_prompt(dyn, req, _exposed)
                    req.dynamic_inputs = dyn
                except Exception:
                    pass
                return await _orig(req)
            base.generate = _gen  # type: ignore
            return base
        else:
            from app.providers.image.comfyui import ComfyUIProvider
            base = ComfyUIProvider()
            base.id = definition.id
            base.display_name = definition.get_display_name()
            base.workflow_id = wkid  # type: ignore
            orig = base.generate
            async def _gen2(req, _orig=orig, _wkid=wkid, _exposed=w_exposed, _map=_std_to_exp):
                if not getattr(req, "workflow_id", None):
                    req.workflow_id = _wkid
                try:
                    dyn = dict(getattr(req, "dynamic_inputs", None) or {})
                    std_refs = None
                    if getattr(req, "reference_images", None): std_refs = getattr(req, "reference_images")
                    elif dyn.get("reference_images"): std_refs = dyn.get("reference_images")
                    elif dyn.get("reference"): std_refs = dyn.get("reference")
                    img_slots = [e for e in (_exposed or []) if e.get("type")=="image"]
                    if std_refs and img_slots:
                        if isinstance(std_refs, str): std_refs = [std_refs]
                        for idx, exp in enumerate(img_slots):
                            k = exp.get("id")
                            if k in dyn:
                                continue  # 用户已按节点显式挂载的独立槽优先，位置映射不覆盖
                            if idx < len(std_refs) and std_refs[idx]:
                                dyn[k] = std_refs[idx]
                            elif idx == 0 and std_refs and std_refs[0]:
                                dyn[k] = std_refs[0]
                        req.dynamic_inputs = dyn
                        req.reference_images = std_refs
                    # 标准 params → 具体 id
                    for std_key, exp_id in _map.items():
                        val = getattr(req, std_key, None)
                        if val is None: val = dyn.get(std_key)
                        if val is None and hasattr(req, "extra") and isinstance(getattr(req,"extra"), dict):
                            val = getattr(req,"extra").get(std_key)
                        if val is not None and exp_id not in dyn:
                            dyn[exp_id] = val
                    # 文本提示词 → 工作流真实文本入口（单点规则，与生成源 schema 同源）
                    dyn = _inject_workflow_prompt(dyn, req, _exposed)
                    req.dynamic_inputs = dyn
                except Exception:
                    pass
                return await _orig(req)
            base.generate = _gen2  # type: ignore
            return base
    # 非代码模式已删除：无代码、非工作流的定义一律拒绝注册（存量请用升级接口升级为代码）
    print(f"[Providers] 非代码源 {definition.id} 已废弃（JSON 模板模式已移除），请升级为代码模式")
    raise RuntimeError(f"Provider {definition.id} 未配置代码（非代码模式已删除），已拒绝注册")


def init_all_providers():
    from .image.registry import image_registry
    from .audio.registry import audio_registry
    from .video.registry import video_registry
    from .image.comfyui import ComfyUIProvider
    from .image.siliconflow import SiliconFlowProvider
    from .image.dashscope import DashScopeProvider
    from .image.openai_compat import OpenAICompatProvider
    from .audio.minimax import MiniMaxTTSProvider
    from .audio.elevenlabs import ElevenLabsProvider
    from .audio.cosyvoice import CosyVoiceProvider
    from .audio.gptsovits import GPTSoVITSProvider
    from .audio.indextts import IndexTTSProvider
    from .video.comfyui_video import ComfyUIVideoProvider
    from .video.minimax_video import CloudVideoProvider
    from .video.minimax_h3 import MiniMaxH3VideoProvider
    from .video.seedance import SeedanceVideoProvider
    from .video.kling import KlingVideoProvider
    from .video.wan3 import Wan3VideoProvider
    from .video.openai_video import OpenAIVideoProvider

    # 清理旧注册（热重载）
    image_registry._providers.clear()
    image_registry._order.clear()
    if hasattr(image_registry, "_custom_ids"):
        image_registry._custom_ids.clear()
    audio_registry._providers.clear()
    audio_registry._order.clear()
    if hasattr(audio_registry, "_custom_ids"):
        audio_registry._custom_ids.clear()
    video_registry._providers.clear()
    video_registry._order.clear()
    if hasattr(video_registry, "_custom_ids"):
        video_registry._custom_ids.clear()

    # 注册图片
    image_registry.register(ComfyUIProvider())
    image_registry.register(SiliconFlowProvider())
    image_registry.register(DashScopeProvider())
    image_registry.register(OpenAICompatProvider())
    from .image.l0veyou_web import L0veyouWebProvider
    image_registry.register(L0veyouWebProvider())

    # 注册音频
    audio_registry.register(MiniMaxTTSProvider())
    audio_registry.register(ElevenLabsProvider())
    audio_registry.register(CosyVoiceProvider())
    audio_registry.register(GPTSoVITSProvider())
    audio_registry.register(IndexTTSProvider())

    # 注册视频 (ComfyUI 本地 + 4 默认云端: H3/Seedance/Kling/Wan3 + 旧兼容通道 + 自定义 OpenAI 兼容)
    # 缺 Key 的源 is_configured()=False, 注册表自动跳过, 配 Key 后即用
    video_registry.register(ComfyUIVideoProvider())
    video_registry.register(MiniMaxH3VideoProvider())
    video_registry.register(SeedanceVideoProvider())
    video_registry.register(KlingVideoProvider())
    video_registry.register(Wan3VideoProvider())
    video_registry.register(CloudVideoProvider())
    video_registry.register(OpenAIVideoProvider())

    # 加载自定义 Providers（代码为唯一方式）
    try:
        from app.providers.custom.manager import custom_provider_manager
        customs = custom_provider_manager.list_definitions()
        for definition in customs:
            try:
                if not definition.enabled:
                    continue
                if definition.kind == "llm":
                    continue
                prov = _make_provider(definition)
                if not prov:
                    continue
                if definition.kind == "image":
                    image_registry.register(prov, is_custom=True)
                elif definition.kind == "audio":
                    audio_registry.register(prov, is_custom=True)
                elif definition.kind == "video":
                    video_registry.register(prov, is_custom=True)
                else:
                    image_registry.register(prov, is_custom=True)
            except Exception as e:
                print(f"[Providers] Failed to register custom provider {definition.id}: {e}")
        if customs:
            print(f"[Providers] Loaded {len(customs)} custom providers (code mode)")
    except Exception as e:
        print(f"[Providers] Custom provider load skipped: {e}")

    print(f"[Providers] Initialized: {len(image_registry._providers)} image, {len(audio_registry._providers)} audio, {len(video_registry._providers)} video providers")
    # 同步每条 ComfyUI 工作流为独立生成源（每工作流一 provider，供画布按源选择）
    try:
        from app.providers.workflow.manager import sync_all_workflow_providers
        sync_all_workflow_providers()
        # 刷新后重新统计
        print(f"[Providers] After workflow sync: {len(image_registry._providers)} image, {len(video_registry._providers)} video providers")
    except Exception as e:
        print(f"[Providers] Workflow provider sync skipped: {e}")


def register_single_custom_provider(definition):
    """热注册单个自定义 provider，无需重启（代码优先）→ 同步 MCP 动态 Tool"""
    from app.providers.image.registry import image_registry
    from app.providers.audio.registry import audio_registry
    from app.providers.video.registry import video_registry
    kind = getattr(definition, "kind", "image")
    try:
        prov = _make_provider(definition)
        if not prov:
            print(f"[Providers] Skipped register {definition.id}: no provider built")
            return False
        if kind == "image":
            image_registry.register(prov, is_custom=True)
        elif kind == "audio":
            audio_registry.register(prov, is_custom=True)
        elif kind == "video":
            video_registry.register(prov, is_custom=True)
        else:
            image_registry.register(prov, is_custom=True)
        print(f"[Providers] Hot registered code provider {definition.id} ({kind}, lang={definition.language})")
        # 同步 MCP：让节点Agent可动态调用 provider_xxx Tool
        try:
            from app.mcp.server import mcp_registry as _mcp
            _mcp.refresh_provider_tools()
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"[Providers] Hot register failed {definition.id}: {e}")
        return False


def unregister_single_custom_provider(provider_id: str, kind: str = "image"):
    from app.providers.image.registry import image_registry
    from app.providers.audio.registry import audio_registry
    from app.providers.video.registry import video_registry
    res = False
    if kind == "image":
        res = image_registry.unregister(provider_id)
    elif kind == "audio":
        res = audio_registry.unregister(provider_id)
    elif kind == "video":
        res = video_registry.unregister(provider_id)
    else:
        found = False
        for reg in (image_registry, audio_registry, video_registry):
            if reg.unregister(provider_id):
                found = True
        res = found
    # 同步 MCP
    try:
        from app.mcp.server import mcp_registry as _mcp
        _mcp.refresh_provider_tools()
    except Exception:
        pass
    return res
