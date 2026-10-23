# -*- coding: utf-8 -*-
"""
插件管理器 P0 — 文件即插件仓库（无DB），对标 ComfyUI(custom_nodes即插) / VSCode(注册表+生命周期)

布局：
  storage/plugins/<plugin_id>/plugin.json + providers/*.json + skills/*/SKILL.md + workflows/*.json
  storage/plugins/index.json — {plugins: {id: {version, enabled, installed_at, installed_files, provider_ids, skill_names}}}

生命周期：discover → validate → install → enable ⇄ disable → uninstall
安全：id/版本白名单、路径围栏（禁.. /绝对路径）、单文件≤1MB/包≤20MB、数量上限；
      provider走custom沙箱体检，skill走通用LLM分支（零代码）；
      mcp_tools查壳函数仅在trusted总闸开启后执行（与fs_file/shell_exec同闸），20分钟超时+结果截断。
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
import threading
import time
import zipfile
from typing import Any, Dict, List, Optional, Tuple

from app.plugins.models import (
    PluginManifest, PluginRecord, MCP_TOOL_NAME_RE, normalize_manifest_v2,
    V2_DOMAINS, domains_of, domain_counts,
)

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,63}$")
_VER_RE = re.compile(r"^\d+\.\d+\.\d+([\-+][0-9A-Za-z.\-]+)?$")
_TOOL_RE = re.compile(MCP_TOOL_NAME_RE)
_MAX_FILE = 1_000_000
_MAX_TOTAL = 20_000_000
_MAX_PER_KIND = 20
_PLUGIN_TOOL_TIMEOUT = 1200  # 单工具执行超时：20 分钟（长任务可自取任务号，但整体不早退）
_PLUGIN_TOOL_MAX_OUT = 20000

# 生命周期并发锁：install / enable / disable / uninstall / reload 串行化
_LOCK = threading.RLock()

# 查壳工具运行时注册表：tool_name -> {"pid","file","entry","input_schema"}
_PLUGIN_TOOL_HANDLERS: Dict[str, Dict[str, Any]] = {}

# 文件监听（热重载）：pid -> 最近一次扫描到的目录 mtime
_WATCH_SNAPSHOT: Dict[str, float] = {}
_watcher_thread: Optional[threading.Thread] = None
_watcher_stop = threading.Event()


def _parse_ver(v: str) -> Optional[Tuple[int, int, int]]:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", str(v or ""))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def _satisfies(version: str, constraint: str) -> bool:
    """轻量 semver 约束：* / = / > / >= / < / <= / ^ / ~，缺省 =。"""
    c = str(constraint or "*").strip()
    if c in ("", "*", "latest"):
        return True
    v = _parse_ver(version)
    if not v:
        return False
    m = re.match(r"^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)", c)
    if not m:
        return False
    op = m.group(1) or "="
    t = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
    if op in ("=", "=="):
        return v == t
    if op == ">=":
        return v >= t
    if op == "<=":
        return v <= t
    if op == ">":
        return v > t
    if op == "<":
        return v < t
    if op == "^":
        return v[0] == t[0] and v >= t
    if op == "~":
        return v[0] == t[0] and v[1] == t[1] and v >= t
    return False


def _app_version() -> str:
    """当前应用版本（`min_app_version` 校验用）。单一真相源 = `app.core.config.APP_VERSION`。"""
    try:
        from app.core.config import APP_VERSION
        return str(APP_VERSION or "0.0.0")
    except Exception:
        return "0.0.0"


def _check_min_app_version(m: PluginManifest) -> None:
    """`min_app_version` 校验（未完成清单第 18 条）：声明了就必须能被当前应用满足。

    此前该字段全仓零消费（声明了等于没写）：插件作者写「>=9.0.0」也不会被拦，
    装上一个必然跑不起来的包。现在在 manifest 校验阶段直接拒绝。
    """
    need = str(m.min_app_version or "").strip()
    if not need:
        return
    cur = _app_version()
    if not _satisfies(cur, need):
        raise ValueError(f"插件要求应用版本 {need}（当前 {cur}），不满足")


def _check_dependencies(m: PluginManifest, require_enabled: bool = False) -> Dict[str, List[str]]:
    """校验 dependsOn。返回 {missing, mismatch, disabled}，均为人类可读字符串列表。"""
    idx = (_load_index().get("plugins") or {})
    missing: List[str] = []
    mismatch: List[str] = []
    disabled: List[str] = []
    for dep_id, constraint in (m.dependsOn or {}).items():
        rec = idx.get(dep_id)
        spec = f"{dep_id}" + (f"@{constraint}" if constraint not in ("", "*") else "")
        if not rec:
            missing.append(spec)
            continue
        if not _satisfies(rec.get("version", ""), constraint):
            mismatch.append(f"{dep_id} 需要 {constraint or '*'}，已装 {rec.get('version') or '?'}")
        elif require_enabled and not rec.get("enabled"):
            disabled.append(dep_id)
    return {"missing": missing, "mismatch": mismatch, "disabled": disabled}


def _namespace_skill_name(content: str, native_name: str) -> str:
    """把 SKILL.md 的 frontmatter ``name`` 重写为命名空间化名称。

    - 有 frontmatter：替换/补写 name（技能引擎以 frontmatter name 为键，物理隔离靠它）；
    - 无 frontmatter：引擎本就不会加载，原样返回。
    """
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not m:
        return content
    fm, body = m.group(1), m.group(2)
    lines = fm.splitlines()
    out_lines, found = [], False
    for ln in lines:
        if re.match(r"^\s*name\s*:", ln):
            out_lines.append(f"name: {native_name}")
            found = True
        else:
            out_lines.append(ln)
    if not found:
        out_lines.insert(0, f"name: {native_name}")
    return "---\n" + "\n".join(out_lines) + "\n---\n" + body


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


#: 声明式扩展点字段名（`extensionPoints` 的 key）——glob 无命中告警遍历用
_EXT_POINT_FIELDS = (
    "providers", "skills", "workflows", "mcp_tools", "custom_nodes", "storyboard_slots",
    "canvas_nodes", "director_packs", "exporters", "themes", "agent_profiles", "agent_teams",
)


def _warn_empty_globs(root: str, eps: Any, warn_sink: List[str]) -> None:
    """**扩展点 glob 无命中告警**（未完成清单第 21 条）。

    声明了 `extensionPoints: {"themes": ["themes/*.json"]}` 却一个文件都没命中时，
    启用会「成功」但什么都没带来，此前完全静默（用户只看到一个已启用插件 + 空列表）。
    这里在启用前统一扫一遍并记 warning，把「什么都没带来」变成可在返回值里看到的事实。
    """
    for attr in _EXT_POINT_FIELDS:
        patterns = getattr(eps, attr, None) or []
        if patterns and not _glob_kind(root, patterns):
            warn_sink.append(
                f"{attr}: 声明了 {list(patterns)} 但无任何文件命中（该扩展点不会带来任何贡献）")


#: 预检覆盖的扩展点：(注册表 kind, manifest 字段, 人类可读名)
#: 这些扩展点的条目 JSON 都带顶层 ``id``，可在**注册前**判定撞名；
#: workflows（id 由入库时生成）/ skills（已按插件命名空间化）/ mcp_tools（查壳名带插件前缀）
#: 天然不跨插件撞名，不进预检。
_PREFLIGHT_KINDS: List[Tuple[str, str, str]] = [
    ("provider", "providers", "生成源"),
    ("custom_node", "custom_nodes", "自定义节点"),
    ("canvas_node", "canvas_nodes", "画布节点"),
    ("theme", "themes", "主题"),
    ("exporter", "exporters", "导出器"),
    ("director_pack", "director_packs", "导演包"),
    ("agent_profile", "agent_profiles", "角色"),
    ("agent_team", "agent_teams", "导演组"),
]


def _preflight_contribution_conflicts(pdir: str, m: PluginManifest, pid: str) -> List[str]:
    """安装 / 启用前的**贡献物撞名预检**（未完成清单第 19 条）。

    此前撞名只在各子系统的注册循环里 `warning + continue`：插件「启用成功」了，
    但其中一部分贡献被静默丢掉，用户直到发现能力缺失才知道。而现成的
    `extension_registry.check_id_available`（按 `(kind, publisher, local_id)` 去重）
    在安装 / 启用路径上一次都没被调用。

    现在在**注册任何东西之前**做一次预检：命中「已被别的来源占用」即返回冲突列表，
    由调用方拒绝安装 / 启用。同包自己的旧件（`source_detail == pid`，如热重载残留）不算冲突。
    """
    try:
        from app.extensions.registry import extension_registry
    except Exception:
        return []  # 扩展层不可用时不做预检（不因预检本身阻断安装）
    eps = m.extensionPoints
    publisher = str(m.publisher or m.author or m.id)
    out: List[str] = []
    for kind, attr, label in _PREFLIGHT_KINDS:
        patterns = getattr(eps, attr, None) or []
        if not patterns:
            continue
        for rel in _glob_kind(pdir, patterns):
            if not rel.lower().endswith(".json"):
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
            except Exception:
                continue  # 解析失败留给正式注册路径报错（那里会给出更具体的 warning）
            lid = str((payload or {}).get("id") or "").strip()
            if not lid:
                continue
            info = extension_registry.check_id_available(kind, lid, publisher)
            for conflict_id in info.get("conflicts") or []:
                ext = extension_registry.get(conflict_id)
                if ext is not None and str(getattr(ext, "source_detail", "") or "") == pid:
                    continue  # 同包自己的旧件
                out.append(f"{label} `{lid}` 已被 {conflict_id} 占用")
    return out


_CODE_FILE_EXT = {"python": (".py",), "javascript": (".js", ".mjs")}


def _resolve_code_ref(pdir: str, rel: str, obj: Any,
                      warning_sink: Optional[List[str]] = None) -> None:
    """插件包 code_file 解析：把包内真实代码文件读入对象的 code 字段。

    - code_file 为相对 plugin.json 的包内路径，统一过路径围栏（禁 .. / 绝对路径 / 盘符）；
    - code 已内联时优先（code_file 忽略并告警）；扩展名须与 language 匹配；文件 ≤1MB。
    """
    cf = str(getattr(obj, "code_file", "") or "").strip()
    if not cf:
        return
    inline = str(getattr(obj, "code", "") or "").strip()
    if inline:
        if warning_sink is not None:
            warning_sink.append(f"{rel}: 已内联 code，忽略 code_file={cf}")
        return
    safe = _safe_rel(pdir, cf)
    fpath = os.path.join(pdir, safe)
    if not os.path.isfile(fpath):
        raise ValueError(f"code_file 不存在: {cf}")
    if os.path.getsize(fpath) > _MAX_FILE:
        raise ValueError(f"code_file 超限1MB: {cf}")
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            code = f.read()
    except Exception as e:
        raise ValueError(f"code_file 读取失败: {cf}: {e}")
    lang = str(getattr(obj, "language", "") or "python").lower()
    ext = os.path.splitext(fpath)[1].lower()
    allowed = _CODE_FILE_EXT.get(lang, ())
    if allowed and ext not in allowed:
        raise ValueError(f"code_file 扩展名与 language 不匹配: {cf}（{lang} 需 {list(allowed)}）")
    setattr(obj, "code", code)


def validate_manifest_dict(data: Dict[str, Any]) -> PluginManifest:
    m = PluginManifest.model_validate(normalize_manifest_v2(data))
    if not _ID_RE.match(m.id):
        raise ValueError("插件id非法：小写字母数字中划线，2~64字符")
    if not _VER_RE.match(m.version):
        raise ValueError("版本非法：须为semver，如 1.0.0")
    eps = m.extensionPoints
    for rel in (eps.providers + eps.skills + eps.workflows + eps.mcp_tools
                + eps.custom_nodes + eps.storyboard_slots
                + eps.canvas_nodes + eps.director_packs + eps.exporters + eps.themes):
        _safe_rel("<manifest>", rel)
    _check_min_app_version(m)
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
            "publisher": m.publisher or m.author or m.id,
            "dependsOn": dict(m.dependsOn or {}),
            "enabled": bool(rec.get("enabled", False)),
            "installed_at": rec.get("installed_at", ""),
            "domains": domains_of(eps, m.domains),
            "domain_counts": domain_counts(eps),
            "contributions": {
                "providers": _glob_kind(pdir, eps.providers),
                "skills": _glob_kind(pdir, eps.skills),
                "workflows": _glob_kind(pdir, eps.workflows),
                "mcp_tools": _glob_kind(pdir, eps.mcp_tools),
                "custom_nodes": _glob_kind(pdir, eps.custom_nodes),
                "storyboard_slots": _glob_kind(pdir, eps.storyboard_slots),
                "canvas_nodes": _glob_kind(pdir, eps.canvas_nodes),
                "themes": _glob_kind(pdir, eps.themes),
                "exporters": _glob_kind(pdir, eps.exporters),
                "director_packs": _glob_kind(pdir, eps.director_packs),
                "agent_profiles": _glob_kind(pdir, eps.agent_profiles),
                "agent_teams": _glob_kind(pdir, eps.agent_teams),
            },
        })
    return out


def install_from_dir(src_dir: str) -> PluginManifest:
    m = _read_manifest(src_dir)
    root = _plugins_root()
    dest = os.path.join(root, m.id)
    # 依赖校验（安装时要求依赖已安装且版本满足；启用时再要求已启用）
    deps = _check_dependencies(m, require_enabled=False)
    if deps["missing"]:
        raise ValueError(f"缺少依赖插件: {', '.join(deps['missing'])}")
    if deps["mismatch"]:
        raise ValueError("依赖版本不满足: " + "；".join(deps["mismatch"]))
    # 体积 guard：payload 全量文件
    all_files = []
    for _dp, _dn, fns in os.walk(src_dir):
        for fn in fns:
            all_files.append(os.path.join(_dp, fn))
    _size_guard(all_files)
    with _LOCK:
        if os.path.exists(dest):
            raise ValueError(f"插件已存在: {m.id}（请先卸载或删除旧版）")
        # 贡献物撞名预检（未完成清单第 19 条）：装进来必然撞件的包直接拒绝，
        # 不留「启用成功但一半贡献被静默丢掉」的坑
        conflicts = _preflight_contribution_conflicts(src_dir, m, m.id)
        if conflicts:
            raise ValueError("贡献物撞名，已拒绝安装（请改用唯一 id 或先卸载冲突来源）: "
                             + "；".join(conflicts))
        # 原子安装：先复制到 staging，再 rename 落位；失败清理 staging
        staging = os.path.join(root, f".staging-{m.id}-{os.getpid()}-{int(time.time() * 1000)}")
        try:
            shutil.copytree(src_dir, staging)
            os.replace(staging, dest)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        idx = _load_index()
        idx.setdefault("plugins", {})[m.id] = {
            "version": m.version, "enabled": False, "installed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [],
            "custom_nodes": [], "canvas_nodes": [], "theme_ids": [], "exporter_ids": [], "director_pack_ids": [],
        }
        _save_index(idx)
    return m


_SCAFFOLD_EXAMPLES = {
    "capability": r"""# 能力域示例

