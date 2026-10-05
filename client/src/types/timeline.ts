// -*- coding: utf-8 -*-
/**
 * 画布时间线节点（简易合视频轻剪辑）的前后端统一契约 + 纯逻辑工具。
 *
 * 这一份类型是**唯一**的片段结构：前端写入 `node.data.clips`，随画布快照持久化，
 * 后端 `server/app/media/timeline_merge.py` 按同名键消费。改这里必须同步改那边
 * （`normalize_clips` 的字段名与 `MIN_CLIP_SECONDS`）。
 */

/** 片段最短时长（秒）：与后端 MIN_CLIP_SECONDS 对齐，裁剪不得短于它 */
export const MIN_CLIP_SECONDS = 0.4;

/**
 * 时长尚未探测到时的**布局占位秒数**（只影响画多宽，不参与时间码/合片时长）。
 *
 * 没有它就会出现真实缺陷：上游刚连进来 / 刚添加的片段 duration 还是 0，
 * `clipSpan` 也是 0 → 片段被画成 30px 的空白块，紧贴「+」按钮，
 * 用户看到的现象就是「加了多个视频只显示一个」。
 */
export const PENDING_PLACEHOLDER_SECONDS = 4;

/** 片段最短可视宽度（px）：再窄就连缩略图都看不见，也无法点选 */
export const MIN_CLIP_PX = 64;

export interface TimelineClip {
  /** 前端生成的稳定 id：拖拽列表 key 与选中态依赖它 */
  id: string;
  /** /storage/... 或 http(s)；存原值，展示时经 resolveMediaUrl 回源 */
  url: string;
  /** 片段显示名（素材名 / 文件名） */
  name: string;
  /** 源素材完整时长（秒），由前端 video/audio 元数据得到；0 表示尚未探测 */
  duration: number;
  /** 入点（秒） */
  in: number;
  /** 出点（秒） */
  out: number;
  kind: 'video' | 'audio';
}

/** 导出目标：本轮只支持 MP4 与剪映工程两项（XML/达芬奇/Pr/FCP 未开放） */
export type TimelineExportTarget = 'mp4' | 'jianyin';

let seq = 0;

export function newClipId(prefix = 'clip'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/** 裁剪后时长（秒） */
export function clipSpan(clip: TimelineClip): number {
  return Math.max(0, round3((clip.out || 0) - (clip.in || 0)));
}

export function timelineTotal(clips: TimelineClip[]): number {
  return round3(clips.reduce((sum, c) => sum + clipSpan(c), 0));
}

/** 时长还没探测到（duration 未回填）：界面必须给明确占位，不能画成空块 */
export function isClipPending(clip: TimelineClip): boolean {
  return clip.duration <= 0;
}

export function round3(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;
}

/**
 * 规整单个片段：出点越界钳到素材时长，入点不小于 0 且不越过出点，
 * 并保证裁剪后不短于 MIN_CLIP_SECONDS（不够则顶到最短，而不是产出非法片段）。
 *
 * duration 为 0 表示「时长还没探测到」：此时不强制最短时长（否则新加的片段会被
 * 顶成 0.4s 的假片段），只保留原样的入出点，等媒体元数据回填后走 withDuration。
 */
export function clampClip(clip: TimelineClip): TimelineClip {
  const duration = Math.max(0, round3(clip.duration || 0));
  if (duration <= 0) {
    const cin = Math.max(0, round3(clip.in || 0));
    return { ...clip, duration: 0, in: cin, out: Math.max(cin, round3(clip.out || 0)) };
  }
  let cin = Math.max(0, clip.in || 0);
  let cout = clip.out > 0 ? clip.out : duration;
  cout = Math.min(cout, duration);
  if (cout - cin < MIN_CLIP_SECONDS) cin = Math.max(0, cout - MIN_CLIP_SECONDS);
  return { ...clip, duration, in: round3(cin), out: round3(cout) };
}

/**
 * 媒体元数据回来时回填时长：首次回填按整段入列（in=0/out=duration），
 * 已探测过的片段只做钳制，不覆盖用户已经裁好的入出点。
 */
export function withDuration(clip: TimelineClip, duration: number): TimelineClip {
  const d = Math.max(0, round3(duration));
  if (d <= 0) return clip;
  if (clip.duration > 0) return clampClip(clip);
  return clampClip({ ...clip, duration: d, in: 0, out: d });
}

export function clampClips(clips: TimelineClip[]): TimelineClip[] {
  return clips.map(clampClip);
}

/** 新片段追加：按 url + kind 去重，避免同一上游反复连线时重复入列 */
export function appendClip(clips: TimelineClip[], clip: TimelineClip): TimelineClip[] {
  if (!clip.url) return clips;
  if (clips.some((c) => c.url === clip.url && c.kind === clip.kind)) return clips;
  return [...clips, clampClip(clip)];
}

export function removeClip(clips: TimelineClip[], id: string): TimelineClip[] {
  return clips.filter((c) => c.id !== id);
}

/** 拖拽换序：把 from 位置的片段插到 to 位置（to 为插入前的目标下标） */
export function reorderClips(clips: TimelineClip[], from: number, to: number): TimelineClip[] {
  if (from === to || from < 0 || from >= clips.length) return clips;
  const next = clips.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/** 时间码：默认 mm:ss 保留 1 位小数；withHours 时输出 hh:mm:ss（全屏编辑器用） */
export function formatTimecode(seconds: number, opts: { withHours?: boolean; decimals?: number } = {}): string {
  const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const decimals = opts.decimals ?? (opts.withHours ? 0 : 1);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(total * factor) / factor;
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, '0');
  if (opts.withHours) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
  }
  return `${String(h * 60 + m).padStart(2, '0')}:${ss}`;
}

