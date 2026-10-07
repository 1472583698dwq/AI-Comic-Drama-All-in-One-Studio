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

    @staticmethod
    def _supports_request(prov: VideoProvider, req: Optional[VideoGenerateRequest]) -> bool:
        """源能力是否覆盖本次请求：mode + 首帧/尾帧/参考媒体插槽。

        req 为空时不做能力过滤（向后兼容）；能力无法判断（get_capabilities 异常）时按支持处理。
        """
        if req is None:
            return True
        try:
            cap = prov.get_capabilities() or {}
        except Exception:
            return True
        mode = (getattr(req, "mode", None) or "i2v").strip() or "i2v"
        modes = cap.get("modes")
        if modes and mode not in modes:
            return False
        if getattr(req, "first_frame_url", None) and cap.get("supports_first_frame") is False:
            return False
        if getattr(req, "last_frame_url", None) and cap.get("supports_last_frame") is False:
            return False
        has_ref = bool(getattr(req, "reference_images", None)
                       or getattr(req, "reference_videos", None)
                       or getattr(req, "reference_audios", None))
        if has_ref and cap.get("supports_reference") is False:
            return False
        return True

    @staticmethod
    def _unsupported_msg(provider_id: str, req: VideoGenerateRequest) -> str:
        mode = (getattr(req, "mode", None) or "i2v")
        bits = [f"mode={mode}"]
        if getattr(req, "first_frame_url", None):
            bits.append("首帧")
        if getattr(req, "last_frame_url", None):
            bits.append("尾帧")
        if (getattr(req, "reference_images", None) or getattr(req, "reference_videos", None)
                or getattr(req, "reference_audios", None)):
            bits.append("参考媒体")
        return f"视频Provider「{provider_id}」不支持当前请求（{'/'.join(bits)}），请更换视频源或调整参数"

    def get_active_provider(self, preferred: Optional[str] = None,
                            req: Optional[VideoGenerateRequest] = None) -> VideoProvider:
        from app.core.config import settings
        from app.providers import verification
        if preferred:
            prov = self.get(preferred)
            if not prov:
                raise ValueError(f"未找到视频Provider: {preferred}，已注册: {list(self._providers.keys())}")
            if not self._supports_request(prov, req):
                raise ValueError(self._unsupported_msg(preferred, req))
            return prov
        pid = getattr(settings, "VIDEO_PROVIDER", "comfyui_video") or "comfyui_video"
        prov = self.get(pid)
        # 1) 生产可用优先：已配置 且 已验证（测试联通）且 支持本次请求
        for oid in self._order:
            p = self._providers[oid]
            if p.is_configured() and verification.is_verified(oid) and self._supports_request(p, req):
                return p
        # 2) 默认若为“真实云端源”、已配置且支持本次请求，直接用（本地占位源 comfyui_video 恒真，不算）
        if pid not in _LOCAL_PLACEHOLDER and prov and prov.is_configured() and self._supports_request(prov, req):
            return prov
        # 3) 首个「已配置且支持本次请求」的非占位源
        for oid in self._order:
            if oid in _LOCAL_PLACEHOLDER:
                continue
            p = self._providers[oid]
            if p.is_configured() and self._supports_request(p, req):
                return p
        # 4) 默认源兜底（仍须支持本次请求，否则给出明确 4xx 而非落到不支持的工作流上报 500）
        if prov and self._supports_request(prov, req):
            return prov
        if req is not None:
            raise ValueError(f"没有已配置的视频源支持当前请求：{self._unsupported_msg(pid, req)}")
        if prov:
            return prov
        raise ValueError(f"未找到视频Provider: {pid}，已注册: {list(self._providers.keys())}")

    @staticmethod
    def _clamp_duration(prov: VideoProvider, req: VideoGenerateRequest) -> None:
        """按源的 min/max_duration 显式钳制时长并回写 req，响应中的 duration 即最终生效值。"""
        try:
            cap = prov.get_capabilities() or {}
        except Exception:
            cap = {}

        def _int(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None

        mn = _int(cap.get("min_duration"))
        mx = _int(cap.get("max_duration"))
        d = _int(getattr(req, "duration", None))
        if d is None or d <= 0:
            d = 5
        if mn is not None and d < mn:
            d = mn
        if mx is not None and d > mx:
            d = mx
        if d < 1:
            d = 1
        req.duration = d

    def list_providers(self) -> List[Dict[str, Any]]:
        return [self._providers[pid].to_provider_info() for pid in self._order]

    async def generate(self, req: VideoGenerateRequest, provider_id: Optional[str] = None) -> VideoGenerateResult:
        extra_provider = (req.extra.get("provider") if req.extra and isinstance(req.extra, dict) else None)
        # 入口校验：空/纯空白 prompt 直接 4xx（不产生任务）；查询模式（透传 task_id 且无 prompt）除外。
        _dyn = req.dynamic_inputs if isinstance(req.dynamic_inputs, dict) else {}
        _extra = req.extra if isinstance(req.extra, dict) else {}
        _task_id = _dyn.get("task_id") or _extra.get("task_id")
        if not (req.prompt or "").strip() and not _task_id:
            raise ValueError("视频生成需要非空 prompt（运动/运镜描述）")
        prov = self.get_active_provider(provider_id or extra_provider, req=req)
        from app.extensions import guard
        _pid = (req.extra.get("project_id") if req.extra and isinstance(req.extra, dict) else None)
        guard.ensure_provider_enabled(getattr(prov, "id", provider_id or ""), _pid)
        # 按源能力显式钳制时长（响应 duration 即为最终生效值）
        self._clamp_duration(prov, req)
        from app.providers.gen_timer import with_timer
        return await with_timer("video", getattr(prov, "id", "") or "unknown", prov.generate(req),
                                detail=(req.prompt or "")[:40])

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
