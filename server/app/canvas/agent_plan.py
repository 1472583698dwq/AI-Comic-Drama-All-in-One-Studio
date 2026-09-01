# -*- coding: utf-8 -*-
"""
节点 Agent 规划器 — 用户自然语言需求 → skill 选择 → 生成源选择 → 异构参数组装
这是"每节点一Agent"的大脑：LLM 读候选生成源的真实 schema（params_schema/input_schema）
产出最终 prompt + 参数 JSON，随后统一交 provider_* Tool 执行。
LLM 不可用/解析失败时自动降级为规则式规划（绝不阻断生成）。
"""
import json
import re
from typing import Any, Dict, List, Optional

# 技能目录（与前端 providerSkills.ts 对齐）
SKILL_CATALOG = {
    "image": [
        {"id": "text_to_image", "name": "文生图", "desc": "纯文本生成，无参考图"},
        {"id": "image_reference", "name": "参考生图", "desc": "带垫图/参考图生成（有 reference_images 时用）"},
        {"id": "character_consistency", "name": "角色一致性", "desc": "角色卡三视图定妆，必须带参考图"},
    ],
    "video": [
        {"id": "text_to_video", "name": "文生视频", "desc": "纯文本运动描述"},
        {"id": "first_last_frame", "name": "首尾帧", "desc": "有首帧(可选尾帧)时镜头连续生成"},
        {"id": "all_round_reference", "name": "全能参考", "desc": "多参考图驱动 R2V"},
    ],
    "audio": [
        {"id": "tts_voice", "name": "角色配音", "desc": "文本→情感配音"},
        {"id": "audio_clone", "name": "音色克隆", "desc": "有参考音频时克隆音色"},
    ],
}


def _providers_brief(kind: str) -> List[Dict[str, Any]]:
    """候选生成源摘要：id/名称/模型/参数schema(裁剪)"""
    briefs: List[Dict[str, Any]] = []
    try:
        if kind == "image":
            from app.providers.image.registry import image_registry as reg
        elif kind == "video":
            from app.providers.video.registry import video_registry as reg
        else:
            from app.providers.audio.registry import audio_registry as reg
        for pid in reg.list_ids():
            try:
                obj = reg.get(pid)
                if obj is None:
                    continue
                info: Dict[str, Any] = {"id": pid}
                info["name"] = getattr(obj, "display_name", None) or pid
                models = []
                definition = getattr(obj, "definition", None)
                if definition is not None:
                    models = list(getattr(definition, "models", []) or [])[:8]
                    info["desc"] = (getattr(definition, "description", "") or "")[:80]
                    ps = getattr(definition, "params_schema", None) or {}
                    props = (ps.get("properties") if isinstance(ps, dict) else {}) or {}
                    slim = {}
                    for k, v in list(props.items())[:14]:
                        entry = {}
                        if isinstance(v, dict):
                            if v.get("enum"):
                                entry["enum"] = [str(x) for x in v["enum"]][:12]
                            if v.get("default") is not None:
                                entry["default"] = v.get("default")
                            if v.get("minimum") is not None:
                                entry["min"] = v.get("minimum")
                            if v.get("maximum") is not None:
                                entry["max"] = v.get("maximum")
                        slim[k] = entry
                    info["params_schema"] = slim
                    ischem = getattr(definition, "input_schema", None) or {}
                    info["input_keys"] = list(((ischem.get("properties") if isinstance(ischem, dict) else {}) or {}).keys())
                else:
                    try:
                        cap = obj.get_capabilities() if hasattr(obj, "get_capabilities") else {}
                        models = list(cap.get("models", []) or [])[:8]
                        info["params_schema"] = cap.get("params_schema") or {}
                    except Exception:
                        pass
                if models:
                    info["models"] = models
                briefs.append(info)
            except Exception:
                continue
    except Exception as e:
        print(f"[AgentPlanner] providers brief failed: {e}")
    return briefs


def _rule_plan(node_type: str, idea: str, provider_id: str, slots: Dict[str, Any]) -> Dict[str, Any]:
    """无 LLM 时的规则降级规划"""
    if not provider_id:
        briefs = _providers_brief(node_type)
        provider_id = briefs[0]["id"] if briefs else ""
    has_ref = bool((slots.get("reference_images") or slots.get("reference")))
    has_first = bool(slots.get("first_frame"))
    has_last = bool(slots.get("last_frame"))
    has_audio = bool(slots.get("ref_audio"))
    if node_type == "image":
        skill = "image_reference" if has_ref else "text_to_image"
    elif node_type == "video":
        skill = "first_last_frame" if (has_first and has_last) else ("first_last_frame" if has_first else ("all_round_reference" if has_ref else "text_to_video"))
    else:
        skill = "audio_clone" if has_audio else "tts_voice"
    return {"skill_id": skill, "provider_id": provider_id, "model": "", "prompt": idea, "params": {}, "reasoning": "规则式规划（LLM 不可用或解析失败）"}


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", text or "")
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


