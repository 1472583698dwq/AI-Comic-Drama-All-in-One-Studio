import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, Send, Square, RefreshCw, User, Sparkles, Wrench,
  CheckCircle2, XCircle, ShieldAlert, Film, Trash2, ChevronDown,
  MessageSquare, Plus, PanelLeftClose, PanelLeft, Clock, History, Lock,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { apiService } from '../services/api';
import { confirmAsync, toast } from '../stores/useDialogStore';
import { MarkdownText } from '../components/agent/MarkdownText';
import { PlanCard, ArtifactCard, ErrorCard, PlanPreview, CapabilityProposalCard } from '../components/agent/AgentCards';
import { extractArtifact, toStructuredError, detectLocalIntent } from '../components/agent/businessIntents';

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
const WS_URL = isDev
  ? 'ws://127.0.0.1:8000/api/v1/ws/agent'
  : (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/ws/agent`
      : 'ws://127.0.0.1:8000/api/v1/ws/agent');

interface ToolStep {
  id: string;
  name: string;
  status: 'executing' | 'completed' | 'error';
  result?: any;
  error?: string;
}

interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  thinking?: string;
  isThinkingStreaming?: boolean;
  steps?: ToolStep[];
  suggested?: string[];
  mode?: 'chat' | 'execute';
  time: string;
  plan?: PlanPreview | null;
  planConfirmed?: boolean;
  artifacts?: Array<{ kind: 'image' | 'video' | 'audio'; url: string; tool: string; label: string; applied?: boolean }>;
  errors?: Array<{ tool: string; what: string; why: string; next: string }>;
}

export interface AgentSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMsg[];
  mode?: 'chat' | 'execute';
  run_mode?: 'approve' | 'auto' | 'create';
}

function formatSessionTime(isoString?: string) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `今天 ${timeStr}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
  } catch {
    return isoString;
  }
}

try { (window as any).__STUDIO_BUILD__ = 'agent-page-20260909-trimode'; } catch {}

