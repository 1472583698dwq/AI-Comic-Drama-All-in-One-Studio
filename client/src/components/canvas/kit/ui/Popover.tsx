// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 弹层原语：渲染到 body（不随画布缩放，同 Toonflow el-popper teleport），
 * fixed 定位到锚点元素或坐标点，越界时翻转 / 夹回视口；点外部、Esc 关闭。
 * 弹层根节点拦截 React 合成事件冒泡，避免穿过 portal 触发节点的选中 / 双击聚焦等处理。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
export type PopoverAnchor = HTMLElement | null | { x: number; y: number };

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: PopoverAnchor;
  placement?: PopoverPlacement;
  offset?: number;
  className?: string;
  style?: CSSProperties;
  role?: string;
  'aria-label'?: string;
  /** 点击这些元素不算「外部」（如触发按钮自身）。 */
  ignoreOutside?: (HTMLElement | null | undefined)[];
  children: ReactNode;
}

const MARGIN = 8;

function anchorRect(anchor: PopoverAnchor): DOMRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

export function computePosition(rect: DOMRect, size: { width: number; height: number }, placement: PopoverPlacement, offset: number, viewport: { width: number; height: number }) {
  const [side, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end'];
  let top = side === 'bottom' ? rect.bottom + offset : rect.top - offset - size.height;
  // 放不下时翻到另一侧
  if (side === 'bottom' && top + size.height > viewport.height - MARGIN && rect.top - offset - size.height >= MARGIN) top = rect.top - offset - size.height;
  if (side === 'top' && top < MARGIN && rect.bottom + offset + size.height <= viewport.height - MARGIN) top = rect.bottom + offset;
  let left = align === 'start' ? rect.left : rect.right - size.width;
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, viewport.height - size.height - MARGIN));
  return { top, left };
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function Popover({ open, onClose, anchor, placement = 'bottom-start', offset = 4, className, style, role, ignoreOutside, children, ...rest }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ignoreRef = useRef(ignoreOutside);
  ignoreRef.current = ignoreOutside;

  const place = useCallback(() => {
    const el = ref.current;
    const rect = anchorRect(anchor);
    if (!el || !rect) return;
    const next = computePosition(rect, { width: el.offsetWidth, height: el.offsetHeight }, placement, offset, { width: window.innerWidth, height: window.innerHeight });
    setPos((p) => (p && p.top === next.top && p.left === next.left ? p : next));
  }, [anchor, placement, offset]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t)) return;
      const ignore = [anchor instanceof HTMLElement ? anchor : null, ...(ignoreRef.current || [])];
      if (ignore.some((el) => el && el.contains(t))) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(onMove) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      ro?.disconnect();
    };
  }, [open, anchor, place]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={rest['aria-label']}
      className={['cv-scope cv-popover nodrag nopan nowheel', className].filter(Boolean).join(' ')}
      style={{ ...style, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={stop}
      onWheel={stop}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemSpec {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 在该项之前画分隔线。 */
  divided?: boolean;
  extra?: ReactNode;
}

/** 菜单列表（Toonflow el-dropdown-menu 外观）。 */
export function MenuList({ items, onClose }: { items: MenuItemSpec[]; onClose?: () => void }) {
  return (
    <div role="menu" className="cv-menu">
      {items.map((it) => (
        <div key={it.key}>
          {it.divided && <div className="cv-menu__divider" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={['cv-menu__item', it.danger ? 'is-danger' : ''].filter(Boolean).join(' ')}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose?.();
              it.onSelect?.();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.extra && <span className="cv-menu__item-extra">{it.extra}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