async def plan_node_agent(node_type: str, idea: str, provider_id: str = "", slots: Optional[Dict[str, Any]] = None, extra_hint: str = "") -> Dict[str, Any]:
    """
    核心规划：自然语言需求 → {skill_id, provider_id, model, prompt, params, reasoning}
    """
    slots = slots or {}
    skills = SKILL_CATALOG.get(node_type, [])
    briefs = _providers_brief(node_type)
    # 若用户已手动绑定源，聚焦该源但保留换源权
    bound = next((b for b in briefs if b["id"] == provider_id), None)
    candidate_briefs = [bound] if (bound and provider_id) else briefs
    system = (
        "你是 AI 漫剧 Studio 的节点生成 Agent。用户给你一个画面/镜头/配音需求，你要：\n"
        f"1) 从技能目录选择最合适技能：{json.dumps(skills, ensure_ascii=False)}\n"
        f"2) 从候选生成源中选择最合适的源（若只给了一个源则必须使用它）：{json.dumps(candidate_briefs, ensure_ascii=False)[:6000]}\n"
        "3) 把用户需求改写为该源能吃的最终 prompt：图像=英文电影级画面描述；视频=中文运动/运镜描述；音频=纯台词文本(去掉说话人标注)\n"
        "4) 严格按所选源的 params_schema 组装 params（enum 值必须逐字来自 enum 列表；漫剧默认 9:16；未提及的参数留空用默认）\n"
        "5) 已提供的资产槽位会由系统自动注入，你不需要把它们写进 params\n"
        "只输出 JSON：{\"skill_id\":\"...\",\"provider_id\":\"...\",\"model\":\"...\",\"prompt\":\"...\",\"params\":{...},\"reasoning\":\"一句话中文说明你为什么这么选\"}"
    )
    user_payload = {
        "node_type": node_type,
        "idea": idea[:2000],
        "已挂载资产": {k: (v if not isinstance(v, list) else f"{len(v)}项") for k, v in slots.items() if v},
    }
    if extra_hint:
        user_payload["补充要求"] = extra_hint[:500]
    plan = None
    try:
        from app.pipelines.llm_service import llm_service
        raw = await llm_service.chat_completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}],
            temperature=0.3,
            max_tokens=1200,
        )
        plan = _extract_json(raw or "")
    except Exception as e:
        print(f"[AgentPlanner] LLM plan failed: {e}")
    if not plan or not isinstance(plan, dict) or not plan.get("prompt"):
        return _rule_plan(node_type, idea, provider_id, slots)
    # 护栏：源/skill/参数合法性
    valid_ids = {b["id"] for b in briefs}
    if plan.get("provider_id") not in valid_ids:
        plan["provider_id"] = provider_id if provider_id in valid_ids else (list(valid_ids)[0] if valid_ids else "")
    if plan.get("skill_id") not in {s["id"] for s in skills}:
        plan["skill_id"] = _rule_plan(node_type, idea, provider_id, slots)["skill_id"]
    ps = {}
    if bound and candidate_briefs and isinstance(candidate_briefs[0].get("params_schema"), dict):
        ps = candidate_briefs[0]["params_schema"]
    else:
        cb = next((b for b in briefs if b["id"] == plan.get("provider_id")), None)
        if cb and isinstance(cb.get("params_schema"), dict):
            ps = cb["params_schema"]
    clean_params: Dict[str, Any] = {}
    for k, v in (plan.get("params") or {}).items():
        if v in (None, "", {}):
            continue
        spec = ps.get(k) if isinstance(ps, dict) else None
        if isinstance(spec, dict):
            if spec.get("enum") and str(v) not in [str(x) for x in spec["enum"]]:
                continue
            if spec.get("min") is not None and isinstance(v, (int, float)) and v < spec["min"]:
                continue
            if spec.get("max") is not None and isinstance(v, (int, float)) and v > spec["max"]:
                continue
        clean_params[k] = v
    plan["params"] = clean_params
    plan.setdefault("model", "")
    plan.setdefault("reasoning", "")
    plan["planned_by"] = "llm"
    return plan
