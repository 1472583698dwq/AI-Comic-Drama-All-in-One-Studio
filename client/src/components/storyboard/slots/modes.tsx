import type React from 'react';
import type { ModeDef, ProductionMode, ShotSlotContext } from './types';
import {
  ActionComic,
  ActionImageToVideo,
  ActionMotionComic,
  StatusComic,
  StatusImageToVideo,
  StatusMotionComic,
} from './modeParts';

/**
 * 制作模式 Slot（shot.modes）：模式定义（数据）+ 状态块/动作栏（展示件见 modeParts）。
 * 能力位 ModeCaps 是唯一口径：宿主与各 Tab 内所有按 productionMode 分支的
 * 条件收敛到 caps（canImage/canVideo/canTts/direct/needsFirstFrame/lockPreview），
 * 映射关系见各 when 与条件注释。新增第 4 种模式 = 加一个 def。
 */

export interface ModeSlotDef extends ModeDef {
  renderStatus: (ctx: ShotSlotContext) => React.ReactNode;
  renderAction: (ctx: ShotSlotContext) => React.ReactNode;
}

export const BUILTIN_MODES: ModeSlotDef[] = [
  {
    id: 'comic', label: '🎨 漫画制作', desc: '纯生图流 · 1/4抽定版', order: 10,
    caps: { canImage: true, canVideo: false, canTts: false, direct: false, needsFirstFrame: false, lockPreview: 'image' },
    inspectorTitle: '漫画分镜参数',
    renderStatus: (ctx) => <StatusComic ctx={ctx} />,
    renderAction: (ctx) => <ActionComic ctx={ctx} />,
  },
  {
    id: 'motion_comic', label: '🎬 漫剧制作', desc: '角色立绘直出视频', order: 20,
    caps: { canImage: false, canVideo: true, canTts: true, direct: true, needsFirstFrame: false, lockPreview: 'video' },
    inspectorTitle: '漫剧直出参数',
    renderAction: (ctx) => <ActionMotionComic ctx={ctx} />,
    renderStatus: (ctx) => <StatusMotionComic ctx={ctx} />,
  },
  {
    id: 'image_to_video', label: '⚡ 图生视频', desc: '首帧精控+I2V演化', order: 30,
    caps: { canImage: true, canVideo: true, canTts: true, direct: false, needsFirstFrame: true, lockPreview: null },
    inspectorTitle: '图生视频参数',
    renderStatus: (ctx) => <StatusImageToVideo ctx={ctx} />,
    renderAction: (ctx) => <ActionImageToVideo ctx={ctx} />,
  },
];

/** 取模式渲染定义（含 renderStatus/renderAction），未知 id 回退图生视频 */
export function getModeSlot(id: ProductionMode): ModeSlotDef {
  return (
    BUILTIN_MODES.find((m) => m.id === id) ||
    dynamicModes.get(id) ||
    BUILTIN_MODES[2]
  );
}

const dynamicModes = new Map<string, ModeSlotDef>();

/**
 * 注册动态制作模式（插件 slots/*.json 的 shot.modes）。
 * 渲染复用 inherit_render 指向的内置模式（状态块/动作栏），
 * caps/标题/顺序来自槽声明。unregisterDynamicModes 供重载时清理。
 */
export function registerDynamicMode(def: any): string {
  const inherit = BUILTIN_MODES.find((m) => m.id === def.inherit_render) || BUILTIN_MODES[2];
  const id = String(def.id);
  dynamicModes.set(id, {
    id: id as ProductionMode,
    label: String(def.label || id),
    desc: String(def.description || def.desc || ''),
    order: Number(def.order ?? 50),
    caps: { ...def.caps },
    inspectorTitle: String(def.label || id),
    renderStatus: inherit.renderStatus,
    renderAction: inherit.renderAction,
  });
  return id;
}

export function unregisterDynamicModes(ids: string[]) {
  for (const id of ids) dynamicModes.delete(id);
}
