// -*- coding: utf-8 -*-
/**
 * 生成源能力细分 — 创建/编辑/列表/选择器共用的唯一口径。
 * 后端 ProviderDefinition.capabilities 为空时（内置源/存量源），按 input_schema 插槽推断。
 */
export interface CapabilityOption { id: string; label: string; desc: string }

export const CAPABILITIES_BY_KIND: Record<string, CapabilityOption[]> = {
  image: [
    { id: 't2i', label: '文生图', desc: '纯文本生成图像' },
    { id: 'i2i', label: '图生图', desc: '垫图重绘/变体' },
    { id: 'reference', label: '参考生图', desc: '角色/物体参考约束' },
  ],
  video: [
    { id: 't2v', label: '文生视频', desc: '纯文本生成视频' },
    { id: 'i2v', label: '图生视频', desc: '首帧图转动态视频' },
    { id: 'r2v', label: '参考生视频', desc: '多参考图约束生成' },
    { id: 'start_end', label: '首尾帧', desc: '首尾帧插值过渡' },
  ],
  audio: [
    { id: 'tts', label: '文本配音', desc: '文本转语音' },
    { id: 'clone', label: '声音复刻', desc: '参考音频复刻音色' },
  ],
  llm: [
    { id: 'chat', label: '对话生成', desc: '文本对话/剧本扩写' },
  ],
};

export function capabilityLabel(kind: string, id: string): string {
  return CAPABILITIES_BY_KIND[kind]?.find((c) => c.id === id)?.label || id;
}

const IMAGE_KEYS = ['image', 'images', 'reference_images', 'reference_image', 'reference', 'init_image', 'first_frame'];

function hasAnyKey(props: Record<string, any>, keys: string[]): boolean {
  const lower = new Set(Object.keys(props || {}).map((k) => String(k).toLowerCase()));
  return keys.some((k) => lower.has(k.toLowerCase()));
}

/** 按 input_schema 插槽推断能力（内置源/未声明源的回退口径） */
export function inferCapabilities(def: any): string[] {
  const kind = def?.kind || 'image';
  const props = def?.input_schema?.properties || {};
  if (kind === 'image') {
    const caps = ['t2i'];
    if (hasAnyKey(props, IMAGE_KEYS)) caps.push('i2i', 'reference');
    return caps;
  }
  if (kind === 'video') {
    const caps: string[] = [];
    // prompt 槽（文本把手）存在即支持文生
    const hasPrompt = hasAnyKey(props, ['prompt', 'text']);
    if (hasPrompt || !Object.keys(props).length) caps.push('t2v');
    if (hasAnyKey(props, ['first_frame', 'first_frame_url', 'image', 'init_image'])) caps.push('i2v');
    if (hasAnyKey(props, ['reference_images', 'reference_image', 'reference', 'reference_videos'])) caps.push('r2v');
    if (hasAnyKey(props, ['last_frame', 'last_frame_url', 'end_frame'])) caps.push('start_end');
    if (!caps.length) caps.push('t2v');
    return caps;
  }
  if (kind === 'audio') {
    const caps = ['tts'];
    if (hasAnyKey(props, ['reference_audio', 'reference_audios', 'ref_audio', 'audio'])) caps.push('clone');
    return caps;
  }
  return ['chat'];
}

/** 显式声明优先，否则推断；保证非空 */
export function getCapabilities(def: any): string[] {
  const explicit = Array.isArray(def?.capabilities) ? def.capabilities.filter(Boolean) : [];
  if (explicit.length) return explicit;
  return inferCapabilities(def);
}

export function hasCapability(def: any, cap: string): boolean {
  return getCapabilities(def).includes(cap);
}
