// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas K1 卡片内 / 弹层内通用表单控件（Toonflow 用的 Element Plus 外观）：
 *   KitField（标签 + 控件 + 提示）、KitInput、KitTextarea、KitSelect（原生 select + 箭头）、
 *   KitButton（default / primary / danger / text）、KitTag、KitAlert。
 * 尺寸：输入框 / 下拉 / 按钮高 32（size="sm" 为 28）、圆角 8（Tag 4）、边框 --cv-border-light、悬停 --cv-border、聚焦主色。
 * 颜色只用 --cv-*（跟随深浅色）；样式在 controls.css（类名前缀 .cv-ctl-*，不依赖 .cv-node 作用域，弹层里也能用）。
 * 输入类控件默认带 nodrag / nopan（nowheel 仅文本域）并拦截 pointer/mouse/key 冒泡：在节点里打字、拖选不会拖动节点或触发画布快捷键。
 */
import {
  forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEventHandler, type MouseEventHandler,
  type PointerEventHandler, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { IconChevronDown, IconLoader2 } from '@tabler/icons-react';
import type { KitIcon } from '../types';
import './controls.css';

export type KitControlSize = 'md' | 'sm';

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
interface GuardHandlers<T extends Element> {
  onPointerDown?: PointerEventHandler<T>;
  onMouseDown?: MouseEventHandler<T>;
  onKeyDown?: KeyboardEventHandler<T>;
}
/** 输入类控件的事件拦截：不拖节点、不平移画布、按键不触发画布快捷键（删除节点等）；调用方自己的同名回调照常执行。 */
function guards<T extends Element>(p: GuardHandlers<T>): Required<GuardHandlers<T>> {
  return {
    onPointerDown: (e) => { e.stopPropagation(); p.onPointerDown?.(e); },
    onMouseDown: (e) => { e.stopPropagation(); p.onMouseDown?.(e); },
    onKeyDown: (e) => { e.stopPropagation(); p.onKeyDown?.(e); },
  };
}

export interface KitInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: KitControlSize;
  /** 错误态（红框）。 */
  invalid?: boolean;
}

export const KitInput = forwardRef<HTMLInputElement, KitInputProps>(function KitInput({ size = 'md', invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx('cv-ctl-input nodrag nopan', size === 'sm' && 'cv-ctl--sm', invalid && 'is-invalid', className)}
      aria-invalid={invalid || undefined}
      {...rest}
      {...guards(rest)}
    />
  );
});

export interface KitTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const KitTextarea = forwardRef<HTMLTextAreaElement, KitTextareaProps>(function KitTextarea({ invalid, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx('cv-ctl-textarea nodrag nopan nowheel', invalid && 'is-invalid', className)}
      aria-invalid={invalid || undefined}
      {...rest}
      {...guards(rest)}
    />
  );
});

export interface KitSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface KitSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: KitControlSize;
  /** 选项（也可以直接写 <option> children）。 */
  options?: readonly KitSelectOption[];
  /** 有值时加一个 value="" 的占位选项。 */
  placeholder?: string;
  /** 包裹层类名（控制宽度 / flex）；className 作用在 <select> 上。 */
  wrapClassName?: string;
}

export const KitSelect = forwardRef<HTMLSelectElement, KitSelectProps>(function KitSelect(
  { size = 'md', options, placeholder, wrapClassName, className, children, ...rest }, ref,
) {
  return (
    <span className={cx('cv-ctl-select-wrap', wrapClassName)}>
      <select ref={ref} className={cx('cv-ctl-select nodrag nopan', size === 'sm' && 'cv-ctl--sm', className)} {...rest} {...guards(rest)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        {children}
      </select>
      <IconChevronDown className="cv-ctl-select-caret" size={14} aria-hidden />
    </span>
  );
});

export interface KitButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'text';
  size?: KitControlSize;
  icon?: KitIcon;
  loading?: boolean;
  /** 占满一行。 */
  block?: boolean;
}

/** el-button 外观的按钮（与 FloatingToolbar 的 ToolbarButton/.cv-btn 不同：这个有边框，用在卡片 / 弹层表单里）。 */
export const KitButton = forwardRef<HTMLButtonElement, KitButtonProps>(function KitButton(
  { variant = 'default', size = 'md', icon: Icon, loading, block, className, children, disabled, onClick, onPointerDown, onMouseDown, onDoubleClick, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('cv-ctl-btn nodrag nopan', `cv-ctl-btn--${variant}`, size === 'sm' && 'cv-ctl--sm', block && 'cv-ctl-btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
      onPointerDown={(e) => { e.stopPropagation(); onPointerDown?.(e); }}
      onMouseDown={(e) => { e.stopPropagation(); onMouseDown?.(e); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
    >
      {loading ? <IconLoader2 className="cv-spin" size={14} aria-hidden /> : Icon ? <Icon size={14} aria-hidden /> : null}
      {children}
    </button>
  );
});

export interface KitFieldProps {
  label?: ReactNode;
  /** 标签右侧（如「恢复默认」按钮、Agent 徽标）。 */
  extra?: ReactNode;
  /** 关联控件 id（点击标签聚焦控件）。 */
  htmlFor?: string;
  required?: boolean;
  /** 控件下方的灰色提示。 */
  hint?: ReactNode;
  /** 控件下方的错误提示（优先于 hint）。 */
  error?: ReactNode;
  /** 标签与控件同行（标签固定宽 72）。 */
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

export function KitField({ label, extra, htmlFor, required, hint, error, inline, className, children }: KitFieldProps) {
  return (
    <div className={cx('cv-ctl-field', inline && 'cv-ctl-field--inline', className)}>
      {(label || extra) && (
        <div className="cv-ctl-field__head">
          {label && (
            <label className="cv-ctl-label" htmlFor={htmlFor}>
              {label}
              {required && <span className="cv-ctl-required" aria-hidden>*</span>}
            </label>
          )}
          {extra}
        </div>
      )}
      <div className="cv-ctl-field__body">
        {children}
        {error ? <div className="cv-ctl-hint is-error" role="alert">{error}</div> : hint ? <div className="cv-ctl-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

export function KitTag({ tone = 'default', title, className, children }: { tone?: 'default' | 'primary' | 'warning' | 'danger'; title?: string; className?: string; children: ReactNode }) {
  return <span className={cx('cv-ctl-tag', `cv-ctl-tag--${tone}`, className)} title={title}>{children}</span>;
}

export function KitAlert({ tone = 'info', role, className, children }: { tone?: 'info' | 'warning' | 'danger' | 'primary'; role?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx('cv-ctl-alert', `cv-ctl-alert--${tone}`, className)} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      {children}
    </div>
  );
}
