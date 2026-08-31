# -*- coding: utf-8 -*-
"""
LangChain Agent 引擎 — 带记忆、多轮循环、真实流式
- 使用 ChatOpenAI (OpenAI兼容) 或 StudioChatModel(包裹 llm_service) 作为底层 LLM
- 使用 LangChain Tools (由 MCP tools 转换) + AgentExecutor 循环
- 使用内存字典 SESSION_MEMORY 保存多轮对话历史
- 支持 astream 流式推送至 WebSocket / SSE
"""
import json
import asyncio
import time
from typing import Dict, Any, List, Optional, AsyncGenerator
from collections import defaultdict

from app.core.config import settings
from app.pipelines.llm_service import llm_service, LLMServiceError, extract_json_from_text, strip_think_tags
from app.mcp.server import mcp_registry

# LangChain imports (lazy to avoid import errors if not installed)
try:
    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain_core.tools import StructuredTool
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.callbacks import AsyncCallbackHandler
    HAS_LANGCHAIN = True
except Exception as e:
    HAS_LANGCHAIN = False
    print(f"[LangChainAgent] langchain import failed: {e}")

try:
    from langchain_openai import ChatOpenAI
    HAS_OPENAI = True
except Exception:
    HAS_OPENAI = False

# 会话记忆：session_id -> List[BaseMessage]
SESSION_MEMORY: Dict[str, List[Any]] = defaultdict(list)
SESSION_MAX_HISTORY = 20  # 保留最近20条消息
SESSION_LOCKS: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

def _get_session_lock(session_id: str) -> asyncio.Lock:
    return SESSION_LOCKS[session_id]

def _trim_history(history: List[Any]) -> List[Any]:
    if len(history) > SESSION_MAX_HISTORY:
        return history[-SESSION_MAX_HISTORY:]
    return history

def get_chat_model(streaming: bool = True):
    """
    根据 settings 构造 LangChain Chat Model
    优先使用 ChatOpenAI (OpenAI兼容)，失败则回退到 StudioChatModel (包裹 llm_service)
    """
    # 尝试使用 ChatOpenAI
    if HAS_OPENAI and settings.OPENAI_API_KEY:
        try:
            # 兼容处理 base_url 尾部
            base_url = (settings.OPENAI_BASE_URL or "https://api.deepseek.com/v1").strip().rstrip("/")
            # ChatOpenAI 需要的 base_url 不含 /chat/completions
            # 如果传入的是完整端点，去掉后缀
            if base_url.endswith("/chat/completions"):
                base_url = base_url[:-len("/chat/completions")].rstrip("/")
            model = settings.OPENAI_MODEL or "deepseek-chat"
            # ox-alpha 等特殊模型
            return ChatOpenAI(
                model=model,
                api_key=settings.OPENAI_API_KEY,
                base_url=base_url,
                temperature=0.3,
                streaming=streaming,
                max_tokens=4096,
            )
        except Exception as e:
            print(f"[LangChainAgent] ChatOpenAI init failed: {e}，回退到 StudioChatModel")
    # 回退：StudioChatModel 包裹 llm_service
    if HAS_LANGCHAIN:
        return StudioChatModel(streaming=streaming)
    # 极端回退：直接返回 None，由调用方使用 llm_service
    return None


