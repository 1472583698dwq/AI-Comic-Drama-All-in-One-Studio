// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas（E2E-2 观察 7）：小地图会盖住选中节点的提示词面板 / 浮动工具栏（挡住发送键）。
 *
 * 小地图是 React Flow 的 Panel（z-index 5，在视口之上），节点面板在视口里，抬面板的 z 盖不过它。
 * 这里改成：选中节点的卡片或它的上下浮层（.cv-node__slot）和小地图在屏幕上相交时，小地图淡出且不拦截鼠标；
 * 不相交时照常显示。视口平移 / 缩放、选中变化、选中节点移动或尺寸变化时重新判断。
 */
import { useEffect, useState } from 'react';
import { MiniMap, useStore, type MiniMapProps, type ReactFlowState } from '@xyflow/react';

export interface RectLike { left: number; top: number; right: number; bottom: number }

/** 两个屏幕矩形是否相交（margin 外扩，贴边也算挡） */
export function rectsOverlap(a: RectLike, b: RectLike, margin = 8): boolean {
  return a.left < b.right + margin && a.right + margin > b.left && a.top < b.bottom + margin && a.bottom + margin > b.top;
}

/** 选中节点的屏幕矩形：卡片本身 + 上下浮层（工具栏 / 提示词面板） */
export function selectedNodeRects(root: ParentNode, ids: readonly string[]): RectLike[] {
  const out: RectLike[] = [];
  for (const id of ids) {
    const sel = `.react-flow__node[data-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`;
    const el = root.querySelector(sel);
    if (!el) continue;
    out.push(el.getBoundingClientRect());
    el.querySelectorAll('.cv-node__slot').forEach((s) => out.push(s.getBoundingClientRect()));
  }
  return out.filter((r) => r.right > r.left && r.bottom > r.top);
}

const selectedKey = (s: ReactFlowState): string => {
  const parts: string[] = [];
  for (const n of s.nodeLookup.values()) {
    if (!n.selected) continue;
    const p = n.internals.positionAbsolute;
    parts.push(`${n.id}@${Math.round(p.x)},${Math.round(p.y)},${n.measured?.width ?? 0}x${n.measured?.height ?? 0}`);
  }
  return parts.join('|');
};
const transformKey = (s: ReactFlowState) => s.transform.join(',');

export function AutoHideMiniMap({ className, ...props }: MiniMapProps) {
  const domNode = useStore((s) => s.domNode);
  const selKey = useStore(selectedKey);
  const tKey = useStore(transformKey);
  const [away, setAway] = useState(false);

  useEffect(() => {
    if (!domNode || !selKey) return;
    const ids = selKey.split('|').map((p) => p.slice(0, p.lastIndexOf('@')));
    const measure = () => {
      const mm = domNode.querySelector('.react-flow__minimap');
      if (!mm) return;
      const box = mm.getBoundingClientRect();
      setAway(selectedNodeRects(domNode, ids).some((r) => rectsOverlap(r, box)));
    };
    // 等这一帧渲染完（选中后浮层才挂上）再量；浮层内容（参考列表等）晚到时再补量一次
    const raf = window.requestAnimationFrame(measure);
    const t = window.setTimeout(measure, 300);
    return () => { window.cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [domNode, selKey, tKey]);

  // 没有选中节点时总显示（不依赖上一次的测量结果）
  const hidden = !!selKey && away;
  return <MiniMap {...props} className={[className, 'cv-minimap', hidden ? 'cv-minimap--away' : ''].filter(Boolean).join(' ')} />;
}
