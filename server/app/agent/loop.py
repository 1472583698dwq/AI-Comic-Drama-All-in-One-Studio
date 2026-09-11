# -*- coding: utf-8 -*-
"""
Agent模式共享内核 — 问答(chat) vs 执行(execute) 双模式 + 工具检索 + 预算

P0最小闭环，不重复造langchain_engine循环：
- chat模式：纯LLM单次问答，不调任何工具（省token/零副作用）
- execute模式：走现有ReAct循环（langchain_engine），但调用前可用search_tools
  缩减provider_*全量预载，解决Anthropic所说的tool定义爆context问题
- 预算：step cap / deadline / 去重 / observation截断，统一口径
"""
from typing import Any, Dict, List, Optional

AGENT_MODES = ("chat", "execute")

# 预算：问答0步，执行默认 200 步（旧值 12 会在大任务中途掐断；可用 AGENT_MAX_ITERATIONS 覆盖）
# 工具窗口：至少 20 分钟（1200s），长任务（视频/批量生成）不再被提前掐断
MODE_BUDGETS: Dict[str, Dict[str, Any]] = {
    "chat": {"max_steps": 0, "deadline_s": 1200, "allow_tools": False},
    "execute": {"max_steps": 200, "deadline_s": 1200, "allow_tools": True},
    # 计划模式：只读侦察 + 产出计划（工具由引擎绑定层硬门控）
    "plan": {"max_steps": 60, "deadline_s": 1200, "allow_tools": True, "readonly": True},
}

# 破坏性工具：执行前建议HITL确认（前端可据此弹确认，P0仅标记）
DESTRUCTIVE_TOOLS = {"delete_custom_provider", "shell_exec", "fs_file"}

# 核心常驻工具（检索不到时也保留，保证基础编排可用）
CORE_TOOLS = {
    "generate_image", "generate_voice", "generate_video",
    "split_novel_script", "director_3d_stage_plan", "export_jianyin_draft",
    "canvas_query", "canvas_create_node", "canvas_connect", "canvas_execute",
    "canvas_update_node", "list_assets", "search_tools",
}


def normalize_mode(mode: Optional[str]) -> str:
    m = (mode or "execute").strip().lower()
    return m if m in AGENT_MODES else "execute"


def truncate_observation(text: Any, limit: int = 1500) -> str:
    s = text if isinstance(text, str) else __import__("json").dumps(text, ensure_ascii=False, default=str)
    s = (s or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + f"…[截断{len(s) - limit}字]"


def search_tools(query: str, limit: int = 12) -> List[Dict[str, Any]]:
    """关键词检索工具子集：name/description/category加权，避免90个provider全量进prompt。

    返回 [{name, description, category, score}]，调用方再按CORE_TOOLS补齐。
    """
    from app.mcp.server import mcp_registry

    q = (query or "").strip().lower()
    tokens = [t for t in __import__("re").split(r"[\s,，。；;、/]+", q) if t]
    scored: List[Dict[str, Any]] = []
    for t in mcp_registry.get_all_tools():
        name = (t.name or "").lower()
        desc = (t.description or "").lower()
        cat = (t.category or "").lower()
        score = 0
        if not tokens:
            score = 1 if t.name in CORE_TOOLS else 0
        else:
            for tok in tokens:
                if tok in name:
                    score += 3
                if tok in desc:
                    score += 1
                if tok in cat:
                    score += 1
                # 中文意图直投
                if any(k in tok for k in ("图", "画", "image", "生图", "重绘")) and ("image" in name or "image" in desc):
                    score += 2
                if any(k in tok for k in ("音", "配音", "声", "voice", "tts")) and ("voice" in name or "audio" in name):
                    score += 2
                if any(k in tok for k in ("视频", "video", "运镜")) and ("video" in name):
                    score += 2
                if any(k in tok for k in ("小说", "拆", "剧本", "novel", "script")) and ("novel" in name or "script" in name):
                    score += 2
                if any(k in tok for k in ("画布", "节点", "连线", "canvas", "dag")) and ("canvas" in name):
                    score += 2
                if any(k in tok for k in ("机位", "导演", "3d", "运镜", "director")) and ("director" in name):
                    score += 2
                if any(k in tok for k in ("剪映", "导出", "export", "jianyin")) and ("export" in name or "jianyin" in name):
                    score += 2
                if any(k in tok for k in ("素材", "asset")) and ("asset" in name):
                    score += 2
                # 自定义代码节点 / 插件工具：关键词直投，避免自定义能力"存在但检索不到"
                if any(k in tok for k in ("自定义", "节点", "超分", "处理", "插件", "custom", "plugin")) and (
                    "customnode" in name or "plugin" in name or "custom" in desc
                ):
                    score += 3
                if any(k in tok for k in ("源", "provider", "生成源", "生成通道")) and ("provider_" in name):
                    score += 1
        if score > 0 or t.name in CORE_TOOLS:
            scored.append({"name": t.name, "description": t.description or "", "category": t.category or "", "score": score})
    scored.sort(key=lambda x: (-x["score"], x["name"]))
    # 去重 + 核心兜底 + 截断
    seen = set()
    out = []
    for s in scored:
        if s["name"] in seen:
            continue
        seen.add(s["name"])
        out.append(s)
        if len(out) >= max(8, min(limit, 20)):
            break
    return out
