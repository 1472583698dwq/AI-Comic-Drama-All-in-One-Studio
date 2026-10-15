// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 下游传播（纯函数，替代旧 CreativeCanvas.handleNodeUpdate / onConnect 的「整包透传」）。
 *
 * 旧宿主一旦补丁里有产出键，就把同一补丁里的其余键（history / params / refRoles / agent_state / script_data …）
 * 原样拷给下游——存量视频节点上的错误 `url` / `image` 就是这么来的。新规则（H1-INPUTS「最高优先」）：
 *
 * 1. 下游是单输入口节点（prompt / image / video / audio / director3d）：**什么都不写**——参考列表由
 *    kit useNodeReferences / buildRefs 实时读上游产出（后端 inputs.py 同理按连线读）。
 * 2. 下游是动态端口节点（ext-node / custom / provider*）：只写 N7 `collectDynamicInputs` 算出的「声明端口 id → 上游值」，
 *    且只写有变化的键。
 * 3. 上游是生成源节点（provider*）：下游只收 `providerPatchFor`（provider_id / provider / model），
 *    种类不符（生图源 → 视频生成等）不写；shot-card 也照旧收（N6）。
 * 4. 仍从 data 读具名输入的旧节点（shot-card / comfy-workflow / timeline-export / script-split）：
 *    只写「源端口当前产出值」到目标端口同名键（+ `_upstream` 同键），按源端口 dataType 读值（kit readOutputValue）。
 * 5. 其余（timeline / export / group …）不写：它们自己按连线读上游，或由后端执行器聚合。
 *
 * 值相同不写，所以不会自激；不级联（下游被写不再继续往下传，同旧行为）。
 */
import type { Edge, Node } from '@xyflow/react';
import { getNodeDef } from '../kit/registry';
import { findPort } from '../kit/connection';
import { readOutputValue } from '../kit/references';
import { GROUP_NODE_TYPE, IN_PORT_NODE_TYPES } from '../kit/inputRules';
import { collectDynamicInputs, kindForPort, providerKindMatches, providerPatchFor } from '../nodes2/legacy-b/inputs';
import { isDynamicPortNodeType, isProviderNodeType, type LegacyPortDef } from '../nodes2/legacy-b/ports';

type AnyData = Record<string, unknown>;
type NodeLike = Pick<Node, 'id' | 'type' | 'data'>;
type EdgeLike = Pick<Edge, 'id' | 'source' | 'target'> & Partial<Pick<Edge, 'sourceHandle' | 'targetHandle'>>;

/** 仍从 data 读具名输入键的旧节点（其余非 in 口 / 非动态端口节点按连线自取上游）。 */
export const DATA_INPUT_TARGET_TYPES: readonly string[] = Object.freeze(['shot-card', 'comfy-workflow', 'timeline-export', 'script-split']);

/** 永不向下游传播的键（防御：即便未来规则有误，这些也不会被写进下游）。 */
export const NEVER_PROPAGATE_KEYS: readonly string[] = Object.freeze([
  'history', 'params', 'provider_params', 'refRoles', 'refOrder', 'agent_state', 'script_data', 'mode', 'smart_plan',
  '_last_agent_plan', '_taskId', '_polling', 'label', 'width', 'height', 'asset_id', 'keyframes', 'camera_state', 'mannequin_pose',
]);

/**
 * 合并节点数据补丁：值为 `undefined` 的键视为清除（N3 / N7：切源、换视频、清错误时用来删旧键）。
 * 不修改入参；补丁为空时返回原对象。
 */
