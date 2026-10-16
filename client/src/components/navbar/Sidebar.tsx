import React, { useEffect, useMemo, useState } from 'react';
import {
  Lock, MessageCirclePlus, type LucideIcon,
} from 'lucide-react';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { usePageStore } from '../../stores/usePageStore';
import { isGlobalPage } from '../../ui-registry/pageTabs';

import { useChatHistoryStore } from '../../stores/useChatHistoryStore';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';
import { useAgentStore } from '../agent/agentStore';
import { toast } from '../../stores/useDialogStore';
import { pageIcon } from '../../utils/pageIcons';
import { NewProjectModal } from '../project/NewProjectModal';
import { UISlot } from '../../ui-registry/UISlot';
import { SIDEBAR_HOST, SIDEBAR_FOOTER_HOST } from '../../ui-registry/types';
import type { ProjectMeta } from '../../stores/useProjectListStore';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  pulse?: boolean;
}

/** 无项目时也能进的页（其余条目需要先有项目）；config 沉到底部 —— 常量见 stores/usePageStore */

/** 未分组页面的兜底分组名 */
const OTHER_GROUP = 'other';

/**
 * 左侧导航栏（ZCode WorkspaceSidebar 同构）：
 * 顶部「新建任务」→ 功能导航（后端页开关驱动，排除 config/agent——对话入口即新建任务与聊天历史；首页保留）→
 * 下半部聊天历史（会话/项目双视图 + 筛选 + 归档，ChatHistory）→ 底部「生成源/设置/收起」。
 *
 * - 新建任务：无项目时静默创建「新任务」项目承接；已有项目且当前会话未开始则直接复用，
 *   否则新建一段会话 —— 对应 ZCode 的 draft 语义（空会话不重复堆积）。
 * - 聊天历史点击 → 切项目（双 store 同步）→ 选中目标会话 → 进 AI 对话页。
 * - 聊天历史受 UI 开关控制（设置 → 功能开关 → UI 开关首项「会话与项目快捷侧栏」）：
 *   关掉后侧栏只剩功能导航 + 底部工具，满足「只要导航、要简洁」的用户。
 * - 底部工具区永远贴底（mt-auto），收起成图标轨时按钮位置与展开态一致，不会跑到导航下面去。
 * - 宽度 264px ⇄ 60px 图标轨；画布页默认收起的行为不变。
 */
export const Sidebar: React.FC = () => {
  const { project, activeTab, setActiveTab } = useProjectStore();
  const sidebarCollapsed = useProjectStore(selectSidebarCollapsed);
  const pages = usePageStore((s) => s.items);
  const values = usePageStore((s) => s.values);
  const groupMeta = usePageStore((s) => s.groups);
  const refreshHistory = useChatHistoryStore((s) => s.refresh);

  /** UI 开关（设置 → 功能开关 → UI 开关，首项）：会话与项目快捷侧栏默认显示，关掉后侧栏只剩导航与底部工具 */
  const historyVisible = useUiPrefsStore((s) => s.values.sidebar_chat_history !== false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);
  const charactersCount = project?.characters?.length || 0;

  const effectiveCollapsed = sidebarCollapsed;

  // 进入对话页 / 挂载时刷新一次历史（会话增删归档后由动作方就地刷新）；
  // UI 开关关掉快捷侧栏时不拉取 —— 没人看的数据不占请求
  useEffect(() => {
    if (!historyVisible) return;
    void refreshHistory();
  }, [refreshHistory, activeTab === 'agent', historyVisible]);

  /** 分组 → 条目（只含开启的页；config 沉底、projects 看板保留，首页保留在导航） */
  const groups = useMemo(() => {
    // 不进导航的页：agent（入口在「新建任务」+ 聊天历史）、projects（入口在顶栏项目下拉）、
    // characters（已并入素材库，作为素材库里的「角色」标签页）。页本身照常注册，路由与功能开关不受影响。
    const HIDDEN_IN_NAV = ['config', 'agent', 'projects', 'characters'];
    const enabled = pages.filter((p) => !HIDDEN_IN_NAV.includes(p.id) && values[p.id] === true);
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
    if (!isGlobalPage(id) && !project) {
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

  const activeCls = (item: NavItem, locked: boolean, active: boolean) => {
    if (locked) return 'opacity-35 cursor-not-allowed';
    if (active) return 'bg-surface-tertiary [color:var(--color-text-main)] font-semibold';
    return '[color:var(--color-text-main)] hover:bg-surface-hover';
  };

  return (
    <aside
      className={`relative shrink-0 h-full bg-surface/80 backdrop-blur-2xl flex flex-col z-20 overflow-hidden transition-[width] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
        effectiveCollapsed ? 'w-[60px]' : 'w-[264px]'
      }`}
    >
      {/* 固定宽度内层：宽度动画期间内容不参与压缩 */}
      <div
        className={`h-full flex flex-col border-r border-white/60 dark:border-white/10 ${effectiveCollapsed ? 'w-[60px]' : 'w-[264px]'}`}
      >
        {/* 顶部按钮堆栈：新建任务 + 功能导航。
            快捷侧栏（UI 开关）关掉时本区块接管剩余高度并可滚动，
            免得导航项一多就把底部工具区挤出视野 */}
        <div className={`px-2 pt-3 pb-1 space-y-0.5 ${
          historyVisible ? 'shrink-0' : 'flex-1 min-h-0 overflow-y-auto'
        }`}>
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
                    const locked = !isGlobalPage(item.id) && !project;
                    const active = activeTab === item.id || (item.id === 'assets' && activeTab === 'characters');
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

        {/* 下半部：会话 / 项目快捷区。Phase 3 起由注册表条目渲染
            （`sidebar.chat-history`，scope=prefs + switchId=sidebar_chat_history）——
            开关关掉即条目移除、整块消失；收起态由条目内部自己判 `selectSidebarCollapsed`。 */}
        <UISlot host={SIDEBAR_HOST} />

        {/* 底部工具区：生成源 / 主题 / 设置 / 收起。
            mt-auto 把本区块顶到侧栏最底部 —— 收起成图标轨时没有下方的聊天历史撑高度，
            少了它按钮会紧贴导航堆栈往上跑。
            按钮本体已条目化（host=sidebar.footer，未完成清单第 2 条）：容器（间距 / 上边框 / 底色）
            是宿主 chrome，条目只渲染按钮并自标标注属性；条目本身常驻，行为与改造前一致。 */}
        <div className="shrink-0 mt-auto p-2 border-t border-white/60 dark:border-white/10 space-y-0.5 bg-surface/80 dark:bg-black/45 backdrop-blur-xl">
          <UISlot host={SIDEBAR_FOOTER_HOST} />
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

