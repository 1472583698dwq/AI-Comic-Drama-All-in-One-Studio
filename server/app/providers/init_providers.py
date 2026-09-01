"""
Provider 初始化 - 代码生成源为唯一方式（彻底去 JSON 模板）
"""
def _make_provider(definition):
    """根据 definition.language/code 选择代码执行器，兼容存量 JSON 迁移"""
    kind = getattr(definition, "kind", "image")
    has_code = bool(getattr(definition, "code", None) and definition.code.strip())
    legacy = getattr(definition, "legacy_json_mode", False)
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
                            if idx < len(std_refs) and std_refs[idx]:
                                dyn[k] = std_refs[idx]
                            elif idx == 0 and std_refs and std_refs[0]:
                                dyn[k] = std_refs[0]
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
                    # 文本提示词 → 工作流真实文本入口（如 PrimitiveString 30:19，用户想法经 Agent 润色后必须落盘）
                    try:
                        txt = (getattr(req, "prompt", None) or "").strip() if getattr(req, "prompt", None) else ""
                        if txt:
                            txt_slots = [e for e in (_exposed or []) if e.get("type") == "text"]
                            # 优先 alias/标签含 提示词/user 的“用户提示词”入口
                            chosen = None
                            for e in txt_slots:
                                lab = str(e.get("label","") or "") + str(e.get("alias","") or "") + str(e.get("description","") or "")
                                if "提示词" in lab or "user" in lab.lower():
                                    chosen = e; break
                            if not chosen:
                                for e in txt_slots:
                                    if str(e.get("param_name","")).lower() in ("prompt","value","text"):
                                        chosen = e; break
                            if not chosen and txt_slots:
                                chosen = txt_slots[0]
                            if chosen and chosen.get("id") not in dyn:
                                dyn[chosen["id"]] = txt
                    except Exception:
                        pass
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
                        dyn.pop("reference_images", None); dyn.pop("reference", None)
                        for idx, exp in enumerate(img_slots):
                            k = exp.get("id")
                            if idx < len(std_refs) and std_refs[idx]:
                                dyn[k] = std_refs[idx]
                            elif idx == 0 and std_refs and std_refs[0]:
                                dyn[k] = std_refs[0]
                        req.dynamic_inputs = dyn
                    # 标准 params → 具体 id
                    for std_key, exp_id in _map.items():
                        val = getattr(req, std_key, None)
                        if val is None: val = dyn.get(std_key)
                        if val is None and hasattr(req, "extra") and isinstance(getattr(req,"extra"), dict):
                            val = getattr(req,"extra").get(std_key)
                        if val is not None and exp_id not in dyn:
                            dyn[exp_id] = val
                    # 文本提示词 → 工作流真实文本入口（同上，解决 30:6 链路经 Switch/Concat 无法直写的问题）
                    try:
                        txt = (getattr(req, "prompt", None) or "").strip() if getattr(req, "prompt", None) else ""
                        if txt:
                            txt_slots = [e for e in (_exposed or []) if e.get("type") == "text"]
                            chosen = None
                            for e in txt_slots:
                                lab = str(e.get("label","") or "") + str(e.get("alias","") or "") + str(e.get("description","") or "")
                                if "提示词" in lab or "user" in lab.lower():
                                    chosen = e; break
                            if not chosen:
                                for e in txt_slots:
                                    if str(e.get("param_name","")).lower() in ("prompt","value","text"):
                                        chosen = e; break
                            if not chosen and txt_slots:
                                chosen = txt_slots[0]
                            if chosen and chosen.get("id") not in dyn:
                                dyn[chosen["id"]] = txt
                    except Exception:
                        pass
                    req.dynamic_inputs = dyn
                except Exception:
                    pass
                return await _orig(req)
            base.generate = _gen2  # type: ignore
            return base
    # 兼容存量 JSON（自动提示升级）
    if legacy or definition.transport.url:
        from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
        print(f"[Providers] Legacy JSON provider {definition.id} detected, consider upgrading to code mode via director tool")
        if kind == "image":
            return GenericHttpImageProvider(definition)
        elif kind == "audio":
            return GenericHttpAudioProvider(definition)
        elif kind == "video":
            return GenericHttpVideoProvider(definition)
        else:
            return GenericHttpImageProvider(definition)
    raise RuntimeError(f"Provider {definition.id} 未配置代码且非兼容 JSON，已跳过")


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
    from .video.comfyui_video import ComfyUIVideoProvider
    from .video.minimax_video import CloudVideoProvider

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

    # 注册音频
    audio_registry.register(MiniMaxTTSProvider())
    audio_registry.register(ElevenLabsProvider())
    audio_registry.register(CosyVoiceProvider())
    audio_registry.register(GPTSoVITSProvider())

    # 注册视频 (ComfyUI 本地 + MiniMax/Kling 云端)
    video_registry.register(ComfyUIVideoProvider())
    video_registry.register(CloudVideoProvider())

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
