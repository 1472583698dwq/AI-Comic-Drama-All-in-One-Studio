// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 选区工具栏（对照 Toonflow canvas/components/selectionToolbar.vue）。
 * 选中 ≥2 个节点（或选中了分组）时出现在选区上方：水平/垂直/宫格排列 | 创建副本 · 成组 · 解组。
 * 作为 <ReactFlow> 的子元素渲染（需要 React Flow store）；结果默认用 setNodes/setEdges 提交，宿主可用 apply 接管（如批量撤销）。
 */
import { useCallback, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useReactFlow, useStore, type Edge, type Node, type ReactFlowState } from '@xyflow/react';
import { IconBoxMultiple, IconCopyPlus, IconDeselect, IconLayoutColumns, IconLayoutGrid, IconLayoutRows } from '@tabler/icons-react';
import { ToolbarButton } from './FloatingToolbar';
import { GROUP_TYPE, arrangeNodes, duplicateNodes, groupNodes, selectionRoots, ungroupNodes, type ArrangeMode } from './graphOps';

export type SelectionAction = ArrangeMode | 'duplicate' | 'group' | 'ungroup';

export interface SelectionToolbarProps {
  disabled?: boolean;
  /** 接管提交（缺省 rf.setNodes / rf.setEdges）。 */
  apply?: (next: { nodes: Node[]; edges: Edge[] }, action: SelectionAction) => void;
  /** 操作完成回调（新选中的节点 id）。 */
  onDone?: (action: SelectionAction, selectedIds: string[]) => void;
  /** 生成新节点 id（缺省 kit 的 defaultIdFactory）。 */
  idFactory?: (prefix: string) => string;
}

interface SelectionInfo {
  ids: string[];
  hasGroup: boolean;
  x: number; y: number; w: number; h: number;
  tx: number; ty: number; zoom: number;
  width: number; height: number;
  active: boolean;
}

function selectionSelector(s: ReactFlowState): SelectionInfo {
  const ids: string[] = [];
  let hasGroup = false;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of s.nodes) {
    if (!n.selected) continue;
    ids.push(n.id);
    if (n.type === GROUP_TYPE) hasGroup = true;
    const internal = s.nodeLookup.get(n.id);
    const p = internal?.internals.positionAbsolute ?? n.position;
    const w = internal?.measured?.width ?? n.width ?? 0;
    const h = internal?.measured?.height ?? n.height ?? 0;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + w); y1 = Math.max(y1, p.y + h);
  }
  const [tx, ty, zoom] = s.transform;
  return {
    ids, hasGroup,
    x: ids.length ? x0 : 0, y: ids.length ? y0 : 0, w: ids.length ? x1 - x0 : 0, h: ids.length ? y1 - y0 : 0,
    tx, ty, zoom, width: s.width, height: s.height,
    active: s.userSelectionActive,
  };
}

function sameSelection(a: SelectionInfo, b: SelectionInfo): boolean {
  return a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]) && a.hasGroup === b.hasGroup
    && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.tx === b.tx && a.ty === b.ty && a.zoom === b.zoom
    && a.width === b.width && a.height === b.height && a.active === b.active;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

const LAYOUTS: { mode: ArrangeMode; label: string; icon: typeof IconLayoutColumns }[] = [
  { mode: 'horizontal', label: '水平排列', icon: IconLayoutColumns },
  { mode: 'vertical', label: '垂直排列', icon: IconLayoutRows },
  { mode: 'grid', label: '宫格排列', icon: IconLayoutGrid },
];

export function SelectionToolbar({ disabled, apply, onDone, idFactory }: SelectionToolbarProps) {
  const rf = useReactFlow();
  const sel = useStore(selectionSelector, sameSelection);
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const commit = useCallback((next: { nodes: Node[]; edges: Edge[] }, action: SelectionAction, selectIds: string[]) => {
    const select = new Set(selectIds);
    const nodes = next.nodes.map((n) => (select.has(n.id) === !!n.selected ? n : { ...n, selected: select.has(n.id) }));
    if (apply) apply({ nodes, edges: next.edges }, action);
    else {
      rf.setNodes(nodes);
      rf.setEdges(next.edges);
    }
    onDone?.(action, selectIds);
  }, [apply, onDone, rf]);

  const operate = useCallback((action: SelectionAction) => {
    if (busy || disabled || !sel.ids.length) return;
    setBusy(true);
    try {
      const nodes = rf.getNodes() as Node[];
      const edges = rf.getEdges() as Edge[];
      const ids = sel.ids;
      if (action === 'duplicate') {
        const r = duplicateNodes(nodes, edges, ids, { withEdges: true, placement: 'right', idFactory });
        commit({ nodes: r.nodes, edges: r.edges }, action, r.newIds);
      } else if (action === 'group') {
        const r = groupNodes(nodes, ids, { idFactory });
        if (r.groupId) commit({ nodes: r.nodes, edges }, action, [r.groupId]);
      } else if (action === 'ungroup') {
        const groupIds = ids.filter((id) => nodes.find((n) => n.id === id)?.type === GROUP_TYPE);
        const promoted = nodes.filter((n) => n.parentId && groupIds.includes(n.parentId)).map((n) => n.id);
        const next = ungroupNodes(nodes, groupIds);
        commit({ nodes: next, edges }, action, [...ids.filter((id) => !groupIds.includes(id)), ...promoted]);
      } else {
        commit({ nodes: arrangeNodes(nodes, ids, action), edges }, action, ids);
      }
    } catch (e) {
      console.error('[kit] 选区操作失败', e);
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, sel.ids, rf, commit, idFactory]);

  const visible = !disabled && !sel.active && (sel.ids.length >= 2 || sel.hasGroup);
  // 自身尺寸用于把工具栏夹在画布可视区内（首帧量完再定位）
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.offsetWidth !== size.w || el.offsetHeight !== size.h) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  if (!visible) return null;

  const roots = selectionRoots(rf.getNodes(), sel.ids);
  const canArrange = !busy && roots.length > 1;
  const width = size.w;
  const height = size.h;
  const left = Math.max(width / 2 + 8, Math.min(sel.tx + (sel.x + sel.w / 2) * sel.zoom, sel.width - width / 2 - 8));
  const top = Math.max(height + 8, Math.min(sel.ty + sel.y * sel.zoom - 12 - (sel.hasGroup ? 30 * sel.zoom : 0), sel.height - 8));

  return (
    <div
      ref={ref}
      className="cv-card cv-selection-toolbar nodrag nopan nowheel"
      style={{ left, top }}
      role="toolbar"
      aria-label="选区操作"
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      <div className="cv-selection-toolbar__actions">
        {LAYOUTS.map((l) => (
          <ToolbarButton key={l.mode} icon={l.icon} title={l.label} size="sm" disabled={!canArrange} onClick={() => operate(l.mode)}>{l.label}</ToolbarButton>
        ))}
        <span className="cv-selection-toolbar__divider" aria-hidden />
        <ToolbarButton icon={IconCopyPlus} title="创建副本" size="sm" disabled={busy} onClick={() => operate('duplicate')}>创建副本</ToolbarButton>
        <ToolbarButton icon={IconBoxMultiple} title="成组" size="sm" disabled={busy || roots.length < 1} onClick={() => operate('group')}>成组</ToolbarButton>
        <ToolbarButton icon={IconDeselect} title="解组" size="sm" disabled={busy || !sel.hasGroup} onClick={() => operate('ungroup')}>解组</ToolbarButton>
      </div>
    </div>
  );
}
