// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：时间线条（标尺 + 片段条 + 波形 + 播放头），原 timeline/TimelineStrip.tsx 的逐行移植。
 *
 * 交互与数据纪律完全不变（三条实测教训照旧落死）：
 * 1. 拖拽用 pointer 事件自实现，不用 HTML5 DnD（与画布 pointer 处理抢事件会「有时候拖不动」）；
 * 2. 时长为 0 的片段给占位宽度和明确外观（否则用户以为「第二个视频没加进来」）；
 * 3. 标尺档位按像素间距选；
 * 拖拽 / 裁剪过程中只改本地 draft，指针抬起时才 onChange 回写。
 *
 * 换皮：颜色全部来自 --cv-*（legacy-a.css 的 .cv-la-tl*），播放头 = --cv-danger（同 Toonflow audioClipEditor），
 * 波形 = --cv-primary（canvas 2D 不认 CSS 变量：用元素的计算色解析，切主题时重画）；图标换 Tabler；
 * 时长标签改为自带底色的标签（不再按缩略图亮度切黑 / 白字）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { IconLoader2, IconMusic, IconPlus, IconVolume, IconVolume3 } from '@tabler/icons-react';
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
} from '../../../../types/timeline';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { useMediaDurations, useWavePeaks } from '../../timeline/mediaProbe';

const TRIM_HANDLE_PX = 10;
const DRAG_THRESHOLD_PX = 5;
const WAVE_HEIGHT = 34;
/** 波形柱 / 占位条的不透明度（原 cyan 0.8 / 0.22 的口径，颜色改取主题变量） */
const WAVE_ALPHA = 0.85;
const WAVE_IDLE_ALPHA = 0.45;

interface LayoutItem {
  clip: TimelineClip;
  left: number;
  width: number;
  pending: boolean;
}

/** html 上的主题切换（data-theme / class / style）→ 版本号 +1，让 canvas 波形按新主题色重画。 */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setV((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => mo.disconnect();
  }, []);
  return v;
}

/** 读元素的计算色（CSS 变量已解析成具体颜色），canvas 2D 绘图用。 */
function computedColor(el: Element | null, prop: 'color' | 'borderTopColor' = 'color'): string {
  if (!el || typeof getComputedStyle === 'undefined') return '';
  return getComputedStyle(el)[prop] || '';
}

/** 轨道头的一格静音开关（卡片态一个整体开关；全屏态视频 / 音频两轨） */
function MuteToggle({ variant, muted, label, onToggle }: { variant: 'card' | 'studio'; muted: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={!muted}
      aria-label={`${label}：${muted ? '已静音' : '有声'}`}
      title={`${label}${muted ? '：已静音（点击开启声音）' : '：有声（点击静音）'}`}
      className={['cv-la-tl-mute', muted ? '' : 'is-on'].filter(Boolean).join(' ')}
    >
      {muted ? <IconVolume3 size={14} stroke={1.7} aria-hidden /> : <IconVolume size={14} stroke={1.7} aria-hidden />}
      {variant === 'studio' && <span className="cv-la-tl-mute__label">{label.replace('音轨', '')}</span>}
    </button>
  );
}

export interface TimelineCardStripProps {
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
  /** 常显裁剪把手（工具行的「裁剪」开关打开时） */
  showTrimHandles?: boolean;
  /** 左侧轨道头（视频轨 / 音频轨各自的静音开关）；给了 onToggle* 才渲染 */
  videoMuted?: boolean;
  audioMuted?: boolean;
  onToggleVideoMute?: () => void;
  onToggleAudioMute?: () => void;
  /** 右键片段回调；未提供时走浏览器默认行为 */
  onClipContextMenu?: (clip: TimelineClip, pos: { x: number; y: number }) => void;
}

