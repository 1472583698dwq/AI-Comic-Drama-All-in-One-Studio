"""
图片 Provider 注册表 - 动态可扩展核心
支持运行时注册/发现所有图片生成提供商
"""
from typing import Dict, Any, List, Optional
import time

from .base import ImageProvider, ImageGenerateRequest, ImageGenerateResult


class ImageProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, ImageProvider] = {}
        self._order: List[str] = []  # 注册顺序

    def register(self, provider: ImageProvider):
        self._providers[provider.id] = provider
        if provider.id not in self._order:
            self._order.append(provider.id)
        print(f"[ImageRegistry] Registered provider: {provider.id} ({provider.display_name})")

    def get(self, provider_id: str) -> Optional[ImageProvider]:
        return self._providers.get(provider_id)

    def get_active_provider(self, preferred: Optional[str] = None) -> ImageProvider:
        """获取当前生效的provider：优先preferred，其次settings.IMAGE_PROVIDER，最后首个已配置的"""
        from app.core.config import settings
        # 若显式指定 preferred，严格返回该provider（即使未配置，调用时会抛明确错误）
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise RuntimeError(f"未找到图片Provider: {preferred}，已注册: {list(self._providers.keys())}")
            return prov
        pid = getattr(settings, "IMAGE_PROVIDER", "comfyui")
        prov = self.get(pid)
        if prov and prov.is_configured():
            return prov
        # fallback to first configured
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured():
                return p
        # fallback to requested even if not configured (will error with clear msg)
        if prov:
            return prov
        raise RuntimeError(f"未找到图片Provider: {pid}，已注册: {list(self._providers.keys())}")

    def list_providers(self) -> List[Dict[str, Any]]:
        result = []
        for pid in self._order:
            prov = self._providers[pid]
            info = prov.to_provider_info()
            result.append(info)
        return result

    async def generate(self, req: ImageGenerateRequest, provider_id: Optional[str] = None) -> ImageGenerateResult:
        # 显式 provider_id 优先，其次 req.extra.provider，最后用默认
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


# 全局单例
image_registry = ImageProviderRegistry()
