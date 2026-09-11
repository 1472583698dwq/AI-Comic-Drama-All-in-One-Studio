from typing import Dict, Any, List, Optional
from .base import VideoProvider, VideoGenerateRequest, VideoGenerateResult

# 本地占位视频源（is_configured 恒真且会出 mock）：默认路由不自动选它
_LOCAL_PLACEHOLDER = {"comfyui_video"}

class VideoProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, VideoProvider] = {}
        self._order: List[str] = []
        self._custom_ids: set = set()

    def register(self, provider: VideoProvider, is_custom: bool = False):
        self._providers[provider.id] = provider
        if provider.id not in self._order:
            self._order.append(provider.id)
        if is_custom:
            self._custom_ids.add(provider.id)
        print(f"[VideoRegistry] Registered provider: {provider.id} ({provider.display_name}){' [custom]' if is_custom else ''}")

    def unregister(self, provider_id: str) -> bool:
        if provider_id in self._providers:
            del self._providers[provider_id]
            if provider_id in self._order:
                self._order.remove(provider_id)
            self._custom_ids.discard(provider_id)
            print(f"[VideoRegistry] Unregistered provider: {provider_id}")
            return True
        return False

    def is_custom(self, provider_id: str) -> bool:
        return provider_id in self._custom_ids

    def get(self, provider_id: str) -> Optional[VideoProvider]:
        return self._providers.get(provider_id)

    def get_active_provider(self, preferred: Optional[str] = None) -> VideoProvider:
        from app.core.config import settings
        from app.providers import verification
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise RuntimeError(f"未找到视频Provider: {preferred}，已注册: {list(self._providers.keys())}")
            return prov
        pid = getattr(settings, "VIDEO_PROVIDER", "comfyui_video") or "comfyui_video"
        prov = self.get(pid)
        # 1) 生产可用优先：已配置 且 已验证（测试联通）
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured() and verification.is_verified(oid):
                return p
        # 2) 默认若为“真实云端源”且已配置，直接用（本地占位源 comfyui_video 恒真，不算）
        if pid not in _LOCAL_PLACEHOLDER and prov and prov.is_configured():
            return prov
        for oid in self._order:
            if oid in _LOCAL_PLACEHOLDER:
                continue
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
        from app.extensions import guard
        _pid = (req.extra.get("project_id") if req.extra and isinstance(req.extra, dict) else None)
        guard.ensure_provider_enabled(getattr(prov, "id", provider_id or ""), _pid)
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
