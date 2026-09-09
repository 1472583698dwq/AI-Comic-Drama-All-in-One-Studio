# -*- coding: utf-8 -*-
"""
Agent业务意图路由 — 结合AI漫剧主链路的确定性Planner（无LLM，可单测）

主链：小说 -> Project{scenes/shots/characters} -> 角色定妆(three_views/voice)
     -> 单镜制作(机位/生图/视频/配音/对齐) -> 批量/一键成片 -> 画布编排 -> 剪映导出 -> 素材沉淀

意图6+2：
  script(编剧拆解) / character(角色定妆) / shot_single(单镜制作,默认) /
  batch_onekey(批量整集) / canvas(画布编排) / export(导出) / asset(素材复用) / debug(排障)
  + chat(纯问答兜底)

前端可先用同构规则做即时Plan预览，后端 /agent/plan/preview 做权威确认。
"""
from typing import Any, Dict, List, Optional
import re

INTENTS: Dict[str, Dict[str, Any]] = {
    "script": {
        "label": "编剧拆解",
        "keywords": ["小说", "拆解", "分镜", "剧本", "章节", "导入小说", "解析", "故事", "大纲"],
        "tools": ["split_novel_script"],
        "risk": "medium",
        "desc": "长文本 -> 角色表 + 场/镜结构",
    },
    "character": {
        "label": "角色定妆",
        "keywords": ["角色", "定妆", "三视图", "立绘", "人设", "声线", "音色", "试音", "形象"],
        "tools": ["generate_image", "generate_voice", "list_assets"],
        "risk": "medium",
        "desc": "角色卡 -> 三视图定妆 + 专属VoiceID试音",
    },
    "batch_onekey": {
        "label": "批量/一键成片",
        "keywords": ["一键", "整集", "全片", "批量", "全自动", "成片", "连发", "多集", "全部镜头"],
        "tools": ["split_novel_script", "generate_image", "generate_video", "generate_voice", "export_jianyin_draft"],
        "risk": "high",
        "desc": "整集流水线：定妆 -> 生图 -> 视频 -> 配音对齐 -> 剪映导出",
    },
    "canvas": {
        "label": "画布编排",
        "keywords": ["画布", "节点", "连线", "编排", "工作流", "dag", "批量生成", "首帧", "参考图"],
        "tools": ["canvas_query", "canvas_create_node", "canvas_connect", "canvas_execute"],
        "risk": "medium",
        "desc": "可视化DAG：建节点 -> 连线 -> 分范围执行(单节点/下游/全量)",
    },
    "export": {
        "label": "导出交付",
        "keywords": ["导出", "剪映", "capcut", "草稿", "时间线", "成片导出", "jianyin"],
        "tools": ["export_jianyin_draft"],
        "risk": "medium",
        "desc": "时间线聚合 -> 剪映草稿工程",
    },
    "asset": {
        "label": "素材复用",
        "keywords": ["素材", "找图", "场景", "道具", "参考", "底图", "预演", "白模"],
        "tools": ["list_assets", "get_asset"],
        "risk": "low",
        "desc": "素材库检索 -> 绑定到分镜/画布插槽",
    },
    "debug": {
        "label": "排障诊断",
        "keywords": ["状态", "健康", "连通", "报错", "失败", "超时", "工作流", "源", "provider", "为什么", "查错", "修"],
        "tools": ["list_image_providers", "list_voice_providers", "list_video_providers", "list_comfyui_workflows", "get_provider_code"],
        "risk": "low",
        "desc": "先查健康/槽位/代码，再给修复步骤",
    },
    "shot_single": {
        "label": "单镜制作",
        "keywords": ["生图", "重绘", "换图", "视频", "运镜", "推镜", "拉镜", "环绕", "配音", "台词", "机位", "3d", "导演", "特写", "当前镜", "本镜", "镜头"],
        "tools": ["director_3d_stage_plan", "generate_image", "generate_video", "generate_voice"],
        "risk": "medium",
        "desc": "针对当前激活镜：机位规划 -> 生图首帧 -> 视频 -> 配音对齐时长",
    },
}


def _hit(prompt: str, keywords: List[str]) -> int:
    p = (prompt or "").lower()
    s = 0
    for k in keywords:
        if k.lower() in p:
            # 长词加权，避免“图/视频”这种单字误伤
            s += 3 if len(k) >= 2 else 1
    return s


