// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 画布图操作纯函数：复制/副本、成组/解组、整理排列、分组贴合、拖入拖出分组。
 * 对照 Toonflow apps/web/.../canvas/{selectionToolbar.vue,selectionNodes.ts,arrangeSelection.ts}，
 * 全部输入 nodes/edges 数组、返回新数组，不碰 React Flow 实例，便于单测与宿主复用。
 */
import type { Edge, Node, XYPosition } from '@xyflow/react';

export const GROUP_TYPE = 'group';
/** 成组时分组框相对内容的留白（design §5 / Toonflow：左右 24、上 40、下 24）。 */
export const GROUP_PADDING = { left: 24, right: 24, top: 40, bottom: 24 } as const;
export const GROUP_MIN_SIZE = { width: 120, height: 80 } as const;
const ARRANGE_GAP = 80;
const COPY_GAP = 32;

type AnyNode = Node<Record<string, unknown>>;

let seq = 0;
export function defaultIdFactory(prefix = 'node'): string {
  seq += 1;
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${seq}_${rnd}`;
}

function parsePx(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 节点尺寸：measured > width/height > initialWidth/Height > style。 */
export function sizeOf(node: Node): { width: number; height: number } {
  const style = (node.style || {}) as Record<string, unknown>;
  return {
    width: node.measured?.width ?? node.width ?? node.initialWidth ?? parsePx(style.width) ?? 0,
    height: node.measured?.height ?? node.height ?? node.initialHeight ?? parsePx(style.height) ?? 0,
  };
}

function indexById<N extends Node>(nodes: readonly N[]): Map<string, N> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** 祖先链（近→远），带环保护。 */
export function ancestorsOf(node: Node, byId: Map<string, Node>): Node[] {
  const out: Node[] = [];
  const visited = new Set([node.id]);
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    out.push(parent);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return out;
}

/** 画布绝对坐标 = 自身 position + 所有祖先 position。 */
export function absolutePosition(node: Node, byId: Map<string, Node>): XYPosition {
  return ancestorsOf(node, byId).reduce((p, a) => ({ x: p.x + a.position.x, y: p.y + a.position.y }), { ...node.position });
}

export interface Rect { x: number; y: number; width: number; height: number }

export function boundsOf(nodes: readonly Node[], byId: Map<string, Node>): Rect {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) {
    const p = absolutePosition(n, byId);
    const s = sizeOf(n);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + s.width); y1 = Math.max(y1, p.y + s.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 选区的「根」：祖先未被选中的选中节点。 */
export function selectionRoots<N extends Node>(nodes: readonly N[], ids: Iterable<string>): N[] {
  const selected = new Set(ids);
  const byId = indexById(nodes as readonly Node[]);
  return nodes.filter((n) => selected.has(n.id) && !ancestorsOf(n, byId).some((a) => selected.has(a.id)));
}

/** 选区的完整子树（根 + 所有后代），父在子前。 */
export function selectionTree<N extends Node>(nodes: readonly N[], ids: Iterable<string>): N[] {
  const children = new Map<string, N[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const out: N[] = [];
  const visited = new Set<string>();
  const visit = (n: N) => {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    out.push(n);
    children.get(n.id)?.forEach(visit);
  };
  selectionRoots(nodes, ids).forEach(visit);
  return out;
}

export interface DuplicateOptions {
  /** true：带上入边（创建副本）；false：不带任何连线（复制节点）。 */
  withEdges?: boolean;
  /** 单节点复制放在原节点下方（Toonflow 节点菜单）；多选复制整体右移（Toonflow 选区工具栏）。 */
  placement?: 'below' | 'right';
  idFactory?: (prefix: string) => string;
  labelSuffix?: string;
}

export interface DuplicateResult<N extends Node = AnyNode> {
  nodes: N[];
  edges: Edge[];
  newIds: string[];
  /** 旧 id → 新 id（含子树）。 */
  idMap: Map<string, string>;
}

/** 复制节点（含分组子树）。返回追加了副本的新 nodes/edges；newIds 只含副本的根。 */
export function duplicateNodes<N extends Node>(nodes: readonly N[], edges: readonly Edge[], ids: Iterable<string>, opts: DuplicateOptions = {}): DuplicateResult<N> {
  const idFactory = opts.idFactory ?? defaultIdFactory;
  const suffix = opts.labelSuffix ?? ' - 副本';
  const tree = selectionTree(nodes, ids);
  if (!tree.length) return { nodes: [...nodes], edges: [...edges], newIds: [], idMap: new Map() };
  const byId = indexById(nodes as readonly Node[]);
  const roots = selectionRoots(tree, tree.map((n) => n.id));
  const rootIds = new Set(roots.map((n) => n.id));
  const idMap = new Map(tree.map((n) => [n.id, idFactory(n.type || 'node')]));
  const placement = opts.placement ?? (roots.length === 1 ? 'below' : 'right');

  const offsets = new Map<string, XYPosition>();
  if (placement === 'below' && roots.length === 1) {
    // Toonflow：放在原节点正下方，与同列兄弟节点重叠时继续下移
    const root = roots[0];
    const size = sizeOf(root);
    const pos = { x: root.position.x, y: root.position.y + size.height + COPY_GAP };
    const column = nodes
      .filter((n) => n.parentId === root.parentId && n.id !== root.id && n.position.x < pos.x + size.width && n.position.x + sizeOf(n).width > pos.x)
      .sort((a, b) => a.position.y - b.position.y);
    for (const n of column) {
      const h = sizeOf(n).height;
      if (pos.y < n.position.y + h + COPY_GAP && pos.y + size.height + COPY_GAP > n.position.y) pos.y = n.position.y + h + COPY_GAP;
    }
    offsets.set(root.id, pos);
  } else {
    const b = boundsOf(roots, byId);
    for (const r of roots) offsets.set(r.id, { x: r.position.x + b.width + 64, y: r.position.y });
  }

  const copies = tree.map((n) => {
    const clone = JSON.parse(JSON.stringify({ ...n, data: n.data })) as N;
    delete (clone as Partial<Node>).measured;
    delete (clone as Partial<Node>).dragging;
    clone.id = idMap.get(n.id)!;
    clone.selected = false;
    if (n.parentId) clone.parentId = idMap.get(n.parentId) ?? n.parentId;
    if (rootIds.has(n.id)) {
      clone.position = offsets.get(n.id) ?? { ...n.position };
      const label = (n.data as Record<string, unknown>)?.label;
      clone.data = { ...(clone.data as Record<string, unknown>), label: `${typeof label === 'string' && label ? label : '未命名节点'}${suffix}` } as N['data'];
    }
    return clone;
  });

  const newEdges: Edge[] = opts.withEdges
    ? edges
      .filter((e) => idMap.has(e.target) && (idMap.has(e.source) || byId.has(e.source)))
      .map((e) => ({
        ...JSON.parse(JSON.stringify(e)),
        id: idFactory('edge'),
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target)!,
        selected: false,
      }))
    : [];

  return {
    nodes: [...nodes, ...copies],
    edges: [...edges, ...newEdges],
    newIds: roots.map((r) => idMap.get(r.id)!),
    idMap,
  };
}

export interface GroupOptions {
  idFactory?: (prefix: string) => string;
  label?: string;
  type?: string;
}

/**
 * 成组：新建分组节点包住选区的根节点（留白 L/R 24、T 40、B 24），根节点 parentId 指向分组、坐标改为相对分组，
 * 不设 extent（可拖出分组）。分组插在第一个子节点之前（React Flow 要求父在子前）。
 */
export function groupNodes<N extends Node>(nodes: readonly N[], ids: Iterable<string>, opts: GroupOptions = {}): { nodes: N[]; groupId?: string } {
  const roots = selectionRoots(nodes, ids);
  if (!roots.length) return { nodes: [...nodes] };
  const byId = indexById(nodes as readonly Node[]);
  const b = boundsOf(roots, byId);
  const parentId = roots.every((n) => n.parentId === roots[0].parentId) ? roots[0].parentId : undefined;
  const parent = parentId ? byId.get(parentId) : undefined;
  const parentAbs = parent ? absolutePosition(parent, byId) : { x: 0, y: 0 };
  const abs = { x: b.x - GROUP_PADDING.left, y: b.y - GROUP_PADDING.top };
  const width = b.width + GROUP_PADDING.left + GROUP_PADDING.right;
  const height = b.height + GROUP_PADDING.top + GROUP_PADDING.bottom;
  const groupId = (opts.idFactory ?? defaultIdFactory)('group');
  const group = {
    id: groupId,
    type: opts.type ?? GROUP_TYPE,
    position: { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y },
    width,
    height,
    style: { width, height },
    data: { label: opts.label ?? '分组' },
    ...(parentId ? { parentId } : {}),
    selected: false,
  } as unknown as N;
  const rootIds = new Set(roots.map((r) => r.id));
  const next: N[] = nodes.map((n) => {
    if (!rootIds.has(n.id)) return n;
    const p = absolutePosition(n, byId);
    const moved = { ...n, parentId: groupId, position: { x: p.x - abs.x, y: p.y - abs.y }, selected: false };
    delete (moved as Partial<Node>).extent;
    delete (moved as Partial<Node>).expandParent;
    return moved;
  });
  const firstChild = next.findIndex((n) => rootIds.has(n.id));
  next.splice(firstChild < 0 ? next.length : firstChild, 0, group);
  return { nodes: next, groupId };
}

/** 解组：移除分组节点，子节点提升到分组的上一级（跳过同样被解散的祖先分组），保持画布绝对位置。 */
export function ungroupNodes<N extends Node>(nodes: readonly N[], groupIds: Iterable<string>, groupType = GROUP_TYPE): N[] {
  const byId = indexById(nodes as readonly Node[]);
  const groups = new Set([...groupIds].filter((id) => byId.get(id)?.type === groupType));
  if (!groups.size) return [...nodes];
  return nodes
    .filter((n) => !groups.has(n.id))
    .map((n) => {
      if (!n.parentId || !groups.has(n.parentId)) return n;
      let parentId: string | undefined = n.parentId;
      const visited = new Set<string>();
      while (parentId && groups.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      const parent = parentId ? byId.get(parentId) : undefined;
      const parentAbs = parent ? absolutePosition(parent, byId) : { x: 0, y: 0 };
      const abs = absolutePosition(n, byId);
      const out = { ...n, position: { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y } } as N;
      if (parent) out.parentId = parent.id;
      else delete (out as Partial<Node>).parentId;
      delete (out as Partial<Node>).extent;
      return out;
    });
}

/** 让分组框贴合子节点（留白同成组）；子节点尺寸未测量时跳过该组。 */
export function fitGroupBounds<N extends Node>(nodes: readonly N[], groupIds: Iterable<string>): N[] {
  const wanted = new Set(groupIds);
  if (!wanted.size) return [...nodes];
  let next = [...nodes];
  // 深层分组先贴合，外层再按新尺寸贴合
  const order = selectionTree(next, wanted).reverse().filter((n) => wanted.has(n.id));
  for (const group of order) {
    const children = next.filter((n) => n.parentId === group.id);
    if (!children.length || children.some((n) => !sizeOf(n).width || !sizeOf(n).height)) continue;
    const left = Math.min(...children.map((n) => n.position.x)) - GROUP_PADDING.left;
    const top = Math.min(...children.map((n) => n.position.y)) - GROUP_PADDING.top;
    const width = Math.max(...children.map((n) => n.position.x + sizeOf(n).width)) - left + GROUP_PADDING.right;
    const height = Math.max(...children.map((n) => n.position.y + sizeOf(n).height)) - top + GROUP_PADDING.bottom;
    next = next.map((n) => {
      if (n.id === group.id) {
        return { ...n, position: { x: n.position.x + left, y: n.position.y + top }, width, height, style: { ...(n.style || {}), width, height } };
      }
      if (n.parentId === group.id && (left || top)) return { ...n, position: { x: n.position.x - left, y: n.position.y - top } };
      return n;
    });
  }
  return next;
}

export type ArrangeMode = 'horizontal' | 'vertical' | 'grid';

/** 整理选中节点（Toonflow arrangeSelection）：水平 / 垂直 / 宫格，间距 80，完成后贴合受影响分组。 */
export function arrangeNodes<N extends Node>(nodes: readonly N[], ids: Iterable<string>, mode: ArrangeMode): N[] {
  const roots = selectionRoots(nodes, ids);
  if (roots.length < 2) return [...nodes];
  const byId = indexById(nodes as readonly Node[]);
  const affected = new Set<string>();
  const items = roots.map((node) => {
    const ancestors = ancestorsOf(node, byId);
    ancestors.filter((a) => a.type === GROUP_TYPE).forEach((a) => affected.add(a.id));
    const parentAbs = ancestors.reduce((p, a) => ({ x: p.x + a.position.x, y: p.y + a.position.y }), { x: 0, y: 0 });
    return { node, size: sizeOf(node), abs: { x: node.position.x + parentAbs.x, y: node.position.y + parentAbs.y }, parentAbs };
  });
  if (items.some((i) => !i.size.width || !i.size.height)) return [...nodes];
  items.sort((a, b) => (mode === 'horizontal' ? a.abs.x - b.abs.x || a.abs.y - b.abs.y : a.abs.y - b.abs.y || a.abs.x - b.abs.x));
  const origin = { x: Math.min(...items.map((i) => i.abs.x)), y: Math.min(...items.map((i) => i.abs.y)) };
  const columns = mode === 'horizontal' ? items.length : mode === 'vertical' ? 1 : Math.ceil(Math.sqrt(items.length));
  const colW = Array<number>(columns).fill(0);
  const rowH = Array<number>(Math.ceil(items.length / columns)).fill(0);
  items.forEach(({ size }, i) => {
    colW[i % columns] = Math.max(colW[i % columns], size.width);
    rowH[Math.floor(i / columns)] = Math.max(rowH[Math.floor(i / columns)], size.height);
  });
  const colX: number[] = [];
  colW.reduce((x, w, i) => { colX[i] = x; return x + w + ARRANGE_GAP; }, origin.x);
  const rowY: number[] = [];
  rowH.reduce((y, h, i) => { rowY[i] = y; return y + h + ARRANGE_GAP; }, origin.y);
  const positions = new Map<string, XYPosition>();
  items.forEach(({ node, size, parentAbs }, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    positions.set(node.id, {
      x: colX[c] + (mode === 'vertical' ? (colW[c] - size.width) / 2 : 0) - parentAbs.x,
      y: rowY[r] + (mode === 'horizontal' ? (rowH[r] - size.height) / 2 : 0) - parentAbs.y,
    });
  });
  const moved = nodes.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n));
  return fitGroupBounds(moved, affected);
}

/**
 * 拖动结束后按相交关系重新归组（Toonflow finishGroupDrag）：拖进分组成为其子节点、拖出分组则脱离，
 * 并贴合受影响的分组。宿主在 onNodeDragStop 里调用。
 */
export function reparentOnDrop<N extends Node>(nodes: readonly N[], draggedIds: Iterable<string>): N[] {
  const byId = indexById(nodes as readonly Node[]);
  const rect = (n: Node) => ({ ...absolutePosition(n, byId), ...sizeOf(n), depth: ancestorsOf(n, byId).length });
  const rects = new Map(nodes.map((n) => [n.id, rect(n)]));
  const groups = nodes
    .filter((n) => n.type === GROUP_TYPE && !n.hidden)
    .sort((a, b) => {
      const ra = rects.get(a.id)!; const rb = rects.get(b.id)!;
      return rb.depth - ra.depth || ra.width * ra.height - rb.width * rb.height;
    });
  const intersects = (a: Node, b: Node) => {
    const x = rects.get(a.id)!; const y = rects.get(b.id)!;
    return x.width > 0 && x.height > 0 && y.width > 0 && y.height > 0
      && x.x < y.x + y.width && x.x + x.width > y.x && x.y < y.y + y.height && x.y + x.height > y.y;
  };
  const affected = new Set<string>();
  const changes = new Map<string, { parentId?: string; position: XYPosition }>();
  for (const node of selectionRoots(nodes, draggedIds)) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    ancestorsOf(node, byId).filter((a) => a.type === GROUP_TYPE).forEach((a) => affected.add(a.id));
    const r = rects.get(node.id)!;
    if (!r.width || !r.height) continue;
    const retains = parent?.type === GROUP_TYPE && intersects(node, parent);
    const target = groups.find((g) => {
      const gAnc = ancestorsOf(g, byId);
      return g.id !== node.id && intersects(node, g) && !gAnc.some((a) => a.id === node.id) && (!retains || gAnc.some((a) => a.id === parent!.id));
    }) ?? (retains ? parent : undefined);
    if (target === parent || (!target && parent?.type !== GROUP_TYPE)) continue;
    const pr = target ? rects.get(target.id)! : { x: 0, y: 0 };
    changes.set(node.id, { parentId: target?.id, position: { x: r.x - pr.x, y: r.y - pr.y } });
    if (target) {
      affected.add(target.id);
      ancestorsOf(target, byId).filter((a) => a.type === GROUP_TYPE).forEach((a) => affected.add(a.id));
    }
  }
  let next = nodes.map((n) => {
    const c = changes.get(n.id);
    if (!c) return n;
    const out = { ...n, position: c.position } as N;
    if (c.parentId) out.parentId = c.parentId;
    else delete (out as Partial<Node>).parentId;
    delete (out as Partial<Node>).extent;
    delete (out as Partial<Node>).expandParent;
    return out;
  });
  if (changes.size) {
    // 父在子前：按树重排
    next = selectionTree(next, next.filter((n) => !n.parentId || !next.some((m) => m.id === n.parentId)).map((n) => n.id));
  }
  return fitGroupBounds(next, affected);
}
