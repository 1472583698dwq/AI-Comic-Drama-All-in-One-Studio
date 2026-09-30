/**
 * Agent 独立模式页 — 薄壳：会话侧栏 + 统一消息流 + 统一运行时 store
 * 运行时（会话/流式/计划/审批）全部收敛到 agentStore，与悬浮抽屉共用同一会话。
 *
 * 界面为两块圆角卡片（会话栏 / 对话主区），右栏已删除：模式选择在输入框左下角菜单，
 * 输入框以「悬浮层」浮在消息流之上；能力面保持上游 —— 多模态附件、运行中 steer 插话、
 * 行内审批与「始终允许」、子代理集群、自动执行警示齐备；清空记忆在页头图标按钮。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, ShieldAlert, Trash2, PanelLeft, ArrowDown,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useAgentStore } from '../components/agent/agentStore';
import { AgentMessageList } from '../components/agent/AgentMessageList';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AgentSwarmPanel } from '../components/agent/AgentSwarmPanel';
import { loadRoleMetas } from '../components/agent/swarmMeta';
import { SessionSidebar } from '../components/agent/SessionSidebar';

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});
  // 消息流容器：输入框改为悬浮层后不再占据独立区域，贴底/回到底部都由它自己算
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const {
    sessions, activeSessionId, loadingSessions,
    messages, isRunning, wsStatus, approvals, subagents, autoAllowTools,
    runMode, permission,
    bindProject, setRunMode, setPermission, setAutoAllow,
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

  // 只有用户本来就贴着底部时才跟随新消息；一旦向上翻看，就不把他拽回来（改用「回到底部」按钮）
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isRunning, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId);
  const pendingList = useMemo(() => Object.entries(approvals).filter(([, v]) => v.decided === undefined), [approvals]);
  const activeSessionTitle = sessions.find((s) => s.id === activeSessionId)?.title || 'Agent 独立模式';
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
        <h2 className="text-lg font-bold [color:var(--color-text-main)]">请先创建或打开一个项目</h2>
        <p className="text-xs [color:var(--color-text-main)] max-w-md">Agent 模式使用项目级会话隔离，请先在项目看板创建或选择项目后再使用。</p>
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
    <div className="flex-1 flex overflow-hidden p-2">
      {/* 左：会话栏 —— 宽度过渡（而非条件渲染）才有展开收起的“一体感”，
          外层容器吃掉溢出，内层整宽跟随；圆角裁切让三块区域各自成卡片。
          间距用 margin 而非 gap：收起后不残留空档 */}
      <div
        className={`shrink-0 overflow-hidden rounded-2xl transition-[width,opacity,margin-right] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isSidebarOpen ? 'w-64 lg:w-72 opacity-100 mr-2' : 'w-0 opacity-0 mr-0'
        }`}
      >
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={loadingSessions}
          projectTitle={project.title}
          onCreate={createSession}
          onSelect={selectSession}
          onDelete={deleteSession}
          onCollapse={() => setIsSidebarOpen(false)}
        />
      </div>

      {/* 中间：对话主区（圆角描边卡片，与会话栏形成明确分隔） */}
      <div className="flex-1 flex flex-col min-w-0 rounded-2xl border border-white/70 dark:border-white/12 overflow-hidden">
        <div className="px-5 py-3 flex items-center gap-3 shrink-0">
          {/* 收起入口已移入会话栏标题行；这里只在收起后提供「展开」恢复入口 */}
          {!isSidebarOpen && (
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-1.5 rounded-lg border border-white/70 dark:border-white/12 hover:border-brand/40 bg-white/60 dark:bg-white/[.05] [color:var(--color-text-main)] transition-all shrink-0"
              title="展开会话列表"
            >
              <PanelLeft className="w-4 h-4 text-brand" />
            </button>
          )}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand to-accent-green flex items-center justify-center text-white shadow-md shrink-0">
            <Bot className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold [color:var(--color-text-main)] truncate max-w-[200px] sm:max-w-[280px]">{activeSessionTitle}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsStatus === 'open' ? 'WS 在线' : 'HTTP 通道（自动重连中）'} />
            </div>
            <div className="text-[10px] [color:var(--color-text-main)] truncate">
              {project.title || '当前项目'} · {shots.length}镜 · 会话: {activeSessionId.slice(0, 12) || '就绪'}
              {isRunning && runningSteps.total > 0 && ` · 步骤 ${runningSteps.done}/${runningSteps.total}`}
              {isRunning && ' · 运行中'}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void clearAll()}
              title="清空本会话的全部消息记忆（不影响项目文件）"
              className="p-2 rounded-lg border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] [color:var(--color-text-main)] hover:border-red-400/50 hover:text-red-300 active:scale-95 transition-all shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {pendingList.length > 0 && (
              <button
                onClick={scrollToBottom}
                className="px-2.5 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-1 animate-pulse"
                title="有工具待确认，点击定位到行内审批卡"
              >
                <ShieldAlert className="w-3.5 h-3.5" />{pendingList.length} 待确认
              </button>
            )}
          </div>
        </div>

        <AgentSwarmPanel subagents={subagents} />

        {/* 消息流与输入框同处一个相对容器：输入框绝对定位浮在消息流之上，
            滚动时内容从输入框底下穿过，不再有一条通栏的输入框占位 */}
        <div className="flex-1 relative min-h-0">
          <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto custom-scrollbar">
            <div className="max-w-4xl mx-auto px-6 pt-5 pb-44 space-y-4">
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
            </div>
          </div>

          {/* 悬浮输入层：渐变蒙版只负责视觉过渡，pointer-events 交给内部，避免挡住消息操作 */}
          <div className="absolute inset-x-0 bottom-0 px-5 pb-4 pt-12 bg-gradient-to-t from-background via-background/85 to-transparent pointer-events-none">
            <div className="max-w-4xl mx-auto relative">
              {!atBottom && (
                <button
                  onClick={scrollToBottom}
                  title="回到底部"
                  className="pointer-events-auto absolute -top-11 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full border border-white/55 dark:border-white/10 bg-white/80 dark:bg-black/55 backdrop-blur-xl [color:var(--color-text-main)] shadow-lg shadow-black/30 flex items-center justify-center transition-colors"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              )}
              <div className="pointer-events-auto">
                <AgentComposer
                  floating
                  runMode={runMode}
                  permission={permission}
                  isRunning={isRunning}
                  wsStatus={wsStatus}
                  onSend={(t, atts) => void send(t, atts)}
                  onAbort={abort}
                  onSteer={(t, atts) => void steer(t, atts)}
                  onRunModeChange={setRunMode}
                  onPermissionChange={setPermission}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};
