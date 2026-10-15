// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 画布宿主上下文：节点外壳需要的宿主能力（保存到素材库、复制、删除、改名、全屏…）
 * 都由宿主（CreativeCanvas，H1 集成时提供）通过这里注入，节点组件不直接依赖 CreativeCanvas。
 * 宿主未提供的能力回落到 React Flow 实例上的等价操作。
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useReactFlow, useStore, type Edge, type Node, type ReactFlowState, type XYPosition } from '@xyflow/react';
import { duplicateNodes, sizeOf } from './graphOps';
import { getNodeDef } from './registry';
import { PRIMARY_OUTPUT_PORT } from './inputRules';
import type { MenuItemSpec } from './ui/Popover';

export type MediaKind = 'image' | 'video' | 'audio';

export interface CanvasHost {
  /** 写节点数据（宿主一般会顺带向下游传播），缺省用 React Flow updateNodeData。 */
  updateNodeData?: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 保存节点产出到素材库；不提供则菜单/工具栏隐藏该项。 */
  saveToAssets?: (nodeId: string) => void | Promise<void>;
  /** 节点是否有可保存的产出（缺省：有 saveToAssets 即可点）。 */
  canSaveToAssets?: (nodeId: string) => boolean;
  /** 「复制节点」：复制一个不带连线的副本。 */
  copy?: (nodeId: string) => void;
  /** 「创建副本」：复制并带上入边。 */
  duplicate?: (nodeId: string) => void;
  remove?: (nodeId: string) => void | Promise<void>;
  rename?: (nodeId: string, label: string) => void;
  /** 标题栏「刷新」按钮；不提供则按钮置灰。 */
  refresh?: (nodeId: string) => void | Promise<void>;
  /** 全屏预览媒体。 */
  openFullscreen?: (payload: { nodeId: string; url: string; kind?: MediaKind }) => void;
  removeEdge?: (edgeId: string) => void;
  // REQ-toonflow-canvas W2 约定：以下能力由 H1 宿主提供，节点只通过 useKitNodeActions 调用
  /**
   * 宿主执行：走宿主原有分支（文本技能 parseScript/split_novel_script/扩写、director3d 的
   * director_3d_stage_plan、custom 代码节点、ext-node 等）。媒体生成节点请直接用 kit/useGeneration。
   * overrides 作为本次执行的数据覆盖（同旧 data.onExecute 的 customData）。
   */
  execute?: (nodeId: string, overrides?: Record<string, unknown>) => Promise<void> | void;
  /**
   * 新建节点（宫格切分 / 截帧 / 分离音轨 / 截取 / 变速 / 3D 导出等产物落成新节点）。
   * connectFrom：从当前节点某输出口连到新节点的 in；placement：相对源节点的摆放方向。
   * 返回新节点 id。缺省回落：React Flow addNodes/addEdges，按网格横向/纵向排布。
   */
  createNodes?: (specs: NewNodeSpec[], opts?: CreateNodesOptions) => string[];
  /** 跳转应用内页面（如 director3d「在 3D 片场打开」→ navigate('director3d', {shotId})）。 */
  navigate?: (tab: string, payload?: Record<string, unknown>) => void;
  /** 当前项目 id（媒体接口 / 备份 / 素材库需要）。 */
  projectId?: string;
  /**
   * REQ-toonflow-canvas H1：宿主追加到节点右键菜单的项（排在节点自己的 menuItems 之后，如「添加到会话」「回写到分镜」）。
   * 打开菜单时才调用；返回空数组即不追加。
   */
  contextMenuItems?: (nodeId: string) => MenuItemSpec[];
}

export interface NewNodeSpec {
  type: string;
  data: Record<string, unknown>;
  /**
   * 画布**绝对**坐标（flow 坐标系，与 screenToFlowPosition 同系）；缺省按 placement 自动排布。
   * K1：锚点在分组里时新节点挂同一个 parentId，宿主 / createNodesLocal 负责换算成相对分组的坐标。
   */
  position?: { x: number; y: number };
}

