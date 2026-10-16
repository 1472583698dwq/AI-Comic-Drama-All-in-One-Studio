// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 独有节点换皮 A 注册入口（design §6.2）：
 *   shot-card（分镜卡）、comfy-workflow（ComfyUI 工作流）、timeline（时间线）、timeline-export（剪映导出）、export（导出草稿）。
 * 类型 id、data 键、端口 id 与旧组件一致，逻辑不变；外观走 kit（NodeSkeleton / NodeHandles / FloatingToolbar / --cv-* / Tabler）。
 * 工具栏成员同现状：export、timeline 在 CORE_LIBRARY 里（inPalette），其余三个是兼容旧画布的节点（不进工具栏）。
 * 宿主（H1）在 nodes2/index.ts 里 `import './legacy-a'` 即完成注册。
 */
import { IconCpu, IconFileExport, IconMovie, IconSlideshow, IconTimeline } from '@tabler/icons-react';
import { defineNode } from '../../kit';
import {
  COMFY_WORKFLOW_PORTS, EXPORT_PORTS, SHOT_CARD_OUTPUTS, SHOT_CARD_STATIC_INPUTS, TIMELINE_EXPORT_PORTS, TIMELINE_PORTS, shotCardPorts,
} from './ports';
import { SHOT_CARD_TYPE, SHOT_CARD_WIDTH, ShotCardNode, type ShotCardData } from './ShotCardNode';
import { COMFY_WORKFLOW_TYPE, COMFY_WORKFLOW_WIDTH, ComfyWorkflowNode } from './ComfyWorkflowNode';
import { TIMELINE_TYPE, TIMELINE_WIDTH, TimelineNode } from './TimelineNode';
import { TIMELINE_EXPORT_TYPE, TIMELINE_EXPORT_WIDTH, TimelineExportNode } from './TimelineExportNode';
import { EXPORT_TYPE, EXPORT_WIDTH, ExportNode } from './ExportNode';

export const shotCardNodeDef = defineNode({
  type: SHOT_CARD_TYPE,
  label: '分镜卡',
  icon: IconSlideshow,
  category: 'image',
  ports: [...SHOT_CARD_STATIC_INPUTS, ...SHOT_CARD_OUTPUTS],
  // 动态输入口：生成源 input_schema（data.providerDef || data.definition）里带 x-handle / uri 数组的属性
  getPorts: (data: ShotCardData) => shotCardPorts(data),
  // 标题缺省按「分镜卡 #镜号」现算，新建时不写死 label
  defaultData: () => ({ label: '' }),
  component: ShotCardNode,
  inPalette: false,
  width: SHOT_CARD_WIDTH,
  description: '分镜首帧 / 生视频（兼容旧画布）',
});

export const comfyWorkflowNodeDef = defineNode({
  type: COMFY_WORKFLOW_TYPE,
  label: 'ComfyUI 工作流',
  icon: IconCpu,
  category: 'image',
  ports: [...COMFY_WORKFLOW_PORTS],
  component: ComfyWorkflowNode,
  inPalette: false,
  width: COMFY_WORKFLOW_WIDTH,
  description: '选择 ComfyUI 工作流、填暴露参数生成（兼容旧画布）',
});

export const timelineNodeDef = defineNode({
  type: TIMELINE_TYPE,
  label: '时间线',
  icon: IconTimeline,
  category: 'output',
  ports: [...TIMELINE_PORTS],
  // 成片名前缀缺省取项目名（旧组件 `data.label || project.title`），新建时不写死 label
  defaultData: () => ({ label: '' }),
  component: TimelineNode,
  inPalette: true,
  width: TIMELINE_WIDTH,
  description: '多段合片 · 轻剪辑（合视频）',
});

export const timelineExportNodeDef = defineNode({
  type: TIMELINE_EXPORT_TYPE,
  label: '剪映导出',
  icon: IconMovie,
  category: 'output',
  ports: [...TIMELINE_EXPORT_PORTS],
  component: TimelineExportNode,
  inPalette: false,
  width: TIMELINE_EXPORT_WIDTH,
  description: '聚合分镜一键导出剪映草稿（兼容旧画布）',
});

export const exportNodeDef = defineNode({
  type: EXPORT_TYPE,
  label: '导出草稿',
  icon: IconFileExport,
  category: 'output',
  ports: [...EXPORT_PORTS],
  component: ExportNode,
  inPalette: true,
  width: EXPORT_WIDTH,
  description: '一键生成剪映工程',
});

/** 本目录注册的全部节点类型。 */
export const LEGACY_A_TYPES = [SHOT_CARD_TYPE, COMFY_WORKFLOW_TYPE, TIMELINE_TYPE, TIMELINE_EXPORT_TYPE, EXPORT_TYPE] as const;

export { ShotCardNode } from './ShotCardNode';
export { ComfyWorkflowNode } from './ComfyWorkflowNode';
export { TimelineNode } from './TimelineNode';
export { TimelineExportNode } from './TimelineExportNode';
export { ExportNode } from './ExportNode';
export {
  exposedDefaults, exposedKey, upstreamMedia, openExportModal, openWorkflowInspector, OPEN_EXPORT_MODAL_EVENT, OPEN_WORKFLOW_INSPECTOR_EVENT,
  type ExposedInput,
} from './helpers';
export { ShotWriteBackControls, type ShotWriteBackControlsProps } from './ShotWriteBackControl';
export { TimelineCardStrip, type TimelineCardStripProps } from './TimelineCardStrip';
export { TimelineCardPreview } from './TimelineCardPreview';
export * from './ports';
