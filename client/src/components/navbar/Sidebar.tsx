import React, { useEffect, useState } from 'react';
import {
  Sparkles, Library, FolderKanban, Bot, Users,
  Settings, Sun, Moon, PanelLeftClose, PanelLeft, Lock, Home,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { toast } from '../../stores/useDialogStore';

interface SidebarProps {
  /** 设置页内仍会用到这三个弹窗，App 统一持有开关 */
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
  onOpenProvider?: () => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: any;
  count?: number;
  accent?: 'pink' | 'purple';
  pulse?: boolean;
}

/**
 * 左侧主导航（SaaS 惯例：主导航常驻侧栏 + 设置沉到底部工具区）。
 * - 顶栏只保留全局上下文；本项目主频道全部收敛到这里，支持折叠成图标栏。
 * - 底部工具区固定放「生成源 / 技能 / MCP / 主题 / 系统设置」，设置永远可见。
 * - **无限画布（activeTab=canvas）：侧栏默认整条隐藏**；唤出按钮统一放在画布左上角
 *   「画布操作台」条的第一个按钮上（不再单独悬浮一个图标按钮），点击滑出「缩小态」
 *   图标轨（60px），底部按钮可再次收起。其余页面维持常驻 + 可折叠的原有行为。
 */
export const Sidebar: React.FC<SidebarProps> = () => {
  const { project, activeTab, setActiveTab, canvasRailOpen, setCanvasRailOpen } = useProjectStore();
  const { effectiveTheme, toggleTheme } = useThemeStore();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('studio_sidebar_collapsed');
      if (saved !== null) return saved === '1';
      return typeof window !== 'undefined' && window.innerWidth < 1180;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('studio_sidebar_collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  // 画布态：整条侧栏隐藏，唤出按钮已合并到画布左上角「画布操作台」条上的第一个按钮
  // （状态在 store 里，画布那边点它 → 这里滑出图标轨）；每次切换页签都回到隐藏态。
  const isCanvas = activeTab === 'canvas';
  useEffect(() => { setCanvasRailOpen(false); }, [activeTab, setCanvasRailOpen]);

  /** 画布态强制缩小态（图标轨）；其余页面沿用用户自己的折叠偏好 */
  const effectiveCollapsed = collapsed || isCanvas;
  const railVisible = !isCanvas || canvasRailOpen;

  const go = (id: string) => {
    // 首页/看板是全局页，不要求已选项目
    if (id !== 'home' && id !== 'projects' && !project) {
      toast.info('请先在看板创建或打开项目');
      return;
    }
    // 工作区（creative/production）与已下线页签的重定向统一由 store 的 setActiveTab 处理
    setActiveTab(id as any);
  };

  // 精简链路：保留 首页 / 项目看板 / 素材库 / 角色设定 / AI 导演 / 创意画布（设置固定在侧栏底部工具区）。
  // 已下线：分镜工作台（studio）/ 3D 片场（director3d）/ 多轨剪辑（timeline）。
  // 角色设定（characters）保留启用 —— 它是角色三视图与参考音频的唯一生产端。
  const charactersCount = project?.characters?.length || 0;
  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: '工作区',
      items: [
        { id: 'home', label: '首页', icon: Home },
        { id: 'projects', label: '项目看板', icon: FolderKanban },
        { id: 'assets', label: '素材库', icon: Library, accent: 'pink' },
        { id: 'characters', label: '角色设定', icon: Users, count: charactersCount },
      ],
    },
    {
      title: '创意工坊',
      items: [
        { id: 'agent', label: 'AI 导演', icon: Bot, pulse: true },
        { id: 'canvas', label: '创意画布', icon: Sparkles, accent: 'purple' },
      ],
    },
  ];

  const activeCls = (item: NavItem, locked: boolean, active: boolean) => {
    if (locked) return 'opacity-35 cursor-not-allowed text-gray-500';
    if (active) {
      if (item.accent === 'pink') return 'bg-accent-pink/15 text-white ring-1 ring-accent-pink/40';
      if (item.accent === 'purple') return 'bg-brand/20 text-white ring-1 ring-brand/40';
      return 'bg-brand/15 text-white ring-1 ring-brand/40';
    }
    return 'text-gray-400 hover:text-white hover:bg-surface-secondary';
  };

  const iconColor = (item: NavItem, active: boolean) => {
    if (item.accent === 'pink') return 'text-accent-pink';
    if (item.accent === 'purple') return 'text-purple-400';
    return active ? 'text-brand-light' : 'text-gray-400';
  };

  return (
    <>
      <aside
        className={`relative shrink-0 h-full bg-surface flex flex-col z-20 overflow-hidden transition-[width] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
          !railVisible ? 'w-0' : effectiveCollapsed ? 'w-[60px]' : 'w-[218px]'
        }`}
      >
        {/* 固定宽度内层：宽度动画期间内容不参与压缩；隐藏态 inert 掉，不进入 Tab 序列。
            发丝右边框挂在内层，收起动画时随内容一起被 overflow 裁掉，不会留下 1px 竖线。 */}
        <div
          inert={!railVisible}
          aria-hidden={!railVisible}
          className={`h-full flex flex-col border-r border-border ${effectiveCollapsed ? 'w-[60px]' : 'w-[218px]'}`}
        >
          {/* 主导航区 */}
          <nav className="flex-1 overflow-y-auto custom-scrollbar py-3 space-y-3">
            {groups.map((g) => (
              <div key={g.title} className="px-2">
                {!effectiveCollapsed && (
                  <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    {g.title}
                  </div>
                )}
                <div className="space-y-0.5">
                  {g.items.map((item) => {
                    const locked = item.id !== 'home' && item.id !== 'projects' && !project;
                    const active = activeTab === item.id;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => go(item.id)}
                        title={locked ? '请先创建或打开项目' : item.label}
                        className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium transition-all ${activeCls(item, locked, active)} ${
                          effectiveCollapsed ? 'justify-center px-0' : ''
                        }`}
                      >
                        {locked ? (
                          <Lock className="w-4 h-4 shrink-0 text-gray-500" />
                        ) : (
                          <Icon className={`w-4 h-4 shrink-0 ${iconColor(item, active)}`} />
                        )}
                        {!effectiveCollapsed && <span className="truncate flex-1 text-left">{item.label}</span>}
                        {!effectiveCollapsed && !locked && typeof item.count === 'number' && item.count > 0 && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold ${
                            active ? 'bg-brand text-white' : 'bg-surface-tertiary text-gray-400'
                          }`}>{item.count}</span>
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
          </nav>

          {/* 底部工具区：设置永远可见 */}
          <div className="p-2 border-t border-border space-y-0.5 bg-surface/95">
            <UtilButton
              icon={effectiveTheme === 'dark' ? Sun : Moon}
              label="切换主题"
              collapsed={effectiveCollapsed}
              onClick={toggleTheme}
              iconCls={effectiveTheme === 'dark' ? 'text-amber-400' : 'text-indigo-400'}
            />

            <button
              onClick={() => setActiveTab('config')}
              title="设置：核心能力 / 输出与存储 / 扩展 / 系统"
              className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-bold transition-all ${
                effectiveCollapsed ? 'justify-center px-0' : ''
              } ${
                activeTab === 'config'
                  ? 'bg-brand text-white shadow-sm shadow-brand/25'
                  : 'text-gray-400 hover:text-white hover:bg-surface-secondary'
              }`}
            >
              <Settings className={`w-4 h-4 shrink-0 ${activeTab === 'config' ? 'text-white' : 'text-gray-400'}`} />
              {!effectiveCollapsed && <span className="truncate">设置</span>}
            </button>

            {/* 画布态收起 = 整条隐藏回悬浮按钮；其余页面仍是「图标轨 ⇄ 完整栏」 */}
            <button
              onClick={() => (isCanvas ? setCanvasRailOpen(false) : setCollapsed((v) => !v))}
              title={isCanvas ? '收起侧栏' : effectiveCollapsed ? '展开侧栏' : '收起侧栏'}
              className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[11px] text-gray-500 hover:text-gray-300 hover:bg-surface-secondary transition-all ${
                effectiveCollapsed ? 'justify-center px-0' : ''
              }`}
            >
              {effectiveCollapsed && !isCanvas ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
              {!effectiveCollapsed && <span>收起侧栏</span>}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};

const UtilButton: React.FC<{
  icon: any;
  label: string;
  collapsed: boolean;
  onClick: () => void;
  iconCls?: string;
  badge?: number;
}> = ({ icon: Icon, label, collapsed, onClick, iconCls, badge }) => (
  <button
    onClick={onClick}
    title={label}
    className={`relative w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-gray-400 hover:text-white hover:bg-surface-secondary transition-all ${
      collapsed ? 'justify-center px-0' : ''
    }`}
  >
    <Icon className={`w-4 h-4 shrink-0 ${iconCls || 'text-gray-400'}`} />
    {!collapsed && <span className="truncate flex-1 text-left">{label}</span>}
    {!collapsed && badge && badge > 0 ? (
      <span className="text-[9px] font-mono text-emerald-400 font-bold">{badge}</span>
    ) : null}
    {collapsed && badge && badge > 0 ? (
      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400" />
    ) : null}
  </button>
);
