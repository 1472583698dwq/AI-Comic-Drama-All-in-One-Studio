# -*- coding: utf-8 -*-
"""
导演台 Agent 引擎 — 完全重构版 (2026-09-02)

设计目标：彻底解决「一轮即停 / 阻塞卡死 / 重复调用」三大顽疾
- 直连 ChatOpenAI 原生 tool calling，去除 LangChain AgentExecutor 的黑盒调度
- 单一主循环，无嵌套 fallback 陷阱，超时可重试，永不静默跌落单轮
- 并行去重、结果摘要、上下文预算、心跳保活，支持 200 轮无上限但防空转

对外 API 保持兼容：
  - run_agent_with_langchain(prompt, context, session_id, websocket, max_iterations, streaming)
  - clear_session(session_id)
  - get_history(session_id)
  - SESSION_MEMORY / get_chat_model

事件协议（兼容前端 AgentChatDrawer）：
  agent_thinking / agent_thinking_start / agent_thinking_chunk / agent_thinking_end
  tool_calling / tool_result / agent_stream_start / agent_stream_chunk / agent_response / error
"""
import json
import os
import asyncio
import time
import hashlib
from typing import Dict, Any, List, Optional
from collections import defaultdict

from app.core.config import settings
from app.pipelines.llm_service import llm_service, LLMServiceError, extract_json_from_text, strip_think_tags, extract_think_tags
from app.mcp.server import mcp_registry

try:
    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage
    from langchain_core.tools import StructuredTool
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    HAS_LANGCHAIN = True
except Exception as e:
    HAS_LANGCHAIN = False
    print(f"[DirectorAgent] langchain import failed: {e}")

try:
    from langchain_openai import ChatOpenAI
    HAS_OPENAI = True
except Exception:
    HAS_OPENAI = False

# ─── 会话记忆 ─────────────────────────────────────────────
SESSION_MEMORY: Dict[str, List[Any]] = defaultdict(list)
SESSION_MAX_HISTORY = 20
SESSION_LOCKS: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

def _get_session_lock(session_id: str) -> asyncio.Lock:
    return SESSION_LOCKS[session_id]

def _trim_history(history: List[Any]) -> List[Any]:
    if len(history) > SESSION_MAX_HISTORY:
        return history[-SESSION_MAX_HISTORY:]
    return history

def _clip(text: Any, n: int) -> str:
    s = str(text if text is not None else "").strip().replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")

def _build_context_block(context: Dict[str, Any]) -> str:
    if not isinstance(context, dict):
        return ""
    project = context.get("project") or {}
    parts: List[str] = []
    if project:
        scenes = project.get("scenes") or []
        all_shots = [s for sc in scenes for s in (sc.get("shots") or [])]
        chars = project.get("characters") or []
        header = [
            f"【当前项目】{project.get('title', '')} (id={project.get('id', '')})",
            f"风格: {project.get('style_preset', '')} | 画幅: {project.get('aspect_ratio', '')} | BGM: {project.get('bgm_name') or '未设置'}",
            f"规模: {len(scenes)} 场 / {len(all_shots)} 镜",
        ]
        if chars:
            char_lines = []
            for c in chars[:30]:
                char_lines.append(
                    f"- {c.get('name', '?')}（{c.get('gender', '')}/{c.get('age_group', '')}/{c.get('role', '')}）"
                    f"音色:{c.get('voice_name') or c.get('voice_id') or '未选'}；人设:{_clip(c.get('description'), 60)}；形象:{_clip(c.get('visual_prompt'), 80)}"
                )
            header.append("【角色表】\n" + "\n".join(char_lines))
        parts.append("\n".join(header))
        shot_lines = []
        for sc in scenes[:40]:
            for s in (sc.get("shots") or []):
                media = ("".join([
                    "图" if s.get("image_url") else "",
                    "视" if s.get("video_url") else "",
                    "音" if s.get("audio_url") else "",
                ])) or "无"
                shot_lines.append(
                    f"#{s.get('shot_index', '?')}（{_clip(sc.get('title') or sc.get('location'), 14)}）"
                    f"{s.get('camera_framing', '')}/{s.get('camera_motion', '')} 情绪:{s.get('emotion', '')} "
                    f"台词:{_clip(s.get('dialogue'), 30)} 动作:{_clip(s.get('action_desc'), 40)} 已生成:{media} 状态:{s.get('status', '')}"
                )
        if shot_lines:
            parts.append("【分镜清单】\n" + "\n".join(shot_lines[:200]))
    active = context.get("active_shot")
    if active:
        kv = [
            ("镜头号", active.get("shot_index")),
            ("动作描述", active.get("action_desc")),
            ("台词", active.get("dialogue")),
            ("说话人", active.get("speaker_name")),
            ("情绪", active.get("emotion")),
            ("景别", active.get("camera_framing")),
            ("运镜", active.get("camera_motion")),
            ("图像提示词", active.get("image_prompt")),
        ]
        lines = [f"  {k}: {_clip(v, 400)}" for k, v in kv if v not in (None, "")]
        parts.append("【当前激活镜头（用户正在操作的镜头，指令未指明时默认针对它）】\n" + "\n".join(lines))
    cs = context.get("canvas_summary")
    if cs:
        parts.append(f"【画布状态】{_clip(cs, 800)}")
    ws = context.get("workspace")
    if ws:
        parts.append(f"【工作区模式】{ws}")
    return "\n\n".join(parts)[:16000]

