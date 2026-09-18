"""
音频 Provider 注册表
"""
from typing import Dict, Any, List, Optional

from .base import AudioProvider, AudioGenerateRequest, AudioGenerateResult


class AudioProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, AudioProvider] = {}
        self._order: List[str] = []
        self._custom_ids: set = set()

    def register(self, provider: AudioProvider, is_custom: bool = False):
        self._providers[provider.id] = provider
        if provider.id not in self._order:
            self._order.append(provider.id)
        if is_custom:
            self._custom_ids.add(provider.id)
        print(f"[AudioRegistry] Registered provider: {provider.id} ({provider.display_name}){' [custom]' if is_custom else ''}")

    def unregister(self, provider_id: str) -> bool:
        if provider_id in self._providers:
            del self._providers[provider_id]
            if provider_id in self._order:
                self._order.remove(provider_id)
            self._custom_ids.discard(provider_id)
            print(f"[AudioRegistry] Unregistered provider: {provider_id}")
            return True
        return False

    def is_custom(self, provider_id: str) -> bool:
        return provider_id in self._custom_ids

    def get(self, provider_id: str) -> Optional[AudioProvider]:
        return self._providers.get(provider_id)

    def get_active_provider(self, preferred: Optional[str] = None) -> AudioProvider:
        from app.core.config import settings
        from app.providers import verification
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise RuntimeError(f"未找到音频Provider: {preferred}，已注册: {list(self._providers.keys())}")
            return prov
        pid = getattr(settings, "TTS_PROVIDER", "minimax")
        prov = self.get(pid)
        # 生产可用优先：已配置 且 已验证（测试联通）
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured() and verification.is_verified(oid):
                return p
        if prov and prov.is_configured():
            return prov
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured():
                return p
        if prov:
            return prov
        raise RuntimeError(f"未找到音频Provider: {pid}，已注册: {list(self._providers.keys())}")

    def list_providers(self) -> List[Dict[str, Any]]:
        result = []
        for pid in self._order:
            prov = self._providers[pid]
            result.append(prov.to_provider_info())
        return result

    async def generate(self, req: AudioGenerateRequest, provider_id: Optional[str] = None) -> AudioGenerateResult:
        extra_provider = (req.extra.get("provider") if req.extra and isinstance(req.extra, dict) else None)
        prov = self.get_active_provider(provider_id or extra_provider)
        # 参考音频归一：/storage 引用 → 本机绝对路径（本地克隆引擎要文件路径；代码源侧仍会再内联为 data URI）
        req = self._normalize_ref_audio(req)
        from app.extensions import guard
        _pid = (req.extra.get("project_id") if req.extra and isinstance(req.extra, dict) else None)
        guard.ensure_provider_enabled(getattr(prov, "id", provider_id or ""), _pid)
        return await prov.generate(req)

    @staticmethod
    def _normalize_ref_audio(req: AudioGenerateRequest) -> AudioGenerateRequest:
        ref = getattr(req, "ref_audio_path", None)
        if not isinstance(ref, str) or not ref.strip():
            return req
        if not ref.startswith(("/storage/", "storage/")):
            return req
        try:
            import os as _os
            from app.providers.media_refs import local_path_for_ref
            local = local_path_for_ref(ref)
            if local and _os.path.isfile(local):
                req.ref_audio_path = local
        except Exception:
            pass
        return req

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


audio_registry = AudioProviderRegistry()
