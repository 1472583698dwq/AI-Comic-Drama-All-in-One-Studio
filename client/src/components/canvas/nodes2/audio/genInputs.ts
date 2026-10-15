// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频生成节点的纯函数（台词取值、旧参考音频、生成源音频槽、最终入参），供节点组件与测试复用。
 */
import type { AssembledInputs } from '../../kit/assembleInputs';
import type { ProviderDefLike } from './audioSettings';

function hasText(v: unknown): v is string {
  return typeof v === 'string' && !!v.trim();
}

/** 输入框里显示的台词：text 有内容用 text，否则 prompt（同 ownPromptOf 的优先级，但保留原始空白）。 */
export function audioPromptValue(d: Record<string, unknown>): string {
  if (hasText(d.text)) return d.text;
  if (hasText(d.prompt)) return d.prompt;
  return typeof d.text === 'string' ? d.text : '';
}

/** 旧画布遗留在节点数据里的参考音频（没有连线参考时执行器仍会读取它）。 */
export function legacyRefAudioOf(d: Record<string, unknown>): string {
  for (const k of ['ref_audio', 'reference_audio', 'ref_audio_path']) {
    const v = d[k];
    if (hasText(v)) return v.trim();
  }
  const list = d.reference_audios;
  if (Array.isArray(list)) {
    const first = list.find(hasText);
    if (first) return first.trim();
  }
  return '';
}

/** 生成源 input_schema 是否声明了音频槽（参考音色）。 */
export function declaresAudioSlot(def: ProviderDefLike): boolean {
  const props = (def?.input_schema?.properties ?? {}) as Record<string, any>;
  return Object.entries(props).some(([k, v]) => {
    const h = String(v?.['x-handle'] ?? '').toLowerCase();
    const uri = v?.format === 'uri' || v?.items?.format === 'uri';
    return h === 'audio' || h === 'audios' || h === 'reference_audios' || v?.['x-slot'] === 'ref_audio' || (uri && /audio/i.test(k));
  });
}

/**
 * 音频生成的最终入参：台词以 `text` 下发（provider_* MCP 工具与执行器都是 text 优先），
 * 参考音频额外镜像到 `ref_audio`（MCP 工具只认 ref_audio / ref_audio_path，生成源槽位名如 reference_audio 它不读）。
 */
export function audioGenerationInputs(a: AssembledInputs): AssembledInputs {
  const args: Record<string, string | string[]> = { ...a.args, text: a.prompt };
  if (a.ref_audio[0]) args.ref_audio = a.ref_audio[0];
  return { ...a, args };
}
