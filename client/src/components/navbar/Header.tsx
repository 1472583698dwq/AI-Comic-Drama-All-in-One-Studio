import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, FolderKanban, Film, ChevronsUpDown, ChevronDown, ChevronRight, Lock, LogOut,
  MoreHorizontal, Wand2, Wrench, Server, Check, LayoutGrid, BookOpen, ArrowRight,
} from 'lucide-react';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { resolveTab } from '../../stores/usePageStore';
import { toast } from '../../stores/useDialogStore';
import { UISlot } from '../../ui-registry/UISlot';
import { ToolbarChromeContext } from '../../ui-registry/toolbarContext';
import { HEADER_MENU_HOST, HEADER_TOOLS_HOST } from '../../ui-registry/types';
import { MENU_ITEM } from './toolbarAtoms';

interface HeaderProps {
  /** 导出剪映工程（顶栏常驻按钮；动作本体是全局弹窗） */
  onOpenExport: () => void;
  /**
   * 注意：导入小说 / 技能工坊 / MCP 工具 / 生成源管理**已条目化**（未完成清单第 2 条），
   * 由 `header.menu` / `header.tools` 两个 toolbar 挂载点渲染，宿主不再持有这些回调。
   */
}

/** 项目头像底色：按项目 id 稳定取色，同一个项目永远同一个颜色（JetBrains 项目组件同款） */
const PROJECT_TINTS = [
  'from-violet-500 to-fuchsia-500',
  'from-sky-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-blue-500',
];
function projectTint(id?: string): string {
  if (!id) return 'from-gray-500 to-gray-600';
  let h = 0;
  for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) | 0;
  return PROJECT_TINTS[Math.abs(h) % PROJECT_TINTS.length];
}
/** 头像缩写：中文取前 2 个字，英文取前两个单词首字母 */
function projectInitials(title?: string): string {
  const t = (title || '').trim();
  if (!t) return '?';
  if (/^[\x00-\x7F]/.test(t)) {
    const words = t.split(/[\s_\-·]+/).filter(Boolean);
    return (words.length >= 2 ? words[0][0] + words[1][0] : t.slice(0, 2)).toUpperCase();
  }
  return Array.from(t.replace(/[\s·・]/g, '')).slice(0, 2).join('');
}

/* ── 顶栏设计 ──────────────────────────────────────────────
 * 栏高 56px（与素材库 / 角色页原本按 56px 预留的高度一致），左右 16px 留白。
 * 结构参照 Linear / Vercel 的工作区切换器 + JetBrains New UI 的项目组件：
 *   [品牌区 = 侧栏同宽] │ [项目切换器：头像 + 名称 / 概况两行] ……… [更多] [导出剪映]
 * 控件高度只有两档：项目切换器 40px，其余按钮 36px；字号只有三档：14 / 13 / 11.5px。
 * 颜色全走主题变量，浅色模式不会再出现白字压浅底。
 */
const T_MAIN = '[color:var(--color-text-main)]';
const T_SEC = '[color:var(--color-text-secondary)]';
const T_MUTED = '[color:var(--color-text-muted)]';
const HOVER_BG = 'hover:bg-black/[.045] dark:hover:bg-white/[.06]';
const ACTIVE_BG = 'bg-black/[.06] dark:bg-white/[.08]';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60';
const HAIRLINE = 'border-black/[.09] dark:border-white/[.09]';

const ICON_BTN =
  `relative w-9 h-9 inline-flex items-center justify-center rounded-lg ${T_MUTED} ` +
  `hover:[color:var(--color-text-main)] ${HOVER_BG} transition-colors ${FOCUS}`;

const MENU_PANEL =
  'absolute top-[calc(100%+8px)] p-1.5 rounded-2xl bg-white dark:bg-[#18181f] ' +
  `border ${HAIRLINE} ` +
  'shadow-[0_24px_48px_-16px_rgba(15,23,42,.28),0_2px_6px_rgba(15,23,42,.06)] ' +
  'dark:shadow-[0_24px_48px_-16px_rgba(0,0,0,.75),0_2px_6px_rgba(0,0,0,.3)] z-40 ' +
  'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none';

const MENU_LABEL = `px-2.5 pt-2 pb-1.5 text-[11.5px] font-medium ${T_MUTED}`;
const MENU_SEP = 'h-px bg-black/[.06] dark:bg-white/[.07] mx-1.5 my-1.5';

/** 「3 分钟前」式相对时间 */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  const dt = new Date(t);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

