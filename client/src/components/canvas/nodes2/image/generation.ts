// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片生成调用的入参整理（纯函数）。
 *
 * kit/useGeneration 的直接生成走 executeAgentNode：它把「节点 data + 本次 override」合并后，
 * 先铺 data.params / provider_params，再按生成源声明的入参键从合并结果里补缺。所以：
 * - 节点里残留的旧槽位键（reference_images / first_frame / img_* … 旧控制台写进 data 的）必须先剔掉，
 *   否则断开连线后旧图仍会被发出去——新模型里媒体只来自参考列表（assembleInputs）；
 * - 本次参数要同时写进 params / provider_params（否则持久化的旧 params 会盖过本次参数，如局部重绘的比例）；
 * - text / idea 是旧控制台的提示词镜像，剔掉后执行器用组装后的提示词。
 */
import type { AssetSlotDef } from '../../providerSkills';

const LEGACY_MEDIA_KEYS = [
  'reference', 'reference_image', 'reference_images', 'first_frame', 'first_frame_url', 'last_frame', 'last_frame_url',
  'camera_prompt', 'ref_audio', 'reference_audios', 'reference_videos', 'dynamic_inputs',
];

export function generationData(
  data: Record<string, unknown>,
  slots: readonly Pick<AssetSlotDef, 'key' | 'originalKey'>[] | null | undefined,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  delete out.text;
  delete out.idea;
  for (const k of LEGACY_MEDIA_KEYS) delete out[k];
  for (const s of slots || []) {
    delete out[s.key];
    if (s.originalKey) delete out[s.originalKey];
  }
  for (const k of Object.keys(out)) if (k.startsWith('img_')) delete out[k];
  out.params = params;
  out.provider_params = params;
  return { ...out, ...extra };
}

/** 运行结果是否真的落地（取消 / 失败时 useGeneration 返回 null，或 patch 为空）。 */
export function generationLanded(res: { url?: string; patch: Record<string, unknown> } | null | undefined): res is { url: string; patch: Record<string, unknown> } {
  return !!res && !!res.url && !!res.patch && Array.isArray(res.patch.history);
}

/** agent_state.running 超过这个时长视为上次中断的陈旧状态（刷新页面后不会再有结果回来）。 */
export const STALE_RUNNING_MS = 20 * 60 * 1000;

export function isAgentRunning(state: unknown, now = Date.now()): boolean {
  const s = state as { status?: string; updated_at?: string } | null | undefined;
  if (s?.status !== 'running') return false;
  const t = s.updated_at ? Date.parse(s.updated_at) : NaN;
  return !Number.isNaN(t) && now - t < STALE_RUNNING_MS;
}

export function agentError(state: unknown): string {
  const s = state as { status?: string; error?: string } | null | undefined;
  return s?.status === 'failed' ? String(s.error || '生成失败') : '';
}