## 生成源（provider）
`capability/providers/hello.json`

```json
{
  "id": "hello_provider",
  "name": "Hello 生成源",
  "kind": "image",
  "provider_type": "code",
  "language": "python",
  "code": "async def generate(ctx, api):\n    return {'image_url': 'https://example.com/hello.png'}\n"
}
```

## 工作流
把 ComfyUI 导出的工作流 JSON 放到 `capability/workflows/`，并在 `plugin.json` 的
`contributes.capability.workflows` 中声明 `workflows/*.json`。

## MCP 工具
把 `PLUGIN_TOOLS` 查壳文件放到 `capability/tools/`，在 `contributes.capability.tools`
中声明 `tools/*.py`。工具执行需要 `STUDIO_TRUSTED_MODE=1`。
""",
    "canvas": """# 画布域示例

## 声明式节点
`canvas/nodes/hello.json`

```json
{
  "id": "hello_node",
  "name": "Hello 节点",
  "kind": "utility",
  "inputs": [{"id": "text", "label": "文本", "type": "text"}],
  "outputs": [{"id": "text", "label": "文本", "type": "text", "from": "text"}],
  "run": {"extension": "custom_node:hello_code", "map": {"text": "$in.text"}}
}
```

## 代码节点
`canvas/code/hello_code.json`，在 `contributes.canvas.codeNodes` 中声明
`canvas/code/*.json`。代码节点需要 `input_schema`、`params_schema` 与 `run.code`。
""",
    "workspace": """# 工作台域示例

