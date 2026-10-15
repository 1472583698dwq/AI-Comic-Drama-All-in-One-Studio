// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 画布宿主的小部件（Toonflow canvas/index.vue 同款）：
 * - 连线显示层：统一画成平滑贝塞尔，与选中 / 拖动节点相连的边加 `cv-edge-active`（主色）；
 * - 点连线出现的 32px「断开」按钮（`.cv-edge-disconnect`，fixed，移出即消失）；
 * - 拖线到空白处 / 画布右键 / 双击空白的「添加节点」菜单（kit Popover + MenuList）；
 * - 媒体全屏查看层（宿主 openFullscreen）；
 * - 「回写到分镜」弹窗（ShotWriteBackControls，旧节点控制台里的回写能力移到节点右键菜单）。
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Edge, Node } from '@xyflow/react';
import { IconUnlink, IconX } from '@tabler/icons-react';
import { MenuList, Popover, type MenuItemSpec } from '../kit/ui/Popover';
import type { KitIcon } from '../kit/types';
import { resolveMediaUrl } from '../../../utils/devOrigin';
import { ShotWriteBackControls } from '../nodes2/legacy-a/ShotWriteBackControl';
import './host.css';

// ───────────────────────────── 连线显示层 ─────────────────────────────

/** 存量 smoothstep / step / straight / default 一律画成 simplebezier；只影响显示，不写回 edges 状态。 */
export function renderEdges(nodes: readonly Pick<Node, 'id' | 'selected' | 'dragging'>[], edges: readonly Edge[]): Edge[] {
  const active = new Set<string>();
  for (const n of nodes) if (n.selected || n.dragging) active.add(n.id);
  return edges.map((e) => {
    const hl = active.has(e.source) || active.has(e.target);
    const base = String(e.className || '').split(/\s+/).filter((c) => c && c !== 'cv-edge-active' && c !== 'canvas-edge-hl' && c !== 'canvas-edge-dim');
    if (hl) base.push('cv-edge-active');
    return {
      ...e,
      type: 'simplebezier',
      animated: false,
      selectable: false,
      focusable: false,
      interactionWidth: 40,
      zIndex: hl ? 1 : 0,
      className: base.join(' ') || undefined,
    };
  });
}

export function useRenderedEdges(nodes: readonly Node[], edges: readonly Edge[]): Edge[] {
  return useMemo(() => renderEdges(nodes, edges), [nodes, edges]);
}

// ───────────────────────────── 断开按钮 ─────────────────────────────

export interface EdgeDisconnectState { id: string; x: number; y: number }

export function EdgeDisconnectButton({ state, onDisconnect, onDismiss }: {
  state: EdgeDisconnectState | null;
  onDisconnect: (edgeId: string) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, onDismiss]);
  if (!state || typeof document === 'undefined') return null;
  return createPortal(
    <button
      type="button"
      className="cv-edge-disconnect"
      aria-label="断开连接"
      title="断开连接"
      style={{ left: state.x, top: state.y }}
      onClick={(e) => { e.stopPropagation(); onDisconnect(state.id); onDismiss(); }}
      onMouseLeave={onDismiss}
    >
      <IconUnlink size={16} aria-hidden />
    </button>,
    document.body,
  );
}

// ───────────────────────────── 添加节点菜单 ─────────────────────────────

export interface NodeMenuItem {
  type: string;
  label: string;
  icon: KitIcon;
  /** 拖线创建时新节点上要连的端口 */
  handleId?: string | null;
}

export interface NodeMenuState {
  x: number;
  y: number;
  /** flow 坐标（新节点落点） */
  flow: { x: number; y: number };
  /** 缺省 = 画布右键 / 双击：只建节点不连线 */
  from?: { nodeId: string; handleId: string | null; side: 'source' | 'target' };
  items: NodeMenuItem[];
}

export function NodeAddMenu({ menu, onPick, onClose }: { menu: NodeMenuState | null; onPick: (item: NodeMenuItem) => void; onClose: () => void }) {
  const items = useMemo<MenuItemSpec[]>(() => {
    if (!menu) return [];
    const title = !menu.from ? '添加节点' : menu.from.side === 'source' ? '创建并连接下游' : '创建并连接上游';
    const list: MenuItemSpec[] = [{ key: '__title', label: title, disabled: true }];
    if (!menu.items.length) list.push({ key: '__empty', label: '没有可连接的节点', disabled: true });
    for (const it of menu.items) {
      const Icon = it.icon;
      list.push({ key: it.type, label: it.label, icon: <Icon size={16} aria-hidden />, onSelect: () => onPick(it) });
    }
    return list;
  }, [menu, onPick]);
  return (
    <Popover open={!!menu} anchor={menu ? { x: menu.x, y: menu.y } : null} onClose={onClose} role="menu" aria-label="添加节点" className="cv-host-node-menu">
      <MenuList items={items} onClose={onClose} />
    </Popover>
  );
}

// ───────────────────────────── 全屏查看 ─────────────────────────────

export type ViewerKind = 'image' | 'video' | 'audio';

export interface ViewerState { url: string; kind?: ViewerKind; title?: string }

/** 按扩展名猜媒体类型（缺省图片）。 */
export function guessMediaKind(url: string): ViewerKind {
  const u = url.split('?')[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v|mkv)$/.test(u)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(u)) return 'audio';
  return 'image';
}

function Overlay({ onClose, children, label, className }: { onClose: () => void; children: ReactNode; label: string; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={['cv-scope cv-host-overlay', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}

export function FullscreenViewer({ state, onClose }: { state: ViewerState | null; onClose: () => void }) {
  if (!state) return null;
  const src = resolveMediaUrl(state.url) || state.url;
  const kind = state.kind || guessMediaKind(state.url);
  return (
    <Overlay onClose={onClose} label="全屏预览">
      <button type="button" className="cv-host-overlay__close" aria-label="关闭预览" title="关闭（Esc）" onClick={onClose}>
        <IconX size={18} aria-hidden />
      </button>
      <div className="cv-host-viewer" onClick={(e) => e.stopPropagation()}>
        {kind === 'video' ? (
          <video src={src} controls autoPlay className="cv-host-viewer__media" />
        ) : kind === 'audio' ? (
          <audio src={src} controls autoPlay className="cv-host-viewer__audio" />
        ) : (
          <img src={src} alt={state.title || '预览'} className="cv-host-viewer__media" />
        )}
      </div>
    </Overlay>
  );
}

// ───────────────────────────── 回写到分镜 ─────────────────────────────

export interface WriteBackState { nodeId: string; nodeType: string }

export function ShotWriteBackDialog({ state, data, onClose }: { state: WriteBackState | null; data: Record<string, unknown> | undefined; onClose: () => void }) {
  if (!state) return null;
  return (
    <Overlay onClose={onClose} label="回写到分镜">
      <div className="cv-card cv-host-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cv-host-dialog__head">
          <span>回写到分镜</span>
          <button type="button" className="cv-host-dialog__close" aria-label="关闭" onClick={onClose}><IconX size={16} aria-hidden /></button>
        </div>
        <ShotWriteBackControls nodeId={state.nodeId} nodeType={state.nodeType} data={data} />
      </div>
    </Overlay>
  );
}
