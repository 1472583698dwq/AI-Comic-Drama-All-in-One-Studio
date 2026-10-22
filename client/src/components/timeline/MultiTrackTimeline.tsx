import React, { useRef, useEffect, useMemo, useState } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  ZoomIn, 
  ZoomOut, 
  Film, 
  Mic, 
  Music, 
  Type, 
  MessageSquare,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FolderOpen,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot } from '../../types';
import { API_ORIGIN } from '../../utils/devOrigin';
import { shotsInEpisode } from '../../utils/episodeScope';
import { useProjectExport } from './useProjectExport';

export const MultiTrackTimeline: React.FC = () => {
  const { 
    project, 
    activeShotId, 
    setActiveShotId, 
    activeTab,
    isPlaying, 
    setIsPlaying, 
    currentTime, 
    setCurrentTime, 
    activeEpisodeId,
  } = useProjectStore();

  const [isCollapsed, setIsCollapsed] = useState<boolean>(activeTab !== 'timeline');
  const [zoom, setZoom] = useState<number>(60); // pixels per second
  const timelineRef = useRef<HTMLDivElement>(null);

  // 进「多轨剪辑」自动展开、离开自动收起。
  // 修复前只展不收：去过一次多轨剪辑后，「分镜台」和「多轨剪辑」两个入口画面完全一样。
  useEffect(() => {
    setIsCollapsed(activeTab !== 'timeline');
  }, [activeTab]);

  const shots: StoryboardShot[] = useMemo(
    () => shotsInEpisode(project, activeEpisodeId),
    [project, activeEpisodeId],
  );
  const totalDuration = useMemo(
    () => shots.reduce((sum, sh) => sum + (Number(sh.duration) || 0), 0),
    [shots],
  );
  const episodeTitle = useMemo(() => {
    if (!project || !activeEpisodeId || activeEpisodeId === 'all' || activeEpisodeId === 'none') return '';
    return project.episodes?.find((episode) => episode.id === activeEpisodeId)?.title || '';
  }, [project, activeEpisodeId]);
  const exportTitle = useMemo(
    () => `${project?.title || '时间线'}${episodeTitle ? ` · ${episodeTitle}` : ''}`,
    [project?.title, episodeTitle],
  );
  const exporter = useProjectExport({ project, shots, title: exportTitle });
  const ffmpegReady = exporter.engine === null || exporter.engine.available;
  // 走带 interval 只随 isPlaying 创建一次；每帧读取 store/latest refs。
  // 旧实现把 currentTime/shots/activeShotId 放进依赖，50ms 就被清掉重建，
  // 会造成走带抖动、播放头卡顿，且每次 render 都生成新 shots 数组。
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const totalRef = useRef(totalDuration);
  totalRef.current = totalDuration;

  useEffect(() => {
    if (!isPlaying) return undefined;
    const interval = window.setInterval(() => {
      const st = useProjectStore.getState();
      const nextTime = st.currentTime + 0.05;
      const total = totalRef.current;
      if (nextTime >= total) {
        st.setCurrentTime(0);
        st.setIsPlaying(false);
        return;
      }
      st.setCurrentTime(nextTime);

      // 只在跨镜时更新 activeShotId，避免每帧写 store 触发额外渲染
      let accumulated = 0;
      for (const shot of shotsRef.current) {
        const dur = Math.max(0, Number(shot.duration) || 0);
        if (nextTime >= accumulated && nextTime < accumulated + dur) {
          if (shot.id !== st.activeShotId) st.setActiveShotId(shot.id);
          break;
        }
        accumulated += dur;
      }
    }, 50);
    return () => window.clearInterval(interval);
  }, [isPlaying]);

  // Handle clicking time ruler or track
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left + timelineRef.current.scrollLeft - 180; // track label offset
    if (clickX >= 0) {
      const clickedTime = Math.max(0, Math.min(totalDuration, clickX / zoom));
      setCurrentTime(clickedTime);

      let accumulated = 0;
      for (const shot of shots) {
        if (clickedTime >= accumulated && clickedTime <= accumulated + shot.duration) {
          setActiveShotId(shot.id);
          break;
        }
        accumulated += shot.duration;
      }
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className={`bg-surface border-t border-border flex flex-col select-none text-xs [color:var(--color-text-main)] transition-all duration-300 ease-in-out shrink-0 ${isCollapsed ? 'h-11 overflow-hidden' : 'h-72'}`}>
      {/* 1. Control Toolbar */}
      <div className="h-10 px-3 sm:px-4 border-b border-border flex items-center justify-between bg-surface-secondary shrink-0">
        <div className="flex items-center space-x-2 sm:space-x-3">
          {/* Transport Controls */}
          <button
            onClick={() => setCurrentTime(0)}
            className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
            title="回到开头"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setIsPlaying(!isPlaying)}
            title="时间线走带：只推进播放头，不在此处播放画面与声音（素材预览/连播在分镜台）"
            className="p-1.5 px-3 rounded-lg bg-brand text-white font-medium flex items-center space-x-1.5 shadow-sm shadow-brand/30 hover:opacity-90 transition-all"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{isPlaying ? '暂停走带' : '时间线走带'}</span>
          </button>

          {/* Timecode */}
          <div className="font-mono text-xs bg-surface px-2.5 py-1 rounded border border-border flex items-center gap-2 shadow-sm">
            <div>
              <span className="text-brand font-bold">{formatTime(currentTime)}</span>
              <span className="[color:var(--color-text-muted)] mx-1">/</span>
              <span className="[color:var(--color-text-secondary)]">{formatTime(totalDuration)}</span>
            </div>
            <button
              onClick={() => useProjectStore.getState().autoFitAllDurations()}
              className="px-2 py-0.5 rounded bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand text-[10px] font-bold flex items-center gap-1 transition-all"
              title="根据全剧所有镜头的配音/台词长度自动智能吸附对齐时长"
            >
              <Sparkles className="w-3 h-3 text-brand" /> 全剧时长自适应
            </button>
          </div>
        </div>

        {/* Collapsed State Hint */}
        {isCollapsed && (
          <div className="hidden lg:flex items-center gap-2 text-[11px] text-gray-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>多轨已就绪 · 共 {shots.length} 个镜头 · 点击右侧展开多轨剪辑</span>
          </div>
        )}

        {/* Zoom Slider, Export & Collapse Toggle */}
        <div className="flex items-center space-x-2">
          <button
            onClick={exporter.exportMp4}
            disabled={exporter.busy || !ffmpegReady}
            aria-label="导出 MP4"
            title={
              ffmpegReady
                ? '把主画面 / 视频原声 / 配音 / 字幕 / BGM 合成为一条 MP4（保存到 exports/timeline）'
                : (exporter.engine?.ffmpeg_hint || 'ffmpeg 未就绪，无法导出 MP4')
            }
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-brand/40 bg-brand/15 text-brand hover:bg-brand/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {exporter.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline whitespace-nowrap">
              {exporter.busy
                ? `${exporter.mp4.stage || '合成'} ${Math.max(0, Math.round(exporter.mp4.progress))}%`
                : exporter.mp4.status === 'success'
                  ? '再次导出 MP4'
                  : '导出 MP4'}
            </span>
          </button>

          {!isCollapsed && (
            <div className="flex items-center space-x-2 mr-2">
              <button
                onClick={() => setZoom(Math.max(30, zoom - 15))}
                className="p-1 rounded [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]"
                title="缩小时间线"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <input
                type="range"
                min="30"
                max="150"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-20 lg:w-24 h-1 bg-surface-tertiary rounded-lg appearance-none cursor-pointer accent-brand"
              />
              <button
                onClick={() => setZoom(Math.min(150, zoom + 15))}
                className="p-1 rounded [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]"
                title="放大时间线"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border ${
              isCollapsed 
                ? 'bg-brand/15 hover:bg-brand/25 border-brand/40 text-brand shadow-sm'
                : 'bg-surface-tertiary hover:bg-surface border-border text-gray-300 hover:text-white'
            }`}
            title={isCollapsed ? '展开多轨剪辑时间线 (音画对齐/多轨)' : '收起时间线以获取最大视口空间'}
          >
            {isCollapsed ? <ChevronUp className="w-3.5 h-3.5 text-brand" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
            <span className="whitespace-nowrap">{isCollapsed ? '展开多轨精剪' : '收起时间线'}</span>
          </button>
        </div>
      </div>

      {!isCollapsed && (exporter.busy || exporter.mp4.status === 'success' || exporter.mp4.status === 'error') && (
        <div className="px-3 sm:px-4 py-1.5 border-b border-border flex items-center gap-2 text-[11px] bg-surface-secondary/60 shrink-0">
          {exporter.busy && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand shrink-0" />
              <span className="[color:var(--color-text-secondary)] shrink-0">
                {exporter.mp4.stage || '合成'}中…
              </span>
              <span className="flex-1 max-w-[220px] h-1 rounded-full overflow-hidden bg-surface-tertiary">
                <span
                  className="block h-full bg-brand transition-[width] duration-300"
                  style={{ width: `${Math.max(5, Math.min(100, exporter.mp4.progress))}%` }}
                />
              </span>
              <span className="font-mono text-[10px] [color:var(--color-text-muted)] shrink-0">
                {Math.max(0, Math.round(exporter.mp4.progress))}%
              </span>
            </>
          )}
          {!exporter.busy && exporter.mp4.status === 'success' && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-emerald-600 dark:text-emerald-300" title={exporter.mp4.task?.output_path}>
                成片已导出
                {exporter.mp4.task?.duration ? ` · ${Number(exporter.mp4.task.duration).toFixed(1)}s` : ''}
                {exporter.mp4.task?.output_url ? ` · ${exporter.mp4.task.output_url.split('/').pop()}` : ''}
              </span>
              {!!exporter.mp4.task?.warnings?.length && (
                <span
                  className="text-amber-500 shrink-0"
                  title={exporter.mp4.task.warnings.join('\n')}
                >
                  {exporter.mp4.task.warnings.length} 条提示
                </span>
              )}
              <button
                onClick={exporter.downloadResult}
                className="ml-auto shrink-0 h-6 px-2 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/10"
              >
                下载成片
              </button>
              <button
                onClick={exporter.openResultFolder}
                className="shrink-0 h-6 px-2 rounded border border-border [color:var(--color-text-secondary)] hover:text-brand hover:border-brand/50 flex items-center gap-1"
              >
                <FolderOpen className="w-3 h-3" /> 打开目录
              </button>
            </>
          )}
          {!exporter.busy && exporter.mp4.status === 'error' && (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-amber-600 dark:text-amber-300" title={exporter.mp4.error || ''}>
                {exporter.mp4.error}
              </span>
              {!ffmpegReady && (
                <span className="shrink-0 text-[10px] [color:var(--color-text-muted)]" title={exporter.engine?.ffmpeg_hint}>
                  可改用「导出剪映草稿」
                </span>
              )}
              <button
                onClick={exporter.exportMp4}
                disabled={!ffmpegReady}
                className="ml-auto shrink-0 h-6 px-2 rounded border border-border [color:var(--color-text-secondary)] hover:text-brand hover:border-brand/50 disabled:opacity-40"
              >
                重试
              </button>
            </>
          )}
        </div>
      )}

      {/* 2. Multi-track Canvas Container */}
      {!isCollapsed && (
      <div 
        ref={timelineRef}
        onClick={handleTimelineClick}
        className="flex-1 overflow-x-auto overflow-y-hidden relative bg-surface-secondary/40 custom-scrollbar"
      >
        {/* Track Content Area */}
        <div 
          className="relative h-full"
          style={{ width: `${Math.max(800, totalDuration * zoom + 300)}px` }}
        >
          {/* Top Time Ruler */}
          <div className="h-6 border-b border-border pl-44 flex items-center relative bg-surface-secondary/80">
            {Array.from({ length: Math.ceil(totalDuration) + 3 }).map((_, sec) => (
              <div
                key={sec}
                className="absolute text-[10px] [color:var(--color-text-muted)] font-mono flex flex-col items-center"
                style={{ left: `${sec * zoom + 180}px` }}
              >
                <span>{sec}s</span>
                <span className="h-1.5 w-[1px] bg-border mt-0.5" />
              </div>
            ))}
          </div>

          {/* Red Scrubbing Playhead Indicator */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-accent-orange z-20 pointer-events-none transition-all shadow-[0_0_8px_rgba(249,115,22,0.8)]"
            style={{ left: `${currentTime * zoom + 180}px` }}
          >
            <div className="w-2.5 h-2.5 bg-accent-orange rotate-45 -ml-1 -mt-0.5 rounded-sm shadow-md" />
          </div>

          {/* Tracks List */}
          <div className="divide-y divide-border">
            {/* Track 1: 🎬 视频分镜画面轨 */}
            <div className="h-14 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Film className="w-3.5 h-3.5 text-brand" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">主分镜画面轨</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderShotTrack(shots, zoom, activeShotId, setActiveShotId)}
              </div>
            </div>

            {/* Track 2: 🎙️ 配音轨（对白与旁白共用同一份 TTS 素材） */}
            <div className="h-12 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Mic className="w-3.5 h-3.5 text-accent-pink" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">对白/旁白配音</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderDialogueTrack(shots, zoom)}
              </div>
            </div>

            {/* Track 3: 💬 字幕轨 */}
            <div className="h-10 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Type className="w-3.5 h-3.5 text-accent-green" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">漫剧字幕</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderSubtitleTrack(shots, zoom)}
              </div>
            </div>

            {/* Track 4: 🎵 BGM 轨（仅当项目绑定了真实音频素材） */}
            <div className="h-10 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Music className="w-3.5 h-3.5 text-accent-orange" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">BGM 氛围原声</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {project?.bgm_url ? (
                  <div
                    className="absolute h-8 rounded-lg bg-accent-orange/15 border border-accent-orange/40 flex items-center px-3 space-x-2"
                    style={{ left: '0px', width: `${totalDuration * zoom}px` }}
                  >
                    <Music className="w-3 h-3 text-accent-orange shrink-0" />
                    <span className="text-[10px] text-accent-orange font-medium truncate">
                      {project.bgm_name || project.bgm_url.split('/').pop()} · 导出时按素材长度平铺
                    </span>
                  </div>
                ) : (
                  <div
                    className="absolute h-8 rounded-lg border border-dashed border-border flex items-center px-3"
                    style={{ left: '0px', width: `${totalDuration * zoom}px` }}
                  >
                    <span className="text-[10px] text-gray-500 truncate">未绑定 BGM 素材 · 导出的剪映草稿不含音乐轨</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
};

// Helper: Render Video Shot Track
function renderShotTrack(
  shots: StoryboardShot[], 
  zoom: number, 
  activeShotId: string | null, 
  setActiveShotId: (id: string) => void
) {
  let accumulated = 0;
  return shots.map((shot) => {
    const start = accumulated;
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;
    const isActive = shot.id === activeShotId;
    // 剪辑只认最终成片和分镜图；白模/预演视频是生成参考，不进入剪辑与导出。
    const frame = shot.video_url || shot.image_url;
    const thumb = shot.image_url;
    const mediaLabel = shot.video_url ? '成片' : shot.image_url ? '静帧' : '无画面';

    return (
      <div
        key={shot.id}
        onClick={(e) => {
          e.stopPropagation();
          setActiveShotId(shot.id);
          // 点片段即把预览/播放头定位到该镜起点，右侧才能单独编辑这一镜。
          useProjectStore.getState().setCurrentTime(start);
        }}
        className={`absolute h-12 rounded-lg overflow-hidden border cursor-pointer transition-all flex items-center shadow-sm ${
          isActive
            ? 'border-brand bg-brand/20 ring-2 ring-brand/50 z-10'
            : frame
              ? 'border-border bg-surface hover:border-brand/50'
              : 'border-dashed border-red-500/50 bg-red-500/5'
        }`}
        style={{ left: `${left}px`, width: `${width - 4}px` }}
        title={frame ? undefined : '该镜还没有成片视频或分镜图，导出剪映草稿时会被跳过'}
      >
        {thumb && (
          <img 
            src={thumb.startsWith('/') ? API_ORIGIN + thumb : thumb} 
            alt={`Shot ${shot.shot_index}`} 
            className="w-12 h-full object-cover rounded-l opacity-90" 
          />
        )}
        <div className="p-1.5 truncate flex-1 flex flex-col justify-center">
          <div className="flex items-center space-x-1">
            <span className="font-bold text-[10px] [color:var(--color-text-main)]">#{shot.shot_index}</span>
            <span className="text-[9px] px-1 rounded bg-surface-secondary border border-border text-brand font-mono">
              {shot.duration}s
            </span>
            {frame
              ? <span className={`text-[9px] ${shot.video_url ? 'text-brand-blue/80' : 'text-gray-500'}`}>{mediaLabel}</span>
              : <span className="text-[9px] text-red-300">无画面</span>}
          </div>
          <p className="text-[9px] [color:var(--color-text-muted)] truncate">{shot.action_desc || shot.image_prompt}</p>
        </div>
      </div>
    );
  });
}

// Helper: Render Dialogue Track — 块的存在与否取决于"是否真的有配音文件"，与导出器口径一致
function renderDialogueTrack(shots: StoryboardShot[], zoom: number) {
  let accumulated = 0;
  return shots.map((shot) => {
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;

    const script = shot.dialogue || shot.voiceover || '';
    const isVoiceover = !shot.dialogue && !!shot.voiceover;
    const audioSec = shot.audio_duration || 0;

    if (!shot.audio_url) {
      if (!script) return null;
      return (
        <div
          key={shot.id}
          className="absolute h-9 rounded-lg border border-dashed border-accent-pink/40 flex items-center px-2 overflow-hidden"
          style={{ left: `${left}px`, width: `${width - 4}px` }}
          title={`台词/旁白还没有配音文件，导出时该镜只有画面与字幕：${script}`}
        >
          <span className="text-[10px] text-accent-pink/60 truncate">#{shot.shot_index} 待配音 · {script}</span>
        </div>
      );
    }

    const clipped = audioSec > shot.duration + 0.05;
    return (
      <div
        key={shot.id}
        className={`absolute h-9 rounded-lg border flex items-center px-2 space-x-1.5 overflow-hidden ${
          clipped
            ? 'bg-red-500/15 border-red-500/50'
            : 'bg-accent-pink/15 border-accent-pink/40'
        }`}
        style={{ left: `${left}px`, width: `${width - 4}px` }}
        title={clipped ? `配音 ${audioSec.toFixed(2)}s 超出该镜 ${shot.duration}s 槽位，导出时会被截断` : undefined}
      >
        <span className={`text-[10px] font-semibold truncate ${clipped ? 'text-red-300' : 'text-accent-pink'}`}>
          {isVoiceover ? '[旁白] ' : `${shot.speaker_name || '未署名'}: `}“{script}”
        </span>
        <span className="text-[9px] font-mono ml-auto shrink-0 text-white/45">
          {clipped ? '⚠ ' : ''}{audioSec ? `${audioSec.toFixed(1)}s` : '未测长'}
        </span>
      </div>
    );
  });
}

// Helper: Render Subtitle Track
function renderSubtitleTrack(shots: StoryboardShot[], zoom: number) {
  let accumulated = 0;
  return shots.map((shot) => {
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;

    if (!shot.subtitle_text) return null;

    return (
      <div
        key={shot.id}
        className="absolute h-7 rounded-lg bg-accent-green/10 border border-accent-green/30 flex items-center px-2 space-x-1 overflow-hidden"
        style={{ left: `${left}px`, width: `${width - 4}px` }}
      >
        <MessageSquare className="w-2.5 h-2.5 text-accent-green flex-shrink-0" />
        <span className="text-[9px] text-accent-green/90 truncate font-mono">
          {shot.subtitle_text}
        </span>
      </div>
    );
  });
}
