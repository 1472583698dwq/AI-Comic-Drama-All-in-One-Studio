// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频素材处理 → 新节点（截帧 / 提取音轨 / 分离音视频 / 截取片段）。
 *
 * 语义照 Toonflow videoPlayer.captureFrame 与 videoActions.process：处理结果落成**新节点**、放在源节点右侧、**不连线**、原视频保留；
 * 标题 `${源标题} · 当前帧/首帧/尾帧/音轨/静音视频/0.00–1.00 秒`。处理本身走后端 /media/ops/*（services/mediaOps.ts）。
 * 新节点数据沿用 MiniMax 键：图片 image_url（+image/url）、音频 audio_url（+audio/url）、视频 video_url（+video/url）。
 */
import type { Node } from '@xyflow/react';
import type { NewNodeSpec } from '../../kit/hostContext';
import {
  extractAudio, extractFrame, splitAv, trimMedia,
  type AudioResult, type FrameResult, type TrimResult, type VideoResult,
} from '../../../../services/mediaOps';
import { videoPatch } from './media';

export type FrameAtCommand = 'current' | 'first' | 'last';
export type VideoAction = 'extractAudio' | 'separate' | 'trim';

export const FRAME_LABELS: Record<FrameAtCommand, string> = { current: '当前帧', first: '首帧', last: '尾帧' };
export const ACTION_LABELS: Record<VideoAction, string> = { extractAudio: '提取音轨', separate: '分离音视频', trim: '截取片段' };

function baseLabel(label: string | undefined, fallback = '视频'): string {
  return (label || '').trim() || fallback;
}

export function imageNodeSpec(label: string, url: string, extra: Record<string, unknown> = {}): NewNodeSpec {
  return { type: 'load-image', data: { label, image_url: url, image: url, url, ...extra } };
}

export function audioNodeSpec(label: string, res: Pick<AudioResult, 'url' | 'duration'>, extra: Record<string, unknown> = {}): NewNodeSpec {
  return { type: 'load-audio', data: { label, audio_url: res.url, audio: res.url, url: res.url, duration: res.duration, ...extra } };
}

export function videoNodeSpec(label: string, res: Pick<VideoResult, 'url'> & Partial<VideoResult>, extra: Record<string, unknown> = {}): NewNodeSpec {
  const data: Record<string, unknown> = { label, ...videoPatch(res.url), ...extra };
  if (res.duration) data.duration = res.duration;
  if (res.width && res.height) { data.width = res.width; data.height = res.height; }
  return { type: 'load-video', data };
}

/** 截帧 → 一个图片节点。 */
export function frameNodeSpec(sourceLabel: string | undefined, at: FrameAtCommand, res: Pick<FrameResult, 'url' | 'width' | 'height' | 'time'>, sourceUrl?: string): NewNodeSpec {
  return imageNodeSpec(`${baseLabel(sourceLabel)} · ${FRAME_LABELS[at]}`, res.url, {
    width: res.width,
    height: res.height,
    frame_time: res.time,
    ...(sourceUrl ? { source_video: sourceUrl } : {}),
  });
}

/** 提取音轨 → 一个音频节点。 */
export function extractAudioSpecs(sourceLabel: string | undefined, res: Pick<AudioResult, 'url' | 'duration'>): NewNodeSpec[] {
  return [audioNodeSpec(`${baseLabel(sourceLabel)} · 音轨`, res)];
}

/** 分离音视频 → 静音视频 + 音频（顺序同 Toonflow requiredTypes：视频在上、音频在下）。 */
export function separateSpecs(sourceLabel: string | undefined, res: { video: Pick<VideoResult, 'url'> & Partial<VideoResult>; audio: Pick<AudioResult, 'url' | 'duration'> }): NewNodeSpec[] {
  const base = baseLabel(sourceLabel);
  return [videoNodeSpec(`${base} · 静音视频`, res.video), audioNodeSpec(`${base} · 音轨`, res.audio)];
}

/** 截取片段 → 一个视频节点。 */
export function trimSpecs(sourceLabel: string | undefined, res: Pick<VideoResult, 'url'> & Partial<VideoResult>, start: number, end: number): NewNodeSpec[] {
  return [videoNodeSpec(`${baseLabel(sourceLabel)} · ${start.toFixed(2)}–${end.toFixed(2)} 秒`, res, { trim_start: start, trim_end: end })];
}

