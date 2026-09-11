# -*- coding: utf-8 -*-
"""
LLM Planner — 由大模型生成结构化执行计划（替代关键词模板，关键词仅作兜底）

对标主流 harness：计划必须由 LLM 产出（Claude Code / Codex / Cline / DeepSeek Harness），
关键词 build_plan 仅在 LLM 不可用/超时/输出不合法时兜底，保证离线可单测、UI 永不空转。

输出协议（与前端 PlanCard 兼容）：
{
  "intent": "shot_single|canvas|character|batch_onekey|script|export|asset|debug|chat",
  "label": "计划标题",
  "reason": "一句话依据",
  "risk": "low|medium|high",
  "steps": [{"id","title","tool","args_preview":{},"risk","est_s","target"}],
  "needs_confirm": bool,
  "est_total_s": int
}
"""
from typing import Any, Dict, List, Optional

# Plan Mode 只读工具白名单（硬门控，绑定层执行；与 langchain_engine 同源）
PLAN_READONLY_TOOLS = {
    "search_tools",
    "canvas_query", "canvas_query_assets",
    "list_assets", "get_asset",
    "list_image_providers", "list_video_providers", "list_voice_providers",
    "list_voices", "list_comfyui_workflows", "list_custom_providers",
    "get_provider_code",
    "director_3d_stage_plan",
    "split_novel_script",
    "creator_inspect_runtime",
}

_PLANNER_SYSTEM = """你是「AI 漫剧 Studio」的执行计划规划器（Planner）。根据用户指令与项目上下文，产出一份可直接执行的计划。

【硬性要求】
1. 只输出一个 JSON 对象，不要 markdown 围栏、不要解释文字。
2. 工具只能从下方【可用工具目录】中选择；确需本地动作（如载入项目/绑定素材）可用 `local:动作名`。
3. 需要首帧/参考图/参考音频的任务，必须选择输入参数含对应插槽的生成源（目录中已标注）。
   输入参数只有 prompt 的源是纯文本源，禁止把参考图挂给它。
4. 尊重画布现状：能复用已有节点/素材就不要重复生成；有画布摘要时优先在画布上编排。
5. 步骤 3-8 条为宜，按依赖顺序排列；每步标注 risk(low/medium/high) 与 est_s(预估秒数)。
6. 若用户只是提问/咨询，intent 用 chat、steps 为空、needs_confirm=false。
7. 涉及批量/高成本生成（一键成片、批量视频）时 risk=high、needs_confirm=true。

【JSON 结构】
{"intent":"shot_single|canvas|character|batch_onekey|script|export|asset|debug|chat",
 "label":"计划标题(中文)",
 "reason":"一句话依据",
 "risk":"low|medium|high",
 "steps":[{"id":"s1","title":"步骤标题","tool":"工具名","args_preview":{...},"risk":"low|medium|high","est_s":10,"target":"作用对象"}],
 "needs_confirm":true,
 "est_total_s":120}
"""


def _tool_catalog(limit: int = 120) -> str:
    """紧凑工具目录：名称 — 描述 | 输入插槽（供 Planner 选源与排步骤）"""
    try:
        from app.mcp.server import mcp_registry
    except Exception:
        return ""
    lines: List[str] = []
    for t in mcp_registry.get_all_tools():
        if len(lines) >= limit:
            break
        name = t.name or ""
        desc = (t.description or "").replace("\n", " ")[:90]
        slots = ""
        try:
            props = (t.input_schema or {}).get("properties", {}) or {}
            handles = []
            for k, v in props.items():
                if isinstance(v, dict) and (v.get("format") == "uri" or v.get("x-handle") in ("image", "audio", "video")):
                    handles.append(k)
            if handles:
                slots = " | 插槽:" + ",".join(handles[:8])
        except Exception:
            pass
        lines.append(f"- {name} — {desc}{slots}")
    return "\n".join(lines)