/** 镜数 · 时长 · 更新时间，缺哪段就省哪段 */
function projectMeta(shots?: number, seconds?: number, updatedAt?: string): string {
  const parts: string[] = [];
  parts.push(`${shots || 0} 镜`);
  if (seconds && seconds > 0) parts.push(`${Math.round(seconds)}s`);
  const rt = relTime(updatedAt);
  if (rt) parts.push(`${rt}更新`);
  return parts.join(' · ');
}

/**
 * 顶部栏（设计基线 §4 / §5.1）：高 44px，只承担「全局上下文 + 全局动作」。
 * - 左：品牌（logo 22px + 名称）· 面包屑（项目 / 视图，可点击）
 * - 右：动作组固定顺序 主题切换 → 更多 → 导出 → 生成（主按钮）
 * - 低频信息（镜数/时长）、扩展工具（技能/MCP/生成源）、退出项目一律收入「更多」，
 *   不再以胶囊形式常驻（基线禁用项）。
 */
export const Header: React.FC<HeaderProps> = ({ onOpenExport }) => {
  const { project, closeProject, activeTab, setActiveTab, totalDuration } = useProjectStore();
  // 品牌区与左侧导航同宽：项目切换器正好从内容区左边缘起，竖向分隔线和侧栏右边框连成一条
  const sidebarCollapsed = useProjectStore(selectSidebarCollapsed);
  const { projects: projectList, fetchProjects, isLoading: isLoadingProjects } = useProjectListStore();

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  /**
   * 注入给 toolbar 条目的宿主 chrome（「声明进注册表、回调由宿主注入」的最小形态）：
   * 动作执行前先收起「更多」菜单 —— 与改造前 `setMoreOpen(false); onOpenSkills()` 的顺序一致。
   * `setMoreOpen` 是 useState 的稳定 setter，故依赖数组为空即可。
   */
  const toolbarChrome = useMemo(() => ({ closeMenu: () => setMoreOpen(false) }), []);
  // 项目下拉切换器（logo 右侧面包屑第一位）：点击展开项目列表，可一键切换
  const [projOpen, setProjOpen] = useState(false);
  const projRef = useRef<HTMLDivElement>(null);

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);

  /**
   * 统一入口跳转：目标页可能已在 设置 → 功能开关 里被关掉（如「项目看板」），
   * 一律经 resolveTab 取一个确实开启的页（首页兜底），免得点了没反应或落到已关闭页。
   */
  const goTab = (id: 'home' | 'projects' | 'canvas') =>
    setActiveTab((resolveTab(id) || 'home') as any);
  const goProjects = () => goTab('projects');
  const goHome = () => goTab('home');

  // 挂载时先拉一次：顶栏的「X 前更新」要用项目索引里的时间，不能等到下拉展开才有
  useEffect(() => { fetchProjects({ sort: 'updated_at' }).catch(() => {}); }, [project?.id]);

  // 下拉展开时拉取最新项目列表（按最近更新排序）
  useEffect(() => {
    if (!projOpen) return;
    fetchProjects({ sort: 'updated_at' }).catch(() => {});
    const onDocDown = (e: MouseEvent) => {
      if (!projRef.current?.contains(e.target as Node)) setProjOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProjOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [projOpen]);

  /** 一键切换到指定项目：同步两个 store 的活跃态 + 加载完整工程内容 */
  const switchProject = async (id: string, title: string) => {
    setProjOpen(false);
    // 只跳过「点的是当前项目」这一种情况。不能写成 `!project || ...`：
    // 未选择项目时 project 为 null，那样会把下拉里的每一次点击都吞掉，
    // 用户就再也无法从顶栏选回任何项目（只能去项目看板），即"一直是未选择状态"。
    if (project?.id === id) return;
    // 双 store 同步：useProjectListStore.activeProjectId 是画布/素材等视图取 pid 的
    // 优先来源，只更新 useProjectStore 会导致界面仍挂旧项目、必须刷新才生效
    useProjectListStore.getState().setActiveProjectId(id);
    await useProjectStore.getState().loadActiveProject(id);
    toast.info(`已切换到「${title || '未命名项目'}」`);
  };

  // 「更多」菜单：Esc 关闭 + 点击外部关闭
  useEffect(() => {
    if (!moreOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const toggleProjMenu = () => setProjOpen((v) => !v);
  // 更新时间取两处里较新的：工程内容里的 updated_at 只在加载时读一次，
  // 项目索引里的会随保存刷新——只用前者的话顶栏会显示「7 天前」而下拉里显示「刚刚」
  const currentUpdatedAt = [
    (project as any)?.updated_at,
    projectList.find((p) => p.id === project?.id)?.updated_at,
  ].filter(Boolean).sort().pop() as string | undefined;

  // 层级：顶栏自身必须 ≥ 画布「画布操作台」悬浮条（CreativeCanvas 里 z-30）。
  // z-index 会建立堆叠上下文，面板写再大的 z-40 也越不出顶栏这一层，
  // 所以下拉要压住悬浮条，只能把顶栏整体抬到 z-40。
  const avatar = (id: string | undefined, title: string | undefined, big = false) => (
    <span
      className={`${big ? 'w-8 h-8 rounded-[9px] text-[12px]' : 'w-7 h-7 rounded-lg text-[11px]'} bg-gradient-to-br ${projectTint(id)} flex items-center justify-center shrink-0 font-semibold [color:#fff] leading-none tracking-tight shadow-[inset_0_1px_0_rgba(255,255,255,.25),0_1px_2px_rgba(0,0,0,.15)]`}
      aria-hidden="true"
    >
      {projectInitials(title)}
    </span>
  );

  return (
    <header className={`h-14 shrink-0 relative z-40 flex items-stretch select-none bg-surface/80 backdrop-blur-2xl border-b ${HAIRLINE}`}>
      {/* ── 品牌区：与左侧导航同宽，右边框和侧栏右边框连成一条线 ── */}
      <div
        className={`shrink-0 flex items-center border-r border-white/60 dark:border-white/10 transition-[width] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
          sidebarCollapsed ? 'w-[60px] justify-center' : 'w-[264px] px-4'
        }`}
      >
        <button
          onClick={goHome}
          title="返回首页"
          aria-label="返回首页"
          className={`flex items-center gap-2.5 min-w-0 h-10 rounded-xl ${sidebarCollapsed ? 'px-1.5' : 'pl-1.5 pr-3 -ml-1.5'} ${HOVER_BG} transition-colors ${FOCUS}`}
        >
          <span className="w-8 h-8 rounded-[9px] bg-gradient-to-br from-[color:var(--color-brand-light)] to-[color:var(--color-brand)] flex items-center justify-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_4px_12px_-4px_rgba(124,58,237,.6)]">
            <Sparkles className="w-4 h-4 [color:#fff]" strokeWidth={2} />
          </span>
          {!sidebarCollapsed && (
            <span className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className={`text-[15px] font-semibold tracking-tight ${T_MAIN}`}>AI 漫剧</span>
              <span className={`text-[13px] font-medium ${T_MUTED}`}>Studio</span>
            </span>
          )}
        </button>
      </div>

      {/* ── 主区：项目切换器 ……… 动作组 ── */}
      <div className="flex-1 min-w-0 flex items-center gap-3 px-4">
        <div className="relative min-w-0" ref={projRef}>
          <button
            onClick={toggleProjMenu}
            title={project ? '切换项目' : '选择项目'}
            aria-haspopup="menu"
            aria-expanded={projOpen}
            className={`flex items-center gap-2.5 min-w-0 h-10 pl-1.5 pr-2.5 rounded-xl border transition-colors ${FOCUS} ${
              projOpen
                ? `border-brand/50 ${ACTIVE_BG}`
                : project
                  ? `${HAIRLINE} bg-black/[.02] dark:bg-white/[.03] hover:border-black/20 dark:hover:border-white/20 ${HOVER_BG}`
                  : 'border-amber-500/40 bg-amber-500/[.06] hover:border-amber-500/70 hover:bg-amber-500/10'
            }`}
          >
            {project
              ? avatar(project.id, project.title)
              : (
                <span className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                  <FolderKanban className="w-4 h-4 text-amber-500" strokeWidth={1.8} />
                </span>
              )}
            <span className="flex flex-col items-start min-w-0 text-left leading-tight">
              <span
                className={`text-[13px] font-semibold truncate max-w-[180px] md:max-w-[320px] ${
                  project ? T_MAIN : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {project ? (project.title || '未命名项目') : '未选择项目'}
              </span>
              <span className={`text-[11.5px] ${T_MUTED} truncate max-w-[180px] md:max-w-[320px] tabular-nums`}>
                {project ? projectMeta(shotsCount, totalDuration, currentUpdatedAt) : '点击选择或新建项目'}
              </span>
            </span>
            <ChevronsUpDown className={`w-4 h-4 ml-1 shrink-0 ${T_MUTED}`} strokeWidth={1.8} />
          </button>

          <div
            role="menu"
            aria-label="切换项目"
            aria-hidden={!projOpen}
            className={`${MENU_PANEL} left-0 w-[360px] origin-top-left ${
              projOpen ? 'opacity-100 translate-y-0 visible' : 'opacity-0 -translate-y-1 invisible pointer-events-none'
            }`}
          >
            <div className={`${MENU_LABEL} flex items-center justify-between`}>
              <span>最近项目</span>
              {projectList.length > 0 && <span className="tabular-nums">{projectList.length}</span>}
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {projectList.length === 0 && !isLoadingProjects ? (
                <div className={`px-2.5 py-4 text-[13px] ${T_MUTED}`}>还没有项目</div>
              ) : (
                projectList.map((p) => {
                  const current = p.id === project?.id;
                  return (
                    <button
                      key={p.id}
                      role="menuitem"
                      onClick={() => switchProject(p.id, p.title)}
                      className={`w-full flex items-center gap-3 h-12 px-2 rounded-xl text-left transition-colors ${current ? ACTIVE_BG : HOVER_BG}`}
                    >
                      {avatar(p.id, p.title, true)}
                      <span className="flex-1 min-w-0 flex flex-col leading-tight">
                        <span className={`text-[13px] font-medium truncate ${T_MAIN}`}>{p.title || '未命名项目'}</span>
                        <span className={`text-[11.5px] truncate tabular-nums ${T_MUTED}`}>
                          {projectMeta(p.stats?.shots, p.stats?.duration, p.updated_at)}
                        </span>
                      </span>
                      {current && <Check className="w-4 h-4 shrink-0 text-brand" strokeWidth={2.4} />}
                    </button>
                  );
                })
              )}
            </div>
            <div className={MENU_SEP} />
            <button
              role="menuitem"
              className={`${MENU_ITEM} group`}
              onClick={() => { setProjOpen(false); goProjects(); }}
            >
              <LayoutGrid className="w-4 h-4 shrink-0" strokeWidth={1.8} />
              <span className="flex-1">项目看板</span>
              <span className={`text-[11.5px] ${T_MUTED}`}>管理 / 新建</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="flex-1" />

        {/* ── 动作组：更多 · 导出剪映 ── */}
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="更多"
            title="更多"
            className={`${ICON_BTN} ${moreOpen ? `${ACTIVE_BG} ${T_MAIN}` : ''}`}
          >
            <MoreHorizontal className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </button>

          {/* 常驻 DOM + 显隐过渡：保证面板开合有 260ms 动效，且关闭时不进入 Tab 序列。
              Provider 向 toolbar 条目注入「先收菜单再执行」的回调（未完成清单第 2 条）。 */}
          <ToolbarChromeContext.Provider value={toolbarChrome}>
          <div
            role="menu"
            aria-label="更多"
            aria-hidden={!moreOpen}
            className={`${MENU_PANEL} right-0 w-[240px] origin-top-right ${
              moreOpen ? 'opacity-100 translate-y-0 visible' : 'opacity-0 -translate-y-1 invisible pointer-events-none'
            }`}
          >
            {/* 低频动作条目（host=header.menu）：导入小说 */}
            <UISlot host={HEADER_MENU_HOST} />
            <div className={MENU_SEP} />
            <div className={MENU_LABEL}>扩展工具</div>
            {/* 扩展工具组条目（host=header.tools）：技能工坊 / MCP 工具 / 生成源管理（插件可继续加） */}
            <UISlot host={HEADER_TOOLS_HOST} />
            {project && (
              <>
                <div className={MENU_SEP} />
                <button
                  role="menuitem"
                  className={`${MENU_ITEM} !text-red-500 dark:!text-red-400 hover:!bg-red-500/10`}
                  onClick={() => { setMoreOpen(false); closeProject(); toast.info('已退出当前项目，返回项目看板'); }}
                >
                  <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.8} />退出当前项目
                </button>
              </>
            )}
          </div>
          </ToolbarChromeContext.Provider>
        </div>

        <button
          disabled={!project}
          onClick={() => {
            if (!project) { toast.info('请先创建或打开项目以导出工程'); return; }
            onOpenExport();
          }}
          title={!project ? '请先创建或打开项目以导出剪映工程' : '导出剪映 / CapCut 草稿工程'}
          className={`h-9 px-3.5 inline-flex items-center gap-2 rounded-lg border ${HAIRLINE} bg-black/[.02] dark:bg-white/[.03] text-[13px] font-medium ${T_SEC} hover:[color:var(--color-text-main)] hover:border-black/20 dark:hover:border-white/20 ${HOVER_BG} transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${FOCUS}`}
        >
          {project ? <Film className="w-4 h-4" strokeWidth={1.8} /> : <Lock className="w-4 h-4" strokeWidth={1.8} />}
          导出剪映
        </button>
      </div>
    </header>
  );
};

export default Header;