/** 截帧：current 用播放头时间（后端在结尾 0.05s 内自动改取末帧）。 */
export async function captureFrameSpec(videoUrl: string, at: FrameAtCommand, currentTime: number, sourceLabel?: string): Promise<NewNodeSpec> {
  const res = at === 'current'
    ? await extractFrame(videoUrl, 'time', Math.max(0, currentTime || 0))
    : await extractFrame(videoUrl, at);
  return frameNodeSpec(sourceLabel, at, res, videoUrl);
}

/** 提取音轨 / 分离音视频 / 截取片段 → 新节点规格。 */
export async function runVideoAction(action: VideoAction, videoUrl: string, sourceLabel: string | undefined, range?: { start: number; end: number }): Promise<NewNodeSpec[]> {
  if (action === 'extractAudio') return extractAudioSpecs(sourceLabel, await extractAudio(videoUrl));
  if (action === 'separate') return separateSpecs(sourceLabel, await splitAv(videoUrl));
  if (!range || !(range.end > range.start)) throw new Error('请选择有效的起止时间');
  const res = (await trimMedia(videoUrl, range.start, range.end)) as TrimResult & VideoResult;
  return trimSpecs(sourceLabel, res, range.start, range.end);
}

// ———————————————————————————— 摆放 ————————————————————————————

type NodeLike = Pick<Node, 'id' | 'position' | 'parentId' | 'width' | 'height' | 'measured'>;

function sizeOf(n: NodeLike, fallback: { w: number; h: number }): { w: number; h: number } {
  return { w: (n.measured?.width ?? n.width ?? fallback.w) as number, h: (n.measured?.height ?? n.height ?? fallback.h) as number };
}

/**
 * Toonflow 摆放：x = 源节点右缘 + gapX；y 从源节点顶部开始，与右侧已有节点重叠就往下挪到其下方 + gapY；
 * 多个产物竖排、间隔 stepY。只处理顶层节点（源节点在分组里时返回 undefined，交给宿主 createNodes 摆放）。
 */
export function placeBeside(
  nodes: readonly NodeLike[],
  anchorId: string,
  opts: { count: number; width: number; height: number; gapX: number; gapY: number; stepY: number },
): { x: number; y: number }[] | undefined {
  const anchor = nodes.find((n) => n.id === anchorId);
  if (!anchor || anchor.parentId) return undefined;
  const a = sizeOf(anchor, { w: 240, h: 240 });
  const x = anchor.position.x + a.w + opts.gapX;
  const totalH = Math.max(opts.height, opts.stepY * (opts.count - 1) + opts.height);
  let y = anchor.position.y;
  const others = nodes.filter((n) => n.id !== anchorId && !n.parentId).sort((p, q) => p.position.y - q.position.y);
  for (const o of others) {
    const s = sizeOf(o, { w: 220, h: 200 });
    const p = o.position;
    if (p.x < x + opts.width && p.x + s.w > x && p.y < y + totalH && p.y + s.h > y) y = p.y + s.h + opts.gapY;
  }
  return Array.from({ length: opts.count }, (_, i) => ({ x, y: y + i * opts.stepY }));
}

/** 给规格补上 Toonflow 式坐标（截帧：gapX 40 / gapY 24 / 高 300；音视频处理：gapX 80 / gapY 40 / 每个 320）。 */
export function withPlacement(nodes: readonly NodeLike[], anchorId: string, specs: NewNodeSpec[], kind: 'frame' | 'action', aspect?: number): NewNodeSpec[] {
  const width = Math.max(kind === 'frame' ? 198 : 320, aspect && Number.isFinite(aspect) && aspect > 0 ? 240 * aspect + 18 : 0);
  const pos = placeBeside(nodes, anchorId, kind === 'frame'
    ? { count: specs.length, width, height: 300, gapX: 40, gapY: 24, stepY: 300 }
    : { count: specs.length, width, height: 320, gapX: 80, gapY: 40, stepY: 320 });
  if (!pos) return specs;
  return specs.map((s, i) => ({ ...s, position: s.position ?? pos[i] }));
}
