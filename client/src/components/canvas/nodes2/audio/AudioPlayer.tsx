// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频播放器（照搬 Toonflow audioNode/components/audioPlayer.vue 的结构与交互）：
 *   波形区（WebAudio 解码 → canvas 画 128 条峰值，已播放部分主色）+ 播放头 + 只在播放头附近可拖的进度滑块
 *   控制行：播放 / 暂停、`0:03 / 0:10`、静音 + 音量。
 * 截取弹窗复用它：`playRange` 只在区间内试听，`overlay` 叠加选区。
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode, type SyntheticEvent,
} from 'react';
import { IconPlayerPauseFilled, IconPlayerPlayFilled, IconVolume, IconVolumeOff } from '@tabler/icons-react';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { toast } from '../../../../stores/useDialogStore';
import { PLAYER_BARS, canDecodeAudio, decodeWaveform, formatTime, resamplePeaks } from './waveform';
import './audio.css';

const stop = (e: SyntheticEvent) => e.stopPropagation();

// —— 主题变化订阅（深浅色 / 插件主题改的是 <html> 的 class / data-theme / style）：全局一个 MutationObserver ——
let themeVersion = 0;
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
function subscribeTheme(fn: () => void): () => void {
  themeListeners.add(fn);
  if (!themeObserver && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      themeVersion++;
      themeListeners.forEach((l) => l());
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  }
  return () => {
    themeListeners.delete(fn);
    if (!themeListeners.size && themeObserver) {
      themeObserver.disconnect();
      themeObserver = null;
    }
  };
}
const getThemeVersion = () => themeVersion;

export interface WaveformCanvasProps {
  /** 原始峰值（decodeWaveform 的 BASE_PEAKS 个），绘制时降采样到 bars 条 */
  peaks: readonly number[];
  bars?: number;
  /** 已播放层（主色）；颜色取 CSS（.cv-audio-canvas / .is-played 的 color），跟随主题 */
  played?: boolean;
  style?: CSSProperties;
}

/** canvas 波形：Toonflow 同款比例（每条占 1/bars 宽、条宽 50%、最高 78%、最矮 2px、圆角）。 */
export function WaveformCanvas({ peaks, bars = PLAYER_BARS, played, style }: WaveformCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, getThemeVersion, getThemeVersion);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks.length) return;
    const values = resamplePeaks(peaks, bars);
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      // 节点会被画布缩放放大：按 2× 设备像素绘制，缩放后仍清晰
      const scale = Math.min(4, (window.devicePixelRatio || 1) * 2);
      const W = Math.round(w * scale);
      const H = Math.round(h * scale);
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color || '#888';
      const step = w / values.length;
      const barW = Math.max(1, step * 0.5);
      values.forEach((peak, i) => {
        const barH = Math.max(2, peak * h * 0.78);
        const x = i * step + (step - barW) / 2;
        const y = (h - barH) / 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 1.5));
        else ctx.rect(x, y, barW, barH);
        ctx.fill();
      });
    };
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, bars, theme, played]);
  return <canvas ref={ref} className={['cv-audio-canvas', played ? 'is-played' : ''].filter(Boolean).join(' ')} style={style} aria-hidden />;
}

/** 解码波形（按 URL 缓存；不支持 WebAudio 的环境直接返回空）。 */
export function useWaveform(src: string): { peaks: number[] | null; decodedDuration: number; loading: boolean } {
  const [state, setState] = useState<{ src: string; peaks: number[] | null; duration: number; done: boolean }>({ src: '', peaks: null, duration: 0, done: false });
  useEffect(() => {
    let alive = true;
    if (!src || !canDecodeAudio()) {
      setState({ src, peaks: null, duration: 0, done: true });
      return;
    }
    setState({ src, peaks: null, duration: 0, done: false });
    void decodeWaveform(src).then((r) => {
      if (alive) setState({ src, peaks: r?.peaks ?? null, duration: r?.duration ?? 0, done: true });
    });
    return () => {
      alive = false;
    };
  }, [src]);
  const cur = state.src === src ? state : { peaks: null, duration: 0, done: false };
  return { peaks: cur.peaks, decodedDuration: cur.duration, loading: !cur.done };
}

export interface AudioPlayerHandle {
  pause: () => void;
  play: () => Promise<void>;
  seekTo: (time: number) => void;
  readonly duration: number;
  readonly currentTime: number;
}

