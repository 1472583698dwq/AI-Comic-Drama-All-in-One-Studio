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


def register_single_custom_provider(definition):
    """热注册单个自定义 provider，无需重启（代码优先）"""
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
        return True
    except Exception as e:
        print(f"[Providers] Hot register failed {definition.id}: {e}")
        return False


def unregister_single_custom_provider(provider_id: str, kind: str = "image"):
    from app.providers.image.registry import image_registry
    from app.providers.audio.registry import audio_registry
    from app.providers.video.registry import video_registry
    if kind == "image":
        return image_registry.unregister(provider_id)
    elif kind == "audio":
        return audio_registry.unregister(provider_id)
    elif kind == "video":
        return video_registry.unregister(provider_id)
    else:
        found = False
        for reg in (image_registry, audio_registry, video_registry):
            if reg.unregister(provider_id):
                found = True
        return found
