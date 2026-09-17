# -*- coding: utf-8 -*-
"""
Agent 业务意图关键词表（仅保留给旧版 langchain 引擎的 trace 标注，不做任何执行决策）

注意：计划（Plan）不由本模块产出——计划模式由 runtime 的代码硬门控实现
（mode_policy.PLAN_READONLY_TOOLS → 绑定层 + 执行口双重白名单），模型在只读工具集内自主侦察并产出计划。
本模块的关键词判定仅用于旧版引擎的 trace 标注，不得用于生成步骤或兜底计划。

意图6+2：
  script(编剧拆解) / character(角色定妆) / shot_single(单镜制作) /
  batch_onekey(批量整集) / canvas(画布编排) / export(导出) / asset(素材复用) / debug(排障)
  + chat(纯问答兜底)
"""
from typing import Any, Dict, List, Optional

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
    """规则路由（仅供 trace 标注）：关键词打分 + 上下文修正。返回 {intent,label,confidence,risk,targets,reason}"""
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
