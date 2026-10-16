// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 按需加载 3D 舞台模块（three 体积大：节点模块本身只依赖纯数据的 scene/presets，
 * 舞台第一次挂载 / 第一次生成关键帧时才动态 import scene/stageCore + scene/camera）。
 * 单测里 mock 这个文件即可替换掉 WebGL 舞台（jsdom 没有 WebGL）。
 */
import type { MiniStage, MiniStageOptions } from '../../../director3d/scene/stageCore';
import type { CameraKeyframe, MotionKeyframeOptions, StageCameraState } from '../../../director3d/scene/camera';

export type { MiniStage, MiniStageOptions };

export interface StageModule {
  createMiniStage: (container: HTMLElement, opts?: MiniStageOptions) => MiniStage;
  framingCameraState: (framing: string, focalLengthMm?: number, rollDeg?: number) => StageCameraState;
  sampleCameraKeyframes: (keyframes: CameraKeyframe[], time: number) => StageCameraState;
  normalizeKeyframes: (keyframes: CameraKeyframe[]) => CameraKeyframe[];
  cameraKeyframesDuration: (keyframes: CameraKeyframe[]) => number;
  motionPresetKeyframes: (motion: string, base: StageCameraState, opts?: MotionKeyframeOptions) => CameraKeyframe[];
  pickRecorderMimeType: () => string;
}

let pending: Promise<StageModule> | null = null;

export function loadStageModule(): Promise<StageModule> {
  if (!pending) {
    pending = Promise.all([
      import('../../../director3d/scene/stageCore'),
      import('../../../director3d/scene/camera'),
    ]).then(([core, cam]) => ({
      createMiniStage: core.createMiniStage,
      pickRecorderMimeType: core.pickRecorderMimeType,
      framingCameraState: cam.framingCameraState,
      sampleCameraKeyframes: cam.sampleCameraKeyframes,
      normalizeKeyframes: cam.normalizeKeyframes,
      cameraKeyframesDuration: cam.cameraKeyframesDuration,
      motionPresetKeyframes: cam.motionPresetKeyframes,
    })).catch((e) => {
      pending = null; // 下次再试（如网络抖动导致分包加载失败）
      throw e;
    });
  }
  return pending;
}
