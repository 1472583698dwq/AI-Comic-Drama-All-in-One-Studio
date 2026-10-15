// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频节点用的弹窗（Toonflow el-dialog appendToBody 的 React 版）。
 * 渲染到 body（不随画布缩放）；`.cv-scope` 让 --cv-* 变量在 portal 里重新求值；
 * 根节点拦截 React 合成事件冒泡，避免穿过 portal 触发节点的选中 / 双击聚焦 / 拖动。
 */
import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '@tabler/icons-react';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  /** false：处理中不允许关闭（同 Toonflow closeOnClickModal / closeOnPressEscape / showClose = !processing）。 */
  closable?: boolean;
  width?: CSSProperties['width'];
  /** 距顶部（Toonflow top）。 */
  top?: string;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Modal({ open, title, onClose, closable = true, width = 520, top = '15vh', footer, children, className }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closableRef = useRef(closable);
  closableRef.current = closable;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (closableRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    // 打开时把焦点移进弹窗（键盘可直接操作）
    const t = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled]), input:not([disabled]), video');
      (el ?? dialogRef.current)?.focus?.();
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="cv-scope cv-modal nodrag nopan nowheel"
      style={{ paddingTop: top }}
      role="presentation"
      onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && closable) onClose(); }}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
      onWheel={stop}
    >
      <div
        ref={dialogRef}
        className={['cv-modal__dialog', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width }}
      >
        <div className="cv-modal__header">
          <h2 className="cv-modal__title" id={titleId}>{title}</h2>
          {closable && (
            <button type="button" className="cv-btn" aria-label="关闭" title="关闭" onClick={onClose}>
              <IconX size={16} aria-hidden />
            </button>
          )}
        </div>
        {children}
        {footer && <div className="cv-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
