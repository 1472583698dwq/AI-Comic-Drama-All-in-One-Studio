# -*- coding: utf-8 -*-
"""
节点 Agent 规划器 — 用户自然语言需求 → skill 选择 → 生成源选择 → 异构参数组装
这是"每节点一Agent"的大脑：LLM 读候选生成源的真实 schema（params_schema/input_schema）
产出最终 prompt + 参数 JSON，随后统一交 provider_* Tool 执行。
LLM 不可用/解析失败时自动降级为规则式规划（绝不阻断生成）。
"""
import asyncio
import json
import re
from typing import Any, Dict, List, Optional

# 规划阶段 LLM 总预算（秒）：流式聚合→非流式→多 provider 降级链全程串行，
# 不设总预算时最坏 120s×N 级回退挂 3~5 分钟；规则规划本身可用，超时直接降级。
# REQ-toonflow-canvas FX-B 原先写死 30s，慢网关（规划请求系统提示长、max_tokens 1200）30s 内回不来、必定降级（E2E-2 B5）；
# 改为可配置：环境变量 / 配置 CANVAS_AGENT_PLAN_TIMEOUT_S（秒），缺省 90，合法范围 5~600。
LLM_PLAN_BUDGET_S = 90.0
_PLAN_BUDGET_ENV = "CANVAS_AGENT_PLAN_TIMEOUT_S"


