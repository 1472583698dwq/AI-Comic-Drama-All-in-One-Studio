/**
 * Agent 独立模式页 — 薄壳：会话侧栏 + 统一消息流 + 统一运行时 store
 * 运行时（会话/流式/计划/审批）全部收敛到 agentStore，与悬浮抽屉共用同一会话。
 *
 * 界面取旧线本地设计：外层留白 + 三块圆角卡片（会话栏 / 对话主区 / 说明侧栏），
 * 输入框以「悬浮层」浮在消息流之上；能力面保持上游 —— 多模态附件、运行中 steer 插话、
 * 行内审批与「始终允许」、子代理集群、待办清单、自动执行（YOLO）提示，两边并存不丢。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, ShieldAlert, Film, Trash2, PanelLeft, ArrowDown, ListTodo, Zap, Send, BookOpen,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useAgentStore, QUICK_ASK, QUICK_DO, QUICK_CREATE, QUICK_PLAN } from '../components/agent/agentStore';
import { AgentMessageList } from '../components/agent/AgentMessageList';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AgentTodoPanel } from '../components/agent/AgentToolSteps';
import { AgentSwarmPanel } from '../components/agent/AgentSwarmPanel';
import { loadRoleMetas } from '../components/agent/swarmMeta';
import { SessionSidebar } from '../components/agent/SessionSidebar';

/**
 * 右栏是「说明 + 快速指令台」：使用指引 + 快捷指令 + 当前上下文。
 * 模式说明已收敛进输入框左下角的预设菜单（AgentComposer 的 AGENT_MODE_PRESETS）。
 */
