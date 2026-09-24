/**
 * Agent 独立模式页 — 薄壳：会话侧栏 + 统一消息流 + 统一运行时 store
 * 运行时（会话/流式/计划/审批）全部收敛到 agentStore，与悬浮抽屉共用同一会话。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Sparkles, ShieldAlert, Film, Trash2, PanelLeftClose, PanelLeft,
  ArrowDown, ListTodo, Zap,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useAgentStore, QUICK_ASK, QUICK_DO, QUICK_CREATE, QUICK_PLAN } from '../components/agent/agentStore';
import { AgentMessageList } from '../components/agent/AgentMessageList';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AgentTodoPanel } from '../components/agent/AgentToolSteps';
import { AgentSwarmPanel } from '../components/agent/AgentSwarmPanel';
import { loadRoleMetas } from '../components/agent/swarmMeta';
import { SessionSidebar } from '../components/agent/SessionSidebar';
import type { BehaviorMode, ExecutionMode } from '../components/agent/agentTypes';

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const {
    sessions, activeSessionId, loadingSessions,
    messages, isRunning, wsStatus, approvals, subagents, autoAllowTools,
    mode, behavior, execution,
    bindProject, setMode, setBehavior, setExecution, setAutoAllow,
    createSession, selectSession, deleteSession,
    send, steer, executePlan, abort, approve, clearAll, proposalAction, applyArtifact,
  } = useAgentStore();

  // 项目切换：绑定/加载该项目的页面版会话（与悬浮窗会话隔离）
  useEffect(() => {
    bindProject(project?.id || null);
  }, [project?.id, bindProject]);

  // 拉取导演组扩展角色（自定义 icon/color）供集群面板使用
  useEffect(() => {
    loadRoleMetas();
  }, []);

  // 自动跟随：用户上滑查看历史时停止自动滚，并给出"回到最新"胶囊（IDE 式）
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };
  const scrollToBottom = () => {
    setAtBottom(true);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }));
  };
  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isRunning, atBottom]);

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId);
  const pendingList = useMemo(() => Object.entries(approvals).filter(([, v]) => v.decided === undefined), [approvals]);
  const quickCommands = mode === 'chat' ? QUICK_ASK : behavior === 'plan' ? QUICK_PLAN : behavior === 'create' ? QUICK_CREATE : QUICK_DO;
  const activeSessionTitle = sessions.find((s) => s.id === activeSessionId)?.title || 'Agent 独立模式';
  const latestTodo = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i].todo;
      if (t && t.length > 0) return t;
    }
    return null;
  }, [messages]);
  const runningSteps = useMemo(() => {
    const cur = [...messages].reverse().find((m) => m.steps && m.steps.length > 0);
    const steps = cur?.steps || [];
    return { total: steps.length, done: steps.filter((s) => s.status === 'completed').length };
  }, [messages]);

  const handleApprove = (aid: string, ok: boolean, always: boolean) => {
    if (always && ok) {
      const a = approvals[aid];
      if (a?.tool_name) setAutoAllow(a.tool_name, true);
    }
    approve(aid, ok);
  };

  const handleProposalAction = async (msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback') => {
    setProposalBusy((p) => ({ ...p, [proposalId]: kind }));
    try {
      await proposalAction(msgId, proposalId, kind);
    } finally {
      setProposalBusy((p) => { const n = { ...p }; delete n[proposalId]; return n; });
    }
  };

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background p-8 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl shadow-xl shadow-brand/20">🎬</div>
        <h2 className="text-lg font-bold text-white">请先创建或打开一个项目</h2>
        <p className="text-xs text-gray-400 max-w-md">Agent 模式使用项目级会话隔离，请先在项目看板创建或选择项目后再使用。</p>
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
      {isSidebarOpen && (
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={loadingSessions}
          projectTitle={project.title}
          onCreate={createSession}
          onSelect={selectSession}
          onDelete={deleteSession}
        />
      )}

      {/* 中间：对话主区 */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {execution === 'auto' && (
          <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/30 flex items-center gap-2 text-[11px] text-red-300 shrink-0">
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              <b>自动执行（YOLO）</b>：全部工具自动执行、删源/写文件/跑命令不再逐项确认。可随时用「暂停」中止。
            </span>
          </div>
        )}
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
              <span className="text-sm font-bold text-white truncate max-w-[200px] sm:max-w-[280px]">{activeSessionTitle}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsStatus === 'open' ? 'WS 在线' : 'HTTP 通道（自动重连中）'} />
            </div>
            <div className="text-[10px] text-gray-500 truncate">
              {project.title || '当前项目'} · {shots.length}镜 · 会话: {activeSessionId.slice(0, 12) || '就绪'}
              {isRunning && runningSteps.total > 0 && ` · 步骤 ${runningSteps.done}/${runningSteps.total}`}
              {isRunning && ' · 运行中'}
            </div>
          </div>
            <div className="ml-auto flex items-center gap-2">
              {pendingList.length > 0 && (
                <button
                  onClick={scrollToBottom}
                  className="px-2.5 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-1 animate-pulse"
                  title="有工具待确认，点击定位到行内审批卡"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />{pendingList.length} 待确认
                </button>
              )}
            <div className="flex items-center rounded-xl bg-surface border border-border p-1" title="行为模式（能干什么）：标准=常规能力 / 创造=缺能力先造 / 计划=只读规划不执行">
              <span className="px-1.5 text-[10px] text-gray-500 select-none">行为</span>
              <button onClick={() => setBehavior('standard')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${behavior === 'standard' ? 'bg-gray-500/25 text-white' : 'text-gray-500 hover:text-white'}`}>标准</button>
              <button onClick={() => setBehavior('create')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${behavior === 'create' ? 'bg-violet-500/20 text-violet-300' : 'text-gray-500 hover:text-white'}`}>创造</button>
              <button onClick={() => setBehavior('plan')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${behavior === 'plan' ? 'bg-sky-500/20 text-sky-300' : 'text-gray-500 hover:text-white'}`}>计划</button>
            </div>
            <div className="flex items-center rounded-xl bg-surface border border-border p-1" title="执行方式（要不要逐项确认）：审批=变异动作先确认 / 自动=全部自动执行不弹确认">
              <span className="px-1.5 text-[10px] text-gray-500 select-none">执行</span>
              <button onClick={() => setExecution('approve')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${execution === 'approve' ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:text-white'}`}>审批</button>
              <button onClick={() => setExecution('auto')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${execution === 'auto' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>自动</button>
            </div>
            <div className="flex items-center rounded-xl bg-surface border border-border p-1">
              <button onClick={() => setMode('chat')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'chat' ? 'bg-accent-green/20 text-accent-green' : 'text-gray-500 hover:text-white'}`}>问答</button>
              <button onClick={() => setMode('execute')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>执行</button>
            </div>
          </div>
        </div>

        <AgentSwarmPanel subagents={subagents} />

        <div ref={listRef} onScroll={onListScroll} className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
          <AgentMessageList
            messages={messages}
            isRunning={isRunning}
            activeShotIndex={activeShot?.shot_index}
            onSendSuggestion={(t) => void send(t)}
            onExecutePlan={(id) => void executePlan(id)}
            onProposalAction={handleProposalAction}
            proposalBusy={proposalBusy}
            onApplyArtifact={applyArtifact}
            approvals={approvals}
            autoAllowTools={autoAllowTools}
            onApprove={handleApprove}
          />
          <div ref={bottomRef} />
        </div>

        {!atBottom && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-brand text-white text-[11px] font-bold shadow-lg flex items-center gap-1 hover:opacity-90"
          >
            <ArrowDown className="w-3.5 h-3.5" />回到最新
          </button>
        )}

        <AgentComposer
          mode={mode}
          behavior={behavior}
          execution={execution}
          isRunning={isRunning}
          wsStatus={wsStatus}
          onSend={(t) => void send(t)}
          onAbort={abort}
          onSteer={(t) => void steer(t)}
          onCycleMode={() => setMode(mode === 'execute' ? 'chat' : 'execute')}
          onCycleBehavior={() => {
            const order: BehaviorMode[] = ['standard', 'create', 'plan'];
            setBehavior(order[(order.indexOf(behavior) + 1) % order.length]);
          }}
          onCycleExecution={() => setExecution(execution === 'auto' ? 'approve' : 'auto')}
        />
      </div>

      {/* 右：模式与上下文侧栏 */}
      <div className="w-72 border-l border-border bg-surface-secondary/40 p-4 space-y-4 overflow-y-auto custom-scrollbar shrink-0 hidden md:block">
        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-brand-light" />模式说明</div>
          <div className={`text-[11px] leading-4 p-2 rounded-xl ${mode === 'chat' ? 'bg-accent-green/10 text-accent-green' : 'bg-brand/10 text-brand-light'}`}>
            {mode === 'chat' ? '问答：纯 LLM 讲解，不进工具循环，零副作用不烧生成费用。' : '执行：ReAct 循环调全部工具；删源/写文件/跑命令会弹窗确认，120s 超时自动拒绝。'}
          </div>
          <div className="text-[11px] leading-4 p-2 rounded-xl bg-surface-secondary border border-border text-gray-300 space-y-1">
            <div>
              <span className="text-gray-500">行为：</span>
              {behavior === 'standard' && '标准 —— 常规工具集，按风险分级放行。'}
              {behavior === 'create' && '创造 —— 缺能力先提案，Start 试跑→持久化/丢弃，默认不写生产。'}
              {behavior === 'plan' && '计划 —— 只读侦察（不生成不执行），产出完整计划，批准后才执行。'}
            </div>
            <div>
              <span className="text-gray-500">执行：</span>
              {execution === 'approve' && '审批 —— 变异动作先审后干（默认）。'}
              {execution === 'auto' && '自动（YOLO）—— 全部工具自动执行，不再逐项弹确认（含删源/写文件/命令）；随时可暂停。'}
            </div>
            {behavior === 'plan' && execution === 'auto' && (
              <div className="text-sky-300/80">计划只读，执行方式仅决定「批准计划后」的跑法。</div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void clearAll()} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center justify-center gap-1"><Trash2 className="w-3 h-3" />清空记忆</button>
            <button onClick={abort} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white">暂停</button>
          </div>
        </div>

        {latestTodo && latestTodo.length > 0 && (
          <div className="rounded-2xl border border-border bg-surface p-3">
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mb-1"><ListTodo className="w-3.5 h-3.5 text-sky-300" />待办清单</div>
            <AgentTodoPanel todo={latestTodo} />
          </div>
        )}

        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-accent-orange" />当前上下文</div>
          <div className="text-[11px] text-gray-400 leading-5">
            <div>项目：{project?.title || '未选择'}</div>
            <div>镜头：{activeShot ? `#${activeShot.shot_index} ${activeShot.action_desc?.slice(0, 20) || ''}` : '无'}</div>
            <div>通道：{wsStatus === 'open' ? 'WS 在线（可确认敏感操作）' : 'HTTP（敏感操作自动拒绝）'}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white">快捷指令{behavior === 'create' ? ' · 创造' : behavior === 'plan' ? ' · 计划' : ''}</div>
          {quickCommands.map((q) => (
            <button key={q} onClick={() => void send(q)} className="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:border-brand hover:text-white">{q}</button>
          ))}
        </div>
      </div>
    </div>
  );
};