# ─── ChatModel 构造 ─────────────────────────────────────
def get_chat_model(streaming: bool = True):
    if HAS_OPENAI and settings.OPENAI_API_KEY:
        try:
            base_url = (settings.OPENAI_BASE_URL or "https://api.deepseek.com/v1").strip().rstrip("/")
            if base_url.endswith("/chat/completions"):
                base_url = base_url[:-len("/chat/completions")].rstrip("/")
            model = settings.OPENAI_MODEL or "deepseek-chat"
            from app.pipelines.llm_service import llm_service
            custom_headers = llm_service._get_custom_headers()
            return ChatOpenAI(
                model=model,
                api_key=settings.OPENAI_API_KEY,
                base_url=base_url,
                temperature=0.3,
                streaming=streaming,
                max_tokens=int(os.environ.get("AGENT_MAX_TOKENS") or 4096),
                timeout=300,
                max_retries=2,
                default_headers=custom_headers if custom_headers else None,
            )
        except Exception as e:
            print(f"[DirectorAgent] ChatOpenAI init failed: {e}，回退到 StudioChatModel")
    if HAS_LANGCHAIN:
        return StudioChatModel(streaming=streaming)
    return None

if HAS_LANGCHAIN:
    class StudioChatModel(BaseChatModel):
        streaming: bool = True
        @property
        def _llm_type(self) -> str:
            return "studio-chat"
        def _convert_messages(self, messages: List[BaseMessage]) -> List[Dict[str, str]]:
            out = []
            for m in messages:
                if isinstance(m, SystemMessage):
                    out.append({"role": "system", "content": m.content})
                elif isinstance(m, HumanMessage):
                    out.append({"role": "user", "content": m.content})
                elif isinstance(m, AIMessage):
                    if getattr(m, "tool_calls", None):
                        tc_json = json.dumps([{"tool": tc["name"], "arguments": tc["args"]} for tc in m.tool_calls], ensure_ascii=False)
                        out.append({"role": "assistant", "content": f"{m.content}\nTOOL_CALLS: {tc_json}"})
                    else:
                        out.append({"role": "assistant", "content": m.content})
                elif isinstance(m, ToolMessage):
                    out.append({"role": "user", "content": f"[Tool {m.name} result]: {m.content}"})
                else:
                    out.append({"role": "user", "content": str(getattr(m, "content", ""))})
            return out
        async def _agenerate(self, messages: List[BaseMessage], stop=None, run_manager=None, **kwargs):
            llm_messages = self._convert_messages(messages)
            content = await llm_service.chat_completion(llm_messages, temperature=kwargs.get("temperature", 0.3), max_tokens=int(os.environ.get("AGENT_MAX_TOKENS") or 65536))
            tool_calls = []
            try:
                parsed = extract_json_from_text(content)
                if isinstance(parsed, dict) and "tool_calls" in parsed and parsed["tool_calls"]:
                    for tc in parsed["tool_calls"][:4]:
                        tool_calls.append({"name": tc.get("tool") or tc.get("name") or "", "args": tc.get("arguments") or {}, "id": f"call_{int(time.time()*1000)}_{len(tool_calls)}", "type": "tool_call"})
                    reply = parsed.get("reply", "")
                    generation = ChatGeneration(message=AIMessage(content=reply, tool_calls=tool_calls if tool_calls else None))
                    return ChatResult(generations=[generation])
            except Exception:
                pass
            generation = ChatGeneration(message=AIMessage(content=content))
            return ChatResult(generations=[generation])
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    raise RuntimeError("sync in async")
                return asyncio.run(self._agenerate(messages, stop, run_manager, **kwargs))
            except RuntimeError:
                raise
        async def _astream(self, messages: List[BaseMessage], stop=None, run_manager=None, **kwargs):
            llm_messages = self._convert_messages(messages)
            async for chunk in llm_service.chat_stream(llm_messages, temperature=kwargs.get("temperature", 0.3), max_tokens=int(os.environ.get("AGENT_MAX_TOKENS") or 65536)):
                from langchain_core.messages import AIMessageChunk
                yield AIMessageChunk(content=chunk)

# ─── P1：HITL审批 + 工具子集裁剪 ──────────────────────────
import uuid as _uuid

# 待确认的破坏性调用：approval_id -> Future[bool]
_PENDING_APPROVALS: Dict[str, Any] = {}


def resolve_approval(approval_id: str, approved: bool) -> bool:
    fut = _PENDING_APPROVALS.get(approval_id)
    if fut is None or getattr(fut, "done", lambda: True)():
        return False
    try:
        fut.set_result(bool(approved))
        return True
    except Exception:
        return False


def _is_destructive_call(name: str, args: Dict[str, Any]) -> bool:
    try:
        from app.agent.loop import DESTRUCTIVE_TOOLS
    except Exception:
        DESTRUCTIVE_TOOLS = {"delete_custom_provider", "shell_exec", "fs_file"}
    if name == "shell_exec":
        return True
    if name == "delete_custom_provider":
        return True
    if name == "fs_file":
        act = str((args or {}).get("action", "")).lower()
        return act in ("write", "append", "delete")
    return False


def _build_allowed_tools(query: str) -> Optional[set]:
    """按意图裁剪bind_tools子集：检索命中 + 常驻 + 破坏性（可提请但走审批）。"""
    try:
        from app.agent.loop import search_tools, CORE_TOOLS
    except Exception:
        return None
    try:
        hits = search_tools(query or "", 12) or []
    except Exception:
        return None
    allowed = set(CORE_TOOLS) | {"search_tools"}
    always = {"get_provider_code", "update_custom_provider", "test_custom_provider",
              "canvas_dispatch_skill", "canvas_query_assets", "list_custom_providers",
              "list_comfyui_workflows", "list_voices", "list_video_providers",
              "list_image_providers", "list_voice_providers",
              "delete_custom_provider", "shell_exec", "fs_file",
              "register_custom_provider", "generate_video", "generate_image",
              "generate_voice", "generate_minimax_voice"}
    allowed |= always
    prov_count = 0
    for h in hits:
        n = h.get("name", "")
        if n.startswith("provider_"):
            if prov_count >= 8:
                continue
            prov_count += 1
        allowed.add(n)
    return allowed


