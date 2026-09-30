import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles, FolderKanban, Film, ChevronDown, ChevronRight, Lock, LogOut,
  Sun, Moon, MoreHorizontal, Wand2, Wrench, Server, Check, LayoutGrid, BookOpen,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { resolveTab } from '../../stores/usePageStore';
import { toast } from '../../stores/useDialogStore';

interface HeaderProps {
  /** 导入小说：入口收进「更多」菜单（弹窗由 App 持有），上游能力保留 */
  onOpenImport?: () => void;
  onOpenExport: () => void;
  /** 扩展工具不再常驻顶栏，统一收入「更多」菜单 */
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
  onOpenProvider?: () => void;
}

/** 面包屑第二段：当前视图名 */
const VIEW_LABEL: Record<string, string> = {
  home: '首页',
  projects: '项目看板',
  assets: '素材库',
  characters: '角色设定',
  agent: 'AI 导演',
  canvas: '创意画布',
  config: '设置',
};

interface Crumb {
  label: string;
  onClick?: () => void;
  current?: boolean;
  warn?: boolean;
}

/**
 * 图标按钮：视觉 36×36（--r-sm 6px），命中区由 ::after 外扩补足到 44×44。
 */
const ICON_BTN =
  'relative w-9 h-9 inline-flex items-center justify-center rounded-md text-gray-400 ' +
  'hover:text-white hover:bg-surface-secondary transition-colors ' +
  'after:absolute after:-inset-1 after:content-[""] ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand';

const MENU_ITEM =
  'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[11.5px] ' +
  'text-gray-300 hover:text-white hover:bg-surface-secondary transition-colors';

/**
 * 顶部栏（设计基线 §4 / §5.1）：高 44px，只承担「全局上下文 + 全局动作」。
 * - 左：品牌（logo 22px + 名称）· 面包屑（项目 / 视图，可点击）
 * - 右：动作组固定顺序 主题切换 → 更多 → 导出 → 生成（主按钮）
 * - 低频信息（镜数/时长）、扩展工具（技能/MCP/生成源）、退出项目一律收入「更多」，
 *   不再以胶囊形式常驻（基线禁用项）。
 */
