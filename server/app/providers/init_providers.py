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
    audio_registry._providers.clear()
    audio_registry._order.clear()
    video_registry._providers.clear()
    video_registry._order.clear()

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

    print(f"[Providers] Initialized: {len(image_registry._providers)} image, {len(audio_registry._providers)} audio, {len(video_registry._providers)} video providers")
