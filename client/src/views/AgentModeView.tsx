import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, Send, Square, RefreshCw, User, Sparkles, Wrench,
  CheckCircle2, XCircle, ShieldAlert, Film, Trash2, ChevronDown,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { apiService } from '../services/api';
import { MarkdownText } from '../components/agent/MarkdownText';

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
}

try { (window as any).__STUDIO_BUILD__ = 'agent-page-20260908-p1'; } catch {}

const QUICK_ASK = ['这个项目怎么做分镜？', '首尾帧和参考图有什么区别？', '剪映导出需要什么前置条件？'];
const QUICK_DO = ['为当前镜头规划3D特写推镜', '生成主角怒吼配音并对齐时长', '把画布现有节点全量执行一遍', '导出剪映工程草稿'];

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [mode, setMode] = useState<'chat' | 'execute'>(() => {
    try { return (localStorage.getItem('agent_mode') as any) || 'execute'; } catch { return 'execute'; }
  });
  useEffect(() => { try { localStorage.setItem('agent_mode', mode); } catch {} }, [mode]);

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
            if (curId) patch((m) => ({
              ...m,
              steps: (m.steps || []).map((s) => (s.name === data.tool_name && s.status === 'executing'
                ? { ...s, status: data.status === 'success' ? 'completed' : 'error', result: data.result, error: data.error } : s)),
            }));
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

  const send = useCallback(async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || thinking) return;
    const m = modeRef.current;
    setMessages((prev) => [...prev, { id: 'u' + Date.now(), sender: 'user', text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
    setInput('');
    setThinking(true);
    const agentId = pushAgentMsg(m);
    const ctx = buildContext();

    // WS优先
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: 'agent_prompt', prompt: text, context: ctx, session_id: effSession, mode: m }));
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
          if (event === 'tool_result') return {
            ...mm,
            steps: (mm.steps || []).map((s) => (s.name === data.tool_name && s.status === 'executing'
              ? { ...s, status: data.status === 'success' ? 'completed' as const : 'error' as const, result: data.result, error: data.error } : s)),
          };
          if (event === 'agent_response') return { ...mm, text: data.message || mm.text, suggested: data.suggested_actions };
          if (event === 'error') return { ...mm, text: mm.text + `\n\n⚠️ ${data.message}` };
          return mm;
        }));
        if (event === 'agent_response' || event === 'error') { setThinking(false); curIdRef.current = null; }
      }, { signal: ctrl.signal, mode: m } as any);
    } catch (e: any) {
      if (String(e?.message || '').toLowerCase().includes('abort')) {
        setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: mm.text + '\n\n⏹️ 已暂停' } : mm)));
      } else {
        try {
          const res = await apiService.agentChat(text, ctx, effSession, m);
          const steps: ToolStep[] = (res.executed_tools || []).map((t: any) => ({ id: 's' + Math.random(), name: t.tool_name, status: t.status === 'success' ? 'completed' : 'error', result: t.result, error: t.error }));
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: res.reply || '完成。', steps, suggested: res.suggested_actions } : mm)));
        } catch (err: any) {
          setMessages((prev) => prev.map((mm) => (mm.id === agentId ? { ...mm, text: `⚠️ 连接异常：${err?.message || '未知'}` } : mm)));
        }
      }
      setThinking(false);
      curIdRef.current = null;
    } finally {
      abortRef.current = null;
    }
  }, [input, thinking, buildContext, effSession]);

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
          <div className="ml-auto flex items-center rounded-xl bg-surface border border-border p-1">
            <button onClick={() => setMode('chat')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'chat' ? 'bg-accent-green/20 text-accent-green' : 'text-gray-500 hover:text-white'}`}>问答</button>
            <button onClick={() => setMode('execute')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>执行</button>
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
          <div className="text-xs font-bold text-white">快捷指令</div>
          {(mode === 'chat' ? QUICK_ASK : QUICK_DO).map((q) => (
            <button key={q} onClick={() => send(q)} className="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:border-brand hover:text-white">{q}</button>
          ))}
        </div>
      </div>
    </div>
  );
};
