# -*- coding: utf-8 -*-
"""代码型生成源的「隐式配置」识别与迁移。

问题：自定义代码源常把 Key / 网关地址 / 工作流 ID 直接写在代码里。
设置页只看到一个空的 Key 输入框——用户既看不出这个源实际用哪把 Key、连哪个网关，
想换还得去翻代码；而且这些明文值会随 provider 定义一起落盘、进仓库。

本模块只做两件事，都不碰网络、不改执行语义：
  1. ``scan_code_config``   —— 只读识别：代码里写死了哪些常量，哪些是疑似密钥
                                （含 ``ctx.get("api_key") or "xxx"`` 这类兜底字面量）
  2. ``rewrite_inline_key`` —— 把内联密钥改写成「运行时从配置读」的安全机械改写
                                （仅 python；JS 的 const 常量不能安全重赋值，只提示）

口径（前后端一致）：
  key_source = ``stored``（配置存储 CUSTOM_PROVIDER_<id> 有值，运行时优先用它）
             | ``inline``（代码里写了密钥字面量）
             | ``none``
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# 常量赋值：NAME = "literal"（允许 f- 前缀；值内不含引号，够覆盖真实源写法）
_CONST_ASSIGN_RE = re.compile(
    r"^([ \t]*)([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*f?(['\"])([^'\"]{4,})\3[ \t]*$",
    re.MULTILINE,
)

# 兜底字面量：ctx.get("api_key") or "xxx" / ctx.api_key || "xxx"
# 中间的 or 段允许任意内容（真实源里出现过
# `ctx.get("api_key") or api.get("get_api_key", lambda: "")() or "xxx"` 这种夹了一层延迟链的写法）。
# 取「同一行里第一个 ≥16 字符的字面量」—— 阈值用来跳过 "get_api_key" 这类短串。
_CTX_KEY_FALLBACK_RE = re.compile(
    r"(?:ctx\.get\(\s*['\"](?:api_key|key|token|api_token|access_token)['\"]\s*\)|ctx\.(?:api_key|key|token))"
    r"[^\n]*?(?:or|\|\|)\s*(['\"])([^'\"]{16,})\1"
)

# 任意字符串字面量（>=16 字符）：最后一道兜底，抓"不在 NAME = "xxx" 位置上的密钥"
_ANY_STRING_RE = re.compile(r"(['\"])([^'\"\n]{16,})\1")

# 运行时确实会读注入 Key 的写法 —— 决定「只写入配置存储」是否立刻生效。
# 沙箱只有两个注入点：ctx["api_key"] 与 api["get_api_key"]（lambda: ctx.get("api_key","")），
# 三种写法都要认，漏一种就会把"读得到"的源误报成"填了不生效"。
_READS_CTX_KEY_RE = re.compile(
    r"ctx\.get\(\s*['\"](?:api_key|key|token|api_token|access_token)['\"]"
    r"|ctx\[['\"](?:api_key|key|token|api_token|access_token)['\"]\]"
    r"|ctx\.(?:api_key|key|token)\b"
    r"|api\.get\(\s*['\"](?:api_key|key|token|get_api_key)['\"]"
    r"|api\[['\"](?:api_key|key|get_api_key)['\"]\]"
    r"|api\.(?:api_key|key|get_api_key)\b"
)

# 入口函数声明（改写时在其后注入 global 恢复语句）
_ENTRY_RE = re.compile(r"^(async\s+def\s+generate\s*\(.*?\)\s*:\s*)$", re.MULTILINE)

_SECRET_NAME_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWD|PASSWORD|SIGN|AUTH|CREDENTIAL)", re.I)
_RANDOMISH_RE = re.compile(r"[A-Za-z0-9_\-]{20,}")

_KIND_LABEL = {"url": "接口地址", "secret": "疑似密钥", "value": "普通常量"}


def mask_secret(value: str, head: int = 4, tail: int = 4) -> str:
    """掩码：保留头尾各 head/tail 位，中间固定 8 个星号。"""
    s = str(value or "")
    if not s:
        return ""
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}{'*' * 8}{s[-tail:]}"


def looks_secret(name: str, value: str) -> bool:
    """疑似密钥：名字含 KEY/TOKEN/SECRET…，或"大小写混杂的长随机串 / 长 hex"。

    反例必须排除：`minimax_h3_image_audio_to_video_v2_15s` 这类**小写下划线 slug**
    （工作流 ID）看着也像随机串，但它不是密钥——误判会让「迁移」对错误的字面量下手。
    """
    if _SECRET_NAME_RE.search(name or ""):
        return True
    v = str(value or "")
    if not _RANDOMISH_RE.fullmatch(v):
        return False
    has_digit = any(c.isdigit() for c in v)
    has_upper = any(c.isupper() for c in v)
    has_lower = any(c.islower() for c in v)
    if has_digit and has_upper and has_lower:
        return True
    return len(v) >= 24 and re.fullmatch(r"[0-9a-fA-F]+", v) is not None


def scan_code_config(code: str) -> Dict[str, Any]:
    """只读扫出代码里写死的配置：常量清单 + ctx 兜底字面量。不做任何修改。"""
    text = code or ""
    constants: List[Dict[str, Any]] = []
    seen = set()
    for m in _CONST_ASSIGN_RE.finditer(text):
        indent, name, value = m.group(1), m.group(2), m.group(4)
        if (name, value) in seen:
            continue
        seen.add((name, value))
        if value.lower().startswith(("http://", "https://")):
            kind = "url"
        elif looks_secret(name, value):
            kind = "secret"
        else:
            kind = "value"
        constants.append({
            "name": name,
            "kind": kind,
            "kind_label": _KIND_LABEL[kind],
            "value": value,
            "masked": mask_secret(value) if kind == "secret" else value,
            "line": text[:m.start()].count("\n") + 1,
            "module_level": not indent,
        })

    fallbacks: List[Dict[str, Any]] = []
    for m in _CTX_KEY_FALLBACK_RE.finditer(text):
        value = m.group(2)
        fallbacks.append({
            "kind": "secret",
            "kind_label": _KIND_LABEL["secret"],
            "value": value,
            "masked": mask_secret(value),
            "line": text[:m.start()].count("\n") + 1,
        })

    # 兜底：任何位置上"疑似密钥的长字面量"（不在常量位、也不在 ctx 兜底链里也能抓出来）
    reported = {c["value"] for c in constants} | {f["value"] for f in fallbacks}
    loose: List[Dict[str, Any]] = []
    for m in _ANY_STRING_RE.finditer(text):
        value = m.group(2)
        if value in reported or not looks_secret("", value):
            continue
        reported.add(value)
        loose.append({
            "kind": "secret",
            "kind_label": _KIND_LABEL["secret"],
            "value": value,
            "masked": mask_secret(value),
            "line": text[:m.start()].count("\n") + 1,
        })

    return {"constants": constants, "ctx_fallbacks": fallbacks, "loose_literals": loose}


def effective_config(definition) -> Dict[str, Any]:
    """该源实际生效的配置：Key 从哪来 + 代码里还写死了什么。"""
    from app.providers.generic.code_provider import _get_api_key_for_provider

    pid = getattr(definition, "id", "") or ""
    code = getattr(definition, "code", "") or ""
    scan = scan_code_config(code)
    stored = _get_api_key_for_provider(pid, definition)
    auth = getattr(definition, "auth", None)
    env_name = (getattr(auth, "key_env", None) or f"CUSTOM_PROVIDER_{pid}")
    # 常量里的密钥优先；其次是 ctx 兜底字面量
    inline_const = next((c for c in scan["constants"] if c["kind"] == "secret"), None)
    fallback = scan["ctx_fallbacks"][0] if scan["ctx_fallbacks"] else None
    loose = scan["loose_literals"][0] if scan["loose_literals"] else None
    if inline_const:
        inline_value, origin = inline_const["value"], "constant"
    elif fallback:
        inline_value, origin = fallback["value"], "ctx_fallback"
    elif loose:
        inline_value, origin = loose["value"], "literal"
    else:
        inline_value, origin = "", ""

    if stored:
        source = "stored"
    elif inline_value:
        source = "inline"
    else:
        source = "none"

    return {
        "provider_id": pid,
        "language": getattr(definition, "language", "") or "python",
        "env_name": env_name,
        "key_source": source,
        "stored_key": stored,
        "stored_masked": mask_secret(stored),
        "inline_key": inline_value,
        "inline_key_masked": mask_secret(inline_value),
        "inline_key_name": (inline_const or {}).get("name") or "",
        "inline_key_origin": origin,
        "reads_ctx_key": bool(_READS_CTX_KEY_RE.search(code)),
        "constants": scan["constants"],
        "ctx_fallbacks": scan["ctx_fallbacks"],
        "loose_literals": scan["loose_literals"],
    }


def rewrite_inline_key(
    code: str,
    language: str,
    literal: str,
    const_name: Optional[str],
    env_name: str,
) -> Tuple[str, List[str]]:
    """把内联 Key 改写成「运行时从配置读」。返回 (新代码, 改动说明)。

    只做两种机械改写，且仅 python（JS 里 ``const`` 常量无法安全重赋值，一律只提示）：
      1. 常量赋值处 ``NAME = "xxx"`` → ``NAME = ""``，并在 ``generate`` 入口注入
         ``global NAME`` + ``NAME = NAME or (ctx.get("api_key") or "")``
         —— 常量只在 generate 内被读，注入即可保证行为不变（配置存储优先、字面量仅作兜底）；
      2. 表达式内字面量（如 ``ctx.get("api_key") or "xxx"``）→ 直接去掉字面量。

    找不到入口函数时**不做任何改写**（宁可只提示，也不能把源改坏）。
    """
    if (language or "python").lower() not in ("python", "py") or not literal:
        return code, []
    new = code or ""
    notes: List[str] = []

    if const_name:
        if not _ENTRY_RE.search(new):
            return code, ["未找到 generate 入口，无法安全改写 —— 请手工把该常量改为读 ctx.get(\"api_key\")"]
        pat = re.compile(
            rf"^([ \t]*{re.escape(const_name)}[ \t]*=[ \t]*f?)(['\"]){re.escape(literal)}\2",
            re.MULTILINE,
        )
        if not pat.search(new):
            return code, []
        new = pat.sub(r'\1""', new, count=1)
        notes.append(f"{const_name} 的字面量已置空")
        new = _ENTRY_RE.sub(
            lambda m: (
                f"{m.group(1)}\n"
                f"    global {const_name}\n"
                f'    {const_name} = {const_name} or (ctx.get("api_key") or "")'
                f"  # Studio 注入（{env_name}）：配置存储优先，上面的字面量仅作兜底"
            ),
            new,
            count=1,
        )
        notes.append(f"generate 入口已注入 global {const_name} 恢复语句")
        return new, notes

    if literal in new:
        new = new.replace(literal, "")
        notes.append('表达式内字面量已移除，改由 ctx.get("api_key") 读取')
    return new, notes


# ============================================================
# Key 管理单一实现（HTTP 路由 / MCP 工具 / 前端共用）
# 口径：Key 一律进「配置存储」（设置→生成源），代码里不许留明文。
# ============================================================

def store_key(provider_id: str, api_key: str) -> bool:
    """把 Key 写入配置存储（config_store.json + 进程环境变量）。空值/失败返回 False。

    这是「设置→生成源 填 Key」与「内联 Key 迁移」唯一落盘口，避免多处各写一份。
    """
    if not api_key:
        return False
    try:
        import json as _json
        import os as _os
        from app.core.config import settings as _settings
        cfg_path = _os.path.join(_settings.STORAGE_DIR, "config_store.json")
        data: Dict[str, Any] = {}
        if _os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                try:
                    data = _json.load(f)
                except Exception:
                    data = {}
        if not isinstance(data.get("custom_providers"), dict):
            data["custom_providers"] = {}
        data["custom_providers"][provider_id] = {"api_key": api_key}
        data[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
        with open(cfg_path, "w", encoding="utf-8") as f:
            _json.dump(data, f, ensure_ascii=False, indent=2)
        _os.environ[f"CUSTOM_PROVIDER_{provider_id}"] = api_key
        return True
    except Exception as e:
        print(f"[InlineConfig] save api_key failed: {e}")
        return False


def key_status(definition) -> Dict[str, Any]:
    """Key 状态（只读，全部掩码、绝不含明文）——给 Agent / UI 看清"Key 从哪来、要不要迁移"。

    key_source：
      - stored：配置存储（设置→生成源）有值，运行时优先用它；
      - inline：代码里写死明文（reads_ctx_key=false 时设置页填 Key 也不生效，必须迁移）；
      - none  ：未配置。
    """
    eff = effective_config(definition)
    src = eff.get("key_source", "none")
    label = {"stored": "配置存储（设置→生成源）", "inline": "代码内联明文（建议迁移）", "none": "未配置"}.get(src, src)
    hint = ""
    if src == "none":
        hint = "未配置 Key：请在「设置→生成源」填入（或让用户填入），不要写进代码。"
    elif src == "inline":
        hint = ("代码里写死了明文 Key：建议迁移到配置存储（migrate_provider_inline_key，Key 不会进入对话上下文）；"
                + ("该源不读注入 Key，设置页填的 Key 当前不生效。" if not eff.get("reads_ctx_key") else "该源读注入 Key，迁移后设置页改 Key 即刻生效。"))
    else:
        hint = "Key 已在配置存储；换 Key 请到「设置→生成源」，改完用「测试→实测」验证。"
    return {
        "provider_id": eff.get("provider_id", ""),
        "key_source": src,
        "key_from": label,
        "key_masked": eff.get("stored_masked") or eff.get("inline_key_masked") or "",
        "reads_ctx_key": bool(eff.get("reads_ctx_key")),
        "migratable": bool(eff.get("inline_key")),
        "env_name": eff.get("env_name", ""),
        "hint": hint,
    }


def migrate_inline_key(provider_id: str, rewrite_code: bool = True) -> Dict[str, Any]:
    """把代码里的内联 Key 迁到配置存储（可选改写代码为读 ctx 注入）。

    关键：Key 从代码里直接读出写盘，**不经过任何返回值/对话上下文**；返回体只有掩码。
    """
    from app.providers.custom.manager import custom_provider_manager

    pd = custom_provider_manager.get_definition(provider_id)
    if not pd:
        raise ValueError(f"Provider 不存在: {provider_id}")
    if getattr(pd, "provider_type", "") != "code":
        raise ValueError("仅代码型自定义源存在「隐式配置」，无需迁移")
    eff = effective_config(pd)
    literal = eff.get("inline_key") or ""
    if not literal:
        return {"status": "noop", "provider_id": provider_id, "key_status": key_status(pd),
                "note": "代码里没有找到内联 Key，无需迁移"}
    ok = store_key(provider_id, literal)
    if not ok:
        raise RuntimeError("写入配置存储失败（检查 storage/config_store.json 权限）")
    env_name = getattr(getattr(pd, "auth", None), "key_env", None) or f"CUSTOM_PROVIDER_{provider_id}"
    try:
        if getattr(pd, "auth", None) is None:
            from app.models.provider_definition import ProviderAuthConfig
            pd.auth = ProviderAuthConfig(type="bearer", key_env=env_name)
        elif not pd.auth.key_env:
            pd.auth.key_env = env_name
    except Exception:
        pass
    notes: List[str] = []
    if rewrite_code:
        new_code, notes = rewrite_inline_key(
            pd.code or "", pd.language or "python", literal, eff.get("inline_key_name") or None, env_name,
        )
        if new_code != (pd.code or ""):
            pd.code = new_code
    custom_provider_manager.save_definition(pd)
    try:
        from app.providers.init_providers import register_single_custom_provider
        register_single_custom_provider(pd)  # 热注册：运行中的进程立刻用上新代码/新 Key
    except Exception as e:
        print(f"[InlineConfig] migrate hot-register failed {provider_id}: {e}")
    try:
        from app.providers import verification
        verification.clear(provider_id)  # 代码/Key 变更 → 需重新测试
    except Exception:
        pass
    return {
        "status": "success",
        "provider_id": provider_id,
        "env_name": env_name,
        "rewritten": bool(notes),
        "notes": notes,
        "key_status": key_status(pd),
        "hint": "Key 已迁到配置存储（不再有明文进代码）；换 Key 在「设置→生成源」，改完用「测试→实测」验证。",
    }
