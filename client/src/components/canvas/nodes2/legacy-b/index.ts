// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 独有节点换皮 B：注册 + 公共出口。
 * 类型 id / 数据键 / 端口 id 全部沿用旧节点；外观走 kit（NodeSkeleton / NodeHandles / FloatingToolbar / --cv-* / Tabler）。
 *
 * 工具栏归属（inPalette）与旧画布一致：这几类都不在核心工具栏里——
 *   brief / script-split / provider*：旧画布只经模板、Agent（canvas_create_node）或旧画布数据出现；
 *   custom / ext-node：经插件调色板行（ui-registry CustomNodeRow / ExtNodeRow → 宿主 createNode）创建，不进核心工具栏。
 *
 * 给 H1 的接口：
 *   - resolveDynamicPorts(node)：任意节点的实际端口（本目录按声明解析，其余走 kit 注册表）；
 *   - edgeInputPatch / collectDynamicInputs：上游值落到「声明的端口 id」（修 ext-node 媒体写成 image_url 的问题）；
 *   - providerPatchFor / providerKindMatches：生成源 `provider` 口向下游透传 provider_id / provider / model；
 *   - registerCustomNodeDefs：宿主刷新自定义节点列表时顺手登记（custom 的 getPorts 同步读这份缓存）。
 */
import './legacyB.css';
import { IconCode, IconNotebook, IconPlug, IconPuzzle, IconScript } from '@tabler/icons-react';
import { defineNode } from '../../kit/registry';
import type { AnyNodeDef, KitNodeComponent } from '../../kit/types';
import { BriefNode, ScriptSplitNode } from './BriefNodes';
import { CustomNode } from './CustomNode';
import { ExtNode } from './ExtNode';
import { ProviderNode } from './ProviderNode';
import { PROVIDER_KIND_META } from './model';
import {
  BRIEF_PORTS, CUSTOM_FALLBACK_INPUTS, SCRIPT_SPLIT_PORTS, customNodePorts, customOutputPorts, customOutputValue, extNodePorts,
  extOutputValue, providerKindOf, providerNodePorts, providerOutputValue, rejectProviderSource, type ProviderKind,
} from './ports';

const cmp = (c: unknown) => c as KitNodeComponent;

export const briefNodeDef = defineNode({
  type: 'brief',
  label: '灵感简报',
  icon: IconNotebook,
  category: 'text',
  ports: [...BRIEF_PORTS],
  component: cmp(BriefNode),
  inPalette: false,
  width: 300,
  description: '小说 / 策划简报，连到「剧本拆解」',
});

export const scriptSplitNodeDef = defineNode({
  type: 'script-split',
  label: '剧本拆解',
  icon: IconScript,
  category: 'text',
  ports: [...SCRIPT_SPLIT_PORTS],
  component: cmp(ScriptSplitNode),
  inPalette: false,
  canConnect: rejectProviderSource,
  width: 300,
  description: '简报 → 角色 / 分镜（split_novel_script）',
});

export const customNodeDef = defineNode({
  type: 'custom',
  label: '自定义节点',
  icon: IconCode,
  category: 'plugin',
  // 静态端口 = 未选节点时的兜底；实际端口一律按 input_schema（getPorts）
  ports: [...CUSTOM_FALLBACK_INPUTS, ...customOutputPorts('utility')],
  getPorts: (data: Record<string, unknown>) => customNodePorts(data),
  outputValue: (data: Record<string, unknown>, portId: string, dataType) => customOutputValue(data, portId, dataType),
  component: cmp(CustomNode),
  inPalette: false,
  canConnect: rejectProviderSource,
  width: 320,
  description: '一段代码即一节点（超分 / 处理），端口按 input_schema',
});

export const extNodeDef = defineNode({
  type: 'ext-node',
  label: '扩展节点',
  icon: IconPuzzle,
  category: 'plugin',
  ports: [],
  getPorts: (data: Record<string, unknown>) => extNodePorts(data),
  outputValue: (data: Record<string, unknown>, portId: string, dataType) => extOutputValue(data, portId, dataType),
  component: cmp(ExtNode),
  inPalette: false,
  canConnect: rejectProviderSource,
  width: 320,
  description: '插件声明的画布节点（canvas_nodes），端口按声明',
});

const PROVIDER_DEFS: ReadonlyArray<{ type: string; kind: ProviderKind | null; label: string }> = [
  { type: 'provider', kind: null, label: '生成源' },
  { type: 'provider-image', kind: 'image', label: PROVIDER_KIND_META.image.label },
  { type: 'provider-video', kind: 'video', label: PROVIDER_KIND_META.video.label },
  { type: 'provider-audio', kind: 'audio', label: PROVIDER_KIND_META.audio.label },
  { type: 'provider-llm', kind: 'llm', label: PROVIDER_KIND_META.llm.label },
];

export const providerNodeDefs: AnyNodeDef[] = PROVIDER_DEFS.map(({ type, kind, label }) => defineNode({
  type,
  label,
  icon: kind ? PROVIDER_KIND_META[kind].icon : IconPlug,
  category: 'tool',
  ports: providerNodePorts(type, null),
  getPorts: (data: Record<string, unknown>) => providerNodePorts(type, data),
  outputValue: (data: Record<string, unknown>, portId: string) => providerOutputValue(data, portId),
  // 带种类的生成源节点：新建时写上 kind（后端 engine 的 provider 分支按 data.kind 判断；provider-llm 旧的会落成 image）
  defaultData: kind ? () => ({ kind }) : undefined,
  component: cmp(ProviderNode),
  inPalette: false,
  canConnect: rejectProviderSource,
  width: 320,
  description: `选择${label}，经「生成源」输出口交给下游`,
}));

export const legacyBNodeDefs: AnyNodeDef[] = [briefNodeDef, scriptSplitNodeDef, customNodeDef, extNodeDef, ...providerNodeDefs];

export { BriefNode, ScriptSplitNode, CustomNode, ExtNode, ProviderNode, providerKindOf };
export {
  resolveDynamicPorts, findInputPort, extNodePorts, extSpecOf, customNodePorts, customDefOf, customOutputPorts, providerNodePorts,
  providerDefOf, providerIdOf, isProviderNodeType, isDynamicPortNodeType, portTypeToDataType, customSlotType, providerSlotType,
  rejectProviderSource, extOutputValue, customOutputValue, providerOutputValue, BRIEF_PORTS, SCRIPT_SPLIT_PORTS,
  CUSTOM_FALLBACK_INPUTS, type LegacyPortDef, type ProviderKind,
} from './ports';
export {
  edgeInputPatch, edgePortValue, collectDynamicInputs, dynamicInputStates, kindForPort, providerPatchFor, providerKindMatches,
  type PortInputState,
} from './inputs';
export {
  registerCustomNodeDef, registerCustomNodeDefs, getCustomNodeDef, clearCustomNodeDefs, loadCustomNodeList, loadCustomNodeDef,
  subscribeCustomNodeDefs, customNodeDefsVersion, type CustomNodeDefinition,
} from './customNodeDefs';
