# -*- coding: utf-8 -*-
"""统一扩展注册表门面：只读聚合 + 统一执行 + 统一写口。

- 读：list/get/search 跨六管家（Step 1）
- 执行：execute 按 kind 路由到既有执行器（Step 2）
- 写：set_enabled/uninstall 委托各管家 + 跨 kind 去重（Step 3）
"""
import time
from typing import Any, Dict, List, Optional

from .models import (
    ExtensionKind,
    ExtensionStatus,
    ExtensionSource,
    ExtensionInfo,
    EXECUTABLE_KINDS,
    LIFECYCLE_KINDS,
    OVERLAY_LIFECYCLE_KINDS,
    make_ext_id,
    split_ext_id,
)
from . import adapters, state, telemetry


class ExtensionRegistry:
    def list(self, kind: Optional[str] = None,
             source: Optional[str] = None,
             q: Optional[str] = None,
             scope: str = "") -> List[ExtensionInfo]:
        kinds = [kind] if kind else list(adapters.ADAPTERS.keys())
        out: List[ExtensionInfo] = []
        for k in kinds:
            fn = adapters.ADAPTERS.get(k)
            if not fn:
                continue
            try:
                out.extend(fn() or [])
            except Exception:
                continue
        if source:
            out = [e for e in out if e.source == source]
        if q:
            ql = q.strip().lower()
            out = [e for e in out
                   if ql in (e.id or "").lower()
                   or ql in (e.name or "").lower()
                   or ql in (e.local_id or "").lower()]
        # 覆盖层：非原生生命周期的项按停用集标记为 disabled
        try:
            disabled = state.effective_disabled(scope)
        except Exception:
            disabled = set()
        if disabled:
            for e in out:
                if e.id in disabled:
                    e.status = ExtensionStatus.DISABLED
        order = {k: i for i, k in enumerate(
            ("provider", "skill", "workflow", "custom_node", "storyboard_slot",
             "plugin", "mcp_tool"))}
        out.sort(key=lambda e: (order.get(e.kind, 99), e.id))
        return out

    def get(self, ext_id: str) -> Optional[ExtensionInfo]:
        kind, local, publisher = split_ext_id(ext_id)
        if not kind:
            # 裸 id：按优先级跨 kind 查找
            for e in self.list():
                if e.local_id == ext_id or e.id == ext_id:
                    return e
            return None
        for e in self.list(kind=kind):
            if e.local_id != local:
                continue
            if publisher and (e.publisher or "") != publisher:
                continue
            return e
        return None

    def counts(self, scope: str = "") -> Dict[str, int]:
        ret: Dict[str, int] = {}
        for e in self.list(scope=scope):
            ret[e.kind] = ret.get(e.kind, 0) + 1
        ret["total"] = sum(ret.values())
        return ret

    # ---------------- Step 2：统一执行口 ----------------

    async def execute(self, ext_id: str, args: Optional[Dict[str, Any]] = None,
                      entry: str = "generate", scope: str = "") -> Dict[str, Any]:
        started = time.time()
        args = dict(args or {})
        # 项目作用域：args.project_id 优先，其次显式 scope
        _scope = scope or str(args.get("project_id") or "")
        kind = ""
        try:
            ext = self.get(ext_id)
            if not ext:
                raise ValueError(f"扩展不存在: {ext_id}")
            kind = ext.kind
            if ext.kind not in EXECUTABLE_KINDS:
                raise ValueError(f"kind={ext.kind} 不可执行（仅支持 {', '.join(EXECUTABLE_KINDS)}）")
            try:
                if state.is_disabled(ext.id, _scope):
                    raise ValueError(f"扩展已停用: {ext.id}（可在扩展中心启用）")
            except ValueError:
                raise
            except Exception:
                pass
            if ext.kind == ExtensionKind.SKILL:
                result = await self._exec_skill(ext.local_id, args)
            elif ext.kind == ExtensionKind.CUSTOM_NODE:
                result = await self._exec_custom_node(ext.local_id, args)
            elif ext.kind == ExtensionKind.MCP_TOOL:
                result = await self._exec_mcp_tool(ext.local_id, args)
            else:
                result = await self._exec_provider(ext, args, entry=entry)
            if not isinstance(result, dict):
                result = {"result": result}
            result.setdefault("extension", ext.id)
            result.setdefault("elapsed_ms", int((time.time() - started) * 1000))
            telemetry.record(ext.id, True, result["elapsed_ms"], kind=kind)
            return result
        except Exception as e:
            ms = int((time.time() - started) * 1000)
            telemetry.record(ext_id, False, ms, kind=kind, error=e,
                             timeout=isinstance(e, (TimeoutError,)))
            raise

    async def _exec_skill(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.skills.engine import skill_engine
        res = await skill_engine.execute_skill(
            name, args.get("context") or {}, args.get("user_prompt") or args.get("prompt") or "")
        try:
            return res.model_dump() if hasattr(res, "model_dump") else dict(res)
        except Exception:
            return {"result": str(res)}

    async def _exec_custom_node(self, nid: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.custom_nodes.manager import custom_node_manager, run_custom_node
        definition = custom_node_manager.get(nid)
        if not definition:
            raise ValueError(f"代码节点不存在: {nid}")
        inputs = args.get("inputs") or {}
        params = args.get("params") or {k: v for k, v in args.items() if k != "inputs"}
        return await run_custom_node(definition, inputs, params)

    async def _exec_mcp_tool(self, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        import asyncio
        import concurrent.futures
        from app.plugins.manager import _PLUGIN_TOOL_HANDLERS, _load_plugin_module
        h = (_PLUGIN_TOOL_HANDLERS or {}).get(tool_name)
        if not h:
            raise ValueError(f"MCP 工具未注册（或所属插件已停用）: {tool_name}")
        entry = h.get("entry") or tool_name
        pid = h.get("pid") or ""
        path = h.get("file") or ""
        try:
            mod = _load_plugin_module(pid, path) if path else None
            fn = getattr(mod, entry, None) if mod else None
        except Exception as e:
            raise RuntimeError(f"插件工具加载失败: {e}")
        if not callable(fn):
            raise RuntimeError(f"插件工具入口不可调用: {entry}")
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            try:
                out = await asyncio.wait_for(
                    loop.run_in_executor(pool, lambda: fn(dict(args), {"tool": tool_name})),
                    timeout=30.0)
            except asyncio.TimeoutError:
                raise TimeoutError("插件工具执行超时（30s）")
        return out if isinstance(out, dict) else {"result": out}

    async def _exec_provider(self, ext: ExtensionInfo, args: Dict[str, Any],
                             entry: str = "generate") -> Dict[str, Any]:
        # 显式类型优先：entry 参数 > ext.sub_kind；不再靠参数字段猜类型。
        sub = (str(entry) if entry not in ("", "generate") else "") or (ext.sub_kind or "")
        sub = sub.lower()
        if sub not in ("image", "video", "audio"):
            raise ValueError(
                f"无法确定 provider 类型: {ext.id}（sub_kind='{ext.sub_kind}'）。"
                f"请在 execute 传 entry='image'|'video'|'audio' 显式指定")
        if sub == "audio":
            return await self._exec_provider_audio(ext.local_id, args)
        if sub == "video":
            return await self._exec_provider_video(ext.local_id, args)
        return await self._exec_provider_image(ext.local_id, args)

    async def _exec_provider_image(self, pid: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.providers.image.registry import image_registry
        from app.providers.image.base import ImageGenerateRequest
        req = ImageGenerateRequest(
            prompt=args.get("prompt") or "",
            negative_prompt=args.get("negative_prompt") or "",
            aspect_ratio=args.get("aspect_ratio") or "9:16",
            resolution=args.get("resolution"),
            seed=args.get("seed"),
            model=args.get("model"),
            width=args.get("width"),
            height=args.get("height"),
            steps=args.get("steps"),
            cfg=args.get("cfg"),
            reference_images=args.get("reference_images"),
            dynamic_inputs=args.get("dynamic_inputs"),
        )
        res = await image_registry.generate(req, provider_id=pid or None)
        return {"image_url": res.image_url, "provider": res.provider,
                "engine": res.engine, "seed": res.seed}

    async def _exec_provider_video(self, pid: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.providers.video.registry import video_registry
        from app.providers.video.base import VideoGenerateRequest
        req = VideoGenerateRequest(
            prompt=args.get("prompt") or "",
            mode=args.get("mode") or "i2v",
            first_frame_url=args.get("first_frame_url") or args.get("first_frame"),
            last_frame_url=args.get("last_frame_url") or args.get("last_frame"),
            reference_images=args.get("reference_images"),
            reference_videos=args.get("reference_videos"),
            reference_audios=args.get("reference_audios"),
            duration=int(args.get("duration") or 5),
            resolution=args.get("resolution") or "720p",
            aspect_ratio=args.get("aspect_ratio") or "9:16",
            seed=args.get("seed"),
            dynamic_inputs=args.get("dynamic_inputs"),
        )
        res = await video_registry.generate(req, provider_id=pid or None)
        return {"video_url": res.video_url, "provider": res.provider,
                "engine": res.engine, "task_id": res.task_id}

    async def _exec_provider_audio(self, pid: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.providers.audio.registry import audio_registry
        from app.providers.audio.base import AudioGenerateRequest
        req = AudioGenerateRequest(
            text=args.get("text") or "",
            voice_id=args.get("voice_id") or "",
            emotion=args.get("emotion") or "",
            speed=float(args.get("speed") or 1.0),
            pitch=float(args.get("pitch") or 0.0),
            model=args.get("model"),
        )
        res = await audio_registry.generate(req, provider_id=pid or None)
        return {"audio_url": res.audio_url, "provider": res.provider,
                "voice_id": res.voice_id}

    # ---------------- Step 3：统一写口 ----------------

    def check_id_available(self, kind: str, local_id: str, publisher: str = "") -> Dict[str, Any]:
        """去重：以 (kind, publisher, local_id) 为命名空间粒度。

        - 同 kind 内 local_id 不得重复（provider:kling 与 skill:kling 可共存）；
        - 若给出 publisher，则进一步报告同 kind 下其他 publisher 的撞名（供插件作者避让内置 id）。
        """
        local_id = str(local_id or "").strip()
        conflicts: List[str] = []
        cross_publisher: List[str] = []
        for e in self.list(kind=kind):
            if e.local_id != local_id:
                continue
            conflicts.append(e.id)
            if publisher and (e.publisher or "") != publisher:
                cross_publisher.append(e.id)
        return {
            "kind": kind,
            "local_id": local_id,
            "publisher": publisher or "",
            "qualified": make_ext_id(kind, local_id, publisher),
            "available": not conflicts,
            "conflicts": conflicts,
            "cross_publisher_conflicts": cross_publisher,
            "namespace_ok": not cross_publisher,
        }

    def set_enabled(self, ext_id: str, enabled: bool, scope: str = "") -> Dict[str, Any]:
        ext = self.get(ext_id)
        if not ext:
            raise ValueError(f"扩展不存在: {ext_id}")
        # 项目作用域：所有 kind 统一走覆盖层（原生 kind 不改全局注册状态，仅在本项目软停用）
        if scope:
            det = state.set_disabled(ext.id, not enabled, scope)
            native = ext.kind in LIFECYCLE_KINDS and ext.source != ExtensionSource.BUILTIN
            resp: Dict[str, Any] = {
                "extension": ext.id, "enabled": enabled,
                "mode": "project-overlay" if native else "overlay", "detail": det,
            }
            if native and enabled and ext.status == ExtensionStatus.DISABLED:
                resp["hint"] = "该扩展全局处于停用，项目内启用不会生效；请先在全局启用"
            return resp
        # 原生生命周期：plugin / 自定义 provider（全局）
        if ext.kind == ExtensionKind.PLUGIN:
            from app.plugins import manager as plugin_manager
            ret = (plugin_manager.enable(ext.local_id) if enabled
                   else plugin_manager.disable(ext.local_id))
            return {"extension": ext.id, "enabled": enabled, "mode": "native", "detail": ret}
        if ext.kind == ExtensionKind.PROVIDER and ext.source != ExtensionSource.BUILTIN:
            from app.providers.custom.manager import custom_provider_manager
            from app.providers.init_providers import (
                register_single_custom_provider, unregister_single_custom_provider)
            d = custom_provider_manager.get_definition(ext.local_id)
            if not d:
                raise ValueError(f"自定义 Provider 不存在: {ext.local_id}")
            d.enabled = bool(enabled)
            custom_provider_manager.save_definition(d)
            if enabled:
                register_single_custom_provider(d)
            else:
                unregister_single_custom_provider(d.id, getattr(d, "kind", "image"))
            return {"extension": ext.id, "enabled": enabled, "mode": "native"}
        # 内置常驻：不可停用
        if ext.source == ExtensionSource.BUILTIN or ext.kind not in OVERLAY_LIFECYCLE_KINDS:
            raise ValueError(
                f"kind={ext.kind} 不支持统一启停（builtin 常驻或走原生接口）")
        # 覆盖层启停（skill/workflow/custom_node/mcp_tool/storyboard_slot）
        return {"extension": ext.id, "enabled": enabled, "mode": "overlay",
                "detail": state.set_disabled(ext.id, not enabled, scope)}

    def uninstall(self, ext_id: str) -> Dict[str, Any]:
        ext = self.get(ext_id)
        if not ext:
            raise ValueError(f"扩展不存在: {ext_id}")
        if ext.kind == ExtensionKind.PLUGIN:
            from app.plugins import manager as plugin_manager
            return {"extension": ext.id, **plugin_manager.uninstall(ext.local_id)}
        if ext.kind == ExtensionKind.PROVIDER and ext.source != ExtensionSource.BUILTIN:
            from app.providers.custom.manager import custom_provider_manager
            from app.providers.init_providers import unregister_single_custom_provider
            d = custom_provider_manager.get_definition(ext.local_id)
            kind = getattr(d, "kind", "image") if d else "image"
            unregister_single_custom_provider(ext.local_id, kind)
            ok = custom_provider_manager.delete_definition(ext.local_id)
            return {"extension": ext.id, "deleted": bool(ok)}
        raise ValueError(f"kind={ext.kind} 不支持统一卸载（builtin 不可卸载）")

    # ---------------- Step 5：可观测 ----------------

    def health(self) -> Dict[str, Any]:
        known = {e.id for e in self.list()}
        h = telemetry.health()
        h["known"] = len(known)
        try:
            h["pruned_state_refs"] = state.prune_unknown(known | set(h["stats"].keys()))
        except Exception:
            h["pruned_state_refs"] = 0
        return h

    def stats(self, ext_id: Optional[str] = None) -> Dict[str, Any]:
        snap = telemetry.snapshot()
        if ext_id:
            return {"extension": ext_id, "stats": snap.get(ext_id)}
        return {"stats": snap}

    def recent(self, n: int = 30) -> Dict[str, Any]:
        return {"recent": telemetry.recent(n)}


extension_registry = ExtensionRegistry()
