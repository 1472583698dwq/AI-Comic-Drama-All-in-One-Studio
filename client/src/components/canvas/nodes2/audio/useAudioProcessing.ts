// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频「截取 / 变速」（对照 Toonflow audioNode/components/audioActions.vue）。
 * Toonflow 在浏览器里跑 ffmpeg；这里改走后端 /media/ops/trim、/media/ops/speed（T2），
 * 产物落成新的「音频」节点（load-audio，经 useKitNodeActions.createNodes 放在右侧），原音频不动。
 * 取消 = 停止等待并丢弃结果（后端处理不可中断，产物留在 storage/generated/media_ops）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { speedAudio, trimMedia } from '../../../../services/mediaOps';
import { toast } from '../../../../stores/useDialogStore';
import type { KitNodeActions } from '../../kit/hostContext';
import { loadAudioPatch } from './media';
import { formatPreciseTime } from './waveform';

export type AudioActionMode = 'trim' | 'speed';

/** 变速范围（后端 atempo 0.5–2.0）。 */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;
/** 截取最短片段（后端 MIN_SPAN_SECONDS）。 */
export const MIN_TRIM_SPAN = 0.05;

export function isValidSpeed(rate: number): boolean {
  return Number.isFinite(rate) && rate >= SPEED_MIN && rate <= SPEED_MAX;
}

export function isValidTrim(start: number, end: number, duration: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && duration > 0
    && start >= 0 && end <= duration + 1e-6 && end - start >= MIN_TRIM_SPAN;
}

/** 新节点标题（Toonflow：`${label} · 1.50×`）。 */
export function derivedLabel(label: string, op: AudioActionMode, a: number, b?: number): string {
  const base = (label || '音频').trim() || '音频';
  return op === 'speed' ? `${base} · ${a.toFixed(2)}×` : `${base} · 截取 ${formatPreciseTime(a)}–${formatPreciseTime(b ?? a)}`;
}

export interface AudioProcessingOptions {
  /** 原音频的存储地址（data 里的 /storage/...，传给后端） */
  sourceUrl: string;
  /** 新节点标题前缀（当前节点名） */
  label: string;
  actions: Pick<KitNodeActions, 'createNodes'>;
  /** 开始处理 / 打开前（暂停播放器） */
  onBeforeRun?: () => void;
}

export interface AudioProcessing {
  mode: AudioActionMode | null;
  processing: boolean;
  error: string | null;
  open: (mode: AudioActionMode) => void;
  /** 处理中 = 取消；否则关闭 */
  close: () => void;
  runSpeed: (rate: number) => Promise<string[] | null>;
  runTrim: (start: number, end: number) => Promise<string[] | null>;
}

export function useAudioProcessing({ sourceUrl, label, actions, onBeforeRun }: AudioProcessingOptions): AudioProcessing {
  const [mode, setMode] = useState<AudioActionMode | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const live = useRef(true);
  const beforeRef = useRef(onBeforeRun);
  beforeRef.current = onBeforeRun;
  const labelRef = useRef(label);
  labelRef.current = label;

  const cancel = useCallback(() => {
    token.current++;
    setProcessing(false);
  }, []);

  // 换了音频：放弃进行中的处理并关闭（Toonflow watch(file.url, reset)）
  useEffect(() => {
    token.current++;
    setProcessing(false);
    setMode(null);
    setError(null);
  }, [sourceUrl]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      token.current++;
    };
  }, []);

  const open = useCallback((m: AudioActionMode) => {
    if (!sourceUrl) return;
    beforeRef.current?.();
    setError(null);
    setMode(m);
  }, [sourceUrl]);

  const close = useCallback(() => {
    if (processing) {
      cancel();
      return;
    }
    setError(null);
    setMode(null);
  }, [processing, cancel]);

  const run = useCallback(async (job: () => Promise<{ url: string; duration?: number }>, title: string, op: AudioActionMode, extra: Record<string, unknown>) => {
    if (!sourceUrl) return null;
    const my = ++token.current;
    beforeRef.current?.();
    setProcessing(true);
    setError(null);
    try {
      const res = await job();
      if (my !== token.current || !live.current) return null;
      const ids = actions.createNodes(
        [{ type: 'load-audio', data: { label: title, ...loadAudioPatch(res.url, { duration: res.duration, derived_from: { url: sourceUrl, op, ...extra } }) } }],
        { placement: 'right' },
      );
      setMode(null);
      toast.success('已在右侧生成新的音频节点');
      return ids;
    } catch (e: any) {
      if (my !== token.current || !live.current) return null;
      const msg = String(e?.message || e || '音频处理失败');
      setError(msg);
      toast.error(msg, op === 'speed' ? '音频变速失败' : '音频截取失败');
      return null;
    } finally {
      if (my === token.current && live.current) setProcessing(false);
    }
  }, [sourceUrl, actions]);

  const runSpeed = useCallback((rate: number) => {
    if (!isValidSpeed(rate)) return Promise.resolve(null);
    const r = Math.round(rate * 100) / 100;
    return run(() => speedAudio(sourceUrl, r), derivedLabel(labelRef.current, 'speed', r), 'speed', { rate: r });
  }, [run, sourceUrl]);

  const runTrim = useCallback((start: number, end: number) => {
    const s = Math.max(0, Math.round(start * 1000) / 1000);
    const e = Math.round(end * 1000) / 1000;
    if (!(e - s >= MIN_TRIM_SPAN)) return Promise.resolve(null);
    return run(() => trimMedia(sourceUrl, s, e), derivedLabel(labelRef.current, 'trim', s, e), 'trim', { start: s, end: e });
  }, [run, sourceUrl]);

  return { mode, processing, error, open, close, runSpeed, runTrim };
}
