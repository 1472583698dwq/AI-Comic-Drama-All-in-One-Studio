// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 参考列表的纯函数部分（对照 Toonflow useNodeReferences.ts / values.ts）。
 * 规则与后端 `server/app/canvas/inputs.py` 的 R1（哪些边算参考）/ R2（顺序）/ R3（类型与取值）一致；
 * 上游值读取集中在 readOutputValue 一处。
 */
import type { Edge, Node } from '@xyflow/react';
import { getNodeDef } from './registry';
import { findPort } from './connection';
import type { RefItem, Slot } from './types';
import {
  CAMERA_KEYS, FALLBACK_KEYS, PRIMARY_OUTPUT_PORT, REF_TOKEN_RE, SOURCE_HANDLE_KIND, SOURCE_TYPE_KIND, TEXT_KEYS, VALUE_KEYS,
  edgeKey, isCameraSource, isRefEdge, looksLikeUrl, refOrderOf, refRolesOf, type Kind,
} from './inputRules';

export { REF_TOKEN_RE };

/** 各数据类型读取的 data 键（按优先级，与后端一致；STRING 来自 3D 导演机位时改读 camera_prompt / minimax_camera_prompt）。 */
export const OUTPUT_VALUE_KEYS: Readonly<Record<Kind, readonly string[]>> = Object.freeze({
  STRING: TEXT_KEYS,
  IMAGE: VALUE_KEYS.IMAGE,
  VIDEO: VALUE_KEYS.VIDEO,
  AUDIO: VALUE_KEYS.AUDIO,
});

/** 视频缩略图候选键（仅前端展示用）。 */
const VIDEO_THUMB_KEYS = ['thumb_url', 'poster_url', 'cover_url', 'thumbnail'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 缺 sourceHandle 的旧边：按来源节点主输出口读取（migrate.PRIMARY_OUTPUT_PORT）。 */
export function effectiveSourceHandle(sourceType: string | undefined, sourceHandle: string | null | undefined): string {
  return (sourceHandle ?? '').trim() || (sourceType ? PRIMARY_OUTPUT_PORT[sourceType] ?? '' : '');
}

/**
 * 读上游节点某个输出口的当前值（R3 取值，对应 inputs.source_values）：STRING 返回文本、媒体返回 URL；没有值返回空串。
 * 顺序：NodeDef.outputValue 覆盖（前端扩展点，新增时须同步后端）→ data[端口 id]（媒体须像 URL）→ 类型默认键 → 媒体兜底键。
 */
export function readOutputValue(node: Pick<Node, 'type' | 'data'> | undefined | null, sourceHandle: string | null | undefined, dataType: Kind): string {
  if (!node) return '';
  const data = (node.data || {}) as Record<string, unknown>;
  const st = node.type ?? '';
  const sh = effectiveSourceHandle(st, sourceHandle);
  const def = getNodeDef(st);
  if (def?.outputValue) {
    try {
      const v = def.outputValue(data as never, sh, dataType);
      if (typeof v === 'string') return v;
    } catch (e) {
      console.error(`[kit] ${def.type}.outputValue 失败`, e);
    }
  }
  if (sh) {
    const own = str(data[sh]);
    if (own && (dataType === 'STRING' || looksLikeUrl(own))) return own;
  }
  const keys = dataType === 'STRING' ? (isCameraSource(st, sh) ? CAMERA_KEYS : TEXT_KEYS) : VALUE_KEYS[dataType];
  for (const k of keys) {
    const v = str(data[k]);
    if (v) return v;
  }
  if (dataType !== 'STRING') {
    for (const k of FALLBACK_KEYS[dataType]) {
      const v = str(data[k]);
      if (v) return v;
    }
  }
  return '';
}

/**
 * 推断一条参考的数据类型（R3，对应 inputs.source_kind）：sourceHandle → 来源节点类型 → 产物键推断；
 * 后端判断不出时，前端再看注册表里声明的端口类型（只会比后端多认，不会冲突）；都不行返回 undefined。
 */
export function inferEdgeDataType(sourceNode: Pick<Node, 'type' | 'data'>, sourceHandle: string | null | undefined): Kind | undefined {
  const st = sourceNode.type ?? '';
  const sh = effectiveSourceHandle(st, sourceHandle);
  if (sh && SOURCE_HANDLE_KIND[sh]) return SOURCE_HANDLE_KIND[sh];
  if (SOURCE_TYPE_KIND[st]) return SOURCE_TYPE_KIND[st];
  const data = (sourceNode.data || {}) as Record<string, unknown>;
  if (str(data.video_url)) return 'VIDEO';
  if (str(data.audio_url)) return 'AUDIO';
  if (str(data.image_url) || str(data.result_url)) return 'IMAGE';
  if (TEXT_KEYS.some((k) => str(data[k]))) return 'STRING';
  const port = findPort(getNodeDef(st), sourceNode, sh || null, 'source');
  const declared = port ? ([] as string[]).concat(port.dataType).filter((t) => t !== '*') : [];
  return declared.length === 1 ? (declared[0] as Kind) : undefined;
}

function thumbOf(node: Pick<Node, 'data'>, dataType: Kind, value: string): string | undefined {
  if (dataType === 'IMAGE') return value || undefined;
  if (dataType === 'VIDEO') {
    const data = (node.data || {}) as Record<string, unknown>;
    for (const k of VIDEO_THUMB_KEYS) {
      const v = str(data[k]);
      if (v) return v;
    }
  }
  return undefined;
}

/** R2：按 refOrder 稳定排序——在 refOrder 中的按其（首次出现的）位置，其余保持连线顺序排在后面。 */
export function orderRefs<T extends { key: string }>(items: T[], refOrder?: readonly string[] | null): T[] {
  if (!refOrder?.length) return items;
  const order = new Map<string, number>();
  refOrder.forEach((k, i) => { if (!order.has(k)) order.set(k, i); });
  const tail = order.size;
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (order.get(a.item.key) ?? tail) - (order.get(b.item.key) ?? tail) || a.i - b.i)
    .map((x) => x.item);
}

