// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频节点用的模态弹窗（对照 Toonflow 的 el-dialog appendToBody：截取 900 / 历史 760）。
 * 渲染到 body（不随画布缩放），带 .cv-scope 让 --cv-* 变量跟随主题；
 * 拦截 React 合成事件冒泡（portal 里的事件会沿 React 树冒到节点，触发选中 / 双击聚焦 / 右键菜单）。
 * busy 时 Esc / 点遮罩不关闭（同 Toonflow closeOnPressEscape=!processing）。
 */
import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '@tabler/icons-react';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import './audio.css';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export interface AudioDialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  /** 处理中：Esc / 遮罩不关闭，关闭按钮改为「取消处理」语义由调用方决定 */
  busy?: boolean;
  width?: number;
  footer?: ReactNode;
  closeLabel?: string;
  children: ReactNode;
}

export function AudioDialog({ open, title, onClose, busy, width = 900, footer, closeLabel = '关闭', children }: AudioDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="cv-scope cv-audio-dialog-mask nodrag nopan nowheel"
      onPointerDown={stop}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !busyRef.current) onCloseRef.current();
      }}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={stop}
      onWheel={stop}
    >
      <div
        ref={ref}
        className="cv-audio-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ '--cv-audio-dialog-w': `${width}px` } as CSSProperties}
      >
        <div className="cv-audio-dialog__header">
          <ToolbarButton icon={IconX} title={closeLabel} iconOnly onClick={onClose} />
          <span id={titleId}>{title}</span>
        </div>
        <div className="cv-audio-dialog__body">{children}</div>
        {footer && <div className="cv-audio-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
