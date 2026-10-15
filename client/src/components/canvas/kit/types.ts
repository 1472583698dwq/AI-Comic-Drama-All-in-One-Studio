// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 节点框架（kit）公共类型。
 * 结构对照 Toonflow `packages/nodeScaffold/src/{connection,values}.ts`，数据字段沿用 MiniMax 现有键（design §2/§4）。
 */
import type { ComponentType } from 'react';
import type { Edge, Node, NodeTypes } from '@xyflow/react';

/** 端口数据类型；`*` 表示任意类型（与任何类型都可连）。 */
export type DataType = 'STRING' | 'IMAGE' | 'VIDEO' | 'AUDIO' | '*';

export const DATA_TYPES: readonly Exclude<DataType, '*'>[] = ['STRING', 'IMAGE', 'VIDEO', 'AUDIO'];

/** 端口声明：target 在左、source 在右；handle id === port id。 */
export interface PortDef {
  id: string;
  type: 'source' | 'target';
  dataType: DataType | DataType[];
  label?: string;
}

export type NodeCategory = 'text' | 'image' | 'video' | 'audio' | '3d' | 'output' | 'tool' | 'plugin';

/** React Flow nodeTypes 的值类型。 */
export type KitNodeComponent = NodeTypes[string];

/** 节点图标：Tabler 图标组件（`@tabler/icons-react`），也接受同签名的任意 SVG 组件。 */
export type KitIcon = ComponentType<{ size?: number | string; stroke?: number | string; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/**
 * 生成源输入槽（design §4）。
 * REQ-toonflow-canvas `refRoles` 里只会出现这些值；`prompt` 表示该文本参考拼进提示词。
 */
export type Slot =
  | 'first_frame'
  | 'last_frame'
  | 'reference_images'
  | 'camera_prompt'
  | 'ref_audio'
  | 'reference_video'
  | 'prompt';

export const SLOTS: readonly Slot[] = [
  'first_frame', 'last_frame', 'reference_images', 'camera_prompt', 'ref_audio', 'reference_video', 'prompt',
];

/** 视频/图片生成的参考模式；可选值由生成源 input_schema 槽位决定（见 assembleInputs.availableModes）。 */
export type GenMode = 'text' | 'singleImage' | 'startEnd' | 'multiReference';

export const GEN_MODES: readonly GenMode[] = ['text', 'singleImage', 'startEnd', 'multiReference'];

export const GEN_MODE_LABELS: Record<GenMode, string> = {
  text: '文生',
  singleImage: '单图参考',
  startEnd: '首尾帧',
  multiReference: '多参考',
};

/**
 * 有序参考列表的一项（useNodeReferences 产出）。
 * `key` = `${sourceId}|${sourceHandle}`，即 design §4 的 edgeKey，`data.refOrder` / `data.refRoles` 都用它做键。
 */
export interface RefItem {
  key: string;
  sourceId: string;
  sourceHandle: string;
  /** 上游节点类型（如 `director3d`），assembleInputs 据此把机位文本分进 camera_prompt。 */
  sourceType?: string;
  /** 连到本节点的哪个输入口（通常是 `in`）。 */
  targetHandle?: string;
  edgeId?: string;
  dataType: Exclude<DataType, '*'>;
  /** STRING 为文本本身；媒体为 URL。上游暂无内容时为空串。 */
  value: string;
  label?: string;
  /** 缩略图 URL（图片即自身，视频取上游封面字段，没有则空）。 */
  thumb?: string;
  /** 显式槽位（来自 data.refRoles）。 */
  role?: Slot;
}

export interface ConnectSource {
  node: Node;
  port: PortDef;
}

/** 目标节点现有的一条入边（canConnect 附加规则用，如「图片+音频参考合计 ≤1」）。 */
export interface IncomingConnection {
  edge: Edge;
  node?: Node;
  port?: PortDef;
}

export interface ConnectContext {
  target: Node;
  /** 目标节点已有的入边（不含正在重连的那条）。 */
  incoming: IncomingConnection[];
  getNode: (id: string) => Node | undefined;
}

/** 节点数据中的 kit 追加字段（design §4，只追加不改旧键）。 */
export interface HistoryEntry {
  url: string;
  created_at: string;
  provider_id?: string;
  params?: Record<string, unknown>;
  prompt?: string;
}

export interface KitNodeData extends Record<string, unknown> {
  label?: string;
  /** 用户拖拽后的参考顺序（元素为 edgeKey）。 */
  refOrder?: string[];
  /** 显式槽位：edgeKey → Slot。 */
  refRoles?: Record<string, Slot>;
  /** 参考模式；为空时按参考数量自动匹配（autoMode）。 */
  mode?: GenMode | '';
  /** 生成历史；当前版本由 image_url / video_url / audio_url 指向。 */
  history?: HistoryEntry[];
}

/**
 * 节点定义（design §3）。重合节点沿用旧类型 id。
 * `component` 收到 React Flow 的 NodeProps。
 */
export interface NodeDef<D extends Record<string, unknown> = KitNodeData> {
  type: string;
  label: string;
  icon: KitIcon;
  category: NodeCategory;
  /** 静态端口；生成类节点只有一个 target `in` + 一个 source。 */
  ports: PortDef[];
  /** 动态端口（ext-node / custom 按 input_schema 渲染）；连线校验与参考解析优先用它。 */
  getPorts?: (data: D) => PortDef[];
  defaultData?: () => Partial<D> & Record<string, unknown>;
  /** React Flow 节点组件（与 <ReactFlow nodeTypes> 的值同型：NodeProps & {data:any; type:any}）。 */
  component: KitNodeComponent;
  /** 是否出现在工具栏 / 拖线菜单；缺省 true（`group` 等内部节点设 false）。 */
  inPalette?: boolean;
  /** 附加连线限制（基础类型校验通过后才调用；只在「接收端」节点上执行，同 Toonflow）。 */
  canConnect?: (src: ConnectSource, dst: PortDef, ctx: ConnectContext) => boolean;
  /** 默认卡片宽（px），缺省 220。 */
  width?: number;
  /** 覆盖默认的输出值读取（readOutputValue），返回 undefined 时回落默认映射。 */
  outputValue?: (data: D, portId: string, dataType: Exclude<DataType, '*'>) => string | undefined;
  description?: string;
}

export type AnyNodeDef = NodeDef<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** edgeKey 规则：`${sourceId}|${sourceHandle}`。 */
export function refKeyOf(sourceId: string, sourceHandle?: string | null): string {
  return `${sourceId}|${sourceHandle ?? ''}`;
}
