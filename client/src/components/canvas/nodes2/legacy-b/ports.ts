// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 独有节点换皮 B：端口声明（纯函数，不依赖 React）。
 *
 * 单一事实来源——节点渲染（NodeSkeleton ports）、注册表 `getPorts`（kit 连线类型校验）、
 * 宿主传播与执行（inputs.ts）都只从这里取端口，修掉调研的两处不一致（design §6.2）：
 *  ① ext-node：端口按插件声明 `inputs/outputs` 生成并参与类型校验；值写到声明的端口 id（后端 engine.py 按端口 id 读）；
 *  ② custom：端口统一以 `input_schema` 为准（旧 nodeRegistry 写死的 prompt/reference_images/first_frame… 列表与卡片渲染不一致）。
 * 端口 id 全部沿用旧组件的 handle id；旧数据类型（image/video/audio/text/any）映射到 kit DataType。
 */
import type { Node } from '@xyflow/react';
import type { ConnectSource, DataType, PortDef } from '../../kit/types';
import { getNodeDef } from '../../kit/registry';
import { resolvePorts } from '../../kit/connection';
import { PROVIDER_NODE_TYPES } from '../../kit/inputRules';
import { getCanvasNodeSpec, type CanvasNodeSpec } from '../../canvasNodeSpecs';
import { getCustomNodeDef, type CustomNodeDefinition } from './customNodeDefs';

export type Kind = Exclude<DataType, '*'>;
type AnyData = Record<string, any>;

/** kit PortDef + 旧声明里的附加信息（kit 只认 PortDef 字段，多出的字段不影响校验）。 */
export interface LegacyPortDef extends PortDef {
  /** 多值端口（schema type=array）：多条入边合并成数组 */
  multi?: boolean;
  required?: boolean;
  description?: string;
  /** ext-node 输出口：结果字段名（spec.outputs[].from，缺省同 id） */
  from?: string;
}

// ───────────────────────────── 类型映射 ─────────────────────────────

/** x-handle / 声明类型 → 媒体 DataType（含旧插槽别名：reference_images、first_frame、ref_audio…）。 */
const MEDIA_ALIASES: Readonly<Record<string, Kind>> = Object.freeze({
  image: 'IMAGE', images: 'IMAGE', reference_images: 'IMAGE', reference_image: 'IMAGE', first_frame: 'IMAGE', last_frame: 'IMAGE',
  video: 'VIDEO', videos: 'VIDEO', reference_videos: 'VIDEO', reference_video: 'VIDEO',
  audio: 'AUDIO', audios: 'AUDIO', reference_audios: 'AUDIO', reference_audio: 'AUDIO', ref_audio: 'AUDIO',
});

/** canvas_nodes 端口类型（image|video|audio|text|any）→ DataType。 */
export function portTypeToDataType(t: unknown): DataType {
  const k = String(t ?? '').trim().toLowerCase();
  if (k === 'any' || k === '*') return '*';
  return MEDIA_ALIASES[k] ?? 'STRING';
}

function isUriProp(def: AnyData | undefined): boolean {
  return def?.format === 'uri' || def?.items?.format === 'uri';
}

/** 媒体 / uri 属性按键名粗判（旧 CustomNode.slotType 与 dynamicHandles.coerce 同口径：缺省按图片）。 */
function uriKindByKey(key: string): Kind {
  const lk = key.toLowerCase();
  if (lk.includes('audio')) return 'AUDIO';
  if (lk.includes('video')) return 'VIDEO';
  return 'IMAGE';
}

/** custom input_schema 属性 → DataType（旧 CustomNode.slotType：x-handle 媒体 → uri 按键名 → 其余文本）。 */
export function customSlotType(key: string, def: AnyData | undefined): DataType {
  const h = String(def?.['x-handle'] ?? '').toLowerCase();
  if (MEDIA_ALIASES[h]) return MEDIA_ALIASES[h];
  if (isUriProp(def)) return uriKindByKey(key);
  return 'STRING';
}

