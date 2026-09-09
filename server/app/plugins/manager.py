# -*- coding: utf-8 -*-
"""
插件管理器 P0 — 文件即插件仓库（无DB），对标 ComfyUI(custom_nodes即插) / VSCode(注册表+生命周期)

布局：
  storage/plugins/<plugin_id>/plugin.json + providers/*.json + skills/*/SKILL.md + workflows/*.json
  storage/plugins/index.json — {plugins: {id: {version, enabled, installed_at, installed_files, provider_ids, skill_names}}}

生命周期：discover → validate → install → enable ⇄ disable → uninstall
安全：id/版本白名单、路径围栏（禁.. /绝对路径）、单文件≤1MB/包≤20MB、数量上限；
      provider走custom沙箱体检，skill走通用LLM分支（零代码）；
      mcp_tools查壳函数仅在trusted总闸开启后执行（与fs_file/shell_exec同闸），30s超时+结果截断。
"""
import asyncio
import glob
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from typing import Any, Dict, List, Optional, Tuple

from app.plugins.models import PluginManifest, PluginRecord, MCP_TOOL_NAME_RE

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,63}$")
_VER_RE = re.compile(r"^\d+\.\d+\.\d+([\-+][0-9A-Za-z.\-]+)?$")
_TOOL_RE = re.compile(MCP_TOOL_NAME_RE)
_MAX_FILE = 1_000_000
_MAX_TOTAL = 20_000_000
_MAX_PER_KIND = 20
_PLUGIN_TOOL_TIMEOUT = 30
_PLUGIN_TOOL_MAX_OUT = 20000

# 查壳工具运行时注册表：tool_name -> {"pid","file","entry","input_schema"}
_PLUGIN_TOOL_HANDLERS: Dict[str, Dict[str, Any]] = {}


def _pid_norm(pid: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", pid.lower().replace("-", "_"))


def _plugins_root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "plugins")
    os.makedirs(root, exist_ok=True)
    return root


def _index_path() -> str:
    return os.path.join(_plugins_root(), "index.json")


def _load_index() -> Dict[str, Any]:
    try:
        with open(_index_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {"plugins": {}}


def _save_index(data: Dict[str, Any]) -> None:
    tmp = _index_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _index_path())


def _safe_rel(root: str, rel: str) -> str:
    """相对路径围栏校验，返回归一化rel；越界抛错。"""
    if not rel or os.path.isabs(rel) or (len(rel) > 2 and rel[1] == ":"):
        raise ValueError(f"非法路径（须为包内相对路径）: {rel}")
    norm = os.path.normpath(rel).replace("\\", "/")
    if norm.startswith("..") or "/../" in norm:
        raise ValueError(f"路径越界已拦截: {rel}")
    return norm


def _glob_kind(root: str, patterns: List[str]) -> List[str]:
    out: List[str] = []
    for pat in patterns or []:
        pat = _safe_rel(root, pat)
        for hit in sorted(glob.glob(os.path.join(root, pat), recursive=True)):
            if os.path.isfile(hit):
                out.append(os.path.relpath(hit, root).replace("\\", "/"))
    # 去重保序 + 上限
    seen, uniq = set(), []
    for r in out:
        if r not in seen:
            seen.add(r)
            uniq.append(r)
    return uniq[:_MAX_PER_KIND]


def validate_manifest_dict(data: Dict[str, Any]) -> PluginManifest:
    m = PluginManifest.model_validate(data)
    if not _ID_RE.match(m.id):
        raise ValueError("插件id非法：小写字母数字中划线，2~64字符")
    if not _VER_RE.match(m.version):
        raise ValueError("版本非法：须为semver，如 1.0.0")
    eps = m.extensionPoints
    for rel in (eps.providers + eps.skills + eps.workflows + eps.mcp_tools
                + eps.custom_nodes
                + eps.canvas_nodes + eps.director_packs + eps.exporters + eps.themes):
        _safe_rel("<manifest>", rel)
    return m


def _read_manifest(plugin_dir: str) -> PluginManifest:
    pj = os.path.join(plugin_dir, "plugin.json")
    if not os.path.isfile(pj):
        raise ValueError("缺少 plugin.json")
    if os.path.getsize(pj) > _MAX_FILE:
        raise ValueError("plugin.json 过大")
    with open(pj, "r", encoding="utf-8") as f:
        data = json.load(f)
    return validate_manifest_dict(data)


