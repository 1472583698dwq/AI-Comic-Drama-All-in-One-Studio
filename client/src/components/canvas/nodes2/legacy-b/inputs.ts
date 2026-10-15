// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 上游值 → 声明端口（纯函数，宿主传播 / 节点执行共用）。
 *
 * 修复 design §6.2 ①：旧宿主的连线传播只认 nodeRegistry 里有的节点，ext-node 不在其中，
 * 于是图片 / 视频 / 音频被写成 image_url / video_url / audio_url，而后端 engine.py 的 ext-node 分支
 * 按声明的端口 id（如 upscale_ext 的 `video`）取输入 → 拿不到。这里统一按 `resolveDynamicPorts` 的端口落值：
 *   - 单值端口：`{ [端口 id]: 值 }`（多条入边时最后连上的那条生效，同旧传播「后写覆盖」）；
 *   - 多值端口（schema type=array）：按连线顺序去重合并成数组。
 * 读上游值统一用 kit 的 readOutputValue（与参考列表、后端 inputs.source_values 同一套取值键）。
 */
import type { Edge, Node } from '@xyflow/react';
import { inferEdgeDataType, readOutputValue } from '../../kit/references';
import { GROUP_NODE_TYPE } from '../../kit/inputRules';
import type { DataType } from '../../kit/types';
import {
  findInputPort, isDynamicPortNodeType, isProviderNodeType, providerIdOf, providerKindOf,
  type Kind, type LegacyPortDef, type ProviderKind,
} from './ports';

type NodeLike = Pick<Node, 'id' | 'type' | 'data'>;
type EdgeLike = Pick<Edge, 'source' | 'target'> & Partial<Pick<Edge, 'id' | 'sourceHandle' | 'targetHandle'>>;

function typesOf(dt: DataType | DataType[]): DataType[] {
  return (Array.isArray(dt) ? dt : [dt]).flatMap((t) => String(t).split(',')).map((t) => t.trim() as DataType).filter(Boolean);
}

/** 端口实际要读的上游类型：单一具体类型直接用；多类型 / `*` 按上游推断（推断不出取端口的第一个具体类型）。 */
export function kindForPort(port: Pick<LegacyPortDef, 'dataType'>, source: NodeLike, sourceHandle: string | null | undefined): Kind | undefined {
  const types = typesOf(port.dataType);
  const concrete = types.filter((t): t is Kind => t !== '*');
  if (concrete.length === 1 && !types.includes('*')) return concrete[0];
  const inferred = inferEdgeDataType(source, sourceHandle);
  if (inferred && (types.includes('*') || concrete.includes(inferred))) return inferred;
  return concrete[0];
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  return typeof v === 'string' && v.trim() ? [v] : [];
}

/** 这条边能不能往目标的声明端口落值（生成源 / 分组来源不算：生成源走 providerPatchFor）。 */
function landable(source: NodeLike | undefined, target: NodeLike | undefined): source is NodeLike {
  if (!source || !target || !isDynamicPortNodeType(target.type)) return false;
  return !isProviderNodeType(source.type) && source.type !== GROUP_NODE_TYPE;
}

/** 单条边的上游值（端口 + 值）；端口不存在 / 上游暂无值 → null。 */
export function edgePortValue(edge: EdgeLike, source: NodeLike | undefined, target: NodeLike | undefined): { port: LegacyPortDef; value: string } | null {
  if (!landable(source, target)) return null;
  const port = findInputPort(target, edge.targetHandle);
  if (!port) return null;
  const kind = kindForPort(port, source, edge.sourceHandle);
  if (!kind) return null;
  const value = readOutputValue(source, edge.sourceHandle, kind);
  return value ? { port, value } : null;
}

/**
 * 一条连线（onConnect 时）要写进目标节点的补丁：`{ [声明端口 id]: 值 }`；多值端口在目标现有数组上追加去重。
 * 目标不是动态端口节点 / 来源是生成源 / 没值 → null。
 */