/** 生成源 input/output_schema 属性 → DataType（旧 ProviderNode.getHandleColor 的分类，补上 uri 兜底）。 */
export function providerSlotType(key: string, def: AnyData | undefined): DataType {
  const h = String(def?.['x-handle'] ?? '').toLowerCase();
  if (MEDIA_ALIASES[h]) return MEDIA_ALIASES[h];
  if (h === 'text' || h === 'prompt') return 'STRING';
  const lk = key.toLowerCase();
  if (lk.includes('image')) return 'IMAGE';
  if (lk.includes('video')) return 'VIDEO';
  if (lk.includes('audio')) return 'AUDIO';
  if (isUriProp(def)) return 'IMAGE';
  return 'STRING';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function propsOf(schema: unknown): Array<[string, AnyData]> {
  const p = (schema as AnyData | null | undefined)?.properties;
  return p && typeof p === 'object' ? Object.entries(p as Record<string, AnyData>) : [];
}

function requiredOf(schema: unknown): string[] {
  const r = (schema as AnyData | null | undefined)?.required;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

// ───────────────────────────── 节点类型 ─────────────────────────────

export const EXT_NODE_TYPE = 'ext-node';
export const CUSTOM_NODE_TYPE = 'custom';
export const BRIEF_NODE_TYPE = 'brief';
export const SCRIPT_SPLIT_NODE_TYPE = 'script-split';
export { PROVIDER_NODE_TYPES };

export function isProviderNodeType(type: string | null | undefined): boolean {
  return !!type && PROVIDER_NODE_TYPES.includes(type);
}

/** 端口由节点数据决定的类型（ext-node / custom / provider*）。 */
export function isDynamicPortNodeType(type: string | null | undefined): boolean {
  return type === EXT_NODE_TYPE || type === CUSTOM_NODE_TYPE || isProviderNodeType(type);
}

// ───────────────────────────── brief / script-split（静态） ─────────────────────────────

/** 灵感简报：旧组件右侧无 id 口 + 底部 `brief` 口 → 统一为 `brief`（无 id 的旧连线落到第一个输出口，即 brief）。 */
export const BRIEF_PORTS: readonly LegacyPortDef[] = Object.freeze([
  { id: 'brief', type: 'source', dataType: 'STRING', label: '简报' },
]);

/**
 * 剧本拆解：输入 `brief`（旧左侧无 id 口与顶部 `brief` 口合一）；输出沿用 nodeRegistry 声明的 `characters`、`shots`
 * （旧右侧无 id 口的连线落到第一个输出口 characters）。
 */
export const SCRIPT_SPLIT_PORTS: readonly LegacyPortDef[] = Object.freeze([
  { id: 'brief', type: 'target', dataType: 'STRING', label: '简报' },
  { id: 'characters', type: 'source', dataType: 'STRING', label: '角色' },
  { id: 'shots', type: 'source', dataType: 'STRING', label: '分镜' },
]);

// ───────────────────────────── ext-node（canvas_nodes 插件声明） ─────────────────────────────

function looksLikeSpec(v: unknown): v is CanvasNodeSpec {
  return !!v && typeof v === 'object' && (Array.isArray((v as AnyData).inputs) || Array.isArray((v as AnyData).outputs));
}

/**
 * 扩展节点的声明：全局注册表（`canvasNodeSpecs`，宿主按项目同步、节点懒取后登记）优先，
 * 其次节点 data.definition（拖入时带的快照）；都没有 → null（插件未启用 / 已卸载）。
 */
export function extSpecOf(data: AnyData | null | undefined): CanvasNodeSpec | null {
  const d = data || {};
  const id = str(d.canvas_node_id) || str(d.canvasNodeId);
  const reg = id ? getCanvasNodeSpec(id) : undefined;
  if (reg) return reg;
  const def = d.definition;
  if (looksLikeSpec(def) && (!id || !def.id || def.id === id)) return def;
  return null;
}

/** 扩展节点端口：输入 = spec.inputs，输出 = spec.outputs（id 即声明的端口 id）。 */
export function extNodePorts(data: AnyData | null | undefined): LegacyPortDef[] {
  const spec = extSpecOf(data);
  if (!spec) return [];
  const ins: LegacyPortDef[] = (spec.inputs || []).filter((p) => p?.id).map((p) => ({
    id: p.id,
    type: 'target',
    dataType: portTypeToDataType(p.type),
    label: p.label || p.id,
    ...(p.required ? { required: true } : {}),
    ...(p.description ? { description: p.description } : {}),
  }));
  const outs: LegacyPortDef[] = (spec.outputs || []).filter((p) => p?.id).map((p) => ({
    id: p.id,
    type: 'source',
    dataType: portTypeToDataType(p.type),
    label: p.label || p.id,
    ...(p.from ? { from: p.from } : {}),
    ...(p.description ? { description: p.description } : {}),
  }));
  return [...ins, ...outs];
}

// ───────────────────────────── custom（自定义代码节点） ─────────────────────────────

/** 定义：模块缓存（最新）优先，其次 data.definition；节点换了 custom_node_id 后不认旧快照。 */
export function customDefOf(data: AnyData | null | undefined): CustomNodeDefinition | null {
  const d = data || {};
  const id = str(d.custom_node_id) || str(d.customNodeId);
  const hit = id ? getCustomNodeDef(id) : undefined;
  if (hit) return hit;
  const def = d.definition;
  if (def && typeof def === 'object' && (!id || !(def as AnyData).id || (def as AnyData).id === id) && (def as AnyData).input_schema) {
    return def as CustomNodeDefinition;
  }
  return null;
}

/** 没有 input_schema（未选节点 / 定义还没拉到）时的输入口：与旧 CustomNode 的兜底一致。 */
export const CUSTOM_FALLBACK_INPUTS: readonly LegacyPortDef[] = Object.freeze([
  { id: 'prompt', type: 'target', dataType: 'STRING', label: '提示词/文本' },
  { id: 'video', type: 'target', dataType: 'VIDEO', label: '视频' },
  { id: 'reference_images', type: 'target', dataType: 'IMAGE', label: '参考集', multi: true },
]);

/** 输出口按 kind（同旧 CustomNode）：image/video/audio 各一个口，utility 等四个口全给。 */
export function customOutputPorts(kind: unknown): LegacyPortDef[] {
  const k = str(kind) || 'utility';
  if (k === 'image') return [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图像' }];
  if (k === 'video') return [{ id: 'video', type: 'source', dataType: 'VIDEO', label: '视频' }];
  if (k === 'audio') return [{ id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频' }];
  return [
    { id: 'image', type: 'source', dataType: 'IMAGE', label: '图像' },
    { id: 'video', type: 'source', dataType: 'VIDEO', label: '视频' },
    { id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频' },
    { id: 'text', type: 'source', dataType: 'STRING', label: '文本' },
  ];
}

/** 输入口 = input_schema 的每个属性（id 为属性键：后端 engine custom 分支与 /custom-nodes/run 都按属性键取值）。 */
export function customNodePorts(data: AnyData | null | undefined): LegacyPortDef[] {
  const def = customDefOf(data);
  const props = propsOf(def?.input_schema);
  const required = requiredOf(def?.input_schema);
  const ins: LegacyPortDef[] = props.length
    ? props.map(([key, p]) => ({
        id: key,
        type: 'target',
        dataType: customSlotType(key, p),
        label: str(p?.description) || str(p?.title) || key,
        ...(p?.type === 'array' ? { multi: true } : {}),
        ...(required.includes(key) || p?.required === true ? { required: true } : {}),
      }))
    : CUSTOM_FALLBACK_INPUTS.map((p) => ({ ...p }));
  return [...ins, ...customOutputPorts(def?.kind)];
}

// ───────────────────────────── provider*（生成源节点） ─────────────────────────────

export type ProviderKind = 'image' | 'video' | 'audio' | 'llm';
const PROVIDER_KINDS: readonly ProviderKind[] = ['image', 'video', 'audio', 'llm'];

/** 生成源种类：带种类的类型强制（provider-llm 以前会落成 image），通用 `provider` 读 data.kind（缺省 image）。 */
export function providerKindOf(type: string | null | undefined, data?: AnyData | null): ProviderKind {
  if (type === 'provider-image') return 'image';
  if (type === 'provider-video') return 'video';
  if (type === 'provider-audio') return 'audio';
  if (type === 'provider-llm') return 'llm';
  const k = str(data?.kind) as ProviderKind;
  return PROVIDER_KINDS.includes(k) ? k : 'image';
}

const KIND_DATATYPE: Readonly<Record<ProviderKind, Kind>> = Object.freeze({ image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', llm: 'STRING' });

/** 节点上选中的生成源定义（旧组件把 definition 写进节点 data，供下游 / 引擎读取）。 */
export function providerDefOf(data: AnyData | null | undefined): AnyData | null {
  const def = data?.definition;
  return def && typeof def === 'object' && !Array.isArray(def) ? (def as AnyData) : null;
}

/** 生成源 id：provider_id → providerId → definition.id（与后端 engine provider 分支同口径）。 */
export function providerIdOf(data: AnyData | null | undefined): string {
  const d = data || {};
  return str(d.provider_id) || str(d.providerId) || str(providerDefOf(d)?.id);
}

const PROVIDER_IN_HANDLES = ['image', 'images', 'reference_images', 'audio', 'audios', 'reference_audios', 'video', 'videos', 'reference_videos', 'text', 'prompt'];

/** 旧 ProviderNode.dynamicInputs 的筛选：有 x-handle、uri 数组、或描述里提到媒体的 uri。 */
function isProviderInputProp(def: AnyData | undefined): boolean {
  if (!def) return false;
  const h = def['x-handle'];
  if (h && PROVIDER_IN_HANDLES.includes(String(h))) return true;
  if (def.type === 'array' && def.items?.format === 'uri') return true;
  if (def.format === 'uri' && ['image', 'audio', 'video'].some((k) => String(def.description ?? '').toLowerCase().includes(k))) return true;
  return !!h;
}

/**
 * 生成源节点端口：
 * - 输入：input_schema 里的数据口（属性键为 id），没有则一个 `prompt` 文本口；
 * - 输出：`provider`（把生成源 id / 模型交给下游，原底部口）+ output_schema 的数据口，没有则按种类给 image/video/audio/output。
 */
export function providerNodePorts(type: string | null | undefined, data: AnyData | null | undefined): LegacyPortDef[] {
  const kind = providerKindOf(type, data);
  const def = providerDefOf(data);
  const required = requiredOf(def?.input_schema);
  const ins: LegacyPortDef[] = propsOf(def?.input_schema)
    .filter(([, p]) => isProviderInputProp(p))
    .map(([key, p]) => ({
      id: key,
      type: 'target',
      dataType: providerSlotType(key, p),
      label: str(p?.title) || str(p?.description) || key,
      ...(p?.type === 'array' ? { multi: true } : {}),
      ...(required.includes(key) ? { required: true } : {}),
    }));
  const outs: LegacyPortDef[] = propsOf(def?.output_schema)
    .filter(([, p]) => !!p?.['x-handle'] || p?.format === 'uri')
    .map(([key, p]) => ({ id: key, type: 'source', dataType: providerSlotType(key, p), label: str(p?.title) || str(p?.description) || key }));
  const fallbackOut: LegacyPortDef = {
    id: kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'output',
    type: 'source',
    dataType: KIND_DATATYPE[kind],
    label: kind === 'image' ? '图像' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '输出',
  };
  return [
    ...(ins.length ? ins : [{ id: 'prompt', type: 'target', dataType: 'STRING', label: '提示词' } as LegacyPortDef]),
    { id: 'provider', type: 'source', dataType: KIND_DATATYPE[kind], label: '生成源（连到下游的生成源输入）' },
    ...(outs.length ? outs : [fallbackOut]),
  ];
}

// ───────────────────────────── 统一解析 ─────────────────────────────

/**
 * 任意节点的实际端口（H1 的 isValidConnection / 传播用）：本目录的节点按声明解析，
 * 其他节点走 kit 注册表（静态 ports 或 getPorts）。
 */
export function resolveDynamicPorts(node: Pick<Node, 'type' | 'data'> | null | undefined): LegacyPortDef[] {
  if (!node) return [];
  const data = (node.data || {}) as AnyData;
  switch (node.type) {
    case EXT_NODE_TYPE:
      return extNodePorts(data);
    case CUSTOM_NODE_TYPE:
      return customNodePorts(data);
    case BRIEF_NODE_TYPE:
      return BRIEF_PORTS.map((p) => ({ ...p }));
    case SCRIPT_SPLIT_NODE_TYPE:
      return SCRIPT_SPLIT_PORTS.map((p) => ({ ...p }));
    default:
      break;
  }
  if (isProviderNodeType(node.type)) return providerNodePorts(node.type, data);
  return resolvePorts(getNodeDef(node.type), node) as LegacyPortDef[];
}

/** 在节点上按 handle id 找输入口（没有 handle id 的旧连线落到第一个输入口，同 kit.findPort）。 */
export function findInputPort(node: Pick<Node, 'type' | 'data'> | null | undefined, handleId: string | null | undefined): LegacyPortDef | undefined {
  const ports = resolveDynamicPorts(node).filter((p) => p.type === 'target');
  if (!ports.length) return undefined;
  if (!handleId) return ports[0];
  return ports.find((p) => p.id === handleId);
}

/**
 * NodeDef.canConnect（只在接收端执行）：生成源节点的 `provider` 口输出的是生成源 id，
 * 不能当成媒体 / 文本喂给扩展节点、代码节点、生成源节点或剧本拆解。
 */
export function rejectProviderSource(src: ConnectSource): boolean {
  return !isProviderNodeType(src?.node?.type);
}

// ───────────────────────────── 输出值（NodeDef.outputValue） ─────────────────────────────
// 旧数据里输入值也写在 data[端口 id] 上（如 upscale_ext 的输入口与输出口都叫 video），
// kit 默认的 readOutputValue 先读 data[sourceHandle] 会把「输入」当成「输出」交给下游，所以这三类节点各自覆盖。
// 返回 '' 表示「暂无产出」（不再回落默认键，避免把输入值漏给下游）；返回 undefined 才回落 kit 默认映射。

const RESULT_KEYS: Readonly<Record<Kind, readonly string[]>> = Object.freeze({
  IMAGE: ['image_url', 'result_url'],
  VIDEO: ['video_url'],
  AUDIO: ['audio_url'],
  STRING: ['text'],
});

function firstStr(data: AnyData, keys: readonly string[], skip?: ReadonlySet<string>): string {
  for (const k of keys) {
    if (skip?.has(k)) continue;
    const v = str(data[k]);
    if (v) return v;
  }
  return '';
}

/** ext-node：outputs[端口 id]（后端 run_canvas_node 的端口映射）→ data[from] → 该类型的结果键；都不读输入口同名键。 */
export function extOutputValue(data: AnyData, portId: string, kind: Kind): string | undefined {
  const spec = extSpecOf(data);
  if (!spec) return undefined;
  const inputIds = new Set((spec.inputs || []).map((p) => p.id));
  const out = (spec.outputs || []).find((p) => p.id === portId);
  if (!out) return inputIds.has(portId) ? '' : undefined;
  const outputs = data.outputs && typeof data.outputs === 'object' ? (data.outputs as AnyData) : {};
  const own = str(outputs[portId]);
  if (own) return own;
  if (out.from && !inputIds.has(out.from)) {
    const v = str(data[out.from]);
    if (v) return v;
  }
  const outKind = (portTypeToDataType(out.type) === '*' ? kind : portTypeToDataType(out.type)) as Kind;
  return firstStr(data, RESULT_KEYS[outKind] ?? RESULT_KEYS[kind], inputIds);
}

/** custom：image→image_url/result_url、video→video_url、audio→audio_url、text→text（结果键，不读同名输入口）。 */
export function customOutputValue(data: AnyData, portId: string, kind: Kind): string | undefined {
  const outs = customOutputPorts(customDefOf(data)?.kind);
  const out = outs.find((p) => p.id === portId);
  if (!out) return undefined;
  const outKind = (Array.isArray(out.dataType) ? out.dataType[0] : out.dataType) as Kind;
  return firstStr(data, RESULT_KEYS[outKind] ?? RESULT_KEYS[kind]);
}

/** provider：`provider` 口 = 生成源 id；其余口回落 kit 默认映射（引擎直连生成时写 image_url/video_url/audio_url）。 */
export function providerOutputValue(data: AnyData, portId: string): string | undefined {
  if (portId === 'provider') return providerIdOf(data);
  return undefined;
}
