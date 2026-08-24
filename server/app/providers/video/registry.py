from typing import Dict, Any, List, Optional
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

class VideoProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, VideoProvider] = {}
        self._order: List[str] = []

    def register(self, provider: VideoProvider):
        self._providers[provider.id] = provider
        if provider.id not in self._order:
            self._order.append(provider.id)
        print(f"[VideoRegistry] Registered provider: {provider.id} ({provider.display_name})")

    def get(self, provider_id: str) -> Optional[VideoProvider]:
        return self._providers.get(provider_id)

    def get_active_provider(self, preferred: Optional[str] = None) -> VideoProvider:
        from app.core.config import settings
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise RuntimeError(f"未找到视频Provider: {preferred}，已注册: {list(self._providers.keys())}")
            return prov
        pid = getattr(settings, "VIDEO_PROVIDER", "comfyui_video") or "comfyui_video"
        prov = self.get(pid)
        if prov and prov.is_configured():
            return prov
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured():
                return p
        if prov:
            return prov
        raise RuntimeError(f"未找到视频Provider: {pid}，已注册: {list(self._providers.keys())}")

    def list_providers(self) -> List[Dict[str, Any]]:
        return [self._providers[pid].to_provider_info() for pid in self._order]

    async def generate(self, req: VideoGenerateRequest, provider_id: Optional[str] = None) -> VideoGenerateResult:
        extra_provider = (req.extra.get("provider") if req.extra and isinstance(req.extra, dict) else None)
        prov = self.get_active_provider(provider_id or extra_provider)
        return await prov.generate(req)

    async def check_health_all(self) -> Dict[str, Any]:
        results = {}
        for pid, prov in self._providers.items():
            try:
                ok = await prov.check_health()
                results[pid] = {"ok": ok, "configured": prov.is_configured()}
            except Exception as e:
                results[pid] = {"ok": False, "configured": prov.is_configured(), "error": str(e)}
        return results

    def list_ids(self) -> List[str]:
        return list(self._order)

video_registry = VideoProviderRegistry()