const QUICK_ASK = ['这个项目怎么做分镜？', '首尾帧和参考图有什么区别？', '剪映导出需要什么前置条件？'];
const QUICK_DO = ['为当前镜头规划3D特写推镜', '生成主角怒吼配音并对齐时长', '把画布现有节点全量执行一遍', '导出剪映工程草稿'];
const QUICK_CREATE = ['制作国风悬疑短剧插件包', '给H3视频源补first_frame插槽', '做个6格漫剧画布模板', '新建古风战斗Skill规范'];

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [mode, setMode] = useState<'chat' | 'execute'>(() => {
    try { return (localStorage.getItem('agent_mode') as any) || 'execute'; } catch { return 'execute'; }
  });
  useEffect(() => { try { localStorage.setItem('agent_mode', mode); } catch {} }, [mode]);
  // 三运行模式：approve审批(默认) / auto自动 / create创造
  const [runMode, setRunMode] = useState<'approve' | 'auto' | 'create'>(() => {
    try { return (localStorage.getItem('agent_run_mode') as any) || 'approve'; } catch { return 'approve'; }
  });
  useEffect(() => { try { localStorage.setItem('agent_run_mode', runMode); } catch {} }, [runMode]);
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});

  // ── 项目级会话状态隔离 ──
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const effSession = project?.id && activeSessionId 
    ? `proj_${project.id}_${activeSessionId}` 
    : (activeSessionId || `sess_${Date.now()}`);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [wsOk, setWsOk] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, { tool_name: string; args: any; decided?: boolean }>>({});
  const [showSteps, setShowSteps] = useState<Record<string, boolean>>({});
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const curIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const syncTimerRef = useRef<any>(null);
  const isSwitchingSessionRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const runModeRef = useRef(runMode);
  runModeRef.current = runMode;
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  // ---- WS ----
  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setWsOk(true);
      ws.onclose = () => setWsOk(false);
      ws.onerror = () => setWsOk(false);
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const event = data.event;
          const curId = curIdRef.current;
          const patch = (fn: (m: ChatMsg) => ChatMsg) =>
            setMessages((prev) => prev.map((m) => (m.id === curId ? fn(m) : m)));
          if (event === 'agent_thinking') {
            setThinking(true);
            if (curId) {
              patch((m) => ({
                ...m,
                isThinkingStreaming: true,
                thinking: (m.thinking ? m.thinking + '\n' : '') + data.message,
              }));
              setExpandedThinking((prev) => ({ ...prev, [curId]: true }));
            }
          } else if (event === 'agent_thinking_start') {
            setThinking(true);
            if (curId) {
              patch((m) => ({ ...m, isThinkingStreaming: true, thinking: m.thinking || '' }));
              setExpandedThinking((prev) => ({ ...prev, [curId]: true }));
            }
          } else if (event === 'agent_thinking_chunk') {
            setThinking(true);
            if (curId) {
              patch((m) => ({
                ...m,
                isThinkingStreaming: true,
                thinking: (m.thinking || '') + (data.delta || ''),
              }));
              setExpandedThinking((prev) => ({ ...prev, [curId]: true }));
            }
          } else if (event === 'agent_thinking_end') {
            if (curId) patch((m) => ({ ...m, isThinkingStreaming: false }));
          } else if (event === 'agent_stream_start') {
            if (curId) patch((m) => ({ ...m, isThinkingStreaming: false }));
          } else if (event === 'tool_calling') {
            if (curId) patch((m) => ({ ...m, steps: [...(m.steps || []), { id: 's' + Date.now() + Math.random(), name: data.tool_name, status: 'executing' }] }));
          } else if (event === 'tool_result') {
            if (curId) patch((m) => {
              const steps: ToolStep[] = (m.steps || []).map((s) => (s.name === data.tool_name && s.status === 'executing'
                ? { ...s, status: (data.status === 'success' ? 'completed' : 'error') as ToolStep['status'], result: data.result, error: data.error } : s));
              // P0业务卡：成功提产物 / 失败提结构化错误；Creator 提案单独成卡
              let artifacts = m.artifacts || [];
              let errors = m.errors || [];
              let plan = m.plan;
              try {
                if (data.status === 'success' && data.result) {
                  const r = data.result as any;
                  const prop = r?.proposal || (r?.proposal_id ? r : null);
                  if ((data.tool_name === 'creator_propose_capability' || data.tool_name?.startsWith?.('creator_')) && prop?.proposal_id) {
                    plan = { ...(plan as any), creator_proposal: prop } as any;
                  } else {
                    const a = extractArtifact(data.tool_name, data.result);
                    if (a) artifacts = [...artifacts, { ...a }];
                  }
                } else if (data.status !== 'success') {
                  const se = toStructuredError(data.tool_name, data.error || '执行失败');
                  errors = [...errors, { tool: data.tool_name, ...se }];
                }
              } catch {}
              return { ...m, steps, artifacts, errors, plan };
            });
          } else if (event === 'approval_required') {
            const aid = String(data.approval_id || '');
            if (aid) {
              setApprovals((p) => ({ ...p, [aid]: { tool_name: data.tool_name, args: data.arguments } }));
              if (curId) patch((m) => ({ ...m, text: m.text + `\n\n⚠️ 请求敏感操作 \`${data.tool_name}\`，请在右侧确认卡允许/拒绝（120s超时自动拒绝）。` }));
            }
          } else if (event === 'approval_ack') {
            const aid = String(data.approval_id || '');
            if (aid) setApprovals((p) => (p[aid] ? { ...p, [aid]: { ...p[aid], decided: !!data.approved } } : p));
          } else if (event === 'agent_stream_chunk') {
            if (curId) patch((m) => ({ ...m, isThinkingStreaming: false, text: m.text + (data.delta || '') }));
          } else if (event === 'agent_response') {
            setThinking(false);
            if (curId) patch((m) => ({
              ...m,
              text: data.message || m.text,
              thinking: data.thinking || m.thinking,
              suggested: data.suggested_actions,
              isThinkingStreaming: false,
            }));
            curIdRef.current = null;
          } else if (event === 'error') {
            setThinking(false);
            if (curId) patch((m) => ({ ...m, text: m.text + `\n\n⚠️ ${data.message}`, isThinkingStreaming: false }));
            curIdRef.current = null;
          }
        } catch {}
      };
    } catch { setWsOk(false); }
    return () => { try { ws?.close(); } catch {} wsRef.current = null; };
  }, []);

  // ── 1. 项目切换时拉取该项目的专属会话历史 ──
  useEffect(() => {
    if (!project?.id) {
      setSessions([]);
      setActiveSessionId('');
      setMessages([]);
      return;
    }

    let isMounted = true;
    setIsLoadingSessions(true);

    apiService.getProjectAgentSessions(project.id)
      .then((res) => {
        if (!isMounted) return;
        const list: AgentSession[] = Array.isArray(res?.sessions) ? res.sessions : [];
        if (list.length > 0) {
          setSessions(list);
          isSwitchingSessionRef.current = true;
          setActiveSessionId(list[0].id);
          setMessages(list[0].messages || []);
          if (list[0].mode) setMode(list[0].mode);
          if (list[0].run_mode) setRunMode(list[0].run_mode);
          setTimeout(() => { isSwitchingSessionRef.current = false; }, 50);
        } else {
          // 创建项目初始默认会话
          const newId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const newSess: AgentSession = {
            id: newId,
            title: '新会话',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            messages: [{
              id: 'welcome',
              sender: 'agent',
              mode: 'execute',
              text: '这里是 **Agent 独立模式**。\n\n- **问答**：只讲解不动手，不调任何工具；\n- **执行**：ReAct循环调生图/配音/视频/画布/剪映等工具直接生成，敏感操作（删源/写文件/跑命令）会弹窗确认。',
              suggested: QUICK_DO,
              time: '就绪',
            }],
            mode: 'execute',
            run_mode: 'approve',
          };
          setSessions([newSess]);
          isSwitchingSessionRef.current = true;
          setActiveSessionId(newId);
          setMessages(newSess.messages);
          setTimeout(() => { isSwitchingSessionRef.current = false; }, 50);
          apiService.saveProjectAgentSessions(project.id, [newSess]).catch(console.error);
        }
      })
      .catch((err) => {
        console.warn('Failed to load project agent sessions:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoadingSessions(false);
      });

    return () => {
      isMounted = false;
    };
  }, [project?.id]);

  // ── 2. 会话内容自动持久化至项目 ──
  useEffect(() => {
    if (!project?.id || !activeSessionId || messages.length === 0 || isSwitchingSessionRef.current) return;

    const firstUser = messages.find((m) => m.sender === 'user');
    const autoTitle = firstUser ? firstUser.text.slice(0, 20).replace(/[\r\n]+/g, ' ') : '';

    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === activeSessionId);
      if (idx === -1) return prev;
      const cur = prev[idx];
      const isDefaultTitle = !cur.title || cur.title === '新会话' || cur.title.startsWith('会话 ');
      const newTitle = (isDefaultTitle && autoTitle) ? autoTitle : cur.title;
      const updated: AgentSession = {
        ...cur,
        title: newTitle,
        updated_at: new Date().toISOString(),
        messages,
        mode,
        run_mode: runMode,
      };
      const copy = [...prev];
      copy[idx] = updated;
      return copy;
    });

    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      setSessions((latest) => {
        if (project?.id) {
          apiService.saveProjectAgentSessions(project.id, latest).catch(console.error);
        }
        return latest;
      });
    }, 600);

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [messages, mode, runMode, project?.id, activeSessionId]);

  // ── 3. 切换会话 ──
  const handleSelectSession = useCallback((sessId: string) => {
    if (sessId === activeSessionId) return;
    const target = sessions.find((s) => s.id === sessId);
    if (!target) return;
    isSwitchingSessionRef.current = true;
    setActiveSessionId(sessId);
    setMessages(target.messages || []);
    if (target.mode) setMode(target.mode);
    if (target.run_mode) setRunMode(target.run_mode);
    setTimeout(() => {
      isSwitchingSessionRef.current = false;
    }, 50);
  }, [activeSessionId, sessions]);

  // ── 4. 新建独立会话 ──
  const handleCreateSession = useCallback(() => {
    if (!project?.id) return;
    const newId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newSess: AgentSession = {
      id: newId,
      title: `会话 ${new Date().toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [{
        id: 'welcome_' + Date.now(),
        sender: 'agent',
        mode: modeRef.current,
        text: '已开启新会话。请下达针对当前项目的导演或制作指令。',
        suggested: modeRef.current === 'chat' ? QUICK_ASK : QUICK_DO,
        time: '就绪',
      }],
      mode: modeRef.current,
      run_mode: runModeRef.current,
    };
    isSwitchingSessionRef.current = true;
    const nextSessions = [newSess, ...sessions];
    setSessions(nextSessions);
    setActiveSessionId(newId);
    setMessages(newSess.messages);
    setTimeout(() => {
      isSwitchingSessionRef.current = false;
    }, 50);
    apiService.saveProjectAgentSessions(project.id, nextSessions).catch(console.error);
    toast.success('已新建独立会话');
  }, [project?.id, sessions]);

  // ── 5. 删除会话 ──
  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessId: string) => {
    e.stopPropagation();
    if (!project?.id) return;
    const ok = await confirmAsync({
      title: '删除会话',
      message: '确定要删除此会话历史记录吗？删除后不可恢复。',
      confirmText: '确认删除',
      cancelText: '取消',
      isDanger: true,
    });
    if (!ok) return;

    try {
      await apiService.deleteProjectAgentSession(project.id, sessId);
      const remaining = sessions.filter((s) => s.id !== sessId);
      setSessions(remaining);
      toast.success('会话已删除');
      if (activeSessionId === sessId) {
        if (remaining.length > 0) {
          isSwitchingSessionRef.current = true;
          setActiveSessionId(remaining[0].id);
          setMessages(remaining[0].messages || []);
          if (remaining[0].mode) setMode(remaining[0].mode);
          if (remaining[0].run_mode) setRunMode(remaining[0].run_mode);
          setTimeout(() => { isSwitchingSessionRef.current = false; }, 50);
        } else {
          handleCreateSession();
        }
      }
    } catch (err: any) {
      toast.error('删除会话失败: ' + (err?.message || '未知错误'));
    }
  }, [project?.id, sessions, activeSessionId, handleCreateSession]);

  const approve = useCallback((aid: string, ok: boolean) => {
    try { wsRef.current?.send(JSON.stringify({ action: 'approve_tool', approval_id: aid, approved: ok })); } catch {}
    setApprovals((p) => (p[aid] ? { ...p, [aid]: { ...p[aid], decided: ok } } : p));
  }, []);

  const buildContext = useCallback(() => {
    const shots = project?.scenes.flatMap((s) => s.shots) || [];
    const active = shots.find((s) => s.id === activeShotId);
    let canvas_summary: string | null = null;
    try {
      const cn = useCanvasStore.getState().nodes;
      if (cn.length > 0) canvas_summary = useCanvasStore.getState().summary;
    } catch {}
    return {
      project_id: project?.id, project_title: project?.title, project: project || null,
      active_shot: active ? { id: active.id, shot_index: active.shot_index, action_desc: active.action_desc, dialogue: active.dialogue, camera_framing: active.camera_framing, camera_motion: active.camera_motion } : null,
      platform: 'desktop', canvas_summary, workspace: useProjectStore.getState().workspace,
    };
  }, [project, activeShotId]);

  const pushAgentMsg = (mode: 'chat' | 'execute') => {
    const id = 'm' + Date.now();
    curIdRef.current = id;
    setMessages((prev) => [...prev, {
      id, sender: 'agent', text: '', mode,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      thinking: '',
      isThinkingStreaming: true,
    }]);
    setExpandedThinking((prev) => ({ ...prev, [id]: true }));
    return id;
  };

  const executeSend = useCallback(async (agentId: string, text: string, ctx: any, m: 'chat' | 'execute') => {
    const rm = runModeRef.current;
    // WS优先（run_mode 透传，后端 trace 审计；未知字段后端忽略）
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: 'agent_prompt', prompt: text, context: ctx, session_id: effSession, mode: m, run_mode: rm }));
        return;
      } catch {}
    }
    // SSE降级
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await apiService.agentChatStream(text, ctx, effSession, (event, data) => {
        setMessages((prev) => prev.map((mm) => {
          if (mm.id !== agentId) return mm;
          if (event === 'agent_thinking') return { ...mm, isThinkingStreaming: true, thinking: (mm.thinking ? mm.thinking + '\n' : '') + data.message };
          if (event === 'agent_thinking_start') return { ...mm, isThinkingStreaming: true, thinking: mm.thinking || '' };
          if (event === 'agent_thinking_chunk') return { ...mm, isThinkingStreaming: true, thinking: (mm.thinking || '') + (data.delta || '') };
          if (event === 'agent_thinking_end' || event === 'agent_stream_start') return { ...mm, isThinkingStreaming: false };
          if (event === 'agent_stream_chunk') return { ...mm, isThinkingStreaming: false, text: mm.text + (data.delta || '') };
          if (event === 'tool_calling') return { ...mm, steps: [...(mm.steps || []), { id: 's' + Date.now(), name: data.tool_name, status: 'executing' as const }] };
          if (event === 'tool_result') {
            const steps = (mm.steps || []).map((s) => (s.name === data.tool_name && s.status === 'executing'
              ? { ...s, status: data.status === 'success' ? 'completed' as const : 'error' as const, result: data.result, error: data.error } : s));
            let artifacts = mm.artifacts || [];
            let errors = mm.errors || [];
            let plan = mm.plan;
            try {
              if (data.status === 'success' && data.result) {
                const r = data.result as any;
                const prop = r?.proposal || (r?.proposal_id ? r : null);
                if ((data.tool_name === 'creator_propose_capability' || data.tool_name?.startsWith?.('creator_')) && prop?.proposal_id) {
                  plan = { ...(plan as any), creator_proposal: prop } as any;
                } else {
                  const a = extractArtifact(data.tool_name, data.result);
                  if (a) artifacts = [...artifacts, { ...a }];
                }
              } else if (data.status !== 'success') {
                const se = toStructuredError(data.tool_name, data.error || '执行失败');
                errors = [...errors, { tool: data.tool_name, ...se }];
              }
            } catch {}
            return { ...mm, steps, artifacts, errors, plan };
          }
          if (event === 'agent_response') return { ...mm, text: data.message || mm.text, thinking: data.thinking !== undefined ? (data.thinking || mm.thinking) : mm.thinking, suggested: data.suggested_actions, isThinkingStreaming: false };
          if (event === 'error') return { ...mm, text: mm.text + `\n\n⚠️ ${data.message}`, isThinkingStreaming: false };
          return mm;
        }));
        if (event === 'agent_response' || event === 'error') { setThinking(false); curIdRef.current = null; }
      }, { signal: ctrl.signal, mode: m, runMode: runModeRef.current } as any);
    } catch (e: any) {
      if (String(e?.message || '').toLowerCase().includes('abort')) {
        setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: mm.text + '\n\n⏹️ 已暂停', isThinkingStreaming: false } : mm)));
      } else {
        try {
          const res = await apiService.agentChat(text, ctx, effSession, m, runModeRef.current);
          const steps: ToolStep[] = (res.executed_tools || []).map((t: any) => ({ id: 's' + Math.random(), name: t.tool_name, status: t.status === 'success' ? 'completed' : 'error', result: t.result, error: t.error }));
          const artifacts: ChatMsg['artifacts'] = [];
          const errors: ChatMsg['errors'] = [];
          for (const t of (res.executed_tools || [])) {
            try {
              if (t.status === 'success' && t.result) {
                const a = extractArtifact(t.tool_name, t.result);
                if (a) artifacts!.push({ ...a });
              } else if (t.status !== 'success') {
                const se = toStructuredError(t.tool_name, t.error || '执行失败');
                errors!.push({ tool: t.tool_name, ...se });
              }
            } catch {}
          }
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: res.reply || '完成。', thinking: res.thinking || mm.thinking, isThinkingStreaming: false, steps, artifacts, errors, suggested: res.suggested_actions } : mm)));
        } catch (err: any) {
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: `⚠️ 连接异常：${err?.message || '未知'}` } : mm)));
        }
      }
      setThinking(false);
      curIdRef.current = null;
    } finally {
      abortRef.current = null;
    }
  }, [buildContext, effSession]);

  const pendingTextRef = useRef<Record<string, { text: string; ctx: any; mode: 'chat' | 'execute' }>>({});

  const confirmPlan = useCallback((msgId: string) => {
    const p = pendingTextRef.current[msgId];
    if (!p) return;
    setMessages((prev) => prev.map((mm) => (mm.id === msgId ? { ...mm, planConfirmed: true } : mm)));
    setThinking(true);
    executeSend(msgId, p.text, p.ctx, p.mode);
    delete pendingTextRef.current[msgId];
  }, [executeSend]);

  const cancelPlan = useCallback((msgId: string) => {
    delete pendingTextRef.current[msgId];
    setThinking(false);
    curIdRef.current = null;
    setMessages((prev) => prev.map((mm) => (mm.id === msgId ? { ...mm, text: (mm.text || '') + '\n\n已取消该计划，可调整说法后重试。', plan: null } : mm)));
  }, []);

  // Creator 提案动作：Start 试跑 / persist 真写生产 / discard / rollback 按备份恢复
  const proposalAction = useCallback(async (msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback') => {
    setProposalBusy((p) => ({ ...p, [proposalId]: kind }));
    try {
      if (kind === 'start') {
        const r = await apiService.creatorStart(proposalId);
        const checks = ((r as any)?.report?.checks || []).map((c: any) => `${c.ok ? '✓' : '✕'}${c.name}`).join('；');
        setMessages((prev) => prev.map((mm) => {
          if (mm.id !== msgId || !mm.plan?.creator_proposal) return mm;
          return {
            ...mm,
            plan: { ...mm.plan, creator_proposal: { ...(mm.plan.creator_proposal as any), status: (r as any)?.proposal?.status || 'tested' } },
            text: mm.text + `\n\n试跑${(r as any)?.proposal?.status === 'tested' ? '通过' : '有问题'}：${checks || '无检查项'}`,
          };
        }));
      } else {
        const r = await apiService.creatorFinalize(proposalId, kind);
        try {
          if ((r as any)?.template_id) window.dispatchEvent(new Event('creator-template-refresh'));
          if ((r as any)?.skill) window.dispatchEvent(new Event('skill-list-refresh'));
          if ((r as any)?.plugin_id) {
            window.dispatchEvent(new Event('plugin-list-refresh'));
            window.dispatchEvent(new Event('skill-list-refresh'));
          }
        } catch {}
        setMessages((prev) => prev.map((mm) => {
          if (mm.id !== msgId || !mm.plan?.creator_proposal) return mm;
          const gone = kind === 'discard';
          const status = (r as any)?.status || (gone ? 'discarded' : 'persisted');
          return {
            ...mm,
            plan: gone ? { ...mm.plan, creator_proposal: undefined } : { ...mm.plan, creator_proposal: { ...(mm.plan.creator_proposal as any), status } },
            text: mm.text + (gone ? '\n\n提案已丢弃（teardown），未动生产。' : `\n\n${(r as any)?.note || '完成。'}`),
          };
        }));
      }
    } catch (e: any) {
      setMessages((prev) => prev.map((mm) => (mm.id === msgId ? { ...mm, text: mm.text + `\n\n提案操作失败：${e?.message || '未知'}` } : mm)));
    } finally {
      setProposalBusy((p) => { const n = { ...p }; delete n[proposalId]; return n; });
    }
  }, []);

  const send = useCallback(async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || thinking) return;
    const m = modeRef.current;
    const rm = runModeRef.current;
    setMessages((prev) => [...prev, { id: 'u' + Date.now(), sender: 'user', text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
    setInput('');
    setThinking(true);
    const agentId = pushAgentMsg(m);
    const ctx = buildContext();

    // 三模式闸：执行模式先取Plan预览（含 run_mode）；问答模式直发
    if (m === 'execute') {
      try {
        const plan = await apiService.agentPlanPreview(text, ctx, rm);
        if (plan && plan.steps && plan.steps.length > 0) {
          const local = detectLocalIntent(text, !!ctx.active_shot);
          const hasProposal = !!(plan as any).creator_proposal;
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? {
            ...mm,
            text: `**${plan.label}** · ${plan.reason || local.label}，预估${plan.est_total_s >= 60 ? `约${Math.round(plan.est_total_s / 60)}分钟` : `约${plan.est_total_s}s`}（${plan.run_mode || rm}）。${hasProposal ? '创造模式附带能力提案，先 Start 试跑再执行主计划。' : plan.needs_confirm ? '确认后开始执行。' : '风险较低，直接开始执行。'}`,
            plan,
          } : mm)));
          if (plan.needs_confirm || hasProposal) {
            pendingTextRef.current[agentId] = { text, ctx, mode: m };
            setThinking(false);
            return;
          }
        } else if ((plan as any)?.creator_proposal) {
          // 无执行步骤但有提案（如纯补源意图）：同样先展示提案卡
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? {
            ...mm,
            text: `**${plan.label}**（${plan.run_mode || rm}）：先处理能力提案，再执行。`,
            plan,
          } : mm)));
          pendingTextRef.current[agentId] = { text, ctx, mode: m };
          setThinking(false);
          return;
        }
      } catch {
        // 预览失败不阻塞，直接执行
      }
    }
    await executeSend(agentId, text, ctx, m);
  }, [input, thinking, buildContext, effSession, executeSend]);

  const abort = useCallback(() => {
    try { wsRef.current?.send(JSON.stringify({ action: 'abort', session_id: effSession })); } catch {}
    try { abortRef.current?.abort(); } catch {}
    setThinking(false);
    curIdRef.current = null;
  }, [effSession]);

  const clearAll = useCallback(async () => {
    if (thinking) abort();
    try { await apiService.clearAgentHistory(effSession); } catch {}
    try { wsRef.current?.send(JSON.stringify({ action: 'clear_history', session_id: effSession })); } catch {}
    const resetMessages: ChatMsg[] = [{ id: 'welcome2_' + Date.now(), sender: 'agent', mode, text: '记忆已清空，从头开始吧。', time: '就绪' }];
    setMessages(resetMessages);
    setApprovals({});
    toast.info('已清空当前会话记忆');
  }, [thinking, abort, effSession, mode]);

  const pendingList = Object.entries(approvals).filter(([, v]) => v.decided === undefined);
  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const active = shots.find((s) => s.id === activeShotId);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl shadow-xl shadow-brand/20">
          🎬
        </div>
        <h2 className="text-lg font-bold text-white">请先创建或打开一个项目</h2>
        <p className="text-xs text-gray-400 max-w-md">
          Agent 模式已实现严格的项目级会话隔离，请先在项目看板创建或选择项目后再使用。
        </p>
        <button
          onClick={() => useProjectStore.getState().setActiveTab('projects')}
          className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-semibold hover:opacity-90 shadow-lg shadow-brand/20 transition-all"
        >
          打开项目看板
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── ① 左侧：会话历史侧边栏 (项目级独立持久化隔离) ── */}
      {isSidebarOpen ? (
        <aside className="w-64 lg:w-72 border-r border-border bg-surface-secondary/50 flex flex-col shrink-0 animate-fade-in select-none">
          {/* 侧栏顶栏 */}
          <div className="p-3 border-b border-border flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-brand/15 border border-brand/30 flex items-center justify-center text-brand shrink-0">
                <History className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">
                  <span>项目会话</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-brand/20 text-brand font-mono">隔离</span>
                </div>
                <div className="text-[10px] text-gray-500 truncate" title={project.title}>
                  {project.title || '当前项目'}
                </div>
              </div>
            </div>

            {/* 新建会话按钮 */}
            <button
              onClick={handleCreateSession}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand hover:bg-brand-light text-white text-xs font-semibold shadow-sm shadow-brand/20 transition-all shrink-0 active:scale-95"
              title="新建独立会话"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建</span>
            </button>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
            {isLoadingSessions && sessions.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-500 flex flex-col items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-brand" />
                <span>加载会话中…</span>
              </div>
            ) : sessions.length === 0 ? (
              <div className="py-12 text-center text-xs text-gray-500 space-y-2">
                <MessageSquare className="w-8 h-8 mx-auto text-gray-600 opacity-50" />
                <div>暂无会话记录</div>
                <button
                  onClick={handleCreateSession}
                  className="px-3 py-1 rounded-lg bg-surface border border-border text-brand hover:bg-surface-secondary text-xs"
                >
                  创建新会话
                </button>
              </div>
            ) : (
              sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                const msgCount = s.messages?.length || 0;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelectSession(s.id)}
                    className={`group relative p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-1 ${
                      isActive
                        ? 'bg-brand/15 border-brand/50 text-white shadow-sm ring-1 ring-brand/20'
                        : 'bg-surface/60 hover:bg-surface border-border/60 hover:border-brand/30 text-gray-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-brand' : 'text-gray-500 group-hover:text-gray-400'}`} />
                        <span className={`text-xs truncate block ${isActive ? 'font-bold text-white' : 'font-medium text-gray-200'}`} title={s.title}>
                          {s.title || '新会话'}
                        </span>
                      </div>

                      {/* 删除按钮 */}
                      <button
                        onClick={(e) => handleDeleteSession(e, s.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                        title="删除此会话"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-gray-500 pl-5">
                      <span className="flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        <span>{formatSessionTime(s.updated_at || s.created_at)}</span>
                      </span>
                      <span className="font-mono text-gray-400 bg-surface-secondary px-1.5 py-0.2 rounded text-[9px]">
                        {msgCount}条
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 侧栏底部 */}
          <div className="p-2.5 border-t border-border/80 bg-surface/40 flex items-center justify-between text-[10px] text-gray-500 shrink-0">
            <span className="flex items-center gap-1 text-gray-400">
              <Lock className="w-3 h-3 text-emerald-400" />
              <span>本工程专属持久化</span>
            </span>
            <span className="font-mono">{sessions.length}个会话</span>
          </div>
        </aside>
      ) : null}

      {/* ── ② 中间：对话主区 ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-5 py-3 border-b border-border bg-surface-secondary/60 flex items-center gap-3 shrink-0">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-1.5 rounded-lg border border-border hover:border-brand/40 bg-surface text-gray-400 hover:text-white transition-all shrink-0"
            title={isSidebarOpen ? '收起会话列表' : '展开会话列表'}
          >
            {isSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4 text-brand" />}
          </button>

          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand to-accent-green flex items-center justify-center text-white shadow-md shrink-0">
            <Bot className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white truncate max-w-[200px] sm:max-w-[280px]">
                {sessions.find((s) => s.id === activeSessionId)?.title || 'Agent 独立模式'}
              </span>
              <span className={`w-1.5 h-1.5 rounded-full ${wsOk ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsOk ? 'WS在线' : 'HTTP通道'} />
            </div>
            <div className="text-[10px] text-gray-500 truncate">
              {project.title || '当前项目'} · {shots.length}镜 · 会话: {activeSessionId.slice(0, 12) || '就绪'}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-xl bg-surface border border-border p-1" title="运行模式：审批=每步确认 / 自动=高风险才拦 / 创造=先造能力">
              <button onClick={() => setRunMode('approve')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'approve' ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:text-white'}`}>审批</button>
              <button onClick={() => setRunMode('auto')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'auto' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>自动</button>
              <button onClick={() => setRunMode('create')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'create' ? 'bg-violet-500/20 text-violet-300' : 'text-gray-500 hover:text-white'}`}>创造</button>
            </div>
            <div className="flex items-center rounded-xl bg-surface border border-border p-1">
              <button onClick={() => setMode('chat')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'chat' ? 'bg-accent-green/20 text-accent-green' : 'text-gray-500 hover:text-white'}`}>问答</button>
              <button onClick={() => setMode('execute')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>执行</button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
          {messages.map((m) => {
            const isAgent = m.sender === 'agent';
            const hasThinking = isAgent && !!(m.thinking || m.isThinkingStreaming);
            const isThinkingOpen = expandedThinking[m.id] !== undefined ? expandedThinking[m.id] : true;
            return (
            <div key={m.id} className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl p-4 leading-relaxed text-xs ${m.sender === 'user' ? 'bg-brand text-white rounded-br-none' : 'bg-surface-secondary border border-border text-gray-100 rounded-bl-none'}`}>
                <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-gray-500">
                  {m.sender === 'user' ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3 text-brand-light" />}
                  <span>{m.sender === 'user' ? '你' : 'Agent'}</span>
                  {m.mode && <span className={`px-1.5 py-px rounded font-bold ${m.mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'bg-accent-green/20 text-accent-green'}`}>{m.mode === 'execute' ? '执行' : '问答'}</span>}
                  <span className="ml-auto">{m.time}</span>
                </div>

                {/* 思考推演折叠卡片 (Thinking Process Card) */}
                {hasThinking && (
                  <div className="mb-3 rounded-xl border border-brand/30 bg-brand/5 overflow-hidden shadow-xs transition-all">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedThinking((prev) => ({
                          ...prev,
                          [m.id]: isThinkingOpen ? false : true,
                        }))
                      }
                      className="w-full px-3 py-1.5 flex items-center justify-between text-[11px] font-bold text-brand-light hover:bg-brand/10 transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        <Sparkles className={`w-3.5 h-3.5 text-brand ${m.isThinkingStreaming ? 'animate-spin' : ''}`} />
                        <span>{m.isThinkingStreaming ? '思考推演中…' : '思考过程'}</span>
                      </span>
                      <span className="flex items-center gap-1 text-[10px] text-gray-400 font-normal">
                        <span>{isThinkingOpen ? '收起' : '展开'}</span>
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isThinkingOpen ? 'rotate-180' : ''}`} />
                      </span>
                    </button>

                    {isThinkingOpen && (
                      <div className="px-3 py-2 border-t border-brand/15 text-[11px] leading-relaxed text-gray-300 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto custom-scrollbar select-text bg-black/30">
                        {m.thinking || (m.isThinkingStreaming ? '正在感知导演意图与分析分镜机位…' : '')}
                        {m.isThinkingStreaming && (
                          <span className="inline-block w-1.5 h-3.5 bg-brand ml-1 animate-pulse align-middle" />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {m.sender === 'agent' ? <MarkdownText text={m.text || (thinking && m.id === curIdRef.current && !m.thinking ? '思考中…' : '')} /> : <div className="whitespace-pre-wrap">{m.text}</div>}
                {m.sender === 'agent' && m.plan && m.plan.steps.length > 0 && !m.planConfirmed && (
                  <PlanCard plan={m.plan} onConfirm={() => confirmPlan(m.id)} onCancel={() => cancelPlan(m.id)} confirming={thinking} />
                )}
                {m.sender === 'agent' && (m.plan as any)?.creator_proposal && (
                  <CapabilityProposalCard
                    proposal={(m.plan as any).creator_proposal}
                    busy={proposalBusy[(m.plan as any).creator_proposal.proposal_id] || null}
                    onStart={() => proposalAction(m.id, (m.plan as any).creator_proposal.proposal_id, 'start')}
                    onFinalize={(a) => proposalAction(m.id, (m.plan as any).creator_proposal.proposal_id, a)}
                  />
                )}
                {m.sender === 'agent' && m.plan && m.planConfirmed && (
                  <div className="mt-1.5 text-[10px] text-emerald-300">✓ 计划已确认，正在执行…</div>
                )}
                {(m.artifacts?.length || 0) > 0 && (
                  <div className="space-y-1.5">
                    {m.artifacts!.map((a, i) => (
                      <ArtifactCard
                        key={`${m.id}-a${i}-${a.url.slice(-16)}`}
                        kind={a.kind} url={a.url} tool={a.tool} label={a.label}
                        shotLabel={active ? `#${active.shot_index}` : undefined}
                        applied={a.applied}
                        onApply={() => {
                          if (!activeShotId) return;
                          const patch: any = { status: 'completed' };
                          if (a.kind === 'image') { patch.image_url = a.url; patch.image_provider = a.tool; }
                          if (a.kind === 'video') { patch.video_url = a.url; patch.video_provider = a.tool; }
                          if (a.kind === 'audio') { patch.audio_url = a.url; patch.audio_provider = a.tool; }
                          try { useProjectStore.getState().updateShot(activeShotId, patch); } catch {}
                          setMessages((prev) => prev.map((mm) => (mm.id === m.id
                            ? { ...mm, artifacts: (mm.artifacts || []).map((x, xi) => (xi === i ? { ...x, applied: true } : x)) }
                            : mm)));
                        }}
                      />
                    ))}
                  </div>
                )}
                {(m.errors?.length || 0) > 0 && (
                  <div className="space-y-1.5">
                    {m.errors!.map((e, i) => (
                      <ErrorCard key={`${m.id}-e${i}`} what={e.what} why={e.why} next={e.next} />
                    ))}
                  </div>
                )}
                {(m.steps?.length || 0) > 0 && (
                  <div className="mt-2 rounded-xl border border-border overflow-hidden">
                    <button onClick={() => setShowSteps((p) => ({ ...p, [m.id]: !p[m.id] }))} className="w-full px-2.5 py-1.5 flex items-center gap-1.5 text-[10px] font-bold text-gray-300 hover:bg-white/5">
                      <Wrench className="w-3 h-3 text-accent-orange" />工具步骤 {m.steps!.filter((s) => s.status === 'completed').length}/{m.steps!.length}
                      <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${showSteps[m.id] ? 'rotate-180' : ''}`} />
                    </button>
                    {showSteps[m.id] && (
                      <div className="border-t border-border divide-y divide-white/5">
                        {m.steps!.map((s) => (
                          <div key={s.id} className="px-2.5 py-1.5 flex items-center gap-2 text-[11px]">
                            {s.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5 text-accent-green shrink-0" /> : s.status === 'error' ? <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" /> : <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />}
                            <span className="font-mono text-gray-200 truncate">{s.name}</span>
                            {s.error && <span className="text-red-400 truncate">{s.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {m.suggested && m.suggested.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.suggested.map((s) => (
                      <button key={s} onClick={() => send(s)} className="px-2 py-1 rounded-full bg-surface border border-border text-[10px] text-gray-300 hover:border-brand hover:text-white">{s}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="p-4 border-t border-border bg-surface shrink-0">
          <div className="flex items-end gap-2 max-w-4xl mx-auto">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); thinking ? abort() : send(); } }}
              placeholder={mode === 'chat' ? '问答模式：只讲解不生成，如“首尾帧和参考图有什么区别？”' : '执行模式：直接调工具生成，如“为当前镜头规划特写推镜并配音”'}
              rows={2}
              className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none custom-scrollbar"
            />
            <button onClick={() => (thinking ? abort() : send())} disabled={!thinking && !input.trim()} className={`p-3 rounded-xl text-white shrink-0 ${thinking ? 'bg-red-500' : 'bg-brand'} disabled:opacity-40`}>
              {thinking ? <Square className="w-4 h-4 fill-white" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* 右：模式与上下文侧栏 */}
      <div className="w-72 border-l border-border bg-surface-secondary/40 p-4 space-y-4 overflow-y-auto custom-scrollbar shrink-0 hidden md:block">
        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-brand-light" />模式说明</div>
          <div className={`text-[11px] leading-4 p-2 rounded-xl ${mode === 'chat' ? 'bg-accent-green/10 text-accent-green' : 'bg-brand/10 text-brand-light'}`}>
            {mode === 'chat' ? '问答：纯LLM讲解，不进工具循环，零副作用不烧生成费用。' : '执行：ReAct循环调全部工具，可并行；删源/写文件/跑命令会弹窗确认，120s超时自动拒绝。'}
          </div>
          <div className="text-[11px] leading-4 p-2 rounded-xl bg-surface-secondary border border-border text-gray-300">
            {runMode === 'approve' && '审批模式：变异动作先审后干，Plan必确认（默认）。'}
            {runMode === 'auto' && '自动模式：低/中风险直跑+Undo，仅高风险/删源拦截。'}
            {runMode === 'create' && '创造模式：缺能力先提案，Start试跑→持久化/丢弃，默认不写生产。'}
          </div>
          <div className="flex gap-2">
            <button onClick={clearAll} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center justify-center gap-1"><Trash2 className="w-3 h-3" />清空记忆</button>
            <button onClick={abort} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white">暂停</button>
          </div>
        </div>

        {pendingList.length > 0 && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" />待确认 {pendingList.length}</div>
            {pendingList.map(([aid, v]) => (
              <div key={aid} className="rounded-xl bg-black/30 border border-amber-500/20 p-2">
                <div className="text-[11px] font-mono text-white truncate">{v.tool_name}</div>
                <div className="text-[10px] font-mono text-gray-500 break-all max-h-20 overflow-y-auto custom-scrollbar">{JSON.stringify(v.args).slice(0, 400)}</div>
                <div className="flex gap-1.5 mt-1.5">
                  <button onClick={() => approve(aid, true)} className="flex-1 py-1 rounded-lg bg-amber-500 text-black text-[11px] font-bold">允许</button>
                  <button onClick={() => approve(aid, false)} className="flex-1 py-1 rounded-lg border border-border text-[11px] text-gray-300">拒绝</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-accent-orange" />当前上下文</div>
          <div className="text-[11px] text-gray-400 leading-5">
            <div>项目：{project?.title || '未选择'}</div>
            <div>镜头：{active ? `#${active.shot_index} ${active.action_desc?.slice(0, 20) || ''}` : '无'}</div>
            <div>通道：{wsOk ? 'WS在线（可确认敏感操作）' : 'HTTP（敏感操作自动拒绝）'}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white">快捷指令{runMode === 'create' ? ' · 创造' : ''}</div>
          {(mode === 'chat' ? QUICK_ASK : runMode === 'create' ? QUICK_CREATE : QUICK_DO).map((q) => (
            <button key={q} onClick={() => send(q)} className="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:border-brand hover:text-white">{q}</button>
          ))}
        </div>
      </div>
    </div>
  );
};
