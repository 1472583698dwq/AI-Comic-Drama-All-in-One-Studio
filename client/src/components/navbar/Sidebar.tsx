import React, { useEffect, useState } from 'react';
import {
  Sparkles, Layers, Users, Compass, Video, Library, FolderKanban, Bot,
  Settings, Sun, Moon, PanelLeftClose, PanelLeft, Lock, Plug,
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
 * - 底部工具区固定放「生成源 / 主题 / 系统设置」，设置永远可见（技能与 MCP 入口在 设置→扩展）。
 */
export const Sidebar: React.FC<SidebarProps> = ({ onOpenProvider }) => {
  const { project, activeTab, setActiveTab, setWorkspace } = useProjectStore();
  const { effectiveTheme, toggleTheme } = useThemeStore();

  const shotsCount = (project?.scenes || []).reduce(
    (n: number, s: any) => n + (s?.shots?.length || 0), 0);
  const charactersCount = project?.characters?.length || 0;

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

  const go = (id: string) => {
    if (id !== 'projects' && !project) {
      toast.info('请先在看板创建或打开项目');
      return;
    }
    if (id === 'canvas') { setWorkspace('creative'); setActiveTab('canvas'); }
    else if (id === 'assets') { setWorkspace('production'); setActiveTab('assets'); }
    else { setWorkspace('production'); setActiveTab(id as any); }
  };

  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: '漫剧工坊',
      items: [
        { id: 'projects', label: '项目看板', icon: FolderKanban },
        { id: 'studio', label: '分镜台', icon: Layers, count: shotsCount },
        { id: 'characters', label: '角色设定', icon: Users, count: charactersCount },
        { id: 'director3d', label: '3D 片场', icon: Compass },
        { id: 'timeline', label: '多轨剪辑', icon: Video },
        { id: 'assets', label: '素材库', icon: Library, accent: 'pink' },
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
    <aside
      className={`relative shrink-0 h-full bg-surface border-r border-border flex flex-col transition-[width] duration-200 z-20 ${
        collapsed ? 'w-[60px]' : 'w-[218px]'
      }`}
    >
      {/* 主导航区 */}
      <nav className="flex-1 overflow-y-auto custom-scrollbar py-3 space-y-3">
        {groups.map((g) => (
          <div key={g.title} className="px-2">
            {!collapsed && (
              <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                {g.title}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const locked = item.id !== 'projects' && !project;
                const active = activeTab === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => go(item.id)}
                    title={locked ? '请先创建或打开项目' : item.label}
                    className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium transition-all ${activeCls(item, locked, active)} ${
                      collapsed ? 'justify-center px-0' : ''
                    }`}
                  >
                    {locked ? (
                      <Lock className="w-4 h-4 shrink-0 text-gray-500" />
                    ) : (
                      <Icon className={`w-4 h-4 shrink-0 ${iconColor(item, active)}`} />
                    )}
                    {!collapsed && <span className="truncate flex-1 text-left">{item.label}</span>}
                    {!collapsed && !locked && typeof item.count === 'number' && item.count > 0 && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold ${
                        active ? 'bg-brand text-white' : 'bg-surface-tertiary text-gray-400'
                      }`}>{item.count}</span>
                    )}
                    {!collapsed && item.pulse && !locked && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    )}
                    {collapsed && item.pulse && !locked && (
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
          icon={Plug}
          label="生成源"
          collapsed={collapsed}
          onClick={() => onOpenProvider?.()}
          iconCls="text-brand-light"
        />

        <UtilButton
          icon={effectiveTheme === 'dark' ? Sun : Moon}
          label="切换主题"
          collapsed={collapsed}
          onClick={toggleTheme}
          iconCls={effectiveTheme === 'dark' ? 'text-amber-400' : 'text-indigo-400'}
        />

        <button
          onClick={() => setActiveTab('config')}
          title="设置：能力配置 / 扩展与插件 / 系统"
          className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-bold transition-all ${
            collapsed ? 'justify-center px-0' : ''
          } ${
            activeTab === 'config'
              ? 'bg-brand text-white shadow-sm shadow-brand/25'
              : 'bg-surface-secondary border border-border text-gray-200 hover:text-white hover:border-brand/50'
          }`}
        >
          <Settings className={`w-4 h-4 shrink-0 ${activeTab === 'config' ? 'text-white' : 'text-brand-light'}`} />
          {!collapsed && <span className="truncate">设置</span>}
        </button>

        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[11px] text-gray-500 hover:text-gray-300 hover:bg-surface-secondary transition-all ${
            collapsed ? 'justify-center px-0' : ''
          }`}
        >
          {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          {!collapsed && <span>收起侧栏</span>}
        </button>
      </div>
    </aside>
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