def _size_guard(files: List[str]) -> None:
    total = 0
    for fp in files:
        sz = os.path.getsize(fp)
        if sz > _MAX_FILE:
            raise ValueError(f"单文件超限1MB: {os.path.basename(fp)}")
        total += sz
    if total > _MAX_TOTAL:
        raise ValueError("插件包超限20MB")


def discover() -> List[Dict[str, Any]]:
    """扫描已安装插件：manifest + 开关状态 + 贡献摘要。"""
    root = _plugins_root()
    idx = _load_index().get("plugins", {})
    out = []
    for entry in sorted(os.listdir(root)):
        pdir = os.path.join(root, entry)
        if not os.path.isdir(pdir):
            continue
        try:
            m = _read_manifest(pdir)
        except Exception as e:
            out.append({"id": entry, "error": f"manifest无效: {e}", "enabled": bool((idx.get(entry) or {}).get("enabled", False))})
            continue
        rec = idx.get(m.id, {})
        eps = m.extensionPoints
        out.append({
            "id": m.id, "name": m.name, "version": m.version,
            "description": m.description, "author": m.author, "license": m.license,
            "enabled": bool(rec.get("enabled", False)),
            "installed_at": rec.get("installed_at", ""),
            "contributions": {
                "providers": _glob_kind(pdir, eps.providers),
                "skills": _glob_kind(pdir, eps.skills),
                "workflows": _glob_kind(pdir, eps.workflows),
                "mcp_tools": _glob_kind(pdir, eps.mcp_tools),
                "custom_nodes": _glob_kind(pdir, eps.custom_nodes),
            },
            "deferred": {
                k: getattr(eps, k) for k in ("canvas_nodes", "director_packs", "exporters", "themes")
                if getattr(eps, k)
            },
        })
    return out


def install_from_dir(src_dir: str) -> PluginManifest:
    m = _read_manifest(src_dir)
    root = _plugins_root()
    dest = os.path.join(root, m.id)
    if os.path.exists(dest):
        raise ValueError(f"插件已存在: {m.id}（请先卸载或删除旧版）")
    # 体积 guard：payload 全量文件
    all_files = []
    for _dp, _dn, fns in os.walk(src_dir):
        for fn in fns:
            all_files.append(os.path.join(_dp, fn))
    _size_guard(all_files)
    shutil.copytree(src_dir, dest)
    idx = _load_index()
    idx.setdefault("plugins", {})[m.id] = {
        "version": m.version, "enabled": False, "installed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [],
        "custom_nodes": [],
    }
    _save_index(idx)
    return m


def install_from_zip(data: bytes) -> PluginManifest:
    if len(data) > _MAX_TOTAL + 1_000_000:
        raise ValueError("zip包超限")
    tmp = tempfile.mkdtemp(prefix="plugin_")
    try:
        zpath = os.path.join(tmp, "pkg.zip")
        with open(zpath, "wb") as f:
            f.write(data)
        outdir = os.path.join(tmp, "out")
        os.makedirs(outdir, exist_ok=True)
        with zipfile.ZipFile(zpath, "r") as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if name.startswith("/") or ".." in name.split("/"):
                    raise ValueError(f"zip路径越界已拦截: {info.filename}")
                target = os.path.abspath(os.path.join(outdir, name))
                if not target.startswith(os.path.abspath(outdir) + os.sep) and target != os.path.abspath(outdir):
                    raise ValueError(f"zip路径越界已拦截: {info.filename}")
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with zf.open(info, "r") as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 256)
        # plugin.json 在根或单层子目录
        cand = os.path.join(outdir, "plugin.json")
        src_dir = outdir if os.path.isfile(cand) else ""
        if not src_dir:
            subs = [d for d in os.listdir(outdir) if os.path.isdir(os.path.join(outdir, d))]
            for s in subs:
                if os.path.isfile(os.path.join(outdir, s, "plugin.json")):
                    src_dir = os.path.join(outdir, s)
                    break
        if not src_dir:
            raise ValueError("zip内未找到 plugin.json（根或单层子目录）")
        return install_from_dir(src_dir)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _skills_target_root() -> str:
    # server/skills/.plugins/<pid>/...（skills引擎扫描 server/skills）
    here = os.path.abspath(os.path.dirname(__file__))
    return os.path.join(os.path.abspath(os.path.join(here, "..", "..", "skills")), ".plugins")


