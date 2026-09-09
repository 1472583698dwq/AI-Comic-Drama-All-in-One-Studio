# -*- coding: utf-8 -*-
"""
自定义节点管理器 — 文件即仓库：storage/custom_nodes/<id>.json
执行复用代码源沙箱（_execute_python/js_code），用户写 run(inputs,params,ctx)，
运行时垫一层 shim 转为沙箱要求的 generate(ctx, api) 签名。
"""
import json
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from app.custom_nodes.models import CustomNodeDefinition

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,63}$")

def _py_shim(entry: str) -> str:
    # 沙箱 exec(code, g, l) 下运行时名字只从 g 解析，顶层追加的 shim 调不到 l 中的 run；
    # 因此把用户代码整体缩进包进入口闭包，run 变为闭包局部函数，调用必定可达。
    # （顶层 import/def 照常工作；如需网络请用 api.httpx，见 ctx["api"]）
    return (
        "\nasync def __studio_entry(ctx, api):\n"
        "    _inputs = (ctx or {}).get('inputs') or {}\n"
        "    _params = (ctx or {}).get('params') or {}\n"
        "    _ctx = dict(ctx or {}); _ctx['api'] = api\n"
        "{{USER_CODE}}\n"
        f"    return await {entry}(_inputs, _params, _ctx)\n"
    )


def _js_shim(entry: str) -> str:
    # JS 沙箱以 CommonJS 模块作用域执行，顶层函数互可见，直接追加 shim 即可；
    # 且沙箱自动按 ENTRY 导出，入口保持顶层。
    return (
        "\nasync function __studio_entry(ctx, api) {\n"
        "  const inputs = (ctx && ctx.inputs) || {};\n"
        "  const params = (ctx && ctx.params) || {};\n"
        "  const ctx2 = Object.assign({}, ctx || {}, {api});\n"
        f"  return await {entry}(inputs, params, ctx2);\n"
        "}\n"
    )


def _wrap_py_user_code(code: str, entry: str) -> str:
    body = "\n".join(("    " + ln) if ln.strip() else ln for ln in (code or "").split("\n"))
    return _py_shim(entry).replace("{{USER_CODE}}", body)


def _root() -> str:
    try:
        from app.core.config import settings
        base = os.path.abspath(settings.STORAGE_DIR)
    except Exception:
        base = os.path.abspath(os.path.join(os.getcwd(), "storage"))
    root = os.path.join(base, "custom_nodes")
    os.makedirs(root, exist_ok=True)
    return root


def _path(nid: str) -> str:
    return os.path.join(_root(), f"{nid}.json")


class CustomNodeManager:
    def list_nodes(self, kind: Optional[str] = None) -> List[CustomNodeDefinition]:
        out = []
        try:
            for fn in sorted(os.listdir(_root())):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(_root(), fn), "r", encoding="utf-8") as f:
                        d = CustomNodeDefinition.model_validate(json.load(f))
                    if kind and d.kind != kind:
                        continue
                    out.append(d)
                except Exception:
                    continue
        except Exception:
            pass
        return out

    def get(self, nid: str) -> Optional[CustomNodeDefinition]:
        try:
            with open(_path(nid), "r", encoding="utf-8") as f:
                return CustomNodeDefinition.model_validate(json.load(f))
        except Exception:
            return None

    def save(self, definition: CustomNodeDefinition) -> CustomNodeDefinition:
        from app.providers.generic.code_provider import compile_check_code
        if not definition.id:
            definition.id = f"cn_{uuid.uuid4().hex[:8]}"
        if not _ID_RE.match(definition.id):
            raise ValueError("节点id非法：小写字母数字_ -，2~64字符")
        if definition.kind not in ("image", "video", "audio", "utility"):
            raise ValueError("kind 需为 image/video/audio/utility")
        if definition.language not in ("python", "javascript"):
            raise ValueError("language 需为 python/javascript")
        if not (definition.code or "").strip():
            raise ValueError("code 不能为空")
        # 编译体检：入口须为 run(inputs, params, ctx)
        chk = compile_check_code(definition.language, definition.code, definition.code_entry or "run")
        if not chk.get("ok"):
            raise ValueError(f"代码体检失败: {chk.get('error')}")
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        if not definition.created_at:
            definition.created_at = now
        definition.updated_at = now
        tmp = _path(definition.id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(definition.model_dump(), f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(definition.id))
        return definition

    def delete(self, nid: str) -> bool:
        try:
            if os.path.isfile(_path(nid)):
                os.remove(_path(nid))
                return True
        except Exception:
            pass
        return False


custom_node_manager = CustomNodeManager()


async def run_custom_node(definition: CustomNodeDefinition, inputs: Dict[str, Any],
                          params: Dict[str, Any], extra_ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """执行自定义节点：params 合并默认值 → shim → 沙箱。返回用户代码的dict结果。"""
    from app.providers.generic.code_provider import _execute_python_code, _execute_js_code
    merged = dict(definition.default_params or {})
    merged.update({k: v for k, v in (params or {}).items() if v not in (None, "")})
    try:
        timeout = max(5, min(300, int(definition.code_timeout or 60)))
    except Exception:
        timeout = 60
    try:
        trusted = bool(getattr(definition, "trusted", False))
        if trusted:
            from app.core.config import is_trusted_mode_enabled
            if not is_trusted_mode_enabled():
                trusted = False
    except Exception:
        trusted = False
    # 可信模式显式 opt-in 的节点在沙箱外拥有完整能力；默认走受限沙箱
    ctx = {"inputs": inputs or {}, "params": merged, "node_id": definition.id,
           "node_kind": definition.kind, **(extra_ctx or {})}
    entry = definition.code_entry or "run"
    if (definition.language or "python") == "javascript":
        code = (definition.code or "") + _js_shim(entry)
        return await _execute_js_code(code, "__studio_entry", ctx, timeout=timeout, trusted=trusted)
    code = _wrap_py_user_code(definition.code or "", entry)
    return await _execute_python_code(code, "__studio_entry", ctx, timeout=timeout, trusted=trusted)
