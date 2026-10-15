// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 画布宿主上下文：节点外壳需要的宿主能力（保存到素材库、复制、删除、改名、全屏…）
 * 都由宿主（CreativeCanvas，H1 集成时提供）通过这里注入，节点组件不直接依赖 CreativeCanvas。
 * 宿主未提供的能力回落到 React Flow 实例上的等价操作。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { duplicateNodes } from './graphOps';

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
}

export interface NewNodeSpec {
  type: string;
  data: Record<string, unknown>;
  /** 绝对坐标；缺省按 placement 自动排布 */
  position?: { x: number; y: number };
}

export interface CreateNodesOptions {
  /** 发起节点（自动排布的锚点） */
  anchorId?: string;
  /** 'right'（默认，横向排在锚点右侧）| 'below'（排在锚点下方） */
  placement?: 'right' | 'below';
  /** 从锚点的哪个输出口连到每个新节点的 in（不连则不传） */
  connectFrom?: { nodeId: string; sourceHandle: string; targetHandle?: string };
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
  return useMemo<KitNodeActions>(() => {
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
      canSaveToAssets: !!host.saveToAssets && (host.canSaveToAssets ? host.canSaveToAssets(nodeId) : true),
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
}


/** createNodes 的缺省实现：按锚点排布 + 可选连线（宿主没接管时用）。 */
export function createNodesLocal(
  rf: Pick<ReturnType<typeof useReactFlow>, 'getNode' | 'addNodes' | 'addEdges' | 'setNodes'>,
  specs: NewNodeSpec[],
  opts: CreateNodesOptions = {},
): string[] {
  const anchor = opts.anchorId ? (rf.getNode(opts.anchorId) as Node | undefined) : undefined;
  const aw = (anchor?.measured?.width ?? anchor?.width ?? 240) as number;
  const ah = (anchor?.measured?.height ?? anchor?.height ?? 240) as number;
  const base = anchor?.position ?? { x: 0, y: 0 };
  const gap = 48;
  const ids: string[] = [];
  const nodes: Node[] = specs.map((spec, i) => {
    const id = `${spec.type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${i}`;
    ids.push(id);
    const position =
      spec.position ??
      (opts.placement === 'below'
        ? { x: base.x + i * (aw + gap), y: base.y + ah + gap }
        : { x: base.x + aw + gap, y: base.y + i * (ah + gap) });
    return {
      id,
      type: spec.type,
      position,
      parentId: anchor?.parentId,
      data: spec.data,
      selected: opts.select !== false,
    } as Node;
  });
  if (opts.select !== false) rf.setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  rf.addNodes(nodes);
  if (opts.connectFrom) {
    const { nodeId, sourceHandle, targetHandle } = opts.connectFrom;
    rf.addEdges(
      ids.map((id) => ({
        id: `e_${nodeId}_${sourceHandle}_${id}`,
        source: nodeId,
        sourceHandle,
        target: id,
        targetHandle: targetHandle ?? 'in',
      })),
    );
  }
  return ids;
}