export function edgeInputPatch(edge: EdgeLike, source: NodeLike | undefined, target: NodeLike | undefined): Record<string, unknown> | null {
  const hit = edgePortValue(edge, source, target);
  if (!hit) return null;
  const { port, value } = hit;
  if (port.multi) {
    const cur = toList((target?.data as Record<string, unknown> | undefined)?.[port.id]);
    return { [port.id]: cur.includes(value) ? cur : [...cur, value] };
  }
  return { [port.id]: value };
}

/**
 * 目标节点全部入边重算（上游产出变化 / 执行前）：只返回有入边且有值的端口。
 * 多值端口 = 按连线顺序去重的数组；单值端口 = 最后一条有值的入边。
 */
export function collectDynamicInputs(
  target: NodeLike | undefined,
  edges: readonly EdgeLike[],
  getNode: (id: string) => NodeLike | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!target || !isDynamicPortNodeType(target.type)) return out;
  for (const e of edges) {
    if (e.target !== target.id) continue;
    const hit = edgePortValue(e, getNode(e.source), target);
    if (!hit) continue;
    const { port, value } = hit;
    if (port.multi) {
      const list = (out[port.id] as string[] | undefined) ?? [];
      if (!list.includes(value)) list.push(value);
      out[port.id] = list;
    } else {
      out[port.id] = value;
    }
  }
  return out;
}

/** 每个输入口的连线情况（卡片展示用）：连线数 + 当前值（多值端口为数组）。 */
export interface PortInputState {
  connected: number;
  value?: string | string[];
}

export function dynamicInputStates(
  target: NodeLike | undefined,
  edges: readonly EdgeLike[],
  getNode: (id: string) => NodeLike | undefined,
): Record<string, PortInputState> {
  const out: Record<string, PortInputState> = {};
  if (!target) return out;
  for (const e of edges) {
    if (e.target !== target.id) continue;
    const port = findInputPort(target, e.targetHandle);
    if (!port) continue;
    const st = (out[port.id] ??= { connected: 0 });
    st.connected++;
    const hit = edgePortValue(e, getNode(e.source), target);
    if (!hit) continue;
    if (port.multi) {
      const list = Array.isArray(st.value) ? st.value : [];
      if (!list.includes(hit.value)) list.push(hit.value);
      st.value = list;
    } else {
      st.value = hit.value;
    }
  }
  return out;
}

// ───────────────────────────── 生成源透传 ─────────────────────────────

/**
 * 生成源节点（provider*）连到下游时要写进下游的补丁（旧 CreativeCanvas.onConnect「Provider 节点透传」）：
 * `{ provider_id, provider, model }`；源未选定 → null。下游种类匹配由接收端节点自己判断（见 providerKindMatches）。
 * REQ-toonflow-canvas D2：`model` 键总是带上——新源没有 model 时值为 `undefined`（宿主合并补丁时删键），
 * 否则换源后下游残留上一个源的 model，会把别家的模型名发给会读 model 的源。
 */
export function providerPatchFor(source: NodeLike | undefined | null): Record<string, unknown> | null {
  if (!source || !isProviderNodeType(source.type)) return null;
  const data = (source.data || {}) as Record<string, unknown>;
  const pid = providerIdOf(data);
  if (!pid) return null;
  const patch: Record<string, unknown> = { provider_id: pid, provider: pid };
  const model = typeof data.model === 'string' ? data.model.trim() : '';
  patch.model = model || undefined;
  return patch;
}

/** 生成节点类型 → 需要的生成源种类（供接收端 canConnect：生图源只连图片生成等）。 */
const TARGET_PROVIDER_KIND: Readonly<Record<string, ProviderKind>> = Object.freeze({
  image: 'image', 'shot-card': 'image', video: 'video', audio: 'audio', tts: 'audio', prompt: 'llm',
});

/** 生成源节点能否把 id 交给该类型的下游（未知下游类型放行，交给下游自己的规则）。 */
export function providerKindMatches(source: NodeLike | undefined | null, targetType: string | null | undefined): boolean {
  if (!source || !isProviderNodeType(source.type)) return false;
  const need = targetType ? TARGET_PROVIDER_KIND[targetType] : undefined;
  if (!need) return true;
  return providerKindOf(source.type, source.data as Record<string, unknown>) === need;
}
