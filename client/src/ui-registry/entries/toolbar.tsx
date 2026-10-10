import React from 'react';
import {
  BookOpen, Moon, PanelLeft, PanelLeftClose, Plug, Server, Settings, Sun, Wand2, Wrench,
} from 'lucide-react';
import { MENU_ITEM, UtilButton } from '../../components/navbar/toolbarAtoms';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { register } from '../registry';
import { modalIntents } from '../modalIntents';
import { useToolbarChrome } from '../toolbarContext';
import { HEADER_MENU_HOST, HEADER_TOOLS_HOST, SIDEBAR_FOOTER_HOST, markAttrs } from '../types';

/**
 * **工具动作条目化**（未完成清单第 2 条）：顶栏「更多」菜单与侧栏底部工具区的入口按钮
 * 从组件内硬编码改为注册表条目（`kind: 'toolbar'`）。
 *
 * 三个挂载点（为什么是两个 header 槽：菜单里「导入小说 / 项目信息 / 扩展工具 / 退出项目」
 * 之间有分隔线与分组标题，是宿主 chrome；把动作抽出来后仍需保持原有分组顺序）：
 *   · `header.menu`  —— 「更多」菜单里的低频动作（导入小说）
 *   · `header.tools` —— 「更多」菜单里的「扩展工具」组（技能工坊 / MCP 工具 / 生成源管理）
 *   · `sidebar.footer` —— 侧栏底部工具区（生成源 / 主题 / 设置 / 收起）
 *
 * 行为等价要点：
 *   1. **不绑 switchId**（迁移期常驻，设计 §3.3）—— 与改造前「永远在」完全一致；
 *      后续要给某个入口开关，只需在这条上补 `scope` + `switchId`（零成本），
 *      插件贡献的新工具也走同一挂载点 + 加 `source: 'plugin:<id>'` 即可按来源回滚。
 *   2. 菜单动作执行前先 `closeMenu()`（宿主通过 `ToolbarChromeContext` 注入）——
 *      与改造前 `setMoreOpen(false); onOpenSkills()` 的顺序一致。
 *   3. 侧栏底部条目**自标** `markAttrs`：`sidebar.*` 槽位不给包裹层（会破坏侧栏列的
 *      flex / 间距语义，见 `UISlot` 注释），所以标注属性打在条目自己的容器上。
 *   4. 侧栏壳（含底栏容器）仍是锁定条目 `shell.sidebar`（设计 §5.2 第 3 条：设置入口自救必需），
 *      这里条目化的是**底栏里的按钮**，不是壳本身。
 */

/* ───────────────────────── 顶栏「更多」菜单 ───────────────────────── */

/** 导入小说：上游入口，收进菜单而非常驻顶栏（与改造前一致） */
export const HeaderImportEntry: React.FC = () => {
  const { closeMenu } = useToolbarChrome();
  return (
    <button
      role="menuitem"
      className={MENU_ITEM}
      onClick={() => { closeMenu(); modalIntents().openImport(); }}
    >
      <BookOpen className="w-4 h-4 shrink-0" strokeWidth={1.7} />导入小说
    </button>
  );
};

/** 技能工坊（全局弹窗，弹窗本体由 host=app 的条目渲染） */
export const HeaderSkillsEntry: React.FC = () => {
  const { closeMenu } = useToolbarChrome();
  return (
    <button
      role="menuitem"
      className={MENU_ITEM}
      onClick={() => { closeMenu(); modalIntents().openSkills(); }}
    >
      <Wand2 className="w-4 h-4 shrink-0" strokeWidth={1.7} />技能工坊
    </button>
  );
};

/** MCP 工具面板 */
export const HeaderMcpEntry: React.FC = () => {
  const { closeMenu } = useToolbarChrome();
  return (
    <button
      role="menuitem"
      className={MENU_ITEM}
      onClick={() => { closeMenu(); modalIntents().openMcp(); }}
    >
      <Wrench className="w-4 h-4 shrink-0" strokeWidth={1.7} />MCP 工具
    </button>
  );
};

/** 生成源管理 */
export const HeaderProviderEntry: React.FC = () => {
  const { closeMenu } = useToolbarChrome();
  return (
    <button
      role="menuitem"
      className={MENU_ITEM}
      onClick={() => { closeMenu(); modalIntents().openProviderManager(); }}
    >
      <Server className="w-4 h-4 shrink-0" strokeWidth={1.7} />生成源管理
    </button>
  );
};

/* ───────────────────────── 侧栏底部工具区 ───────────────────────── */

const footerMark = (id: string) => markAttrs({ id, kind: 'toolbar', source: 'builtin' });