export interface AudioPlayerProps {
  /** 可直接播放的地址（已 resolveMediaUrl 回源） */
  src: string;
  label?: string;
  /** 波形区高度（Toonflow 96，截取 148） */
  trackHeight?: number;
  bars?: number;
  /** 只在区间内试听：播放头不在区间内时从 start 起播，到 end 自动暂停 */
  playRange?: { start: number; end: number } | null;
  onDuration?: (duration: number) => void;
  onPlay?: () => void;
  /** 叠在波形上、播放头滑块之下（截取选区） */
  overlay?: (ctx: { duration: number; currentTime: number }) => ReactNode;
  className?: string;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer(props, ref) {
  const { src, label = '节点音频', trackHeight = 96, bars = PLAYER_BARS, playRange, onDuration, onPlay, overlay, className } = props;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const { peaks, decodedDuration, loading } = useWaveform(src);
  const duration = mediaDuration || decodedDuration || 0;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const rangeRef = useRef(playRange);
  rangeRef.current = playRange;
  const disposed = useRef(false);

  const readTime = useCallback(() => {
    setCurrentTime(audioRef.current?.currentTime ?? 0);
  }, []);
  const stopProgress = useCallback(() => {
    setPlaying(false);
    readTime();
  }, [readTime]);

  // 播放中逐帧读进度（Toonflow requestAnimationFrame 同款）；区间试听到 end 自动暂停
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const a = audioRef.current;
      if (!a) return;
      const r = rangeRef.current;
      if (r && !a.paused && a.currentTime >= r.end) {
        a.pause();
        a.currentTime = r.end;
      }
      setCurrentTime(a.currentTime);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 换音频：复位（Toonflow watch src）
  useEffect(() => {
    setMediaDuration(0);
    setCurrentTime(0);
    setFailed(false);
    setPlaying(false);
  }, [src]);
  useEffect(() => {
    disposed.current = false;
    const a = audioRef.current;
    return () => {
      disposed.current = true;
      if (a && !a.paused) a.pause();
    };
  }, []);
  useEffect(() => {
    if (duration > 0) onDuration?.(duration);
  }, [duration, onDuration]);

  const readDuration = () => {
    const v = audioRef.current?.duration ?? 0;
    setMediaDuration(Number.isFinite(v) ? Math.max(0, v) : 0);
  };

  const seekTo = useCallback((value: number) => {
    const a = audioRef.current;
    const d = durationRef.current;
    if (!a || !d || !Number.isFinite(value)) return;
    a.currentTime = Math.min(d, Math.max(0, value));
    setCurrentTime(a.currentTime);
  }, []);

  const play = useCallback(async () => {
    const a = audioRef.current;
    if (!a || !durationRef.current) return;
    const r = rangeRef.current;
    if (r && (a.currentTime < r.start || a.currentTime >= r.end - 0.01)) a.currentTime = r.start;
    try {
      await a.play();
    } catch (error) {
      if (!disposed.current && !(error instanceof DOMException && error.name === 'AbortError')) toast.error('音频播放失败');
    }
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a || !duration || failed) return;
    if (!a.paused) a.pause();
    else void play();
  };

  useImperativeHandle(ref, () => ({
    pause: () => {
      const a = audioRef.current;
      if (a && !a.paused) a.pause();
    },
    play,
    seekTo,
    get duration() { return durationRef.current; },
    get currentTime() { return audioRef.current?.currentTime ?? 0; },
  }), [play, seekTo]);

  const setVolumeTo = (value: number) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(value)) return;
    a.volume = Math.min(100, Math.max(0, value)) / 100;
    a.muted = value === 0;
  };
  const toggleMute = () => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.volume) a.volume = 1;
    a.muted = !(muted || !volume);
  };

  const progress = duration ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const silent = muted || !volume;
  const trackStyle = { '--cv-audio-track-h': `${trackHeight}px` } as CSSProperties;

  return (
    <div className={['cv-audio-player', className].filter(Boolean).join(' ')} onKeyDown={stop}>
      <audio
        ref={audioRef}
        src={src || undefined}
        preload="metadata"
        aria-label={label}
        onLoadedMetadata={readDuration}
        onDurationChange={readDuration}
        onTimeUpdate={() => { if (!playing) readTime(); }}
        onPlay={() => { setPlaying(true); onPlay?.(); }}
        onPause={stopProgress}
        onEnded={stopProgress}
        onVolumeChange={() => {
          setVolume(Math.round((audioRef.current?.volume ?? 1) * 100));
          setMuted(audioRef.current?.muted ?? false);
        }}
        onError={() => { setFailed(true); stopProgress(); }}
      />
      <div className={['cv-audio-wave', !duration || failed ? 'is-unavailable' : ''].filter(Boolean).join(' ')}>
        <div className="cv-audio-track" style={trackStyle}>
          {peaks && !failed ? (
            <>
              <WaveformCanvas peaks={peaks} bars={bars} />
              <WaveformCanvas peaks={peaks} bars={bars} played style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }} />
            </>
          ) : (
            <span className="cv-audio-status">{failed ? '无法播放音频' : loading ? '正在读取波形…' : '当前音频无法显示波形'}</span>
          )}
          {overlay?.({ duration, currentTime })}
          {duration > 0 && !failed && <span className="cv-audio-playhead" style={{ left: `${progress}%` }} aria-hidden />}
          <input
            className="cv-audio-seek nodrag nopan nowheel"
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(currentTime, duration || 1)}
            disabled={!duration || failed}
            aria-label="音频播放进度"
            aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
            onPointerDown={stop}
            onMouseDown={stop}
            onDoubleClick={stop}
            onChange={(e) => seekTo(e.currentTarget.valueAsNumber)}
            onKeyDown={(e) => {
              if (e.key === ' ') {
                e.preventDefault();
                toggle();
              }
            }}
          />
        </div>
      </div>
      <div className="cv-audio-controls">
        <button
          type="button"
          className="cv-audio-play nodrag nopan nowheel"
          disabled={!duration || failed}
          aria-label={playing ? '暂停音频' : '播放音频'}
          title={playing ? '暂停' : '播放'}
          onPointerDown={stop}
          onMouseDown={stop}
          onDoubleClick={stop}
          onClick={(e) => { e.stopPropagation(); toggle(); }}
        >
          {playing ? <IconPlayerPauseFilled size={14} aria-hidden /> : <IconPlayerPlayFilled size={14} aria-hidden />}
        </button>
        <span className="cv-audio-time">
          <span>{formatTime(currentTime)}</span>
          <span className="cv-audio-time__sep">/</span>
          <span>{formatTime(duration)}</span>
        </span>
        <div className="cv-audio-volume nodrag nopan nowheel" onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop}>
          <ToolbarButton
            icon={silent ? IconVolumeOff : IconVolume}
            title={silent ? '取消静音' : '静音'}
            aria-pressed={silent}
            iconOnly
            disabled={failed}
            onClick={toggleMute}
          />
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            disabled={failed}
            aria-label="音频音量"
            onChange={(e) => setVolumeTo(e.currentTarget.valueAsNumber)}
          />
        </div>
      </div>
    </div>
  );
});
