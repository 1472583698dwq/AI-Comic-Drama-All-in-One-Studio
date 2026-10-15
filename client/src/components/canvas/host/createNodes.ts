// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 宿主的 `createNodes`（宫格切分 / 截帧 / 分离音轨 / 截取 / 变速 / 3D 导出 / 角色三视图等产物落成新节点）。
 *
 * 摆放与连线复用 kit `createNodesLocal`（K1 起已按 Toonflow 摆放）：
 * - placement 'right'（缺省）：锚点右侧 48px 一列，从锚点顶部往下排，按实测尺寸避让同层已有节点；'below' 同理横排；
 * - spec.position 是**画布绝对坐标**，锚点在分组里时新节点挂同一 parentId 并换算成相对坐标；
 * - connectFrom：锚点输出口 → 每个新节点 in；connectTo：每个新节点主输出口 → 锚点 targetHandle（缺省 in）；
 * - select:false 时不改变当前选中。
 * 宿主在这之上补：注册表缺省数据（defaultData）合并、id 生成、写入宿主自己的 nodes / edges 状态（进撤销历史）。
 */
import type { Edge, Node } from '@xyflow/react';
import { createNodesLocal, type CreateNodesOptions, type NewNodeSpec } from '../kit/hostContext';
import { createNodeData } from '../kit/registry';

/** 标题由节点按声明现算的类型：新建时不写死 label（custom → 定义名、ext-node → 插件声明名）。 */
export const COMPUTED_TITLE_TYPES: readonly string[] = Object.freeze(['custom', 'ext-node']);

/** 新节点 data = 注册表缺省数据 + 传入数据（传入优先）。 */
export function newNodeData(type: string, extra?: Record<string, unknown>): Record<string, unknown> {
  const base = createNodeData(type);
  if (COMPUTED_TITLE_TYPES.includes(type)) delete base.label;
  return { ...base, ...(extra || {}) };
}

export interface HostGraphAccess {
  getNodes: () => Node[];
  getNode: (id: string) => Node | undefined;
  setNodes: (updater: (nodes: Node[]) => Node[]) => void;
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void;
}

/** 宿主 createNodes：返回新节点 id（与 specs 同序）。 */
export function hostCreateNodes(g: HostGraphAccess, specs: NewNodeSpec[], opts: CreateNodesOptions = {}): string[] {
  if (!specs.length) return [];
  const withDefaults = specs.map((s) => ({ ...s, data: newNodeData(s.type, s.data) }));
  // createNodesLocal 只用到 getNode / getNodes / addNodes / addEdges / setNodes，这里接到宿主状态上
  const adapter = {
    getNode: (id: string) => g.getNode(id),
    getNodes: () => g.getNodes(),
    setNodes: (u: Node[] | ((n: Node[]) => Node[])) => g.setNodes((nds) => (typeof u === 'function' ? u(nds) : u)),
    addNodes: (n: Node | Node[]) => {
      const list = Array.isArray(n) ? n : [n];
      g.setNodes((nds) => [...nds, ...list]);
    },
    addEdges: (e: Edge | Edge[]) => {
      const list = Array.isArray(e) ? e : [e];
      g.setEdges((eds) => [...eds, ...list.filter((x) => !eds.some((y) => y.id === x.id))]);
    },
  };
  return createNodesLocal(adapter as unknown as Parameters<typeof createNodesLocal>[0], withDefaults, opts);
}
