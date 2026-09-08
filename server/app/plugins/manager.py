# -*- coding: utf-8 -*-
"""
插件管理器 P0 — 文件即插件仓库（无DB），对标 ComfyUI(custom_nodes即插) / VSCode(注册表+生命周期)

布局：
  storage/plugins/<plugin_id>/plugin.json + providers/*.json + skills/*/SKILL.md + workflows/*.json
  storage/plugins/index.json — {plugins: {id: {version, enabled, installed_at, installed_files, provider_ids, skill_names}}}

生命周期：discover → validate → install → enable ⇄ disable → uninstall
安全：id/版本白名单、路径围栏（禁.. /绝对路径）、单文件≤1MB/包≤20MB、数量上限；
      provider走custom沙箱体检，skill走通用LLM分支（零代码），不执行插件内任意代码。
"""
import glob
import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from typing import Any, Dict, List, Optional, Tuple

from app.plugins.models import PluginManifest, PluginRecord

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,63}$")
_VER_RE = re.compile(r"^\d+\.\d+\.\d+([\-+][0-9A-Za-z.\-]+)?$")
_MAX_FILE = 1_000_000
_MAX_TOTAL = 20_000_000
_MAX_PER_KIND = 20


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
            },
            "deferred": {
                k: getattr(eps, k) for k in ("mcp_tools", "canvas_nodes", "director_packs", "exporters", "themes")
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
        "installed_files": [], "provider_ids": [], "skill_names": [],
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


def _workflows_root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "workflows")
    os.makedirs(root, exist_ok=True)
    return root


def enable(pid: str) -> Dict[str, Any]:
    root = _plugins_root()
    pdir = os.path.join(root, pid)
    if not os.path.isdir(pdir):
        raise ValueError(f"插件不存在: {pid}")
    m = _read_manifest(pdir)
    if m.id != pid:
        raise ValueError("目录名与manifest id不一致")
    idx = _load_index()
    rec = idx.setdefault("plugins", {}).setdefault(pid, {"version": m.version, "enabled": False, "installed_at": "", "installed_files": [], "provider_ids": [], "skill_names": []})
    if rec.get("enabled"):
        return {"id": pid, "enabled": True, "note": "已启用，无需重复操作"}
    summary: Dict[str, Any] = {"providers": [], "skills": [], "workflows": [], "warnings": []}
    installed_files: List[str] = []
    provider_ids: List[str] = []
    skill_names: List[str] = []

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

    # —— workflows：P0仅落盘，提示去Infra同步 ——
    try:
        wroot = _workflows_root()
        for rel in _glob_kind(pdir, m.extensionPoints.workflows):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            dest = os.path.join(wroot, os.path.basename(rel))
            if os.path.exists(dest):
                summary["warnings"].append(f"已存在同名工作流已跳过: {os.path.basename(rel)}")
                continue
            shutil.copy2(os.path.join(pdir, rel), dest)
            installed_files.append(dest)
            summary["workflows"].append(os.path.basename(rel))
        if summary["workflows"]:
            summary["warnings"].append("工作流已落盘，请到 设置→基础设施 手动同步后生效（P1自动sync）")
    except Exception as e:
        summary["warnings"].append(f"workflows落盘失败: {e}")

    try:
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception:
        pass

    rec.update({"version": m.version, "enabled": True,
                "installed_at": rec.get("installed_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
                "installed_files": installed_files, "provider_ids": provider_ids, "skill_names": skill_names})
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
    rec.update({"enabled": False, "installed_files": [], "provider_ids": [], "skill_names": []})
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