export interface CreateNodesOptions {
  /** 发起节点（自动排布的锚点） */
  anchorId?: string;
  /** 'right'（默认，横向排在锚点右侧）| 'below'（排在锚点下方） */
  placement?: 'right' | 'below';
  /** 从锚点的哪个输出口连到每个新节点的 in（不连则不传） */
  connectFrom?: { nodeId: string; sourceHandle: string; targetHandle?: string };
  /**
   * K1：反向连线——把每个**新节点**的主输出口连到锚点（当前节点）的 targetHandle（缺省 `in`），
   * 如图片节点「角色一致性」把新建的参考图节点接进自己。sourceHandle 缺省取新节点注册表的第一个 source 口
   * （没有注册则 PRIMARY_OUTPUT_PORT[type]）。
   */
  connectTo?: { targetHandle?: string; sourceHandle?: string };
  /** 是否选中新节点（默认 true） */
  select?: boolean;
}

export const CanvasHostContext = createContext<CanvasHost>({});

export function CanvasHostProvider({ value, children }: { value: CanvasHost; children: ReactNode }) {
  return <CanvasHostContext.Provider value={value}>{children}</CanvasHostContext.Provider>;
}

export function useCanvasHost(): CanvasHost {
  return useContext(CanvasHostContext);
}

export interface KitNodeActions {
  update: (patch: Record<string, unknown>) => void;
  rename: (label: string) => void;
  remove: () => void | Promise<void>;
  copy: () => void;
  duplicate: () => void;
  removeEdge: (edgeId: string) => void;
  saveToAssets?: () => void | Promise<void>;
  canSaveToAssets: boolean;
  refresh?: () => void | Promise<void>;
  openFullscreen: (url: string, kind?: MediaKind) => void;
  /** 宿主执行（见 CanvasHost.execute）；缺省回落旧的 data.onExecute */
  execute: (overrides?: Record<string, unknown>) => Promise<void>;
  /** 新建节点并可从本节点连线（见 CanvasHost.createNodes） */
  createNodes: (specs: NewNodeSpec[], opts?: Omit<CreateNodesOptions, 'anchorId'>) => string[];
  navigate?: (tab: string, payload?: Record<string, unknown>) => void;
  projectId?: string;
}

