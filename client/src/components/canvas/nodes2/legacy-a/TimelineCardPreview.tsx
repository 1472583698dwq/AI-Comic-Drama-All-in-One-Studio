// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 换皮：时间线卡片的大屏预览（原 timeline/TimelinePreview.tsx 的 card 形态，逻辑不变）。
 * - 未播放时显示播放头所在位置的静帧；点画面 = 播放 / 暂停；
 * - 只让当前片段在跑，另一路立刻停（避免视频声与音频片段叠在一起）；
 * - 画面 contain 不裁切。颜色只用 --cv-*（legacy-a.css 的 .cv-la-tl-preview）。
 * 全屏编辑器仍用原 timeline/TimelinePreview（studio 形态）。
 */
import { useEffect, useRef } from 'react';
import { IconMusic } from '@tabler/icons-react';
import type { TimelineClip } from '../../../../types/timeline';
import { resolveMediaUrl } from '../../../../utils/devOrigin';

export interface TimelineCardPreviewProps {
  clip: TimelineClip | null;
  /** 播放头在当前片段内的源时刻（秒） */
  localTime: number;
  playing: boolean;
  onToggle: () => void;
  videoMuted: boolean;
  audioMuted: boolean;
}

/** play() 在部分环境（jsdom / 老浏览器）不返回 Promise：只在有 catch 时挂上，避免未捕获的拒绝。 */
function safePlay(el: HTMLMediaElement) {
  const p = el.play() as Promise<void> | undefined;
  if (p && typeof p.catch === 'function') p.catch(() => undefined);
}

export function TimelineCardPreview({ clip, localTime, playing, onToggle, videoMuted, audioMuted }: TimelineCardPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isAudioClip = clip?.kind === 'audio';

  // 播放头 → 当前片段：只让「当前这一段」在跑，另一路立刻停
  useEffect(() => {
    const active = isAudioClip ? audioRef.current : videoRef.current;
    const idle = isAudioClip ? videoRef.current : audioRef.current;
    if (idle && !idle.paused) idle.pause();
    if (!active || !clip) return;
    if (Math.abs(active.currentTime - localTime) > 0.3) active.currentTime = Math.max(0, localTime);
    if (playing && active.paused) safePlay(active);
    if (!playing && !active.paused) active.pause();
  }, [clip, clip?.id, isAudioClip, localTime, playing]);

  return (
    <div className="cv-la-tl-preview" data-testid="timeline-preview">
      {!clip && <span className="cv-la-tl-preview__empty">时间线为空：从上游连入视频或添加素材</span>}

      {clip && isAudioClip && (
        <div className="cv-la-tl-preview__audio">
          <IconMusic size={32} stroke={1.4} aria-hidden />
          <span className="cv-la-truncate" style={{ maxWidth: '100%' }}>{clip.name}</span>
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
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="cv-la-tl-preview__video"
          title={playing ? '点击暂停' : '点击播放'}
        />
      )}

      {/* 音频片段轨：与画面同一播放头驱动 */}
      {clip && isAudioClip && <audio key={clip.url} ref={audioRef} src={resolveMediaUrl(clip.url)} muted={audioMuted} />}

      {/* 点画面任意位置都能播放 / 暂停（不受视频元素命中区域限制） */}
      {clip && (
        <button
          type="button"
          aria-label={playing ? '暂停' : '播放'}
          title={playing ? '点击暂停' : '点击播放'}
          onClick={onToggle}
          className="cv-la-tl-preview__hit"
          tabIndex={-1}
        />
      )}
    </div>
  );
}

export default TimelineCardPreview;
