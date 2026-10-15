// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 节点内视频播放器（照 Toonflow nodeScaffold/components/videoPlayer.vue）：
 * - 视频本身不接收指针（拖视频区域 = 拖节点），悬停出现底部控制条（播放 / 时间 / 进度 / 音量 / 截帧）；
 * - 最大高 240、object-fit: contain；全屏用视频元素自身 requestFullscreen（全屏时显示原生控件）；
 * - 截帧菜单：截取当前帧 / 首帧 / 尾帧（处理交给外层，走后端 /media/ops/frame）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import {
  IconPhotoScan, IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconPlayerSkipForward, IconVolume, IconVolumeOff,
} from '@tabler/icons-react';
import { MenuList, Popover } from '../../kit/ui/Popover';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import type { FrameAtCommand } from './videoOps';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function formatClock(value: number): string {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface VideoPlayerHandle {
  enterFullscreen: () => Promise<void>;
  /** 当前播放头（秒），截取当前帧用。 */
  currentTime: () => number;
  pause: () => void;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
}

export interface VideoPlayerProps {
  /** 可直接播放的地址（/storage 相对地址先经 resolveMediaUrl）。 */
  src: string;
  label?: string;
  onMetadata?: (meta: VideoMeta) => void;
  /** 传入则在控制条显示截帧按钮。 */
  onCapture?: (at: FrameAtCommand) => void;
  capturing?: boolean;
  captureDisabled?: boolean;
  /** 全屏失败时的回落（如宿主的全屏预览）。 */
  onFullscreenFallback?: () => void;
}

/** 截帧菜单项（Toonflow 同款三项）。 */
export function captureMenuItems(onSelect: (at: FrameAtCommand) => void) {
  return [
    { key: 'current', label: '截取当前帧', icon: <IconPhotoScan size={16} aria-hidden />, onSelect: () => onSelect('current') },
    { key: 'first', label: '截取首帧', icon: <IconPlayerSkipBack size={16} aria-hidden />, onSelect: () => onSelect('first') },
    { key: 'last', label: '截取尾帧', icon: <IconPlayerSkipForward size={16} aria-hidden />, onSelect: () => onSelect('last') },
  ];
}

/** 工具栏右侧的「截取视频帧」下拉（Toonflow topRightActions）。 */
export function FrameCaptureButton({ onSelect, loading, disabled }: { onSelect: (at: FrameAtCommand) => void; loading?: boolean; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <ToolbarButton
        icon={IconPhotoScan}
        title="截取视频帧"
        iconOnly
        loading={loading}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      <Popover open={!!anchor} anchor={anchor} placement="bottom-end" onClose={() => setAnchor(null)} role="menu" aria-label="截取视频帧">
        <MenuList items={captureMenuItems(onSelect)} onClose={() => setAnchor(null)} />
      </Popover>
    </>
  );
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { src, label = '节点视频', onMetadata, onCapture, capturing, captureDisabled, onFullscreenFallback },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [captureAnchor, setCaptureAnchor] = useState<HTMLButtonElement | null>(null);
  const lastVolume = useRef(100);

  // 换片源时状态归零（Toonflow watch(src)）：由使用方传 key={src} 重挂载

  const enterFullscreen = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    setFullscreen(true);
    try {
      await el.requestFullscreen();
    } catch {
      setFullscreen(false);
      onFullscreenFallback?.();
    }
  }, [onFullscreenFallback]);

  useImperativeHandle(ref, () => ({
    enterFullscreen,
    currentTime: () => videoRef.current?.currentTime ?? 0,
    pause: () => videoRef.current?.pause(),
  }), [enterFullscreen]);

  const togglePlayback = async () => {
    const el = videoRef.current;
    if (!el) return;
    if (!el.paused) { el.pause(); return; }
    try { await el.play(); } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError('视频播放失败');
    }
  };
  const seek = (value: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(value)) return;
    el.currentTime = Math.min(duration || 0, Math.max(0, value));
    setCurrent(el.currentTime);
  };
  const readVolume = () => {
    const el = videoRef.current;
    if (!el) return;
    const v = Math.round(el.volume * 100);
    setVolume(v);
    setMuted(el.muted);
    if (v > 0) lastVolume.current = v;
  };
  const changeVolume = (value: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(value)) return;
    el.volume = Math.min(100, Math.max(0, value)) / 100;
    el.muted = el.volume === 0;
    readVolume();
  };
  const toggleMute = () => {
    const el = videoRef.current;
    if (!el) return;
    const silent = el.muted || el.volume === 0;
    if (el.volume === 0) el.volume = lastVolume.current / 100;
    el.muted = !silent;
    readVolume();
  };

  const silent = muted || !volume;
  const pct = duration ? `${Math.min(100, (current / duration) * 100)}%` : '0%';
  return (
    <div className="cv-vplayer" data-testid="cv-vplayer">
      <video
        ref={videoRef}
        className={['cv-vplayer__video', fullscreen ? 'nodrag' : ''].filter(Boolean).join(' ')}
        src={src}
        controls={fullscreen}
        playsInline
        preload="metadata"
        draggable={false}
        aria-label={label}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          const d = Number.isFinite(el.duration) ? el.duration : 0;
          setDuration(d);
          setReady(true);
          setError('');
          if (el.videoWidth && el.videoHeight) onMetadata?.({ width: el.videoWidth, height: el.videoHeight, duration: d });
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={readVolume}
        onError={() => {
          setReady(false);
          setPlaying(false);
          setError('视频无法加载/播放（多为 H.265 等浏览器不支持的编码或文件损坏，可下载后用外部播放器打开）');
        }}
      />
      {error && <div className="cv-vplayer__error" role="alert">{error}</div>}
      {!fullscreen && (
        <div
          className={['cv-vplayer__controls nodrag nopan nowheel', captureAnchor ? 'is-pinned' : ''].filter(Boolean).join(' ')}
          onPointerDown={stop}
          onMouseDown={stop}
          onDoubleClick={stop}
          onKeyDown={stop}
        >
          <button
            type="button"
            className="cv-vplayer__btn cv-vplayer__play"
            disabled={!ready}
            aria-label={playing ? '暂停视频' : '播放视频'}
            title={playing ? '暂停' : '播放'}
            onClick={(e) => { e.stopPropagation(); void togglePlayback(); }}
          >
            {playing ? <IconPlayerPause size={15} aria-hidden /> : <IconPlayerPlay size={15} aria-hidden />}
          </button>
          <span className="cv-vplayer__time">{formatClock(current)}</span>
          <input
            type="range"
            className="cv-range cv-vplayer__progress"
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(current, duration || 1)}
            disabled={!ready || !duration}
            aria-label="视频播放进度"
            aria-valuetext={formatClock(current)}
            style={{ ['--cv-range-pct' as string]: pct }}
            onChange={(e) => seek(Number(e.currentTarget.value))}
          />
          <span className="cv-vplayer__duration"><span className="cv-vplayer__sep">/</span>{formatClock(duration)}</span>
          <div className="cv-vplayer__volume">
            <div className="cv-vplayer__volume-pop">
              <span className="cv-vplayer__volume-value">{silent ? 0 : volume}%</span>
              <input
                type="range"
                className="cv-vplayer__volume-slider"
                min={0}
                max={100}
                value={silent ? 0 : volume}
                disabled={!ready}
                aria-label="视频音量"
                onChange={(e) => changeVolume(Number(e.currentTarget.value))}
                style={{ accentColor: 'var(--cv-primary)' }}
              />
            </div>
            <button
              type="button"
              className="cv-vplayer__btn"
              disabled={!ready}
              aria-pressed={silent}
              aria-label={silent ? '取消静音' : '静音视频'}
              title="音量 · 点击切换静音"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
            >
              {silent ? <IconVolumeOff size={15} aria-hidden /> : <IconVolume size={15} aria-hidden />}
            </button>
          </div>
          {onCapture && (
            <button
              type="button"
              className="cv-vplayer__btn cv-vplayer__capture"
              disabled={!ready || capturing || captureDisabled}
              aria-label="截取视频帧"
              title="截取视频帧"
              aria-haspopup="menu"
              aria-expanded={!!captureAnchor}
              onClick={(e) => { e.stopPropagation(); setCaptureAnchor(captureAnchor ? null : e.currentTarget); }}
            >
              <IconPhotoScan size={15} aria-hidden />
            </button>
          )}
        </div>
      )}
      {onCapture && (
        <Popover open={!!captureAnchor} anchor={captureAnchor} placement="top-end" onClose={() => setCaptureAnchor(null)} role="menu" aria-label="截取视频帧">
          <MenuList items={captureMenuItems(onCapture)} onClose={() => setCaptureAnchor(null)} />
        </Popover>
      )}
      <FullscreenWatcher videoRef={videoRef} onChange={setFullscreen} />
    </div>
  );
});

/** 监听视频元素的全屏切换（React 不支持 onFullscreenChange 合成事件，直接挂原生监听）。 */
function FullscreenWatcher({ videoRef, onChange }: { videoRef: RefObject<HTMLVideoElement | null>; onChange: (v: boolean) => void }) {
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const h = () => onChange(document.fullscreenElement === el);
    el.addEventListener('fullscreenchange', h);
    document.addEventListener('fullscreenchange', h);
    return () => {
      el.removeEventListener('fullscreenchange', h);
      document.removeEventListener('fullscreenchange', h);
    };
  }, [videoRef, onChange]);
  return null;
}