def _load_plugin_module(pid: str, path: str):
    """查壳加载插件python文件（每次新鲜加载，无跨调用状态残留）。"""
    stem = os.path.splitext(os.path.basename(path))[0]
    safe_stem = re.sub(r"[^a-z0-9_]", "_", stem.lower()) or "mod"
    mod_name = f"studio_plugin_{_pid_norm(pid)}_{safe_stem}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if not spec or not spec.loader:
        raise ValueError(f"无法加载模块: {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _register_plugin_tools(pid: str, pdir: str, patterns: List[str]) -> Tuple[List[str], List[str]]:
    """查壳注册插件mcp_tools为 plugin_<id>_<name> MCP Tool。返回 (registered, warnings)。"""
    from app.mcp.server import mcp_registry
    from app.models.schemas import MCPToolDefinition

    registered: List[str] = []
    warnings: List[str] = []
    for rel in _glob_kind(pdir, patterns):
        if not rel.lower().endswith(".py"):
            warnings.append(f"跳过非py: {rel}")
            continue
        fpath = os.path.join(pdir, rel)
        try:
            mod = _load_plugin_module(pid, fpath)
        except Exception as e:
            warnings.append(f"查壳失败 {rel}: {e}")
            continue
        decls = getattr(mod, "PLUGIN_TOOLS", None)
        if not isinstance(decls, list) or not decls:
            warnings.append(f"无PLUGIN_TOOLS声明已跳过: {rel}")
            continue
        for d in decls:
            try:
                if not isinstance(d, dict):
                    raise ValueError("声明须为dict")
                name = str(d.get("name") or "")
                if not _TOOL_RE.match(name):
                    raise ValueError(f"工具名非法: {name}（小写字母数字下划线，2~48字符）")
                desc = str(d.get("description") or "").strip()
                if not desc:
                    raise ValueError(f"工具 {name} 缺少description")
                schema = d.get("input_schema") or {"type": "object", "properties": {}}
                if not isinstance(schema, dict) or schema.get("type") != "object":
                    raise ValueError(f"工具 {name} input_schema须为type=object的dict")
                entry = str(d.get("entry") or name)
                if not callable(getattr(mod, entry, None)):
                    raise ValueError(f"工具 {name} 入口函数缺失: {entry}")
                tool_name = f"plugin_{_pid_norm(pid)}_{name}"
                if tool_name in mcp_registry.tools and tool_name not in _PLUGIN_TOOL_HANDLERS:
                    warnings.append(f"工具名冲突已跳过: {tool_name}")
                    continue
                mcp_registry.register_tool(MCPToolDefinition(
                    name=tool_name,
                    description=f"[插件{pid}] {desc}",
                    category="plugin",
                    icon="Puzzle",
                    author=pid,
                    is_enabled=True,
                    input_schema=schema,
                ))
                _PLUGIN_TOOL_HANDLERS[tool_name] = {
                    "pid": pid, "file": fpath, "entry": entry, "input_schema": schema,
                }
                registered.append(tool_name)
            except Exception as e:
                warnings.append(f"工具注册失败 {rel}: {e}")
    return registered, warnings


def _unregister_plugin_tools(tool_names: List[str]) -> None:
    try:
        from app.mcp.server import mcp_registry
        for tn in tool_names or []:
            _PLUGIN_TOOL_HANDLERS.pop(tn, None)
            try:
                mcp_registry.tools.pop(tn, None)
            except Exception:
                pass
    except Exception:
        pass


async def run_plugin_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """执行查壳插件工具：trusted总闸 + 必填校验 + 30s超时 + 结果截断。供mcp execute_tool分支调用。"""
    from app.mcp.server import _trusted_gate_or_raise
    h = _PLUGIN_TOOL_HANDLERS.get(tool_name)
    if not h:
        raise ValueError(f"插件工具未注册（插件可能被禁用）: {tool_name}")
    _trusted_gate_or_raise()
    schema = h.get("input_schema") or {}
    required = schema.get("required") or []
    args = dict(arguments or {})
    missing = [k for k in required if args.get(k) in (None, "")]
    if missing:
        raise ValueError(f"缺少必填参数: {missing}")
    mod = _load_plugin_module(h["pid"], h["file"])
    fn = getattr(mod, h["entry"], None)
    if not callable(fn):
        raise ValueError(f"入口函数丢失: {h['entry']}")
    ctx = {"plugin_id": h["pid"], "tool": tool_name}
    result = await asyncio.wait_for(asyncio.to_thread(fn, args, ctx), timeout=_PLUGIN_TOOL_TIMEOUT)
    try:
        s = json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        s = str(result)
        result = {"output": s}
    if len(s) > _PLUGIN_TOOL_MAX_OUT:
        return {"output": s[:_PLUGIN_TOOL_MAX_OUT] + "…[截断]", "truncated": True}
    return result if isinstance(result, dict) else {"output": result}


def restore_enabled_plugins() -> Dict[str, Any]:
    """启动期恢复已启用插件的查壳工具注册（providers/skills/workflows由各自存储自恢复）。"""
    idx = _load_index().get("plugins", {})
    out: Dict[str, Any] = {"restored": [], "warnings": []}
    for pid, rec in idx.items():
        if not rec.get("enabled"):
            continue
        pdir = os.path.join(_plugins_root(), pid)
        if not os.path.isdir(pdir):
            out["warnings"].append(f"{pid} 目录丢失已跳过")
            continue
        try:
            m = _read_manifest(pdir)
        except Exception as e:
            out["warnings"].append(f"{pid} manifest无效: {e}")
            continue
        try:
            reged, warns = _register_plugin_tools(pid, pdir, m.extensionPoints.mcp_tools)
            if reged:
                out["restored"].append({pid: reged})
            out["warnings"].extend(warns)
        except Exception as e:
            out["warnings"].append(f"{pid} 恢复失败: {e}")
    return out


def enable(pid: str) -> Dict[str, Any]:
    root = _plugins_root()
    pdir = os.path.join(root, pid)
    if not os.path.isdir(pdir):
        raise ValueError(f"插件不存在: {pid}")
    m = _read_manifest(pdir)
    if m.id != pid:
        raise ValueError("目录名与manifest id不一致")
    idx = _load_index()
    rec = idx.setdefault("plugins", {}).setdefault(pid, {"version": m.version, "enabled": False, "installed_at": "", "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [], "custom_nodes": []})
    if rec.get("enabled"):
        return {"id": pid, "enabled": True, "note": "已启用，无需重复操作"}
    summary: Dict[str, Any] = {"providers": [], "skills": [], "workflows": [], "mcp_tools": [], "custom_nodes": [], "warnings": []}
    installed_files: List[str] = []
    provider_ids: List[str] = []
    skill_names: List[str] = []
    workflow_ids: List[str] = []
    registered_tools: List[str] = []

    # —— providers：经custom_manager体检 + 热注册 + MCP刷新 ——
    try:
        from app.models.provider_definition import ProviderDefinition
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.init_providers import register_single_custom_provider
    except Exception as e:
        raise ValueError(f"provider子系统不可用: {e}")
    for rel in _glob_kind(pdir, m.extensionPoints.providers):
        if not rel.lower().endswith(".json"):
            summary["warnings"].append(f"跳过非JSON: {rel}")
            continue
        try:
            with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                payload = json.load(f)
            definition = ProviderDefinition.model_validate(payload)
            if custom_provider_manager.get_definition(definition.id):
                summary["warnings"].append(f"已存在同名源已跳过: {definition.id}")
                continue
            custom_provider_manager.save_definition(definition)
            ok = register_single_custom_provider(definition)
            provider_ids.append(definition.id)
            summary["providers"].append({"id": definition.id, "kind": definition.kind, "registered": bool(ok)})
        except Exception as e:
            summary["warnings"].append(f"provider失败 {rel}: {e}")

    # —— skills：拷贝到 server/skills/.plugins/<pid>/ + reload ——
    try:
        from app.skills.engine import skill_engine
        trot = os.path.join(_skills_target_root(), pid)
        os.makedirs(trot, exist_ok=True)
        for rel in _glob_kind(pdir, m.extensionPoints.skills):
            if os.path.basename(rel) != "SKILL.md":
                summary["warnings"].append(f"skill须为SKILL.md，已跳过: {rel}")
                continue
            skill_dir = os.path.dirname(rel) or "skill"
            sname = os.path.basename(os.path.normpath(skill_dir))
            dest_dir = os.path.join(trot, sname)
            os.makedirs(dest_dir, exist_ok=True)
            shutil.copy2(os.path.join(pdir, rel), os.path.join(dest_dir, "SKILL.md"))
            installed_files.append(os.path.join(dest_dir, "SKILL.md"))
            skill_names.append(sname)
            summary["skills"].append(sname)
        try:
            skill_engine.reload_skills()
        except Exception as e:
            summary["warnings"].append(f"skills reload失败: {e}")
    except Exception as e:
        summary["warnings"].append(f"skills子系统不可用: {e}")

    # —— workflows：经save_workflow校验入库（含Save格式自动转换）+ 自动sync为独立源 ——
    try:
        from app.providers.workflow.manager import workflow_manager
        for rel in _glob_kind(pdir, m.extensionPoints.workflows):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                if not isinstance(payload, dict):
                    raise ValueError("工作流JSON须为对象")
                wname = f"{m.name}-{os.path.splitext(os.path.basename(rel))[0]}"
                meta = workflow_manager.save_workflow(
                    name=wname, workflow_json=payload,
                    description=f"插件{m.id}自带工作流（{rel}）",
                )
                wid = str(meta.get("id") or "")
                if wid:
                    workflow_ids.append(wid)
                summary["workflows"].append({
                    "id": wid, "name": wname,
                    "provider": f"comfyui_{wid}" if wid and not wid.startswith("ext_") else None,
                    "warnings": meta.get("warnings", []),
                })
            except Exception as e:
                summary["warnings"].append(f"工作流失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"workflow子系统不可用: {e}")

    # —— mcp_tools：查壳注册为 plugin_<id>_<name>（执行走trusted闸门） ——
    try:
        reged, warns = _register_plugin_tools(pid, pdir, m.extensionPoints.mcp_tools)
        registered_tools = reged
        summary["mcp_tools"] = reged
        summary["warnings"].extend(warns)
        if reged:
            summary["warnings"].append("插件工具执行需全局 STUDIO_TRUSTED_MODE=1（与fs_file/shell_exec同闸），未开启时调用明错")
    except Exception as e:
        summary["warnings"].append(f"mcp_tools失败: {e}")

    # —— custom_nodes：代码节点包（JSON含code），体检入库 + MCP注册 + 画布工具栏 ——
    custom_ids: List[str] = []
    try:
        from app.custom_nodes.manager import custom_node_manager
        from app.custom_nodes.models import CustomNodeDefinition as _CND
        for rel in _glob_kind(pdir, m.extensionPoints.custom_nodes):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                definition = _CND.model_validate(payload)
                if custom_node_manager.get(definition.id):
                    summary["warnings"].append(f"已存在同名节点已跳过: {definition.id}")
                    continue
                saved = custom_node_manager.save(definition)
                custom_ids.append(saved.id)
                summary["custom_nodes"].append({"id": saved.id, "kind": saved.kind, "mcp_tool": f"customnode_{saved.id}"})
            except Exception as e:
                summary["warnings"].append(f"自定义节点失败 {rel}: {e}")
        try:
            from app.mcp.server import mcp_registry as _mcp2
            if hasattr(_mcp2, "refresh_customnode_tools"):
                _mcp2.refresh_customnode_tools()
        except Exception:
            pass
    except Exception as e:
        summary["warnings"].append(f"custom_nodes子系统不可用: {e}")

    try:
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception:
        pass

    rec.update({"version": m.version, "enabled": True,
                "installed_at": rec.get("installed_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
                "installed_files": installed_files, "provider_ids": provider_ids,
                "skill_names": skill_names, "workflow_ids": workflow_ids, "mcp_tools": registered_tools,
                "custom_nodes": custom_ids})
    _save_index(idx)
    summary.update({"id": pid, "enabled": True})
    return summary


def disable(pid: str) -> Dict[str, Any]:
    idx = _load_index()
    rec = (idx.get("plugins") or {}).get(pid)
    if not rec or not rec.get("enabled"):
        return {"id": pid, "enabled": False, "note": "本就未启用"}
    removed: List[str] = []
    warnings: List[str] = []
    # providers：反注册 + 删定义（仅追踪到的id）
    try:
        from app.providers.custom.manager import custom_provider_manager
        from app.providers.init_providers import unregister_single_custom_provider
        for prov_id in rec.get("provider_ids", []):
            kind = "image"
            try:
                d = custom_provider_manager.get_definition(prov_id)
                if d:
                    kind = getattr(d, "kind", "image")
            except Exception:
                pass
            try:
                unregister_single_custom_provider(prov_id, kind)
            except Exception as e:
                warnings.append(f"反注册失败 {prov_id}: {e}")
            try:
                custom_provider_manager.delete_definition(prov_id)
            except Exception:
                pass
            removed.append(f"provider:{prov_id}")
    except Exception as e:
        warnings.append(f"provider子系统不可用: {e}")
    # workflows：删工作流 + 同步删对应 Provider（仅追踪到的id）
    try:
        from app.providers.workflow.manager import workflow_manager, remove_workflow_provider
        for wid in rec.get("workflow_ids", []):
            try:
                workflow_manager.delete_workflow(wid)
            except Exception as e:
                warnings.append(f"工作流删除失败 {wid}: {e}")
            try:
                remove_workflow_provider(wid)
            except Exception:
                pass
            removed.append(f"workflow:{wid}")
    except Exception as e:
        warnings.append(f"workflow子系统不可用: {e}")
    # 查壳工具反注册（仅追踪到的）
    try:
        _unregister_plugin_tools(rec.get("mcp_tools", []))
        for tn in rec.get("mcp_tools", []):
            removed.append(f"mcp_tool:{tn}")
    except Exception as e:
        warnings.append(f"插件工具反注册失败: {e}")
    # 自定义节点：删定义 + MCP反注册（仅追踪到的id）
    try:
        from app.custom_nodes.manager import custom_node_manager
        for cid in rec.get("custom_nodes", []):
            try:
                custom_node_manager.delete(cid)
            except Exception as e:
                warnings.append(f"自定义节点删除失败 {cid}: {e}")
            removed.append(f"custom_node:{cid}")
        try:
            from app.mcp.server import mcp_registry as _mcp3
            if hasattr(_mcp3, "refresh_customnode_tools"):
                _mcp3.refresh_customnode_tools()
        except Exception:
            pass
    except Exception as e:
        warnings.append(f"custom_nodes子系统不可用: {e}")
    # 落盘文件：仅删追踪到的
    for fp in rec.get("installed_files", []):
        try:
            ap = os.path.abspath(fp)
            if os.path.isfile(ap):
                os.remove(ap)
                removed.append(ap)
        except Exception as e:
            warnings.append(f"删除失败 {fp}: {e}")
    # 清理空技能目录
    try:
        trot = os.path.join(_skills_target_root(), pid)
        if os.path.isdir(trot) and not os.listdir(trot):
            os.rmdir(trot)
    except Exception:
        pass
    try:
        from app.skills.engine import skill_engine
        skill_engine.reload_skills()
    except Exception as e:
        warnings.append(f"skills reload失败: {e}")
    try:
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception:
        pass
    rec.update({"enabled": False, "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [], "custom_nodes": []})
    _save_index(idx)
    return {"id": pid, "enabled": False, "removed": removed, "warnings": warnings}


def uninstall(pid: str) -> Dict[str, Any]:
    try:
        disable(pid)
    except Exception:
        pass
    root = _plugins_root()
    pdir = os.path.join(root, pid)
    if os.path.isdir(pdir):
        shutil.rmtree(pdir, ignore_errors=True)
    idx = _load_index()
    (idx.get("plugins") or {}).pop(pid, None)
    _save_index(idx)
    return {"id": pid, "uninstalled": True}
