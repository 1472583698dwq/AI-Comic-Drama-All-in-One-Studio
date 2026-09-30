import React, { useEffect, useMemo, useState } from 'react';
import {
  Settings, PanelLeftClose, PanelLeft, Lock, Plug, MessageCirclePlus, type LucideIcon,
} from 'lucide-react';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { usePageStore } from '../../stores/usePageStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useChatHistoryStore } from '../../stores/useChatHistoryStore';
import { useAgentStore } from '../agent/agentStore';
import { toast } from '../../stores/useDialogStore';
import { pageIcon } from '../../utils/pageIcons';
import { ChatHistory } from './ChatHistory';
import { NewProjectModal } from '../project/NewProjectModal';
import type { ChatHistoryEntry } from '../../stores/useChatHistoryStore';
import type { ProjectMeta } from '../../stores/useProjectListStore';

interface SidebarProps {
  /** 设置页内仍会用到这三个弹窗，App 统一持有开关 */
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
  onOpenProvider?: () => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  pulse?: boolean;
}

/** 无项目时也能进的页（其余条目需要先有项目）；home 已删除，config 沉到底部 */
const GLOBAL_TABS = ['projects', 'config'];

/** 未分组页面的兜底分组名 */
const OTHER_GROUP = 'other';

/**
 * 左侧导航栏（ZCode WorkspaceSidebar 同构）：
 * 顶部「新建任务」→ 功能导航（后端页开关驱动，排除 home/config）→
 * 下半部聊天历史（会话/项目双视图 + 筛选 + 归档，ChatHistory）→ 底部「生成源/设置/收起」。
 *
 * - 新建任务：无项目时静默创建「新任务」项目承接；已有项目且当前会话未开始则直接复用，
 *   否则新建一段会话 —— 对应 ZCode 的 draft 语义（空会话不重复堆积）。
 * - 聊天历史点击 → 切项目（双 store 同步）→ 选中目标会话 → 进 AI 对话页。
 * - 宽度 264px ⇄ 60px 图标轨；画布页默认收起的行为不变。
 */
