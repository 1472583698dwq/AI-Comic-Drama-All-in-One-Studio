// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N3：视频节点 `load-video` + 视频生成节点 `video`（类型 id 沿用旧画布，design §2.1）。
 * import 本模块即完成注册；H1 在 nodes2/index.ts 里 `import './video'` 即可。
 */
import { IconCameraAi, IconVideo } from '@tabler/icons-react';
import { defineNode } from '../../kit/registry';
import type { PortDef } from '../../kit/types';
import { LoadVideoNode, LOAD_VIDEO_LABEL } from './LoadVideoNode';
import { VideoGenNode, VIDEO_GEN_LABEL } from './VideoGenNode';

/** Toonflow videoNode handles：只有输出口。 */
export const LOAD_VIDEO_PORTS: PortDef[] = [{ id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' }];

/** Toonflow videoGenerationNode handles：单一输入口 `in` + 视频输出。 */
export const VIDEO_GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'], label: '图片、视频、音频、文本输入' },
  { id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' },
];

export const loadVideoNodeDef = defineNode({
  type: 'load-video',
  label: LOAD_VIDEO_LABEL,
  icon: IconVideo,
  category: 'video',
  ports: LOAD_VIDEO_PORTS,
  component: LoadVideoNode,
  defaultData: () => ({ video_url: '' }),
  description: '导入、播放视频素材；截帧、提取音轨、分离音视频、截取片段',
});

export const videoGenNodeDef = defineNode({
  type: 'video',
  label: VIDEO_GEN_LABEL,
  icon: IconCameraAi,
  category: 'video',
  ports: VIDEO_GEN_PORTS,
  component: VideoGenNode,
  defaultData: () => ({ prompt: '', mode: '', refOrder: [], refRoles: {}, history: [], smart_plan: false }),
  description: '按参考素材与提示词生成视频（首尾帧 / 单图 / 多参考 / 文生，模式自动匹配）',
});

export { LoadVideoNode, VideoGenNode };
export { VideoPlayer, FrameCaptureButton, type VideoPlayerHandle, type VideoMeta } from './VideoPlayer';
export { VideoActionsDialog } from './VideoActionsDialog';
export { useVideoOps } from './useVideoOps';
export { useVideoTaskRecovery, taskIdOf, shouldResume } from './useTaskRecovery';
export {
  frameNodeSpec, extractAudioSpecs, separateSpecs, trimSpecs, captureFrameSpec, runVideoAction, placeBeside, withPlacement,
  FRAME_LABELS, ACTION_LABELS, type FrameAtCommand, type VideoAction,
} from './videoOps';
export {
  quickParamsOf, schemaDefaults, carryOverParams, paramsPatch, paramsSummary, effectiveMode, resolveAutoMode, modeOptions, dataForRun,
  RATIO_OPTIONS, DEFAULT_RATIO,
} from './videoParams';
export { videoUrlOf, videoPatch, normalizeMediaUrl, uploadVideoFile, parseMediaDrop, isVideoDrop, MAX_VIDEO_BYTES } from './media';
export { VIDEO_MODE_LABELS } from './VideoGenSettings';