/** 节点内统一的动作入口：宿主优先，缺省回落 React Flow。 */
export function useKitNodeActions(nodeId: string): KitNodeActions {
  const host = useCanvasHost();
  const rf = useReactFlow();
  // K1：订阅本节点 data，产出变化（如刚生成了图）后重新求 canSaveToAssets；其余动作对象保持稳定引用
  useStore(useCallback((s: ReactFlowState) => s.nodeLookup.get(nodeId)?.data, [nodeId]));
  const canSaveToAssets = !!host.saveToAssets && (host.canSaveToAssets ? host.canSaveToAssets(nodeId) : true);
  const base = useMemo<Omit<KitNodeActions, 'canSaveToAssets'>>(() => {
    const update = (patch: Record<string, unknown>) => {
      if (host.updateNodeData) host.updateNodeData(nodeId, patch);
      else rf.updateNodeData(nodeId, patch);
    };
    const copyLocal = (withEdges: boolean) => {
      const nodes = rf.getNodes() as Node[];
      const edges = rf.getEdges() as Edge[];
      const res = duplicateNodes(nodes, edges, [nodeId], { withEdges, placement: 'below' });
      if (!res.newIds.length) return;
      rf.setNodes(res.nodes.map((n) => ({ ...n, selected: res.newIds.includes(n.id) })));
      rf.setEdges(res.edges);
    };
    return {
      update,
      rename: (label: string) => {
        const v = label.trim();
        if (!v) return;
        if (host.rename) host.rename(nodeId, v);
        else update({ label: v });
      },
      remove: () => (host.remove ? host.remove(nodeId) : void rf.deleteElements({ nodes: [{ id: nodeId }] })),
      copy: () => (host.copy ? host.copy(nodeId) : copyLocal(false)),
      duplicate: () => (host.duplicate ? host.duplicate(nodeId) : copyLocal(true)),
      removeEdge: (edgeId: string) => (host.removeEdge ? host.removeEdge(edgeId) : void rf.deleteElements({ edges: [{ id: edgeId }] })),
      saveToAssets: host.saveToAssets ? () => host.saveToAssets!(nodeId) : undefined,
      refresh: host.refresh ? () => host.refresh!(nodeId) : undefined,
      openFullscreen: (url: string, kind?: MediaKind) => {
        if (host.openFullscreen) host.openFullscreen({ nodeId, url, kind });
        else if (url) window.open(url, '_blank', 'noopener');
      },
      execute: async (overrides?: Record<string, unknown>) => {
        if (host.execute) return void (await host.execute(nodeId, overrides));
        const node = rf.getNode(nodeId) as Node | undefined;
        const legacy = (node?.data as Record<string, unknown> | undefined)?.onExecute as
          | ((id: string, custom?: Record<string, unknown>) => unknown)
          | undefined;
        if (typeof legacy !== 'function') throw new Error('宿主未提供执行能力');
        await legacy(nodeId, overrides);
      },
      createNodes: (specs: NewNodeSpec[], opts?: Omit<CreateNodesOptions, 'anchorId'>) => {
        if (host.createNodes) return host.createNodes(specs, { ...opts, anchorId: nodeId });
        return createNodesLocal(rf, specs, { ...opts, anchorId: nodeId });
      },
      navigate: host.navigate,
      projectId: host.projectId,
    };
  }, [host, rf, nodeId]);
  return useMemo<KitNodeActions>(() => ({ ...base, canSaveToAssets }), [base, canSaveToAssets]);
}


type LocalRf = Pick<ReturnType<typeof useReactFlow>, 'getNode' | 'addNodes' | 'addEdges' | 'setNodes'>
  & Partial<Pick<ReturnType<typeof useReactFlow>, 'getNodes'>>;

/** 新节点在自动排布时的估计尺寸（还没渲染、没有测量值）。 */
const NEW_NODE_FALLBACK = { width: 220, height: 200 };
const PLACE_GAP = 48;

function measured(n: Node | undefined, fallback = NEW_NODE_FALLBACK): { width: number; height: number } {
  const s = n ? sizeOf(n) : { width: 0, height: 0 };
  return { width: s.width || fallback.width, height: s.height || fallback.height };
}

/** 节点的画布绝对坐标（沿 parentId 链累加，带环保护）。 */
function absoluteOf(rf: Pick<LocalRf, 'getNode'>, id: string | undefined): XYPosition {
  const p = { x: 0, y: 0 };
  const seen = new Set<string>();
  let n = id ? (rf.getNode(id) as Node | undefined) : undefined;
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    p.x += n.position.x;
    p.y += n.position.y;
    n = n.parentId ? (rf.getNode(n.parentId) as Node | undefined) : undefined;
  }
  return p;
}

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 新节点的主输出口：注册表第一个 source 口，其次 PRIMARY_OUTPUT_PORT。 */
function primaryOutputOf(type: string): string | undefined {
  return getNodeDef(type)?.ports.find((p) => p.type === 'source')?.id ?? PRIMARY_OUTPUT_PORT[type];
}

/**
 * createNodes 的缺省实现（宿主没接管时用）。K1 起按 Toonflow 摆放：
 * - placement 'right'（缺省）：锚点右侧 48px 一列，从锚点顶部往下排，碰到同层已有节点（按测量尺寸）就挪到它下方 +48；
 * - placement 'below'：锚点下方 48px 一行，从锚点左侧往右排，碰到已有节点就挪到它右侧 +48；
 * - spec.position 是画布绝对坐标：锚点在分组里时换算成相对分组的坐标（新节点与锚点同一 parentId）；
 * - connectFrom：锚点某输出口 → 每个新节点的 in；connectTo：每个新节点主输出口 → 锚点 targetHandle（缺省 in）。
 * rf 可选提供 getNodes（用于避让已有节点；没有时只在新节点之间避让）。
 */