if HAS_LANGCHAIN:
    class StudioChatModel(BaseChatModel):
        """包裹 llm_service 的 LangChain Chat Model，支持任意 provider (deepseek/qwen/minimax等)"""
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
                    # 若包含 tool_calls，展开为文本（兼容 JSON 模式）
                    if getattr(m, "tool_calls", None):
                        # 将 tool_calls 序列化为文本
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
            # 调用 llm_service 的非流式接口
            content = await llm_service.chat_completion(llm_messages, temperature=kwargs.get("temperature", 0.3))
            # 尝试解析 tool_calls JSON (兼容旧 Prompt)
            # 若 content 包含工具调用，构造 tool_calls 结构
            tool_calls = []
            try:
                parsed = extract_json_from_text(content)
                if isinstance(parsed, dict) and "tool_calls" in parsed and parsed["tool_calls"]:
                    for tc in parsed["tool_calls"][:3]:
                        tool_calls.append({"name": tc.get("tool") or tc.get("name") or "", "args": tc.get("arguments") or {}, "id": f"call_{int(time.time()*1000)}_{len(tool_calls)}", "type": "tool_call"})
                    # 若有工具调用，content 用 reply
                    reply = parsed.get("reply", "")
                    generation = ChatGeneration(message=AIMessage(content=reply, tool_calls=tool_calls if tool_calls else None))
                    return ChatResult(generations=[generation])
            except Exception:
                pass
            generation = ChatGeneration(message=AIMessage(content=content))
            return ChatResult(generations=[generation])

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            # 同步版本（LangChain 要求），用 asyncio run
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # 在已有 loop 中无法同步调用，直接抛错让 LangChain 走 async 路径
                    raise RuntimeError("同步调用在异步上下文中，请使用 astream")
                return asyncio.run(self._agenerate(messages, stop, run_manager, **kwargs))
            except RuntimeError:
                # 回退：直接调用 llm_service 同步逻辑（简化）
                raise

        async def _astream(self, messages: List[BaseMessage], stop=None, run_manager=None, **kwargs):
            llm_messages = self._convert_messages(messages)
            async for chunk in llm_service.chat_stream(llm_messages, temperature=kwargs.get("temperature", 0.3)):
                # LangChain 期望 yield ChatGenerationChunk，但简化：直接 yield token
                # 这里通过回调发送，这里返回 AIMessageChunk 模拟
                from langchain_core.messages import AIMessageChunk
                yield AIMessageChunk(content=chunk)

            # 注意：此简化版不处理 tool_calls 流式，tool_calls 将在 _agenerate 解析

    class StreamingCallback(AsyncCallbackHandler):
        """将 LLM token 流式推送至 WebSocket 回调"""
        def __init__(self, send_func):
            self.send_func = send_func  # async def send(event, data)

        async def on_llm_new_token(self, token: str, **kwargs):
            try:
                await self.send_func("agent_stream_chunk", {"delta": token})
            except Exception:
                pass

        async def on_tool_start(self, serialized, input_str, **kwargs):
            try:
                tool_name = serialized.get("name") if isinstance(serialized, dict) else str(serialized)
                await self.send_func("tool_calling", {"tool_name": tool_name, "arguments": {}, "status": "executing"})
            except Exception:
                pass


def _mcp_to_langchain_tools() -> List[Any]:
    """将 MCP tools 转为 LangChain StructuredTool 列表（带正确 args_schema，避免 kwargs 嵌套）"""
    if not HAS_LANGCHAIN:
        return []
    from pydantic import create_model, Field, BaseModel
    tools = []
    for mcp_tool in mcp_registry.get_all_tools():
        name = mcp_tool.name
        desc = mcp_tool.description or ""
        schema = mcp_tool.input_schema or {"type": "object", "properties": {}}
        # 构建 Pydantic args_schema 以避免 **kwargs 嵌套问题
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        field_defs = {}
        for prop_name, prop_def in props.items():
            if not isinstance(prop_def, dict):
                prop_def = {"type": "string"}
            ptype = prop_def.get("type", "string")
            desc_p = prop_def.get("description", "")
            # 映射 JSON Schema type 到 Python 类型
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
        # 若无属性，创建一个空模型
        if not field_defs:
            # 创建一个允许任意额外字段的空模型，避免 LangChain 报错
            ArgsModel = create_model(f"{name}Args", __base__=BaseModel)
            ArgsModel.model_config = {"extra": "allow"}
        else:
            try:
                ArgsModel = create_model(f"{name}Args", **field_defs)  # type: ignore
            except Exception as e:
                print(f"[LangChainAgent] create_model for {name} failed: {e}")
                ArgsModel = None

        # 构造同步执行函数（供 LangChain 调用）
        def make_func(tool_name: str):
            def _func(**kwargs):
                # 同步包装：调用 async 的 execute_tool
                import asyncio
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        # 无法在运行 loop 中同步调用，抛错让 LangChain 走 async
                        raise RuntimeError("需异步执行")
                    return asyncio.run(mcp_registry.execute_tool(tool_name, kwargs))
                except RuntimeError:
                    # 返回提示
                    return {"error": "async required"}
            async def _afunc(**kwargs):
                # 解包 LangChain 可能的嵌套 kwargs (如 {"kwargs": {"prompt": "..."}})
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
                # 兼容：部分工具的输入是 JSON 字符串
                if "input" in kwargs and isinstance(kwargs["input"], str) and len(kwargs) == 1:
                    try:
                        kwargs = json.loads(kwargs["input"])
                    except Exception:
                        pass
                result = await mcp_registry.execute_tool(tool_name, kwargs)
                # 返回字符串供 LLM
                if result.status == "success":
                    return json.dumps(result.result, ensure_ascii=False)[:4000]
                else:
                    return json.dumps({"error": result.error}, ensure_ascii=False)
            return _func, _afunc

        func, afunc = make_func(name)
        try:
            if ArgsModel is not None:
                tool = StructuredTool.from_function(
                    func=func,
                    coroutine=afunc,
                    name=name,
                    description=desc,
                    args_schema=ArgsModel,
                )
            else:
                tool = StructuredTool.from_function(
                    func=func,
                    coroutine=afunc,
                    name=name,
                    description=desc,
                )
            tools.append(tool)
        except Exception as e:
            print(f"[LangChainAgent] tool {name} convert failed: {e}")
    return tools


