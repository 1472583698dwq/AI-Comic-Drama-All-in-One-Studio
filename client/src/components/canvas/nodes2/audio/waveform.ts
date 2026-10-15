// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频波形（对照 Toonflow audioNode/audioWaveform.ts + audioPlayer.vue 的解码部分）。
 * 浏览器 WebAudio 完整解码后只保留峰值：先算 BASE_PEAKS 个原始峰值（未归一）并按 URL 缓存，
 * 绘制时再按需要的条数降采样 + 归一（节点内 128 条、截取弹窗更多），不引入任何波形库。
 */

/** 每个音频缓存的原始峰值个数（任意显示条数都从它降采样）。 */
export const BASE_PEAKS = 1024;
/** 节点内播放器的波形条数（Toonflow 同款 128）。 */
export const PLAYER_BARS = 128;

/**
 * Toonflow getWaveformPeaks：多声道取绝对值最大，按条数分桶，归一化到 0–1。
 * 极短音频复用当前样本填满显示条数（不插值、不合并声道，避免反相抵消）。
 */
export function getWaveformPeaks(channels: readonly Float32Array[], barCount = PLAYER_BARS): number[] {
  return normalize(rawPeaks(channels, barCount));
}

/** 原始峰值（未归一）。 */
export function rawPeaks(channels: readonly Float32Array[], barCount: number): number[] {
  if (!Number.isInteger(barCount) || barCount <= 0) throw new RangeError('波形条数必须为正整数');
  const peaks = Array<number>(barCount).fill(0);
  const sampleCount = channels.reduce((length, channel) => Math.max(length, channel.length), 0);
  for (let bar = 0; bar < barCount && sampleCount > 0; bar++) {
    const start = Math.floor((bar * sampleCount) / barCount);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * sampleCount) / barCount));
    let peak = 0;
    for (const channel of channels) {
      const stop = Math.min(end, channel.length);
      for (let i = start; i < stop; i++) {
        const amplitude = Math.abs(channel[i]);
        if (amplitude > peak && Number.isFinite(amplitude)) peak = amplitude;
      }
    }
    peaks[bar] = peak;
  }
  return peaks;
}

function normalize(peaks: number[]): number[] {
  const maximum = peaks.reduce((m, p) => (p > m ? p : m), 0);
  return maximum > 0 ? peaks.map((p) => p / maximum) : peaks;
}

/** 已有峰值降采样（max-pooling）到 barCount 条并归一化；条数多于源时按最近邻铺满。 */
export function resamplePeaks(peaks: readonly number[], barCount: number): number[] {
  if (!peaks.length || barCount <= 0) return [];
  const out = Array<number>(barCount).fill(0);
  const n = peaks.length;
  for (let bar = 0; bar < barCount; bar++) {
    const start = Math.floor((bar * n) / barCount);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * n) / barCount));
    let peak = 0;
    for (let i = start; i < Math.min(end, n); i++) if (peaks[i] > peak) peak = peaks[i];
    out[bar] = peak;
  }
  return normalize(out);
}

export interface DecodedWaveform {
  /** BASE_PEAKS 个原始峰值（未归一）。 */
  peaks: number[];
  /** 解码得到的时长（秒）；播放器拿不到元数据时兜底。 */
  duration: number;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null;
}

/** 当前环境能否用 WebAudio 解码（jsdom / 老浏览器没有时只播放、不画波形）。 */
export function canDecodeAudio(): boolean {
  return !!offlineCtor();
}

const CACHE_LIMIT = 24;
const cache = new Map<string, Promise<DecodedWaveform | null>>();

/**
 * 拉取并解码音频，返回峰值（按 URL 缓存，失败不缓存、返回 null）。
 * 浏览器能播放但解码不了的格式（Toonflow 同款处理）：仍保留播放，波形区提示不可用。
 */
export function decodeWaveform(url: string): Promise<DecodedWaveform | null> {
  const Ctor = offlineCtor();
  if (!url || !Ctor) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) {
    // LRU：命中的挪到最后
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const job = (async (): Promise<DecodedWaveform | null> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取音频（HTTP ${res.status}）`);
    const content = await res.arrayBuffer();
    // 与 Toonflow 一致：48k 单声道离线上下文只用来解码（decodeAudioData 会保留全部声道）
    const ctx = new Ctor(1, 1, 48000);
    const buffer = await ctx.decodeAudioData(content);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    return { peaks: rawPeaks(channels, BASE_PEAKS), duration: buffer.duration };
  })().catch(() => null);
  cache.set(url, job);
  void job.then((r) => { if (!r && cache.get(url) === job) cache.delete(url); });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return job;
}

/** 仅测试用：清空解码缓存。 */
export function clearWaveformCache(): void {
  cache.clear();
}

/** `m:ss`（Toonflow audioPlayer formatTime）。 */
export function formatTime(value: number): string {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** `m:ss.cc`（Toonflow audioClipEditor formatTime，截取用）。 */
export function formatPreciseTime(value: number): string {
  const safe = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 100);
  return `${Math.floor(safe / 6000)}:${((safe % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}