export function createNodesLocal(
  rf: LocalRf,
  specs: NewNodeSpec[],
  opts: CreateNodesOptions = {},
): string[] {
  const anchor = opts.anchorId ? (rf.getNode(opts.anchorId) as Node | undefined) : undefined;
  const parentId = anchor?.parentId;
  const parentAbs = parentId ? absoluteOf(rf, parentId) : { x: 0, y: 0 };
  const a = measured(anchor, { width: 240, height: 240 });
  const base = anchor?.position ?? { x: 0, y: 0 };
  // 同层（相对同一父节点）的已有节点，用于避让
  const occupied: Rect[] = (rf.getNodes?.() ?? [])
    .filter((n) => n.id !== anchor?.id && (n.parentId ?? undefined) === parentId)
    .map((n) => { const s = measured(n as Node); return { x: n.position.x, y: n.position.y, w: s.width, h: s.height }; });
  const place = (start: Rect, axis: 'x' | 'y'): Rect => {
    const r = { ...start };
    for (let guard = 0; guard < 200; guard++) {
      const hit = occupied.find((o) => overlaps(r, o));
      if (!hit) break;
      if (axis === 'y') r.y = hit.y + hit.h + PLACE_GAP;
      else r.x = hit.x + hit.w + PLACE_GAP;
    }
    return r;
  };
  let cursor = opts.placement === 'below' ? base.x : base.y;

  const ids: string[] = [];
  const nodes: Node[] = specs.map((spec, i) => {
    const id = `${spec.type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${i}`;
    ids.push(id);
    const est = { width: getNodeDef(spec.type)?.width ?? NEW_NODE_FALLBACK.width, height: a.height || NEW_NODE_FALLBACK.height };
    let position: XYPosition;
    if (spec.position) {
      position = { x: spec.position.x - parentAbs.x, y: spec.position.y - parentAbs.y };
      occupied.push({ ...position, w: est.width, h: est.height });
    } else if (opts.placement === 'below') {
      const r = place({ x: cursor, y: base.y + a.height + PLACE_GAP, w: est.width, h: est.height }, 'x');
      position = { x: r.x, y: r.y };
      occupied.push(r);
      cursor = r.x + r.w + PLACE_GAP;
    } else {
      const r = place({ x: base.x + a.width + PLACE_GAP, y: cursor, w: est.width, h: est.height }, 'y');
      position = { x: r.x, y: r.y };
      occupied.push(r);
      cursor = r.y + r.h + PLACE_GAP;
    }
    return {
      id,
      type: spec.type,
      position,
      parentId,
      data: spec.data,
      selected: opts.select !== false,
    } as Node;
  });
  if (opts.select !== false) rf.setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  rf.addNodes(nodes);
  const edges: Edge[] = [];
  if (opts.connectFrom) {
    const { nodeId, sourceHandle, targetHandle } = opts.connectFrom;
    edges.push(...ids.map((id) => ({
      id: `e_${nodeId}_${sourceHandle}_${id}`,
      source: nodeId,
      sourceHandle,
      target: id,
      targetHandle: targetHandle ?? 'in',
    })));
  }
  if (opts.connectTo && opts.anchorId) {
    const targetHandle = opts.connectTo.targetHandle ?? 'in';
    specs.forEach((spec, i) => {
      const sourceHandle = opts.connectTo!.sourceHandle ?? primaryOutputOf(spec.type);
      if (!sourceHandle) return;
      edges.push({ id: `e_${ids[i]}_${sourceHandle}_${opts.anchorId}`, source: ids[i], sourceHandle, target: opts.anchorId!, targetHandle });
    });
  }
  if (edges.length) rf.addEdges(edges);
  return ids;
}