export interface BuildRefsOptions {
  /**
   * 收哪些入边：缺省 `'in'` = 后端 R1（in 口；或目标是 in 口节点类型时空口 / 旧具名口）；
   * null = 所有入边（仍排除 provider* / group 来源）；其他字符串 = 只收该输入口。
   */
  handleId?: string | null;
  /** 缺省读目标节点 data.refOrder。 */
  refOrder?: readonly string[] | null;
  /** 缺省读目标节点 data.refRoles。 */
  refRoles?: Record<string, string> | null;
}

/** 从边 + 节点构建目标节点的有序参考列表（useNodeReferences 的纯函数核心）。N = 下标 + 1，暂无值的参考也占号。 */
export function buildRefs(
  edges: readonly Edge[],
  getNode: (id: string) => Pick<Node, 'id' | 'type' | 'data'> | undefined,
  targetId: string,
  options: BuildRefsOptions = {},
): RefItem[] {
  const handleId = options.handleId === undefined ? 'in' : options.handleId;
  const target = getNode(targetId);
  if (!target) return [];
  const tdata = (target.data || {}) as Record<string, unknown>;
  const refOrder = options.refOrder !== undefined ? options.refOrder : refOrderOf(tdata);
  const refRoles = options.refRoles !== undefined ? options.refRoles : refRolesOf(tdata);
  const seen = new Set<string>();
  const items: RefItem[] = [];
  for (const edge of edges) {
    if (edge.target !== targetId) continue;
    const src = getNode(edge.source);
    if (!src) continue;
    if (handleId === 'in') {
      if (!isRefEdge(edge.targetHandle, target.type, src.type)) continue;
    } else if (handleId === null) {
      if (!isRefEdge('in', target.type, src.type)) continue;
    } else if ((edge.targetHandle ?? '') !== handleId) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = inferEdgeDataType(src, edge.sourceHandle);
    // 判断不出类型的参考（后端 kind=None）：记成空文本，占号但不参与组装
    const dataType: Kind = kind ?? 'STRING';
    const value = kind ? readOutputValue(src, edge.sourceHandle, kind) : '';
    const data = (src.data || {}) as Record<string, unknown>;
    const role = refRoles?.[key] as Slot | undefined;
    items.push({
      key,
      sourceId: edge.source,
      sourceHandle: edge.sourceHandle ?? '',
      sourceType: src.type,
      targetHandle: edge.targetHandle ?? undefined,
      edgeId: edge.id,
      dataType,
      value,
      label: str(data.label) ?? getNodeDef(src.type)?.label ?? src.type,
      thumb: thumbOf(src, dataType, value),
      ...(role ? { role } : {}),
    });
  }
  return orderRefs(items, refOrder);
}

/** 浅比较两份参考列表（useStore 的 equalityFn，避免无关 store 变化触发重渲染）。 */
export function refsEqual(a: readonly RefItem[], b: readonly RefItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.key !== y.key || x.value !== y.value || x.dataType !== y.dataType || x.label !== y.label
      || x.thumb !== y.thumb || x.role !== y.role || x.edgeId !== y.edgeId || x.sourceType !== y.sourceType
      || x.targetHandle !== y.targetHandle
    ) return false;
  }
  return true;
}

/** `{{ref N}}` 字面量（N 从 1 开始）。 */
export function refToken(index: number): string {
  return `{{ref ${index}}}`;
}

/** 参考在列表中的显示名（Toonflow 同款「参考 N」）。 */
export function refName(index: number): string {
  return `参考 ${index}`;
}

/**
 * 参考顺序变化后改写提示词里的 `{{ref N}}`，让每个标记继续指向同一个上游（编号随之改变）。
 * 找不到的编号原样保留。
 */
export function remapRefTokens(text: string, fromKeys: readonly string[], toKeys: readonly string[]): string {
  if (!text || !text.includes('{{ref ')) return text;
  const pos = new Map(toKeys.map((k, i) => [k, i + 1]));
  return text.replace(REF_TOKEN_RE, (whole, n: string) => {
    const key = fromKeys[Number(n) - 1];
    const next = key === undefined ? undefined : pos.get(key);
    return next === undefined ? whole : refToken(next);
  });
}

/** 把一组参考移动位置后的新 key 顺序。 */
export function moveKeys(keys: readonly string[], from: number, to: number): string[] {
  const next = [...keys];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
