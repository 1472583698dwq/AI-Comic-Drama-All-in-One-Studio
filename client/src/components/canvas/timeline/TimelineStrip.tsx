// -*- coding: utf-8 -*-
/**
 * 时间线条（标尺 + 片段条 + 波形 + 播放头）——卡片态与全屏编辑器**共用同一份交互**。
 *
 * 三条实测教训（都已在此实现里落死）：
 * 1. **拖拽用 pointer 事件自实现，不用 HTML5 DnD**。片段块画在 React Flow 节点里，
 *    浏览器原生 DnD 与画布的 pointer 处理互相抢事件，表现就是「有时候拖不动」。
 * 2. **时长为 0 的片段必须给占位宽度和明确外观**。上游刚连进来 / 刚添加的片段
 *    duration 还没回填，`clipSpan` 为 0；画成窄空白块后用户会以为「第二个视频没加进来」。
 * 3. **标尺档位按像素间距选**，否则窄卡片上时间码会挤成一团。
 *
 * 数据纪律：拖拽/裁剪过程中只改本地 draft，**指针抬起时才 onChange 回写**，
 * 避免拖动期间每帧触发画布全量快照写盘。
 * 播放预览是**静音**的（最小集不含音量控制）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Music, Plus, Volume2, VolumeX } from 'lucide-react';
import {
  MIN_CLIP_PX,
  MIN_CLIP_SECONDS,
  PENDING_PLACEHOLDER_SECONDS,
  clampClips,
  clipIndexAt,
  clipSpan,
  clipStartAt,
  formatTimecode,
  reorderClips,
  round3,
  rulerStepForPx,
  rulerTicksForPx,
  timelineTotal,
  withDuration,
  type TimelineClip,
} from '../../../types/timeline';
import { resolveMediaUrl } from '../../../utils/devOrigin';
import { useMediaDurations, useWavePeaks } from './mediaProbe';

const TRIM_HANDLE_PX = 10;
const DRAG_THRESHOLD_PX = 5;
const WAVE_HEIGHT = 34;
const WAVE_COLOR = 'rgba(34, 211, 238, 0.8)';
const WAVE_IDLE_COLOR = 'rgba(34, 211, 238, 0.22)';
const PLAYHEAD_COLOR = '#FF3B5C';

interface LayoutItem {
  clip: TimelineClip;
  left: number;
  width: number;
  pending: boolean;
}

/** 轨道头的一格静音开关（参考图左下角「视频音轨 / 音频音轨」双轨声音控制） */
const MuteToggle: React.FC<{
  variant: 'card' | 'studio';
  muted: boolean;
  label: string;
  onToggle: () => void;
  tone: string;
}> = ({ variant, muted, label, onToggle, tone }) => (
  <button
    onClick={onToggle}
    onPointerDown={(e) => e.stopPropagation()}
    aria-pressed={!muted}
    aria-label={`${label}：${muted ? '已静音' : '有声'}`}
    title={`${label}${muted ? '：已静音（点击开启声音）' : '：有声（点击静音）'}`}
    className={`flex flex-col items-center justify-center gap-[1px] w-full h-full rounded-md transition-colors hover:bg-white/5 ${
      muted ? '[color:var(--color-text-muted)]' : tone
    }`}
  >
    {muted ? <VolumeX className="w-3.5 h-3.5" strokeWidth={1.7} /> : <Volume2 className="w-3.5 h-3.5" strokeWidth={1.7} />}
    {variant === 'studio' && <span className="text-[8.5px] leading-none">{label.replace('音轨', '')}</span>}
  </button>
);

