// -*- coding: utf-8 -*-
/**
 * 时间线播放头走带：只推进时间，不在这里播放声音/画面。
 *
 * 画面与声音的同步在 `TimelineStrip` 里按播放头位置驱动各自的媒体元素
 * （命中片段 play、其余 pause）—— 这与已下线多轨面板「只走带不播放」的历史
 * 结论相反：本节点的播放预览就是最小集里明确要求的能力，所以必须真播出画面。
 *
 * 50ms 一跳（对齐既有时间线实现的节奏）：再快就是无意义的 20Hz 以上重渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { timelineTotal, type TimelineClip } from '../../../types/timeline';

const TICK_MS = 50;

export interface TimelinePlayer {
  playing: boolean;
  playhead: number;
  total: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
}

export function useTimelinePlayer(clips: TimelineClip[]): TimelinePlayer {
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const total = timelineTotal(clips);

  const playheadRef = useRef(0);
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const next = playheadRef.current + TICK_MS / 1000;
      if (next >= totalRef.current) {
        playheadRef.current = totalRef.current;
        setPlayhead(totalRef.current);
        setPlaying(false);
        return;
      }
      playheadRef.current = next;
      setPlayhead(next);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  const seek = useCallback((seconds: number) => {
    const next = Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, totalRef.current));
    playheadRef.current = next;
    setPlayhead(next);
  }, []);

  // 片段被删/被裁短后，播放头可能落到时间线之外 → 收回末尾
  useEffect(() => {
    if (playheadRef.current > total) {
      playheadRef.current = total;
      setPlayhead(total);
    }
  }, [total]);

  const play = useCallback(() => {
    if (totalRef.current <= 0) return;
    // 播到末尾后再按播放 → 从头开始（与主流剪辑器一致）
    if (playheadRef.current >= totalRef.current - 0.01) {
      playheadRef.current = 0;
      setPlayhead(0);
    }
    setPlaying(true);
  }, []);

  const pause = useCallback(() => setPlaying(false), []);
  const stop = useCallback(() => setPlaying(false), []);

  return {
    playing,
    playhead,
    total,
    play,
    pause,
    toggle: () => (playing ? pause() : play()),
    seek,
    stop,
  };
}
