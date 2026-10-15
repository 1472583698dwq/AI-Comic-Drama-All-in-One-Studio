// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 一键模板 / Creator 模板 → 新节点数据模型（纯函数）。
 * 生成类节点只有一个输入口 `in`：连线一律连到 `in`，需要固定落位的（首帧 / 尾帧）写进目标 `data.refRoles`，
 * 顺序写进 `data.refOrder`（edgeKey = `source|sourceHandle`），与迁移 / 后端 inputs.py 同口径。
 */
import type { Edge, Node } from '@xyflow/react';
import { IN_PORT_NODE_TYPES, NEW_IN_PORT, PRIMARY_OUTPUT_PORT, edgeKey } from '../migrate';
import type { Slot } from '../kit/types';

export interface CanvasTemplate {
  id: string;
  label: string;
  desc: string;
  nodes: string[];
  /** 连线：[源下标, 目标下标, 目标槽位?] */
  links: Array<[number, number, Slot?]>;
  /** 节点额外数据（按下标） */
  data?: Record<number, Record<string, unknown>>;
}

export const TEMPLATES: CanvasTemplate[] = [
  {
    id: 't1', label: '剧本 → 生图 → 视频', desc: '漫剧创作标准链路',
    nodes: ['prompt', 'image', 'video'],
    links: [[0, 1], [1, 2, 'first_frame']],
  },
  {
    id: 't2', label: '完整漫剧导演流', desc: '剧本 → 画面 → 视频 → 配音 → 导出',
    nodes: ['prompt', 'image', 'video', 'audio', 'export'],
    links: [[0, 1], [1, 2, 'first_frame'], [0, 3], [3, 4], [2, 4]],
  },
  {
    id: 't3', label: '连续镜头视频流', desc: '首帧 + 尾帧 → 连续动态视频',
    nodes: ['image', 'image', 'video'],
    links: [[0, 2, 'first_frame'], [1, 2, 'last_frame']],
    data: { 0: { label: '首帧' }, 1: { label: '尾帧' }, 2: { mode: 'startEnd' } },
  },
];

type MakeNode = (type: string, position: { x: number; y: number }, data?: Record<string, unknown>) => Node;

/** 源节点主输出口（注册表 / 迁移同表）；未知类型返回 null（旧边语义：落到第一个口）。 */
export function primaryOut(type: string | undefined): string | null {
  return (type && PRIMARY_OUTPUT_PORT[type]) || null;
}

/** 非 in 口目标（export / timeline）的输入口：按源类型选 video / audio。 */
function legacyTargetHandle(targetType: string, sourceType: string): string | null {
  if (targetType === 'export' || targetType === 'timeline') {
    if (sourceType === 'audio' || sourceType === 'load-audio') return 'audio';
    if (sourceType === 'video' || sourceType === 'load-video') return 'video';
    return null;
  }
  return null;
}

/**
 * 在一组新节点之间按新模型连线：目标是 in 口节点 → `in` + refRoles/refOrder；目标是 export / timeline → 按媒体口。
 * 返回连线，并直接改写目标节点 data（refRoles / refOrder）。不合法的组合（如 视频 → 音频）跳过。
 */
export function linkNodes(nodes: Node[], links: Array<[string, string, Slot?]>): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: Edge[] = [];
  for (const [sid, tid, slot] of links) {
    const s = byId.get(sid);
    const t = byId.get(tid);
    if (!s || !t) continue;
    const sh = primaryOut(s.type);
    if (!sh) continue;
    let th: string | null;
    if (t.type && IN_PORT_NODE_TYPES.includes(t.type)) {
      // 音频生成只接 文本 / 图片 / 音频，不接视频
      if (t.type === 'audio' && (s.type === 'video' || s.type === 'load-video')) continue;
      th = NEW_IN_PORT;
      const key = edgeKey(s.id, sh);
      const d = (t.data || {}) as Record<string, unknown>;
      const order = Array.isArray(d.refOrder) ? (d.refOrder as string[]) : [];
      const roles = (d.refRoles && typeof d.refRoles === 'object' ? d.refRoles : {}) as Record<string, string>;
      t.data = {
        ...d,
        refOrder: order.includes(key) ? order : [...order, key],
        refRoles: slot ? { ...roles, [key]: slot } : roles,
      };
    } else {
      th = legacyTargetHandle(t.type || '', s.type || '');
      if (!th) continue;
    }
    edges.push({ id: `e_${s.id}_${sh}_${t.id}_${th}`, source: s.id, sourceHandle: sh, target: t.id, targetHandle: th } as Edge);
  }
  return edges;
}

/** 内置模板 → 节点（组内横向排开，列间距 120；整组位置由宿主 placeNewBlock 决定）与连线。 */
export function buildTemplate(tpl: CanvasTemplate, makeNode: MakeNode, widthOf: (type: string) => number): { nodes: Node[]; edges: Edge[] } {
  let x = 0;
  const nodes = tpl.nodes.map((type, i) => {
    const n = makeNode(type, { x, y: 0 }, tpl.data?.[i]);
    x += widthOf(type) + 120;
    return n;
  });
  const edges = linkNodes(nodes, tpl.links.map(([a, b, slot]) => [nodes[a].id, nodes[b].id, slot] as [string, string, Slot?]));
  return { nodes, edges };
}

/** Creator 模板（Agent 创造模式产物）键 → 节点类型。 */
export const CREATOR_KEY_TYPES: Record<string, string> = {
  image: 'image', video: 'video', audio: 'audio',
  prompt: 'prompt', text: 'prompt',
  director: 'director3d', director3d: 'director3d', export: 'export',
};

/** Creator 模板 → 节点与连线（未知节点键跳过；图片 → 视频按旧约定落首帧）。 */
export function buildCreatorTemplate(tpl: { nodes?: any[]; edges?: any[] }, makeNode: MakeNode): { nodes: Node[]; edges: Edge[] } {
  const idByKey: Record<string, string> = {};
  const nodes: Node[] = [];
  for (const n of tpl.nodes || []) {
    const key = String(n?.key || '');
    const type = CREATOR_KEY_TYPES[key];
    if (!type) continue;
    const node = makeNode(type, { x: Number(n.x) || 0, y: Number(n.y) || 0 });
    idByKey[key] = node.id;
    nodes.push(node);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: Array<[string, string, Slot?]> = [];
  for (const e of tpl.edges || []) {
    const sid = idByKey[String(e?.from || '')];
    const tid = idByKey[String(e?.to || '')];
    if (!sid || !tid) continue;
    const st = byId.get(sid)?.type;
    const tt = byId.get(tid)?.type;
    links.push([sid, tid, st === 'image' && tt === 'video' ? 'first_frame' : undefined]);
  }
  return { nodes, edges: linkNodes(nodes, links) };
}
