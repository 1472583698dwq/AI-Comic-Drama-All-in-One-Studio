"""
Provider 初始化 - 在应用启动时注册所有内置Provider (图片/音频/视频)
"""
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

    # 加载自定义 Providers（解耦：多生成源持久化）
    try:
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
        customs = custom_provider_manager.list_definitions()
        for definition in customs:
            try:
                if not definition.enabled:
                    continue
                if definition.kind == "image":
                    prov = GenericHttpImageProvider(definition)
                    image_registry.register(prov, is_custom=True)
                elif definition.kind == "audio":
                    prov = GenericHttpAudioProvider(definition)
                    audio_registry.register(prov, is_custom=True)
                elif definition.kind == "video":
                    prov = GenericHttpVideoProvider(definition)
                    video_registry.register(prov, is_custom=True)
                elif definition.kind == "llm":
                    # LLM 暂不走 registry，仅存储
                    pass
                else:
                    prov = GenericHttpImageProvider(definition)
                    image_registry.register(prov, is_custom=True)
            except Exception as e:
                print(f"[Providers] Failed to register custom provider {definition.id}: {e}")
        if customs:
            print(f"[Providers] Loaded {len(customs)} custom providers")
    except Exception as e:
        print(f"[Providers] Custom provider load skipped: {e}")

    print(f"[Providers] Initialized: {len(image_registry._providers)} image, {len(audio_registry._providers)} audio, {len(video_registry._providers)} video providers")


def register_single_custom_provider(definition):
    """热注册单个自定义 provider，无需重启"""
    from app.providers.image.registry import image_registry
    from app.providers.audio.registry import audio_registry
    from app.providers.video.registry import video_registry
    from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
    kind = getattr(definition, "kind", "image")
    try:
        if kind == "image":
            prov = GenericHttpImageProvider(definition)
            image_registry.register(prov, is_custom=True)
        elif kind == "audio":
            prov = GenericHttpAudioProvider(definition)
            audio_registry.register(prov, is_custom=True)
        elif kind == "video":
            prov = GenericHttpVideoProvider(definition)
            video_registry.register(prov, is_custom=True)
        else:
            prov = GenericHttpImageProvider(definition)
            image_registry.register(prov, is_custom=True)
        print(f"[Providers] Hot registered custom provider {definition.id} ({kind})")
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
        # 尝试全部
        found = False
        for reg in (image_registry, audio_registry, video_registry):
            if reg.unregister(provider_id):
                found = True
        return found
