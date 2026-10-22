import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Film, Maximize, Pause, Play, SlidersHorizontal, Volume2, VolumeX,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { API_ORIGIN } from '../../utils/devOrigin';
import { shotsInEpisode } from '../../utils/episodeScope';
import { formatTimecode } from '../../types/timeline';
import type { StoryboardShot } from '../../types';

const resolveMediaUrl = (url?: string | null) => {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  return url.startsWith('/') ? API_ORIGIN + url : `${API_ORIGIN}/${url}`;
};

const isVideoUrl = (url: string) => /^(data:video\/|blob:)/.test(url) || /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i.test(url);
const isImageUrl = (url: string) => /^(data:image\/|blob:)/.test(url) || /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(url);

function shotMedia(shot: StoryboardShot | undefined): { url: string; kind: 'video' | 'image' | 'none'; label: string } {
  if (!shot) return { url: '', kind: 'none', label: '' };
  // 剪辑只认最终成片或分镜图；白模/预演只服务生成参考，不进入剪辑预览。
  if (shot.video_url) return { url: shot.video_url, kind: 'video', label: '成片' };
  if (shot.image_url) return { url: shot.image_url, kind: 'image', label: '分镜图' };
  return { url: '', kind: 'none', label: '' };
}

export const ProjectTimelinePreview: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const activeEpisodeId = useProjectStore((s) => s.activeEpisodeId);
  const currentTime = useProjectStore((s) => s.currentTime);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying);
  const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
  const setActiveShotId = useProjectStore((s) => s.setActiveShotId);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);

  const shots = useMemo(
    () => shotsInEpisode(project, activeEpisodeId) as StoryboardShot[],
    [project, activeEpisodeId],
  );
  const total = useMemo(
    () => shots.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration) || 0), 0),
    [shots],
  );

  const { shot, index, localTime } = useMemo(() => {
    if (!shots.length) return { shot: undefined as StoryboardShot | undefined, index: -1, localTime: 0 };
    let acc = 0;
    const t = Math.max(0, Math.min(currentTime, total));
    for (let i = 0; i < shots.length; i += 1) {
      const dur = Math.max(0, Number(shots[i].duration) || 0);
      if (t < acc + dur || i === shots.length - 1) {
        return { shot: shots[i], index: i, localTime: Math.max(0, t - acc) };
      }
      acc += dur;
    }
    return { shot: shots[shots.length - 1], index: shots.length - 1, localTime: 0 };
  }, [shots, currentTime, total]);

  const media = shotMedia(shot);
  const mediaUrl = resolveMediaUrl(media.url);
  const mediaKind = media.kind === 'none' && mediaUrl
    ? (isVideoUrl(mediaUrl) ? 'video' : isImageUrl(mediaUrl) ? 'image' : 'none')
    : media.kind;
  // 下一镜预加载：剪辑点卡顿主要来自新 <video> 才刚开始 buffer。
  const nextShot = index >= 0 ? shots[index + 1] : shots[0];
  const nextMedia = shotMedia(nextShot);
  const nextMediaUrl = resolveMediaUrl(nextMedia.url);
  const nextVoiceUrl = resolveMediaUrl(nextShot?.audio_url);

  const [muted, setMuted] = useState(false);
  const hasVoice = !!shot?.audio_url;
  const videoMuted = muted || hasVoice;
  const voiceUrl = resolveMediaUrl(shot?.audio_url);
  const bgmUrl = resolveMediaUrl(project?.bgm_url);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const monitorRef = useRef<HTMLDivElement | null>(null);
  const lastVideoSyncRef = useRef(0);
  const lastVoiceSyncRef = useRef(0);
  const lastBgmSyncRef = useRef(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, localTime);
    const sync = () => {
      if (Math.abs(v.currentTime - target) > 0.3) {
        try { v.currentTime = target; } catch { /* metadata not ready */ }
      }
    };
    if (v.readyState >= 1) sync();
    else v.addEventListener('loadedmetadata', sync, { once: true });
    if (isPlaying) v.play().catch(() => undefined);
    else v.pause();
    return () => v.removeEventListener('loadedmetadata', sync);
  }, [shot?.id, mediaUrl, isPlaying]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!isPlaying) {
      if (Math.abs(v.currentTime - localTime) > 0.2) {
        try { v.currentTime = Math.max(0, localTime); } catch { /* ignore */ }
      }
      return;
    }
    // 播放中让视频自己走，最多每 500ms 校一次漂移；每 50ms seek 会明显卡顿。
    const now = performance.now();
    if (now - lastVideoSyncRef.current < 500) return;
    if (Math.abs(v.currentTime - localTime) > 0.7) {
      try { v.currentTime = Math.max(0, localTime); } catch { /* ignore */ }
      lastVideoSyncRef.current = now;
    }
  }, [localTime, isPlaying, mediaUrl]);

  useEffect(() => {
    const a = voiceRef.current;
    if (!a) return;
    const target = Math.max(0, localTime);
    const sync = () => {
      if (Math.abs(a.currentTime - target) > 0.3) {
        try { a.currentTime = target; } catch { /* metadata not ready */ }
      }
    };
    if (a.readyState >= 1) sync();
    else a.addEventListener('loadedmetadata', sync, { once: true });
    if (isPlaying) a.play().catch(() => undefined);
    else a.pause();
    return () => a.removeEventListener('loadedmetadata', sync);
  }, [shot?.id, isPlaying, hasVoice, voiceUrl]);

  useEffect(() => {
    const a = voiceRef.current;
    if (!a) return;
    if (!isPlaying) {
      if (Math.abs(a.currentTime - localTime) > 0.2) {
        try { a.currentTime = Math.max(0, localTime); } catch { /* ignore */ }
      }
      return;
    }
    const now = performance.now();
    if (now - lastVoiceSyncRef.current < 500) return;
    if (Math.abs(a.currentTime - localTime) > 0.7) {
      try { a.currentTime = Math.max(0, localTime); } catch { /* ignore */ }
      lastVoiceSyncRef.current = now;
    }
  }, [localTime, isPlaying, voiceUrl]);

  useEffect(() => {
    const a = bgmRef.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, Number(project?.bgm_volume ?? 0.5)));
    if (isPlaying && bgmUrl) a.play().catch(() => undefined);
    else a.pause();
  }, [isPlaying, bgmUrl, project?.bgm_volume]);

  useEffect(() => {
    const a = bgmRef.current;
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
    const now = performance.now();
    if (isPlaying && now - lastBgmSyncRef.current < 1200) return;
    const target = currentTime % a.duration;
    if (Math.abs(a.currentTime - target) > 1.0) {
      try { a.currentTime = target; } catch { /* ignore */ }
      lastBgmSyncRef.current = now;
    }
  }, [currentTime, isPlaying, bgmUrl]);

  const togglePlay = () => setIsPlaying(!isPlaying);
  const seek = (value: number) => setCurrentTime(Math.max(0, Math.min(total, value)));
  const jumpShot = (delta: number) => {
    const next = Math.min(shots.length - 1, Math.max(0, index + delta));
    let start = 0;
    for (let i = 0; i < next; i += 1) start += Math.max(0, Number(shots[i].duration) || 0);
    setCurrentTime(start);
    if (shots[next]) setActiveShotId(shots[next].id);
  };
  const toggleFullscreen = () => {
    const el = monitorRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };

  const aspect = project?.aspect_ratio || '9:16';
  const ratio = aspect === '16:9' ? 16 / 9 : aspect === '1:1' ? 1 : 9 / 16;
  const landscape = ratio >= 1;
  const stageStyle: React.CSSProperties = landscape
    ? { width: '100%', aspectRatio: `${ratio}` }
    : { height: '100%', aspectRatio: `${ratio}` };

  if (!project) {
    return <div className="flex-1 flex items-center justify-center text-xs text-gray-500">先打开一个项目</div>;
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
      <div
        ref={monitorRef}
        className="relative flex-1 min-h-0 flex flex-col items-center justify-center overflow-hidden bg-black/95 px-4 pt-4 pb-2"
      >
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          <div
            className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl shadow-black/50"
            style={stageStyle}
          >
          {!shot && (
            <div className="flex flex-col items-center gap-2 px-6 text-center">
              <Film className="h-10 w-10 text-white/25" strokeWidth={1.4} />
              <span className="text-xs text-white/55">当前集还没有分镜</span>
              <span className="text-[10px] text-white/30">先去分镜台生成或导入分镜，再回到这里预览剪辑。</span>
            </div>
          )}

          {shot && mediaKind === 'video' && mediaUrl && (
            <video
              key={`${shot.id}:${mediaUrl}`}
              ref={videoRef}
              src={mediaUrl}
              poster={resolveMediaUrl(shot.image_url)}
              muted={videoMuted}
              playsInline
              preload="auto"
              className="h-full w-full cursor-pointer object-contain"
              onClick={togglePlay}
            />
          )}

          {shot && mediaKind === 'image' && mediaUrl && (
            <img
              src={mediaUrl}
              alt={`分镜 #${shot.shot_index}`}
              className="h-full w-full cursor-pointer object-contain"
              onClick={togglePlay}
            />
          )}

          {nextMediaUrl && nextMedia.kind === 'video' && (
            <video
              key={`preload:${nextShot?.id}:${nextMediaUrl}`}
              src={nextMediaUrl}
              preload="auto"
              muted
              playsInline
              aria-hidden
              className="pointer-events-none absolute h-px w-px opacity-0"
            />
          )}
          {nextMediaUrl && nextMedia.kind === 'image' && (
            <img
              key={`preload:${nextShot?.id}:${nextMediaUrl}`}
              src={nextMediaUrl}
              alt=""
              aria-hidden
              className="pointer-events-none absolute h-px w-px opacity-0"
            />
          )}
          {nextVoiceUrl && (
            <audio key={`preload:${nextShot?.id}:${nextVoiceUrl}`} src={nextVoiceUrl} preload="auto" muted />
          )}

          {shot && !mediaUrl && (
            <div className="flex flex-col items-center gap-2 px-6 text-center">
              <Film className="h-10 w-10 text-white/20" strokeWidth={1.4} />
              <span className="text-xs text-white/55">分镜 #{shot.shot_index} 暂无画面素材</span>
              <span className="text-[10px] text-white/30">生成分镜图或成片视频后，这里会同步显示。</span>
            </div>
          )}

          {shot && (
            <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] font-bold text-white backdrop-blur">
                #{shot.shot_index}
              </span>
              {media.label && (
                <span className="rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white/80 backdrop-blur">
                  {media.label}
                </span>
              )}
              <span className="rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] text-white/60 backdrop-blur">
                {shot.camera_framing} / {shot.camera_motion}
              </span>
            </div>
          )}

          {shot?.subtitle_text && (
            <div className="pointer-events-none absolute inset-x-4 bottom-5 z-10 flex justify-center">
              <span className="max-w-[88%] rounded-md bg-black/55 px-2.5 py-1 text-center text-[13px] font-semibold leading-snug text-white shadow-lg shadow-black/40 backdrop-blur-sm [text-shadow:0_1px_2px_rgba(0,0,0,.8)]">
                {shot.subtitle_text}
              </span>
            </div>
          )}

          {shot && isPlaying && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/45 to-transparent" />
          )}
          </div>
        </div>

        <div className="mt-2 flex h-10 w-full max-w-4xl shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-2.5 backdrop-blur">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? '暂停预览' : '播放预览'}
            disabled={!shots.length}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-sm shadow-brand/30 transition-colors hover:bg-brand-light disabled:opacity-40"
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => jumpShot(-1)}
            aria-label="上一个分镜"
            disabled={index <= 0}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-25"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => jumpShot(1)}
            aria-label="下一个分镜"
            disabled={index < 0 || index >= shots.length - 1}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-25"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <input
            type="range"
            min={0}
            max={Math.max(total, 0.1)}
            step={0.01}
            value={Math.min(currentTime, Math.max(total, 0.1))}
            onChange={(e) => seek(Number(e.target.value))}
            className="min-w-0 flex-1 accent-brand"
            aria-label="预览进度"
          />

          <span className="shrink-0 font-mono text-[10.5px] text-white/65">
            {formatTimecode(currentTime, { withHours: true })}
            <span className="mx-1 text-white/25">/</span>
            {formatTimecode(total, { withHours: true })}
          </span>

          <button
            type="button"
            onClick={() => setMuted((v) => !v)}
            aria-label={muted ? '取消静音' : '静音'}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${muted ? 'text-amber-300 hover:bg-white/10' : 'text-white/55 hover:bg-white/10 hover:text-white'}`}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="全屏预览"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Maximize className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!shot}
            onClick={() => {
              if (!shot) return;
              setIsPlaying(false);
              setActiveShotId(shot.id);
              setActiveTab('studio');
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent('storyboard-open-shot', { detail: { shotId: shot.id } }));
              }, 150);
            }}
            title="到分镜台单独编辑当前镜的参数/参考绑定（不影响其他镜头）"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-white/12 px-2 text-[10.5px] font-semibold text-white/65 transition-colors hover:border-brand/50 hover:text-brand disabled:opacity-30"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">编辑此镜</span>
          </button>
        </div>

        {voiceUrl && <audio key={`${shot?.id}:${voiceUrl}`} ref={voiceRef} src={voiceUrl} muted={muted} preload="auto" />}
        {bgmUrl && <audio ref={bgmRef} src={bgmUrl} muted={muted} loop preload="auto" />}
      </div>
    </div>
  );
};