export interface TimelineStripProps {
  clips: TimelineClip[];
  onChange: (clips: TimelineClip[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  playhead: number;
  onSeek: (seconds: number) => void;
  playing: boolean;
  pxPerSecond: number;
  variant?: 'card' | 'studio';
  /** 末尾「+」：未提供时不可添加（只读展示） */
  onAdd?: () => void;
  /** 常显裁剪把手（卡片工具行的「裁剪」开关打开时） */
  showTrimHandles?: boolean;
  /** 左侧轨道头（视频轨 / 音频轨各自的静音开关）；给了 onToggle* 才渲染 */
  videoMuted?: boolean;
  audioMuted?: boolean;
  onToggleVideoMute?: () => void;
  onToggleAudioMute?: () => void;
  /** 右键片段回调（全屏编辑器：弹出「属性」菜单）；未提供时走浏览器默认行为 */
  onClipContextMenu?: (clip: TimelineClip, pos: { x: number; y: number }) => void;
}

export const TimelineStrip: React.FC<TimelineStripProps> = ({
  clips,
  onChange,
  selectedId,
  onSelect,
  playhead,
  onSeek,
  playing,
  pxPerSecond,
  variant = 'card',
  onAdd,
  showTrimHandles = false,
  videoMuted = true,
  audioMuted = true,
  onToggleVideoMute,
  onToggleAudioMute,
  onClipContextMenu,
}) => {
  const [draft, setDraft] = useState<TimelineClip[] | null>(null);
  const [dragging, setDragging] = useState<{ index: number; from: number; to: number } | null>(null);
  const [trims, setTrims] = useState<{ id: string; text: string } | null>(null);
  const trimRef = useRef<{ id: string; edge: 'in' | 'out'; startX: number; baseIn: number; baseOut: number } | null>(null);
  const dragRef = useRef<{ index: number; startX: number; startY: number; moved: boolean; to: number } | null>(null);
  const mediaRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // 缩略图平均亮度（0..1）→ 时长标签自动黑/白：亮画面（白云、雪地等）用深色字，
  // 暗画面用浅色字；跨域取不到帧时保持默认浅色字 + 深色渐变底。
  const [thumbLum, setThumbLum] = useState<Record<string, number>>({});

  const sampleThumbLum = useCallback((id: string, el: HTMLVideoElement) => {
    try {
      if (el.readyState < 2 || !el.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 9;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(el, 0, 0, 16, 9);
      const data = ctx.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const lum = sum / (data.length / 4) / 255;
      setThumbLum((prev) => (Math.abs((prev[id] ?? -1) - lum) < 0.01 ? prev : { ...prev, [id]: lum }));
    } catch {
      /* 画布被跨域污染等：拿不到亮度就维持默认样式 */
    }
  }, []);

  const shown = draft || clips;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  /** 最短可拖时长：既满足合片内核的 0.4s，也保证块宽够抓手（否则块会小到没法再拖） */
  const minSpan = Math.max(MIN_CLIP_SECONDS, 48 / pxPerSecond);

  const layout: LayoutItem[] = useMemo(() => {
    let acc = 0;
    return shown.map((clip) => {
      const real = clipSpan(clip);
      const pending = real <= 0;
      const width = Math.max(real > 0 ? real : PENDING_PLACEHOLDER_SECONDS, minSpan);
      const item: LayoutItem = { clip, left: acc, width, pending };
      acc += width;
      return item;
    });
  }, [shown, minSpan]);

  const layoutTotal = layout.length ? layout[layout.length - 1].left + layout[layout.length - 1].width : 0;
  const frameTotal = Math.max(layoutTotal, variant === 'studio' ? 12 : 8);
  // 末尾「+」按钮需要 10px 间距 + 40px 宽：之前只留 20px 余量，按钮会被滚动边界裁掉
  // （实测表现为「+」被挤成一条竖缝）。有 onAdd 时必须把这两项宽度都预留出来。
  const contentWidth = Math.max(200, frameTotal * pxPerSecond + (onAdd ? 60 : 20));

  /**
   * 屏幕坐标 → 本组件 CSS 坐标。
   *
   * 卡片活在 ReactFlow 的缩放视口里：`clientX` 与 `getBoundingClientRect()` 都是**屏幕**像素，
   * 而被缩放到 0.5 倍时，屏幕 1px 只等于 CSS 2px。不换算就会让「拖动 1px 裁剪量翻倍」
   * （实测表现就是拖起来很怪 / 位置跳）。
   */
  const clientToCss = useCallback(
    (clientX: number): number | null => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return null;
      return (clientX - rect.left) / (rect.width / contentWidth);
    },
    [contentWidth],
  );

  // 真实时长回填：duration 还是 0 的片段探测到元数据后一次性补全（整段入列）
  const probeItems = useMemo(
    () => shown.filter((c) => c.duration <= 0).map((c) => ({ url: c.url, kind: c.kind })),
    [shown],
  );
  const durations = useMediaDurations(probeItems);
  useEffect(() => {
    const current = clipsRef.current;
    const pending = current.filter((c) => c.duration <= 0 && durations[c.url]);
    if (!pending.length) return;
    onChange(current.map((c) => (c.duration <= 0 && durations[c.url] ? withDuration(c, durations[c.url]) : c)));
  }, [durations, onChange]);

  const peaks = useWavePeaks(shown.map((c) => c.url));

  // 波形绘制：单画布整行绘制（逐片段取该片段 in..out 区间的峰值切片）
  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(contentWidth));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(WAVE_HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${WAVE_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);

    layout.forEach((item, i) => {
      const x = item.left * pxPerSecond;
      const blockW = Math.max(2, item.width * pxPerSecond);
      const data = peaks[item.clip.url];
      if (item.pending) {
        // 占位：虚线，明确「还在读」
        ctx.strokeStyle = WAVE_IDLE_COLOR;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 2, WAVE_HEIGHT / 2);
        ctx.lineTo(x + blockW - 2, WAVE_HEIGHT / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      if (!data || !data.length) {
        ctx.fillStyle = WAVE_IDLE_COLOR;
        ctx.fillRect(x + 1, WAVE_HEIGHT / 2 - 1, Math.max(1, blockW - 2), 2);
        return;
      }
      const dur = item.clip.duration || item.clip.out || 1;
      const from = Math.max(0, Math.floor((data.length * item.clip.in) / dur));
      const to = Math.max(from + 1, Math.ceil((data.length * item.clip.out) / dur));
      const slice = data.slice(from, to);
      // 降采样到「一块最多 ~1 根柱子/像素」：直接按 slice 长度排柱会在片段被裁短后
      // 铺出比块还宽的一排柱子，压到相邻片段下面去（实测现象）。
      const bars = Math.max(1, Math.min(slice.length, Math.floor(blockW)));
      const step = slice.length / bars;
      const barW = blockW / bars;
      ctx.fillStyle = WAVE_COLOR;
      for (let b = 0; b < bars; b += 1) {
        let peak = 0;
        const s0 = Math.floor(b * step);
        const s1 = Math.min(slice.length, Math.floor((b + 1) * step));
        for (let s = s0; s < s1; s += 1) {
          if (slice[s] > peak) peak = slice[s];
        }
        const barH = Math.max(1, peak * (WAVE_HEIGHT - 8));
        ctx.fillRect(x + b * barW, (WAVE_HEIGHT - barH) / 2, Math.max(1, barW - 0.5), barH);
      }
      if (i > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(Math.round(x), 0, 1, WAVE_HEIGHT);
      }
    });
  }, [layout, peaks, pxPerSecond, contentWidth]);

  // 播放预览：只让播放头命中的那一段真正播出画面（静音），其余立刻暂停
  useEffect(() => {
    if (!playing) {
      Object.values(mediaRefs.current).forEach((el) => {
        if (el && !el.paused) el.pause();
      });
      return;
    }
    const active = clipIndexAt(shown, playhead);
    shown.forEach((clip, i) => {
      const el = mediaRefs.current[clip.id];
      if (!el) return;
      if (i === active) {
        const local = clip.in + (playhead - clipStartAt(shown, i));
        if (Math.abs(el.currentTime - local) > 0.3) el.currentTime = Math.max(0, local);
        if (el.paused) el.play().catch(() => undefined);
      } else if (!el.paused) {
        el.pause();
      }
    });
  }, [playing, playhead, shown]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const xCss = clientToCss(clientX);
      if (xCss === null) return;
      const total = Math.max(timelineTotal(clipsRef.current), 0.001);
      onSeek(Math.max(0, Math.min(xCss / pxPerSecond, total)));
    },
    [clientToCss, onSeek, pxPerSecond],
  );