export function applyDataPatch(data: AnyData | undefined | null, patch: AnyData | undefined | null): AnyData {
  const base = (data || {}) as AnyData;
  if (!patch) return base;
  const keys = Object.keys(patch);
  if (!keys.length) return base;
  const out: AnyData = { ...base };
  for (const k of keys) {
    const v = patch[k];
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function diffInto(target: AnyData, current: AnyData, next: AnyData): void {
  for (const [k, v] of Object.entries(next)) {
    if (NEVER_PROPAGATE_KEYS.includes(k)) continue;
    if (!same(current[k], v)) target[k] = v;
  }
}

/** 单条边对目标的补丁（不含其他边的贡献；动态端口节点按全部入边重算）。 */
function edgePatch(
  edge: EdgeLike,
  source: NodeLike,
  target: NodeLike,
  edges: readonly EdgeLike[],
  getNode: (id: string) => NodeLike | undefined,
): AnyData {
  const out: AnyData = {};
  const tdata = (target.data || {}) as AnyData;
  if (!target.type || target.type === GROUP_NODE_TYPE || source.type === GROUP_NODE_TYPE) return out;
  // 3. 生成源 → 下游：只透传生成源 id / 模型
  if (isProviderNodeType(source.type)) {
    if (!providerKindMatches(source, target.type)) return out;
    const pp = providerPatchFor(source);
    if (pp) diffInto(out, tdata, pp);
    return out;
  }
  // 2. 动态端口节点：声明端口 id ← 上游值（全部入边重算）
  if (isDynamicPortNodeType(target.type)) {
    diffInto(out, tdata, collectDynamicInputs(target, edges, getNode));
    return out;
  }
  // 1. 单输入口节点：参考列表实时读，不写
  if (IN_PORT_NODE_TYPES.includes(target.type)) return out;
  // 4. 从 data 读具名输入的旧节点：只写源端口当前产出值
  if (DATA_INPUT_TARGET_TYPES.includes(target.type)) {
    const port = findPort(getNodeDef(target.type), target, edge.targetHandle, 'target') as LegacyPortDef | undefined;
    if (!port) return out;
    const kind = kindForPort(port, source, edge.sourceHandle);
    if (!kind) return out;
    const value = readOutputValue(source, edge.sourceHandle, kind);
    if (!value || same(tdata[port.id], value)) return out;
    out[port.id] = value;
    const up = (tdata._upstream && typeof tdata._upstream === 'object' ? tdata._upstream : {}) as AnyData;
    out._upstream = { ...up, [port.id]: value };
  }
  return out;
}

export interface PropagationOptions {
  /** 只算这些边（连线时只算新边） */
  edgeIds?: ReadonlySet<string> | readonly string[];
}

/**
 * 源节点（已应用自身补丁后）向下游的补丁：targetId → patch（只含有变化的键）。
 * `nodes` 须是已应用源节点补丁后的节点列表。
 */
export function downstreamPatches(
  nodes: readonly NodeLike[],
  edges: readonly EdgeLike[],
  sourceId: string,
  opts: PropagationOptions = {},
): Map<string, AnyData> {
  const out = new Map<string, AnyData>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = byId.get(sourceId);
  if (!source) return out;
  const only = opts.edgeIds ? new Set(opts.edgeIds as Iterable<string>) : null;
  const getNode = (id: string) => byId.get(id);
  for (const e of edges) {
    if (e.source !== sourceId) continue;
    if (only && !only.has(e.id)) continue;
    const target = byId.get(e.target);
    if (!target) continue;
    // 同一目标多条边：在已累积补丁基础上继续算，避免后一条覆盖前一条的判断基准
    const prev = out.get(target.id);
    const view = prev ? { ...target, data: applyDataPatch(target.data as AnyData, prev) } : target;
    const p = edgePatch(e, source, view, edges, getNode);
    if (Object.keys(p).length) out.set(target.id, { ...(prev || {}), ...p });
  }
  return out;
}

/** 把一组「目标 → 补丁」应用到节点列表（不改入参，未变的节点保持原引用）。 */
export function applyPatches<N extends NodeLike>(nodes: readonly N[], patches: Map<string, AnyData>): N[] {
  if (!patches.size) return nodes as N[];
  return nodes.map((n) => {
    const p = patches.get(n.id);
    return p ? ({ ...n, data: applyDataPatch(n.data as AnyData, p) } as N) : n;
  });
}

/**
 * 加载画布 / Agent 改画布后整体重算一次：动态端口节点按入边落值、生成源向下游透传 id。
 * 只补有变化的键；其余节点不动。
 */
export function recomputeDerivedInputs<N extends NodeLike>(nodes: readonly N[], edges: readonly EdgeLike[]): N[] {
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const sources = new Set<string>();
  for (const e of edges) {
    if (isProviderNodeType(typeOf.get(e.source)) || isDynamicPortNodeType(typeOf.get(e.target))) sources.add(e.source);
  }
  let cur = nodes as N[];
  for (const sid of sources) {
    const fromProvider = isProviderNodeType(typeOf.get(sid));
    const keep = new Map<string, AnyData>();
    // 只保留「生成源透传」与「动态端口落值」（旧具名口节点加载时不重写，保持存量数据原样）
    for (const [tid, p] of downstreamPatches(cur, edges, sid)) {
      if (fromProvider || isDynamicPortNodeType(typeOf.get(tid))) keep.set(tid, p);
    }
    cur = applyPatches(cur, keep);
  }
  return cur;
}
