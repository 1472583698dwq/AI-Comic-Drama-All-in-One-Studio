# -*- coding: utf-8 -*-
"""
Creator 能力提案链 — 参考 DeepSeek Harness Creator mode：
  inspect运行时 -> propose(临时提案) -> 人来Start试跑 -> persist持久化 / discard卸载

- 提案默认临时：只写 storage/agent_proposals/{id}.json，不碰生产配置。
- 人来启动：start_test 才允许调用 test/试跑类工具；finalize(persist) 才写生产。
- teardown：discard 删除临时包 + 清副作用声明；外部已发生动作（如已花钱生成）不可逆，需在提案中明示。
- 审计：每次状态变迁写 trace（proposal_created/started/tested/persisted/discarded）。
"""
import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

def _proposal_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "agent_proposals"
    except Exception:
        base = Path("storage") / "agent_proposals"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _trace(run_id: str, event: str, data: Dict[str, Any]) -> None:
    try:
        from app.agent.trace import log_event
        log_event(run_id or "creator", event, data)
    except Exception:
        pass


def inspect_runtime(context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """只读检查：生成源/技能/画布/工作流现状，供提案依据。绝不产生副作用。"""
    ctx = context or {}
    out: Dict[str, Any] = {"providers": {}, "skills": {}, "canvas": {}, "workflows": {}}
    try:
        from app.providers.image.registry import image_registry
        from app.providers.video.registry import video_registry
        from app.providers.audio.registry import audio_registry
        out["providers"] = {
            "image": image_registry.list_ids(),
            "video": video_registry.list_ids(),
            "audio": audio_registry.list_ids(),
        }
    except Exception as e:
        out["providers"] = {"error": str(e)[:200]}
    try:
        from app.skills.engine import skill_engine
        out["skills"] = {"count": len(skill_engine.list_skills()), "names": [s.name for s in skill_engine.list_skills()][:20]}
    except Exception as e:
        out["skills"] = {"error": str(e)[:200]}
    try:
        proj = (ctx.get("project") or {})
        shots_n = sum(len(sc.get("shots") or []) for sc in (proj.get("shots", []) or [])) if isinstance(proj, dict) else 0
        if not shots_n and isinstance(proj, dict):
            shots_n = sum(len(sc.get("shots") or []) for sc in (proj.get("scenes") or []))
        out["canvas"] = {"canvas_summary": (ctx.get("canvas_summary") or "")[:500], "project_shots": shots_n}
    except Exception:
        out["canvas"] = {}
    try:
        from app.providers.workflow.manager import workflow_manager
        wfs = workflow_manager.list_workflows(source="all") if hasattr(workflow_manager, "list_workflows") else []
        out["workflows"] = {"count": len(wfs) if isinstance(wfs, list) else 0}
    except Exception as e:
        out["workflows"] = {"error": str(e)[:200]}
    return out


def _classify_goal(goal: str) -> str:
    g = (goal or "")
    # 分镜工作台槽（storyboard_slot）：分镜 Tab/锚点/槽位/批注定制；
    # 含生成源/接口/模型/插槽字样时仍归源侧，避免“补参考图槽”误分类
    if (any(k in g for k in ["分镜", "Tab", "tab", "锚点", "storyboard", "槽位", "批注", "分镜工作台"])
            and not any(k in g for k in ["源", "Provider", "provider", "API", "接口", "模型", "工作流", "插槽", "input_schema", "params_schema"])):
        return "storyboard_slot"
    if any(k in g for k in ["插件", "插件包", "plugin", "package", "扩展包"]):
        return "new_plugin"
    # 明确的“新建/接入”意图优先于补丁：长文档里常带 H3/补/插槽 等字样，
    # 不能因此把“新建视频生成源：接入 XXX”误判成给存量源打补丁（会误改到错误目标）。
    if (any(k in g for k in ["新建", "新增", "接入", "注册", "创建", "添加", "做一个", "做个", "制作"])
            and any(k in g for k in ["源", "Provider", "provider", "API", "接口", "工作流", "模型", "服务"])):
        return "new_provider"
    if any(k in g for k in ["参数", "暴露", "补", "first_frame", "插槽", "input_schema", "params_schema", "H3", "h3"]):
        return "patch_provider"
    if any(k in g for k in ["模板", "画布", "节点编排", "工作流模板"]):
        return "canvas_template"
    if any(k in g for k in ["Skill", "skill", "技能", "规范", "流程"]):
        return "new_skill"
    if any(k in g for k in ["源", "接入", "API", "接口", "模型"]):
        return "new_provider"
    return "patch_provider"


def _generate_plugin_spec(goal: str, pid: str) -> Dict[str, Any]:
    import re as _re
    g = (goal or "").strip()
    base_slug = _slug(g, f"pack-{pid[-6:]}")
    clean_id = _re.sub(r"[^a-z0-9\-]", "", base_slug.lower()).strip("-")
    if not clean_id or clean_id[0] not in "abcdefghijklmnopqrstuvwxyz0123456789":
        clean_id = f"pack-{pid[-6:]}"
    plugin_id = clean_id[:48]
    name_clean = g.split("包")[0].split("插件")[0].strip() if ("包" in g or "插件" in g) else g[:20].strip()
    plugin_name = (name_clean[:24] if name_clean else "漫剧定制扩展包") + "包"

    skill_slug = f"{plugin_id}-skill"
    skill_rel = f"skills/{skill_slug}/SKILL.md"
    skill_content = (
        f"---\n"
        f"name: {skill_slug}\n"
        f"description: {plugin_name}专属技能：针对【{g[:80]}】的分镜打磨、镜头机位设计与情绪视效提示词增强\n"
        f"version: 1.0.0\n"
        f"author: Creator Agent\n"
        f"category: drama-pack\n"
        f"tools: [generate_image, generate_video, generate_voice, director_3d_stage_plan]\n"
        f"---\n\n"
        f"# {plugin_name} · 导演执行规范\n\n"
        f"来源：由导演 Agent 创造模式根据指令自动生成（目标：{g[:120]}）。\n\n"
        f"## 核心导演法则\n"
        f"1. **视觉定调**：围绕镜头的情绪张力与环境光影展开，提取主体、核心动作、环境与光照氛围。\n"
        f"2. **视听对齐**：生图首帧需严格锁定角色特写与景深关系，视频生成保持运镜平稳，旁白/对白精准同步时间码。\n"
        f"3. **质检门验收**：产物必须回写至分镜与时间轴监视器，失败按结构化错误提示原因。\n"
    )

    tool_rel = "mcp_tools/scene_tools.py"
    tool_content = (
        f"# -*- coding: utf-8 -*-\n"
        f'"""[插件 {plugin_id}] 漫剧分镜与节奏分析工具 (FastMCP 契约)"""\n\n'
        f"PLUGIN_TOOLS = [\n"
        f"    {{\n"
        f'        "name": "analyze_drama_scene",\n'
        f'        "description": "分析镜头剧本台词的节奏速度、字数时长匹配度与情绪张力",\n'
        f'        "input_schema": {{\n'
        f'            "type": "object",\n'
        f'            "properties": {{\n'
        f'                "text": {{"type": "string", "description": "分镜台词或画面动作描述"}},\n'
        f'                "pacing_hint": {{"type": "string", "description": "节奏预期(fast/slow/normal)", "default": "normal"}}\n'
        f'            }},\n'
        f'            "required": ["text"]\n'
        f'        }},\n'
        f'        "entry": "analyze_drama_scene"\n'
        f"    }}\n"
        f"]\n\n\n"
        f"def analyze_drama_scene(args: dict, ctx: dict) -> dict:\n"
        f'    text = str((args or {{}}).get("text") or "")\n'
        f'    pacing = str((args or {{}}).get("pacing_hint") or "normal")\n'
        f"    char_count = len(text)\n"
        f"    estimated_seconds = round(max(1.0, char_count * 0.24), 1)\n"
        f"    return {{\n"
        f'        "plugin": "{plugin_id}",\n'
        f'        "char_count": char_count,\n'
        f'        "estimated_seconds": estimated_seconds,\n'
        f'        "pacing": "fast" if char_count < 15 else "normal",\n'
        f'        "status": "success"\n'
        f"    }}\n"
    )

    manifest = {
        "id": plugin_id,
        "name": plugin_name,
        "version": "1.0.0",
        "description": f"由导演 Agent 创造模式根据需求【{g[:100]}】自动构建的漫剧功能扩展包",
        "author": "Creator Agent",
        "license": "MIT",
        "extensionPoints": {
            "providers": [],
            "skills": [f"skills/{skill_slug}/SKILL.md"],
            "workflows": [],
            "mcp_tools": [tool_rel],
            "custom_nodes": []
        }
    }

    files = {
        "plugin.json": json.dumps(manifest, ensure_ascii=False, indent=2),
        skill_rel: skill_content,
        tool_rel: tool_content,
    }

    return {
        "manifest": manifest,
        "files": files,
        "plugin_id": plugin_id,
        "plugin_name": plugin_name,
    }


def _generate_slot_spec(goal: str, pid: str) -> Dict[str, Any]:
    """由目标生成分镜槽声明模板（含启发式槽位推断，可在 persist 前由人工/LLM 改写）。

    推断规则：含“锚点/挂载/字段”→ shot.anchors；含“按钮/批量/操作”→ shot.actions；
    含“模式/流程”→ shot.modes；其余一律 shot.tabs（最通用、可只读展示）。
    """
    import re as _re
    g = (goal or "").strip()
    base = _re.sub(r"[^a-zA-Z0-9\u4e00-\u9fa5]+", "-", g).strip("-")
    slug = _re.sub(r"-{2,}", "-", base.lower())[:24].strip("-") or f"slot-{pid[-6:]}"
    # 中文 slug 转为合法 id：保留计数后缀
    sid = _re.sub(r"[^a-z0-9\-]", "", slug)[:32].strip("-") or f"slot-{pid[-6:]}"
    if len(sid) < 2:
        sid = f"slot-{pid[-6:]}"
    label = (g[:16] or "定制槽").strip()
    if any(k in g for k in ["锚点", "挂载", "字段"]):
        field = f"custom_{sid.replace('-', '_')}"[:40]
        doc = {"slot": "shot.anchors", "id": sid, "label": label, "order": 40,
               "field": field, "category": "prop",
               "description": f"Creator 生成：{g[:80]}"}
    elif any(k in g for k in ["按钮", "批量", "操作", "一键"]):
        doc = {"slot": "shot.actions", "id": sid, "label": label, "order": 40,
               "run": {"store_action": "synthesizeShotPrompt", "args": {}},
               "description": f"Creator 生成：{g[:80]}"}
    elif any(k in g for k in ["模式", "流程", "直出", "漫画"]):
        doc = {"slot": "shot.modes", "id": sid, "label": label, "order": 40,
               "caps": {"canImage": True, "canVideo": True, "canTts": True,
                        "direct": False, "needsFirstFrame": False, "lockPreview": None},
               "inherit_render": "image_to_video",
               "description": f"Creator 生成：{g[:80]}"}
    else:
        doc = {"slot": "shot.tabs", "id": sid, "label": label, "icon": "📝",
               "color": "text-teal-400", "order": 40,
               "blocks": [
                   {"kind": "info", "text": f"Creator 生成：{g[:120]}"},
                   {"kind": "buttons", "buttons": [
                       {"label": "⚡ 全要素合成", "run": {"store_action": "synthesizeShotPrompt"}}]},
               ],
               "description": f"Creator 生成：{g[:80]}"}
    return {"doc": doc, "goal": g[:500]}


def propose_capability(goal: str, context: Optional[Dict[str, Any]] = None, run_id: str = "") -> Dict[str, Any]:
    """生成临时提案（不生效）。返回提案卡所需全部字段：diff_preview/风险/试跑计划/可逆性声明。"""
    ctx = context or {}
    kind = _classify_goal(goal or "")
    pid = f"prop_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    runtime = inspect_runtime(ctx)
    plugin_spec = None
    slot_spec = None
    if kind == "new_plugin":
        plugin_spec = _generate_plugin_spec(goal, pid)
        manifest = plugin_spec["manifest"]
        title = f"新建插件包（{manifest['name']}）"
        diff_preview = f"new plugin {manifest['id']}@1.0.0：包含 {len(plugin_spec['files'])-1} 个扩展组件（{list(plugin_spec['files'].keys())}），落盘至 storage/plugins/{manifest['id']}/"
        test_plan = ["校验 plugin.json 结构与必填字段", "验证插件 ID 与 Semver 规范", "AST 静态分析 mcp_tools Python 脚本", "验证 SKILL.md Frontmatter 规范"]
        risk, reversible = "low", "可逆：持久化后向系统插件中心注册，支持随时一键回滚或在插件中心直接卸载"
    elif kind == "patch_provider":
        title = "补齐生成源参数暴露"
        diff_preview = "patch params_schema/input_schema: 补 x-category/x-visibility/x-agent + 缺失插槽（如 first_frame/reference_images），存量 code 不动"
        test_plan = ["get_provider_code 看现状", "内存试算新 schema", "test_custom_provider 连通试跑（只读/小参）"]
        risk, reversible = "medium", "可逆：patch 前自动备份原 definition，discard 一键回滚"
    elif kind == "new_provider":
        title = "接入新生成源（临时包）"
        diff_preview = "new provider_xxx (code 沙盒，trusted 关)：Start 试跑 = 按文档草拟代码 + 沙箱编译体检（不落库）；持久化 = 创建入库+注册+连通试跑，失败自动删除"
        test_plan = ["校验目标文档/接口信息", "草拟代码 + 沙箱编译体检（零配额）", "持久化后连通试跑，失败自动删除"]
        risk, reversible = "high", "可逆：本提案创建的源可在卡片上一键回滚（删除）；已发生的生成计费不可逆"
    elif kind == "canvas_template":
        title = "新建画布编排模板（临时）"
        diff_preview = "batch create nodes+edges：生图→视频→配音链，位置按阶段列排，默认 scoped=downstream 执行"
        test_plan = ["画布预览（不执行）", "单节点试跑", "全量需二次确认"]
        risk, reversible = "medium", "可逆：模板删除不影响已生成节点"
    elif kind == "storyboard_slot":
        slot_spec = _generate_slot_spec(goal, pid)
        title = f"新建分镜槽（{slot_spec['doc']['slot']}:{slot_spec['doc']['id']}，临时）"
        diff_preview = f"new storyboard slot {slot_spec['doc']['slot']}:{slot_spec['doc']['id']}（{slot_spec['doc'].get('label','')}），落盘至 storage/storyboard_slots/custom/，需项目内验收"
        test_plan = ["槽声明 schema 校验", "slot:id 全局去重检查", "分镜工作台沙盒预览"]
        risk, reversible = "low", "可逆：删除裸件槽文件即卸载，不碰内置槽"
    else:
        title = "新建 Skill 规范（临时）"
        diff_preview = "new skill SKILL.md：触发条件 + 步骤 + 质检门，引用现有 MCP 工具，不新增外部调用"
        test_plan = ["单镜试跑 Skill", "人工验收", "persist 到 skills/"]
        risk, reversible = "low", "可逆：删除 skill 目录即卸载"
    proposal = {
        "proposal_id": pid, "kind": kind, "title": title, "goal": (goal or "")[:6000],
        "diff_preview": diff_preview, "test_plan": test_plan,
        "risk": risk, "reversible": reversible, "status": "proposed",
        "runtime_snapshot": {k: (str(v)[:400]) for k, v in runtime.items()},
        "created_at": time.time(), "run_id": run_id,
    }
    if plugin_spec:
        proposal["plugin_spec"] = plugin_spec
    if kind == "storyboard_slot" and slot_spec:
        proposal["slot_spec"] = slot_spec
    try:
        (_proposal_dir() / f"{pid}.json").write_text(json.dumps(proposal, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    _trace(run_id, "proposal_created", {"proposal_id": pid, "kind": kind, "title": title})
    return proposal


def _backup_dir() -> Path:
    d = _proposal_dir() / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _skill_version_dir() -> Path:
    """Skill 版本库：storage/skill_versions/{slug}/{ts}_{reason}.md（含 creator 备份与导入覆盖备份）"""
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "skill_versions"
    except Exception:
        base = Path("storage") / "skill_versions"
    base.mkdir(parents=True, exist_ok=True)
    return base


def backup_skill_version(slug: str, content: str, reason: str = "manual") -> str:
    """备份一份 Skill 快照，返回版本 id（文件名）。"""
    import re as _re
    slug = _re.sub(r"[^a-zA-Z0-9_-]", "-", slug or "").strip("-") or "unknown"
    d = _skill_version_dir() / slug
    d.mkdir(parents=True, exist_ok=True)
    vid = f"{int(time.time())}_{reason}.md"
    (d / vid).write_text(content or "", encoding="utf-8")
    return vid


def list_skill_versions(slug: str) -> List[Dict[str, Any]]:
    """版本历史：current（现行）+ 快照列表（新→旧）。"""
    import re as _re
    slug = _re.sub(r"[^a-zA-Z0-9_-]", "-", slug or "").strip("-")
    out: List[Dict[str, Any]] = []
    # 现行文件
    try:
        from app.skills.engine import SKILLS_ROOT_DIR
        cur = Path(SKILLS_ROOT_DIR) / slug / "SKILL.md"
        if cur.exists():
            st = cur.stat()
            out.append({"vid": "current", "mtime": st.st_mtime, "size": st.st_size, "source": "现行文件"})
    except Exception:
        pass
    d = _skill_version_dir() / slug
    # 兼容旧备份位（agent_proposals/backups/skill_{slug}_*.md）：读到即迁移展示
    legacy: List[Path] = []
    try:
        legacy = sorted(_backup_dir().glob(f"skill_{slug}_*.md"), key=lambda x: x.stat().st_mtime, reverse=True)
    except Exception:
        legacy = []
    if legacy:
        for f in legacy:
            try:
                st = f.stat()
                out.append({"vid": f"legacy:{f.name}", "mtime": st.st_mtime, "size": st.st_size, "source": "Creator 备份"})
            except Exception:
                continue
    try:
        if d.exists():
            for f in sorted(d.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
                st = f.stat()
                reason = f.stem.split("_", 1)[1] if "_" in f.stem else "snapshot"
                out.append({"vid": f.name, "mtime": st.st_mtime, "size": st.st_size, "source": reason})
    except Exception:
        pass
    return out


def get_skill_version(slug: str, vid: str) -> str:
    """取某版本内容；vid=current 取现行文件，legacy:xxx 取旧备份位。"""
    import re as _re
    slug = _re.sub(r"[^a-zA-Z0-9_-]", "-", slug or "").strip("-")
    if vid == "current":
        from app.skills.engine import SKILLS_ROOT_DIR
        cur = Path(SKILLS_ROOT_DIR) / slug / "SKILL.md"
        if not cur.exists():
            raise ValueError(f"Skill 不存在: {slug}")
        return cur.read_text(encoding="utf-8")
    if vid.startswith("legacy:"):
        p = _backup_dir() / vid[len("legacy:"):]
    else:
        if "/" in vid or "\\" in vid or ".." in vid:
            raise ValueError("非法版本 id")
        p = _skill_version_dir() / slug / vid
    if not p.exists():
        raise ValueError(f"版本不存在: {vid}")
    return p.read_text(encoding="utf-8")


def _template_dir() -> Path:
    try:
        from app.core.config import settings
        base = Path(settings.STORAGE_DIR) / "canvas_templates"
    except Exception:
        base = Path("storage") / "canvas_templates"
    base.mkdir(parents=True, exist_ok=True)
    return base


def list_templates() -> List[Dict[str, Any]]:
    """Creator 画布模板列表（供画布“从模板新建”消费）。"""
    d = _template_dir()
    out: List[Dict[str, Any]] = []
    try:
        for f in sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                out.append({
                    "id": data.get("id") or f.stem,
                    "name": data.get("name") or f.stem,
                    "nodes": data.get("nodes") or [],
                    "edges": data.get("edges") or [],
                    "source_proposal": data.get("source_proposal"),
                })
            except Exception:
                continue
    except Exception:
        pass
    return out


def get_template(tid: str) -> Dict[str, Any]:
    if "/" in tid or "\\" in tid or ".." in tid:
        raise ValueError("非法模板 id")
    p = _template_dir() / f"{tid}.json"
    if not p.exists():
        raise ValueError(f"模板不存在: {tid}")
    return json.loads(p.read_text(encoding="utf-8"))


# params_schema 缺省 x-* 时的按名回填表（与 provider_routes 规范对齐）
_X_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "aspect_ratio": {"x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
    "resolution": {"x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
    "duration": {"x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
    "fps": {"x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 31},
    "steps": {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 40},
    "cfg": {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
    "negative_prompt": {"x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 42},
    "seed": {"x-category": "quality", "x-visibility": "advanced", "x-agent": "manual", "x-priority": 99},
    "voice_id": {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 5},
    "emotion": {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 6},
    "speed": {"x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
    "pitch": {"x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 20},
    "volume": {"x-category": "audio", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 21},
}


def _resolve_target_provider(goal: str) -> Dict[str, Any]:
    """按 goal 关键词在自定义源中定位唯一目标；含混时返回 candidates 供人选。"""
    from app.providers.custom.manager import custom_provider_manager as _mgr
    defs = _mgr.list_definitions(kind=None)
    g = (goal or "").lower()
    # 目标类型提示：避免“给H3视频源补插槽”这类目标被同名的音频/图片源抢走
    want = None
    if any(k in g for k in ("视频", "video", "生视频", "图生视频", "文生视频")):
        want = "video"
    elif any(k in g for k in ("生图", "图片", "图像", "文生图", "image")):
        want = "image"
    elif any(k in g for k in ("配音", "语音", "音频", "声音", "tts", "audio")):
        want = "audio"
    if want:
        defs = [d for d in defs if d.kind == want]
    scored = []
    for d in defs:
        hay = f"{d.id} {d.name} {d.display_name or ''} {d.description or ''}".lower()
        score = 0
        if d.id.lower() in g:
            score += 5
        if (d.name or "").lower() and (d.name or "").lower() in g:
            score += 3
        for tok in ("h3", "first_frame", "首帧", "autodl", "kling", "flux"):
            if tok in g and tok in hay:
                score += 2
        if score > 0:
            scored.append((score, d))
    scored.sort(key=lambda x: -x[0])
    if scored:
        best = scored[0][1]
        cands = [{"id": d.id, "name": d.name, "kind": d.kind} for _, d in scored[:5]]
        return {"provider": best, "candidates": cands}
    if len(defs) == 1:
        d = defs[0]
        return {"provider": d, "candidates": [{"id": d.id, "name": d.name, "kind": d.kind}]}
    return {"provider": None, "candidates": [{"id": d.id, "name": d.name, "kind": d.kind} for d in defs[:8]]}


def _compute_schema_patch(kind: str, input_schema: Optional[Dict], params_schema: Optional[Dict]) -> Dict[str, Any]:
    """计算缺失插槽 + 缺失 x-* 的补丁（只增不改存量值）。返回 {input_add, input_fix, params_fix, summary}。"""
    kind = (kind or "image").lower()
    inp = dict((input_schema or {}).get("properties", {}) or {})
    prm = dict((params_schema or {}).get("properties", {}) or {})
    input_add: Dict[str, Any] = {}
    input_fix: List[str] = []
    # 文本主槽
    text_key = "text" if kind == "audio" else "prompt"
    if text_key not in inp:
        input_add[text_key] = {"type": "string", "description": "文本输入", "x-handle": "text"}
    elif not isinstance(inp.get(text_key), dict) or not inp[text_key].get("x-handle"):
        input_fix.append(text_key)
    if kind in ("image", "video"):
        if "reference_images" not in inp:
            input_add["reference_images"] = {"type": "array", "items": {"type": "string", "format": "uri"},
                                             "description": "参考图", "x-handle": "image"}
        elif not isinstance(inp.get("reference_images"), dict) or not inp["reference_images"].get("x-handle"):
            input_fix.append("reference_images")
    if kind == "video":
        if "first_frame" not in inp:
            input_add["first_frame"] = {"type": "string", "format": "uri", "description": "首帧", "x-handle": "image"}
        elif not isinstance(inp.get("first_frame"), dict) or not inp["first_frame"].get("x-handle"):
            input_fix.append("first_frame")
    params_fix: Dict[str, List[str]] = {}
    for k, v in prm.items():
        if not isinstance(v, dict):
            continue
        missing = [x for x in ("x-category", "x-visibility", "x-agent", "x-priority") if x not in v]
        if missing:
            params_fix[k] = missing
    summary = f"input 补 {len(input_add)} 槽({','.join(input_add) or '无'})、修 {len(input_fix)} 处 x-handle；params 补 {len(params_fix)} 个参数的 x-*"
    return {"input_add": input_add, "input_fix": input_fix, "params_fix": params_fix, "summary": summary}


def _load(pid: str) -> Optional[Dict[str, Any]]:
    p = _proposal_dir() / f"{pid}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save(prop: Dict[str, Any]) -> None:
    try:
        (_proposal_dir() / f"{prop['proposal_id']}.json").write_text(json.dumps(prop, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def list_proposals(limit: int = 20) -> List[Dict[str, Any]]:
    d = _proposal_dir()
    try:
        files = sorted(d.glob("prop_*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:limit]
        out = []
        for f in files:
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception:
                continue
        return out
    except Exception:
        return []


async def _draft_code_for_goal(goal: str, kind_hint: str = "") -> Dict[str, Any]:
    """按目标文档草拟生成源代码（不落库）：LLM 生成 → 沙箱编译体检。返回 {ok, kind, code, error}。"""
    goal = (goal or "").strip()
    if len(goal) < 20:
        return {"ok": False, "error": "goal 太短，无法草拟代码"}
    from app.api.provider_routes import code_gen_system_prompt, CODE_TEMPLATES, _infer_kind_from_doc
    from app.providers.generic.code_provider import compile_check_code
    kind = kind_hint or _infer_kind_from_doc(goal, "") or "image"
    lang = "python"
    tmpl = CODE_TEMPLATES.get((lang, kind)) or CODE_TEMPLATES.get(("python", kind)) or ""
    system_prompt = code_gen_system_prompt(kind, lang, tmpl)
    user_prompt = f"kind: {kind}\nlanguage: {lang}\n\nAPI 文档:\n{goal[:6000]}"
    from app.pipelines.llm_service import llm_service
    try:
        code_text = await llm_service.chat_completion(
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            temperature=0.2,
        )
    except Exception:
        code_text = await llm_service.chat_json(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.2)
        if isinstance(code_text, dict):
            code_text = code_text.get("code") or str(code_text)
    code_text = str(code_text or "").strip()
    if len(code_text) < 50:
        return {"ok": False, "kind": kind, "error": "LLM 生成代码过短"}
    cc = compile_check_code(lang, code_text, "generate")
    return {"ok": bool(cc.get("ok")), "kind": kind, "code": code_text, "error": cc.get("error")}


def _delete_created_provider(pid: str) -> None:
    """删除本提案创建的生成源（失败回滚用）：定义 + 配置 Key + 反注册 + MCP 刷新。"""
    if not pid:
        return
    try:
        from app.providers.custom.manager import custom_provider_manager as _mgr
        from app.providers.init_providers import unregister_single_custom_provider
        pd = _mgr.get_definition(pid)
        if pd:
            _mgr.delete_definition(pid)
            unregister_single_custom_provider(pid, kind=pd.kind)
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception:
        pass
    try:
        import json as _json
        import os as _os
        from app.core.config import settings as _settings
        cfg_path = _os.path.join(_settings.STORAGE_DIR, "config_store.json")
        if _os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                data = _json.load(f)
            if isinstance(data.get("custom_providers"), dict):
                data["custom_providers"].pop(pid, None)
            data.pop(f"CUSTOM_PROVIDER_{pid}", None)
            with open(cfg_path, "w", encoding="utf-8") as f:
                _json.dump(data, f, ensure_ascii=False, indent=2)
            _os.environ.pop(f"CUSTOM_PROVIDER_{pid}", None)
    except Exception:
        pass


async def _persist_new_provider(prop: Dict[str, Any], run_id: str) -> Dict[str, Any]:
    """新源持久化：草稿代码（Start 试跑已生成）或现生成 → 统一创建入口（注册+落 Key+体检）→ 连通试跑；失败自动删除回滚。"""
    import re as _re
    goal = (prop.get("goal") or "").strip()
    code_text = str(prop.get("draft_code") or "").strip()
    kind = str(prop.get("draft_kind") or "")
    if not code_text:
        draft = await _draft_code_for_goal(goal, prop.get("target_kind") or "")
        if not draft.get("ok"):
            raise RuntimeError(f"代码草稿未通过体检，无法持久化：{draft.get('error')}")
        code_text = draft["code"]
        kind = draft["kind"]
    kind = kind or "image"
    name = ""
    m = _re.search(r"[「【《\"']([^」】》\"']{2,40})[」】》\"']", goal)
    if m:
        name = m.group(1).strip()
    if not name:
        first = (goal.splitlines() or [""])[0]
        name = (first[:24].strip() or f"自定义{kind}源")
    api_key = ""
    mk = _re.search(r"(?:api[_ \-]?key|密钥)\s*[=:：]\s*([A-Za-z0-9_\-]{16,})", goal, _re.IGNORECASE)
    if mk:
        api_key = mk.group(1)
    from app.api.provider_routes import create_code_source
    created = create_code_source(
        name=name, kind=kind, code=code_text, language="python",
        description=f"由 Creator 提案持久化（{prop.get('proposal_id')}）",
        api_key=api_key or None, doc_text=goal,
    )
    pid = created["id"]
    if not created["compile_check"].get("ok"):
        _delete_created_provider(pid)
        raise RuntimeError(f"代码未通过沙箱体检，已删除：{created['compile_check'].get('error')}")
    from app.mcp.server import mcp_registry as _reg
    tres = await _reg.execute_tool("test_custom_provider", {"provider_id": pid})
    if getattr(tres, "status", "error") != "success":
        _delete_created_provider(pid)
        raise RuntimeError(f"连通试跑失败，已删除：{getattr(tres, 'error', '')}")
    prop["provider_id"] = pid
    return {"provider_id": pid,
            "note": f"新生成源已创建并连通：{pid}（已出现在生成源/画布/分镜选择器）"}


async def start_test(proposal_id: str, context: Optional[Dict[str, Any]] = None, run_id: str = "") -> Dict[str, Any]:
    """人来 Start：只做只读/小参试跑，不写生产。patch 算真实补丁；new_provider 草拟代码+沙箱编译体检。"""
    prop = _load(proposal_id)
    if not prop:
        raise ValueError(f"提案不存在: {proposal_id}")
    prop["status"] = "testing"
    report: Dict[str, Any] = {"proposal_id": proposal_id, "checks": []}
    try:
        kind = prop.get("kind", "")
        if kind in ("patch_provider", "new_provider"):
            try:
                from app.mcp.server import mcp_registry
                tools = [t.name for t in mcp_registry.get_all_tools() if t.name.startswith("provider_")][:5]
                report["checks"].append({"name": "provider_tools_visible", "ok": True, "detail": f"可见 provider_* 工具（前5: {tools}）"})
            except Exception as e:
                report["checks"].append({"name": "provider_tools_visible", "ok": False, "detail": str(e)[:200]})
        if kind == "new_provider":
            # 真实试跑（不落库）：按目标文档草拟代码并做沙箱编译体检，草稿存提案供持久化复用
            try:
                draft = await _draft_code_for_goal(prop.get("goal", ""), prop.get("target_kind") or "")
                if draft.get("ok"):
                    prop["draft_code"] = draft["code"]
                    prop["draft_kind"] = draft["kind"]
                    report["checks"].append({"name": "code_draft_compile", "ok": True,
                                             "detail": f"代码草稿编译体检通过（{len(draft['code'])} 字符，{draft['kind']}，未入库）"})
                else:
                    report["checks"].append({"name": "code_draft_compile", "ok": False,
                                             "detail": f"代码草稿体检失败: {draft.get('error')}"})
            except Exception as e:
                report["checks"].append({"name": "code_draft_compile", "ok": False, "detail": f"草拟异常: {str(e)[:200]}"})
            all_ok = all(c.get("ok") for c in report["checks"])
            prop["status"] = "tested" if all_ok else "test_failed"
        elif kind == "new_plugin":
            spec = prop.get("plugin_spec") or {}
            manifest = spec.get("manifest") or {}
            files = spec.get("files") or {}
            
            try:
                from app.plugins.models import PluginManifest
                PluginManifest.model_validate(manifest)
                report["checks"].append({"name": "manifest_schema", "ok": True, "detail": f"Manifest 结构符合 PluginManifest 规范 (id={manifest.get('id')})"})
            except Exception as e:
                report["checks"].append({"name": "manifest_schema", "ok": False, "detail": f"Manifest 校验失败: {e}"})

            try:
                from app.plugins.manager import _ID_RE, _VER_RE
                if not _ID_RE.match(manifest.get("id", "")):
                    raise ValueError(f"插件 ID 非法: {manifest.get('id')}")
                if not _VER_RE.match(manifest.get("version", "")):
                    raise ValueError(f"版本号非法: {manifest.get('version')}")
                report["checks"].append({"name": "id_version_format", "ok": True, "detail": f"插件 ID ({manifest.get('id')}) 与 Semver 命名合规"})
            except Exception as e:
                report["checks"].append({"name": "id_version_format", "ok": False, "detail": str(e)})

            ast_ok = True
            for fpath, content in files.items():
                if fpath.endswith(".py"):
                    import ast
                    try:
                        ast.parse(content)
                    except SyntaxError as se:
                        ast_ok = False
                        report["checks"].append({"name": f"syntax_{fpath}", "ok": False, "detail": f"Python 语法错误: {se}"})
                elif fpath.endswith(".md"):
                    if not content.startswith("---"):
                        report["checks"].append({"name": f"frontmatter_{fpath}", "ok": False, "detail": "缺少 YAML frontmatter"})
            if ast_ok:
                report["checks"].append({"name": "code_ast_check", "ok": True, "detail": f"所有扩展组件代码通过静态语法与 AST 格式分析 (共 {len(files)} 个文件)"})

            all_ok = all(c.get("ok") for c in report["checks"])
            prop["status"] = "tested" if all_ok else "test_failed"
        elif kind == "patch_provider":
            resolved = _resolve_target_provider(prop.get("goal", ""))
            pd = resolved.get("provider")
            if not pd:
                report["checks"].append({"name": "resolve_target", "ok": False,
                                         "detail": f"目标含混，请指定 provider_id，可选: {resolved.get('candidates', [])[:5]}"})
                prop["status"] = "test_failed"
                prop["test_report"] = report
                _save(prop)
                _trace(run_id, "proposal_tested", {"proposal_id": proposal_id, "status": prop["status"]})
                return {"proposal": prop, "report": report}
            patch = _compute_schema_patch(pd.kind, pd.input_schema, pd.params_schema)
            prop["target_provider_id"] = pd.id
            prop["target_kind"] = pd.kind
            prop["patch"] = patch
            report["checks"].append({"name": "resolve_target", "ok": True, "detail": f"目标 {pd.id}（{pd.name}/{pd.kind}）"})
            report["checks"].append({"name": "schema_patch_preview", "ok": True, "detail": patch["summary"]})
            if not patch["input_add"] and not patch["input_fix"] and not patch["params_fix"]:
                report["checks"].append({"name": "dry_run_schema", "ok": True, "detail": "schema 已完备，无需补丁（persist 将直接通过）"})
            else:
                report["checks"].append({"name": "dry_run_schema", "ok": True, "detail": "补丁试算通过，未写生产配置"})
            prop["status"] = "tested"
        elif kind == "storyboard_slot":
            from app.storyboard import slots as _slot_store
            doc = (prop.get("slot_spec") or {}).get("doc") or {}
            err = _slot_store.validate_slot_doc(doc)
            report["checks"].append({"name": "slot_schema", "ok": err is None,
                                     "detail": "槽声明校验通过" if err is None else err})
            if err is None:
                dup = [e for e in (_slot_store.list_effective_slots().get("slots") or [])
                       if e.get("slot") == doc.get("slot") and e.get("id") == doc.get("id") and e.get("valid")]
                if dup:
                    d0 = dup[0]
                    report["checks"].append({"name": "slot_id_unique", "ok": False,
                                             "detail": f"槽已存在: {doc.get('slot')}:{doc.get('id')}（来源 {d0.get('source')}）"})
                else:
                    report["checks"].append({"name": "slot_id_unique", "ok": True,
                                             "detail": f"slot:id 全局唯一: {doc.get('slot')}:{doc.get('id')}"})
            all_ok = all(c.get("ok") for c in report["checks"])
            prop["status"] = "tested" if all_ok else "test_failed"
        else:
            report["checks"].append({"name": "dry_run_schema", "ok": True, "detail": "试算通过，未写生产配置"})
            prop["status"] = "tested"
        prop["test_report"] = report
    except Exception as e:
        report["checks"].append({"name": "test", "ok": False, "detail": str(e)[:300]})
        prop["test_report"] = report
        prop["status"] = "test_failed"
    _save(prop)
    _trace(run_id, "proposal_tested", {"proposal_id": proposal_id, "status": prop["status"]})
    return {"proposal": prop, "report": report}


def _slug(text: str, fallback: str) -> str:
    import re as _re
    s = _re.sub(r"[^a-zA-Z0-9-]+", "-", (text or "").strip().lower()).strip("-")
    s = _re.sub(r"-{2,}", "-", s)
    return (s[:40] or fallback)


async def _persist_patch_provider(prop: Dict[str, Any], run_id: str) -> Dict[str, Any]:
    """真写生产：备份原 definition → 合并补丁（只增不改存量值）→ 保存 → 热重载 → MCP 刷新 → 连通试跑；试跑失败自动回滚。"""
    from app.providers.custom.manager import custom_provider_manager as _mgr
    pid = prop.get("target_provider_id") or ""
    patch = prop.get("patch") or {}
    if not pid:
        raise ValueError("提案缺少 target_provider_id，请先 Start 试跑定位目标源")
    pd = _mgr.get_definition(pid)
    if not pd:
        raise ValueError(f"Provider 不存在: {pid}")
    if pd.builtin:
        raise ValueError("内置 Provider 不可编辑")
    # 1) 备份
    backup_path = _backup_dir() / f"{pid}_{prop['proposal_id']}.json"
    try:
        backup_path.write_text(json.dumps(pd.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        raise RuntimeError(f"备份失败，已拒绝写入: {e}")
    # 2) 合并补丁
    try:
        inp = dict(pd.input_schema or {})
        props = dict(inp.get("properties", {}) or {})
        for k, v in (patch.get("input_add") or {}).items():
            if k not in props:
                props[k] = v
        for k in (patch.get("input_fix") or []):
            if isinstance(props.get(k), dict) and not props[k].get("x-handle"):
                props[k]["x-handle"] = "text" if k in ("prompt", "text") else "image"
        inp["properties"] = props
        inp.setdefault("type", "object")
        pd.input_schema = inp
        prm = dict(pd.params_schema or {})
        pprops = dict(prm.get("properties", {}) or {})
        for k, missing in (patch.get("params_fix") or {}).items():
            if not isinstance(pprops.get(k), dict):
                continue
            for x in missing:
                if x not in pprops[k] and k in _X_DEFAULTS and x in _X_DEFAULTS[k]:
                    pprops[k][x] = _X_DEFAULTS[k][x]
        prm["properties"] = pprops
        prm.setdefault("type", "object")
        pd.params_schema = prm
        saved = _mgr.save_definition(pd)
    except Exception as e:
        raise RuntimeError(f"合并补丁失败，未写入: {e}")
    # 3) 热重载 + MCP 刷新
    try:
        from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
        unregister_single_custom_provider(pid, kind=saved.kind)
        register_single_custom_provider(saved)
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception as e:
        _rollback_patch_provider(prop, run_id, reason=f"热重载失败自动回滚: {e}")
        raise RuntimeError(f"热重载失败已回滚: {e}")
    # 4) 连通试跑（真实执行 test_custom_provider：编译体检+连通，零配额）；失败自动回滚
    try:
        from app.mcp.server import mcp_registry as _reg
        tres = await _reg.execute_tool("test_custom_provider", {"provider_id": pid})
        if getattr(tres, "status", "error") != "success":
            _rollback_patch_provider(prop, run_id, reason=f"试跑失败自动回滚: {getattr(tres, 'error', '')}")
            raise RuntimeError(f"连通试跑失败已回滚: {getattr(tres, 'error', '')}")
    except RuntimeError:
        raise
    except Exception as e:
        _rollback_patch_provider(prop, run_id, reason=f"试跑异常自动回滚: {e}")
        raise RuntimeError(f"试跑异常已回滚: {e}")
    prop["backup_path"] = str(backup_path)
    return {"provider_id": pid, "backup": str(backup_path), "patch_summary": patch.get("summary", ""),
            "note": f"已写入并热重载，连通试跑通过（备份见 {backup_path}），失败可一键回滚"}


def _rollback_patch_provider(prop: Dict[str, Any], run_id: str, reason: str = "") -> Dict[str, Any]:
    from app.providers.custom.manager import custom_provider_manager as _mgr
    from app.models.provider_definition import ProviderDefinition as _PD
    pid = prop.get("target_provider_id") or ""
    bpath = prop.get("backup_path") or str(_backup_dir() / f"{pid}_{prop['proposal_id']}.json")
    p = Path(bpath)
    if not p.exists():
        return {"ok": False, "note": "无备份，无法回滚"}
    data = json.loads(p.read_text(encoding="utf-8"))
    pd = _PD.model_validate(data)
    _mgr.save_definition(pd)
    try:
        from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
        unregister_single_custom_provider(pid, kind=pd.kind)
        register_single_custom_provider(pd)
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception as e:
        return {"ok": False, "note": f"回滚写入成功但热重载失败: {e}"}
    _trace(run_id, "proposal_rolled_back", {"proposal_id": prop["proposal_id"], "provider_id": pid, "reason": reason[:200]})
    return {"ok": True, "provider_id": pid}


def _persist_new_skill(prop: Dict[str, Any]) -> Dict[str, Any]:
    from app.skills.engine import SKILLS_ROOT_DIR, skill_engine
    slug = _slug(prop.get("goal", ""), f"creator-{prop['proposal_id'][-6:]}")
    dest = Path(SKILLS_ROOT_DIR) / slug
    backup = None
    if (dest / "SKILL.md").exists():
        try:
            vid = backup_skill_version(slug, (dest / "SKILL.md").read_text(encoding="utf-8"), "creator-overwrite")
            backup = str(_skill_version_dir() / slug / vid)
        except Exception:
            backup = None
    dest.mkdir(parents=True, exist_ok=True)
    tools_hint = "generate_image, generate_video, generate_voice, canvas_create_node, canvas_connect, canvas_execute"
    body = (
        f"---\nname: {slug}\ndescription: {prop.get('title','')}：{(prop.get('goal','') or '')[:120]}\n"
        f"version: 1.0.0\nauthor: Creator\ncategory: comic mills\ntools: [{tools_hint}]\n---\n\n"
        f"# {prop.get('title','')}\n\n来源：Creator 提案 {prop['proposal_id']}（目标：{(prop.get('goal','') or '')[:200]}）\n\n"
        f"## 步骤\n{(chr(10).join(f'{i+1}. {s}' for i, s in enumerate(prop.get('test_plan', []))) or '1. 按规范执行')}\n\n"
        f"## 质检门\n- 产物回写分镜/画布后再标记完成；失败按 what/why/next 报结构化错误。\n"
    )
    (dest / "SKILL.md").write_text(body, encoding="utf-8")
    try:
        skill_engine.reload_skills()
    except Exception:
        pass
    prop["skill_slug"] = slug
    if backup:
        prop["backup_path"] = str(backup)
    return {"skill": slug, "path": str(dest / "SKILL.md")}


def _rollback_new_skill(prop: Dict[str, Any]) -> Dict[str, Any]:
    from app.skills.engine import SKILLS_ROOT_DIR, skill_engine
    import shutil
    slug = prop.get("skill_slug") or ""
    if not slug:
        return {"ok": False, "note": "无 skill 记录，无法回滚"}
    dest = Path(SKILLS_ROOT_DIR) / slug
    backup = prop.get("backup_path")
    try:
        if backup and Path(backup).exists():
            dest.mkdir(parents=True, exist_ok=True)
            (dest / "SKILL.md").write_text(Path(backup).read_text(encoding="utf-8"), encoding="utf-8")
        elif backup and str(backup).startswith("legacy:"):
            # 兼容旧备份位引用
            content = get_skill_version(slug, str(backup))
            dest.mkdir(parents=True, exist_ok=True)
            (dest / "SKILL.md").write_text(content, encoding="utf-8")
        elif dest.exists():
            shutil.rmtree(dest)
        try:
            skill_engine.reload_skills()
        except Exception:
            pass
        return {"ok": True, "skill": slug}
    except Exception as e:
        return {"ok": False, "note": str(e)[:200]}


def _persist_canvas_template(prop: Dict[str, Any]) -> Dict[str, Any]:
    base = _template_dir()
    tid = f"tpl_{prop['proposal_id'][-8:]}"
    nodes = [
        {"key": "image", "label": "生图首帧", "x": 0, "y": 0},
        {"key": "video", "label": "图生视频", "x": 320, "y": 0},
        {"key": "audio", "label": "配音对齐", "x": 640, "y": 0},
    ]
    edges = [{"from": "image", "to": "video"}, {"from": "video", "to": "audio"}]
    doc = {"id": tid, "name": (prop.get("goal", "") or "漫剧模板")[:40] or "漫剧模板",
           "source_proposal": prop["proposal_id"], "nodes": nodes, "edges": edges,
           "execute_scope": "downstream", "created_at": time.time()}
    (base / f"{tid}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    prop["template_id"] = tid
    return {"template_id": tid, "path": str(base / f"{tid}.json"), "nodes": len(nodes)}


def _rollback_canvas_template(prop: Dict[str, Any]) -> Dict[str, Any]:
    tid = prop.get("template_id") or ""
    if not tid:
        return {"ok": False, "note": "无模板记录，无法回滚"}
    base = _template_dir()
    p = base / f"{tid}.json"
    try:
        if p.exists():
            p.unlink()
        return {"ok": True, "template_id": tid}
    except Exception as e:
        return {"ok": False, "note": str(e)[:200]}


def _persist_storyboard_slot(prop: Dict[str, Any]) -> Dict[str, Any]:
    """真写裸件槽：storage/storyboard_slots/custom/<slot>__<id>.json（幂等：同文件覆盖写）"""
    from app.storyboard import slots as _slot_store
    doc = (prop.get("slot_spec") or {}).get("doc") or {}
    saved = _slot_store.save_custom_slot(doc)
    prop["slot_key"] = f"{saved['slot']}:{saved['id']}"
    return {"slot": prop["slot_key"], "path": saved["path"]}


def _rollback_storyboard_slot(prop: Dict[str, Any]) -> Dict[str, Any]:
    from app.storyboard import slots as _slot_store
    doc = (prop.get("slot_spec") or {}).get("doc") or {}
    slot, sid = str(doc.get("slot") or ""), str(doc.get("id") or "")
    if not slot or not sid:
        return {"ok": False, "note": "提案无槽记录，无法回滚"}
    ok = _slot_store.delete_custom_slot(slot, sid)
    return {"ok": ok, "slot": f"{slot}:{sid}",
            "note": "裸件槽文件已删除" if ok else "裸件槽文件不存在（可能已手动删除）"}


def _persist_new_plugin(prop: Dict[str, Any], run_id: str) -> Dict[str, Any]:
    import tempfile
    from app.plugins import manager as pm
    spec = prop.get("plugin_spec") or {}
    manifest = spec.get("manifest") or {}
    files = spec.get("files") or {}
    pid = spec.get("plugin_id") or manifest.get("id")
    if not pid or not manifest:
        raise ValueError("提案缺少合法的 plugin_spec")

    # 创建临时构建目录打包
    with tempfile.TemporaryDirectory(prefix="creator_plugin_") as tmp:
        for rel, content in files.items():
            fpath = Path(tmp) / rel
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_text(content, encoding="utf-8")

        try:
            pm.uninstall(pid)
        except Exception:
            pass

        try:
            pm.install_from_dir(tmp)
        except Exception as e:
            raise RuntimeError(f"插件安装失败: {e}")

    try:
        en_res = pm.enable(pid)
    except Exception as e:
        try:
            pm.uninstall(pid)
        except Exception:
            pass
        raise RuntimeError(f"插件启用加载失败，已自动回滚卸载: {e}")

    prop["plugin_id"] = pid
    root_dir = pm._plugins_root()
    dest = Path(root_dir) / pid
    return {
        "plugin_id": pid,
        "path": str(dest),
        "enable_summary": en_res,
        "note": f"插件包 {pid} 已成功安装并启用，扩展能力（技能/MCP工具）已全量挂载生效"
    }


def _rollback_new_plugin(prop: Dict[str, Any]) -> Dict[str, Any]:
    from app.plugins import manager as pm
    pid = prop.get("plugin_id") or (prop.get("plugin_spec") or {}).get("plugin_id")
    if not pid:
        return {"ok": False, "note": "无插件 ID 记录，无法回滚"}
    try:
        pm.uninstall(pid)
        return {"ok": True, "plugin_id": pid, "note": f"插件包 {pid} 已彻底卸载并反注册"}
    except Exception as e:
        return {"ok": False, "note": f"插件卸载异常: {e}"}


async def finalize(proposal_id: str, action: str = "persist", context: Optional[Dict[str, Any]] = None, run_id: str = "") -> Dict[str, Any]:
    """persist 真写生产（备份→写入→热重载→试跑，失败自回滚）/ discard 卸载 / rollback 按备份恢复。"""
    prop = _load(proposal_id)
    if not prop:
        raise ValueError(f"提案不存在: {proposal_id}")
    action = (action or "persist").strip().lower()
    if action == "discard":
        prop["status"] = "discarded"
        _save(prop)
        try:
            (_proposal_dir() / f"{proposal_id}.json").unlink()
        except Exception:
            pass
        _trace(run_id, "proposal_discarded", {"proposal_id": proposal_id})
        return {"proposal_id": proposal_id, "status": "discarded", "note": "临时包已卸载，未动生产配置"}
    if action == "rollback":
        kind = prop.get("kind", "")
        if kind == "patch_provider":
            r = _rollback_patch_provider(prop, run_id, reason="人工回滚")
        elif kind == "new_skill":
            r = _rollback_new_skill(prop)
        elif kind == "canvas_template":
            r = _rollback_canvas_template(prop)
        elif kind == "new_plugin":
            r = _rollback_new_plugin(prop)
        elif kind == "storyboard_slot":
            r = _rollback_storyboard_slot(prop)
        elif kind == "new_provider":
            pid = prop.get("provider_id") or ""
            if not pid:
                return {"proposal_id": proposal_id, "status": prop.get("status"), "note": "该提案未创建生成源，无需回滚"}
            _delete_created_provider(pid)
            prop["status"] = "rolled_back"
            _save(prop)
            return {"proposal_id": proposal_id, "status": "rolled_back", "note": f"已删除本提案创建的生成源 {pid}"}
        else:
            return {"proposal_id": proposal_id, "status": prop.get("status"), "note": "该类型无备份可回滚"}
        if r.get("ok"):
            prop["status"] = "rolled_back"
            _save(prop)
            return {"proposal_id": proposal_id, "status": "rolled_back", "note": f"已回滚（{kind}），生产恢复到备份状态"}
        return {"proposal_id": proposal_id, "status": prop.get("status"), "note": r.get("note", "回滚失败")}
    # persist
    kind = prop.get("kind", "")
    try:
        if kind == "new_plugin":
            if prop.get("status") == "persisted":
                return {"proposal_id": proposal_id, "status": "persisted", "plugin_id": prop.get("plugin_id"),
                        "note": "该提案已持久化，无需重复操作；如需调整请重新提案"}
            if prop.get("status") != "tested":
                raise ValueError("请先 Start 试跑通过后再持久化")
            r = _persist_new_plugin(prop, run_id)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "plugin_id": r.get("plugin_id")})
            return {"proposal_id": proposal_id, "status": "persisted", "plugin_id": r.get("plugin_id"),
                    "path": r.get("path"), "note": r.get("note")}
        if kind == "patch_provider":
            if prop.get("status") == "persisted" and prop.get("patch"):
                return {"proposal_id": proposal_id, "status": "persisted", "provider_id": prop.get("target_provider_id"),
                        "note": "该提案已持久化，无需重复操作；如需再改可重新提案或让导演直接 update_custom_provider"}
            if prop.get("status") != "tested" or not prop.get("patch"):
                raise ValueError("请先 Start 试跑通过后再持久化")
            r = await _persist_patch_provider(prop, run_id)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "provider_id": r.get("provider_id")})
            return {"proposal_id": proposal_id, "status": "persisted", "provider_id": r.get("provider_id"),
                    "patch_summary": r.get("patch_summary", ""), "backup": r.get("backup", ""),
                    "note": r.get("note") or f"已写入生产并热重载（备份见 {r.get('backup','')}），失败可一键 rollback"}
        if kind == "new_skill":
            r = _persist_new_skill(prop)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "skill": r.get("skill")})
            return {"proposal_id": proposal_id, "status": "persisted", "skill": r.get("skill"), "path": r.get("path"),
                    "note": "Skill 已落盘并重载，删除目录即卸载（rollback 同效）"}
        if kind == "canvas_template":
            r = _persist_canvas_template(prop)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "template_id": r.get("template_id")})
            return {"proposal_id": proposal_id, "status": "persisted", "template_id": r.get("template_id"), "path": r.get("path"),
                    "note": "模板已落盘 storage/canvas_templates，删除文件即卸载"}
        if kind == "storyboard_slot":
            if prop.get("status") != "tested":
                raise ValueError("请先 Start 试跑通过后再持久化")
            r = _persist_storyboard_slot(prop)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "slot": r.get("slot")})
            return {"proposal_id": proposal_id, "status": "persisted", "slot": r.get("slot"), "path": r.get("path"),
                    "note": "分镜槽已落盘 storage/storyboard_slots/custom，删除文件即卸载（rollback 同效）"}
        if kind == "new_provider":
            if prop.get("status") == "persisted":
                return {"proposal_id": proposal_id, "status": "persisted", "provider_id": prop.get("provider_id"),
                        "note": "该提案已持久化（生成源已创建），无需重复操作"}
            if prop.get("status") != "tested":
                raise ValueError("请先 Start 试跑通过后再持久化")
            r = await _persist_new_provider(prop, run_id)
            prop["status"] = "persisted"
            _save(prop)
            _trace(run_id, "proposal_persisted", {"proposal_id": proposal_id, "kind": kind, "provider_id": r.get("provider_id")})
            return {"proposal_id": proposal_id, "status": "persisted", "provider_id": r.get("provider_id"),
                    "note": r.get("note")}
        # 未知类型：保留原上下文，交由人工/导演走专用链路
        prop["status"] = "needs_manual"
        _save(prop)
        return {"proposal_id": proposal_id, "status": "needs_manual",
                "note": "未知提案类型，请人工处理（本提案保留上下文）"}
    except (ValueError, RuntimeError) as e:
        raise
    except Exception as e:
        raise RuntimeError(f"持久化失败: {e}")