export const Sidebar: React.FC<SidebarProps> = ({ onOpenProvider }) => {
  const { project, activeTab, setActiveTab, toggleSidebar } = useProjectStore();
  const sidebarCollapsed = useProjectStore(selectSidebarCollapsed);
  const pages = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const groupMeta = usePageStore((s) => s.groups);
  const refreshHistory = useChatHistoryStore((s) => s.refresh);
  const agentActiveSessionId = useAgentStore((s) => s.activeSessionId);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);
  const charactersCount = project?.characters?.length || 0;

  const effectiveCollapsed = sidebarCollapsed;

  // 进入对话页 / 挂载时刷新一次历史（会话增删归档后由动作方就地刷新）
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, activeTab === 'agent']);

  /** 分组 → 条目（只含开启的页；home 已删除、config 沉底、projects 看板保留） */
  const groups = useMemo(() => {
    const enabled = pages.filter((p) => p.id !== 'config' && p.id !== 'home' && values[p.id] === true);
    const labelOf = (gid: string) => groupMeta.find((g) => g.id === gid)?.label
      || (gid === OTHER_GROUP ? '其他' : gid);
    const orderOf = (gid: string) => groupMeta.find((g) => g.id === gid)?.order ?? 9999;

    const buckets = new Map<string, NavItem[]>();
    enabled.forEach((p) => {
      const gid = p.group || OTHER_GROUP;
      const decorate: Partial<NavItem> =
        p.id === 'agent' ? { pulse: true }
        : p.id === 'studio' ? { count: shotsCount }
        : p.id === 'characters' ? { count: charactersCount }
        : {};
      const list = buckets.get(gid) || [];
      list.push({ id: p.id, label: p.label, icon: pageIcon(p.id, p.icon), ...decorate });
      buckets.set(gid, list);
    });

    return [...buckets.entries()]
      .sort(([a], [b]) => orderOf(a) - orderOf(b) || a.localeCompare(b))
      .map(([gid, items]) => ({
        title: labelOf(gid),
        items,
      }));
  }, [pages, values, groupMeta, shotsCount, charactersCount]);

  const go = (id: string) => {
    if (!GLOBAL_TABS.includes(id) && !project) {
      toast.info('请先在看板创建或打开项目');
      return;
    }
    setActiveTab(id as any);
  };

  /** 新建任务：有项目直接进对话（空会话复用不堆积）；无项目先走「名称+风格模板」引导弹窗 */
  const handleNewTask = () => {
    if (!project) {
      setNewProjectOpen(true);
      return;
    }
    setActiveTab('agent');
    const agent = useAgentStore.getState();
    if (agent.projectId !== project.id) {
      // 换了项目：绑定后由 bindProject 在空项目上自建「新会话」草稿
      agent.bindProject(project.id);
    } else {
      const cur = agent.sessions.find((s) => s.id === agent.activeSessionId);
      const started = (cur?.messages || []).some((m) => m.sender === 'user');
      if (started) agent.createSession();
    }
    void refreshHistory();
  };

  const handleTaskProjectCreated = async (meta: ProjectMeta) => {
    setNewProjectOpen(false);
    await useProjectStore.getState().loadActiveProject(meta.id);
    setActiveTab('agent');
    useAgentStore.getState().bindProject(meta.id);
    void refreshHistory();
  };

  /** 历史行点击：切项目（双 store 同步）→ 绑定并选中目标会话 → 进对话页 */
  const openHistoryEntry = async (e: ChatHistoryEntry) => {
    const cur = useProjectStore.getState().project;
    if (cur?.id !== e.projectId) {
      useProjectListStore.getState().setActiveProjectId(e.projectId);
      await useProjectStore.getState().loadActiveProject(e.projectId);
    }
    setActiveTab('agent');
    useAgentStore.getState().bindProject(e.projectId, e.session.id);
  };

  const activeCls = (item: NavItem, locked: boolean, active: boolean) => {
    if (locked) return 'opacity-35 cursor-not-allowed';
    if (active) return 'bg-surface-tertiary [color:var(--color-text-main)] font-semibold';
    return '[color:var(--color-text-main)] hover:bg-surface-hover';
  };

  return (
    <aside
      className={`relative shrink-0 h-full bg-white/60 dark:bg-white/[.04] backdrop-blur-2xl flex flex-col z-20 overflow-hidden transition-[width] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
        effectiveCollapsed ? 'w-[60px]' : 'w-[264px]'
      }`}
    >
      {/* 固定宽度内层：宽度动画期间内容不参与压缩 */}
      <div
        className={`h-full flex flex-col border-r border-white/60 dark:border-white/10 ${effectiveCollapsed ? 'w-[60px]' : 'w-[264px]'}`}
      >
        {/* 顶部按钮堆栈：新建任务 + 功能导航 */}
        <div className="shrink-0 px-2 pt-3 pb-1 space-y-0.5">
          <button
            onClick={handleNewTask}
            title="新建任务：开始一段新的 AI 对话"
            className={`w-full h-8 rounded-lg inline-flex items-center gap-2 px-2.5 text-xs font-semibold [color:var(--color-text-main)] hover:bg-surface-hover active:scale-[0.99] transition-all ${
              effectiveCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            <MessageCirclePlus className="w-4 h-4 shrink-0 text-brand" />
            {!effectiveCollapsed && <span className="truncate text-left">新建任务</span>}
          </button>

          <div className="space-y-0.5">
            {groups.map((g) => (
              <div key={g.title} className="pt-1">
                {!effectiveCollapsed && (
                  <div className="px-2.5 pb-1 text-[10px] font-bold tracking-wider [color:var(--color-text-main)] opacity-50">
                    {g.title}
                  </div>
                )}
                <div className="space-y-0.5">
                  {g.items.map((item) => {
                    const locked = !GLOBAL_TABS.includes(item.id) && !project;
                    const active = activeTab === item.id;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => go(item.id)}
                        title={locked ? '请先创建或打开项目' : item.label}
                        className={`relative w-full h-8 flex items-center gap-2.5 rounded-lg pl-2.5 pr-1 text-xs font-medium transition-all ${activeCls(item, locked, active)} ${
                          effectiveCollapsed ? 'justify-center px-0' : ''
                        }`}
                      >
                        {locked ? (
                          <Lock className="w-4 h-4 shrink-0 [color:var(--color-text-main)] opacity-50" />
                        ) : (
                          <Icon className="w-4 h-4 shrink-0" />
                        )}
                        {!effectiveCollapsed && <span className="truncate flex-1 text-left">{item.label}</span>}
                        {!effectiveCollapsed && !locked && typeof item.count === 'number' && item.count > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold bg-surface-tertiary [color:var(--color-text-main)] opacity-70">
                            {item.count}
                          </span>
                        )}
                        {!effectiveCollapsed && item.pulse && !locked && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                        )}
                        {effectiveCollapsed && item.pulse && !locked && (
                          <span className="absolute right-2 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 下半部：聊天历史（收起态隐藏） */}
        {!effectiveCollapsed && (
          <>
            <div className="mx-3 my-1.5 h-px bg-border shrink-0" />
            <ChatHistory
              activeSessionId={agentActiveSessionId}
              onOpenEntry={(e) => { void openHistoryEntry(e); }}
            />
          </>
        )}

        {/* 底部工具区：生成源 / 设置 / 收起（主题切换已按需求移除） */}
        <div className="shrink-0 p-2 border-t border-white/60 dark:border-white/10 space-y-0.5 bg-white/70 dark:bg-black/45 backdrop-blur-xl">
          <UtilButton
            icon={Plug}
            label="生成源"
            collapsed={effectiveCollapsed}
            onClick={() => onOpenProvider?.()}
            iconCls="text-brand-light"
          />

          <button
            onClick={() => setActiveTab('config')}
            title="设置：核心能力 / 输出与存储 / 扩展 / 系统"
            className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-bold transition-all ${
              effectiveCollapsed ? 'justify-center px-0' : ''
            } ${
              activeTab === 'config'
                ? 'bg-brand text-white shadow-sm shadow-brand/25'
                : '[color:var(--color-text-main)] hover:bg-surface-hover'
            }`}
          >
            <Settings className="w-4 h-4 shrink-0" />
            {!effectiveCollapsed && <span className="truncate">设置</span>}
          </button>

          {/* 图标轨 ⇄ 完整栏（所有页面一致） */}
          <button
            onClick={toggleSidebar}
            title={effectiveCollapsed ? '展开侧栏' : '收起侧栏'}
            className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[11px] [color:var(--color-text-main)] opacity-70 hover:opacity-100 hover:bg-surface-hover transition-all ${
              effectiveCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            {effectiveCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            {!effectiveCollapsed && <span>收起侧栏</span>}
          </button>
        </div>
      </div>

      <NewProjectModal
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(meta) => { void handleTaskProjectCreated(meta); }}
        hint="起个项目名、挑个风格模板，创建后直接开始 AI 对话。"
      />
    </aside>
  );
};

const UtilButton: React.FC<{
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  onClick: () => void;
  iconCls?: string;
}> = ({ icon: Icon, label, collapsed, onClick, iconCls }) => (
  <button
    onClick={onClick}
    title={label}
    className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium [color:var(--color-text-main)] hover:bg-surface-hover transition-all ${
      collapsed ? 'justify-center px-0' : ''
    }`}
  >
    <Icon className={`w-4 h-4 shrink-0 ${iconCls || ''}`} />
    {!collapsed && <span className="truncate flex-1 text-left">{label}</span>}
  </button>
);
