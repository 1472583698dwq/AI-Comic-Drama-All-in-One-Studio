import React from 'react';
import { Loader2 } from 'lucide-react';
import { GLASS, SectionTitle, T_MAIN } from '../../components/ui/designKit';

/**
 * 开关注册台的大卡片与配套零件（设置 → 功能开关）。
 *
 * 结构与原型 `docs/plans/prototype/minimal-shell.html` 的 `.scard` 对齐：
 *   序号（右上角等宽数字）→ 图标块 → 标题 + 英文小标 → 描述 → 虚线页脚（左：标签 / 右：大开关）。
 * 皮肤沿用当前设计系统：卡片底用 `designKit.GLASS`（设计 §9.1 规定面板类必须复用这套常量），
 * 阴影/圆角/间距都用现有 Token，不引入原型那套粗野主义硬阴影。
 *
 * 锁定卡片（locked）多一层警示斑纹（`ui-locked-stripe`，见 index.css），开关变成不可点的锁形。
 */

export type TagTone = 'default' | 'lock' | 'plugin' | 'on' | 'off';

const TAG_CLS: Record<TagTone, string> = {
  default: 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80',
  lock: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  plugin: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  on: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  off: 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80',
};

export const CardTag: React.FC<{ text: string; tone?: TagTone }> = ({ text, tone = 'default' }) => (
  <span className={`px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap ${TAG_CLS[tone]}`}>{text}</span>
);

/** 大开关（原型 48×27；锁定态不可点） */
export const BigSwitch: React.FC<{
  checked: boolean;
  locked?: boolean;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onToggle?: (next: boolean) => void;
}> = ({ checked, locked, busy, disabled, title, onToggle }) => {
  if (locked) {
    return (
      <span
        title={title}
        className="shrink-0 w-12 h-7 rounded-full relative bg-brand/40 border border-white/70 dark:border-white/12 flex items-center justify-center opacity-60"
        role="switch"
        aria-checked="true"
        aria-disabled="true"
      >
        <span className="w-2.5 h-2.5 rounded-sm border-2 border-white/80" aria-hidden="true" />
      </span>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      title={title}
      disabled={disabled || busy}
      onClick={() => onToggle?.(!checked)}
      className={`shrink-0 w-12 h-7 rounded-full relative transition-colors disabled:opacity-60 ${
        checked ? 'bg-brand' : 'bg-surface-hover/80 border border-white/70 dark:border-white/12'
      }`}
    >
      <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      {busy && <Loader2 className="absolute inset-0 m-auto w-3 h-3 animate-spin text-white/80" />}
    </button>
  );
};

export interface ConsoleCardProps {
  /** 分区内序号（1 起） */
  index: number;
  icon: React.ReactNode;
  title: string;
  /** 英文小标（等宽大写） */
  sub?: string;
  desc?: React.ReactNode;
  tags?: React.ReactNode;
  locked?: boolean;
  /** 页脚上方的一行附加动作（如「前往」） */
  extra?: React.ReactNode;
  /** 自定义页脚右侧；缺省渲染大开关 */
  footer?: React.ReactNode;
  checked?: boolean;
  busy?: boolean;
  toggleTitle?: string;
  onToggle?: (next: boolean) => void;
}

export const ConsoleCard: React.FC<ConsoleCardProps> = ({
  index, icon, title, sub, desc, tags, locked, extra, footer,
  checked = false, busy, toggleTitle, onToggle,
}) => (
  <div className={`${GLASS} relative rounded-2xl px-4 py-4 flex flex-col gap-2 min-h-[172px] ${locked ? 'ui-locked-stripe' : ''}`}>
    <span aria-hidden="true" className="absolute right-4 top-3 font-mono text-[18px] leading-none text-gray-500/45">
      {String(index).padStart(2, '0')}
    </span>

    <div className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center border border-white/70 dark:border-white/12 ${
      checked ? 'bg-brand/15 text-brand-light' : 'bg-surface-hover/80 text-gray-400'
    }`}>
      {icon}
    </div>

    <div className="min-w-0">
      <h3 className={`text-[14.5px] font-bold ${T_MAIN} leading-snug`}>{title}</h3>
      {sub && <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[.16em] text-gray-500 truncate">{sub}</div>}
    </div>

    {desc && <p className="text-[11.5px] text-gray-400 leading-relaxed">{desc}</p>}
    {extra}

    <div className="mt-auto pt-3 border-t border-dashed border-white/60 dark:border-white/12 flex items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">{tags}</div>
      {footer ?? (
        <BigSwitch
          checked={checked}
          locked={locked}
          busy={busy}
          title={toggleTitle}
          onToggle={onToggle}
        />
      )}
    </div>
  </div>
);

/**
 * 分区头：复用 designKit 的 `SectionTitle`（品牌短竖线 + 图标 + 标题），
 * 右侧塞「英文小标 + 计数」——与原型的分区头信息量一致，但视觉走当前设计系统。
 */
export const ConsoleSection: React.FC<{
  icon?: React.ReactNode;
  title: string;
  sub: string;
  count?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, sub, count, hint, children }) => (
  <section className="flex flex-col gap-2.5">
    <SectionTitle
      icon={icon}
      title={title}
      hint={(
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9.5px] uppercase tracking-[.16em] text-gray-500">{sub}</span>
          {count && <span className="font-mono text-[10px] text-gray-500">{count}</span>}
        </div>
      )}
    />
    {hint && <p className="text-[10.5px] text-gray-500 leading-relaxed -mt-1.5">{hint}</p>}
    <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
      {children}
    </div>
  </section>
);

/** 分区级错误提示（后端不可达时用；不写假状态，只给重试） */
export const SectionError: React.FC<{ text: string; onRetry: () => void; retryText: string }> = ({ text, onRetry, retryText }) => (
  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[11.5px] text-amber-300 flex items-center justify-between gap-3">
    <span>{text}</span>
    <button onClick={onRetry} className="shrink-0 px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 flex items-center gap-1">
      {retryText}
    </button>
  </div>
);

/** 分区空态（没有可切换项 / 还在读） */
export const SectionEmpty: React.FC<{ text: string; spinning?: boolean }> = ({ text, spinning }) => (
  <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3.5 py-3 text-[11.5px] text-gray-500 flex items-center gap-2">
    {spinning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
    {text}
  </div>
);
