import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, Send, Square, RefreshCw, User, Sparkles, Wrench,
  CheckCircle2, XCircle, ShieldAlert, Film, Trash2, ChevronDown,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { apiService } from '../services/api';
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
  steps?: ToolStep[];
  suggested?: string[];
  mode?: 'chat' | 'execute';
  time: string;
  plan?: PlanPreview | null;
  planConfirmed?: boolean;
  artifacts?: Array<{ kind: 'image' | 'video' | 'audio'; url: string; tool: string; label: string; applied?: boolean }>;
  errors?: Array<{ tool: string; what: string; why: string; next: string }>;
}

try { (window as any).__STUDIO_BUILD__ = 'agent-page-20260909-trimode'; } catch {}

const QUICK_ASK = ['这个项目怎么做分镜？', '首尾帧和参考图有什么区别？', '剪映导出需要什么前置条件？'];
const QUICK_DO = ['为当前镜头规划3D特写推镜', '生成主角怒吼配音并对齐时长', '把画布现有节点全量执行一遍', '导出剪映工程草稿'];
const QUICK_CREATE = ['给H3视频源补first_frame插槽', '做个6格漫剧画布模板', '新建古风战斗Skill规范'];

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

  const [sessionId] = useState(() => {
    try {
      const s = localStorage.getItem('agent_session_id');
      if (s) return s;
      const nid = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      localStorage.setItem('agent_session_id', nid);
      return nid;
    } catch { return `sess_${Date.now()}`; }
  });
  const effSession = project?.id ? `proj_${project.id}_${sessionId.slice(0, 8)}` : sessionId;

  const [messages, setMessages] = useState<ChatMsg[]>([{
    id: 'welcome', sender: 'agent', mode: 'execute',
    text: '这里是 **Agent 独立模式**。\n\n- **问答**：只讲解不动手，不调任何工具；\n- **执行**：ReAct循环调生图/配音/视频/画布/剪映等工具直接生成，敏感操作（删源/写文件/跑命令）会弹窗确认。',
    suggested: QUICK_DO, time: '就绪',
  }]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [wsOk, setWsOk] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, { tool_name: string; args: any; decided?: boolean }>>({});
  const [showSteps, setShowSteps] = useState<Record<string, boolean>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const curIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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
            if (curId) patch((m) => ({ ...m, thinking: (m.thinking || '') + data.message + '\n' }));
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
            if (curId) patch((m) => ({ ...m, text: m.text + (data.delta || '') }));
          } else if (event === 'agent_response') {
            setThinking(false);
            if (curId) patch((m) => ({ ...m, text: data.message || m.text, suggested: data.suggested_actions }));
            curIdRef.current = null;
          } else if (event === 'error') {
            setThinking(false);
            if (curId) patch((m) => ({ ...m, text: m.text + `\n\n⚠️ ${data.message}` }));
            curIdRef.current = null;
          }
        } catch {}
      };
    } catch { setWsOk(false); }
    return () => { try { ws?.close(); } catch {} wsRef.current = null; };
  }, []);

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
    setMessages((prev) => [...prev, { id, sender: 'agent', text: '', mode, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
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
          if (event === 'agent_stream_chunk') return { ...mm, text: mm.text + (data.delta || '') };
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
          if (event === 'agent_response') return { ...mm, text: data.message || mm.text, suggested: data.suggested_actions };
          if (event === 'error') return { ...mm, text: mm.text + `\n\n⚠️ ${data.message}` };
          return mm;
        }));
        if (event === 'agent_response' || event === 'error') { setThinking(false); curIdRef.current = null; }
      }, { signal: ctrl.signal, mode: m, runMode: runModeRef.current } as any);
    } catch (e: any) {
      if (String(e?.message || '').toLowerCase().includes('abort')) {
        setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: mm.text + '\n\n⏹️ 已暂停' } : mm)));
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
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: res.reply || '完成。', steps, artifacts, errors, suggested: res.suggested_actions } : mm)));
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
    setMessages([{ id: 'welcome2', sender: 'agent', mode, text: '记忆已清空，从头开始吧。', time: '就绪' }]);
    setApprovals({});
  }, [thinking, abort, effSession, mode]);

  const pendingList = Object.entries(approvals).filter(([, v]) => v.decided === undefined);
  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const active = shots.find((s) => s.id === activeShotId);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 左：对话主区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-5 py-3 border-b border-border bg-surface-secondary/60 flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand to-accent-green flex items-center justify-center text-white shadow-md"><Bot className="w-5 h-5" /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">Agent 模式</span>
              <span className={`w-1.5 h-1.5 rounded-full ${wsOk ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsOk ? 'WS在线' : 'HTTP通道'} />
            </div>
            <div className="text-[10px] text-gray-500">{project?.title || '未选择项目'} · {shots.length}镜 · 独立页面（悬浮窗不受影响）</div>
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
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl p-4 leading-relaxed text-xs ${m.sender === 'user' ? 'bg-brand text-white rounded-br-none' : 'bg-surface-secondary border border-border text-gray-100 rounded-bl-none'}`}>
                <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-gray-500">
                  {m.sender === 'user' ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3 text-brand-light" />}
                  <span>{m.sender === 'user' ? '你' : 'Agent'}</span>
                  {m.mode && <span className={`px-1.5 py-px rounded font-bold ${m.mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'bg-accent-green/20 text-accent-green'}`}>{m.mode === 'execute' ? '执行' : '问答'}</span>}
                  <span className="ml-auto">{m.time}</span>
                </div>
                {m.thinking && <div className="mb-2 text-[10px] text-gray-500 whitespace-pre-wrap max-h-24 overflow-y-auto custom-scrollbar border-l-2 border-brand/40 pl-2">{m.thinking}</div>}
                {m.sender === 'agent' ? <MarkdownText text={m.text || (thinking && m.id === curIdRef.current ? '思考中…' : '')} /> : <div className="whitespace-pre-wrap">{m.text}</div>}
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
          ))}
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