def detect_intent(prompt: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """规则路由：关键词打分 + 上下文修正。返回 {intent,label,confidence,risk,targets,reason}"""
    ctx = context or {}
    p = (prompt or "").strip()
    scores: Dict[str, int] = {k: _hit(p, v["keywords"]) for k, v in INTENTS.items()}

    # 上下文修正
    has_active_shot = bool((ctx.get("active_shot") or {}).get("id"))
    has_project = bool(ctx.get("project_id") or (ctx.get("project") or {}).get("id"))
    shots_n = 0
    try:
        proj = ctx.get("project") or {}
        shots_n = sum(len(sc.get("shots") or []) for sc in (proj.get("scenes") or []))
    except Exception:
        pass

    # 无项目 + 长文本(>200字) -> 极可能是小说拆解
    if not has_project and len(p) > 200:
        scores["script"] = scores.get("script", 0) + 6
    # 有激活镜 + 无明确批量词 -> 单镜加权
    if has_active_shot and scores.get("batch_onekey", 0) == 0 and scores.get("canvas", 0) == 0:
        scores["shot_single"] = scores.get("shot_single", 0) + 2
    # 明确批量词优先
    # (batch_onekey 已靠关键词命中，此处不额外加)

    best = max(scores.items(), key=lambda x: (x[1], x[0]))
    intent, score = best
    if score <= 0:
        intent = "chat"
        return {
            "intent": "chat", "label": "问答讲解",
            "confidence": "low", "risk": "low",
            "targets": _targets(ctx),
            "reason": "无业务关键词命中，走纯问答不调工具",
        }
    conf = "high" if score >= 6 else ("medium" if score >= 3 else "low")
    return {
        "intent": intent,
        "label": INTENTS[intent]["label"],
        "confidence": conf,
        "risk": INTENTS[intent]["risk"],
        "targets": _targets(ctx),
        "reason": f"命中关键词分{score}，上下文: 项目={'有' if has_project else '无'}/{shots_n}镜，激活镜={'有' if has_active_shot else '无'}",
        "shots_count": shots_n,
    }


def _targets(context: Dict[str, Any]) -> Dict[str, Any]:
    a = (context or {}).get("active_shot") or {}
    proj = (context or {}).get("project") or {}
    return {
        "project_id": (context or {}).get("project_id") or proj.get("id"),
        "project_title": (context or {}).get("project_title") or proj.get("title"),
        "active_shot_id": a.get("id"),
        "active_shot_index": a.get("shot_index"),
        "aspect_ratio": proj.get("aspect_ratio") or "9:16",
        "style_preset": proj.get("style_preset") or "donghua_xianxia",
    }


def build_plan(prompt: str, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """由意图生成可编辑步骤。步骤结构供前端PlanCard直接渲染。"""
    det = detect_intent(prompt, context or {})
    intent = det["intent"]
    t = det["targets"]
    shot_label = f"#{t.get('active_shot_index')}" if t.get("active_shot_index") is not None else "当前镜"
    steps: List[Dict[str, Any]] = []

    if intent == "script":
        steps = [
            {"id": "s1", "title": "小说拆解为场/镜+角色表", "tool": "split_novel_script", "args_preview": {"text": prompt[:60] + ("…" if len(prompt) > 60 else ""), "aspect_ratio": t.get("aspect_ratio")}, "risk": "medium", "est_s": 20, "target": "新项目"},
            {"id": "s2", "title": "载入为当前项目并自动绑角色", "tool": "local:load_project", "args_preview": {}, "risk": "low", "est_s": 1, "target": "分镜台"},
        ]
    elif intent == "character":
        steps = [
            {"id": "s1", "title": "三视图定妆(正/侧/3/4)", "tool": "generate_image", "args_preview": {"count": 3, "aspect_ratio": "1:1"}, "risk": "medium", "est_s": 60, "target": "角色库"},
            {"id": "s2", "title": "专属音色试音一句", "tool": "generate_voice", "args_preview": {"text": "试音台词"}, "risk": "low", "est_s": 10, "target": "角色库"},
            {"id": "s3", "title": "沉淀到素材库(角色分类)", "tool": "local:save_asset", "args_preview": {}, "risk": "low", "est_s": 1, "target": "素材库"},
        ]
    elif intent == "batch_onekey":
        steps = [
            {"id": "s1", "title": "角色定妆(三视图)", "tool": "generate_image", "args_preview": {"scope": "全角色"}, "risk": "medium", "est_s": 120, "target": "角色库"},
            {"id": "s2", "title": "批量生图(角色参考+相机意图)", "tool": "generate_image", "args_preview": {"scope": "全部分镜"}, "risk": "high", "est_s": 300, "target": "分镜台"},
            {"id": "s3", "title": "批量视频(首帧i2v+运镜)", "tool": "generate_video", "args_preview": {"mode": "i2v"}, "risk": "high", "est_s": 600, "target": "分镜台"},
            {"id": "s4", "title": "批量配音+对齐时长", "tool": "generate_voice", "args_preview": {}, "risk": "medium", "est_s": 180, "target": "时间线"},
            {"id": "s5", "title": "导出剪映草稿", "tool": "export_jianyin_draft", "args_preview": {}, "risk": "medium", "est_s": 10, "target": "剪映"},
        ]
    elif intent == "canvas":
        steps = [
            {"id": "s1", "title": "感知画布现状", "tool": "canvas_query", "args_preview": {}, "risk": "low", "est_s": 2, "target": "画布"},
            {"id": "s2", "title": "批量建生图/视频节点并连线", "tool": "canvas_create_node", "args_preview": {"batch": True}, "risk": "medium", "est_s": 5, "target": "画布"},
            {"id": "s3", "title": "按范围执行(单节点/下游/全量)", "tool": "canvas_execute", "args_preview": {"scope": "downstream"}, "risk": "medium", "est_s": 300, "target": "画布"},
        ]
    elif intent == "export":
        steps = [
            {"id": "s1", "title": "聚合时间线并导出剪映草稿", "tool": "export_jianyin_draft", "args_preview": {}, "risk": "medium", "est_s": 10, "target": "剪映"},
        ]
    elif intent == "asset":
        steps = [
            {"id": "s1", "title": "检索素材库(场景/道具/角色)", "tool": "list_assets", "args_preview": {"q": prompt[:30]}, "risk": "low", "est_s": 3, "target": "素材库"},
            {"id": "s2", "title": "绑定到分镜/画布插槽", "tool": "local:bind_asset", "args_preview": {"shot": shot_label}, "risk": "low", "est_s": 1, "target": shot_label},
        ]
    elif intent == "debug":
        steps = [
            {"id": "s1", "title": "查生成源健康与工作流槽位", "tool": "list_image_providers", "args_preview": {}, "risk": "low", "est_s": 5, "target": "生成源"},
            {"id": "s2", "title": "定位未暴露参数并给修复", "tool": "get_provider_code", "args_preview": {}, "risk": "low", "est_s": 3, "target": "生成源"},
        ]
    elif intent == "shot_single":
        steps = [
            {"id": "s1", "title": f"3D机位规划({shot_label})", "tool": "director_3d_stage_plan", "args_preview": {"shot": shot_label}, "risk": "low", "est_s": 3, "target": shot_label},
            {"id": "s2", "title": f"生图首帧({shot_label})", "tool": "generate_image", "args_preview": {"shot": shot_label, "aspect_ratio": t.get("aspect_ratio")}, "risk": "medium", "est_s": 25, "target": shot_label},
            {"id": "s3", "title": f"图生视频i2v({shot_label})", "tool": "generate_video", "args_preview": {"mode": "i2v", "shot": shot_label}, "risk": "medium", "est_s": 90, "target": shot_label},
            {"id": "s4", "title": f"配音并对齐时长({shot_label})", "tool": "generate_voice", "args_preview": {"shot": shot_label}, "risk": "medium", "est_s": 12, "target": shot_label},
        ]
    else:  # chat
        steps = []

    needs_confirm = det["risk"] in ("high", "medium") and len(steps) > 1
    # 单步低风险可直接跑
    if det["risk"] == "low":
        needs_confirm = False
    est_total = sum(s.get("est_s", 0) for s in steps)
    return {
        "intent": intent, "label": det["label"], "confidence": det["confidence"],
        "risk": det["risk"], "reason": det.get("reason", ""),
        "targets": t, "steps": steps,
        "needs_confirm": needs_confirm, "est_total_s": est_total,
        "autonomy_hint": "建议" if det["risk"] == "high" else ("草稿" if needs_confirm else "自动"),
    }
