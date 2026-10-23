/**
 * AI 对话页 — 薄壳：统一消息流 + 统一运行时 store（项目选择 chip 在输入框上方）
 * 运行时（会话/流式/计划/审批）全部收敛到 agentStore，与悬浮抽屉共用同一会话。
 *
 * 界面为单栏对话区（会话历史在应用侧栏的聊天历史区），模式选择在输入框左下角菜单，
 * 输入框以「悬浮层」浮在消息流之上；能力面保持上游 —— 多模态附件、运行中 steer 插话、
 * 行内审批与「始终允许」、子代理集群、自动执行警示齐备；清空记忆在页头图标按钮。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldAlert, ShieldCheck, Trash2, ArrowDown, Folder, ChevronDown, Check, MessageCirclePlus,
} from 'lucide-react';
import { useProjectStore } from '../stores/useProjectStore';
import { useProjectListStore, type ProjectMeta } from '../stores/useProjectListStore';
import { useAgentStore } from '../components/agent/agentStore';
import { AgentMessageList } from '../components/agent/AgentMessageList';
import { ApprovalCard } from '../components/agent/AgentToolSteps';
import { AgentComposer } from '../components/agent/AgentComposer';
import { AgentSwarmPanel } from '../components/agent/AgentSwarmPanel';
import { ProjectPolicyModal } from '../components/agent/ProjectPolicyModal';
import { loadRoleMetas } from '../components/agent/swarmMeta';
import { apiService } from '../services/api';
import { toast } from '../stores/useDialogStore';
import { NewProjectModal } from '../components/project/NewProjectModal';

/**
 * 项目选择 chip（ZCode 工作目录选择器同位）：对话绑定哪个项目/工程。
 * 弹层向上展开：搜索 + 项目单选 + 分隔线 + 新建项目；切换走双 store 同步。
 */