  // ── 入出点裁剪（pointer capture，抬起才提交） ─────────────────
  const startTrim = (e: React.PointerEvent, item: LayoutItem, edge: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    if (item.pending) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    trimRef.current = { id: item.clip.id, edge, startX: e.clientX, baseIn: item.clip.in, baseOut: item.clip.out };
    setDraft(clipsRef.current.map((c) => ({ ...c })));
    onSelect(item.clip.id);
  };

  const moveTrim = (e: React.PointerEvent) => {
    const t = trimRef.current;
    if (!t) return;
    // 起止都换算到 CSS 坐标再求差：缩放视口下直接用 clientX 差值会偏大 1/scale 倍
    const nowX = clientToCss(e.clientX);
    const startX = clientToCss(t.startX);
    if (nowX === null || startX === null) return;
    const delta = (nowX - startX) / pxPerSecond;
    const base = draft || clipsRef.current;
    const next = base.map((c) => {
      if (c.id !== t.id) return c;
      if (t.edge === 'in') {
        const nextIn = Math.max(0, Math.min(t.baseIn + delta, c.out - minSpan));
        setTrims({ id: c.id, text: `入点 ${formatTimecode(nextIn)}` });
        return { ...c, in: round3(nextIn) };
      }
      const upper = c.duration > 0 ? c.duration : Math.max(t.baseOut + delta, minSpan);
      const nextOut = Math.max(c.in + minSpan, Math.min(t.baseOut + delta, upper));
      setTrims({ id: c.id, text: `出点 ${formatTimecode(nextOut)}` });
      return { ...c, out: round3(nextOut) };
    });
    setDraft(next);
  };

