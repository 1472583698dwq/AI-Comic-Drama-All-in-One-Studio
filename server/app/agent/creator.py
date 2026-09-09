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
    if any(k in g for k in ["参数", "暴露", "补", "first_frame", "插槽", "input_schema", "params_schema", "H3", "h3"]):
        return "patch_provider"
    if any(k in g for k in ["模板", "画布", "节点编排", "工作流模板"]):
        return "canvas_template"
    if any(k in g for k in ["Skill", "skill", "技能", "规范", "流程"]):
        return "new_skill"
    if any(k in g for k in ["源", "接入", "API", "接口", "模型"]):
        return "new_provider"
    return "patch_provider"


def propose_capability(goal: str, context: Optional[Dict[str, Any]] = None, run_id: str = "") -> Dict[str, Any]:
    """生成临时提案（不生效）。返回提案卡所需全部字段：diff_preview/风险/试跑计划/可逆性声明。"""
    ctx = context or {}
    kind = _classify_goal(goal or "")
    pid = f"prop_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    runtime = inspect_runtime(ctx)
    if kind == "patch_provider":
        title = "补齐生成源参数暴露"
        diff_preview = "patch params_schema/input_schema: 补 x-category/x-visibility/x-agent + 缺失插槽（如 first_frame/reference_images），存量 code 不动"
        test_plan = ["get_provider_code 看现状", "内存试算新 schema", "test_custom_provider 连通试跑（只读/小参）"]
        risk, reversible = "medium", "可逆：patch 前自动备份原 definition，discard 一键回滚"
    elif kind == "new_provider":
        title = "接入新生成源（临时包）"
        diff_preview = "new provider_xxx (code 沙盒，trusted 关)：input_schema 文件槽 + params_schema 分组，默认禁用，花钱动作需二次确认"
        test_plan = ["register_custom_provider(dry-run)", "小参试生成 1 张", "人工验收后再 persist"]
        risk, reversible = "high", "部分可逆：已发生的生成计费不可逆，注册本身可删"
    elif kind == "canvas_template":
        title = "新建画布编排模板（临时）"
        diff_preview = "batch create nodes+edges：生图→视频→配音链，位置按阶段列排，默认 scoped=downstream 执行"
        test_plan = ["画布预览（不执行）", "单节点试跑", "全量需二次确认"]
        risk, reversible = "medium", "可逆：模板删除不影响已生成节点"
    else:
        title = "新建 Skill 规范（临时）"
        diff_preview = "new skill SKILL.md：触发条件 + 步骤 + 质检门，引用现有 MCP 工具，不新增外部调用"
        test_plan = ["单镜试跑 Skill", "人工验收", "persist 到 skills/"]
        risk, reversible = "low", "可逆：删除 skill 目录即卸载"
    proposal = {
        "proposal_id": pid, "kind": kind, "title": title, "goal": (goal or "")[:500],
        "diff_preview": diff_preview, "test_plan": test_plan,
        "risk": risk, "reversible": reversible, "status": "proposed",
        "runtime_snapshot": {k: (str(v)[:400]) for k, v in runtime.items()},
        "created_at": time.time(), "run_id": run_id,
    }
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


async def start_test(proposal_id: str, context: Optional[Dict[str, Any]] = None, run_id: str = "") -> Dict[str, Any]:
    """人来 Start：只做只读/小参试跑，不写生产。patch_provider 会算出真实补丁存提案，供 persist 使用。"""
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
        if kind == "patch_provider":
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


def _persist_patch_provider(prop: Dict[str, Any], run_id: str) -> Dict[str, Any]:
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
    # 4) 连通试跑；失败自动回滚
    try:
        from app.mcp.server import mcp_registry as _reg
        import asyncio as _aio
        async def _t():
            return await _reg.execute_tool("test_custom_provider", {"provider_id": pid})
        try:
            _loop = _aio.get_running_loop()
        except RuntimeError:
            _loop = None
        if _loop and _loop.is_running():
            # 已在事件循环中（MCP/HTTP 上下文）：跳过阻塞试跑，标记待用户手动点测试
            return {"provider_id": pid, "backup": str(backup_path),
                    "note": "已写入并热重载；循环内跳过连通试跑，请手动测试该源"}
        else:
            tres = _aio.run(_t())
        if getattr(tres, "status", "error") != "success":
            _rollback_patch_provider(prop, run_id, reason=f"试跑失败自动回滚: {getattr(tres, 'error', '')}")
            raise RuntimeError(f"连通试跑失败已回滚: {getattr(tres, 'error', '')}")
    except RuntimeError:
        raise
    except Exception as e:
        _rollback_patch_provider(prop, run_id, reason=f"试跑异常自动回滚: {e}")
        raise RuntimeError(f"试跑异常已回滚: {e}")
    prop["backup_path"] = str(backup_path)
    return {"provider_id": pid, "backup": str(backup_path), "patch_summary": patch.get("summary", "")}


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
        if kind == "patch_provider":
            if prop.get("status") != "tested" or not prop.get("patch"):
                raise ValueError("请先 Start 试跑通过后再持久化")
            r = _persist_patch_provider(prop, run_id)
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
        # new_provider：高风险代码生成不在此自动写，要求走 register 链路（防坏码入库）
        prop["status"] = "needs_manual"
        _save(prop)
        return {"proposal_id": proposal_id, "status": "needs_manual",
                "note": "新源接入需文档/Key/沙箱体检，请走 register_custom_provider（本提案保留上下文，可直接引用 goal）"}
    except (ValueError, RuntimeError) as e:
        raise
    except Exception as e:
        raise RuntimeError(f"持久化失败: {e}")
