// -*- coding: utf-8 -*-
/**
 * 时间线素材探测：真实时长（媒体元数据）+ 音频波形峰值（WebAudio 解码）。
 *
 * 两条原则：
 * 1. **不引入新依赖**：时长靠隐藏 `<video>/<audio>` 的 `loadedmetadata`，
 *    波形靠 `fetch → decodeAudioData`，全部用浏览器原生能力。
 * 2. **探测失败绝不阻塞主流程**：解码不了（无音轨 / 跨域 / 文件过大）就返回 null，
 *    画面上退化成一条低透明度装饰条，不给用户报错。
 *
 * 结果按 URL 在模块级缓存：同一素材在卡片态与全屏态之间来回切换不会重复探测。
 */
import { useEffect, useRef, useState } from 'react';
import { resolveMediaUrl } from '../../../utils/devOrigin';

const durationCache = new Map<string, number>();
const durationInFlight = new Set<string>();

export interface MediaProbeItem {
  url: string;
  kind: 'video' | 'audio';
}

/**
 * 批量探测素材时长（秒）。返回 `{ [url]: duration }`，未探测到的不出现在结果里。
 */
export function useMediaDurations(items: MediaProbeItem[]): Record<string, number> {
  const [durations, setDurations] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const it of items) {
      const cached = durationCache.get(it.url);
      if (cached) init[it.url] = cached;
    }
    return init;
  });
  const durationsRef = useRef<Record<string, number>>(durations);
  durationsRef.current = durations;
  const key = items.map((i) => `${i.kind}:${i.url}`).join('|');

  useEffect(() => {
    const pending = items.filter(
      (it) => it.url && !durationCache.has(it.url) && !durationInFlight.has(it.url) && !durationsRef.current[it.url],
    );
    if (!pending.length) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    for (const item of pending) {
      durationInFlight.add(item.url);
      const el = document.createElement(item.kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.muted = true;
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onError);
        el.removeAttribute('src');
        try {
          el.load();
        } catch {
          /* 卸载中的元素 load() 可能抛，无害 */
        }
        durationInFlight.delete(item.url);
      };
      const onMeta = () => {
        const d = Number(el.duration);
        if (Number.isFinite(d) && d > 0) {
          durationCache.set(item.url, d);
          if (!cancelled) setDurations((prev) => (prev[item.url] ? prev : { ...prev, [item.url]: d }));
        }
        cleanup();
      };
      const onError = () => cleanup();
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onError);
      el.src = resolveMediaUrl(item.url);
      cleanups.push(cleanup);
    }

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
    // key 覆盖了全部 url/kind 组合；items 每次渲染都是新数组，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return durations;
}

const peaksCache = new Map<string, number[] | null>();
const peaksInFlight = new Set<string>();
/** 单个素材的音频解码上限：超过就放弃波形（避免大文件把主线程/内存拖垮） */
const MAX_DECODE_BYTES = 40 * 1024 * 1024;
const TARGET_BARS = 260;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

async function decodePeaks(url: string): Promise<number[] | null> {
  const res = await fetch(resolveMediaUrl(url));
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_DECODE_BYTES) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;
  const decoded = await ctx.decodeAudioData(buf);
  const channel = decoded.getChannelData(0);
  if (!channel.length) return null;
  const bars = Math.max(40, Math.min(TARGET_BARS, Math.round(decoded.duration * 14)));
  const step = Math.max(1, Math.floor(channel.length / bars));
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const start = i * step;
    let peak = 0;
    // 稀疏采样：每 16 个样点取一个，波形观感不变但快一个量级
    for (let j = 0; j < step; j += 16) {
      const v = Math.abs(channel[start + j] || 0);
      if (v > peak) peak = v;
    }
    out.push(Math.min(1, peak * 1.6));
  }
  return out;
}

/**
 * 批量取音频峰值（0~1）。返回 `{ [url]: number[] | null }`：
 * null 表示「探测过但拿不到」（无音轨 / 解码失败 / 文件过大），调用方据此画装饰条。
 */
export function useWavePeaks(urls: string[]): Record<string, number[] | null> {
  const [peaks, setPeaks] = useState<Record<string, number[] | null>>(() => {
    const init: Record<string, number[] | null> = {};
    for (const u of urls) {
      if (peaksCache.has(u)) init[u] = peaksCache.get(u) as number[] | null;
    }
    return init;
  });
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;
  const key = urls.join('|');

  useEffect(() => {
    const pending = urls.filter((u) => u && !peaksCache.has(u) && !peaksInFlight.has(u) && peaksRef.current[u] === undefined);
    if (!pending.length) return;
    for (const url of pending) {
      peaksInFlight.add(url);
      decodePeaks(url)
        .then((result) => {
          peaksCache.set(url, result);
          // 无论本 effect 是否已被 cleanup 都要回写 state：之前 cancelled 时只写缓存，
          // state 停留在 undefined 且 effect 不会重跑 → 卡片态波形永远是平线，
          // 之后打开全屏才从缓存初始化出波形（实测不一致）。
          setPeaks((prev) => (prev[url] !== undefined ? prev : { ...prev, [url]: result }));
        })
        .catch((e) => {
          console.warn('[Timeline] 波形解码失败，退化为装饰条', url, e?.message || e);
          peaksCache.set(url, null);
          setPeaks((prev) => (prev[url] !== undefined ? prev : { ...prev, [url]: null }));
        })
        .finally(() => peaksInFlight.delete(url));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return peaks;
}