  const endTrim = () => {
    if (!trimRef.current) return;
    trimRef.current = null;
    setTrims(null);
    const pending = draft;
    if (pending) onChange(clampClips(pending));
    setDraft(null);
  };

  // ── 换序 / 点选（pointer 自实现，不用 HTML5 DnD） ───────────────
  const dropIndexFromClientX = useCallback(
    (clientX: number): number => {
      const x = clientToCss(clientX);
      if (x === null) return layout.length;
      for (let i = 0; i < layout.length; i += 1) {
        const center = (layout[i].left + layout[i].width / 2) * pxPerSecond;
        if (x < center) return i;
      }
      return layout.length;
    },
    [clientToCss, layout, pxPerSecond],
  );

  const startDrag = (e: React.PointerEvent, item: LayoutItem, index: number) => {
    if (e.button !== 0) return;
    // 拦住冒泡：否则条容器上的「点空白取消选中」会先跑，选中态会闪一下
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { index, startX: e.clientX, startY: e.clientY, moved: false, to: index };
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      const far = Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD_PX || Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD_PX;
      if (!far) return;
      d.moved = true;
      onSelect(layout[d.index]?.clip.id ?? null);
    }
    d.to = dropIndexFromClientX(e.clientX);
    setDragging({ index: d.index, from: layout[d.index]?.left ?? 0, to: d.to });
  };

  const endDrag = (e?: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    if (!d) return;
    if (d.moved) {
      const base = clipsRef.current;
      const target = d.to > d.index ? d.to - 1 : d.to;
      const next = reorderClips(base, d.index, target);
      if (next !== base) onChange(next);
      return;
    }
    // 没超过阈值 = 单击：选中并把播放头移到该片段起点
    const item = layout[d.index];
    if (item) {
      onSelect(item.clip.id);
      onSeek(clipStartAt(clipsRef.current, d.index));
    }
    e?.stopPropagation();
  };

  const dropX = dragging ? (dragging.to >= layout.length ? layoutTotal : layout[dragging.to]?.left ?? layoutTotal) : null;
  const trimBubbleX = trims
    ? (() => {
        const idx = layout.findIndex((it) => it.clip.id === trims.id);
        if (idx < 0) return 0;
        return (layout[idx].left + layout[idx].width / 2) * pxPerSecond;
      })()
    : 0;
  const blockHeight = variant === 'studio' ? 'h-[64px]' : 'h-[62px]';
  const rulerDecimals = rulerStepForPx(frameTotal, pxPerSecond) < 1 ? 1 : 0;
  const showHeads = !!(onToggleVideoMute || onToggleAudioMute);

  return (
    <div className="select-none flex items-stretch gap-1.5">
      {/* 左侧轨道头：卡片态只有一个**整体**静音开关（纵跨两行）；全屏编辑器才分视频/音频两轨 */}
      {showHeads && (
        <div className="w-[30px] shrink-0 flex flex-col">
          <div className="h-[22px]" />
          {variant === 'card' ? (
            <div className="flex-1 flex items-center justify-center">
              <MuteToggle
                variant={variant}
                muted={videoMuted}
                label="整体音轨"
                onToggle={() => onToggleVideoMute?.()}
                tone="text-brand"
              />
            </div>
          ) : (
            <>
              <div className={`${blockHeight} flex items-center justify-center`}>
                <MuteToggle
                  variant={variant}
                  muted={videoMuted}
                  label="视频音轨"
                  onToggle={() => onToggleVideoMute?.()}
                  tone="text-orange-400"
                />
              </div>
              <div className="h-1" />
              <div className="flex items-center justify-center" style={{ height: WAVE_HEIGHT }}>
                <MuteToggle
                  variant={variant}
                  muted={audioMuted}
                  label="音频音轨"
                  onToggle={() => onToggleAudioMute?.()}
                  tone="text-cyan-400"
                />
              </div>
            </>
          )}
        </div>
      )}
      {/* overflow-y-hidden 必须显式写：只写 overflow-x-auto 时 y 轴会被计算成 auto，
          播放头/把手的负偏移就会撑出一个多余的竖向滚动条（实测在卡片右侧看到一条竖条） */}
      <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain">
      <div ref={contentRef} className="relative" style={{ width: contentWidth }}>
        {/* 标尺：点击/拖动定位播放头 */}
        <div
          className="relative h-[22px] cursor-pointer touch-none"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            seekFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekFromClientX(e.clientX);
          }}
          title="点击或拖动定位播放头"
        >
          {rulerTicksForPx(frameTotal, pxPerSecond).map((t) => (
            <div key={t} className="absolute top-0 h-full" style={{ left: t * pxPerSecond }}>
              <span className="block w-px h-[7px]" style={{ background: 'var(--color-border)' }} />
              <span className="block font-mono text-[10px] leading-[13px] whitespace-nowrap [color:var(--color-text-muted)]">
                {formatTimecode(t, { decimals: rulerDecimals })}
              </span>
            </div>
          ))}
          {/* 播放头在标尺上的延线（拖动把手在波形轨上） */}
          <span
            className="absolute bottom-0 top-0 w-[1.5px] pointer-events-none"
            style={{ left: playhead * pxPerSecond, background: PLAYHEAD_COLOR }}
          />
        </div>

        {/* 片段条 */}
        <div
          className={`relative ${blockHeight} rounded-xl border border-white/70 dark:border-white/12 overflow-hidden`}
          style={{ background: 'var(--color-surface-secondary)' }}
          onPointerDown={() => onSelect(null)}
        >
          {!shown.length && onAdd && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              className="absolute inset-1.5 rounded-lg border border-dashed border-white/70 dark:border-white/12 flex items-center justify-center gap-1.5 text-[11px] [color:var(--color-text-muted)] hover:border-brand/60 hover:text-brand hover:bg-brand/5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={1.8} />
              添加视频 / 音频素材
            </button>
          )}
          {!shown.length && !onAdd && (
            <div className="absolute inset-0 flex items-center justify-center text-[11px] [color:var(--color-text-muted)] px-3 text-center">
              从上游连入视频后再回来编辑
            </div>
          )}

          {layout.map((item, i) => {
            const { clip, pending } = item;
            const left = item.left * pxPerSecond;
            const width = Math.max(MIN_CLIP_PX, item.width * pxPerSecond);
            const isSelected = selectedId === clip.id;
            const isAudio = clip.kind === 'audio';
            const isDragged = dragging?.index === i;
            return (
              <div
                key={clip.id}
                onPointerDown={(e) => startDrag(e, item, i)}
                onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e)}
                onContextMenu={(e) => {
                  if (!onClipContextMenu) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onClipContextMenu(clip, { x: e.clientX, y: e.clientY });
                }}
                title={
                  pending
                    ? `${clip.name} · 正在读取时长…`
                    : `${clip.name} · ${formatTimecode(clip.in)} → ${formatTimecode(clip.out)}（拖两端裁剪，拖中间换序）`
                }
                className={`group absolute top-1 bottom-1 rounded-lg overflow-hidden border touch-none transition-[box-shadow,border-color] duration-150 ${
                  isSelected ? 'border-brand ring-1 ring-brand/60 shadow-lg shadow-brand/25' : 'border-white/70 dark:border-white/12 hover:border-brand/50'
                } ${isDragged ? 'opacity-50' : 'cursor-grab active:cursor-grabbing'}`}
                style={{ left, width, zIndex: isDragged ? 5 : isSelected ? 4 : 2 }}
              >
                {pending ? (
                  <div
                    className="w-full h-full flex flex-col items-center justify-center gap-1 px-1.5"
                    style={{ background: 'var(--color-surface-tertiary)' }}
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
                    <span className="w-full text-center text-[9.5px] leading-tight [color:var(--color-text-secondary)] truncate">
                      {clip.name}
                    </span>
                  </div>
                ) : isAudio ? (
                  <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--color-surface-tertiary)' }}>
                    <Music className="w-4 h-4 text-cyan-400/80" strokeWidth={1.7} />
                  </div>
                ) : (
                  <video
                    ref={(el) => {
                      mediaRefs.current[clip.id] = el;
                    }}
                    src={resolveMediaUrl(clip.url)}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedData={(e) => sampleThumbLum(clip.id, e.currentTarget)}
                    onCanPlay={(e) => sampleThumbLum(clip.id, e.currentTarget)}
                    className="w-full h-full object-cover pointer-events-none"
                  />
                )}

                {!pending && (
                  <>
                    {/* 时长标签自动黑/白：亮缩略图用深色字 + 白色渐变底，暗缩略图用浅色字 + 黑色渐变底 */}
                    {(() => {
                      const bright = (thumbLum[clip.id] ?? -1) > 0.55;
                      return (
                        <>
                          <div
                            className={`absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t pointer-events-none ${bright ? 'from-white/85' : 'from-black/85'} to-transparent`}
                          />
                          <span
                            className={`absolute right-1 bottom-0 font-mono text-[9.5px] leading-4 font-medium pointer-events-none ${
                              bright ? 'text-black/85' : 'text-white/90'
                            }`}
                          >
                            {formatTimecode(clipSpan(clip))}
                          </span>
                        </>
                      );
                    })()}
                    {isAudio && (
                      <span className="absolute left-1.5 top-0.5 text-[9px] text-white/70 pointer-events-none">音频</span>
                    )}
                    <div
                      onPointerDown={(e) => startTrim(e, item, 'in')}
                      onPointerMove={moveTrim}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                      className="absolute left-0 top-0 bottom-0 cursor-col-resize touch-none flex items-center justify-start"
                      style={{ width: TRIM_HANDLE_PX }}
                      title="拖动改入点"
                    >
                      <span
                        className={`w-[3px] h-7 rounded-full bg-white/80 transition-opacity pointer-events-none ${
                          showTrimHandles ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      />
                    </div>
                    <div
                      onPointerDown={(e) => startTrim(e, item, 'out')}
                      onPointerMove={moveTrim}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                      className="absolute right-0 top-0 bottom-0 cursor-col-resize touch-none flex items-center justify-end"
                      style={{ width: TRIM_HANDLE_PX }}
                      title="拖动改出点"
                    >
                      <span
                        className={`w-[3px] h-7 rounded-full bg-white/80 transition-opacity pointer-events-none ${
                          showTrimHandles ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {/* 换序插入指示线 */}
          {dropX !== null && (
            <span className="absolute top-0 bottom-0 w-[2px] bg-brand pointer-events-none z-20" style={{ left: dropX * pxPerSecond }} />
          )}

          {!!shown.length && onAdd && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="添加素材"
              title="添加素材（画布产出 / 素材库 / 本地文件）"
              className="absolute top-1.5 bottom-1.5 rounded-lg border border-dashed border-white/70 dark:border-white/12 flex items-center justify-center [color:var(--color-text-muted)] hover:border-brand/60 hover:text-brand hover:bg-brand/5 transition-colors z-[3]"
              style={{ left: layoutTotal * pxPerSecond + 10, width: 40 }}
            >
              <Plus className="w-4 h-4" strokeWidth={1.8} />
            </button>
          )}

          {/* 裁剪中的时间码气泡（放在条外，避免被片段块裁掉） */}
          {trims && (
            <span
              className="absolute -top-1 z-30 px-1.5 py-0.5 rounded bg-black/90 border border-brand/40 font-mono text-[9.5px] text-white whitespace-nowrap pointer-events-none"
              style={{ left: trimBubbleX, transform: 'translate(-50%, -100%)' }}
            >
              {trims.text}
            </span>
          )}

          {/* 播放头在片段条上的延线 */}
          <span
            className="absolute -top-1 -bottom-6 w-[1.5px] pointer-events-none z-[6]"
            style={{ left: playhead * pxPerSecond, background: PLAYHEAD_COLOR }}
          />
        </div>

        {/* 音频波形轨 + 播放头（播放头可拖） */}
        <div className="relative mt-1 rounded-md" style={{ height: WAVE_HEIGHT }}>
          <canvas ref={waveRef} className="block rounded-md overflow-hidden" />
          <div
            className="absolute -top-1 bottom-0 z-20 cursor-ew-resize touch-none"
            style={{ left: playhead * pxPerSecond - 6, width: 13 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              seekFromClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) seekFromClientX(e.clientX);
            }}
            title="拖动播放头"
          >
            <span className="absolute left-1/2 top-0 bottom-0 w-[1.5px] -translate-x-1/2 pointer-events-none" style={{ background: PLAYHEAD_COLOR }} />
            <span className="absolute left-1/2 top-0 w-[10px] h-[7px] -translate-x-1/2 rounded-sm pointer-events-none" style={{ background: PLAYHEAD_COLOR }} />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};
