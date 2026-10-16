// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 3D 导演节点注册（类型 id 沿用旧 `director3d`，输出口 `camera_prompt` 不变，新增 image / video）。
 * 宿主（H1）在 nodes2/index.ts 里 import 本文件即完成注册。
 */
import { IconCube3dSphere } from '@tabler/icons-react';
import { defineNode, type PortDef } from '../../kit';
import { DIRECTOR3D_WIDTH, Director3DNode } from './Director3DNode';
import { createDirector3DData } from './model';

export const DIRECTOR3D_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['STRING', 'IMAGE'], label: '文本、图片输入' },
  // 存量连线都用 camera_prompt，id 不能改
  { id: 'camera_prompt', type: 'source', dataType: 'STRING', label: '运镜提示词' },
  { id: 'image', type: 'source', dataType: 'IMAGE', label: '机位截图' },
  { id: 'video', type: 'source', dataType: 'VIDEO', label: '运镜视频' },
];

export const director3dNodeDef = defineNode({
  type: 'director3d',
  label: '3D 导演',
  icon: IconCube3dSphere,
  category: '3d',
  ports: DIRECTOR3D_PORTS,
  width: DIRECTOR3D_WIDTH,
  defaultData: createDirector3DData,
  component: Director3DNode,
  description: '节点内 3D 舞台：人偶摆姿势、景别 / 运镜预设、运镜关键帧；输出海螺运镜提示词、机位截图 PNG、运镜视频 MP4',
});

export { Director3DNode, DIRECTOR3D_WIDTH, PLAN_SOURCES } from './Director3DNode';
export * from './model';
export { useDirectorStage, stagePixelRatio, RELEASE_DELAY_MS, type DirectorStage, type StageStatus } from './useDirectorStage';
export { MAX_LIVE_STAGES, HARD_MAX_LIVE_STAGES, liveStageCount } from './stageBudget';
export { uploadStageBlob, uploadStageVideo } from './exportMedia';
