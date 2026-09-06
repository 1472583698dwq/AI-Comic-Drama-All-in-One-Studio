import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Sparkles,
  Send,
  Bot,
  User,
  CheckCircle2,
  X,
  Maximize2,
  Minimize2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Film,
  GripHorizontal,
  Wand2,
  Lightbulb,
  Cpu,
  ArrowUpRight,
  Square,
  Pause,
  Copy,
  Check
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';
import { MarkdownText } from './MarkdownText';

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
const WS_URL = isDev
  ? 'ws://127.0.0.1:8000/api/v1/ws/agent'
  : (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/ws/agent`
      : 'ws://127.0.0.1:8000/api/v1/ws/agent');

export interface ToolCallItem {
  id: string;
  name: string;
  status: 'executing' | 'completed' | 'error';
  result?: any;
  error?: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  thinking?: string;
  isThinkingStreaming?: boolean;
  toolCalls?: ToolCallItem[];
  suggestedActions?: string[];
  time: string;
  isStreaming?: boolean;
}

export const AgentChatDrawer: React.FC = () => {
  const { project, activeShotId, setActiveTab } = useProjectStore();

  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [inputText, setInputText] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<Record<string, boolean>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // 单条消息复制（全局文字可复制入口之一）
  const handleCopyMessage = async (e: React.MouseEvent, id: string, text: string) => {
    e.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {}
    }
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId((v) => (v === id ? null : v)), 1500);
  };

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
  const effectiveSessionId = project?.id ? `proj_${project.id}_${sessionId.slice(0,8)}` : sessionId;

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'm-welcome',
      sender: 'agent',
      text: '你好！我是你的 AI 漫剧导演 Agent。\n我可以为你深度拆解小说文本、实时规划 3D 电影级运镜、联动 ComfyUI 生图与视频生成、合成角色音色并一键导出剪映工程。',
      suggestedActions: [
        '为当前镜头规划 3D 电影特写推镜',
        '将当前分镜台词情绪调整为激烈对峙',
        '一键全要素合成当前镜头提示词',
        '生成全片角色配音并对齐时长',
      ],
      time: '系统就绪',
    },
  ]);

  const [isThinking, setIsThinking] = useState(false);

  // Floating Button Drag Position State
  const [btnPos, setBtnPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('agent_float_btn_pos');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      x: typeof window !== 'undefined' ? window.innerWidth - 170 : 1200,
      y: typeof window !== 'undefined' ? window.innerHeight - 70 : 800,
    };
  });

  const [isBtnDragging, setIsBtnDragging] = useState(false);
  const btnDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; hasMoved: boolean }>({
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    hasMoved: false,
  });

  // Dialog Window Drag Position State
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const [isDialogDragging, setIsDialogDragging] = useState(false);
  const dialogDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number }>({
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentStreamingIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize dialog position when opened
  useEffect(() => {
    if (isOpen && dialogPos === null && typeof window !== 'undefined') {
      const w = isExpanded ? 540 : 400;
      const h = isExpanded ? 660 : 520;
      const targetX = Math.max(16, Math.min(window.innerWidth - w - 16, btnPos.x - w + 140));
      const targetY = Math.max(16, Math.min(window.innerHeight - h - 16, btnPos.y - h));
      setDialogPos({ x: targetX, y: targetY });
    }
  }, [isOpen, isExpanded, dialogPos, btnPos]);

  // Window bounds check on resize
  useEffect(() => {
    const handleResize = () => {
      if (typeof window === 'undefined') return;
      setBtnPos((prev) => ({
        x: Math.max(10, Math.min(window.innerWidth - 170, prev.x)),
        y: Math.max(10, Math.min(window.innerHeight - 65, prev.y)),
      }));
      if (dialogPos) {
        const w = isExpanded ? 540 : 400;
        const h = isExpanded ? 660 : 520;
        setDialogPos((prev) =>
          prev
            ? {
                x: Math.max(10, Math.min(window.innerWidth - w - 10, prev.x)),
                y: Math.max(10, Math.min(window.innerHeight - h - 10, prev.y)),
              }
            : null
        );
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [dialogPos, isExpanded]);

  // Floating Button Drag Handlers
  const handleBtnMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsBtnDragging(true);
    btnDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: btnPos.x,
      origY: btnPos.y,
      hasMoved: false,
    };
  };

  const handleBtnTouchStart = (e: React.TouchEvent) => {
    if (!e.touches[0]) return;
    const t = e.touches[0];
    setIsBtnDragging(true);
    btnDragRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      origX: btnPos.x,
      origY: btnPos.y,
      hasMoved: false,
    };
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isBtnDragging) return;
      const dx = e.clientX - btnDragRef.current.startX;
      const dy = e.clientY - btnDragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) {
        btnDragRef.current.hasMoved = true;
      }
      const nextX = Math.max(10, Math.min(window.innerWidth - 170, btnDragRef.current.origX + dx));
      const nextY = Math.max(10, Math.min(window.innerHeight - 65, btnDragRef.current.origY + dy));
      setBtnPos({ x: nextX, y: nextY });
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isBtnDragging || !e.touches[0]) return;
      const t = e.touches[0];
      const dx = t.clientX - btnDragRef.current.startX;
      const dy = t.clientY - btnDragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) {
        btnDragRef.current.hasMoved = true;
      }
      const nextX = Math.max(10, Math.min(window.innerWidth - 170, btnDragRef.current.origX + dx));
      const nextY = Math.max(10, Math.min(window.innerHeight - 65, btnDragRef.current.origY + dy));
      setBtnPos({ x: nextX, y: nextY });
    };

    const onMouseUp = () => {
      if (isBtnDragging) {
        setIsBtnDragging(false);
        if (btnDragRef.current.hasMoved) {
          localStorage.setItem('agent_float_btn_pos', JSON.stringify(btnPos));
        } else {
          setIsOpen((v) => !v);
        }
      }
    };

    if (isBtnDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onMouseUp);
    };
  }, [isBtnDragging, btnPos]);

  // Dialog Window Drag Handlers
  const handleDialogHeaderMouseDown = (e: React.MouseEvent) => {
    if (!dialogPos) return;
    if ((e.target as HTMLElement).closest('button')) return;
    setIsDialogDragging(true);
    dialogDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: dialogPos.x,
      origY: dialogPos.y,
    };
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDialogDragging) return;
      const w = isExpanded ? 540 : 400;
      const h = isExpanded ? 660 : 520;
      const dx = e.clientX - dialogDragRef.current.startX;
      const dy = e.clientY - dialogDragRef.current.startY;
      const nextX = Math.max(10, Math.min(window.innerWidth - w - 10, dialogDragRef.current.origX + dx));
      const nextY = Math.max(10, Math.min(window.innerHeight - h - 10, dialogDragRef.current.origY + dy));
      setDialogPos({ x: nextX, y: nextY });
    };

    const onMouseUp = () => {
      if (isDialogDragging) setIsDialogDragging(false);
    };

    if (isDialogDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDialogDragging, isExpanded]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen, isThinking]);

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
          const curId = currentStreamingIdRef.current;

          if (event === 'agent_thinking_start') {
            setIsThinking(true);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === curId ? { ...m, isThinkingStreaming: true, thinking: '' } : m))
              );
              setExpandedThinkingIds((prev) => ({ ...prev, [curId]: true }));
            }
          } else if (event === 'agent_thinking_chunk') {
            setIsThinking(true);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === curId
                    ? { ...m, isThinkingStreaming: true, thinking: (m.thinking || '') + (data.delta || '') }
                    : m
                )
              );
            }
          } else if (event === 'agent_thinking_end') {
            if (curId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === curId ? { ...m, isThinkingStreaming: false } : m))
              );
            }
          } else if (event === 'tool_calling') {
            setIsThinking(true);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== curId) return m;
                  const tools = [...(m.toolCalls || [])];
                  tools.push({
                    id: 'tc-' + Date.now(),
                    name: data.tool_name,
                    status: 'executing',
                  });
                  return { ...m, toolCalls: tools };
                })
              );
            }
          } else if (event === 'tool_result') {
            if (curId) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== curId) return m;
                  const tools = (m.toolCalls || []).map((t) =>
                    t.name === data.tool_name && t.status === 'executing'
                      ? {
                          ...t,
                          status: (data.status === 'success' ? 'completed' : 'error') as any,
                          result: data.result,
                          error: data.error,
                        }
                      : t
                  );
                  return { ...m, toolCalls: tools };
                })
              );
            }
            if (data.tool_name === 'register_custom_provider' && data.status === 'success') {
              try { window.dispatchEvent(new Event('provider-list-refresh')); } catch {}
            }
            if (data.tool_name && String(data.tool_name).startsWith('canvas_')) {
              try {
                window.dispatchEvent(new CustomEvent('agent-canvas-tool', { detail: { tool: data.tool_name, status: data.status, result: data.result, error: data.error } }));
                window.dispatchEvent(new CustomEvent('agent-canvas-updated', { detail: { tool: data.tool_name } }));
              } catch {}
            }
          } else if (event === 'agent_stream_start') {
            setIsThinking(false);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === curId ? { ...m, isStreaming: true, isThinkingStreaming: false } : m))
              );
            }
          } else if (event === 'agent_stream_chunk') {
            setIsThinking(false);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === curId ? { ...m, text: m.text + (data.delta || ''), isStreaming: true } : m
                )
              );
            }
          } else if (event === 'agent_response') {
            setIsThinking(false);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === curId
                    ? {
                        ...m,
                        text: data.message || m.text,
                        isStreaming: false,
                        isThinkingStreaming: false,
                        suggestedActions: data.suggested_actions,
                      }
                    : m
                )
              );
              currentStreamingIdRef.current = null;
            }
          } else if (event === 'error') {
            setIsThinking(false);
            if (curId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === curId
                    ? {
                        ...m,
                        text: m.text ? m.text + `\n\n⚠️ 异常: ${data.message}` : `⚠️ 指令执行异常: ${data.message}`,
                        isStreaming: false,
                        isThinkingStreaming: false,
                      }
                    : m
                )
              );
              currentStreamingIdRef.current = null;
            }
          }
        } catch (e) {
          console.warn(e);
        }
      };
      return ws;
    } catch {
      setWsConnected(false);
      return null;
    }
  }, []);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputText;
    if (!text.trim() || isThinking) return;

    const userMsg: Message = {
      id: 'usr-' + Date.now(),
      sender: 'user',
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const agentMsgId = 'agt-' + Date.now();
    currentStreamingIdRef.current = agentMsgId;

    const agentPlaceholderMsg: Message = {
      id: agentMsgId,
      sender: 'agent',
      text: '',
      isStreaming: true,
      isThinkingStreaming: true,
      thinking: '',
      toolCalls: [],
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg, agentPlaceholderMsg]);
    setInputText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setIsThinking(true);
    setExpandedThinkingIds((prev) => ({ ...prev, [agentMsgId]: true }));

    const shots = project?.scenes.flatMap((s) => s.shots) || [];
    const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

    let canvas_summary: string | null = null;
    try {
      const cs = useCanvasStore.getState().summary;
      const cn = useCanvasStore.getState().nodes;
      if (cn.length > 0) canvas_summary = cs;
    } catch {}

    const contextPayload = {
      project_id: project?.id,
      project_title: project?.title,
      project: project || null,
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

    // 1. Try WebSocket
    let ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = connectWs();
      await new Promise((r) => setTimeout(r, 120));
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
      } catch {
        sentViaWs = false;
      }
    }

    // 2. HTTP SSE Fallback（支持 Abort 暂停）
    if (!sentViaWs) {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        await apiService.agentChatStream(text, contextPayload, effectiveSessionId, (event, data) => {
          if (event === 'agent_thinking_start') {
            setIsThinking(true);
            setMessages((prev) =>
              prev.map((m) => (m.id === agentMsgId ? { ...m, isThinkingStreaming: true, thinking: '' } : m))
            );
          } else if (event === 'agent_thinking_chunk') {
            setIsThinking(true);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? { ...m, isThinkingStreaming: true, thinking: (m.thinking || '') + (data.delta || '') }
                  : m
              )
            );
          } else if (event === 'agent_thinking_end') {
            setMessages((prev) =>
              prev.map((m) => (m.id === agentMsgId ? { ...m, isThinkingStreaming: false } : m))
            );
          } else if (event === 'agent_stream_chunk') {
            setIsThinking(false);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId ? { ...m, text: m.text + (data.delta || ''), isStreaming: true } : m
              )
            );
          } else if (event === 'tool_calling') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== agentMsgId) return m;
                const tools = [...(m.toolCalls || [])];
                tools.push({ id: 'tc-' + Date.now(), name: data.tool_name, status: 'executing' });
                return { ...m, toolCalls: tools };
              })
            );
          } else if (event === 'tool_result') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== agentMsgId) return m;
                const tools = (m.toolCalls || []).map((t) =>
                  t.name === data.tool_name && t.status === 'executing'
                    ? {
                        ...t,
                        status: (data.status === 'success' ? 'completed' : 'error') as any,
                        result: data.result,
                        error: data.error,
                      }
                    : t
                );
                return { ...m, toolCalls: tools };
              })
            );
            if (data.tool_name && String(data.tool_name).startsWith('canvas_')) {
              try {
                window.dispatchEvent(new CustomEvent('agent-canvas-tool', { detail: { tool: data.tool_name, status: data.status, result: data.result } }));
                window.dispatchEvent(new CustomEvent('agent-canvas-updated', { detail: { tool: data.tool_name } }));
              } catch {}
            }
          } else if (event === 'agent_response') {
            setIsThinking(false);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? {
                      ...m,
                      text: data.message || m.text,
                      isStreaming: false,
                      isThinkingStreaming: false,
                      suggestedActions: data.suggested_actions,
                    }
                  : m
              )
            );
            currentStreamingIdRef.current = null;
          } else if (event === 'error') {
            setIsThinking(false);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? {
                      ...m,
                      text: m.text ? m.text + `\n\n⚠️ ${data.message}` : `⚠️ 指令异常: ${data.message}`,
                      isStreaming: false,
                      isThinkingStreaming: false,
                    }
                  : m
              )
            );
            currentStreamingIdRef.current = null;
          }
        }, { signal: controller.signal } as any);
        setIsThinking(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsgId ? { ...m, isStreaming: false, isThinkingStreaming: false } : m))
        );
      } catch (e: any) {
        // 被暂停则不再 fallback
        if (e?.name === 'AbortError' || String(e?.message || e).toLowerCase().includes('abort')) {
          setIsThinking(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? {
                    ...m,
                    text: m.text ? m.text + "\n\n⏹️ 已暂停" : "⏹️ 已暂停",
                    isStreaming: false,
                    isThinkingStreaming: false,
                  }
                : m
            )
          );
          currentStreamingIdRef.current = null;
        } else {
        // Fallback to non-streaming agentChat
        try {
          const res = await apiService.agentChat(text, contextPayload, effectiveSessionId);
          setIsThinking(false);
          const tools: ToolCallItem[] = (res.executed_tools || []).map((t: any) => ({
            id: 'tc-' + Math.random(),
            name: t.tool_name,
            status: t.status === 'success' ? 'completed' : 'error',
            result: t.result,
            error: t.error,
          }));
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? {
                    ...m,
                    text: res.reply || '指令已执行完成。',
                    isStreaming: false,
                    isThinkingStreaming: false,
                    toolCalls: tools,
                    suggestedActions: res.suggested_actions,
                  }
                : m
            )
          );
        } catch (err: any) {
          setIsThinking(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? {
                    ...m,
                    text: `⚠️ 抱歉，连接异常: ${err.message || '网络请求超时'}。请检查后端服务运行状态。`,
                    isStreaming: false,
                    isThinkingStreaming: false,
                  }
                : m
            )
          );
        }
        }
      } finally {
        abortControllerRef.current = null;
      }
    }
  };

  const handleAbort = useCallback(() => {
    // WS 暂停
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: 'abort', session_id: effectiveSessionId }));
      } catch {}
    }
    // SSE 暂停
    if (abortControllerRef.current) {
      try { abortControllerRef.current.abort(); } catch {}
      abortControllerRef.current = null;
    }
    const curId = currentStreamingIdRef.current;
    setIsThinking(false);
    if (curId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === curId
            ? {
                ...m,
                text: m.text ? m.text + "\n\n⏹️ 已暂停" : "⏹️ 已暂停",
                isStreaming: false,
                isThinkingStreaming: false,
              }
            : m
        )
      );
      currentStreamingIdRef.current = null;
    } else {
      // 无 curId 时也强制结束 thinking
      setMessages((prev) =>
        prev.map((m) => (m.isStreaming || m.isThinkingStreaming ? { ...m, isStreaming: false, isThinkingStreaming: false } : m))
      );
    }
  }, [effectiveSessionId]);

  // Esc 全局暂停
  useEffect(() => {
    if (!isOpen || !isThinking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleAbort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isThinking, handleAbort]);

  const handleClearHistory = async () => {
    // 暂停后再清
    if (isThinking) handleAbort();
    try {
      await apiService.clearAgentHistory(effectiveSessionId);
      setMessages([
        {
          id: 'm-reset',
          sender: 'agent',
          text: '已重置对话历史记忆。你可以提出全新的导演指令。',
          suggestedActions: [
            '重新分析当前剧情节拍',
            '规划 3D 电影镜头组',
            '一键全流程全要素生图',
          ],
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'clear_history', session_id: effectiveSessionId }));
      }
    } catch (e: any) {
      alert(e.message || '清空记忆失败');
    }
  };

  const activeShot = project?.scenes.flatMap((s) => s.shots).find((s) => s.id === activeShotId);

  return (
    <>
      {/* 1. 全局自由拖拽悬浮 Trigger 胶囊按钮 */}
      <div
        style={{
          position: 'fixed',
          left: `${btnPos.x}px`,
          top: `${btnPos.y}px`,
          zIndex: 60,
        }}
        className="touch-none select-none"
      >
        <button
          onMouseDown={handleBtnMouseDown}
          onTouchStart={handleBtnTouchStart}
          className={`group flex items-center space-x-2 px-3.5 py-2.5 rounded-full backdrop-blur-xl border transition-all shadow-xl cursor-grab active:cursor-grabbing ${
            isOpen
              ? 'bg-brand text-white border-brand-glow shadow-brand/40 ring-2 ring-brand/50'
              : 'bg-surface/90 hover:bg-surface border-border hover:border-brand/60 text-white shadow-black/40 hover:scale-105'
          }`}
          title="点击展开/收起导演 Agent，按住可任意拖拽位置"
        >
          <div className="relative flex items-center justify-center">
            <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-brand to-brand-cyan flex items-center justify-center text-white shadow-sm">
              <Bot className="w-3 h-3" />
            </div>
            <span
              className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-surface ${
                wsConnected ? 'bg-accent-green animate-pulse' : 'bg-amber-400'
              }`}
            />
          </div>

          <div className="flex items-center gap-1.5 font-bold text-xs">
            <span className="[color:var(--color-text-main)] group-hover:text-brand">导演 Agent</span>
            <GripHorizontal className="w-3 h-3 [color:var(--color-text-muted)] opacity-50 group-hover:opacity-100" />
          </div>
        </button>
      </div>

      {/* 2. 独立悬浮可拖拽会话窗口 */}
      {isOpen && dialogPos && (
        <div
          style={{
            position: 'fixed',
            left: `${dialogPos.x}px`,
            top: `${dialogPos.y}px`,
            width: isExpanded ? '540px' : '410px',
            height: isExpanded ? '680px' : '530px',
            zIndex: 55,
          }}
          className="rounded-3xl border border-border bg-surface/95 backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-in transition-size duration-150"
        >
          {/* Window Header */}
          <div
            onMouseDown={handleDialogHeaderMouseDown}
            className="h-12 px-4 border-b border-border flex items-center justify-between bg-surface-secondary/80 shrink-0 cursor-grab active:cursor-grabbing select-none"
            title="按住拖拽窗口位置"
          >
            <div className="flex items-center space-x-2.5">
              <GripHorizontal className="w-4 h-4 [color:var(--color-text-muted)]" />
              <div className="p-1.5 rounded-xl bg-gradient-to-tr from-brand to-brand-blue text-white shadow-md shadow-brand/30">
                <Bot className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-1.5">
                  <span className="text-xs font-bold [color:var(--color-text-main)]">AI 漫剧导演 Agent</span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-accent-green' : 'bg-amber-400'}`}
                    title={wsConnected ? 'WebSocket 流式通道已就绪' : 'HTTP 通道'}
                  />
                </div>
                <div className="text-[9px] [color:var(--color-text-muted)] flex items-center gap-1">
                  <span>多模态感知</span>
                  <span>·</span>
                  <span>LangChain 智能记忆</span>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-1">
              <button
                onClick={handleClearHistory}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title="重置会话记忆"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title={isExpanded ? '还原默认尺寸' : '放大窗口'}
              >
                {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title="收起悬浮窗"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Active Context Bar */}
          {activeShot && (
            <div className="px-3.5 py-1.5 bg-brand/10 border-b border-brand/20 flex items-center justify-between text-[11px] text-brand shrink-0">
              <span className="flex items-center space-x-1.5 truncate">
                <Film className="w-3.5 h-3.5 shrink-0" />
                <span className="font-semibold truncate">
                  镜头 #{activeShot.shot_index}: {activeShot.action_desc || activeShot.image_prompt?.slice(0, 30)}
                </span>
              </span>
              <button
                onClick={() => setActiveTab('director3d')}
                className="text-[10px] text-brand hover:underline ml-2 shrink-0 font-bold flex items-center gap-0.5"
              >
                3D机位 <ArrowUpRight className="w-2.5 h-2.5" />
              </button>
            </div>
          )}

          {/* Conversation Messages Container */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 custom-scrollbar text-xs">
            {messages.map((m) => {
              const isUser = m.sender === 'user';
              const isAgent = m.sender === 'agent';
              const showThinking = !!(m.thinking || m.isThinkingStreaming);
              const isThinkingOpen = !!expandedThinkingIds[m.id];

              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1 animate-fade-in`}
                >
                  <div
                    className={`p-3.5 rounded-2xl max-w-[92%] leading-relaxed shadow-sm group/msg relative allow-select select-text ${
                      isUser
                        ? 'bg-brand text-white rounded-br-none'
                        : 'bg-surface-secondary border border-border [color:var(--color-text-main)] rounded-bl-none'
                    }`}
                  >
                    {/* 单条复制按钮 */}
                    {m.text && (
                      <button
                        onClick={(e) => handleCopyMessage(e, m.id, m.text)}
                        className="absolute top-1.5 right-1.5 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-black/20 hover:bg-black/40 text-white/70 hover:text-white"
                        title="复制本条消息"
                      >
                        {copiedMsgId === m.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    )}
                    {/* 1. Collapsible Thinking / Reasoning Chain */}
                    {isAgent && showThinking && (
                      <div className="mb-2.5 rounded-xl border border-brand/20 bg-brand/5 overflow-hidden">
                        <button
                          onClick={() =>
                            setExpandedThinkingIds((prev) => ({
                              ...prev,
                              [m.id]: !prev[m.id],
                            }))
                          }
                          className="w-full px-2.5 py-1.5 flex items-center justify-between text-[10px] font-bold text-brand hover:bg-brand/10 transition-all"
                        >
                          <span className="flex items-center gap-1.5">
                            <Sparkles className={`w-3 h-3 ${m.isThinkingStreaming ? 'animate-spin' : ''}`} />
                            <span>
                              {m.isThinkingStreaming ? '思考推演中...' : '导演思考过程'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1 text-[9px] opacity-70">
                            {isThinkingOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </span>
                        </button>

                        {isThinkingOpen && (
                          <div className="p-2.5 pt-0 text-[10px] leading-relaxed [color:var(--color-text-secondary)] whitespace-pre-wrap font-mono max-h-36 overflow-y-auto custom-scrollbar border-t border-brand/10 allow-select select-text">
                            {m.thinking || '正在感知分镜机位与剧情节拍...'}
                            {m.isThinkingStreaming && (
                              <span className="inline-block w-1.5 h-3 bg-brand ml-1 animate-pulse align-middle" />
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 2. Structured Tool Call Execution Badges */}
                    {isAgent && m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="mb-2.5 space-y-1">
                        <div className="text-[10px] font-bold text-brand flex items-center gap-1">
                          <Cpu className="w-3 h-3" /> 动作执行:
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.toolCalls.map((tc) => (
                            <span
                              key={tc.id}
                              className={`px-2 py-0.5 rounded-md border text-[10px] font-mono flex items-center gap-1 shadow-xs ${
                                tc.status === 'completed'
                                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                  : tc.status === 'error'
                                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                                  : 'bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse'
                              }`}
                            >
                              {tc.status === 'completed' ? (
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              ) : tc.status === 'error' ? (
                                <span>✕</span>
                              ) : (
                                <span className="animate-spin">⏳</span>
                              )}
                              <span>{tc.name}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 3. Main Message Content（Agent 侧 Markdown 渲染，用户侧纯文本，均可选中复制） */}
                    {isAgent ? (
                      <div className="leading-relaxed text-xs">
                        <MarkdownText text={m.text} />
                        {m.isStreaming && (
                          <span className="inline-block w-1.5 h-3.5 bg-brand ml-1 animate-pulse align-middle" />
                        )}
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap leading-relaxed text-xs">
                        {m.text}
                      </div>
                    )}

                    {/* 4. Suggested Directorial Action Chips */}
                    {isAgent && m.suggestedActions && m.suggestedActions.length > 0 && (
                      <div className="mt-3 pt-2.5 border-t border-border space-y-1.5">
                        <div className="text-[10px] font-semibold [color:var(--color-text-muted)] flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-amber-400" /> 推荐下一步:
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.suggestedActions.map((act, i) => (
                            <button
                              key={i}
                              onClick={() => handleSendMessage(act)}
                              className="text-[10px] px-2.5 py-1 rounded-xl bg-surface hover:bg-brand hover:text-white border border-border text-[color:var(--color-text-secondary)] transition-all text-left shadow-xs flex items-center gap-1"
                            >
                              <span>⚡</span>
                              <span>{act}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-[9px] [color:var(--color-text-muted)] px-1">{m.time}</span>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Presets / Pause Hint */}
          {isThinking ? (
            <div className="px-3 py-2 bg-amber-500/10 border-t border-amber-500/20 flex items-center justify-between text-[10px] shrink-0">
              <span className="flex items-center gap-1.5 text-amber-500 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                正在执行中… 可点击右侧 ■ 或按 Esc 暂停
              </span>
              <button onClick={handleAbort} className="px-2.5 py-1 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold flex items-center gap-1 transition-all">
                <Square className="w-3 h-3 fill-white" /> 暂停
              </button>
            </div>
          ) : (
            <div className="px-3 py-2 bg-surface-secondary/40 border-t border-border flex space-x-1.5 overflow-x-auto text-[10px] whitespace-nowrap custom-scrollbar shrink-0">
              {[
                '规划当前镜 3D 特写推镜',
                '重绘当前分镜画面 (ComfyUI)',
                '将台词情绪调整为激动',
                '生成角色配音并对齐时长',
                '一键导出剪映工程',
              ].map((chip) => (
                <button
                  key={chip}
                  onClick={() => handleSendMessage(chip)}
                  className="px-2.5 py-1 rounded-full bg-surface border border-border hover:border-brand text-[color:var(--color-text-secondary)] hover:text-brand transition-all shadow-xs"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Input Bar */}
          <div className="p-3 border-t border-border bg-surface flex items-end space-x-2 shrink-0">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 100) + 'px';
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape' && isThinking) {
                  e.preventDefault();
                  handleAbort();
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (isThinking) handleAbort();
                  else handleSendMessage();
                }
              }}
              onPaste={(e) => {
                e.stopPropagation();
                const text = (e.clipboardData as any)?.getData('text/plain') || (e.clipboardData as any)?.getData('text') || '';
                if (text) {
                  e.preventDefault();
                  const target = e.target as HTMLTextAreaElement;
                  const start = target.selectionStart ?? inputText.length;
                  const end = target.selectionEnd ?? inputText.length;
                  const newValue = inputText.slice(0, start) + text + inputText.slice(end);
                  setInputText(newValue);
                  requestAnimationFrame(() => {
                    try { target.selectionStart = target.selectionEnd = start + text.length; } catch {}
                    target.style.height = 'auto';
                    target.style.height = Math.min(target.scrollHeight, 100) + 'px';
                  });
                }
              }}
              onCopy={(e) => e.stopPropagation()}
              onCut={(e) => e.stopPropagation()}
              placeholder={isThinking ? "正在执行中… 按 Esc 或点击 ■ 暂停" : "向导演 Agent 下达指令（Enter 发送，Shift+Enter 换行）..."}
              rows={1}
              className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs [color:var(--color-text-main)] placeholder-gray-500 focus:outline-none focus:border-brand resize-none min-h-[36px] max-h-[100px] leading-relaxed custom-scrollbar select-text"
            />
            <button
              onClick={() => (isThinking ? handleAbort() : handleSendMessage())}
              disabled={!isThinking && !inputText.trim()}
              className={`p-2.5 rounded-xl text-white shadow-md transition-all shrink-0 self-end ${isThinking ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20 animate-pulse' : 'bg-brand hover:bg-brand-light shadow-brand/20'} disabled:opacity-40`}
              title={isThinking ? "暂停 (Esc)" : "发送指令 (Enter)"}
            >
              {isThinking ? <Square className="w-4 h-4 fill-white" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
