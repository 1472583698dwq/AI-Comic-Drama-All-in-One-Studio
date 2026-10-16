// -*- coding: utf-8 -*-
/**
 * 导演台预设同源常量 — 3D 舞台与画布 director3d 节点共用，避免两边各写各的导致选项断层。
 * 纯数据模块（不依赖 three），舞台与节点均从此 import。
 *
 * REQ-toonflow-canvas T3：真身已迁入 `./scene/presets.ts`（3D 场景共用模块），
 * 这里只做 re-export 保持旧 import 路径可用（同一个数组实例，导演包合并逻辑不受影响）。
 */
export {
  FRAMING_PRESETS,
  MOTION_PRESETS,
  POSE_PRESETS,
  CAST_LAYOUTS,
  framingShortLabel,
  motionShortLabel,
} from './scene/presets';