def llm_plan_budget_s() -> float:
    """当前规划预算（每次调用时读取，改环境变量 / 配置无需重启）；非法值回落缺省 90s。"""
    import os
    raw = os.environ.get(_PLAN_BUDGET_ENV)
    if raw in (None, ""):
        try:
            from app.core.config import settings
            raw = getattr(settings, _PLAN_BUDGET_ENV, None)
        except Exception:
            raw = None
    try:
        val = float(raw) if raw not in (None, "") else LLM_PLAN_BUDGET_S
    except (TypeError, ValueError):
        val = LLM_PLAN_BUDGET_S
    if val != val or val <= 0:  # NaN / 非正数
        val = LLM_PLAN_BUDGET_S
    return max(5.0, min(val, 600.0))

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
    """候选生成源摘要：id/名称/模型/参数schema(裁剪) + v2 分组与人机分工"""
    briefs: List[Dict[str, Any]] = []
    try:
        if kind == "image":
            from app.providers.image.registry import image_registry as reg
        elif kind == "video":
            from app.providers.video.registry import video_registry as reg
        else:
            from app.providers.audio.registry import audio_registry as reg
        # v2 enrich helper（保证 LLM 看到 basic/advanced 分组与 auto/suggest/manual）
        try:
            from app.api.provider_routes import _enrich_params_schema, _default_params_schema
        except Exception:
            _enrich_params_schema = lambda s,k: s  # type: ignore
            _default_params_schema = lambda k: {}  # type: ignore
        for pid in reg.list_ids():
            try:
                obj = reg.get(pid)
                if obj is None:
                    continue
                info: Dict[str, Any] = {"id": pid}
                info["name"] = getattr(obj, "display_name", None) or pid
                models = []
                definition = getattr(obj, "definition", None)
                # 工作流/自定义 code 源：registry 对象本身无 definition，需走 custom_manager
                if definition is None and hasattr(reg, "is_custom") and reg.is_custom(pid):
                    try:
                        from app.providers.custom.manager import custom_provider_manager
                        definition = custom_provider_manager.get_definition(pid)
                    except Exception:
                        definition = None
                if definition is not None:
                    models = list(getattr(definition, "models", []) or [])[:8]
                    info["desc"] = (getattr(definition, "description", "") or "")[:80]
                    ps = getattr(definition, "params_schema", None) or {}
                    # v2：先 enrich 再裁剪，确保 x-* 完整
                    if isinstance(ps, dict) and ps.get("properties"):
                        try:
                            ps = _enrich_params_schema(ps, kind)  # type: ignore
                        except Exception:
                            pass
                    else:
                        try:
                            ps = _default_params_schema(kind)  # type: ignore
                            ps = _enrich_params_schema(ps, kind)  # type: ignore
                        except Exception:
                            ps = {}
                    props = (ps.get("properties") if isinstance(ps, dict) else {}) or {}
                    slim = {}
                    for k, v in list(props.items())[:16]:
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
                            # v2 标准：把分组与人机分工暴露给 LLM，便于其只建议 advanced/suggest 项
                            for xk in ("x-category", "x-visibility", "x-agent", "x-priority", "title", "description"):
                                if xk in v:
                                    entry[xk] = v[xk]
                        slim[k] = entry
                    info["params_schema"] = slim
                    ischem = getattr(definition, "input_schema", None) or {}
                    info["input_keys"] = list(((ischem.get("properties") if isinstance(ischem, dict) else {}) or {}).keys())
                    # 详细插槽摘要：几张图片/几段音频，供 LLM 精准选 skill
                    try:
                        props = (ischem.get("properties") if isinstance(ischem, dict) else {}) or {}
                        req = set(ischem.get("required", []) if isinstance(ischem, dict) else [])
                        brief_slots = []
                        for k, v in props.items():
                            if not isinstance(v, dict):
                                continue
                            # 仅 uri 类资产
                            is_arr = v.get("type") == "array"
                            fmt = v.get("format") or (v.get("items", {}) or {}).get("format", "")
                            if fmt != "uri" and not is_arr:
                                continue
                            if fmt != "uri" and is_arr and (v.get("items", {}) or {}).get("format") != "uri":
                                # 检查 x-handle
                                if "image" not in str(v.get("x-handle", "")).lower() and "audio" not in str(v.get("x-handle", "")).lower() and "video" not in str(v.get("x-handle", "")).lower():
                                    continue
                            maxc = v.get("maxItems") or (v.get("items", {}) or {}).get("maxItems") or (1 if not is_arr else 4)
                            minc = v.get("minItems") or (v.get("items", {}) or {}).get("minItems") or (1 if k in req else 0)
                            brief_slots.append({"key": k, "max": maxc, "min": minc, "required": k in req, "type": "image" if "image" in k.lower() or "first" in k.lower() or "reference" in k.lower() else ("audio" if "audio" in k.lower() else "video")})
                        if brief_slots:
                            info["slots"] = brief_slots
                    except Exception:
                        pass
                else:
                    try:
                        cap = obj.get_capabilities() if hasattr(obj, "get_capabilities") else {}
                        models = list(cap.get("models", []) or [])[:8]
                        raw = cap.get("params_schema") or {}
                        # v2：内置源也按 x-* 补全
                        if isinstance(raw, dict) and raw.get("properties"):
                            try:
                                raw = _enrich_params_schema(raw, kind)  # type: ignore
                            except Exception as e:
                                print(f"[AgentPlanner] enrich builtin {pid} failed: {e}")
                        else:
                            try:
                                raw = _default_params_schema(kind)  # type: ignore
                                raw = _enrich_params_schema(raw, kind)  # type: ignore
                            except Exception as e:
                                print(f"[AgentPlanner] default enrich builtin {pid} failed: {e}")
                                raw = {}
                        # 裁剪为 slim（保留 x-*）
                        slim2 = {}
                        for k2, v2 in list(((raw.get("properties") if isinstance(raw, dict) else {}) or {}).items())[:16]:
                            e2: Dict[str, Any] = {}
                            if isinstance(v2, dict):
                                if v2.get("enum"): e2["enum"] = [str(x) for x in v2["enum"]][:12]
                                if v2.get("default") is not None: e2["default"] = v2.get("default")
                                if v2.get("minimum") is not None: e2["min"] = v2.get("minimum")
                                if v2.get("maximum") is not None: e2["max"] = v2.get("maximum")
                                for xk in ("x-category", "x-visibility", "x-agent", "x-priority", "title", "description"):
                                    if xk in v2: e2[xk] = v2[xk]
                            slim2[k2] = e2
                        info["params_schema"] = slim2
                    except Exception as e:
                        print(f"[AgentPlanner] builtin brief {pid} outer failed: {e}")
                        pass
                    # 兜底：若仍无 params_schema，强制补默认
                    if "params_schema" not in info or not info["params_schema"]:
                        try:
                            _def = _default_params_schema(kind)  # type: ignore
                            _def = _enrich_params_schema(_def, kind)  # type: ignore
                            tmp = {}
                            for k2, v2 in list((_def.get("properties") or {}).items())[:8]:
                                e2 = {}
                                if isinstance(v2, dict):
                                    if v2.get("enum"): e2["enum"] = [str(x) for x in v2["enum"]][:8]
                                    if v2.get("default") is not None: e2["default"] = v2.get("default")
                                    for xk in ("x-category","x-visibility","x-agent","x-priority"):
                                        if xk in v2: e2[xk]=v2[xk]
                                tmp[k2]=e2
                            info["params_schema"]=tmp
                        except Exception:
                            info["params_schema"]={}
                if models:
                    info["models"] = models
                briefs.append(info)
            except Exception:
                continue
    except Exception as e:
        print(f"[AgentPlanner] providers brief failed: {e}")
    return briefs