const USAGE_GUIDE: Array<{ step: string; desc: string }> = [
  { step: '开始', desc: '左栏「新建会话」开一段干净上下文；会话按项目隔离持久化，随时可切回。' },
  { step: '提问', desc: '执行模式下直接说要什么（镜头 / 素材 / 配音），由 Agent 决定调哪些工具。' },
  { step: '指令台', desc: '下方按当前行为模式给示例指令，点一下即发出，也可先改两句再发。' },
  { step: '计划', desc: '计划模式先产出完整计划，点「按此计划执行」才会真正动手，也可继续输入改计划。' },
  { step: '敏感操作', desc: '删源 / 写文件 / 跑命令会弹窗确认；120s 无人应答或通道断开即自动拒绝。' },
  { step: '暂停与翻看', desc: '运行中按 Enter 暂停，已完成结果照常保留；向上翻历史不会被拽走，点 ↓ 一键到底。' },
];

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
    mode, behavior, runMode,
    bindProject, setMode, setRunMode, setAutoAllow,
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
  // 运行模式两维：行为（能干什么）决定提示词与工具门控，执行（要不要逐项人审）决定是否弹确认
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
        {runMode.endsWith('auto') && (
          <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/30 flex items-center gap-2 text-[11px] text-red-300 shrink-0">
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              <b>完全访问</b>：全部工具自动执行、删源/写文件/跑命令不再逐项确认。可随时用「暂停」中止。
            </span>
          </div>
        )}
        <div className="px-5 py-3 flex items-center gap-3 shrink-0">
          {/* 收起入口已移入会话栏标题行；这里只在收起后提供「展开」恢复入口 */}
          {!isSidebarOpen && (
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-1.5 rounded-lg border border-white/70 dark:border-white/12 hover:border-brand/40 bg-white/60 dark:bg-white/[.05] text-gray-400 hover:text-white transition-all shrink-0"
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
                  className="pointer-events-auto absolute -top-11 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full border border-white/55 dark:border-white/10 bg-white/80 dark:bg-black/55 backdrop-blur-xl text-gray-400 hover:text-white shadow-lg shadow-black/30 flex items-center justify-center transition-colors"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              )}
              <div className="pointer-events-auto">
                <AgentComposer
                  floating
                  mode={mode}
                  runMode={runMode}
                  isRunning={isRunning}
                  wsStatus={wsStatus}
                  onSend={(t, atts) => void send(t, atts)}
                  onAbort={abort}
                  onSteer={(t, atts) => void steer(t, atts)}
                  onModeChange={setMode}
                  onRunModeChange={setRunMode}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 右：上下文与快捷操作侧栏（模式说明已收敛进输入框左下角的预设菜单） */}
      <div className="w-72 ml-2 rounded-2xl bg-white/60 dark:bg-white/[.05] p-4 space-y-4 overflow-y-auto custom-scrollbar shrink-0 hidden md:block">
        {latestTodo && latestTodo.length > 0 && (
          <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] p-3">
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mb-1"><ListTodo className="w-3.5 h-3.5 text-sky-300" />待办清单</div>
            <AgentTodoPanel todo={latestTodo} />
          </div>
        )}

        {pendingList.length > 0 && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" />待确认 {pendingList.length}</div>
            {pendingList.map(([aid, v]) => (
              <div key={aid} className="rounded-xl bg-white/55 dark:bg-white/[.06] border border-amber-500/20 p-2">
                <div className="text-[11px] font-mono text-white truncate">{v.tool_name}</div>
                <div className="text-[10px] font-mono text-gray-500 break-all max-h-20 overflow-y-auto custom-scrollbar">{JSON.stringify(v.args).slice(0, 400)}</div>
                <div className="flex gap-1.5 mt-1.5">
                  <button onClick={() => handleApprove(aid, true, false)} className="flex-1 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-[11px] font-bold active:scale-95 transition-all">允许</button>
                  <button onClick={() => handleApprove(aid, false, false)} className="flex-1 py-1 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:bg-white/65 dark:bg-white/[.09]! hover:border-white/80 dark:border-white/20! hover:text-white active:scale-95 transition-all">拒绝</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-accent-orange" />当前上下文</div>
          <div className="text-[11px] text-gray-400 leading-5">
            <div>项目：{project?.title || '未选择'}</div>
            <div>镜头：{activeShot ? `#${activeShot.shot_index} ${activeShot.action_desc?.slice(0, 20) || ''}` : '无'}</div>
            <div>通道：{wsStatus === 'open' ? 'WS 在线（可确认敏感操作）' : 'HTTP（敏感操作自动拒绝）'}</div>
            <div>会话：{messages.length} 条消息 · {isRunning ? '运行中' : '空闲'}</div>
          </div>
          <button
            onClick={() => void clearAll()}
            title="清空本会话的全部消息记忆（不影响项目文件）"
            className="w-full py-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:bg-white/65 dark:bg-white/[.09]! hover:border-white/80 dark:border-white/20! hover:text-white active:scale-95 transition-all flex items-center justify-center gap-1"
          >
            <Trash2 className="w-3 h-3" />清空记忆
          </button>
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] p-3 space-y-2">
          <div className="text-xs font-bold text-white">快捷指令{behavior === 'create' ? ' · 创造' : behavior === 'plan' ? ' · 计划' : ''}</div>
          <div className="text-[10px] text-gray-500 leading-4">按当前行为模式给示例，点一下即发出（想改再改就手动输入）。</div>
          {quickCommands.map((q) => (
            <button
              key={q}
              onClick={() => void send(q)}
              className="group w-full text-left px-2.5 py-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:bg-brand/10! hover:border-brand/60! hover:text-white active:scale-[0.98] transition-all flex items-start gap-1.5"
            >
              <span className="w-3 shrink-0 pt-0.5">
                <Send className="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
              </span>
              <span>{q}</span>
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] p-3 space-y-2">
          <div className="text-xs font-bold text-white flex items-center gap-1.5"><BookOpen className="w-3.5 h-3.5 text-brand-cyan" />使用指引</div>
          <div className="space-y-1.5">
            {USAGE_GUIDE.map((g, i) => (
              <div key={g.step} className="flex gap-2 text-[11px] leading-4">
                <span className="mt-0.5 w-4 h-4 shrink-0 rounded-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[9px] font-bold text-brand-cyan flex items-center justify-center">{i + 1}</span>
                <span className="text-gray-400"><span className="text-white font-semibold">{g.step}</span> — {g.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