const ProjectChip: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiService.listProjects({ sort: 'updated_at' })
      .then((res) => setProjects((res?.projects || []) as ProjectMeta[]))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [open]);

  const switchProject = async (id: string, title: string) => {
    setOpen(false);
    if (project?.id === id) return;
    useProjectListStore.getState().setActiveProjectId(id);
    await useProjectStore.getState().loadActiveProject(id);
    toast.info(`已切换到「${title || '未命名项目'}」`);
  };

  const createProject = async (meta: ProjectMeta) => {
    setCreateOpen(false);
    setOpen(false);
    await useProjectStore.getState().loadActiveProject(meta.id);
    toast.success(`已切换到「${meta.title}」`);
  };

  const kw = search.trim().toLowerCase();
  const filtered = projects.filter((p) => !kw || (p.title || '').toLowerCase().includes(kw) || p.id.toLowerCase().includes(kw));

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="选择这段对话的工作目录（项目）"
        className="inline-flex items-center gap-1 max-w-[15rem] rounded-full hover:bg-surface-hover pl-3 pr-2 py-1 text-[11px] [color:var(--color-text-main)] transition-colors"
      >
        <Folder className="w-3.5 h-3.5 opacity-60 shrink-0" />
        <span className="truncate">{project?.title || '选择项目'}</span>
        <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 w-72 bg-surface border border-border rounded-xl p-1 animate-fade-in">
          <div className="p-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索项目…"
              className="w-full h-8 rounded-lg bg-surface-hover px-2.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-main)] opacity-90 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto custom-scrollbar">
            {loading && <div className="px-2 py-2 text-[11px] [color:var(--color-text-main)] opacity-60">正在加载…</div>}
            {!loading && filtered.length === 0 && (
              <div className="px-2 py-2 text-[11px] [color:var(--color-text-main)] opacity-60">没有匹配的项目</div>
            )}
            {filtered.map((p) => {
              const on = p.id === project?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { void switchProject(p.id, p.title); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs [color:var(--color-text-main)] hover:bg-surface-hover ${on ? 'bg-surface-tertiary' : ''}`}
                >
                  <Folder className="w-3.5 h-3.5 opacity-60 shrink-0" />
                  <span className="flex-1 truncate">{p.title || p.id}</span>
                  {on && <Check className="w-3 h-3 text-brand shrink-0" />}
                </button>
              );
            })}
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => { setCreateOpen(true); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs [color:var(--color-text-main)] hover:bg-surface-hover"
          >
            <Folder className="w-3.5 h-3.5 opacity-60 shrink-0" />新建项目
          </button>
        </div>
      )}

      <NewProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(meta) => { void createProject(meta); }}
      />
    </div>
  );
};

export const AgentModeView: React.FC = () => {
  const { project, activeShotId } = useProjectStore();
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});
  const [policyOpen, setPolicyOpen] = useState(false);
  // 消息流容器：输入框改为悬浮层后不再占据独立区域，贴底/回到底部都由它自己算
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const {
    sessions, activeSessionId, loadingSessions,
    messages, isRunning, wsStatus, approvals, questions, subagents, autoAllowTools,
    runMode, permission,
    bindProject, setRunMode, setPermission, setAutoAllow,
    createSession, selectSession, deleteSession,
    send, steer, executePlan, abort, approve, answerQuestion, clearAll, proposalAction, applyArtifact,
  } = useAgentStore();

  // 项目切换：绑定/加载该项目的页面版会话（与悬浮窗会话隔离）
  useEffect(() => {
    bindProject(project?.id || null);
  }, [project?.id, bindProject]);

  // 项目级执行模式：切换项目时以项目设置为默认，之后仍可在输入框左下角临时切换
  useEffect(() => {
    if (!project?.id) return;
    let alive = true;
    apiService.getProjectAgentPolicy(project.id)
      .then((p) => {
        if (alive && (p?.execution_mode === 'plan' || p?.execution_mode === 'auto' || p?.execution_mode === 'create')) {
          setRunMode(p.execution_mode);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [project?.id, setRunMode]);

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
      {/* 中间：对话主区（圆角描边卡片，与会话栏形成明确分隔） */}
      <div className="flex-1 flex flex-col min-w-0 rounded-2xl border border-white/70 dark:border-white/12 overflow-hidden">
        <div className="relative px-4 py-3 flex items-center shrink-0 border-b border-black/5 dark:border-white/10">
          {/* 会话标题：绝对居中，不随左右两侧按钮宽度偏移 */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[52%] text-center pointer-events-none">
            <div className="flex items-center justify-center gap-1.5">
              <span className="text-sm font-bold [color:var(--color-text-main)] truncate">{activeSessionTitle}</span>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsStatus === 'open' ? 'WS 在线' : 'HTTP 通道（自动重连中）'} />
            </div>
            <div className="text-[10px] [color:var(--color-text-muted)] truncate">
              {project.title || '当前项目'} · {shots.length}镜 · 会话: {activeSessionId.slice(0, 12) || '就绪'}
              {isRunning && runningSteps.total > 0 && ` · 步骤 ${runningSteps.done}/${runningSteps.total}`}
              {isRunning && ' · 运行中'}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPolicyOpen(true)}
              title="项目模型与权限（工具 allow / ask / deny）"
              aria-label="项目模型与权限"
              className="flex items-center gap-1.5 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 px-2.5 py-2 text-[11px] font-semibold [color:var(--color-text-main)] transition-all hover:border-brand/50 active:scale-95 shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">权限</span>
            </button>
            <button
              onClick={() => createSession()}
              title="新建会话（不继承当前对话上下文）"
              aria-label="新建会话"
              className="flex items-center gap-1.5 rounded-lg border border-brand/35 bg-brand/10 px-2.5 py-2 text-[11px] font-semibold text-brand transition-all hover:border-brand/60 hover:bg-brand/15 active:scale-95 shrink-0"
            >
              <MessageCirclePlus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">新建会话</span>
            </button>
            <button
              onClick={() => void clearAll()}
              title="清空本会话的全部消息记忆（不影响项目文件）"
              className="p-2 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 [color:var(--color-text-main)] hover:border-red-400/50 hover:text-red-500 dark:hover:text-red-300 active:scale-95 transition-all shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {pendingList.length > 0 && (
              <button
                onClick={scrollToBottom}
                className="px-2.5 py-1.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-600 dark:text-amber-300 text-xs font-bold flex items-center gap-1 animate-pulse"
                title="有工具待确认（审批卡在输入框上方）"
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
            <div className="max-w-3xl mx-auto px-6 pt-6 pb-44 space-y-5">
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
                questions={questions}
                onAnswerQuestion={answerQuestion}
              />
            </div>
          </div>

          {/* 悬浮输入层：渐变蒙版只负责视觉过渡，pointer-events 交给内部，避免挡住消息操作 */}
          <div className="absolute inset-x-0 bottom-0 px-5 pb-4 pt-12 bg-gradient-to-t from-background via-background/85 to-transparent pointer-events-none">
            <div className="max-w-3xl mx-auto relative">
              {!atBottom && (
                <button
                  onClick={scrollToBottom}
                  title="回到底部"
                  className="pointer-events-auto absolute -top-11 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full border border-white/55 dark:border-white/10 bg-surface/80 dark:bg-black/55 backdrop-blur-xl [color:var(--color-text-main)] shadow-lg shadow-black/30 flex items-center justify-center transition-colors"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              )}
              <div className="pointer-events-auto">
                {pendingList.length > 0 && (
                  <div className="mb-1.5 space-y-1.5 max-h-[42vh] overflow-y-auto custom-scrollbar">
                    {pendingList.map(([aid, v]) => (
                      <ApprovalCard
                        key={aid}
                        aid={aid}
                        tool={v.tool_name}
                        args={v.args || {}}
                        createdAt={v.createdAt}
                        autoAllowed={!!autoAllowTools[v.tool_name]}
                        onApprove={handleApprove}
                      />
                    ))}
                  </div>
                )}
                {/* 对话工作目录（项目）选择，ZCode contextHeader 同位 */}
                <div className="flex items-center mb-1.5">
                  <ProjectChip />
                </div>
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

      <ProjectPolicyModal
        open={policyOpen}
        projectId={project?.id}
        onClose={() => setPolicyOpen(false)}
        onSaved={(p) => setRunMode(p.execution_mode)}
      />
    </div>
  );
};