def _rule_plan(node_type: str, idea: str, provider_id: str, slots: Dict[str, Any], forced_skill: str = "") -> Dict[str, Any]:
    """无 LLM 时的规则降级规划（支持多图/多音频计数）"""
    # 计数变量先初始化：forced_skill 分支不走下面的统计，return 的 reasoning 仍会引用（P3-1 回归修复 UnboundLocalError）
    ref_count = 0
    audio_count = 0
    has_first = False
    if not provider_id:
        briefs = _providers_brief(node_type)
        provider_id = briefs[0]["id"] if briefs else ""
    if forced_skill and forced_skill in {s["id"] for s in SKILL_CATALOG.get(node_type, [])}:
        skill = forced_skill
    else:
        # 支持多文件计数
        refs = slots.get("reference_images") or slots.get("reference") or []
        ref_count = len(refs) if isinstance(refs, list) else (1 if refs else 0)
        has_ref = ref_count > 0
        has_first = bool(slots.get("first_frame"))
        has_last = bool(slots.get("last_frame"))
        # 音频可能是单段或多段
        audio_raw = slots.get("ref_audio") or slots.get("reference_audio") or []
        audio_count = len(audio_raw) if isinstance(audio_raw, list) else (1 if audio_raw else 0)
        has_audio = audio_count > 0
        if node_type == "image":
            # 多图参考也走 image_reference
            skill = "image_reference" if has_ref else "text_to_image"
        elif node_type == "video":
            if has_first and has_last:
                skill = "first_last_frame"
            elif has_first:
                skill = "first_last_frame"
            elif has_ref:
                # 1 张或多张参考图都走全能参考
                skill = "all_round_reference"
            else:
                skill = "text_to_video"
        else:
            skill = "audio_clone" if has_audio else "tts_voice"
    return {"skill_id": skill, "provider_id": provider_id, "model": "", "prompt": idea, "params": {}, "reasoning": f"规则式规划（LLM 不可用，已挂载:首帧{int(has_first)} 张/参考{ref_count if 'ref_count' in locals() else 0}张/音频{audio_count if 'audio_count' in locals() else 0}段）"}


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


