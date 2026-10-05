"""
图片 Provider 注册表 - 动态可扩展核心
支持运行时注册/发现所有图片生成提供商
"""
from typing import Dict, Any, List, Optional
import time

from .base import ImageProvider, ImageGenerateRequest, ImageGenerateResult

# “永远自认为已配置”的本地占位源：不能被默认路由自动选中，需显式指定或测试通过
_LOCAL_PLACEHOLDER = {"comfyui"}


class ImageProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, ImageProvider] = {}
        self._order: List[str] = []  # 注册顺序
        self._custom_ids: set = set()  # 标记自定义 provider id

    def register(self, provider: ImageProvider, is_custom: bool = False):
        self._providers[provider.id] = provider
        if provider.id not in self._order:
            self._order.append(provider.id)
        if is_custom:
            self._custom_ids.add(provider.id)
        print(f"[ImageRegistry] Registered provider: {provider.id} ({provider.display_name}){' [custom]' if is_custom else ''}")

    def unregister(self, provider_id: str) -> bool:
        if provider_id in self._providers:
            del self._providers[provider_id]
            if provider_id in self._order:
                self._order.remove(provider_id)
            self._custom_ids.discard(provider_id)
            print(f"[ImageRegistry] Unregistered provider: {provider_id}")
            return True
        return False

    def is_custom(self, provider_id: str) -> bool:
        return provider_id in self._custom_ids

    def get(self, provider_id: str) -> Optional[ImageProvider]:
        return self._providers.get(provider_id)

    def get_active_provider(self, preferred: Optional[str] = None) -> ImageProvider:
        """获取当前生效的 provider：优先 preferred；否则优先「已验证+已配置」，再首个已配置云端源，最后兜底默认。"""
        from app.core.config import settings
        from app.providers import verification
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise RuntimeError(f"未找到图片Provider: {preferred}，已注册: {list(self._providers.keys())}")
            return prov
        pid = getattr(settings, "IMAGE_PROVIDER", "comfyui")
        prov = self.get(pid)
        # 1) 生产可用优先：已配置 且 已验证（测试联通）
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured() and verification.is_verified(oid):
                return p
        # 2) 默认若为“真实云端源”且已配置，直接用（本地占位源 comfyui 恒真，不算）
        if pid not in _LOCAL_PLACEHOLDER and prov and prov.is_configured():
            return prov
        for oid in self._order:
            if oid in _LOCAL_PLACEHOLDER:
                continue
            p = self._providers[oid]
            if p.is_configured():
                return p
        # 3) 默认源未配置且没有任何云端源可用：回退本地占位源（ComfyUI），
        #    避免把默认改成 openai_compat 后"没配 Key 就整个生图不可用"
        ph = self._providers.get("comfyui")
        if ph is not None and prov is not None and not prov.is_configured():
            return ph
        # 4) 兜底：请求的源（会给出明确错误）
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
        # 显式 provider_id 优先，若请求中包含自定义 workflow_id 则自动路由至 comfyui
        target_provider = provider_id
        if not target_provider and req.workflow_id:
            target_provider = "comfyui"
        extra_provider = (req.extra.get("provider") if req.extra and isinstance(req.extra, dict) else None)
        prov = self.get_active_provider(target_provider or extra_provider)
        from app.extensions import guard
        _pid = (req.extra.get("project_id") if req.extra and isinstance(req.extra, dict) else None)
        guard.ensure_provider_enabled(getattr(prov, "id", target_provider or ""), _pid)
        from app.providers.gen_timer import with_timer
        return await with_timer("image", getattr(prov, "id", "") or "unknown", prov.generate(req),
                                detail=(req.prompt or "")[:40])

    async def check_health_all(self) -> Dict[str, Any]:
        """并行探测所有图片源健康（串行在离线/慢网络下会叠加成几十秒）。"""
        import asyncio

        async def _one(pid: str, prov) -> tuple:
            try:
                ok = await prov.check_health()
                return pid, {"ok": ok, "configured": prov.is_configured()}
            except Exception as e:
                return pid, {"ok": False, "configured": prov.is_configured(), "error": str(e)}

        jobs = [_one(pid, prov) for pid, prov in self._providers.items()]
        pairs = await asyncio.gather(*jobs) if jobs else []
        return {pid: info for pid, info in pairs}

    def list_ids(self) -> List[str]:
        return list(self._order)


# 全局单例
image_registry = ImageProviderRegistry()
