# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas FX-B 画布执行结果写回画布（progress/COORDINATION.md 第 16 条，E2E-3 D5）。

``canvas_engine.execute_dag`` 只返回各节点结果、不落盘；MCP ``canvas_execute`` / ``POST /canvas/execute`` /
``POST /projects/{id}/canvas/execute`` 执行完用这里把结果合并进画布节点再保存，前端收到 ``canvas_updated`` 重载即可看到。

合并口径与前端一致（kit/useGeneration、host/executeRouter.runTextSkill、hooks/nodeAgentExecutor.patchFromPayload）：
- 媒体节点（图片 / 视频 / 音频，及产出媒体的 custom / ext-node…）：``image_url``(+``result_url``) / ``video_url`` / ``audio_url``，
  并把本次结果插到 ``history`` 最前（``{url, created_at, provider_id?, prompt?, params?}``，按 url 去重，最多 20 条）；
- 视频源返回 task_id 但还没出片：写 ``_taskId`` + ``_polling``，前端节点挂载后自动续轮询（N3 useTaskRecovery）；
- 文本节点（prompt）：只有真正执行了文本技能（结果带 ``skill_id``）才写回 ``text``/``prompt``（同值，N1）与 ``script_data``；
  原样透传正文的结果不写；
- 3D 导演：``camera_prompt`` / ``minimax_camera_prompt``；
- 成功写 ``agent_state = {status: completed, tool, provider_id?, elapsed_ms?, updated_at}``，失败写 ``status: failed`` + error。

保存：执行可能跑几分钟，期间前端可能已自动保存，所以**重新读取**同一张画布（显式 canvas_id）后按节点 id 合并，
再按该 canvas_id 保存（``save_canvas`` 保留 schema_version / viewport 等顶层键）；画布里已不存在的节点跳过。
"""
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

HISTORY_LIMIT = 20
TOOL_NAME = "canvas_execute"

_IMAGE_TYPES = frozenset({"image", "generate-image", "shot-card", "comfy-workflow"})
_VIDEO_TYPES = frozenset({"video", "video-node"})
_AUDIO_TYPES = frozenset({"audio", "tts", "voice"})
_TEXT_TYPES = frozenset({"prompt"})
# 只读 / 容器 / 配置节点：执行结果只是透传自身数据，不写回
_PASSIVE_TYPES = frozenset({
    "group", "load-image", "load-image-batch", "load-video", "load-audio", "asset", "brief",
    "provider", "provider-image", "provider-video", "provider-audio", "provider-llm",
})


def now_iso() -> str:
    """与前端 ``new Date().toISOString()`` 同格式（UTC、毫秒、Z 结尾）。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_history(history: Any, item: Dict[str, Any], limit: int = HISTORY_LIMIT) -> List[Dict[str, Any]]:
    """同前端 kit/useGeneration.appendHistory：新结果在最前，按 url 去重，超出上限丢最旧的。"""
    prev = [h for h in history if isinstance(h, dict) and h.get("url")] if isinstance(history, list) else []
    return [item, *[h for h in prev if h.get("url") != item.get("url")]][:limit]


def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _media_kind(node_type: str, result: Dict[str, Any]) -> Optional[str]:
    if node_type in _IMAGE_TYPES:
        return "image"
    if node_type in _VIDEO_TYPES:
        return "video"
    if node_type in _AUDIO_TYPES:
        return "audio"
    # custom / ext-node / 其他产出媒体的节点：按产物键判断
    if _str(result.get("video_url")):
        return "video"
    if _str(result.get("audio_url")):
        return "audio"
    if _str(result.get("image_url")) or _str(result.get("result_url")):
        return "image"
    return None


def _media_url(kind: str, result: Dict[str, Any]) -> str:
    if kind == "image":
        return _str(result.get("image_url")) or _str(result.get("result_url")) or _str(result.get("url"))
    return _str(result.get(f"{kind}_url"))


def _own_prompt(kind: str, data: Dict[str, Any]) -> str:
    keys = ("text", "prompt") if kind == "audio" else ("prompt", "video_prompt" if kind == "video" else "image_prompt", "text")
    for k in keys:
        v = _str(data.get(k))
        if v:
            return v
    return ""


def _provider_of(result: Dict[str, Any], data: Dict[str, Any]) -> str:
    for v in (result.get("provider_id"), result.get("provider"), data.get("provider_id"), data.get("provider")):
        if _str(v):
            return _str(v)
    return ""


def _state(status: str, ts: str, result: Dict[str, Any], provider: str, error: str = "") -> Dict[str, Any]:
    st: Dict[str, Any] = {"status": status, "tool": TOOL_NAME, "updated_at": ts}
    if provider:
        st["provider_id"] = provider
    if error:
        st["error"] = error[:200]
    el = result.get("elapsed_ms")
    if isinstance(el, (int, float)) and not isinstance(el, bool):
        st["elapsed_ms"] = int(el)
    return st