/** 标尺可选档位（秒） */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/**
 * 标尺档位按**像素间距**选，而不是按总时长。
 * 之前按总时长固定 2s 一档，窄卡片上 2s×16px=32px 放不下 "00:02"，
 * 时间码直接挤成一团 —— 这是实测到的显示 bug。
 */
export function rulerStepForPx(pxPerSecond: number, minGapPx = 76): number {
  for (const step of RULER_STEPS) {
    if (step * pxPerSecond >= minGapPx) return step;
  }
  return 900;
}

/** 标尺刻度：0 起步、按档位均匀分布（不追加总时长刻度，避免右端半个标签被裁） */
export function rulerTicksForPx(totalSeconds: number, pxPerSecond: number, minGapPx = 76): number[] {
  const step = rulerStepForPx(pxPerSecond, minGapPx);
  const ticks: number[] = [];
  for (let t = 0; t <= totalSeconds + 1e-6; t += step) ticks.push(round3(t));
  return ticks;
}

/** 片段在当前时间线上的起始时刻（按顺序累加裁剪后时长） */
export function clipStartAt(clips: TimelineClip[], index: number): number {
  let acc = 0;
  for (let i = 0; i < index && i < clips.length; i += 1) acc += clipSpan(clips[i]);
  return round3(acc);
}

/** 播放头时刻命中哪个片段（-1 表示落在末尾空白） */
export function clipIndexAt(clips: TimelineClip[], time: number): number {
  let acc = 0;
  for (let i = 0; i < clips.length; i += 1) {
    const span = clipSpan(clips[i]);
    if (time >= acc && time < acc + span) return i;
    acc += span;
  }
  return -1;
}

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg)(\?|#|$)/i;

/**
 * 由素材 URL 判定片段类型；图片等非法素材返回 null（合片内核只接受视频/音频，
 * 素材选择器允许「全部」时用户可能选到图片，这里负责筛掉并给出提示）。
 */
export function mediaKindFromUrl(url: string): 'video' | 'audio' | null {
  if (!url) return null;
  if (VIDEO_EXT.test(url)) return 'video';
  if (AUDIO_EXT.test(url)) return 'audio';
  return null;
}

/** 素材 URL → 默认片段（时长待媒体元数据回填） */
export function clipFromUrl(url: string, opts: { kind?: 'video' | 'audio'; name?: string; duration?: number } = {}): TimelineClip {
  const name = opts.name || url.split('/').pop() || url;
  const kind = opts.kind || 'video';
  const duration = Math.max(0, round3(opts.duration || 0));
  return clampClip({
    id: newClipId(kind === 'audio' ? 'aclip' : 'clip'),
    url,
    name,
    duration,
    in: 0,
    out: duration > 0 ? duration : 0,
    kind,
  });
}