# 构建带工具的 Prompt 模板
def _build_prompt_template():
    if not HAS_LANGCHAIN:
        return None
    # 复用现有的 AGENT_SYSTEM_PROMPT，但增加记忆占位
    from app.api.routes import AGENT_SYSTEM_PROMPT as BASE_PROMPT
    # 增加记忆与循环指引
    extra = """
你是一个具备多轮记忆与工具循环能力的导演 Agent。
- 你会记住之前的对话历史（chat_history），可基于之前的工具结果继续推理
- 你可以进行多轮工具调用，直到任务完成（最多6轮）
- 每次调用工具后，你会看到工具返回结果，再决定下一步是继续调用工具还是直接回复用户
- 请保持简洁、高效、中文回复
"""
    system = BASE_PROMPT + "\n\n" + extra
    # ChatPromptTemplate 包含历史
    try:
        prompt = ChatPromptTemplate.from_messages([
            ("system", system),
            MessagesPlaceholder(variable_name="chat_history", optional=True),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad", optional=True),
        ])
        return prompt
    except Exception as e:
        print(f"[LangChainAgent] prompt build failed: {e}")
        return None


# ===================== 核心执行逻辑 =====================

async def run_agent_with_langchain(
    prompt: str,
    context: Dict[str, Any],
    session_id: str = "default",
    websocket=None,
    max_iterations: Optional[int] = None,
    streaming: bool = True,
) -> Dict[str, Any]:
    """
    使用 LangChain 进行多轮循环执行
    - session_id 用于记忆隔离（按项目或用户）
    - websocket 用于流式推送（若提供）
    - max_iterations: 可选轮次上限；默认 None=无上限（直到模型不再调用工具）。
      防失控双保险：绝对安全上限 200 轮 + 连续 3 轮完全相同的工具调用判定卡死自动收尾
    返回 {"reply": str, "tool_calls": [], "suggested_actions": []}
    """
    # 取历史
    async with _get_session_lock(session_id):
        history = SESSION_MEMORY.get(session_id, [])
        history = _trim_history(history)

    # 构造当前输入（带上下文）
    context_str = json.dumps(context, ensure_ascii=False)[:2000] if context else ""
    human_content = prompt
    if context_str and context_str != "{}":
        human_content = f"指令: {prompt}\n上下文: {context_str}"

    # 若 LangChain 不可用，回退到原 llm_service 单轮
    if not HAS_LANGCHAIN or not HAS_OPENAI and not settings.OPENAI_API_KEY and not settings.MINIMAX_API_KEY:
        # 简单回退：直接调用 llm_service
        from app.api.routes import AGENT_SYSTEM_PROMPT
        try:
            decision = await llm_service.chat_json(
                system_prompt=AGENT_SYSTEM_PROMPT,
                user_prompt=json.dumps({"instruction": prompt, "context": context}, ensure_ascii=False),
                temperature=0.2,
            )
            # 记忆
            async with _get_session_lock(session_id):
                SESSION_MEMORY[session_id].append(HumanMessage(content=human_content) if HAS_LANGCHAIN else {"role": "user", "content": human_content})
                SESSION_MEMORY[session_id].append(AIMessage(content=decision.get("reply","")) if HAS_LANGCHAIN else {"role":"assistant","content":decision.get("reply","")})
            return decision
        except Exception as e:
            raise LLMServiceError(str(e))

    # 尝试使用 ChatOpenAI + Tools 循环
    try:
        # 获取 LLM
        llm = get_chat_model(streaming=streaming)
        if llm is None:
            raise RuntimeError("无法初始化 Chat Model")

        # 获取工具
        tools = _mcp_to_langchain_tools()
        # 绑定工具到 LLM（支持 tool calling）
        llm_with_tools = llm
        if hasattr(llm, "bind_tools") and tools:
            try:
                llm_with_tools = llm.bind_tools(tools)
            except Exception as e:
                print(f"[LangChainAgent] bind_tools failed: {e}")

        # 准备消息
        messages: List[BaseMessage] = []
        # 系统提示：循环模式使用 LOOP 版（原生 tool calling + 多步持续执行策略），
        # 不带"严格输出 JSON/最多 2 个工具"的单轮兜底约束（历史bug：该约束导致模型一轮工具后就 JSON 总结收工）
        from app.api.routes import AGENT_LOOP_SYSTEM_PROMPT
        system_extra = "\n\n你是具备多轮记忆的导演 Agent，可进行多轮工具调用且无固定轮次上限——持续执行直到用户目标全部完成，请基于历史与工具结果持续推理。"
        messages.append(SystemMessage(content=AGENT_LOOP_SYSTEM_PROMPT + system_extra))
        # 历史
        for h in history:
            messages.append(h)
        # 当前用户消息
        messages.append(HumanMessage(content=human_content))

        # 用于收集流式内容
        full_reply = ""
        executed_tools = []
        # 发送 thinking 事件
        if websocket:
            try:
                await websocket.send_json({"event": "agent_thinking", "message": f"正在解析导演指令: 「{prompt[:40]}」..."})
            except Exception:
                pass

        # 循环执行 — 无固定轮次上限：直到模型不再调用工具（目标完成）才结束。
        # 防失控双保险：① 连续 3 轮完全相同的工具调用（同名同参）判定卡死自动收尾；② 绝对安全上限 200 轮
        iteration = 0
        stall_sig = None
        stall_count = 0
        safety_cap = 200
        while True:
            iteration += 1
            if max_iterations and iteration > max_iterations:
                full_reply = content if 'content' in locals() else ""
                break
            if iteration > safety_cap:
                full_reply = (content if 'content' in locals() else "") + "\n\n（已达到单次任务安全轮次上限 200，任务未完成可让我继续。）"
                break
            content = ""
            tool_calls: List[Dict[str, Any]] = []
            result = None
            last_err: Optional[Exception] = None
            # ainvoke 双重试：代理/网络抖动时先重试而非直接跌落单轮兜底（单轮兜底无循环，是"一步即停"的历史根因之一）
            for _attempt in range(2):
                try:
                    # 统一使用非流式获取决策（兼容 Studio JSON 与 OpenAI function calling）
                    result = await llm_with_tools.ainvoke(messages)
                    break
                except Exception as _e:
                    last_err = _e
                    result = None
                    print(f"[LangChainAgent] ainvoke failed (attempt {_attempt + 1}/2): {_e}")
                    await asyncio.sleep(0.8)
            if result is None:
                print(f"[LangChainAgent] ainvoke 重试仍失败: {last_err}，fallback to llm_service 单轮")
                try:
                    from app.api.routes import AGENT_SYSTEM_PROMPT as _JSON_PROMPT
                    decision = await llm_service.chat_json(
                        system_prompt=_JSON_PROMPT,
                        user_prompt=json.dumps({"instruction": prompt, "context": context, "history": [m.content for m in history[-6:]]}, ensure_ascii=False),
                        temperature=0.2,
                    )
                    for call in (decision.get("tool_calls") or [])[:3]:
                        tool_name = call.get("tool", "")
                        args = call.get("arguments") or {}
                        if websocket:
                            await websocket.send_json({"event": "tool_calling", "tool_name": tool_name, "arguments": args, "status": "executing"})
                        result = await mcp_registry.execute_tool(tool_name, args)
                        if websocket:
                            await websocket.send_json({"event": "tool_result", "tool_name": tool_name, "status": result.status, "result": result.result if result.status=="success" else None, "error": result.error if result.status!="success" else None})
                    reply = decision.get("reply", "")
                    # 流式推送最终回复
                    if websocket and streaming:
                        await websocket.send_json({"event": "agent_stream_start"})
                        for i in range(0, len(reply), 6):
                            await websocket.send_json({"event": "agent_stream_chunk", "delta": reply[i:i+6]})
                            await asyncio.sleep(0.02)
                    async with _get_session_lock(session_id):
                        SESSION_MEMORY[session_id].append(HumanMessage(content=human_content))
                        SESSION_MEMORY[session_id].append(AIMessage(content=reply))
                        SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])
                    return {"reply": reply, "tool_calls": decision.get("tool_calls") or [], "suggested_actions": decision.get("suggested_actions") or [], "executed_tools": decision.get("tool_calls") or []}
                except Exception as e3:
                    raise e3
            # 解析决策（解析异常不触发单轮兜底，下一轮重试即可）
            try:
                content = result.content if hasattr(result, "content") else str(result)
                tool_calls = getattr(result, "tool_calls", None) or []
                # 处理 LangChain 可能将 tool_calls 放在 additional_kwargs
                if not tool_calls and hasattr(result, "additional_kwargs"):
                    ak = getattr(result, "additional_kwargs", {}) or {}
                    if isinstance(ak, dict) and "tool_calls" in ak and ak["tool_calls"]:
                        for tc in ak["tool_calls"]:
                            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                            tool_calls.append({"name": fn.get("name") or tc.get("name") or "", "args": json.loads(fn.get("arguments") or "{}") if isinstance(fn.get("arguments"), str) else fn.get("arguments") or {}, "id": tc.get("id") or f"call_{iteration}"})
                # JSON 兼容：若仍无 tool_calls 但 content 包含 JSON，尝试解析
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
            except Exception as _pe:
                print(f"[LangChainAgent] 决策解析异常: {_pe}")
                content, tool_calls = str(result), []

            # 处理工具调用 — 先流式推送思考过程（P 思考展示）
            if tool_calls:
                if content and content.strip() and websocket and streaming:
                    try:
                        await websocket.send_json({"event": "agent_thinking_start"})
                        for i in range(0, len(content), 6):
                            await websocket.send_json({"event": "agent_thinking_chunk", "delta": content[i:i+6]})
                            await asyncio.sleep(0.012)
                        await websocket.send_json({"event": "agent_thinking_end"})
                    except Exception:
                        pass
                # 卡死检测：连续 3 轮完全相同的工具调用（同名同参）判定为空转，自动收尾
                _sig = json.dumps(
                    [[tc.get("name") or tc.get("tool") or "", json.dumps(tc.get("args") or tc.get("arguments") or {}, ensure_ascii=False, sort_keys=True, default=str)] for tc in tool_calls],
                    ensure_ascii=False,
                )
                if _sig == stall_sig:
                    stall_count += 1
                else:
                    stall_sig = _sig
                    stall_count = 1
                if stall_count >= 3:
                    full_reply = (content or "") + "\n\n（检测到连续相同的工具调用，已自动停止以避免空转；可调整指令后让我继续。）"
                    messages.append(AIMessage(content=full_reply))
                    break
                # 通知前端开始工具调用
                # 先将 AIMessage 加入历史
                messages.append(AIMessage(content=content or "", tool_calls=tool_calls))
                for tc in tool_calls:
                    name = tc.get("name") or tc.get("tool") or ""
                    args = tc.get("args") or tc.get("arguments") or {}
                    if not name:
                        continue
                    # 清理 args 可能是字符串
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except Exception:
                            args = {}
                    if websocket:
                        try:
                            await websocket.send_json({"event": "tool_calling", "tool_name": name, "arguments": args, "status": "executing"})
                        except Exception:
                            pass
                    result = await mcp_registry.execute_tool(name, args, project_context=context.get("project") if isinstance(context, dict) else None)
                    executed_tools.append({"tool_name": name, "arguments": args, "status": result.status, "result": result.result, "error": result.error})
                    if websocket:
                        try:
                            payload = {"event": "tool_result", "tool_name": name, "status": result.status}
                            if result.status == "success":
                                payload["result"] = result.result
                            else:
                                payload["error"] = result.error
                            await websocket.send_json(payload)
                        except Exception:
                            pass
                    # 将工具结果加入消息历史
                    tool_result_str = json.dumps(result.result if result.status == "success" else {"error": result.error}, ensure_ascii=False)[:4000]
                    messages.append(ToolMessage(content=tool_result_str, tool_call_id=tc.get("id") or name, name=name))
                # 继续下一轮循环，让 LLM 基于工具结果生成下一步
                # 重置 content 继续
                continue
            else:
                # 无工具调用，结束循环 — 流式推送最终回复
                full_reply = content
                if websocket and streaming and full_reply:
                    try:
                        await websocket.send_json({"event": "agent_stream_start"})
                        # 真实流式：按 6 字符分块推送，模拟 token 流
                        chunk_size = 6
                        for i in range(0, len(full_reply), chunk_size):
                            await websocket.send_json({"event": "agent_stream_chunk", "delta": full_reply[i:i+chunk_size]})
                            await asyncio.sleep(0.015)
                    except Exception:
                        pass
                # 加入历史
                messages.append(AIMessage(content=full_reply))
                break

        # 去除 think 标签
        full_reply = strip_think_tags(full_reply) if full_reply else "指令已执行。"

        # 保存记忆
        async with _get_session_lock(session_id):
            # 追加当前轮
            SESSION_MEMORY[session_id].append(HumanMessage(content=human_content))
            SESSION_MEMORY[session_id].append(AIMessage(content=full_reply))
            SESSION_MEMORY[session_id] = _trim_history(SESSION_MEMORY[session_id])

        # 若最终回复未通过循环内流式发送（例如循环内未触发流式），则在此处补发
        if websocket and streaming and full_reply:
            # 检查是否已发送过（通过 executed_tools 判断）—— 简单补发兜底，若前端已收到则会去重
            pass

        return {
            "reply": full_reply,
            "tool_calls": [{"tool": t["tool_name"], "arguments": t["arguments"]} for t in executed_tools] if executed_tools else [],
            "suggested_actions": [],
            "executed_tools": executed_tools,
        }

    except LLMServiceError as e:
        raise
    except Exception as e:
        print(f"[LangChainAgent] run failed: {e}")
        import traceback
        traceback.print_exc()
        # 回退
        try:
            from app.api.routes import AGENT_SYSTEM_PROMPT as _PROMPT
            decision = await llm_service.chat_json(
                system_prompt=_PROMPT,
                user_prompt=json.dumps({"instruction": prompt, "context": context}, ensure_ascii=False),
                temperature=0.2,
            )
            async with _get_session_lock(session_id):
                SESSION_MEMORY[session_id].append(HumanMessage(content=human_content) if HAS_LANGCHAIN else {"role":"user","content":human_content})
                SESSION_MEMORY[session_id].append(AIMessage(content=decision.get("reply","")) if HAS_LANGCHAIN else {"role":"assistant","content":decision.get("reply","")})
            return decision
        except Exception as e2:
            raise LLMServiceError(f"Agent 执行失败: {e2}") from e2


async def clear_session(session_id: str):
    async with _get_session_lock(session_id):
        SESSION_MEMORY.pop(session_id, None)

def get_history(session_id: str) -> List[Any]:
    return SESSION_MEMORY.get(session_id, [])

# 为了兼容旧接口，提供简单的非流式封装
async def chat_once(prompt: str, context: Dict[str, Any], session_id: str = "default") -> Dict[str, Any]:
    return await run_agent_with_langchain(prompt, context, session_id=session_id, websocket=None, streaming=False)
