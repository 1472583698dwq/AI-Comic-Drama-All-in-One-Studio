// -*- coding: utf-8 -*-
/**
 * 设计语言统一件（对齐「首页 / 设置中心」新版基线）。
 *
 * 约定（全站逐页对齐时统一从这里取，避免每页各写一套）：
 * - GLASS / GLASS_SOFT：磨砂玻璃面板。
 *   ⚠️ 不要用 bg-surface* 当玻璃底：index.css 把它们 !important 固定为不透明，做不出层次。
 *   做法与 HomeView 一致：浅色 = 半透明白 + 深色外描边；暗色 = 6% 白 + 浅描边。
 * - T_MAIN / T_SEC / T_MUTED：统一文本色（CSS 变量，深浅主题自动适配）。
 * - SectionTitle：品牌色短竖线 + 图标 + 标题 + 右侧动作（各区统一头部）。
 * - Ambience：页面氛围层（品牌光斑 + 极淡网格），玻璃才有可透的底。
 * - PILL / PILL_STRONG：徽标胶囊（顶部标签、状态位）。
 * - CTA_GRADIENT / BTN_GHOST：主/次按钮基线。
 */
import React from 'react';

/** 磨砂面板（大卡片） */
export const GLASS =
  'border border-white/70 bg-white/55 backdrop-blur-2xl '
  + 'shadow-[0_0_0_1px_rgba(15,23,42,.045),0_1px_0_0_rgba(255,255,255,.9)_inset,0_26px_54px_-32px_rgba(15,23,42,.38)] '
  + 'dark:border-white/12 dark:bg-white/[.06] '
  + 'dark:shadow-[0_0_0_1px_rgba(255,255,255,.05),0_1px_0_0_rgba(255,255,255,.06)_inset,0_26px_54px_-32px_rgba(0,0,0,.85)]';

/** 磨砂面板（小控件/工具条） */
export const GLASS_SOFT =
  'border border-white/65 bg-white/45 backdrop-blur-xl '
  + 'shadow-[0_1px_0_0_rgba(255,255,255,.7)_inset,0_18px_36px_-28px_rgba(15,23,42,.35)] '
  + 'dark:border-white/10 dark:bg-white/[.05] '
  + 'dark:shadow-[0_1px_0_0_rgba(255,255,255,.05)_inset,0_18px_36px_-28px_rgba(0,0,0,.8)]';

export const T_MAIN = '[color:var(--color-text-main)]';
export const T_SEC = '[color:var(--color-text-secondary)]';
export const T_MUTED = '[color:var(--color-text-muted)]';

/** 徽标胶囊 */
export const PILL =
  'inline-flex items-center gap-1 h-6 px-2.5 rounded-full border border-white/70 bg-white/60 backdrop-blur-md '
  + 'text-[10.5px] font-semibold dark:border-white/10 dark:bg-white/[.08]';

/** 主按钮（品牌渐变） */
export const CTA_GRADIENT =
  'inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-[color:var(--color-brand-light)] to-[color:var(--color-brand)] '
  + 'text-white font-semibold shadow-[0_14px_30px_-12px_rgba(124,58,237,.75)] hover:brightness-110 active:scale-[.98] transition-all '
  + 'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]';

/** 次按钮（磨砂幽灵） */
export const BTN_GHOST =
  'inline-flex items-center justify-center gap-2 rounded-2xl border border-white/70 bg-white/55 backdrop-blur-xl '
  + `${T_SEC} hover:[color:var(--color-text-main)] hover:bg-white/80 active:scale-[.98] transition-all `
  + 'dark:border-white/10 dark:bg-white/[.05] dark:hover:bg-white/[.09] '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-glow)]';

/** 分区标题：品牌短竖线 + 图标 + 标题 + 右侧动作 */
export const SectionTitle: React.FC<{ icon?: React.ReactNode; title: string; hint?: React.ReactNode }> = ({ icon, title, hint }) => (
  <div className="flex items-center justify-between mb-3.5">
    <h2 className={`text-[13.5px] font-bold ${T_MAIN} flex items-center gap-2`}>
      <span className="w-[3px] h-[13px] rounded-full bg-[color:var(--color-brand)] shrink-0" aria-hidden="true" />
      {icon && <span className={`${T_MUTED} flex items-center`}>{icon}</span>}
      {title}
    </h2>
    {hint}
  </div>
);

/** 页面氛围层：品牌光斑 + 极淡网格（放在页面根节点的绝对定位层里） */
export const Ambience: React.FC = () => (
  <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
    <div className="absolute -top-[28%] -left-[12%] w-[46vw] h-[46vw] min-w-[420px] min-h-[420px] rounded-full blur-[110px] opacity-[.22] bg-[radial-gradient(circle_at_center,#7C3AED,transparent_62%)]" />
    <div className="absolute -top-[18%] right-[-14%] w-[40vw] h-[40vw] min-w-[380px] min-h-[380px] rounded-full blur-[120px] opacity-[.18] bg-[radial-gradient(circle_at_center,#0EA5E9,transparent_62%)]" />
    <div className="absolute bottom-[-22%] left-[28%] w-[36vw] h-[36vw] min-w-[320px] min-h-[320px] rounded-full blur-[130px] opacity-[.14] bg-[radial-gradient(circle_at_center,#EC4899,transparent_65%)]" />
    <div className="absolute inset-0 opacity-[.55] [background-image:linear-gradient(to_right,rgba(15,23,42,.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,.045)_1px,transparent_1px)] [background-size:52px_52px] [mask-image:radial-gradient(ellipse_at_50%_0%,#000_10%,transparent_78%)] dark:opacity-[.4] dark:[background-image:linear-gradient(to_right,rgba(255,255,255,.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,.05)_1px,transparent_1px)]" />
  </div>
);