# ─── 工具转换 ────────────────────────────────────────────
def _mcp_to_langchain_tools(allowed: Optional[set] = None) -> List[Any]:
    if not HAS_LANGCHAIN:
        return []
    from pydantic import create_model, Field, BaseModel
    tools = []
    for mcp_tool in mcp_registry.get_all_tools():
        name = mcp_tool.name
        if allowed is not None and name not in allowed:
            continue
        desc = mcp_tool.description or ""
        schema = mcp_tool.input_schema or {"type": "object", "properties": {}}
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        field_defs = {}
        for prop_name, prop_def in props.items():
            if not isinstance(prop_def, dict):
                prop_def = {"type": "string"}
            ptype = prop_def.get("type", "string")
            desc_p = prop_def.get("description", "")
            if ptype == "string":
                py_type = str
            elif ptype == "integer":
                py_type = int
            elif ptype == "number":
                py_type = float
            elif ptype == "boolean":
                py_type = bool
            elif ptype == "array":
                py_type = List[Any]
            elif ptype == "object":
                py_type = Dict[str, Any]
            else:
                py_type = str
            if prop_name in required:
                field_defs[prop_name] = (py_type, Field(description=desc_p))
            else:
                field_defs[prop_name] = (Optional[py_type], Field(default=None, description=desc_p))
        if not field_defs:
            ArgsModel = create_model(f"{name}Args", __base__=BaseModel)
            ArgsModel.model_config = {"extra": "allow"}
        else:
            try:
                ArgsModel = create_model(f"{name}Args", **field_defs)
            except Exception as e:
                print(f"[DirectorAgent] create_model {name} failed: {e}")
                ArgsModel = None
        def make_func(tool_name: str):
            def _func(**kwargs):
                import asyncio
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        raise RuntimeError("async required")
                    return asyncio.run(mcp_registry.execute_tool(tool_name, kwargs))
                except RuntimeError:
                    return {"error": "async required"}
            async def _afunc(**kwargs):
                if "kwargs" in kwargs and isinstance(kwargs["kwargs"], dict) and len(kwargs) == 1:
                    kwargs = kwargs["kwargs"]
                elif "__arg1" in kwargs and len(kwargs) == 1:
                    v = kwargs["__arg1"]
                    if isinstance(v, dict):
                        kwargs = v
                    elif isinstance(v, str):
                        try:
                            kwargs = json.loads(v)
                        except Exception:
                            kwargs = {"prompt": v}
                if "input" in kwargs and isinstance(kwargs["input"], str) and len(kwargs) == 1:
                    try:
                        kwargs = json.loads(kwargs["input"])
                    except Exception:
                        pass
                result = await mcp_registry.execute_tool(tool_name, kwargs)
                if result.status == "success":
                    return json.dumps(result.result, ensure_ascii=False)[:60000]
                else:
                    return json.dumps({"error": result.error}, ensure_ascii=False)
            return _func, _afunc
        func, afunc = make_func(name)
        try:
            if ArgsModel is not None:
                tool = StructuredTool.from_function(func=func, coroutine=afunc, name=name, description=desc, args_schema=ArgsModel)
            else:
                tool = StructuredTool.from_function(func=func, coroutine=afunc, name=name, description=desc)
            tools.append(tool)
        except Exception as e:
            print(f"[DirectorAgent] tool {name} convert failed: {e}")
    return tools

# ─── 工具结果摘要（防上下文爆炸）─────────────────────────
def _summarize_tool_result(tool_name: str, result: Any, max_chars: int = 4000) -> str:
    """将超大工具结果压缩为 LLM 可消化摘要，H3 等 code 类 provider 只保留关键字段"""
    try:
        raw = json.dumps(result, ensure_ascii=False)
    except Exception:
        raw = str(result)
    if len(raw) <= max_chars:
        return raw
    # 针对 list_custom_providers：剥离 code，只保留 id/name/kind/params_schema 概要
    if tool_name == "list_custom_providers" and isinstance(result, dict) and "providers" in result:
        try:
            brief = []
            for p in result.get("providers") or []:
                if not isinstance(p, dict):
                    continue
                # 只保留关键信息，code 截断，params_schema 只保留字段名
                ps = p.get("params_schema") or {}
                ps_keys = list(ps.get("properties", {}).keys()) if isinstance(ps, dict) else []
                is_prop = p.get("params_schema") or p.get("input_schema") or {}
                # 简化
                brief.append({
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "kind": p.get("kind"),
                    "provider_type": p.get("provider_type"),
                    "has_code": p.get("has_code"),
                    "params": list((p.get("params_schema") or {}).get("properties", {}).keys()) if isinstance(p.get("params_schema"), dict) else [],
                    "input": list((p.get("input_schema") or {}).get("properties", {}).keys()) if isinstance(p.get("input_schema"), dict) else [],
                    "enabled": p.get("enabled"),
                    "description": (p.get("description") or "")[:80],
                })
            summarized = {"total": result.get("total"), "providers_brief": brief, "_note": "已剔除 code 全文，仅保留参数结构；如需代码请调用 get_provider_code"}
            s = json.dumps(summarized, ensure_ascii=False)
            if len(s) > max_chars:
                s = s[:max_chars] + "…(truncated)"
            return s
        except Exception:
            pass
    if tool_name == "get_provider_code" and isinstance(result, dict) and "code" in result:
        try:
            code = result.get("code") or ""
            preview = code[:600] + ("…(后续截断，共{}字符)".format(len(code)) if len(code) > 600 else "")
            summarized = {k: v for k, v in result.items() if k != "code"}
            summarized["code_preview"] = preview
            summarized["code_length"] = len(code)
            s = json.dumps(summarized, ensure_ascii=False)
            return s[:max_chars] + "…(truncated)" if len(s) > max_chars else s
        except Exception:
            pass
    # 通用截断：保留头尾
    if len(raw) > max_chars:
        half = max_chars // 2
        return raw[:half] + f"\n…(已截断，原文 {len(raw)} 字符)…\n" + raw[-half:]
    return raw

