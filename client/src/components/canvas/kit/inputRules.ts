// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 参考列表规则常量 —— 与后端 `server/app/canvas/inputs.py`（R1–R7）逐条对应，改动须前后端同步。
 * 迁移相关的常量 / 函数直接复用 `../migrate.ts`（edgeKey、NEW_IN_PORT、PRIMARY_OUTPUT_PORT、LEGACY_SLOT_MAP…），不重复实现。
 */
import {
  IN_PORT_NODE_TYPES, LEGACY_SLOT_MAP, NEW_IN_PORT, PRIMARY_OUTPUT_PORT, PROVIDER_NODE_TYPES, edgeKey,
} from '../migrate';
import type { DataType, GenMode, Slot } from './types';

export { IN_PORT_NODE_TYPES, NEW_IN_PORT, PRIMARY_OUTPUT_PORT, PROVIDER_NODE_TYPES, edgeKey };

export type Kind = Exclude<DataType, '*'>;

/** 槽位 → 参考类型（inputs.SLOT_KIND）。 */
export const SLOT_KIND: Readonly<Record<Slot, Kind>> = Object.freeze({
  prompt: 'STRING',
  camera_prompt: 'STRING',
  first_frame: 'IMAGE',
  last_frame: 'IMAGE',
  reference_images: 'IMAGE',
  ref_audio: 'AUDIO',
  reference_video: 'VIDEO',
});

/**
 * 旧具名输入口 → 槽位（inputs.LEGACY_HANDLE_SLOTS）= migrate.LEGACY_SLOT_MAP + 后端多认的几个别名。
 * 迁移把表外口名原样写进 refRoles，这里也能归一。
 */
export const LEGACY_HANDLE_SLOTS: Readonly<Record<string, Slot>> = Object.freeze({
  ...(LEGACY_SLOT_MAP as Record<string, Slot>),
  brief: 'prompt',
  image_prompt: 'prompt',
  video_prompt: 'prompt',
  reference_image: 'reference_images',
  ref: 'reference_images',
  reference_audios: 'ref_audio',
  audios: 'ref_audio',
  reference_videos: 'reference_video',
  videos: 'reference_video',
});

export const GROUP_NODE_TYPE = 'group';

/** sourceHandle → 类型（inputs._SOURCE_HANDLE_KIND）。 */
export const SOURCE_HANDLE_KIND: Readonly<Record<string, Kind>> = Object.freeze({
  image: 'IMAGE', images: 'IMAGE', image_url: 'IMAGE', result_url: 'IMAGE',
  video: 'VIDEO', videos: 'VIDEO', video_url: 'VIDEO',
  audio: 'AUDIO', audios: 'AUDIO', audio_url: 'AUDIO',
  prompt: 'STRING', text: 'STRING', camera_prompt: 'STRING', brief: 'STRING',
  shot: 'STRING', shots: 'STRING', characters: 'STRING',
});

/** 来源节点类型 → 类型（inputs._SOURCE_TYPE_KIND）。 */
export const SOURCE_TYPE_KIND: Readonly<Record<string, Kind>> = Object.freeze({
  prompt: 'STRING', 'text-prompt': 'STRING', brief: 'STRING', 'script-split': 'STRING', director3d: 'STRING',
  image: 'IMAGE', 'generate-image': 'IMAGE', 'load-image': 'IMAGE', 'load-image-batch': 'IMAGE',
  'shot-card': 'IMAGE', 'comfy-workflow': 'IMAGE',
  video: 'VIDEO', 'video-node': 'VIDEO', 'video-legacy': 'VIDEO', 'load-video': 'VIDEO',
  audio: 'AUDIO', tts: 'AUDIO', voice: 'AUDIO', 'load-audio': 'AUDIO',
});

/** 各类型读取的数据键（inputs._TEXT_KEYS / _CAMERA_KEYS / _IMAGE_KEYS / _VIDEO_KEYS / _AUDIO_KEYS）。 */
export const TEXT_KEYS = ['prompt', 'text', 'brief', 'image_prompt', 'video_prompt'] as const;
export const CAMERA_KEYS = ['camera_prompt', 'minimax_camera_prompt'] as const;
export const VALUE_KEYS: Readonly<Record<Exclude<Kind, 'STRING'>, readonly string[]>> = Object.freeze({
  IMAGE: ['image_url', 'result_url', 'file_url', 'thumb_url'],
  VIDEO: ['video_url', 'file_url'],
  AUDIO: ['audio_url', 'file_url'],
});
/** 媒体最后的兜底键（inputs.source_values 的 fallback，不要求像 URL）。 */
export const FALLBACK_KEYS: Readonly<Record<Exclude<Kind, 'STRING'>, readonly string[]>> = Object.freeze({
  IMAGE: ['image', 'url'],
  VIDEO: ['video', 'url'],
  AUDIO: ['audio', 'url'],
});