/** 生成源（设置页内也会用到同一弹窗；这里只是入口） */
export const SidebarProviderEntry: React.FC = () => {
  const collapsed = useProjectStore(selectSidebarCollapsed);
  return (
    <div {...footerMark('toolbar.sidebar.providers')}>
      <UtilButton
        icon={Plug}
        label="生成源"
        collapsed={collapsed}
        onClick={() => modalIntents().openProviderManager()}
        iconCls="text-brand-light"
      />
    </div>
  );
};

/** 白天 / 黑夜切换：收起态同样在底部第二格，位置与展开态一致 */
export const SidebarThemeEntry: React.FC = () => {
  const collapsed = useProjectStore(selectSidebarCollapsed);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const dark = effectiveTheme === 'dark';
  return (
    <div {...footerMark('toolbar.sidebar.theme')}>
      <UtilButton
        icon={dark ? Sun : Moon}
        label={dark ? '切换白天模式' : '切换黑夜模式'}
        collapsed={collapsed}
        onClick={toggleTheme}
        iconCls={dark ? 'text-amber-400' : 'text-indigo-400'}
      />
    </div>
  );
};

/** 设置（最小形态自救入口：侧栏壳锁定 + 后端拒绝停用 config，双保险） */
export const SidebarSettingsEntry: React.FC = () => {
  const collapsed = useProjectStore(selectSidebarCollapsed);
  const activeTab = useProjectStore((s) => s.activeTab);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);
  return (
    <div {...footerMark('toolbar.sidebar.settings')}>
      <button
        onClick={() => setActiveTab('config')}
        title="设置：核心能力 / 输出与存储 / 扩展 / 系统"
        className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-bold transition-all ${
          collapsed ? 'justify-center px-0' : ''
        } ${
          activeTab === 'config'
            ? 'bg-brand text-white shadow-sm shadow-brand/25'
            : '[color:var(--color-text-main)] hover:bg-surface-hover'
        }`}
      >
        <Settings className="w-4 h-4 shrink-0" />
        {!collapsed && <span className="truncate">设置</span>}
      </button>
    </div>
  );
};

/** 图标轨 ⇄ 完整栏（所有页面一致） */
export const SidebarCollapseEntry: React.FC = () => {
  const collapsed = useProjectStore(selectSidebarCollapsed);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  return (
    <div {...footerMark('toolbar.sidebar.collapse')}>
      <button
        onClick={toggleSidebar}
        title={collapsed ? '展开侧栏' : '收起侧栏'}
        className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[11px] [color:var(--color-text-main)] opacity-70 hover:opacity-100 hover:bg-surface-hover transition-all ${
          collapsed ? 'justify-center px-0' : ''
        }`}
      >
        {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        {!collapsed && <span>收起侧栏</span>}
      </button>
    </div>
  );
};

/* ───────────────────────── 登记 ───────────────────────── */

/**
 * 全部工具动作条目。`order` 与改造前菜单 / 底栏的视觉顺序一一对应：
 * 菜单：导入小说(10) → 扩展工具组 技能工坊(30)/MCP(40)/生成源(50)；
 * 底栏：生成源(10) / 主题(20) / 设置(30) / 收起(40)。
 */
function registerToolbarEntries(): Array<() => void> {
  return [
    register({ id: 'toolbar.header.import', kind: 'toolbar', host: HEADER_MENU_HOST, order: 10, source: 'builtin', render: HeaderImportEntry }),
    register({ id: 'toolbar.header.skills', kind: 'toolbar', host: HEADER_TOOLS_HOST, order: 30, source: 'builtin', render: HeaderSkillsEntry }),
    register({ id: 'toolbar.header.mcp', kind: 'toolbar', host: HEADER_TOOLS_HOST, order: 40, source: 'builtin', render: HeaderMcpEntry }),
    register({ id: 'toolbar.header.providers', kind: 'toolbar', host: HEADER_TOOLS_HOST, order: 50, source: 'builtin', render: HeaderProviderEntry }),
    register({ id: 'toolbar.sidebar.providers', kind: 'toolbar', host: SIDEBAR_FOOTER_HOST, order: 10, source: 'builtin', render: SidebarProviderEntry }),
    register({ id: 'toolbar.sidebar.theme', kind: 'toolbar', host: SIDEBAR_FOOTER_HOST, order: 20, source: 'builtin', render: SidebarThemeEntry }),
    register({ id: 'toolbar.sidebar.settings', kind: 'toolbar', host: SIDEBAR_FOOTER_HOST, order: 30, source: 'builtin', render: SidebarSettingsEntry }),
    register({ id: 'toolbar.sidebar.collapse', kind: 'toolbar', host: SIDEBAR_FOOTER_HOST, order: 40, source: 'builtin', render: SidebarCollapseEntry }),
  ];
}

registerToolbarEntries();