## 主题
`workspace/themes/hello-theme.json`

```json
{
  "id": "hello-theme",
  "name": "Hello 主题",
  "mode": "all",
  "vars": {"--color-brand": "#7c3aed", "--color-bg": "#0b0b0f"}
}
```

## 分镜槽
`workspace/slots/hello-tab.json`

```json
{
  "slot": "shot.tabs",
  "id": "hello-tab",
  "label": "Hello",
  "order": 50,
  "blocks": [{"kind": "info", "text": "来自 Hello 插件"}]
}
```

导出器与导演包分别放在 `workspace/exporters/`、`workspace/director_packs/`。
""",
    "agent": """# 智能体域示例

## 技能
`agent/skills/hello/SKILL.md`

```markdown
---
name: hello
description: 一个最小技能示例
---

收到用户请求后，先复述目标，再给出三条可执行建议。
```

## 角色与导演组
角色画像放 `agent/profiles/*.json`，导演组放 `agent/teams/*.json`；
在 `plugin.json` 的 `contributes.agent` 中分别声明 `profiles` 与 `teams`。
""",
}


def scaffold_plugin(pid: str, name: str, domain: str = "capability",
                    description: str = "", author: str = "") -> Dict[str, Any]:
    """生成一个 v2 四域插件骨架（只写 storage/plugins，不启用、不执行代码）。"""
    pid = str(pid or "").strip()
    if not _ID_RE.match(pid):
        raise ValueError("插件id非法：小写字母数字中划线，2~64字符")
    domain = str(domain or "capability").strip()
    if domain not in V2_DOMAINS:
        raise ValueError(f"domain 非法: {domain}，支持 {list(V2_DOMAINS)}")
    name = str(name or "").strip() or pid
    dest = os.path.join(_plugins_root(), pid)
    manifest = {
        "schema": 2,
        "id": pid,
        "name": name,
        "version": "1.0.0",
        "description": str(description or "").strip(),
        "author": str(author or "").strip(),
        "publisher": str(author or "").strip() or pid,
        "license": "MIT",
        "domains": [domain],
        "contributes": {domain: {}},
    }
    validate_manifest_dict(manifest)
    readme = (
        f"# {name}\n\n"
        f"{manifest['description'] or '一个最小可用的 v2 插件骨架。'}\n\n"
        f"域：`{domain}`（{V2_DOMAINS[domain]['label']}）\n\n"
        "## 目录\n"
        f"- `plugin.json`：插件清单，`contributes.{domain}` 下声明扩展点。\n"
        f"- `examples/{domain}.md`：该域的示例与契约。\n\n"
        "## 下一步\n"
        f"1. 按 `examples/{domain}.md` 把真实贡献文件放进插件目录。\n"
        f"2. 在 `plugin.json` 的 `contributes.{domain}` 中补上 glob（如 `themes/*.json`）。\n"
        "3. 回到插件中心点「启用」。\n"
    )
    with _LOCK:
        if os.path.exists(dest):
            raise ValueError(f"插件目录已存在: {pid}")
        os.makedirs(dest, exist_ok=False)
        files: List[str] = []
        try:
            with open(os.path.join(dest, "plugin.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            files.append("plugin.json")
            with open(os.path.join(dest, "README.md"), "w", encoding="utf-8") as f:
                f.write(readme)
            files.append("README.md")
            ex_dir = os.path.join(dest, "examples")
            os.makedirs(ex_dir, exist_ok=True)
            with open(os.path.join(ex_dir, f"{domain}.md"), "w", encoding="utf-8") as f:
                f.write(_SCAFFOLD_EXAMPLES[domain])
            files.append(f"examples/{domain}.md")
        except Exception:
            shutil.rmtree(dest, ignore_errors=True)
            raise
    return {
        "status": "scaffolded",
        "id": pid,
        "name": name,
        "domain": domain,
        "path": dest,
        "files": files,
        "manifest": manifest,
        "next": f"编辑 {pid}/plugin.json 后 POST /plugins/{pid}/enable",
    }


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
    """执行查壳插件工具：trusted总闸 + 必填校验 + 20分钟超时 + 结果截断。供mcp execute_tool分支调用。"""
    from app.mcp.server import _trusted_gate_or_raise
    from app.extensions import telemetry
    started = time.time()
    ext_id = f"mcp_tool:{tool_name}"
    h = _PLUGIN_TOOL_HANDLERS.get(tool_name)
    if not h:
        telemetry.record(ext_id, False, 0, kind="mcp_tool", error="未注册")
        raise ValueError(f"插件工具未注册（插件可能被禁用）: {tool_name}")
    try:
        from app.extensions import guard
        guard.ensure_enabled("mcp_tool", tool_name)
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
        out = ({"output": s[:_PLUGIN_TOOL_MAX_OUT] + "…[截断]", "truncated": True}
               if len(s) > _PLUGIN_TOOL_MAX_OUT
               else (result if isinstance(result, dict) else {"output": result}))
        telemetry.record(ext_id, True, int((time.time() - started) * 1000), kind="mcp_tool")
        return out
    except Exception as e:
        telemetry.record(ext_id, False, int((time.time() - started) * 1000), kind="mcp_tool",
                         error=e, timeout=isinstance(e, (asyncio.TimeoutError, TimeoutError)))
        raise


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
    with _LOCK:
        return _enable_locked(pid)


def _enable_locked(pid: str) -> Dict[str, Any]:
    root = _plugins_root()
    pdir = os.path.join(root, pid)
    if not os.path.isdir(pdir):
        raise ValueError(f"插件不存在: {pid}")
    m = _read_manifest(pdir)
    if m.id != pid:
        raise ValueError("目录名与manifest id不一致")
    deps = _check_dependencies(m, require_enabled=True)
    if deps["missing"]:
        raise ValueError(f"缺少依赖插件: {', '.join(deps['missing'])}")
    if deps["mismatch"]:
        raise ValueError("依赖版本不满足: " + "；".join(deps["mismatch"]))
    if deps["disabled"]:
        raise ValueError(f"依赖插件尚未启用: {', '.join(deps['disabled'])}")
    # 贡献物撞名预检（未完成清单第 19 条）：注册任何东西之前先拒绝，
    # 避免「启用成功但一半贡献被静默跳过」
    conflicts = _preflight_contribution_conflicts(pdir, m, pid)
    if conflicts:
        raise ValueError("贡献物撞名，已拒绝启用（请改用唯一 id 或先卸载冲突来源）: "
                         + "；".join(conflicts))
    idx = _load_index()
    rec = idx.setdefault("plugins", {}).setdefault(pid, {"version": m.version, "enabled": False, "installed_at": "", "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [], "custom_nodes": [], "canvas_nodes": [], "theme_ids": [], "exporter_ids": [], "director_pack_ids": []})
    if rec.get("enabled"):
        return {"id": pid, "enabled": True, "note": "已启用，无需重复操作"}
    summary: Dict[str, Any] = {"providers": [], "skills": [], "workflows": [], "mcp_tools": [], "custom_nodes": [], "canvas_nodes": [], "themes": [], "exporters": [], "director_packs": [], "agent_profiles": [], "agent_teams": [], "warnings": []}
    # 扩展点 glob 无命中告警（未完成清单第 21 条）
    _warn_empty_globs(pdir, m.extensionPoints, summary["warnings"])
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
            _resolve_code_ref(pdir, rel, definition, summary["warnings"])
            if custom_provider_manager.get_definition(definition.id):
                summary["warnings"].append(f"已存在同名源已跳过: {definition.id}")
                continue
            custom_provider_manager.save_definition(definition)
            ok = register_single_custom_provider(definition)
            provider_ids.append(definition.id)
            summary["providers"].append({"id": definition.id, "kind": definition.kind, "registered": bool(ok)})
        except Exception as e:
            summary["warnings"].append(f"provider失败 {rel}: {e}")

    # —— skills：拷贝到 server/skills/.plugins/<pid>/<pid>__<name>/，并物理命名空间化 ——
    try:
        from app.skills.engine import skill_engine
        trot = os.path.join(_skills_target_root(), pid)
        os.makedirs(trot, exist_ok=True)
        used_native: set = set()
        for rel in _glob_kind(pdir, m.extensionPoints.skills):
            if os.path.basename(rel) != "SKILL.md":
                summary["warnings"].append(f"skill须为SKILL.md，已跳过: {rel}")
                continue
            skill_dir = os.path.dirname(rel) or "skill"
            sname = os.path.basename(os.path.normpath(skill_dir))
            native = f"{_pid_norm(pid)}__{sname}"
            n = 2
            while native in used_native:
                native = f"{_pid_norm(pid)}__{sname}_{n}"
                n += 1
            used_native.add(native)
            dest_dir = os.path.join(trot, native)
            os.makedirs(dest_dir, exist_ok=True)
            dest_file = os.path.join(dest_dir, "SKILL.md")
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    raw = f.read()
                with open(dest_file, "w", encoding="utf-8") as f:
                    f.write(_namespace_skill_name(raw, native))
            except Exception:
                shutil.copy2(os.path.join(pdir, rel), dest_file)
            installed_files.append(dest_file)
            skill_names.append(native)
            summary["skills"].append({"native": native, "original": sname})
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
                _resolve_code_ref(pdir, rel, definition, summary["warnings"])
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

    # —— canvas_nodes：声明式画布节点（JSON），体检入库 + 画布工具栏动态挂载 ——
    canvas_ids: List[str] = []
    try:
        from app.canvas_nodes.manager import canvas_node_manager
        from app.canvas_nodes.models import CanvasNodeSpec as _CNS
        for rel in _glob_kind(pdir, m.extensionPoints.canvas_nodes):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                definition = _CNS.model_validate(payload)
                if canvas_node_manager.get(definition.id):
                    summary["warnings"].append(f"已存在同名节点已跳过: {definition.id}")
                    continue
                saved = canvas_node_manager.save(definition)
                canvas_ids.append(saved.id)
                summary["canvas_nodes"].append({"id": saved.id, "kind": saved.kind})
            except Exception as e:
                summary["warnings"].append(f"画布节点失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"canvas_nodes子系统不可用: {e}")

    # —— themes：主题变量包（JSON），入库 + 前端主题选择器可见 ——
    theme_ids: List[str] = []
    try:
        from app.themes.manager import theme_manager
        from app.themes.models import ThemeSpec as _TS
        for rel in _glob_kind(pdir, m.extensionPoints.themes):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                spec = _TS.model_validate(payload)
                if theme_manager.get(spec.id):
                    summary["warnings"].append(f"已存在同名主题已跳过: {spec.id}")
                    continue
                saved = theme_manager.save(spec)
                theme_ids.append(saved.id)
                summary["themes"].append({"id": saved.id, "mode": saved.mode})
            except Exception as e:
                summary["warnings"].append(f"主题失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"themes子系统不可用: {e}")

    # —— exporters：声明式导出器（JSON），入库 + 导出中心可见 ——
    exporter_ids: List[str] = []
    try:
        from app.exporters.manager import exporter_manager
        from app.exporters.models import ExporterSpec as _ES
        for rel in _glob_kind(pdir, m.extensionPoints.exporters):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                spec = _ES.model_validate(payload)
                if exporter_manager.get(spec.id):
                    summary["warnings"].append(f"已存在同名导出器已跳过: {spec.id}")
                    continue
                saved = exporter_manager.save(spec)
                exporter_ids.append(saved.id)
                summary["exporters"].append({"id": saved.id, "extension": saved.run.extension})
            except Exception as e:
                summary["warnings"].append(f"导出器失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"exporters子系统不可用: {e}")

    # —— director_packs：导演台扩展包（JSON），入库 + 导演台预设/道具/环境可见 ——
    pack_ids: List[str] = []
    try:
        from app.director_packs.manager import director_pack_manager
        from app.director_packs.models import DirectorPackSpec as _DS
        for rel in _glob_kind(pdir, m.extensionPoints.director_packs):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                spec = _DS.model_validate(payload)
                if director_pack_manager.get(spec.id):
                    summary["warnings"].append(f"已存在同名导演包已跳过: {spec.id}")
                    continue
                saved = director_pack_manager.save(spec)
                pack_ids.append(saved.id)
                summary["director_packs"].append({"id": saved.id})
            except Exception as e:
                summary["warnings"].append(f"导演包失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"director_packs子系统不可用: {e}")

    # —— agent_profiles / agent_teams：导演组扩展（JSON），入库 + subagent_run 可委派 ——
    agent_profile_ids: List[str] = []
    agent_team_ids: List[str] = []
    try:
        from app.agent_teams.manager import agent_team_manager, validate_team_members
        from app.agent_teams.models import AgentProfileSpec as _APS
        from app.agent_teams.models import AgentTeamSpec as _ATS
        try:
            from app.agent.runtime.agents import builtin_role_names
            _builtin_roles = builtin_role_names()
        except Exception:
            _builtin_roles = set()
        for rel in _glob_kind(pdir, m.extensionPoints.agent_profiles):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                spec = _APS.model_validate(payload)
                if spec.id in _builtin_roles and not spec.override:
                    summary["warnings"].append(
                        f"角色 {spec.id} 与内置角色重名（需 override=true 才允许替换）已跳过")
                    continue
                if agent_team_manager.get_profile_spec(spec.id):
                    summary["warnings"].append(f"已存在同名角色已跳过: {spec.id}")
                    continue
                saved = agent_team_manager.save_profile(spec)
                agent_profile_ids.append(saved.id)
                summary["agent_profiles"].append({"id": saved.id, "override": bool(saved.override)})
            except Exception as e:
                summary["warnings"].append(f"角色失败 {rel}: {e}")
        for rel in _glob_kind(pdir, m.extensionPoints.agent_teams):
            if not rel.lower().endswith(".json"):
                summary["warnings"].append(f"跳过非JSON: {rel}")
                continue
            try:
                with open(os.path.join(pdir, rel), "r", encoding="utf-8") as f:
                    payload = json.load(f)
                spec = _ATS.model_validate(payload)
                if agent_team_manager.get_team(spec.id):
                    summary["warnings"].append(f"已存在同名导演组已跳过: {spec.id}")
                    continue
                member_errors = validate_team_members(spec)
                if member_errors:
                    summary["warnings"].append(f"导演组 {spec.id} 成员校验失败已跳过: {'；'.join(member_errors)}")
                    continue
                saved = agent_team_manager.save_team(spec)
                agent_team_ids.append(saved.id)
                summary["agent_teams"].append({"id": saved.id, "members": len(saved.members)})
            except Exception as e:
                summary["warnings"].append(f"导演组失败 {rel}: {e}")
    except Exception as e:
        summary["warnings"].append(f"agent_teams子系统不可用: {e}")

    try:
        from app.mcp.server import mcp_registry
        mcp_registry.refresh_provider_tools()
    except Exception:
        pass

    rec.update({"version": m.version, "enabled": True,
                "installed_at": rec.get("installed_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
                "installed_files": installed_files, "provider_ids": provider_ids,
                "skill_names": skill_names, "workflow_ids": workflow_ids, "mcp_tools": registered_tools,
                "custom_nodes": custom_ids, "canvas_nodes": canvas_ids,
                "theme_ids": theme_ids, "exporter_ids": exporter_ids, "director_pack_ids": pack_ids,
                "agent_profile_ids": agent_profile_ids, "agent_team_ids": agent_team_ids})
    _save_index(idx)
    summary.update({"id": pid, "enabled": True})
    return summary


def disable(pid: str) -> Dict[str, Any]:
    with _LOCK:
        return _disable_locked(pid)


def _disable_locked(pid: str) -> Dict[str, Any]:
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
    # 声明式画布节点：删定义（仅追踪到的id）
    try:
        from app.canvas_nodes.manager import canvas_node_manager
        for cnid in rec.get("canvas_nodes", []):
            try:
                canvas_node_manager.delete(cnid)
            except Exception as e:
                warnings.append(f"画布节点删除失败 {cnid}: {e}")
            removed.append(f"canvas_node:{cnid}")
    except Exception as e:
        warnings.append(f"canvas_nodes子系统不可用: {e}")
    # 主题包 / 导出器 / 导演包：删定义（仅追踪到的id）
    try:
        from app.themes.manager import theme_manager
        for tid in rec.get("theme_ids", []):
            try:
                theme_manager.delete(tid)
            except Exception as e:
                warnings.append(f"主题删除失败 {tid}: {e}")
            removed.append(f"theme:{tid}")
    except Exception as e:
        warnings.append(f"themes子系统不可用: {e}")
    try:
        from app.exporters.manager import exporter_manager
        for eid in rec.get("exporter_ids", []):
            try:
                exporter_manager.delete(eid)
            except Exception as e:
                warnings.append(f"导出器删除失败 {eid}: {e}")
            removed.append(f"exporter:{eid}")
    except Exception as e:
        warnings.append(f"exporters子系统不可用: {e}")
    try:
        from app.director_packs.manager import director_pack_manager
        for dpid in rec.get("director_pack_ids", []):
            try:
                director_pack_manager.delete(dpid)
            except Exception as e:
                warnings.append(f"导演包删除失败 {dpid}: {e}")
            removed.append(f"director_pack:{dpid}")
    except Exception as e:
        warnings.append(f"director_packs子系统不可用: {e}")
    # 导演组扩展（角色画像 / 导演组）：删定义（仅追踪到的id）
    try:
        from app.agent_teams.manager import agent_team_manager
        for apid in rec.get("agent_profile_ids", []):
            try:
                agent_team_manager.delete_profile(apid)
            except Exception as e:
                warnings.append(f"角色删除失败 {apid}: {e}")
            removed.append(f"agent_profile:{apid}")
        for atid in rec.get("agent_team_ids", []):
            try:
                agent_team_manager.delete_team(atid)
            except Exception as e:
                warnings.append(f"导演组删除失败 {atid}: {e}")
            removed.append(f"agent_team:{atid}")
    except Exception as e:
        warnings.append(f"agent_teams子系统不可用: {e}")
    # 落盘文件：仅删追踪到的
    for fp in rec.get("installed_files", []):
        try:
            ap = os.path.abspath(fp)
            if os.path.isfile(ap):
                os.remove(ap)
                removed.append(ap)
        except Exception as e:
            warnings.append(f"删除失败 {fp}: {e}")
    # 清理该插件的技能目录（含命名空间子目录）
    try:
        trot = os.path.join(_skills_target_root(), pid)
        if os.path.isdir(trot):
            shutil.rmtree(trot, ignore_errors=True)
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
    rec.update({"enabled": False, "installed_files": [], "provider_ids": [], "skill_names": [], "workflow_ids": [], "mcp_tools": [], "custom_nodes": [], "canvas_nodes": [], "theme_ids": [], "exporter_ids": [], "director_pack_ids": [], "agent_profile_ids": [], "agent_team_ids": []})
    _save_index(idx)
    return {"id": pid, "enabled": False, "removed": removed, "warnings": warnings}


def uninstall(pid: str) -> Dict[str, Any]:
    """卸载：**先完整停用（回滚全部贡献），成功后才删目录与索引**。

    审查第 20 条：此前是 `try: disable(pid) except Exception: pass` 之后照样删目录 + pop 索引 ——
    disable 中途失败时已注册的贡献会变成**无法再回滚的孤儿**（索引记录一并丢了，再也找不到它们）。
    现在改为 fail-safe：停用不成功就**不删**，让「目录 / 索引 / 贡献」三者保持可重试的一致状态。
    """
    with _LOCK:
        try:
            dis = disable(pid)
        except Exception as e:
            raise ValueError(f"卸载中止：停用失败，插件与索引已保留（可重试）: {e}")
        root = _plugins_root()
        pdir = os.path.join(root, pid)
        if os.path.isdir(pdir):
            shutil.rmtree(pdir, ignore_errors=True)
        idx = _load_index()
        (idx.get("plugins") or {}).pop(pid, None)
        _save_index(idx)
        _WATCH_SNAPSHOT.pop(pid, None)
        out: Dict[str, Any] = {"id": pid, "uninstalled": True}
        # 停用期的告警不再被吞掉（例如某个贡献删不掉），交给调用方展示
        warns = list((dis or {}).get("warnings") or [])
        if warns:
            out["warnings"] = warns
        return out


def reload_plugin(pid: str) -> Dict[str, Any]:
    """热重载单个插件：启用中则 disable→enable 重读全部贡献；未启用仅重扫。

    审查第 22 条：此前 enable 失败会让插件**停在未启用态**（重载前的「已启用」状态直接丢失）。
    现在失败时先尽力回滚到重载前的启用态，再把「最终处于什么状态」写进报错 ——
    否则一次失败的 reload 会静默地把插件停掉。
    """
    with _LOCK:
        idx = _load_index()
        rec = (idx.get("plugins") or {}).get(pid) or {}
        was_enabled = bool(rec.get("enabled"))
    if not was_enabled:
        return {"id": pid, "reloaded": True, "enabled": False,
                "note": "未启用，仅重扫 manifest 与贡献"}
    disable(pid)
    try:
        ret = enable(pid)
    except Exception as e:
        # 状态回滚：贡献已被 disable 拆掉，只能靠再 enable 一次恢复
        try:
            enable(pid)
            state = "已回滚到重载前的「已启用」状态"
        except Exception as e2:
            state = f"当前为「已停用」（回滚亦失败: {e2}）"
        raise ValueError(f"重载失败：{e}；{state}")
    return {"id": pid, "reloaded": True, "enabled": True, "detail": ret}


def _dir_mtime(pid: str) -> float:
    pdir = os.path.join(_plugins_root(), pid)
    latest = 0.0
    try:
        for dp, _dn, fns in os.walk(pdir):
            for fn in fns:
                try:
                    latest = max(latest, os.path.getmtime(os.path.join(dp, fn)))
                except Exception:
                    continue
    except Exception:
        pass
    return latest


def scan_plugin_changes() -> List[str]:
    """对比插件目录 mtime，返回内容有变化的插件 id 列表（供文件监听热重载）。"""
    changed: List[str] = []
    root = _plugins_root()
    try:
        entries = [e for e in os.listdir(root) if os.path.isdir(os.path.join(root, e))]
    except Exception:
        return changed
    for pid in entries:
        if pid.startswith(".staging-"):
            continue
        mt = _dir_mtime(pid)
        prev = _WATCH_SNAPSHOT.get(pid)
        _WATCH_SNAPSHOT[pid] = mt
        if prev is not None and mt > prev:
            changed.append(pid)
    return changed


def start_plugin_watcher(interval: float = 3.0, auto_reload: bool = True) -> Dict[str, Any]:
    """启动后台文件监听线程：插件目录变化时自动热重载启用中的插件。

    由环境变量 STUDIO_PLUGIN_WATCH=0 关闭。返回启动状态（幂等）。
    """
    global _watcher_thread
    if os.environ.get("STUDIO_PLUGIN_WATCH", "1") in ("0", "false", "False"):
        return {"started": False, "reason": "disabled_by_env"}
    with _LOCK:
        if _watcher_thread and _watcher_thread.is_alive():
            return {"started": True, "reason": "already_running"}
        _watcher_stop.clear()

        def _loop():
            # 首轮只建基线，不触发热重载
            try:
                scan_plugin_changes()
            except Exception:
                pass
            while not _watcher_stop.wait(max(0.5, float(interval))):
                try:
                    changed = scan_plugin_changes()
                    if not changed:
                        continue
                    for pid in changed:
                        try:
                            if auto_reload:
                                reload_plugin(pid)
                            else:
                                discover()
                        except Exception:
                            continue
                except Exception:
                    continue

        _watcher_thread = threading.Thread(target=_loop, name="plugin-watcher", daemon=True)
        _watcher_thread.start()
    return {"started": True, "interval": interval, "auto_reload": auto_reload}


def stop_plugin_watcher() -> None:
    _watcher_stop.set()