def _deduplicate_tool_calls(tool_calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for tc in tool_calls:
        name = tc.get("name") or tc.get("tool") or ""
        args = tc.get("args") or tc.get("arguments") or {}
        # 归一化 args：排序后 json
        try:
            sig = (name, json.dumps(args, ensure_ascii=False, sort_keys=True, default=str))
        except Exception:
            sig = (name, str(args))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(tc)
    return out

# ─── 核心循环 ────────────────────────────────────────────
async def run_agent_with_langchain(
    prompt: str,
    context: Dict[str, Any],
    session_id: str = "default",
    websocket=None,
    max_iterations: Optional[int] = None,
    streaming: bool = True,
    mode: str = "execute",
) -> Dict[str, Any]:
    async def _safe_send(ev: Dict[str, Any]):
        if not websocket:
            return
        try:
            await asyncio.wait_for(websocket.send_json(ev), timeout=2)
        except Exception:
            pass

    # P0双模式：chat纯问答不进循环（省token/零副作用），execute走ReAct
    _mode = (mode or "execute").strip().lower()
    if _mode == "chat":
        reply = await llm_service.chat_completion(
            messages=[
                {"role": "system", "content": "你是AI漫剧导演顾问，只做问答讲解，不调用任何工具。请在 <think> ... </think> 标签内展示专业导演的思考推演过程，再用中文回答。"},
                {"role": "user", "content": (prompt or "")[:4000]},
            ],
            temperature=0.5,
        )
        th = extract_think_tags(reply or "").strip()
        clean_reply = strip_think_tags(reply or "").strip()
        if not th:
            th = f"【导演顾问思考推演】\n- 意图分析：用户询问「{prompt[:60]}」\n- 解答路径：梳理漫剧影视创作知识库，输出条理清晰的专业指导建议。"
        if websocket:
            try:
                await _safe_send({"event": "agent_thinking_start"})
                for i in range(0, len(th), 8):
                    await _safe_send({"event": "agent_thinking_chunk", "delta": th[i:i+8]})
                    await asyncio.sleep(0.005)
                await _safe_send({"event": "agent_thinking_end"})
                if clean_reply and streaming:
                    await _safe_send({"event": "agent_stream_start"})
                    for i in range(0, len(clean_reply), 6):
                        await _safe_send({"event": "agent_stream_chunk", "delta": clean_reply[i:i+6]})
                        await asyncio.sleep(0.015)
            except Exception:
                pass
        try:
            async with _get_session_lock(session_id):
                SESSION_MEMORY[session_id].append(HumanMessage(content=f"指令: {prompt}"))
                SESSION_MEMORY[session_id].append(AIMessage(content=clean_reply))
                SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])
        except Exception:
            pass
        return {"reply": clean_reply, "thinking": th, "suggested_actions": ["切换到执行模式让我直接做"], "executed_tools": [], "mode": "chat"}
    # execute预算：mode未指定max时用P0默认值12（引擎安全上限30不变）
    try:
        from app.agent.loop import MODE_BUDGETS
        if not max_iterations:
            max_iterations = int(MODE_BUDGETS["execute"]["max_steps"])
    except Exception:
        pass
    async with _get_session_lock(session_id):
        history = _trim_history(SESSION_MEMORY.get(session_id, []))
    context_block = _build_context_block(context)
    human_content = f"指令: {prompt}\n\n{context_block}" if context_block else prompt
    human_history = f"指令: {prompt}" if context_block else prompt

    # 无 LangChain 时直接回退为轻量 JSON 单次（但本重构要求 LangChain 存在）
    if not HAS_LANGCHAIN:
        from app.api.routes import get_agent_system_prompt
        try:
            decision = await llm_service.chat_json(system_prompt=get_agent_system_prompt(), user_prompt=json.dumps({"instruction": prompt, "context": context}, ensure_ascii=False), temperature=0.2, max_tokens=16384)
            async with _get_session_lock(session_id):
                SESSION_MEMORY[session_id].append(HumanMessage(content=human_history))
                SESSION_MEMORY[session_id].append(AIMessage(content=decision.get("reply","")))
                SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])
            return decision
        except Exception as e:
            raise LLMServiceError(str(e))

    llm = get_chat_model(streaming=streaming)
    if llm is None:
        raise RuntimeError("无法初始化 Chat Model")
    # P1真裁剪：按本轮意图取子集进bind_tools，非全部49个
    try:
        _allowed = _build_allowed_tools(prompt or "")
    except Exception:
        _allowed = None
    tools = _mcp_to_langchain_tools(_allowed)
    try:
        print(f"[DirectorAgent] bind_tools subset: {len(tools)} (allowed={len(_allowed) if _allowed else 'all'})")
    except Exception:
        pass
    llm_with_tools = llm.bind_tools(tools) if hasattr(llm, "bind_tools") and tools else llm

    from app.api.routes import get_agent_system_prompt
    system_extra = ("\n\n你是具备多轮记忆的导演 Agent，可进行多轮工具调用且无固定轮次上限——持续执行直到用户目标全部完成，请基于历史与工具结果持续推理。"
                    "\n工具检索优先：provider_*动态源很多时，先调search_tools按意图取子集（如 生图/配音/画布/剪映），再执行，禁止把90个全量定义硬背进每轮。")
    messages: List[BaseMessage] = [SystemMessage(content=get_agent_system_prompt(loop=True) + system_extra)]
    for h in history:
        messages.append(h)
    messages.append(HumanMessage(content=human_content))

    executed_tools: List[Dict[str, Any]] = []
    full_reply = ""
    stall_sig = None
    stall_count = 0
    nudged_empty = False
    nudged_query = False
    # P2 trace: run_id 落盘(JSONL)，供回放/审计；失败也不影响主流程
    import uuid as _trace_uuid
    _run_id = f"{session_id}_{int(time.time())}_{_trace_uuid.uuid4().hex[:6]}"
    try:
        from app.agent.trace import log_event as _trace_log
        from app.agent.business import detect_intent as _detect
        try:
            _det = _detect(prompt, context or {})
        except Exception:
            _det = {"intent": "unknown"}
        _trace_log(_run_id, "run_start", {"prompt": (prompt or "")[:500], "session_id": session_id, "intent": _det, "mode": _mode})
    except Exception:
        _trace_log = None  # type: ignore
    accumulated_thoughts: List[str] = []
    init_thought = f"【导演意图感知】接收指令：「{prompt[:100]}」\n- 会话上下文：{session_id}\n- 项目状态：{'已加载工程' if context and context.get('project_title') else '全局就绪'}"
    if context and context.get("active_shot"):
        ashot = context["active_shot"]
        init_thought += f"\n- 当前分镜 #{ashot.get('shot_index')}: {ashot.get('action_desc') or ashot.get('image_prompt') or '无描述'}"
        if ashot.get("camera_framing") or ashot.get("camera_motion"):
            init_thought += f"（机位: {ashot.get('camera_framing') or '默认'}, 运镜: {ashot.get('camera_motion') or '默认'}）"
    accumulated_thoughts.append(init_thought)

    await _safe_send({"event": "agent_thinking", "message": f"正在解析导演指令: 「{prompt[:40]}」..."})
    if websocket:
        await _safe_send({"event": "agent_thinking_start"})
        for i in range(0, len(init_thought), 8):
            await _safe_send({"event": "agent_thinking_chunk", "delta": init_thought[i:i+8]})
            await asyncio.sleep(0.005)
        await _safe_send({"event": "agent_thinking_end"})

    iteration = 0
    safety_cap = 30  # 重构后实用上限 30 轮足够完成任意画布编排，旧 200 过高易失控
    if max_iterations:
        safety_cap = min(safety_cap, max_iterations)

    while True:
        iteration += 1
        if iteration > safety_cap:
            full_reply = (full_reply or content if 'content' in locals() else "") + "\n\n（已达安全轮次上限 30，任务未完成可让我继续。）"
            break
        content = ""
        tool_calls: List[Dict[str, Any]] = []
        llm_result = None

        # ── LLM 调用（带 90s 超时 + 2 次重试，心跳保活）──
        last_err = None
        for attempt in range(3):
            try:
                # 心跳协程：每 8s 推送一次 thinking，避免前端紫条卡死
                async def _heartbeat():
                    cnt = 0
                    while True:
                        await asyncio.sleep(8)
                        cnt += 1
                        await _safe_send({"event": "agent_thinking", "message": f"导演思考中… ({cnt*8}s)"})
                hb_task = asyncio.create_task(_heartbeat())
                try:
                    llm_result = await asyncio.wait_for(llm_with_tools.ainvoke(messages), timeout=90)
                finally:
                    hb_task.cancel()
                    try:
                        await hb_task
                    except asyncio.CancelledError:
                        pass
                break
            except asyncio.CancelledError:
                print("[DirectorAgent] ainvoke cancelled by user (abort)")
                raise
            except asyncio.TimeoutError as e:
                last_err = e
                print(f"[DirectorAgent] ainvoke timeout 90s (attempt {attempt+1}/3)")
                await _safe_send({"event": "agent_thinking", "message": f"导演思考超时，正在重试 {attempt+1}/3 …"})
                await asyncio.sleep(1 + attempt)
            except Exception as e:
                last_err = e
                print(f"[DirectorAgent] ainvoke failed (attempt {attempt+1}/3): {e}")
                await asyncio.sleep(0.8 * (attempt+1))
                if attempt == 2:
                    await _safe_send({"event": "agent_thinking", "message": "网络波动，切换备用通道…"})

        if llm_result is None:
            # 连续超时/异常兜底：用 llm_service 迭代 3 轮（与旧版一致但精简）
            print(f"[DirectorAgent] ainvoke 多次失败，进入轻量兜底: {last_err}")
            try:
                from app.api.routes import get_agent_system_prompt as _gap
                fb_reply = ""
                fb_decision = None
                for _fb in range(3):
                    _u = {"instruction": prompt, "context": context_block or None, "history": [str(getattr(m, "content",""))[:200] for m in history[-4:]]}
                    if executed_tools:
                        _u["already_executed"] = executed_tools[-6:]
                    # 带上最近消息
                    try:
                        _u["recent_messages"] = [str(getattr(m, "content",""))[:400] for m in messages[-4:]]
                    except Exception:
                        pass
                    fb_decision = await llm_service.chat_json(system_prompt=_gap(), user_prompt=json.dumps(_u, ensure_ascii=False)[:20000], temperature=0.2, max_tokens=16384)
                    _calls = fb_decision.get("tool_calls") or []
                    if _calls:
                        _calls = _deduplicate_tool_calls([{"name": c.get("tool") or c.get("name") or "", "args": c.get("arguments") or {}, "id": f"fb_{iteration}_{_fb}_{i}", "type": "tool_call"} for i, c in enumerate(_calls[:4])])
                        messages.append(AIMessage(content=fb_decision.get("reply","") or "", tool_calls=_calls))
                        for tc in _calls:
                            name = tc.get("name") or ""
                            args = tc.get("args") or {}
                            # 兜底路径破坏性调用直接拒绝（避免无审批执行）
                            if _is_destructive_call(name, args):
                                _msg = f"破坏性工具 {name} 需用户确认，兜底路径已跳过（请用WS执行模式确认后重试）"
                                executed_tools.append({"tool_name": name, "arguments": args, "status": "error", "result": None, "error": _msg})
                                messages.append(ToolMessage(content=_msg, tool_call_id=tc.get("id") or name, name=name))
                                continue
                            await _safe_send({"event": "tool_calling", "tool_name": name, "arguments": args, "status": "executing"})
                            _res = await asyncio.wait_for(mcp_registry.execute_tool(name, args, project_context=context.get("project") if isinstance(context, dict) else None), timeout=30)
                            executed_tools.append({"tool_name": name, "arguments": args, "status": _res.status, "result": _res.result, "error": _res.error})
                            await _safe_send({"event": "tool_result", "tool_name": name, "status": _res.status, "result": _res.result if _res.status=="success" else None, "error": _res.error})
                            tool_str = _summarize_tool_result(name, _res.result if _res.status=="success" else {"error": _res.error}, max_chars=4000)
                            messages.append(ToolMessage(content=tool_str, tool_call_id=tc.get("id") or name, name=name))
                        continue
                    else:
                        fb_reply = fb_decision.get("reply","") or ""
                        break
                reply = fb_reply or (fb_decision.get("reply","") if fb_decision else "") or "指令已执行（兜底）。"
                if websocket and streaming:
                    await _safe_send({"event": "agent_stream_start"})
                    for i in range(0, len(reply), 6):
                        await _safe_send({"event": "agent_stream_chunk", "delta": reply[i:i+6]})
                        await asyncio.sleep(0.015)
                async with _get_session_lock(session_id):
                    SESSION_MEMORY[session_id].append(HumanMessage(content=human_history))
                    SESSION_MEMORY[session_id].append(AIMessage(content=reply))
                    SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])
                return {"reply": reply, "tool_calls": [{"tool": t["tool_name"], "arguments": t["arguments"]} for t in executed_tools] if executed_tools else (fb_decision.get("tool_calls") or [] if fb_decision else []), "suggested_actions": (fb_decision.get("suggested_actions") or [] if fb_decision else []), "executed_tools": executed_tools}
            except Exception as e3:
                raise LLMServiceError(f"Agent 兜底失败: {e3}") from e3

        # ── 解析 LLM 决策 ──
        try:
            content = llm_result.content if hasattr(llm_result, "content") else str(llm_result)
            tool_calls = getattr(llm_result, "tool_calls", None) or []
            if not tool_calls and hasattr(llm_result, "additional_kwargs"):
                ak = getattr(llm_result, "additional_kwargs", {}) or {}
                if isinstance(ak, dict) and "tool_calls" in ak and ak["tool_calls"]:
                    for tc in ak["tool_calls"]:
                        fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                        raw_args = fn.get("arguments")
                        if isinstance(raw_args, str):
                            try:
                                raw_args = json.loads(raw_args)
                            except Exception:
                                raw_args = {}
                        tool_calls.append({"name": fn.get("name") or tc.get("name") or "", "args": raw_args or {}, "id": tc.get("id") or f"call_{iteration}_{len(tool_calls)}"})
            if not tool_calls and content:
                try:
                    parsed = extract_json_from_text(content)
                    if isinstance(parsed, dict) and "tool_calls" in parsed and parsed["tool_calls"]:
                        for tc in parsed["tool_calls"]:
                            tool_calls.append({"name": tc.get("tool") or tc.get("name") or "", "args": tc.get("arguments") or {}, "id": f"call_{iteration}_{len(tool_calls)}"})
                        if parsed.get("reply"):
                            content = parsed.get("reply") or ""
                except Exception:
                    pass
        except Exception as pe:
            print(f"[DirectorAgent] parse failed: {pe}")
            content, tool_calls = str(llm_result), []

        tool_calls = _deduplicate_tool_calls(tool_calls)

        # ── 提取推理/思考推演内容（reasoning_content 或 <think> 标签）──
        ak = getattr(llm_result, "additional_kwargs", {}) or {}
        rc = str(ak.get("reasoning_content") or "").strip()
        tag_think = extract_think_tags(content or "").strip()
        iter_thought = ""
        if rc:
            iter_thought = rc
        if tag_think:
            iter_thought = f"{iter_thought}\n\n{tag_think}".strip() if iter_thought else tag_think

        clean_content = strip_think_tags(content or "").strip()

        # ── 有工具调用 → 执行 ──
        if tool_calls:
            # 聚合思考过程：若模型自带推理/think则优先采用，否则由导演引擎自动生成结构化决策推演
            if iter_thought:
                tc_thought = iter_thought
            else:
                tool_names_str = "、".join([tc.get("name") or "工具" for tc in tool_calls])
                reasoning_lines = [
                    f"【第 {iteration} 轮推演与动作决策】",
                    f"- 意图分析：根据导演目标，调度 [{tool_names_str}] 执行专项操作",
                ]
                for tc in tool_calls[:3]:
                    t_name = tc.get("name") or ""
                    t_args = tc.get("args") or {}
                    arg_keys = [f"{k}={str(v)[:30]}" for k, v in list(t_args.items())[:3]]
                    reasoning_lines.append(f"  * 调度 `{t_name}`（{', '.join(arg_keys) if arg_keys else '默认参数'}）")
                reasoning_lines.append("- 执行预期：推进影视资产与分镜编排，等待工具产物回填")
                tc_thought = "\n".join(reasoning_lines)

            if clean_content and clean_content not in tc_thought:
                tc_thought = f"{tc_thought}\n\n{clean_content}".strip()

            accumulated_thoughts.append(tc_thought)
            if websocket:
                await _safe_send({"event": "agent_thinking_start"})
                for i in range(0, len(tc_thought), 8):
                    await _safe_send({"event": "agent_thinking_chunk", "delta": tc_thought[i:i+8]})
                    await asyncio.sleep(0.006)
                await _safe_send({"event": "agent_thinking_end"})
            # 空转检测：同批工具连续 3 次
            sig = json.dumps([[tc.get("name") or "", json.dumps(tc.get("args") or {}, ensure_ascii=False, sort_keys=True, default=str)] for tc in tool_calls], ensure_ascii=False)
            if sig == stall_sig:
                stall_count += 1
            else:
                stall_sig = sig
                stall_count = 1
            if stall_count >= 3:
                full_reply = (content or "") + "\n\n（检测到连续相同的工具调用，已自动停止以避免空转；可调整指令后让我继续。）"
                messages.append(AIMessage(content=full_reply))
                break
            messages.append(AIMessage(content=content or "", tool_calls=tool_calls))
            # 并发执行但限流，避免 H3 等生成类阻塞查询类
            # 分类：查询类先行，生成类后行（保证 list→generate 顺序）
            async def _exec_one(tc):
                name = tc.get("name") or tc.get("tool") or ""
                args = tc.get("args") or tc.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                if not name:
                    return None
                # P1 HITL：破坏性调用先请示，无WS/超时/拒绝则跳过（HTTP无交互自动拒绝并引导走WS）
                if _is_destructive_call(name, args):
                    if websocket is None:
                        msg = f"破坏性工具 {name} 需用户确认，已跳过（请用WS执行模式确认后重试）"
                        executed_tools.append({"tool_name": name, "arguments": args, "status": "error", "result": None, "error": msg})
                        messages.append(ToolMessage(content=msg, tool_call_id=tc.get("id") or name, name=name))
                        return None
                    _aid = f"appr_{_uuid.uuid4().hex[:8]}"
                    _loop = asyncio.get_running_loop()
                    _fut = _loop.create_future()
                    _PENDING_APPROVALS[_aid] = _fut
                    try:
                        await _safe_send({"event": "approval_required", "approval_id": _aid, "tool_name": name, "arguments": args})
                        try:
                            _ok = await asyncio.wait_for(_fut, timeout=120)
                        except asyncio.TimeoutError:
                            _ok = False
                        if not _ok:
                            msg = f"用户拒绝/超时，已跳过破坏性工具 {name}"
                            executed_tools.append({"tool_name": name, "arguments": args, "status": "error", "result": None, "error": msg})
                            await _safe_send({"event": "tool_result", "tool_name": name, "status": "error", "error": msg})
                            messages.append(ToolMessage(content=msg, tool_call_id=tc.get("id") or name, name=name))
                            return None
                    finally:
                        _PENDING_APPROVALS.pop(_aid, None)
                await _safe_send({"event": "tool_calling", "tool_name": name, "arguments": args, "status": "executing"})
                try:
                    res = await asyncio.wait_for(mcp_registry.execute_tool(name, args, project_context=context.get("project") if isinstance(context, dict) else None), timeout=40)
                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError:
                    res = type("R", (), {"status": "error", "result": None, "error": f"工具 {name} 执行超时 40s"})()
                except Exception as e:
                    res = type("R", (), {"status": "error", "result": None, "error": str(e)})()
                executed_tools.append({"tool_name": name, "arguments": args, "status": getattr(res, "status", "error"), "result": getattr(res, "result", None), "error": getattr(res, "error", None)})
                await _safe_send({"event": "tool_result", "tool_name": name, "status": getattr(res, "status", "error"), "result": getattr(res, "result", None) if getattr(res, "status", "")=="success" else None, "error": getattr(res, "error", None)})
                summarized = _summarize_tool_result(name, getattr(res, "result", None) if getattr(res, "status", "")=="success" else {"error": getattr(res, "error", "")}, max_chars=4000)
                return (tc, summarized, name)

            # 保持顺序执行以符合前端 badge 顺序，但整体仍异步
            for tc in tool_calls:
                r = await _exec_one(tc)
                if not r:
                    continue
                orig_tc, summarized, name = r
                messages.append(ToolMessage(content=summarized, tool_call_id=orig_tc.get("id") or name, name=name))
            continue

        # ── 无工具调用 → 收尾或防早停 ──
        stripped = clean_content
        if not stripped:
            if iter_thought and len(iter_thought) > 40:
                stripped = iter_thought
                iter_thought = ""
            elif executed_tools and not nudged_empty:
                nudged_empty = True
                messages.append(HumanMessage(content="请基于以上已执行工具的结果，直接给出最终中文总结与答案，不要返回空内容。"))
                continue
            elif executed_tools:
                names = "、".join(t.get("tool_name") for t in executed_tools[-3:])
                stripped = f"已执行 {names}，但模型未能生成总结（可回复「继续」让我重试收尾）。"
            else:
                stripped = "（模型未返回有效内容，请重试或调整指令。）"

        # 如果本轮有模型原生思考推演，加入全局思考流
        if iter_thought:
            accumulated_thoughts.append(iter_thought)
            if websocket:
                await _safe_send({"event": "agent_thinking_start"})
                for i in range(0, len(iter_thought), 8):
                    await _safe_send({"event": "agent_thinking_chunk", "delta": iter_thought[i:i+8]})
                    await asyncio.sleep(0.006)
                await _safe_send({"event": "agent_thinking_end"})
        elif not executed_tools and len(accumulated_thoughts) <= 1:
            direct_thought = f"【导演方案推演】\n- 构思分析：针对指令「{prompt[:60]}」，综合剧本审美与镜头语言\n- 响应策略：输出影视化专业解答与操作指引。"
            accumulated_thoughts.append(direct_thought)
            if websocket:
                await _safe_send({"event": "agent_thinking_start"})
                for i in range(0, len(direct_thought), 8):
                    await _safe_send({"event": "agent_thinking_chunk", "delta": direct_thought[i:i+8]})
                    await asyncio.sleep(0.006)
                await _safe_send({"event": "agent_thinking_end"})
        elif executed_tools:
            conclude_thought = "【导演执行总评】各项影视工具调用完毕，正在整合输出最终导演答复。"
            accumulated_thoughts.append(conclude_thought)
            if websocket:
                await _safe_send({"event": "agent_thinking_start"})
                for i in range(0, len(conclude_thought), 8):
                    await _safe_send({"event": "agent_thinking_chunk", "delta": conclude_thought[i:i+8]})
                    await asyncio.sleep(0.005)
                await _safe_send({"event": "agent_thinking_end"})

        # 查询后早停拦截（H3 场景精准命中：list 后直接总结）
        if not nudged_query and executed_tools and stripped.strip():
            QUERY = {"list_custom_providers","list_image_providers","list_comfyui_workflows","list_voice_providers","list_voices","list_assets","get_asset","canvas_query","get_provider_code"}
            last_is_query = (executed_tools[-1].get("tool_name") or "") in QUERY
            all_query = all((t.get("tool_name") or "") in QUERY for t in executed_tools)
            needs_multi = any(kw in prompt for kw in ["生成","画布","创建","连线","执行","分镜","视频","配音","图片","素材","注册","工作流","节点","H3","h3","参数","暴露"])
            has_sub = any(k in stripped for k in ["已生成","已创建","已执行","image_url","video_url","audio_url","provider_","节点","画布","成功生成","已暴露","未暴露","params_schema"])
            if (last_is_query or all_query) and needs_multi and not has_sub and iteration <= 10:
                nudged_query = True
                messages.append(AIMessage(content=stripped or ""))
                # 针对 H3：直接提示下一步应查 provider_code
                hint = "你刚才只完成了查询，任务尚未完成。"
                if "H3" in prompt or "h3" in prompt or "参数" in prompt:
                    hint += "请立即调用 get_provider_code 查看 H3 provider 的 input_schema/params_schema 与 code，定位未暴露参数的具体字段，然后给出修复建议（必要时调用 update_custom_provider）。"
                else:
                    hint += "请立即基于查询结果执行下一步实质动作（generate_image/generate_voice/canvas_create_node/canvas_connect/canvas_execute 等），不要只总结。"
                messages.append(HumanMessage(content=hint))
                continue

        full_reply = stripped
        if websocket and streaming and full_reply:
            await _safe_send({"event": "agent_stream_start"})
            for i in range(0, len(full_reply), 6):
                await _safe_send({"event": "agent_stream_chunk", "delta": full_reply[i:i+6]})
                await asyncio.sleep(0.015)
        messages.append(AIMessage(content=full_reply))
        break

    full_reply = strip_think_tags(full_reply) if full_reply else "指令已执行。"
    async with _get_session_lock(session_id):
        SESSION_MEMORY[session_id].append(HumanMessage(content=human_history))
        SESSION_MEMORY[session_id].append(AIMessage(content=full_reply))
        SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])
    try:
        if _trace_log:
            _trace_log(_run_id, "run_end", {"reply": (full_reply or "")[:1000], "executed_tools": [{"tool": t.get("tool_name"), "status": t.get("status")} for t in executed_tools]})
    except Exception:
        pass
    full_thinking = "\n\n---\n\n".join(accumulated_thoughts) if accumulated_thoughts else None
    out = {
        "reply": full_reply,
        "thinking": full_thinking,
        "tool_calls": [{"tool": t["tool_name"], "arguments": t["arguments"]} for t in executed_tools] if executed_tools else [],
        "suggested_actions": [],
        "executed_tools": executed_tools
    }
    try:
        if _trace_log:
            out["run_id"] = _run_id
    except Exception:
        pass
    return out

async def clear_session(session_id: str):
    async with _get_session_lock(session_id):
        SESSION_MEMORY.pop(session_id, None)

def get_history(session_id: str) -> List[Any]:
    return SESSION_MEMORY.get(session_id, [])

async def chat_once(prompt: str, context: Dict[str, Any], session_id: str = "default") -> Dict[str, Any]:
    return await run_agent_with_langchain(prompt, context, session_id=session_id, websocket=None, streaming=False)
