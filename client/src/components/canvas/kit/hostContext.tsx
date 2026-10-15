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
    };
  }, [host, rf, nodeId]);
}
