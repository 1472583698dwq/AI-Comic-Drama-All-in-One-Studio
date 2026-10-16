import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * 顶栏 / 侧栏工具条的**共用样式原子**（原本内联在 `Header.tsx` / `Sidebar.tsx`）。
 *
 * 为什么抽出来：工具动作已经条目化（`ui-registry/entries/toolbar.tsx`），
 * 宿主（Header / Sidebar）与条目必须引用**同一份** class —— 两处各写一份迟早会视觉漂移。
 * 纯样式 / 纯展示，不含任何开关或注册逻辑。
 */

/** 顶栏「更多」菜单里的菜单项（导入小说 / 扩展工具 / 退出项目 共用） */
export const MENU_ITEM =
  'w-full flex items-center gap-3 h-9 px-2.5 rounded-lg text-left text-[13px] [color:var(--color-text-secondary)] ' +
  'hover:[color:var(--color-text-main)] hover:bg-black/[.045] dark:hover:bg-white/[.06] transition-colors';

/** 侧栏底部工具按钮（生成源 / 主题切换；收起成图标轨时只留图标） */
export const UtilButton: React.FC<{
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