/** 视频参考模式别名（inputs._VIDEO_MODE_ALIASES，含旧生成源模式 i2v/r2v/t2v）。 */
const VIDEO_MODE_ALIASES: Readonly<Record<string, GenMode>> = Object.freeze({
  text: 'text',
  singleimage: 'singleImage', single_image: 'singleImage', single: 'singleImage',
  startend: 'startEnd', start_end: 'startEnd', startendrequired: 'startEnd',
  endframeoptional: 'startEnd', first_last: 'startEnd', first_last_frame: 'startEnd',
  multireference: 'multiReference', multi_reference: 'multiReference', reference: 'multiReference',
  r2v: 'multiReference', t2v: 'text', i2v: 'singleImage',
});

/** 视频参考模式 → 生成源模式（inputs.PROVIDER_MODE_BY_VIDEO_MODE）。 */
export const PROVIDER_MODE_BY_VIDEO_MODE: Readonly<Record<GenMode, 't2v' | 'i2v' | 'r2v'>> = Object.freeze({
  text: 't2v', singleImage: 'i2v', startEnd: 'i2v', multiReference: 'r2v',
});

export const REF_TOKEN_RE = /\{\{ref (\d+)\}\}/g;

/** 槽位名归一：合法槽位原样返回，旧口名 / 复数别名映射到槽位，其余 undefined（inputs.normalize_slot）。 */
export function normalizeSlot(slot: unknown): Slot | undefined {
  if (typeof slot !== 'string') return undefined;
  const s = slot.trim();
  if (s in SLOT_KIND) return s as Slot;
  return LEGACY_HANDLE_SLOTS[s];
}

/** 视频模式归一；空 / 未知 → ''（自动）（inputs.normalize_video_mode）。 */
export function normalizeVideoMode(mode: unknown): GenMode | '' {
  if (typeof mode !== 'string') return '';
  return VIDEO_MODE_ALIASES[mode.trim().toLowerCase()] ?? '';
}

/** 节点自身文本：audio 取 text 优先，其余 prompt 优先（inputs.own_prompt）。 */
export function ownPromptOf(nodeType: string | undefined, data: Record<string, unknown> | undefined | null): string {
  const d = data || {};
  const keys = nodeType === 'audio' ? ['text', 'prompt'] : ['prompt', 'text'];
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** refOrder：数组，或 Toonflow 式 {in: [...]}（inputs.ref_order_of）。 */
export function refOrderOf(data: Record<string, unknown> | undefined | null): string[] {
  const d = data || {};
  let raw = d.refOrder ?? d.ref_order;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = (raw as Record<string, unknown>)[NEW_IN_PORT];
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

/** refRoles：只保留字符串键值（inputs.ref_roles_of）。 */
export function refRolesOf(data: Record<string, unknown> | undefined | null): Record<string, string> {
  const d = data || {};
  const raw = d.refRoles ?? d.ref_roles;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * R1：这条边是否按「参考列表」解析。provider* / group 来源不算；目标是 group 不算；
 * targetHandle == 'in'，或目标是 in 口节点类型且口为空 / 旧具名口（未迁移的旧画布）。
 */
export function isRefEdge(targetHandle: string | null | undefined, targetType: string | undefined, sourceType: string | undefined): boolean {
  if (targetType === GROUP_NODE_TYPE || sourceType === GROUP_NODE_TYPE) return false;
  if (sourceType && PROVIDER_NODE_TYPES.includes(sourceType)) return false;
  const th = (targetHandle ?? '').trim();
  if (th === NEW_IN_PORT) return true;
  return !!targetType && IN_PORT_NODE_TYPES.includes(targetType) && (th === '' || th in LEGACY_HANDLE_SLOTS);
}

/** 来自 3D 导演机位输出的文本（inputs._is_camera_source）。 */
export function isCameraSource(sourceType: string | undefined, sourceHandle: string | null | undefined): boolean {
  const sh = sourceHandle ?? '';
  if (sh === 'camera_prompt') return true;
  return sourceType === 'director3d' && ['', 'camera_prompt', 'prompt', 'text'].includes(sh);
}

export function looksLikeUrl(v: string): boolean {
  return /^(https?:|data:|blob:|\/)/.test(v);
}
