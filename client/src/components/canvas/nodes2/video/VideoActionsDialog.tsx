// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频处理弹窗（照 Toonflow node-video/components/videoActions.vue）：
 * - 截取片段：预览 + 胶片条（10 张缩略图）+ 左右边界拖拽 / 键盘（←→ 0.1s、Shift 1s、Home/End）+ 起止时间输入 + 时长；
 * - 提取音轨 / 分离音视频：打开即开始处理，显示进度与「取消处理」。
 * 取消 = 停止等待并丢弃结果（后端处理是同步接口，已开始的会跑完，产物不落成节点）。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Modal } from './Modal';
import { ACTION_LABELS, type VideoAction } from './videoOps';

const FRAME_COUNT = 10;

/** Toonflow formatTime：mm:ss.cc */
export function formatClipTime(value: number): string {
  const cs = Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * 100));
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${((cs % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

export interface VideoActionsDialogProps {
  /** 当前打开的操作；null 关闭。 */
  action: VideoAction | null;
  /** 可播放地址（resolveMediaUrl 之后）。 */
  src: string;
  processing: boolean;
  onRunTrim: (range: { start: number; end: number }) => void;
  /** 提取音轨 / 分离音视频失败后重试。 */
  onRetry?: () => void;
  /** 关闭（未处理时）。 */
  onClose: () => void;
  /** 处理中点「取消处理」。 */
  onCancel: () => void;
  disabled?: boolean;
}

export function VideoActionsDialog({ action, src, processing, onRunTrim, onRetry, onClose, onCancel, disabled }: VideoActionsDialogProps) {
  const open = !!action;
  const isTrim = action === 'trim';
  return (
    <Modal
      open={open}
      title={action ? ACTION_LABELS[action] : ''}
      width={isTrim ? 760 : 520}
      top={isTrim ? '6vh' : '15vh'}
      closable={!processing}
      onClose={onClose}
    >
      {isTrim ? (
        <TrimPanel src={src} processing={processing} disabled={disabled} onRun={onRunTrim} onCancel={onCancel} onClose={onClose} />
      ) : (
        <>
          <p className="cv-hint">{action === 'extractAudio' ? '提取音轨并生成音频节点，保留原视频。' : '生成静音视频和音频两个节点，保留原视频。'}</p>
          {processing && <ProcessingStatus />}
          <div className="cv-modal__footer">
            <button type="button" className="cv-btn cv-btn--outline" onClick={processing ? onCancel : onClose}>{processing ? '取消处理' : '取消'}</button>
            <button type="button" className="cv-btn cv-btn--primary" disabled={processing || !!disabled || !onRetry} aria-busy={processing} onClick={() => onRetry?.()}>
              {action ? ACTION_LABELS[action] : ''}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ProcessingStatus() {
  return (
    <div className="cv-processing" role="status" aria-live="polite">
      <div className="cv-progress-bar" aria-hidden />
      <span>正在处理视频…</span>
    </div>
  );
}

function TrimPanel({ src, processing, disabled, onRun, onCancel, onClose }: {
  src: string; processing: boolean; disabled?: boolean; onRun: (r: { start: number; end: number }) => void; onCancel: () => void; onClose: () => void;
}) {
  const previewRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [frames, setFrames] = useState<string[]>([]);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const dragRef = useRef<{ pointerId: number; target: HTMLElement; x: number; time: number; width: number; edge: 'start' | 'end' } | null>(null);

  const clipLimit = duration < 0.01 ? duration : Math.floor(duration * 100) / 100;
  const minimumLength = Math.min(0.01, clipLimit);
  const startPercent = duration && Number.isFinite(start) ? Math.min(100, Math.max(0, (start / duration) * 100)) : 0;
  const endPercent = duration && Number.isFinite(end) ? Math.min(100, Math.max(0, (end / duration) * 100)) : 100;
  const validRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration;
  const locked = processing || !!disabled || !duration;

  // —— 胶片条：独立 <video> 采样 10 帧（只采 10 张小图，内存不随时长增长；跨域被拒时静默不显示）——
  useEffect(() => {
    if (!duration || !src) return;
    let stopped = false;
    const source = document.createElement('video');
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    const got: string[] = [];
    let timer = 0;
    const stopAll = () => {
      stopped = true;
      window.clearTimeout(timer);
      source.onloadeddata = source.onseeked = source.onerror = null;
      source.removeAttribute('src');
      try { source.load(); } catch { /* jsdom */ }
    };
    if (!ctx) { stopAll(); return undefined; }
    const seekFrame = () => {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(stopAll, 15000);
      const time = Math.min((duration * (got.length + 0.5)) / FRAME_COUNT, Math.max(0, duration - 0.001));
      if (source.readyState >= 2 && Math.abs(source.currentTime - time) < 0.000001) capture();
      else source.currentTime = time;
    };
    const capture = () => {
      if (stopped) return;
      try {
        const scale = Math.max(canvas.width / source.videoWidth, canvas.height / source.videoHeight);
        ctx.drawImage(source, (canvas.width - source.videoWidth * scale) / 2, (canvas.height - source.videoHeight * scale) / 2, source.videoWidth * scale, source.videoHeight * scale);
        got.push(canvas.toDataURL('image/jpeg', 0.75));
        setFrames([...got]);
        if (got.length >= FRAME_COUNT) stopAll();
        else seekFrame();
      } catch {
        stopAll();
      }
    };
    source.onloadeddata = seekFrame;
    source.onseeked = capture;
    source.onerror = stopAll;
    source.muted = true;
    source.preload = 'auto';
    source.crossOrigin = 'anonymous';
    source.src = src;
    timer = window.setTimeout(stopAll, 15000);
    try { source.load(); } catch { /* jsdom */ }
    return stopAll;
  }, [duration, src]);

  const seekPreview = useCallback((value: number) => {
    const v = previewRef.current;
    if (!v || !duration || !Number.isFinite(value)) return;
    v.pause();
    v.currentTime = Math.min(Math.max(0, duration - 0.001), Math.max(0, value));
    setCurrentTime(v.currentTime);
  }, [duration]);

  const setBoundary = (edge: 'start' | 'end', value: number) => {
    if (processing || disabled || !duration || !Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end)) return;
    const rounded = Math.round(value * 100) / 100;
    if (edge === 'start') {
      const next = Number(Math.max(0, Math.min(end - minimumLength, rounded)).toFixed(2));
      setStart(next);
      seekPreview(next);
    } else {
      const next = Number(Math.min(clipLimit, Math.max(start + minimumLength, rounded)).toFixed(2));
      setEnd(next);
      seekPreview(next);
    }
  };

  const beginDrag = (e: ReactPointerEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const width = trackRef.current?.getBoundingClientRect().width;
    if (e.button !== 0 || dragRef.current || !width || locked) return;
    const target = e.currentTarget;
    dragRef.current = { pointerId: e.pointerId, target, x: e.clientX, time: edge === 'start' ? start : end, width, edge };
    setDragging(edge);
    try { target.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    seekPreview(dragRef.current.time);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    setBoundary(d.edge, d.time + ((e.clientX - d.x) / d.width) * duration);
  };
  const endDrag = (e?: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    dragRef.current = null;
    setDragging(null);
    try { if (d.target.hasPointerCapture(d.pointerId)) d.target.releasePointerCapture(d.pointerId); } catch { /* jsdom */ }
  };
  const onHandleKey = (e: ReactKeyboardEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    const step = e.shiftKey ? 1 : 0.1;
    const time = edge === 'start' ? start : end;
    const values: Record<string, number> = { ArrowLeft: time - step, ArrowDown: time - step, ArrowRight: time + step, ArrowUp: time + step, Home: 0, End: clipLimit };
    if (!(e.key in values)) return;
    e.preventDefault();
    setBoundary(edge, values[e.key]);
  };
  const seekTrack = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || locked || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width) seekPreview(Math.max(start, Math.min(end, ((e.clientX - rect.left) / rect.width) * duration)));
  };

  return (
    <div className="nodrag nopan nowheel">
      <video
        ref={previewRef}
        className="cv-clip-preview"
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label="截取片段预览"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget.duration;
          const d = Number.isFinite(v) && v > 0 ? v : 0;
          setDuration(d);
          setStart(0);
          setEnd(d < 0.01 ? d : Math.floor(d * 100) / 100);
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setCurrentTime(v.currentTime);
          if (!v.paused && validRange && v.currentTime >= end) v.pause();
        }}
        onPlay={(e) => {
          const v = e.currentTarget;
          if (validRange && (v.currentTime < start || v.currentTime >= end)) v.currentTime = start;
        }}
        onError={() => setDuration(0)}
      />
      <div className={['cv-clip-timeline', processing || !duration ? 'is-unavailable' : ''].filter(Boolean).join(' ')}>
        <div className="cv-clip-timeline__header">
          <span>拖动左右边界，选择保留的片段</span>
          <span className="cv-clip-timeline__duration">原视频 {formatClipTime(duration)}</span>
        </div>
        <div className="cv-clip-timeline__body">
          <div ref={trackRef} className="cv-clip-track" onPointerDown={seekTrack}>
            <div className="cv-clip-filmstrip" aria-hidden>
              {Array.from({ length: FRAME_COUNT }, (_, i) => (
                <div key={i} className="cv-clip-frame">{frames[i] && <img src={frames[i]} alt="" draggable={false} />}</div>
              ))}
            </div>
            <div className="cv-clip-discarded" style={{ left: 0, width: `${startPercent}%` }} />
            <div className="cv-clip-discarded" style={{ left: `${endPercent}%`, right: 0 }} />
            <div className="cv-clip-selected" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }} />
            {duration > 0 && <div className="cv-clip-playhead" style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }} aria-hidden />}
            {(['start', 'end'] as const).map((edge) => {
              const value = edge === 'start' ? start : end;
              return (
                <button
                  key={edge}
                  type="button"
                  className={['cv-clip-handle', edge === 'start' ? 'cv-clip-handle--start' : 'cv-clip-handle--end', dragging === edge ? 'is-dragging' : ''].filter(Boolean).join(' ')}
                  style={{ left: `${edge === 'start' ? startPercent : endPercent}%` }}
                  role="slider"
                  aria-label={edge === 'start' ? '片段开始边界' : '片段结束边界'}
                  aria-orientation="horizontal"
                  aria-valuemin={edge === 'start' ? 0 : Number((start + minimumLength).toFixed(2))}
                  aria-valuemax={edge === 'start' ? Math.max(0, Number((end - minimumLength).toFixed(2))) : clipLimit}
                  aria-valuenow={value}
                  aria-valuetext={Number.isFinite(value) ? `${value.toFixed(2)} 秒` : '未设置'}
                  disabled={locked}
                  onPointerDown={(e) => beginDrag(e, edge)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onLostPointerCapture={endDrag}
                  onKeyDown={(e) => onHandleKey(e, edge)}
                >
                  <span aria-hidden />
                </button>
              );
            })}
          </div>
          <div className="cv-clip-ruler" aria-hidden>
            {Array.from({ length: 5 }, (_, i) => <span key={i}>{formatClipTime((duration * i) / 4)}</span>)}
          </div>
        </div>
      </div>
      <div className="cv-clip-times">
        <label>
          <span>开始时间</span>
          <input
            className="cv-clip-time-input"
            type="number"
            min={0}
            max={clipLimit}
            step={0.01}
            value={Number.isFinite(start) ? start : ''}
            disabled={processing || !duration}
            aria-label="片段开始时间"
            onChange={(e) => { const v = e.currentTarget.valueAsNumber; setStart(v); seekPreview(v); }}
          />
          <span>秒</span>
        </label>
        <label>
          <span>结束时间</span>
          <input
            className="cv-clip-time-input"
            type="number"
            min={0}
            max={clipLimit}
            step={0.01}
            value={Number.isFinite(end) ? end : ''}
            disabled={processing || !duration}
            aria-label="片段结束时间"
            onChange={(e) => { const v = e.currentTarget.valueAsNumber; setEnd(v); seekPreview(v); }}
          />
          <span>秒</span>
        </label>
        <span className="cv-clip-length">时长 {validRange ? (end - start).toFixed(2) : '—'} 秒</span>
      </div>
      <p className="cv-hint">{validRange ? '截取后生成新视频节点，原视频会保留。' : '请选择有效的起止时间。'}</p>
      {processing && <ProcessingStatus />}
      <div className="cv-modal__footer">
        <button type="button" className="cv-btn cv-btn--outline" onClick={processing ? onCancel : onClose}>{processing ? '取消处理' : '取消'}</button>
        <button
          type="button"
          className="cv-btn cv-btn--primary"
          disabled={processing || !!disabled || !validRange}
          aria-busy={processing}
          onClick={() => { previewRef.current?.pause(); onRun({ start, end }); }}
        >
          截取片段
        </button>
      </div>
    </div>
  );
}
