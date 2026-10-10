import React from 'react';
import { Plus } from 'lucide-react';

/**
 * 画布操作台（调色板）里的一行（原内联在 `CreativeCanvas.tsx`）。
 *
 * 抽出来的原因：插件贡献的节点行已条目化（`ui-registry/entries/canvasPaletteRow.tsx`，设计 §12），
 * 宿主与条目必须引用**同一份**行组件，否则视觉会悄悄漂移；`CreativeCanvas` 也就不再需要
 * 把行组件导出给注册表用（避免「大文件 → 条目 → 大文件」的循环导入）。
 */
export const WorkbenchRow: React.FC<{
  icon: any;
  iconCls?: string;
  label: string;
  desc?: string;
  title?: string;
  /** 悬停时右侧出现的主操作（默认「添加」） */
  actionLabel?: string;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}> = ({ icon: Icon, iconCls, label, desc, title, actionLabel = '添加', onClick, draggable, onDragStart }) => (
  <div
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    draggable={draggable}
    onDragStart={onDragStart}
    onClick={onClick}
    onKeyDown={(e) => {
      if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
    }}
    title={title}
    className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent hover:border-white/70 dark:border-white/12 hover:bg-surface/80 transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand active:cursor-grabbing"
  >
    <span className="w-8 h-8 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center shrink-0">
      <Icon className={`w-4 h-4 ${iconCls || '[color:var(--color-text-secondary)]'}`} strokeWidth={1.7} />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] font-medium [color:var(--color-text-main)] truncate">{label}</span>
      {desc && <span className="block text-[10.5px] [color:var(--color-text-muted)] truncate">{desc}</span>}
    </span>
    {onClick && (
      <span
        title={actionLabel}
        aria-hidden="true"
        className="w-6 h-6 rounded-md shrink-0 hidden group-hover:flex items-center justify-center [color:var(--color-text-muted)] group-hover:[color:var(--color-text-main)] group-hover:bg-surface-hover/80 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={1.7} />
      </span>
    )}
  </div>
);

export default WorkbenchRow;
