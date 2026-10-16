// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 截取音频弹窗（对照 Toonflow audioActions 的 clipDialog + audioClipEditor）。
 * Toonflow 是多片段剪辑 + 拼接（浏览器 ffmpeg）；后端 /media/ops/trim 只截一个区间，这里做单区间选择：
 *   时间刻度（点选定位）→ 波形（拖动空白处新建选区、拖两端把手调整、单击定位播放头）→ 开始 / 结束秒数输入；
 *   试听只播选区；「导出音频」→ 新音频节点。
 */
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconPlayerPlay } from '@tabler/icons-react';
import { AudioDialog } from './AudioDialog';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';
import { MIN_TRIM_SPAN, isValidTrim } from './useAudioProcessing';
import { formatPreciseTime } from './waveform';
import './audio.css';

export interface AudioTrimDialogProps {
  /** 可直接播放的地址（已回源） */
  src: string;
  processing: boolean;
  error?: string | null;
  onClose: () => void;
  onRun: (start: number, end: number) => void;
}

type Drag = { kind: 'start' | 'end' | 'new'; anchor: number; x: number; moved: boolean };

const round2 = (v: number) => Math.round(v * 100) / 100;

function TimeField({ label, value, min, max, disabled, onCommit }: {
  label: string; value: number; min: number; max: number; disabled?: boolean; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
  };
  return (
    <label>
      {label}
      <input
        className="cv-audio-num"
        type="number"
        step={0.01}
        min={min}
        max={max}
        value={draft ?? value.toFixed(2)}
        disabled={disabled}
        aria-label={`${label}（秒）`}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      秒
    </label>
  );
}

export function AudioTrimDialog({ src, processing, error, onClose, onRun }: AudioTrimDialogProps) {
  const player = useRef<AudioPlayerHandle>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const start = range?.start ?? 0;
  const end = range?.end ?? duration;
  const valid = isValidTrim(start, end, duration);

  const onDuration = useCallback((d: number) => {
    setDuration(d);
    // 首次拿到时长：默认选中整段（Toonflow 同款）
    setRange((r) => r ?? { start: 0, end: d });
  }, []);

  const setStart = (v: number) => setRange({ start: Math.max(0, Math.min(v, end - MIN_TRIM_SPAN)), end });
  const setEnd = (v: number) => setRange({ start, end: Math.min(duration, Math.max(v, start + MIN_TRIM_SPAN)) });
  const pct = (t: number) => (duration ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);
  const timeAt = (clientX: number) => {
    const rect = overlay.current?.getBoundingClientRect();
    if (!rect || !rect.width || !duration) return 0;
    return round2(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (processing || e.button !== 0 || !duration) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = (e.target as HTMLElement).dataset?.handle as 'start' | 'end' | undefined;
    const t = timeAt(e.clientX);
    drag.current = { kind: handle ?? 'new', anchor: t, x: e.clientX, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    const t = timeAt(e.clientX);
    if (d.kind === 'start') setStart(t);
    else if (d.kind === 'end') setEnd(t);
    else setRange({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
    if (!d) return;
    if (!d.moved && d.kind === 'new') player.current?.seekTo(d.anchor);
    else if (d.kind === 'new') {
      // 拖出的选区太短：按最短片段补齐
      setRange((r) => (r && r.end - r.start < MIN_TRIM_SPAN ? { start: r.start, end: Math.min(duration, r.start + MIN_TRIM_SPAN) } : r));
    }
  };
  const onHandleKey = (which: 'start' | 'end') => (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.shiftKey ? 1 : 0.1;
    const cur = which === 'start' ? start : end;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - delta;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + delta;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = duration;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (which === 'start') setStart(round2(next));
    else setEnd(round2(next));
  };

  const status = processing
    ? '正在导出音频…'
    : error
      ? error
      : duration
        ? `选区 ${formatPreciseTime(start)} – ${formatPreciseTime(end)}（${(end - start).toFixed(2)} 秒）`
        : '正在读取音频时长…';

  return (
    <AudioDialog
      open
      title="截取音频"
      busy={processing}
      closeLabel={processing ? '取消处理' : '关闭'}
      onClose={onClose}
      footer={(
        <>
          <span className={['cv-audio-dialog__status', !processing && error ? 'is-error' : ''].filter(Boolean).join(' ')} role="status">{status}</span>
          <button type="button" className="cv-audio-btn" onClick={onClose}>{processing ? '取消处理' : '取消'}</button>
          <button
            type="button"
            className="cv-audio-btn cv-audio-btn--primary"
            disabled={processing || !valid}
            onClick={() => onRun(start, end)}
          >
            {processing ? '导出中…' : '导出音频'}
          </button>
        </>
      )}
    >
      <div className="cv-audio-trim">
        <div
          className="cv-audio-trim__ruler"
          aria-hidden
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width && duration) player.current?.seekTo(((e.clientX - rect.left) / rect.width) * duration);
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} style={{ left: `${i * 20}%` }}>{formatPreciseTime((duration * i) / 5)}</span>
          ))}
        </div>
        <AudioPlayer
          ref={player}
          src={src}
          label="音频截取预览"
          trackHeight={148}
          bars={256}
          playRange={valid ? { start, end } : null}
          onDuration={onDuration}
          overlay={({ duration: d }) => (d > 0 ? (
            <div
              ref={overlay}
              className="cv-audio-trim__overlay"
              role="group"
              aria-label="截取选区"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div className="cv-audio-trim__shade" style={{ left: 0, width: `${pct(start)}%` }} />
              <div className="cv-audio-trim__shade" style={{ left: `${pct(end)}%`, right: 0 }} />
              <div className="cv-audio-trim__sel" style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }} />
              <div
                className="cv-audio-trim__handle"
                data-handle="start"
                role="slider"
                tabIndex={0}
                aria-label="截取开始"
                aria-valuemin={0}
                aria-valuemax={round2(end)}
                aria-valuenow={round2(start)}
                aria-valuetext={formatPreciseTime(start)}
                style={{ left: `${pct(start)}%` }}
                onKeyDown={onHandleKey('start')}
              />
              <div
                className="cv-audio-trim__handle"
                data-handle="end"
                role="slider"
                tabIndex={0}
                aria-label="截取结束"
                aria-valuemin={round2(start)}
                aria-valuemax={round2(d)}
                aria-valuenow={round2(end)}
                aria-valuetext={formatPreciseTime(end)}
                style={{ left: `${pct(end)}%` }}
                onKeyDown={onHandleKey('end')}
              />
            </div>
          ) : null)}
        />
        <div className="cv-audio-trim__fields">
          <TimeField label="开始" value={start} min={0} max={Math.max(0, end - MIN_TRIM_SPAN)} disabled={processing || !duration} onCommit={setStart} />
          <TimeField label="结束" value={end} min={Math.min(duration, start + MIN_TRIM_SPAN)} max={duration} disabled={processing || !duration} onCommit={setEnd} />
          <span>时长 <span className="cv-audio-trim__span">{Math.max(0, end - start).toFixed(2)}</span> 秒</span>
          <button
            type="button"
            className="cv-audio-btn cv-audio-btn--sm"
            disabled={processing || !valid}
            title="只播放选中的片段"
            onClick={() => { player.current?.seekTo(start); void player.current?.play(); }}
          >
            <IconPlayerPlay size={14} aria-hidden />试听选区
          </button>
          <button
            type="button"
            className="cv-audio-btn cv-audio-btn--sm"
            disabled={processing || !duration}
            onClick={() => setRange({ start: 0, end: duration })}
          >
            全选
          </button>
        </div>
      </div>
    </AudioDialog>
  );
}
