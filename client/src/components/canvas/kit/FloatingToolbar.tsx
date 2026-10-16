// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 卡片上方浮动工具栏（Toonflow nodeSkeleton 默认 #top：mediaToolbar el-card）。
 * 结构：[添加到素材库] [左侧动作…] | [右侧动作…] [下载] [全屏]；el-card body padding 6，按钮 32px。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { IconDownload, IconFolderPlus, IconLoader2, IconMaximize } from '@tabler/icons-react';
import type { KitIcon } from './types';
import { resolveMediaUrl } from '../../../utils/devOrigin';

export interface ToolbarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon?: KitIcon;
  /** 悬停提示 + aria-label。 */
  title: string;
  /** 只显示图标（Toonflow 右侧动作 / 下载 / 全屏）。 */
  iconOnly?: boolean;
  loading?: boolean;
  active?: boolean;
  size?: 'md' | 'sm';
  children?: ReactNode;
}

/** el-button text 外观的按钮（工具栏、标题栏动作通用）。 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { icon: Icon, title, iconOnly, loading, active, size = 'md', children, className, disabled, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={['cv-btn', size === 'sm' ? 'cv-btn--sm' : '', active ? 'is-active' : '', className].filter(Boolean).join(' ')}
      title={title}
      aria-label={title}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      {...rest}
    >
      {loading ? <IconLoader2 size={16} className="cv-spin" aria-hidden /> : Icon ? <Icon size={16} aria-hidden /> : null}
      {!iconOnly && (children ?? title)}
    </button>
  );
});

export function ToolbarDivider() {
  return <span className="cv-toolbar__divider" aria-hidden />;
}

export interface FloatingToolbarProps {
  /** 左侧动作（Toonflow #topActions）。 */
  left?: ReactNode;
  /** 分隔线右侧动作（Toonflow #topRightActions）。 */
  right?: ReactNode;
  /** 「添加到素材库」：不传则不显示该按钮。 */
  onSaveToAssets?: () => void;
  saveDisabled?: boolean;
  /** 下载地址（存值可为相对 `/storage/...`，渲染时经 resolveMediaUrl 回源）。 */
  downloadUrl?: string;
  downloadName?: string;
  /**
   * REQ-toonflow-canvas K1：是否显示下载按钮。缺省 `!!downloadUrl`（无产出的节点不显示）；
   * 传 true 时没有 downloadUrl 也显示一个置灰的下载按钮（Toonflow 原样）。
   */
  showDownload?: boolean;
  /** 不传则不显示全屏按钮。 */
  onFullscreen?: () => void;
  /** 缺省：没有 downloadUrl 时置灰（Toonflow 同款）。 */
  fullscreenDisabled?: boolean;
  className?: string;
}

export function FloatingToolbar({ left, right, onSaveToAssets, saveDisabled, downloadUrl, downloadName, showDownload, onFullscreen, fullscreenDisabled, className }: FloatingToolbarProps) {
  const href = resolveMediaUrl(downloadUrl);
  return (
    <div className={['cv-card cv-toolbar', className].filter(Boolean).join(' ')} role="toolbar">
      {onSaveToAssets && (
        <ToolbarButton icon={IconFolderPlus} title="添加到素材库" disabled={saveDisabled} onClick={() => onSaveToAssets()}>
          添加到素材库
        </ToolbarButton>
      )}
      {left}
      <ToolbarDivider />
      {right}
      {href ? (
        <a
          className="cv-btn"
          href={href}
          download={downloadName || ''}
          target="_blank"
          rel="noreferrer"
          title="下载"
          aria-label="下载"
          onClick={(e) => e.stopPropagation()}
        >
          <IconDownload size={16} aria-hidden />
        </a>
      ) : showDownload ? (
        <ToolbarButton icon={IconDownload} title="下载" iconOnly disabled />
      ) : null}
      {onFullscreen && <ToolbarButton icon={IconMaximize} title="全屏" iconOnly disabled={fullscreenDisabled ?? !downloadUrl} onClick={() => onFullscreen()} />}
    </div>
  );
}