async def plan_node_agent(node_type: str, idea: str, provider_id: str = "", slots: Optional[Dict[str, Any]] = None, extra_hint: str = "", forced_skill: str = "") -> Dict[str, Any]:
    """
    核心规划：自然语言需求 → {skill_id, provider_id, model, prompt, params, reasoning}
    forced_skill: 用户在控制台顶部显式选择的 skill，Agent 必须按此 skill 风格润色提示词
    """
    slots = slots or {}
    skills = SKILL_CATALOG.get(node_type, [])
    briefs = _providers_brief(node_type)
    # 若用户已手动绑定源，聚焦该源但保留换源权
    bound = next((b for b in briefs if b["id"] == provider_id), None)
    candidate_briefs = [bound] if (bound and provider_id) else briefs
    forced_note = f"\n用户已指定技能为 {forced_skill}，你必须使用该 skill 并按其描述风格润色提示词，不要自行切换。" if forced_skill and forced_skill in {s["id"] for s in skills} else ""
    system = (
        "你是 AI 漫剧 Studio 的节点生成 Agent（v2 标准）。用户给你一个画面/镜头/配音需求，你要：\n"
        f"1) 从技能目录选择最合适技能：{json.dumps(skills, ensure_ascii=False)}" + (f"（{forced_note}）" if forced_note else "") + "\n"
        f"2) 从候选生成源中选择最合适的源（若只给了一个源则必须使用它）：{json.dumps(candidate_briefs, ensure_ascii=False)[:6000]}\n"
        "3) 把用户需求改写为该源能吃的最终 prompt：图像=英文电影级画面描述；视频=中文运动/运镜描述；音频=纯台词文本(去掉说话人标注)\n"
        "4) 严格按所选源的 params_schema 组装 params（enum 值必须逐字来自 enum 列表；每个参数含 x-visibility:basic/advanced/hidden 与 x-agent:auto/suggest/manual — basic 常显可自动填，advanced 需点⚙仅建议，hidden不渲染，manual绝不代填如 seed；漫剧默认 9:16；未提及的 basic/auto 项可按项目画幅自动填，advanced/suggest 仅在用户未显式指定时才建议）\n"
        "5) 已提供的资产槽位(input_schema 已声明首帧/参考图/参考音频)会由系统自动注入，你不需要把它们写进 params，也不要把文件路径塞进 params_schema\n"
        "只输出 JSON：{\"skill_id\":\"...\",\"provider_id\":\"...\",\"model\":\"...\",\"prompt\":\"...\",\"params\":{...},\"reasoning\":\"一句话中文说明你为什么这么选（需提及所用分组与人机分工判断）\"}"
    )
    user_payload = {
        "node_type": node_type,
        "idea": idea[:2000],
        "已挂载资产": {k: (v if not isinstance(v, list) else f"{len(v)}项") for k, v in slots.items() if v},
    }
    if extra_hint:
        user_payload["补充要求"] = extra_hint[:500]
    plan = None
    budget = llm_plan_budget_s()
    try:
        from app.pipelines.llm_service import llm_service
        # 总预算护栏：LLM 降级链（流式→非流式→多 provider）全程串行，
        # 超过预算直接放弃 LLM 润色，走规则规划（P3-1）
        raw = await asyncio.wait_for(
            llm_service.chat_completion(
                messages=[{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}],
                temperature=0.3,
                max_tokens=1200,
                timeout=budget,
            ),
            timeout=budget + 3.0,
        )
        plan = _extract_json(raw or "")
    except Exception as e:
        print(f"[AgentPlanner] LLM plan failed（预算 {budget:.0f}s，可用 {_PLAN_BUDGET_ENV} 调整；超时/失败自动降级规则规划）: {str(e) or type(e).__name__}")
    if not plan or not isinstance(plan, dict) or not plan.get("prompt"):
        rule = _rule_plan(node_type, idea, provider_id, slots, forced_skill)
        rule["plan_source"] = "rule"
        rule["reasoning"] = f"{rule.get('reasoning') or ''}（LLM 不可用或超时，已降级规则规划）".strip()
        return rule
    plan["plan_source"] = "llm"
    # 强制 skill 优先：用户显式选择的不允许被 LLM 覆盖
    if forced_skill and forced_skill in {s["id"] for s in skills}:
        plan["skill_id"] = forced_skill
    # 护栏：源/skill/参数合法性
    valid_ids = {b["id"] for b in briefs}
    if plan.get("provider_id") not in valid_ids:
        plan["provider_id"] = provider_id if provider_id in valid_ids else (list(valid_ids)[0] if valid_ids else "")
    if plan.get("skill_id") not in {s["id"] for s in skills}:
        plan["skill_id"] = _rule_plan(node_type, idea, provider_id, slots, forced_skill)["skill_id"]
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
        # x-agent:manual 项（seed/api_key/锁定值）Agent 绝不代填——分工由接口 schema 声明
        if isinstance(spec, dict) and spec.get("x-agent") == "manual":
            continue
        if isinstance(spec, dict) and spec.get("enum") and isinstance(v, str) and k in ("resolution", "aspect_ratio"):
            # 归一化竖/横等后缀：720P竖 → 720P，9:16竖 → 9:16
            norm = str(v).replace("竖", "").replace("横", "").strip()
            enum_strs = [str(x) for x in spec["enum"]]
            if norm not in enum_strs and str(v) not in enum_strs:
                # 前缀/包含匹配（如 720 → 720P）
                hit = next((opt for opt in enum_strs if opt.lower() == norm.lower()), None)
                if not hit:
                    hit = next((opt for opt in enum_strs if norm.lower() in opt.lower() or opt.lower().split(" ")[0] == norm.lower()), None)
                if hit:
                    v = hit
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