def result_patch(node: Dict[str, Any], result: Any, now: Optional[str] = None) -> Dict[str, Any]:
    """一个节点的执行结果 → 节点数据补丁（口径见模块文档）；返回 {} = 不写回。"""
    if not isinstance(node, dict) or not isinstance(result, dict):
        return {}
    ntype = node.get("type") or ""
    if ntype in _PASSIVE_TYPES:
        return {}
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    ts = now or now_iso()
    provider = _provider_of(result, data)
    status = result.get("status")
    if status == "error":
        return {"agent_state": _state("failed", ts, result, provider, str(result.get("error") or "执行失败"))}
    if status != "success":
        return {}

    patch: Dict[str, Any] = {}
    if ntype in _TEXT_TYPES:
        if not result.get("skill_id"):
            return {}  # 未执行技能 = 原样透传正文，不改节点
        text = _str(result.get("text")) or _str(result.get("prompt"))
        if text:
            patch["text"] = text
            patch["prompt"] = text
        if result.get("script_data") is not None:
            patch["script_data"] = result["script_data"]
    elif ntype == "director3d":
        for k in ("camera_prompt", "minimax_camera_prompt"):
            if _str(result.get(k)):
                patch[k] = result[k]
    else:
        kind = _media_kind(ntype, result)
        url = _media_url(kind, result) if kind else ""
        if url:
            patch[f"{kind}_url"] = url
            if kind == "image":
                patch["result_url"] = url
            if kind == "video" and data.get("_polling"):
                patch["_polling"] = False
            item: Dict[str, Any] = {"url": url, "created_at": ts}
            if provider:
                item["provider_id"] = provider
            own = _own_prompt(kind, data)
            if own:
                item["prompt"] = own
            if isinstance(data.get("params"), dict) and data["params"]:
                item["params"] = data["params"]
            patch["history"] = append_history(data.get("history"), item)
        elif kind == "video" and _str(result.get("task_id")):
            # 视频还在生成：落 task_id，前端节点挂载后续轮询（出片后由前端写 video_url + history）
            return {"_taskId": _str(result.get("task_id")), "_polling": True,
                    "agent_state": _state("running", ts, result, provider)}
        if ntype == "custom" and _str(result.get("text")):
            patch["text"] = result["text"]
    if not patch:
        return {}
    patch["agent_state"] = _state("completed", ts, result, provider)
    return patch


def merge_results_into_nodes(nodes: Iterable[Dict[str, Any]], results: Dict[str, Any],
                             now: Optional[str] = None) -> List[str]:
    """把 results 就地合并进 nodes（按节点 id），返回改动过的节点 id（按 nodes 顺序）。"""
    if not isinstance(results, dict) or not results:
        return []
    ts = now or now_iso()
    updated: List[str] = []
    for n in nodes or []:
        if not isinstance(n, dict) or n.get("id") not in results:
            continue
        patch = result_patch(n, results[n["id"]], ts)
        if not patch:
            continue
        data = n.get("data") if isinstance(n.get("data"), dict) else {}
        n["data"] = {**data, **patch}
        updated.append(n["id"])
    return updated


def persist_execution_results(project_id: Optional[str], canvas_id: Optional[str], results: Dict[str, Any],
                              project_manager: Any = None) -> Dict[str, Any]:
    """重读画布 → 合并结果 → 按显式 canvas_id 保存。返回 ``{persisted, canvas_id, updated_nodes[, reason]}``，不抛异常。"""
    out: Dict[str, Any] = {"persisted": False, "canvas_id": canvas_id, "updated_nodes": []}
    if not project_id or not isinstance(results, dict) or not results:
        out["reason"] = "无项目或无结果"
        return out
    try:
        if project_manager is None:
            from app.providers.project.manager import project_manager as _pm
            project_manager = _pm
        snap = project_manager.get_canvas(project_id, canvas_id) if canvas_id else project_manager.get_canvas(project_id)
        if not snap:
            out["reason"] = "画布不存在"
            return out
        cid = canvas_id or str(snap.get("canvas_id") or "") or "default"
        out["canvas_id"] = cid
        nodes = snap.get("nodes") if isinstance(snap.get("nodes"), list) else []
        updated = merge_results_into_nodes(nodes, results)
        if not updated:
            out["reason"] = "没有可写回的产出"
            return out
        snap["nodes"] = nodes
        project_manager.save_canvas(project_id, snap, canvas_id=cid)
        out.update(persisted=True, updated_nodes=updated)
        return out
    except Exception as e:  # 写回失败不影响执行结果本身
        print(f"[CanvasPersist] 写回画布失败 project={project_id} canvas={canvas_id}: {e}")
        out["reason"] = f"写回失败: {e}"
        return out
