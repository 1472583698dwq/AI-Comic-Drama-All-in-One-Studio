import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Sparkles, 
  Send, 
  Bot, 
  User, 
  CheckCircle2, 
  Cpu, 
  X, 
  Maximize2,
  Minimize2,
  RefreshCw,
  ChevronDown,
  Film,
  GripHorizontal,
  Move
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
const WS_URL = isDev
  ? 'ws://127.0.0.1:8000/api/v1/ws/agent'
  : (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/ws/agent`
      : 'ws://127.0.0.1:8000/api/v1/ws/agent');

interface Message {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  toolCall?: {
    toolName: string;
    status: 'executing' | 'completed' | 'error';
  };
  suggestedActions?: string[];
  time: string;
  isStreaming?: boolean;
}

export const AgentChatDrawer: React.FC = () => {
  const { project, activeShotId, setActiveTab } = useProjectStore();

  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [inputText, setInputText] = useState('');
  // LangChain 会话记忆：按项目隔离，支持多轮
  const [sessionId, setSessionId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('agent_session_id');
      if (stored) return stored;
      const nid = `sess_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      localStorage.setItem('agent_session_id', nid);
      return nid;
    } catch { return `sess_${Date.now()}`; }
  });
  // 当项目切换时，使用项目级 session 实现上下文隔离
  const effectiveSessionId = project?.id ? `proj_${project.id}_${sessionId.slice(0,8)}` : sessionId;
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'm1',
      sender: 'agent',
      text: '你好！我是你的 AI 漫剧导演 Agent。你可以通过自然语言指挥我深度拆解小说、调整 3D 运镜轨迹、调用生图引擎重绘、生成角色配音或导出剪映工程。',
      suggestedActions: [
        '为当前镜头规划 3D 特写运镜',
        '将当前台词情绪调整为激动',
        '检查当前分镜提示词并优化',
      ],
      time: '刚刚',
    },
  ]);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState("");
  const [isThinkingStreaming, setIsThinkingStreaming] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  // Position & Dragging State
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  // Initialize position to bottom right when first opened
  useEffect(() => {
    if (isOpen && position === null && typeof window !== 'undefined') {
      const w = isExpanded ? 520 : 384;
      const h = isExpanded ? 640 : 500;
      setPosition({
        x: Math.max(20, window.innerWidth - w - 24),
        y: Math.max(20, window.innerHeight - h - 30),
      });
    }
  }, [isOpen, isExpanded, position]);

  // Dragging event listeners
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const w = isExpanded ? 520 : 384;
      const h = isExpanded ? 640 : 500;
      const newX = Math.max(10, Math.min(window.innerWidth - w - 10, e.clientX - dragOffsetRef.current.x));
      const newY = Math.max(10, Math.min(window.innerHeight - h - 10, e.clientY - dragOffsetRef.current.y));
      setPosition({ x: newX, y: newY });
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging || !e.touches[0]) return;
      const touch = e.touches[0];
      const w = isExpanded ? 520 : 384;
      const h = isExpanded ? 640 : 500;
      const newX = Math.max(10, Math.min(window.innerWidth - w - 10, touch.clientX - dragOffsetRef.current.x));
      const newY = Math.max(10, Math.min(window.innerHeight - h - 10, touch.clientY - dragOffsetRef.current.y));
      setPosition({ x: newX, y: newY });
    };

    const onStopDrag = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onStopDrag);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', onStopDrag);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onStopDrag);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onStopDrag);
    };
  }, [isDragging, isExpanded]);

  const handleStartDrag = (clientX: number, clientY: number) => {
    if (!position) return;
    setIsDragging(true);
    dragOffsetRef.current = {
      x: clientX - position.x,
      y: clientY - position.y,
    };
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen, isThinking]);

  // Connect WebSocket with real-time streaming tokens
  const connectWs = useCallback(() => {
    try {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return wsRef.current;
      }
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const event = data.event;

          if (event === 'agent_thinking') {
            setIsThinking(true);
          } else if (event === 'agent_thinking_start') {
            setIsThinking(true);
            setIsThinkingStreaming(true);
            setThinkingText("");
            setShowThinking(true);
          } else if (event === 'agent_thinking_chunk') {
            setIsThinking(true);
            setIsThinkingStreaming(true);
            setThinkingText(prev=> prev + (data.delta || ""));
          } else if (event === 'agent_thinking_end') {
            setIsThinkingStreaming(false);
          } else if (event === 'tool_calling') {
            setMessages((prev) => [
              ...prev,
              {
                id: 'tool-' + Date.now(),
                sender: 'system',
                text: `正在调用 MCP 工具: ${data.tool_name}...`,
                toolCall: { toolName: data.tool_name, status: 'executing' },
                time: new Date().toLocaleTimeString(),
              },
            ]);
          } else if (event === 'tool_result') {
            setMessages((prev) =>
              prev.map((m) =>
                m.toolCall?.toolName === data.tool_name && m.toolCall?.status === 'executing'
                  ? {
                      ...m,
                      text: data.status === 'success' ? `✓ 工具 ${data.tool_name} 执行成功` : `✕ 工具 ${data.tool_name} 失败: ${data.error}`,
                      toolCall: { ...m.toolCall!, status: data.status === 'success' ? 'completed' : 'error' },
                    }
                  : m
              )
            );
            // 新增生成源全局刷新
            if (data.tool_name === 'register_custom_provider' && data.status === 'success') {
              try { window.dispatchEvent(new Event('provider-list-refresh')); } catch {}
            }
          } else if (event === 'agent_stream_start') {
            setIsThinking(false);
            const streamId = 'agent-' + Date.now();
            streamingMsgIdRef.current = streamId;
            setMessages((prev) => [
              ...prev,
              {
                id: streamId,
                sender: 'agent',
                text: '',
                isStreaming: true,
                time: new Date().toLocaleTimeString(),
              },
            ]);
          } else if (event === 'agent_stream_chunk') {
            setIsThinking(false);
            const streamId = streamingMsgIdRef.current;
            if (streamId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId
                    ? { ...m, text: m.text + (data.delta || '') }
                    : m
                )
              );
            }
          } else if (event === 'agent_response') {
            setIsThinking(false);
            const streamId = streamingMsgIdRef.current;
            if (streamId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId
                    ? { ...m, text: data.message || m.text, isStreaming: false, suggestedActions: data.suggested_actions }
                    : m
                )
              );
              streamingMsgIdRef.current = null;
            } else {
              setMessages((prev) => [
                ...prev,
                {
                  id: 'agent-' + Date.now(),
                  sender: 'agent',
                  text: data.message,
                  suggestedActions: data.suggested_actions,
                  time: new Date().toLocaleTimeString(),
                },
              ]);
            }
          } else if (event === 'error') {
            setIsThinking(false);
            setMessages((prev) => [
              ...prev,
              {
                id: 'err-' + Date.now(),
                sender: 'system',
                text: '⚠️ ' + data.message,
                time: new Date().toLocaleTimeString(),
              },
            ]);
          }
        } catch (e) {
          console.warn(e);
        }
      };
      return ws;
    } catch (e) {
      setWsConnected(false);
      return null;
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      connectWs();
    }
  }, [isOpen, connectWs]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputText;
    if (!text.trim() || isThinking) return;

    const userMsg: Message = {
      id: 'msg-' + Date.now(),
      sender: 'user',
      text,
      time: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    if (inputRef.current) { inputRef.current.style.height = 'auto'; }
    setIsThinking(true);
    setThinkingText("");
    setIsThinkingStreaming(false);
    setShowThinking(true);

    const shots = project?.scenes.flatMap((s) => s.shots) || [];
    const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

    // P1: 画布感知透传
    let canvas_summary: string | null = null;
    try {
      const cs = useCanvasStore.getState().summary;
      const cn = useCanvasStore.getState().nodes;
      if (cn.length > 0) canvas_summary = cs;
    } catch {}
    const contextPayload = {
      project_title: project?.title,
      active_shot: activeShot
        ? {
            id: activeShot.id,
            shot_index: activeShot.shot_index,
            action_desc: activeShot.action_desc,
            image_prompt: activeShot.image_prompt,
            speaker_name: activeShot.speaker_name,
            emotion: activeShot.emotion,
            dialogue: activeShot.dialogue,
            camera_framing: activeShot.camera_framing,
            camera_motion: activeShot.camera_motion,
          }
        : null,
      platform: 'desktop',
      canvas_summary,
      workspace: useProjectStore.getState().workspace,
    };

    // 1. Try WebSocket (LangChain 流式)
    let ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = connectWs();
      // 等待一帧确保连接建立
      await new Promise(r=> setTimeout(r, 120));
      ws = wsRef.current;
    }

    let sentViaWs = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            action: 'agent_prompt',
            prompt: text,
            context: contextPayload,
            session_id: effectiveSessionId,
          })
        );
        sentViaWs = true;
      } catch (e) {
        sentViaWs = false;
      }
    }

    // 2. HTTP SSE 真实流式 Fallback (LangChain)
    if (!sentViaWs) {
      const streamId = 'agent-' + Date.now();
      setMessages((prev) => [
        ...prev,
        {
          id: streamId,
          sender: 'agent',
          text: '',
          isStreaming: true,
          time: new Date().toLocaleTimeString(),
        },
      ]);
      try {
        // 优先使用 SSE 流式接口
        await apiService.agentChatStream(text, contextPayload, effectiveSessionId, (event, data)=>{
          if (event === 'agent_stream_chunk') {
            setIsThinking(false);
            setMessages(prev=> prev.map(m=> m.id===streamId ? {...m, text: m.text + (data.delta||'') } : m));
          } else if (event === 'tool_calling') {
            setMessages(prev=> [...prev, {
              id: 'tool-' + Date.now() + Math.random(),
              sender: 'system',
              text: `正在调用 MCP 工具: ${data.tool_name}...`,
              toolCall: { toolName: data.tool_name, status: 'executing' },
              time: new Date().toLocaleTimeString(),
            }]);
          } else if (event === 'tool_result') {
            setMessages(prev=> prev.map(m=> m.toolCall?.toolName===data.tool_name && m.toolCall?.status==='executing' ? {...m, text: data.status==='success'? `✓ 工具 ${data.tool_name} 执行成功` : `✕ 工具 ${data.tool_name} 失败: ${data.error}`, toolCall: {...m.toolCall!, status: data.status==='success'?'completed':'error'}} : m));
          } else if (event === 'agent_thinking') {
            setIsThinking(true);
          } else if (event === 'agent_response') {
            setIsThinking(false);
            setMessages(prev=> prev.map(m=> m.id===streamId ? {...m, text: data.message || m.text, isStreaming:false, suggestedActions: data.suggested_actions} : m));
          } else if (event === 'error') {
            setIsThinking(false);
            setMessages(prev=> [...prev, {id:'err-'+Date.now(), sender:'system', text:'⚠️ '+data.message, time: new Date().toLocaleTimeString()}]);
          }
        });
        setIsThinking(false);
        // 确保结束状态
        setMessages(prev=> prev.map(m=> m.id===streamId ? {...m, isStreaming:false} : m));
      } catch (e: any) {
        // 回退到非流式
        try {
          const res = await apiService.agentChat(text, contextPayload, effectiveSessionId);
          setIsThinking(false);
          if (res.executed_tools && res.executed_tools.length > 0) {
            for (const tool of res.executed_tools) {
              setMessages((prev) => [
                ...prev,
                {
                  id: 'tool-' + Math.random(),
                  sender: 'system',
                  text: tool.status === 'success' ? `✓ 工具 ${tool.tool_name} 执行成功` : `✕ 工具 ${tool.tool_name} 失败: ${tool.error}`,
                  toolCall: { toolName: tool.tool_name, status: tool.status === 'success' ? 'completed' : 'error' },
                  time: new Date().toLocaleTimeString(),
                },
              ]);
            }
          }
          const fullText = res.reply || '指令已完成。';
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, text: fullText, isStreaming: false, suggestedActions: res.suggested_actions }
                : m
            )
          );
        } catch (e2:any) {
          setIsThinking(false);
          setMessages((prev) => [
            ...prev,
            {
              id: 'err-' + Date.now(),
              sender: 'system',
              text: '⚠️ 导演 Agent 响应异常: ' + (e2?.message || '未知错误'),
              time: new Date().toLocaleTimeString(),
            },
          ]);
          setMessages(prev=> prev.map(m=> m.id===streamId ? {...m, text: m.text || '请求失败', isStreaming:false} : m));
        }
      }
    }
  };

  return (
    <>
      {/* Floating Chat Drawer Window (Draggable) */}
      {isOpen && position && (
        <div
          style={{
            left: `${position.x}px`,
            top: `${position.y}px`,
            position: 'fixed',
            zIndex: 999,
          }}
          className={`bg-surface rounded-2xl border border-border shadow-2xl flex flex-col overflow-hidden animate-fade-in select-text transition-shadow ${
            isDragging ? 'shadow-brand/40 ring-2 ring-brand cursor-grabbing' : 'shadow-2xl'
          } ${
            isExpanded
              ? 'w-[520px] h-[640px] max-w-[92vw] max-h-[85vh]'
              : 'w-96 h-[500px] max-w-[92vw] max-h-[75vh]'
          }`}
        >
          {/* Header - Drag Handle */}
          <div
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              handleStartDrag(e.clientX, e.clientY);
            }}
            onTouchStart={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              if (e.touches[0]) handleStartDrag(e.touches[0].clientX, e.touches[0].clientY);
            }}
            className="h-12 px-4 border-b border-border flex items-center justify-between bg-surface-secondary/95 shrink-0 backdrop-blur-md cursor-grab active:cursor-grabbing select-none"
            title="按住鼠标拖拽窗口位置"
          >
            <div className="flex items-center space-x-2">
              <GripHorizontal className="w-4 h-4 text-gray-500 mr-0.5" />
              <div className="p-1.5 rounded-lg bg-gradient-to-r from-brand to-brand-blue text-white shadow-md shadow-brand/20">
                <Bot className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-1.5">
                  <span className="text-xs font-bold text-white">AI 漫剧导演 Agent</span>
                  <span
                    className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-accent-green animate-pulse' : 'bg-amber-400'}`}
                    title={wsConnected ? 'WebSocket 双向流实时连接' : 'HTTP 智能通道已就绪'}
                  />
                </div>
                <div className="text-[9px] text-gray-400">
                  LangChain {wsConnected ? '· 实时流式' : '· HTTP SSE'} · 多轮记忆·循环
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-1">
              <button
                onClick={async()=>{
                  try {
                    await apiService.clearAgentHistory(effectiveSessionId);
                    setMessages([{
                      id: 'm1',
                      sender: 'agent',
                      text: '已清空对话历史（LangChain 记忆已重置）。你可以开始新话题了。',
                      time: new Date().toLocaleTimeString(),
                    }]);
                    // 同时通知 WS 清空
                    const ws = wsRef.current;
                    if (ws && ws.readyState===WebSocket.OPEN) {
                      ws.send(JSON.stringify({action:'clear_history', session_id: effectiveSessionId}));
                    }
                  } catch(e:any){ alert(e.message); }
                }}
                className="p-1.5 rounded-lg text-gray-400 hover:text-amber-300 hover:bg-surface-tertiary transition-all"
                title="清空多轮记忆 (LangChain)"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    const w = isExpanded ? 384 : 520;
                    const h = isExpanded ? 500 : 640;
                    setPosition({
                      x: Math.max(20, window.innerWidth - w - 24),
                      y: Math.max(20, window.innerHeight - h - 30),
                    });
                  }
                  setIsExpanded(!isExpanded);
                }}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary transition-all"
                title={isExpanded ? '还原默认大小' : '放大窗口'}
              >
                {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary transition-all"
                title="收起悬浮窗"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Active Context Banner */}
          {activeShotId && (
            <div className="px-3.5 py-1.5 bg-brand/10 border-b border-brand/20 flex items-center justify-between text-[11px] text-brand-light shrink-0">
              <span className="flex items-center space-x-1.5 truncate">
                <Film className="w-3 h-3 shrink-0" />
                <span className="truncate">当前针对分镜: {project?.scenes.flatMap(s => s.shots).find(s => s.id === activeShotId)?.action_desc || '当前镜头'}</span>
              </span>
              <button
                onClick={() => setActiveTab('director3d')}
                className="text-[10px] text-brand-light underline ml-2 shrink-0 hover:text-white"
              >
                进入3D台
              </button>
            </div>
          )}

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar text-xs">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`p-3 rounded-2xl max-w-[88%] leading-relaxed ${
                    m.sender === 'user'
                      ? 'bg-gradient-to-r from-brand to-brand-blue text-white rounded-br-none shadow-sm'
                      : m.sender === 'system'
                      ? 'bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-bl-none'
                      : 'bg-surface-secondary border border-border text-gray-200 rounded-bl-none'
                  }`}
                >
                  <p className="whitespace-pre-wrap">
                    {m.text}
                    {m.isStreaming && (
                      <span className="inline-block w-1.5 h-3.5 bg-brand-light ml-1 animate-pulse align-middle" />
                    )}
                  </p>

                  {/* Tool Call Pill */}
                  {m.toolCall && (
                    <div className="mt-2 pt-2 border-t border-white/10 flex items-center space-x-1.5 text-[10px] font-mono">
                      <Cpu className={`w-3 h-3 ${m.toolCall.status === 'error' ? 'text-red-400' : 'text-accent-green'}`} />
                      <span className={m.toolCall.status === 'error' ? 'text-red-300' : 'text-accent-green'}>
                        MCP: {m.toolCall.toolName}
                      </span>
                      {m.toolCall.status === 'completed' ? (
                        <CheckCircle2 className="w-3 h-3 text-accent-green" />
                      ) : m.toolCall.status === 'error' ? (
                        <span className="text-red-400">✕</span>
                      ) : (
                        <span className="animate-spin text-accent-orange">⏳</span>
                      )}
                    </div>
                  )}

                  {/* Suggested Actions within Message */}
                  {m.suggestedActions && m.suggestedActions.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-white/10 space-y-1.5">
                      <div className="text-[10px] text-gray-400 font-medium">推荐执行：</div>
                      <div className="flex flex-wrap gap-1.5">
                        {m.suggestedActions.map((act, i) => (
                          <button
                            key={i}
                            onClick={() => handleSendMessage(act)}
                            className="text-[10px] px-2 py-1 rounded-lg bg-surface-tertiary hover:bg-brand/30 border border-border hover:border-brand text-gray-200 hover:text-white transition-all text-left"
                          >
                            ⚡ {act}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <span className="text-[9px] text-gray-500 mt-1 px-1">{m.time}</span>
              </div>
            ))}

            {/* 思考过程流式展示 */}
            {(isThinking || thinkingText) && (
              <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
                <button onClick={()=> setShowThinking(v=>!v)} className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-bold text-violet-300 hover:bg-violet-500/10">
                  <span className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${isThinkingStreaming ? 'bg-violet-400 animate-ping' : 'bg-violet-400'}`} />
                    思考过程 {isThinkingStreaming && <span className="font-normal text-violet-400/70">· 流式输出中…</span>}
                  </span>
                  <span className="text-[10px] text-violet-400/60">{showThinking ? '收起' : '展开'} {thinkingText ? `· ${thinkingText.length}字` : ''}</span>
                </button>
                {showThinking && (
                  <div className="px-3 pb-3 pt-1">
                    {thinkingText ? (
                      <div className="text-[11px] leading-relaxed text-violet-100 whitespace-pre-wrap max-h-[120px] overflow-y-auto custom-scrollbar bg-black/20 rounded-xl p-2 border border-violet-500/10">
                        {thinkingText}
                        {isThinkingStreaming && <span className="inline-block w-1.5 h-3 bg-violet-400 ml-1 animate-pulse align-middle" />}
                      </div>
                    ) : (
                      <div className="text-[11px] text-violet-300/70 flex items-center gap-1.5 py-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-ping" /> 导演正在分析指令与画布上下文…
                      </div>
                    )}
                    {/* 工具调用时间线简要 */}
                    {messages.filter(m=> m.toolCall).slice(-3).length>0 && (
                      <div className="mt-2 space-y-1">
                        {messages.filter(m=> m.toolCall).slice(-3).map(m=>(
                          <div key={m.id} className="text-[10px] font-mono flex items-center gap-1.5 text-violet-300/70">
                            <Cpu className="w-3 h-3" /> {m.toolCall?.toolName} <span className={m.toolCall?.status==='completed'?'text-emerald-400': m.toolCall?.status==='error'?'text-red-400':'text-amber-400'}>{m.toolCall?.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {isThinking && !thinkingText && !isThinkingStreaming && (
              <div className="flex items-center space-x-2 text-gray-400 text-xs py-1 px-1">
                <span className="w-2 h-2 rounded-full bg-brand-light animate-ping" />
                <span className="text-[11px]">导演 Agent 正在思考与调用 MCP 工具...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Action Preset Buttons */}
          <div className="px-3 py-2 bg-surface-secondary/40 border-t border-border/50 flex space-x-1.5 overflow-x-auto text-[10px] whitespace-nowrap custom-scrollbar shrink-0">
            {[
              '规划当前镜 3D 特写运镜',
              '重绘当前分镜画面 (ComfyUI)',
              '为当前台词生成角色配音',
              '导出剪映草稿工程',
            ].map((chip) => (
              <button
                key={chip}
                onClick={() => handleSendMessage(chip)}
                className="px-2.5 py-1 rounded-full bg-surface-tertiary border border-border hover:border-brand text-gray-300 hover:text-white transition-all"
              >
                {chip}
              </button>
            ))}
          </div>

          {/* Input Bar — 多行自适应 */}
          <div className="p-3 border-t border-border bg-surface flex items-end space-x-2 shrink-0">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                // auto-resize
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
              onInput={(e)=>{
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="向导演 Agent 下达指令（Shift+Enter 换行，Enter 发送）... 示例：把镜头改成俯视推镜 / 帮我接入这个API：https://..."
              rows={1}
              className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none overflow-y-auto min-h-[36px] max-h-[120px] leading-relaxed"
              style={{height: 'auto'}}
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputText.trim() || isThinking}
              className="p-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white disabled:opacity-40 hover:opacity-90 shadow-md shadow-brand/20 transition-all shrink-0 self-end"
              title="发送指令 (Enter)"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="px-3 pb-1 text-[10px] text-gray-500 text-right">Shift+Enter 换行 · 支持多行粘贴长文档</div>
        </div>
      )}

      {/* Floating Toggle Button (Fixed at Bottom-Right) */}
      <div className="fixed bottom-5 right-5 z-50">
        <button
          onClick={() => {
            if (!isOpen && position === null && typeof window !== 'undefined') {
              const w = isExpanded ? 520 : 384;
              const h = isExpanded ? 640 : 500;
              setPosition({
                x: Math.max(20, window.innerWidth - w - 24),
                y: Math.max(20, window.innerHeight - h - 30),
              });
            }
            setIsOpen(!isOpen);
          }}
          className="flex items-center space-x-2.5 px-4 py-2.5 rounded-full bg-gradient-to-r from-brand to-brand-blue hover:from-brand-light hover:to-brand text-white font-bold text-xs shadow-2xl shadow-brand/50 hover:scale-105 transition-all border border-white/20"
          title={isOpen ? '收起导演 Agent' : '展开 AI 漫剧导演 Agent 悬浮窗 (支持自由拖拽)'}
        >
          <div className="relative">
            <Sparkles className="w-4 h-4 text-white" />
            <span
              className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${
                wsConnected ? 'bg-accent-green' : 'bg-amber-400'
              }`}
            />
          </div>
          <span>导演 Agent</span>
          {isOpen ? <ChevronDown className="w-3.5 h-3.5 ml-0.5" /> : null}
        </button>
      </div>
    </>
  );
};
