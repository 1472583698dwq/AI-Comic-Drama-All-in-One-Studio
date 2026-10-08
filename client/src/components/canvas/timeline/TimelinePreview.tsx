// -*- coding: utf-8 -*-
/**
 * 时间线预览屏（卡片大屏与全屏编辑器共用）。
 *
 * 行为（对齐参考图）：
 * - 未播放时显示**播放头所在位置的静帧**；点画面 = 播放/暂停 —— 点下去就在这块大屏上播。
 * - 画面按素材自身画幅自适应并**尽量占满**：竖屏素材撑满高度、横屏素材撑满宽度，
 *   不做裁切（contain），所以看起来比固定 16:9 容器里那点画面大得多。
 * - 视频轨/音频轨各自的静音由外部传入：`videoMuted` 控画面自带声音，
 *   `audioMuted` 控音频片段轨；两个都默认静音，避免画布上突然出声。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Music, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { formatTimecode, type TimelineClip } from '../../../types/timeline';
import { resolveMediaUrl } from '../../../utils/devOrigin';

interface Props {
  clip: TimelineClip | null;
  /** 播放头在当前片段内的源时刻（秒） */
  localTime: number;
  playing: boolean;
  playhead: number;
  total: number;
  onToggle: () => void;
  variant?: 'card' | 'studio';
  videoMuted: boolean;
  audioMuted: boolean;
  /** 全屏编辑器：整体音量开关（视频/音频两轨一起切）；给了才显示音量按钮 */
  onToggleVolume?: () => void;
}

export const TimelinePreview: React.FC<Props> = ({
  clip,
  localTime,
  playing,
  playhead,
  total,
  onToggle,
  variant = 'studio',
  videoMuted,
  audioMuted,
  onToggleVolume,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isAudioClip = clip?.kind === 'audio';
  const isStudio = variant === 'studio';
  const masterMuted = videoMuted && audioMuted;

  // 播放头 → 当前片段：只让「当前这一段」在跑，另一路立刻停，避免两路声音叠在一起
  useEffect(() => {
    const active = isAudioClip ? audioRef.current : videoRef.current;
    const idle = isAudioClip ? videoRef.current : audioRef.current;
    if (idle && !idle.paused) idle.pause();
    if (!active || !clip) return;
    if (Math.abs(active.currentTime - localTime) > 0.3) active.currentTime = Math.max(0, localTime);
    if (playing && active.paused) active.play().catch(() => undefined);
    if (!playing && !active.paused) active.pause();
  }, [clip, clip?.id, isAudioClip, localTime, playing]);

  const enterFullscreen = () => {
    const el = videoRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };

  const surface = isStudio ? 'flex-1 min-h-0' : 'h-[220px]';

  // 画面区（卡片态即整块预览；全屏态是控制栏上方的画面）
  const screen = (
    <>
      {!clip && (
        <span className="text-[11px] [color:var(--color-text-muted)] px-4 text-center">
          时间线为空：从上游连入视频或添加素材
        </span>
      )}

      {clip && isAudioClip && (
        <div className="flex flex-col items-center gap-2 text-cyan-300/80">
          <Music className={isStudio ? 'w-12 h-12' : 'w-8 h-8'} strokeWidth={1.4} />
          <span className="text-[11px] max-w-[70%] truncate">{clip.name}</span>
        </div>
      )}

      {clip && !isAudioClip && (
        <video
          key={clip.url}
          ref={videoRef}
          src={resolveMediaUrl(clip.url)}
          muted={videoMuted}
          playsInline
          preload="auto"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="max-w-full max-h-full cursor-pointer object-contain"
          title={playing ? '点击暂停' : '点击播放'}
        />
      )}

      {/* 音频片段轨：与画面同一播放头驱动（参考图的「音频音轨」） */}
      {clip && isAudioClip && (
        <audio
          key={clip.url}
          ref={audioRef}
          src={resolveMediaUrl(clip.url)}
          muted={audioMuted}
        />
      )}

      {/* 点画面任意位置都能播放/暂停（不受视频元素命中区域限制） */}
      {clip && (
        <button
          aria-label={playing ? '暂停' : '播放'}
          title={playing ? '点击暂停' : '点击播放'}
          onClick={onToggle}
          className="absolute inset-0 cursor-pointer"
          tabIndex={-1}
        />
      )}
    </>
  );

  // 卡片态：预览就是一整块画面（控制都在节点工具行里）
  if (!isStudio) {
    return (
      <div className={`relative flex items-center justify-center overflow-hidden ${surface}`} style={{ background: 'var(--color-background)' }}>
        {screen}
      </div>
    );
  }

  // 全屏态：画面 + **独立的一栏控制条**（播放/时间码居中，音量/全屏居右，参考图样式）。
  // 根节点 h-full：无论视频什么尺寸，画面区固定占满面板剩余空间，控制栏永远贴在容器底部
  // （之前根节点高度随内容走，遇到高个视频会把控制栏挤出面板外 —— 表现为"控制栏消失"）。
  return (
    <div className="relative flex flex-col h-full min-h-0" style={{ background: 'var(--color-background)' }}>
      <div className={`relative flex items-center justify-center overflow-hidden ${surface}`}>{screen}</div>
      <div className="h-10 shrink-0 px-3 flex items-center border-t border-white/70 dark:border-white/12" style={{ background: 'var(--color-surface)' }}>
        <span className="flex-1" />
        <button
          onClick={onToggle}
          aria-label={playing ? '暂停' : '播放'}
          title={playing ? '暂停' : '播放'}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-brand text-white hover:bg-brand-light shadow-sm shadow-brand/30 transition-colors"
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <span className="font-mono text-[11px] leading-none mx-2.5">
          <span className="font-semibold [color:var(--color-text-main)]">{formatTimecode(playhead, { withHours: true })}</span>
          <span className="[color:var(--color-text-muted)] mx-1.5">/</span>
          <span className="[color:var(--color-text-secondary)]">{formatTimecode(total, { withHours: true })}</span>
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          {onToggleVolume && (
            <button
              onClick={onToggleVolume}
              aria-label={masterMuted ? '开启声音' : '静音'}
              aria-pressed={!masterMuted}
              title={masterMuted ? '开启声音（视频/音频轨一起）' : '静音（视频/音频轨一起）'}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                masterMuted
                  ? '[color:var(--color-text-muted)] hover:bg-surface/80'
                  : 'text-brand hover:bg-brand/10'
              }`}
            >
              {masterMuted ? <VolumeX className="w-4 h-4" strokeWidth={1.8} /> : <Volume2 className="w-4 h-4" strokeWidth={1.8} />}
            </button>
          )}
          <button
            onClick={enterFullscreen}
            aria-label="全屏播放画面"
            title="全屏播放画面"
            className="w-7 h-7 rounded-lg flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80 transition-colors"
          >
            <Maximize className="w-4 h-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>
    </div>
  );
};