export const Header: React.FC<HeaderProps> = ({
  onOpenImport, onOpenExport, onOpenMcp, onOpenSkills, onOpenProvider,
}) => {
  const { project, closeProject, activeTab, setActiveTab, totalDuration } = useProjectStore();
  const { effectiveTheme, toggleTheme } = useThemeStore();
  const { projects: projectList, fetchProjects, isLoading: isLoadingProjects } = useProjectListStore();

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
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
  const goCanvas = () => {
    if (!project) { toast.info('请先在项目看板创建或打开项目'); return; }
    goTab('canvas');
  };

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

  const viewLabel = VIEW_LABEL[activeTab] || '工作台';
  const toggleProjMenu = () => setProjOpen((v) => !v);
  const crumbs: Crumb[] = project
    ? [
        { label: project.title || '未命名项目', onClick: toggleProjMenu },
        { label: viewLabel, current: true },
      ]
    : activeTab === 'home'
      ? [{ label: '首页', current: true }]
      : activeTab === 'config'
        ? [{ label: '设置', current: true }]
        : [{ label: '未选择项目', onClick: toggleProjMenu, warn: true }];

  // 层级：顶栏自身必须 ≥ 画布「画布操作台」悬浮条（CreativeCanvas 里 z-30）。
  // z-index 会建立堆叠上下文，面板写再大的 z-40 也越不出顶栏这一层，
  // 所以下拉要压住悬浮条，只能把顶栏整体抬到 z-40。
  return (
    <header className="h-11 bg-surface/85 backdrop-blur-xl border-b border-border px-3.5 flex items-center gap-3 select-none z-40 relative shrink-0">
      {/* ── 左：品牌 22px + 名称 ── */}
      <button
        onClick={goHome}
        title="返回首页"
        aria-label="返回首页"
        className="flex items-center gap-2 shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
      >
        <span className="w-[22px] h-[22px] rounded-md bg-brand flex items-center justify-center shadow-sm shadow-brand/25 shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-white" strokeWidth={1.7} />
        </span>
        <span className="hidden lg:inline text-[13px] font-semibold tracking-tight text-white whitespace-nowrap">
          AI 漫剧 Studio
        </span>
      </button>

      {/* ── 左：面包屑（项目 / 视图） ── */}
      <nav aria-label="面包屑" className="flex items-center gap-1.5 min-w-0 flex-1">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 && (
              <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" strokeWidth={1.7} aria-hidden="true" />
            )}
            {c.onClick ? (
              <div className="relative min-w-0" ref={i === 0 ? projRef : undefined}>
                <button
                  onClick={c.onClick}
                  title={c.warn ? '选择项目' : '点击切换项目'}
                  aria-haspopup="menu"
                  aria-expanded={i === 0 ? projOpen : undefined}
                  className={`flex items-center gap-1 min-w-0 px-1.5 py-0.5 -mx-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ${
                    c.warn
                      ? 'text-amber-400 hover:text-amber-300 hover:bg-surface-secondary'
                      : 'text-gray-300 hover:text-white hover:bg-surface-secondary'
                  }`}
                >
                  {c.warn && <FolderKanban className="w-3.5 h-3.5 shrink-0" strokeWidth={1.7} />}
                  <span className="text-[11.5px] font-medium truncate max-w-[110px] md:max-w-[200px]">{c.label}</span>
                  <ChevronDown
                    className={`w-3 h-3 shrink-0 opacity-60 transition-transform ${i === 0 && projOpen ? 'rotate-180' : ''}`}
                    strokeWidth={1.7}
                  />
                </button>

                {/* 项目下拉切换面板（仅面包屑第一位实装） */}
                {i === 0 && (
                  <div
                    role="menu"
                    aria-label="切换项目"
                    aria-hidden={!projOpen}
                    className={`absolute left-0 top-[calc(100%+8px)] w-[268px] p-1.5 rounded-[14px] bg-surface border border-border shadow-xl z-40 origin-top-left transition-all duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
                      projOpen
                        ? 'opacity-100 scale-100 visible'
                        : 'opacity-0 scale-[.97] invisible pointer-events-none'
                    }`}
                  >
                    <div className="px-2.5 pt-1 pb-1 text-[10.5px] font-semibold tracking-wider text-gray-500">
                      切换项目
                    </div>
                    <div className="max-h-[264px] overflow-y-auto">
                      {projectList.length === 0 && !isLoadingProjects ? (
                        <div className="px-2.5 py-3 text-[11px] text-gray-500">暂无其他项目</div>
                      ) : (
                        projectList.map((p) => (
                          <button
                            key={p.id}
                            role="menuitem"
                            onClick={() => switchProject(p.id, p.title)}
                            className={`${MENU_ITEM} ${
                              p.id === project?.id ? 'text-white bg-surface-secondary' : ''
                            }`}
                          >
                            <FolderKanban className="w-4 h-4 shrink-0 opacity-70" strokeWidth={1.7} />
                            <span className="truncate flex-1">{p.title || '未命名项目'}</span>
                            {p.id === project?.id && (
                              <Check className="w-3.5 h-3.5 shrink-0 text-brand" strokeWidth={2.2} />
                            )}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="h-px bg-border-subtle mx-1 my-1" />
                    <button
                      role="menuitem"
                      className={MENU_ITEM}
                      onClick={() => { setProjOpen(false); goProjects(); }}
                    >
                      <LayoutGrid className="w-4 h-4 shrink-0" strokeWidth={1.7} />项目看板（管理 / 新建）
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <span aria-current="page" className="text-[13px] font-semibold text-white truncate px-0.5">
                {c.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </nav>

      {/* ── 右：主题切换 → 更多 → 导出 → 生成 ── */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={toggleTheme}
          aria-label={effectiveTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={effectiveTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          className={ICON_BTN}
        >
          {effectiveTheme === 'dark'
            ? <Moon className="w-4 h-4" strokeWidth={1.7} />
            : <Sun className="w-4 h-4" strokeWidth={1.7} />}
        </button>

        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="更多"
            title="更多"
            className={`${ICON_BTN} ${moreOpen ? 'text-white bg-surface-secondary' : ''}`}
          >
            <MoreHorizontal className="w-4 h-4" strokeWidth={1.7} />
          </button>

          {/* 常驻 DOM + 显隐过渡：保证面板开合有 260ms 动效，且关闭时不进入 Tab 序列 */}
          <div
            role="menu"
            aria-label="更多"
            aria-hidden={!moreOpen}
            className={`absolute right-0 top-[calc(100%+8px)] w-[248px] p-1.5 rounded-[14px] bg-surface border border-border shadow-xl z-40 origin-top-right transition-all duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
              moreOpen
                ? 'opacity-100 scale-100 visible'
                : 'opacity-0 scale-[.97] invisible pointer-events-none'
            }`}
          >
            {/* 导入小说：上游入口，收进菜单而非常驻顶栏 */}
            {onOpenImport && (
              <>
                <button
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => { setMoreOpen(false); onOpenImport(); }}
                >
                  <BookOpen className="w-4 h-4 shrink-0" strokeWidth={1.7} />导入小说
                </button>
                <div className="h-px bg-border-subtle mx-1 my-1" />
              </>
            )}

            {/* 项目信息：低频信息收入菜单，不常驻顶栏 */}
            {project && (
              <>
                <div className="px-2.5 pt-1.5 pb-2 flex items-center gap-3 text-[10.5px] text-gray-500">
                  <span className="flex items-center gap-1">
                    <Film className="w-3 h-3" strokeWidth={1.7} />{shotsCount} 镜
                  </span>
                  <span className="tabular-nums">{totalDuration.toFixed(0)}s</span>
                </div>
                <div className="h-px bg-border-subtle mx-1 mb-1" />
              </>
            )}

            <div className="px-2.5 pt-1 pb-1 text-[10.5px] font-semibold tracking-wider text-gray-500">
              扩展工具
            </div>
            <button
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => { setMoreOpen(false); onOpenSkills?.(); }}
            >
              <Wand2 className="w-4 h-4 shrink-0" strokeWidth={1.7} />技能工坊
            </button>
            <button
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => { setMoreOpen(false); onOpenMcp?.(); }}
            >
              <Wrench className="w-4 h-4 shrink-0" strokeWidth={1.7} />MCP 工具
            </button>
            <button
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => { setMoreOpen(false); onOpenProvider?.(); }}
            >
              <Server className="w-4 h-4 shrink-0" strokeWidth={1.7} />生成源管理
            </button>

            {project && (
              <>
                <div className="h-px bg-border-subtle mx-1 my-1" />
                <button
                  role="menuitem"
                  className={`${MENU_ITEM} text-red-400 hover:text-red-300 hover:bg-red-500/10`}
                  onClick={() => {
                    setMoreOpen(false);
                    closeProject();
                    toast.info('已退出当前项目，返回项目看板');
                  }}
                >
                  <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.7} />退出当前项目
                </button>
              </>
            )}
          </div>
        </div>

        <button
          disabled={!project}
          onClick={() => {
            if (!project) { toast.info('请先创建或打开项目以导出工程'); return; }
            onOpenExport();
          }}
          title={!project ? '请先创建或打开项目以导出剪映工程' : '导出剪映 / CapCut 草稿工程'}
          className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-border text-[11.5px] font-medium text-gray-300 hover:text-white hover:bg-surface-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
        >
          {project
            ? <Film className="w-4 h-4" strokeWidth={1.7} />
            : <Lock className="w-4 h-4" strokeWidth={1.7} />}
          <span className="hidden sm:inline">导出剪映</span>
          <span className="sm:hidden">导出</span>
        </button>

        <button
          disabled={!project}
          onClick={goCanvas}
          title={project ? '进入创意画布开始生成' : '请先创建或打开项目'}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md bg-brand text-white text-[11.5px] font-semibold shadow-sm shadow-brand/25 hover:bg-brand-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-glow"
        >
          <Wand2 className="w-4 h-4" strokeWidth={1.7} />
          生成
        </button>
      </div>
    </header>
  );
};

export default Header;
