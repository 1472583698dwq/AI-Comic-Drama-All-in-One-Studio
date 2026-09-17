/**
 * Agent 独立模式页 — 薄壳：会话侧栏 + 统一消息流 + 统一运行时 store
 * 运行时（会话/流式/计划/审批）全部收敛到 agentStore，与悬浮抽屉共用同一会话。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Sparkles, ShieldAlert, Film, Trash2, PanelLeftClose, PanelLeft,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useAgentStore, QUICK_ASK, QUICK_DO, QUICK_CREATE, QUICK_PLAN } from '../components/agent/agentStore';
import { AgentMessageList } from '../components/agent/AgentMessageList';
import { AgentComposer } from '../components/agent/AgentComposer';
import { SessionSidebar } from '../components/agent/SessionSidebar';

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    sessions, activeSessionId, loadingSessions,
    messages, isRunning, wsStatus, approvals,
    mode, runMode,
    bindProject, setMode, setRunMode, createSession, selectSession, deleteSession,
    send, executePlan, abort, approve, clearAll, proposalAction, applyArtifact,
  } = useAgentStore();

  // 项目切换：绑定/加载该项目的会话（幂等，抽屉同时调用无副作用）
  useEffect(() => {
    bindProject(project?.id || null);
  }, [project?.id, bindProject]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isRunning]);

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId);
  const pendingList = useMemo(() => Object.entries(approvals).filter(([, v]) => v.decided === undefined), [approvals]);
  const quickCommands = mode === 'chat' ? QUICK_ASK : runMode === 'plan' ? QUICK_PLAN : runMode === 'create' ? QUICK_CREATE : QUICK_DO;
  const activeSessionTitle = sessions.find((s) => s.id === activeSessionId)?.title || 'Agent 独立模式';

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
              <span className="text-sm font-bold text-white truncate max-w-[200px] sm:max-w-[280px]">{activeSessionTitle}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsStatus === 'open' ? 'WS 在线' : 'HTTP 通道（自动重连中）'} />
            </div>
            <div className="text-[10px] text-gray-500 truncate">
              {project.title || '当前项目'} · {shots.length}镜 · 会话: {activeSessionId.slice(0, 12) || '就绪'}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-xl bg-surface border border-border p-1" title="运行模式：审批=每步确认 / 自动=高风险才拦 / 创造=先造能力 / 计划=只读规划">
              <button onClick={() => setRunMode('approve')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'approve' ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:text-white'}`}>审批</button>
              <button onClick={() => setRunMode('auto')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'auto' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>自动</button>
              <button onClick={() => setRunMode('create')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'create' ? 'bg-violet-500/20 text-violet-300' : 'text-gray-500 hover:text-white'}`}>创造</button>
              <button onClick={() => setRunMode('plan')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${runMode === 'plan' ? 'bg-sky-500/20 text-sky-300' : 'text-gray-500 hover:text-white'}`}>计划</button>
            </div>
            <div className="flex items-center rounded-xl bg-surface border border-border p-1">
              <button onClick={() => setMode('chat')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'chat' ? 'bg-accent-green/20 text-accent-green' : 'text-gray-500 hover:text-white'}`}>问答</button>
              <button onClick={() => setMode('execute')} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}>执行</button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
          <AgentMessageList
            messages={messages}
            isRunning={isRunning}
            activeShotIndex={activeShot?.shot_index}
            onSendSuggestion={(t) => void send(t)}
            onExecutePlan={(id) => void executePlan(id)}
            onProposalAction={handleProposalAction}
            proposalBusy={proposalBusy}
            onApplyArtifact={applyArtifact}
          />
          <div ref={bottomRef} />
        </div>

        <AgentComposer
          mode={mode}
          runMode={runMode}
          isRunning={isRunning}
          wsStatus={wsStatus}
          onSend={(t) => void send(t)}
          onAbort={abort}
        />
      </div>

      {/* 右：模式与上下文侧栏 */}
      <div className="w-72 border-l border-border bg-surface-secondary/40 p-4 space-y-4 overflow-y-auto custom-scrollbar shrink-0 hidden md:block">
        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-brand-light" />模式说明</div>
          <div className={`text-[11px] leading-4 p-2 rounded-xl ${mode === 'chat' ? 'bg-accent-green/10 text-accent-green' : 'bg-brand/10 text-brand-light'}`}>
            {mode === 'chat' ? '问答：纯 LLM 讲解，不进工具循环，零副作用不烧生成费用。' : '执行：ReAct 循环调全部工具；删源/写文件/跑命令会弹窗确认，120s 超时自动拒绝。'}
          </div>
          <div className="text-[11px] leading-4 p-2 rounded-xl bg-surface-secondary border border-border text-gray-300">
            {runMode === 'approve' && '审批模式：变异动作先审后干，Plan 必确认（默认）。'}
            {runMode === 'auto' && '自动模式：低/中风险直跑，仅高风险/删源拦截。'}
            {runMode === 'create' && '创造模式：缺能力先提案，Start 试跑→持久化/丢弃，默认不写生产。'}
            {runMode === 'plan' && '计划模式：只读侦察（不生成不执行），产出完整计划，批准后才执行。'}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void clearAll()} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center justify-center gap-1"><Trash2 className="w-3 h-3" />清空记忆</button>
            <button onClick={abort} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white">暂停</button>
          </div>
        </div>

        {pendingList.length > 0 && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" />待确认 {pendingList.length}</div>
            {pendingList.map(([aid, v]) => (
              <div key={aid} className="rounded-xl bg-surface-secondary border border-amber-500/20 p-2">
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
            <div>镜头：{activeShot ? `#${activeShot.shot_index} ${activeShot.action_desc?.slice(0, 20) || ''}` : '无'}</div>
            <div>通道：{wsStatus === 'open' ? 'WS 在线（可确认敏感操作）' : 'HTTP（敏感操作自动拒绝）'}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-3 space-y-2">
          <div className="text-xs font-bold text-white">快捷指令{runMode === 'create' ? ' · 创造' : ''}</div>
          {quickCommands.map((q) => (
            <button key={q} onClick={() => void send(q)} className="w-full text-left px-2.5 py-1.5 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:border-brand hover:text-white">{q}</button>
          ))}
        </div>
      </div>
    </div>
  );
};