export function TimelineCardStrip({
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
}: TimelineCardStripProps) {
  const [draft, setDraft] = useState<TimelineClip[] | null>(null);
  const [dragging, setDragging] = useState<{ index: number; from: number; to: number } | null>(null);
  const [trims, setTrims] = useState<{ id: string; text: string } | null>(null);
  const trimRef = useRef<{ id: string; edge: 'in' | 'out'; startX: number; baseIn: number; baseOut: number } | null>(null);
  const dragRef = useRef<{ index: number; startX: number; startY: number; moved: boolean; to: number } | null>(null);
  const mediaRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const waveWrapRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const themeVersion = useThemeVersion();

  const shown = draft || clips;
  // 指针事件 / 时长回填里要读最新片段：提交后（绘制前）同步到 ref
  const clipsRef = useRef(clips);
  useLayoutEffect(() => { clipsRef.current = clips; }, [clips]);
  /** 最短可拖时长：既满足合片内核的 0.4s，也保证块宽够抓手 */
  const minSpan = Math.max(MIN_CLIP_SECONDS, 48 / pxPerSecond);

  const layout: LayoutItem[] = useMemo(() => {
    const items: LayoutItem[] = [];
    let acc = 0;
    for (const clip of shown) {
      const real = clipSpan(clip);
      const pending = real <= 0;
      const width = Math.max(real > 0 ? real : PENDING_PLACEHOLDER_SECONDS, minSpan);
      items.push({ clip, left: acc, width, pending });
      acc += width;
    }
    return items;
  }, [shown, minSpan]);

  const layoutTotal = layout.length ? layout[layout.length - 1].left + layout[layout.length - 1].width : 0;
  const frameTotal = Math.max(layoutTotal, variant === 'studio' ? 12 : 8);
  // 末尾「+」按钮需要 10px 间距 + 40px 宽：有 onAdd 时必须把这两项宽度都预留出来
  const contentWidth = Math.max(200, frameTotal * pxPerSecond + (onAdd ? 60 : 20));

  /**
   * 屏幕坐标 → 本组件 CSS 坐标：卡片活在 React Flow 的缩放视口里，clientX 与 getBoundingClientRect() 都是屏幕像素，
   * 被缩放到 0.5 倍时屏幕 1px 只等于 CSS 2px，不换算就会「拖动 1px 裁剪量翻倍」。
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
    // 颜色取主题变量的计算值：柱 = --cv-primary（canvas 的 color），占位 = --cv-text-3（外层 color），分隔 = 片段条边框色
    const barColor = computedColor(canvas) || computedColor(waveWrapRef.current);
    const idleColor = computedColor(waveWrapRef.current) || barColor;
    const sepColor = computedColor(trackRef.current, 'borderTopColor') || idleColor;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);

    layout.forEach((item, i) => {
      const x = item.left * pxPerSecond;
      const blockW = Math.max(2, item.width * pxPerSecond);
      const data = peaks[item.clip.url];
      if (item.pending) {
        // 占位：虚线，明确「还在读」
        ctx.globalAlpha = WAVE_IDLE_ALPHA;
        ctx.strokeStyle = idleColor;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 2, WAVE_HEIGHT / 2);
        ctx.lineTo(x + blockW - 2, WAVE_HEIGHT / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        return;
      }
      if (!data || !data.length) {
        ctx.globalAlpha = WAVE_IDLE_ALPHA;
        ctx.fillStyle = idleColor;
        ctx.fillRect(x + 1, WAVE_HEIGHT / 2 - 1, Math.max(1, blockW - 2), 2);
        ctx.globalAlpha = 1;
        return;
      }
      const dur = item.clip.duration || item.clip.out || 1;
      const from = Math.max(0, Math.floor((data.length * item.clip.in) / dur));
      const to = Math.max(from + 1, Math.ceil((data.length * item.clip.out) / dur));
      const slice = data.slice(from, to);
      // 降采样到「一块最多 ~1 根柱子/像素」：片段被裁短后不会铺出比块还宽的一排柱子
      const bars = Math.max(1, Math.min(slice.length, Math.floor(blockW)));
      const step = slice.length / bars;
      const barW = blockW / bars;
      ctx.globalAlpha = WAVE_ALPHA;
      ctx.fillStyle = barColor;
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
      ctx.globalAlpha = 1;
      if (i > 0) {
        ctx.fillStyle = sepColor;
        ctx.fillRect(Math.round(x), 0, 1, WAVE_HEIGHT);
      }
    });
  }, [layout, peaks, pxPerSecond, contentWidth, themeVersion]);

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
        if (el.paused) {
          const p = el.play() as Promise<void> | undefined;
          if (p && typeof p.catch === 'function') p.catch(() => undefined);
        }
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
  const startTrim = (e: ReactPointerEvent, item: LayoutItem, edge: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    if (item.pending) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    trimRef.current = { id: item.clip.id, edge, startX: e.clientX, baseIn: item.clip.in, baseOut: item.clip.out };
    setDraft(clipsRef.current.map((c) => ({ ...c })));
    onSelect(item.clip.id);
  };

  const moveTrim = (e: ReactPointerEvent) => {
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

  const startDrag = (e: ReactPointerEvent, _item: LayoutItem, index: number) => {
    if (e.button !== 0) return;
    // 拦住冒泡：否则条容器上的「点空白取消选中」会先跑，选中态会闪一下
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { index, startX: e.clientX, startY: e.clientY, moved: false, to: index };
  };

  const moveDrag = (e: ReactPointerEvent) => {
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

  const endDrag = (e?: ReactPointerEvent) => {
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
  const blockHeight = variant === 'studio' ? 64 : 62;
  const rulerDecimals = rulerStepForPx(pxPerSecond) < 1 ? 1 : 0;
  const showHeads = !!(onToggleVideoMute || onToggleAudioMute);

  return (
    <div className={['cv-la-tl', showTrimHandles ? 'is-trim' : ''].filter(Boolean).join(' ')} data-testid="timeline-strip">
      {/* 左侧轨道头：卡片态只有一个整体静音开关（纵跨两行）；全屏编辑器才分视频 / 音频两轨 */}
      {showHeads && (
        <div className="cv-la-tl__heads">
          <div className="cv-la-tl__heads-spacer" />
          {variant === 'card' ? (
            <div className="cv-la-tl__head" style={{ flex: 1 }}>
              <MuteToggle variant={variant} muted={videoMuted} label="整体音轨" onToggle={() => onToggleVideoMute?.()} />
            </div>
          ) : (
            <>
              <div className="cv-la-tl__head" style={{ height: blockHeight }}>
                <MuteToggle variant={variant} muted={videoMuted} label="视频音轨" onToggle={() => onToggleVideoMute?.()} />
              </div>
              <div style={{ height: 4 }} />
              <div className="cv-la-tl__head" style={{ height: WAVE_HEIGHT }}>
                <MuteToggle variant={variant} muted={audioMuted} label="音频音轨" onToggle={() => onToggleAudioMute?.()} />
              </div>
            </>
          )}
        </div>
      )}
      <div className="cv-la-tl__scroll">
        <div ref={contentRef} className="cv-la-tl__content" style={{ width: contentWidth }}>
          {/* 标尺：点击 / 拖动定位播放头 */}
          <div
            className="cv-la-tl__ruler"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              seekFromClientX(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) seekFromClientX(e.clientX);
            }}
            title="点击或拖动定位播放头"
          >
            {rulerTicksForPx(frameTotal, pxPerSecond).map((t) => (
              <div key={t} className="cv-la-tl__tick" style={{ left: t * pxPerSecond }}>
                <span className="cv-la-tl__tick-line" />
                <span className="cv-la-tl__tick-label cv-la-mono">{formatTimecode(t, { decimals: rulerDecimals })}</span>
              </div>
            ))}
            {/* 播放头在标尺上的延线（拖动把手在波形轨上） */}
            <span className="cv-la-tl__playhead" style={{ left: playhead * pxPerSecond, top: 0, bottom: 0 }} />
          </div>

          {/* 片段条 */}
          <div ref={trackRef} className="cv-la-tl__track" style={{ height: blockHeight }} onPointerDown={() => onSelect(null)}>
            {!shown.length && onAdd && (
              <button
                type="button"
                className="cv-la-tl__empty-add"
                onClick={(e) => {
                  e.stopPropagation();
                  onAdd();
                }}
              >
                <IconPlus size={14} stroke={1.8} aria-hidden />
                添加视频 / 音频素材
              </button>
            )}
            {!shown.length && !onAdd && <div className="cv-la-tl__empty">从上游连入视频后再回来编辑</div>}

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
                  data-clip-id={clip.id}
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
                  className={['cv-la-tl__clip', isSelected ? 'is-selected' : '', isDragged ? 'is-dragged' : ''].filter(Boolean).join(' ')}
                  style={{ left, width, zIndex: isDragged ? 5 : isSelected ? 4 : 2 }}
                >
                  {pending ? (
                    <div className="cv-la-tl__clip-fill">
                      <IconLoader2 size={14} className="cv-la-spin cv-la-accent" aria-hidden />
                      <span>{clip.name}</span>
                    </div>
                  ) : isAudio ? (
                    <div className="cv-la-tl__clip-fill">
                      <IconMusic size={16} stroke={1.7} aria-hidden />
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
                      className="cv-la-tl__thumb"
                    />
                  )}

                  {!pending && (
                    <>
                      <span className="cv-la-tl__dur cv-la-mono">{formatTimecode(clipSpan(clip))}</span>
                      {isAudio && <span className="cv-la-tl__kind">音频</span>}
                      <div
                        onPointerDown={(e) => startTrim(e, item, 'in')}
                        onPointerMove={moveTrim}
                        onPointerUp={endTrim}
                        onPointerCancel={endTrim}
                        className="cv-la-tl__trim cv-la-tl__trim--in"
                        style={{ width: TRIM_HANDLE_PX }}
                        title="拖动改入点"
                      >
                        <span className="cv-la-tl__trim-bar" />
                      </div>
                      <div
                        onPointerDown={(e) => startTrim(e, item, 'out')}
                        onPointerMove={moveTrim}
                        onPointerUp={endTrim}
                        onPointerCancel={endTrim}
                        className="cv-la-tl__trim cv-la-tl__trim--out"
                        style={{ width: TRIM_HANDLE_PX }}
                        title="拖动改出点"
                      >
                        <span className="cv-la-tl__trim-bar" />
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* 换序插入指示线 */}
            {dropX !== null && <span className="cv-la-tl__drop" style={{ left: dropX * pxPerSecond }} />}

            {!!shown.length && onAdd && (
              <button
                type="button"
                className="cv-la-tl__add"
                onClick={(e) => {
                  e.stopPropagation();
                  onAdd();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="添加素材"
                title="添加素材（画布产出 / 素材库 / 本地文件）"
                style={{ left: layoutTotal * pxPerSecond + 10, width: 40 }}
              >
                <IconPlus size={16} stroke={1.8} aria-hidden />
              </button>
            )}

            {/* 裁剪中的时间码气泡 */}
            {trims && <span className="cv-la-tl__bubble cv-la-mono" style={{ left: trimBubbleX }}>{trims.text}</span>}

            {/* 播放头在片段条上的延线 */}
            <span className="cv-la-tl__playhead" style={{ left: playhead * pxPerSecond, top: -4, bottom: -24, zIndex: 6 }} />
          </div>

          {/* 音频波形轨 + 播放头（播放头可拖） */}
          <div ref={waveWrapRef} className="cv-la-tl__wave" style={{ height: WAVE_HEIGHT }}>
            <canvas ref={waveRef} aria-hidden />
            <div
              className="cv-la-tl__scrub"
              style={{ left: playhead * pxPerSecond - 6 }}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                seekFromClientX(e.clientX);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) seekFromClientX(e.clientX);
              }}
              title="拖动播放头"
            >
              <span className="cv-la-tl__scrub-line" />
              <span className="cv-la-tl__scrub-head" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TimelineCardStrip;
