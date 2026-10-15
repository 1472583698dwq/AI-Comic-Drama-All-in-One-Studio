// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点：文本弹窗（对照 Toonflow textNode 的 el-dialog「编辑文本」）。
 * 预览 ⇄ 编辑切换（预览 = Markdown 渲染只读视图，编辑 = MarkdownEditor），可全屏；
 * 宽 min(860px, 100vw-32px)、正文高 min(560px, 100dvh-144px)，全屏时铺满（同 Toonflow）。
 * 渲染到 body，拦截冒泡的指针 / 键盘事件，避免触发画布拖动、节点双击聚焦与画布快捷键。
 */
import { Suspense, lazy, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconCopy, IconLoader2, IconMaximize, IconMinimize, IconX } from '@tabler/icons-react';
import { ToolbarButton } from '../../kit';
import { MarkdownPreview } from './MarkdownPreview';
import { copyText } from './clipboard';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));

export type TextDialogMode = 'read' | 'edit';

export interface TextDocumentDialogProps {
  /** 节点标题 / 参考名 */
  title: string;
  value: string;
  /** 不传 = 只读（如预览上游文本参考），不显示「编辑」 */
  onChange?: (markdown: string) => void;
  mode: TextDialogMode;
  onModeChange?: (mode: TextDialogMode) => void;
  fullscreen: boolean;
  onFullscreenChange: (fullscreen: boolean) => void;
  /** 生成中：编辑器只读 */
  readOnly?: boolean;
  onClose: () => void;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function TextDocumentDialog(props: TextDocumentDialogProps) {
  const { title, value, onChange, fullscreen, onFullscreenChange, readOnly, onClose } = props;
  const editable = !!onChange;
  const mode: TextDialogMode = editable ? props.mode : 'read';
  const maskRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const downOnMask = useRef(false);
  const [copied, setCopied] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 打开时把焦点移进弹窗（Esc 可关），关闭时还给原来的元素
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => { prev?.focus?.({ preventScroll: true }); };
  }, []);
  // 焦点意外落到 body（如被点的按钮随模式切换卸载）时，Esc 仍能关闭弹窗；弹窗内的 Esc 由下面的 onKeyDown 处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const t = e.target as Node | null;
      if (t && maskRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest('.cv-popover')) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (typeof document === 'undefined') return null;
  const heading = mode === 'edit' ? '编辑文本' : title || '文本';
  return createPortal(
    <div
      ref={maskRef}
      className="cv-scope cv-text-dialog-mask nodrag nopan nowheel"
      onPointerDown={(e) => { e.stopPropagation(); downOnMask.current = e.target === e.currentTarget; }}
      onMouseDown={stop}
      onClick={(e) => {
        e.stopPropagation();
        if (downOnMask.current && e.target === e.currentTarget) onClose();
        downOnMask.current = false;
      }}
      onDoubleClick={stop}
      onContextMenu={stop}
      onWheel={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); onClose(); }
      }}
    >
      <div
        ref={dialogRef}
        className={['cv-card cv-text-dialog', fullscreen ? 'is-fullscreen' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
      >
        <div className="cv-text-dialog__header">
          <span className="cv-text-dialog__title" title={title}>{heading}</span>
          {editable && (
            <div className="cv-segmented" role="group" aria-label="查看方式">
              <button type="button" aria-pressed={mode === 'read'} onClick={() => props.onModeChange?.('read')}>预览</button>
              <button type="button" aria-pressed={mode === 'edit'} disabled={readOnly} title={readOnly ? '生成中，暂不能编辑' : undefined} onClick={() => props.onModeChange?.('edit')}>编辑</button>
            </div>
          )}
          <ToolbarButton
            icon={copied ? IconCheck : IconCopy}
            title={copied ? '已复制' : '复制文本'}
            iconOnly
            disabled={!value.trim()}
            onClick={() => { void copyText(value).then((ok) => ok && setCopied(true)); }}
          />
          <ToolbarButton icon={fullscreen ? IconMinimize : IconMaximize} title={fullscreen ? '退出全屏' : '全屏'} iconOnly onClick={() => onFullscreenChange(!fullscreen)} />
          <ToolbarButton icon={IconX} title="关闭" iconOnly onClick={onClose} />
        </div>
        <div className="cv-text-dialog__body">
          {mode === 'edit' && onChange ? (
            <Suspense fallback={<div className="cv-text-dialog__placeholder" role="status"><IconLoader2 className="cv-spin" size={20} aria-hidden />编辑器加载中…</div>}>
              <MarkdownEditor value={value} onChange={onChange} readOnly={readOnly} />
            </Suspense>
          ) : value.trim() ? (
            <div className="cv-text-dialog__read nowheel">
              <MarkdownPreview value={value} aria-label="文本内容" />
            </div>
          ) : (
            <div className="cv-text-dialog__placeholder">暂无内容</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
