// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 独有节点换皮 A —— 卡片内共用小控件（按钮 / 标签 / 提示条 / 下拉 / 进度条）。
 * 外观见 legacy-a.css（Toonflow el-* 结构，颜色只取 --cv-*），图标统一 Tabler。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { IconChevronDown, IconLoader2 } from '@tabler/icons-react';
import type { KitIcon } from '../../kit';
import { stopProp } from './helpers';
import './legacy-a.css';

export interface LaButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'default' | 'primary' | 'text' | 'link' | 'danger-text';
  size?: 'md' | 'sm' | 'xs';
  icon?: KitIcon;
  iconSize?: number;
  loading?: boolean;
  block?: boolean;
  active?: boolean;
  /** 只显示图标（同时用 title 作 aria-label）。 */
  iconOnly?: boolean;
}

export const LaButton = forwardRef<HTMLButtonElement, LaButtonProps>(function LaButton(
  { variant = 'default', size = 'md', icon: Icon, iconSize, loading, block, active, iconOnly, className, children, disabled, title, ...rest },
  ref,
) {
  const s = iconSize ?? (size === 'md' ? 16 : 14);
  return (
    <button
      ref={ref}
      type="button"
      className={[
        'cv-la-btn nodrag nopan',
        variant !== 'default' ? `cv-la-btn--${variant}` : '',
        size !== 'md' ? `cv-la-btn--${size}` : '',
        iconOnly ? 'cv-la-btn--icon' : '',
        block ? 'cv-la-btn--block' : '',
        active ? 'is-active' : '',
        className,
      ].filter(Boolean).join(' ')}
      title={title}
      aria-label={iconOnly ? title : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onDoubleClick={stopProp}
      {...rest}
    >
      {loading ? <IconLoader2 size={s} className="cv-la-spin" aria-hidden /> : Icon ? <Icon size={s} aria-hidden /> : null}
      {!iconOnly && children}
    </button>
  );
});

export function LaChip({ tone = 'neutral', icon: Icon, title, className, children }: {
  tone?: 'neutral' | 'accent';
  icon?: KitIcon;
  title?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span className={['cv-la-chip', tone === 'accent' ? 'cv-la-chip--accent' : '', className].filter(Boolean).join(' ')} title={title}>
      {Icon && <Icon size={12} aria-hidden />}
      {children}
    </span>
  );
}

export function LaNotice({ tone = 'neutral', icon: Icon, children, role }: {
  tone?: 'neutral' | 'accent' | 'danger';
  icon?: KitIcon;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={['cv-la-notice', tone !== 'neutral' ? `cv-la-notice--${tone}` : ''].filter(Boolean).join(' ')} role={role}>
      {Icon && <Icon size={14} aria-hidden />}
      <div className="cv-la-notice__body">{children}</div>
    </div>
  );
}

export interface LaSelectOption {
  value: string;
  label: string;
}

/** 原生 select（无障碍 / 键盘交互由浏览器提供），外观对齐 el-select：圆角 8、右侧 Tabler 下拉箭头。 */
export function LaSelect({ options, placeholder, className, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  options: readonly LaSelectOption[];
  /** 空值选项的文案；不传则不渲染空值选项。 */
  placeholder?: string;
}) {
  return (
    <span className={['cv-la-select', className].filter(Boolean).join(' ')}>
      <select className="cv-la-field nodrag nopan" onDoubleClick={stopProp} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <IconChevronDown className="cv-la-select__icon" size={14} aria-hidden />
    </span>
  );
}

export function LaProgress({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="cv-la-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}