def _context_brief(context: Dict[str, Any]) -> str:
    ctx = context or {}
    proj = ctx.get("project") or {}
    shots = 0
    try:
        shots = sum(len(sc.get("shots") or []) for sc in (proj.get("scenes") or []))
    except Exception:
        pass
    active = ctx.get("active_shot") or {}
    parts = [
        f"项目: {ctx.get('project_title') or proj.get('title') or '无'}（{shots}镜）",
        f"画幅: {proj.get('aspect_ratio') or '9:16'}，风格: {proj.get('style_preset') or 'donghua_xianxia'}",
        f"激活镜: #{active.get('shot_index')} {active.get('action_desc') or active.get('image_prompt') or '无'}（机位:{active.get('camera_framing') or '默认'} 运镜:{active.get('camera_motion') or '默认'}）",
    ]
    cs = ctx.get("canvas_summary")
    if cs:
        parts.append(f"画布摘要: {str(cs)[:600]}")
    return "\n".join(parts)


def _normalize_plan(raw: Any, prompt: str, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """校验/清洗 LLM 输出；不合法返回 None（由调用方兜底）"""
    if not isinstance(raw, dict):
        return None
    steps_in = raw.get("steps")
    if steps_in is None:
        steps_in = []
    if not isinstance(steps_in, list):
        return None
    steps: List[Dict[str, Any]] = []
    for i, s in enumerate(steps_in[:12]):
        if not isinstance(s, dict):
            continue
        tool = str(s.get("tool") or "").strip()
        if not tool:
            continue
        try:
            est = int(s.get("est_s") or 0)
        except Exception:
            est = 0
        risk = str(s.get("risk") or "medium").lower()
        if risk not in ("low", "medium", "high"):
            risk = "medium"
        steps.append({
            "id": str(s.get("id") or f"s{i+1}"),
            "title": str(s.get("title") or tool)[:80],
            "tool": tool,
            "args_preview": s.get("args_preview") if isinstance(s.get("args_preview"), dict) else {},
            "risk": risk,
            "est_s": max(0, est),
            "target": str(s.get("target") or "")[:40],
        })
    risk = str(raw.get("risk") or ("high" if any(x["risk"] == "high" for x in steps) else
                                  "medium" if any(x["risk"] == "medium" for x in steps) else "low")).lower()
    if risk not in ("low", "medium", "high"):
        risk = "medium"
    est_total = sum(x["est_s"] for x in steps)
    return {
        "intent": str(raw.get("intent") or "shot_single")[:32],
        "label": str(raw.get("label") or "执行计划")[:40],
        "reason": str(raw.get("reason") or "LLM 规划")[:200],
        "risk": risk,
        "steps": steps,
        "needs_confirm": bool(raw.get("needs_confirm", risk in ("medium", "high") and len(steps) > 1)),
        "est_total_s": est_total,
        "planner": "llm",
    }


async def llm_plan(prompt: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """LLM 规划：失败/超时/非法输出 → 关键词 build_plan 兜底（永不抛错）。"""
    from app.agent.business import build_plan
    ctx = context or {}
    try:
        from app.pipelines.llm_service import llm_service
        catalog = _tool_catalog()
        user_prompt = (
            f"【用户指令】\n{prompt[:1500]}\n\n"
            f"【项目上下文】\n{_context_brief(ctx)}\n\n"
            f"【可用工具目录】\n{catalog[:12000]}\n\n"
            f"请输出计划 JSON："
        )
        raw = await llm_service.chat_json(
            system_prompt=_PLANNER_SYSTEM,
            user_prompt=user_prompt,
            temperature=0.2,
            max_tokens=1600,
            timeout=45,
        )
        plan = _normalize_plan(raw, prompt, ctx)
        if plan is not None:
            return plan
    except Exception as e:
        try:
            print(f"[Planner] LLM plan failed, fallback to keyword: {e}")
        except Exception:
            pass
    # 兜底：确定性关键词计划（原有 build_plan，可单测）
    fallback = build_plan(prompt, ctx)
    fallback["planner"] = "keyword"
    return fallback
