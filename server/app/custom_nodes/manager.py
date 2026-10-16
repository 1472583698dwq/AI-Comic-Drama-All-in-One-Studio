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
from typing import Any, Dict, List, Optional, Tuple

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


def _schema_keys(schema: Optional[Dict[str, Any]]) -> List[str]:
    props = (schema or {}).get("properties") if isinstance(schema, dict) else None
    return list(props.keys()) if isinstance(props, dict) else []


def split_run_args(definition: CustomNodeDefinition, args: Optional[Dict[str, Any]],
                   input_keys: Optional[Any] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """REQ-toonflow-canvas 统一执行口参数 → (inputs, params)。

    - 嵌套形状（含 ``inputs`` / ``params`` dict）：保持原语义——``inputs`` 原样、没给 ``params`` 时取其余键；
      仅把顶层同名的已声明输入键补进 inputs（不覆盖已有值）。
    - 扁平形状（画布扩展节点 build_run_args、/extensions/execute 直调）：``input_schema`` 声明的属性键 → inputs，
      其余 → params；同时也在 params_schema 里声明的键两边都给。
    - ``input_keys``：调用方额外认定的输入键（如扩展节点从输入端口装配出的键）。代码节点自己没声明成输入的，
      inputs / params 两边都给（老节点可能从 params 读，向后兼容）；声明成参数的只进 params。
    """
    args = dict(args or {})
    declared_in = set(_schema_keys(definition.input_schema))
    declared_params = set(_schema_keys(definition.params_schema))
    extra_in = {str(k) for k in (input_keys or ())} - declared_in - declared_params
    nested_in = args.get("inputs") if isinstance(args.get("inputs"), dict) else None
    nested_params = args.get("params") if isinstance(args.get("params"), dict) else None
    if nested_in is not None or nested_params is not None:
        inputs = dict(nested_in or {})
        if nested_params is not None:
            params = dict(nested_params)
        else:  # 与旧实现一致：没给 params 时取除 inputs 外的其余键
            params = {k: v for k, v in args.items() if k != "inputs"}
        for k in declared_in | extra_in:
            if k not in inputs and args.get(k) not in (None, "", []):
                inputs[k] = args[k]
        return inputs, params
    inputs: Dict[str, Any] = {}
    params: Dict[str, Any] = {}
    for k, v in args.items():
        if k in declared_in:
            inputs[k] = v
            if k in declared_params:
                params[k] = v
        elif k in extra_in:
            inputs[k] = v
            params[k] = v
        else:
            params[k] = v
    return inputs, params


async def run_custom_node(definition: CustomNodeDefinition, inputs: Dict[str, Any],
                          params: Dict[str, Any], extra_ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """执行自定义节点：params 合并默认值 → shim → 沙箱。返回用户代码的dict结果。"""
    from app.providers.generic.code_provider import _execute_python_code, _execute_js_code
    from app.extensions import guard
    guard.ensure_enabled("custom_node", definition.id,
                         (extra_ctx or {}).get("project_id"))
    merged = dict(definition.default_params or {})
    merged.update({k: v for k, v in (params or {}).items() if v not in (None, "")})
    try:
        timeout = max(1200, int(definition.code_timeout or 1200))
    except Exception:
        timeout = 1200
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
