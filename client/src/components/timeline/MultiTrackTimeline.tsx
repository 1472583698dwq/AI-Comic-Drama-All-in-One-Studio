import React, { useRef, useEffect, useState } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  ZoomIn, 
  ZoomOut, 
  Volume2, 
  Film, 
  Mic, 
  Music, 
  Type, 
  MessageSquare,
  Sparkles,
  Scissors,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot } from '../../types';

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
    totalDuration,
    updateShot
  } = useProjectStore();

  const [isCollapsed, setIsCollapsed] = useState<boolean>(activeTab !== 'timeline');
  const [zoom, setZoom] = useState<number>(60); // pixels per second
  const timelineRef = useRef<HTMLDivElement>(null);

  // 进「多轨剪辑」自动展开、离开自动收起。
  // 修复前只展不收：去过一次多轨剪辑后，「分镜工作台」和「多轨剪辑」两个入口画面完全一样。
  useEffect(() => {
    setIsCollapsed(activeTab !== 'timeline');
  }, [activeTab]);

  const shots: StoryboardShot[] = project?.scenes.flatMap((s) => s.shots) || [];

  // Playback timer ticker
  useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        const nextTime = currentTime + 0.05;
        if (nextTime >= totalDuration) {
          setCurrentTime(0);
          setIsPlaying(false);
        } else {
          setCurrentTime(nextTime);
          
          // Auto sync active shot
          let accumulated = 0;
          for (const shot of shots) {
            if (nextTime >= accumulated && nextTime < accumulated + shot.duration) {
              if (shot.id !== activeShotId) {
                setActiveShotId(shot.id);
              }
              break;
            }
            accumulated += shot.duration;
          }
        }
      }, 50);
    }
    return () => clearInterval(interval);
  }, [isPlaying, currentTime, totalDuration, shots, activeShotId]);

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
            className="p-1.5 px-3 rounded-lg bg-brand text-white font-medium flex items-center space-x-1.5 shadow-sm shadow-brand/30 hover:opacity-90 transition-all"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{isPlaying ? '暂停' : '播放'}</span>
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

        {/* Zoom Slider & Collapse Toggle */}
        <div className="flex items-center space-x-2">
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

            {/* Track 2: 🎙️ 角色对白配音轨 */}
            <div className="h-12 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Mic className="w-3.5 h-3.5 text-accent-pink" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">角色对白配音</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderDialogueTrack(shots, zoom, activeShotId)}
              </div>
            </div>

            {/* Track 3: 📢 史诗旁白解说轨 */}
            <div className="h-11 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Volume2 className="w-3.5 h-3.5 text-brand-blue" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">史诗旁白解说</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderVoiceoverTrack(shots, zoom)}
              </div>
            </div>

            {/* Track 4: 💬 动态花字字幕轨 */}
            <div className="h-10 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Type className="w-3.5 h-3.5 text-accent-green" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">动态漫剧字幕</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                {renderSubtitleTrack(shots, zoom)}
              </div>
            </div>

            {/* Track 5: 🎵 BGM & 音效轨 */}
            <div className="h-10 flex items-center hover:bg-surface-hover/30">
              <div className="w-44 flex-shrink-0 px-3 flex items-center space-x-2 border-r border-border bg-surface">
                <Music className="w-3.5 h-3.5 text-accent-orange" />
                <span className="[color:var(--color-text-main)] font-semibold truncate">BGM 氛围原声</span>
              </div>
              <div className="flex-1 h-full relative py-1">
                <div
                  className="absolute h-8 rounded-lg bg-accent-orange/15 border border-accent-orange/40 flex items-center px-3 space-x-2"
                  style={{ left: '0px', width: `${totalDuration * zoom}px` }}
                >
                  <Sparkles className="w-3 h-3 text-accent-orange animate-pulse" />
                  <span className="text-[10px] text-accent-orange font-medium truncate">
                    {project?.bgm_name || 'Epic_Battle_Orchestra.mp3'} (智能节拍吸附)
                  </span>
                </div>
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
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;
    const isActive = shot.id === activeShotId;

    return (
      <div
        key={shot.id}
        onClick={(e) => {
          e.stopPropagation();
          setActiveShotId(shot.id);
        }}
        className={`absolute h-12 rounded-lg overflow-hidden border cursor-pointer transition-all flex items-center shadow-sm ${
          isActive
            ? 'border-brand bg-brand/20 ring-2 ring-brand/50 z-10'
            : 'border-border bg-surface hover:border-brand/50'
        }`}
        style={{ left: `${left}px`, width: `${width - 4}px` }}
      >
        {shot.image_url && (
          <img 
            src={shot.image_url.startsWith('/') ? 'http://127.0.0.1:8000' + shot.image_url : shot.image_url} 
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
          </div>
          <p className="text-[9px] [color:var(--color-text-muted)] truncate">{shot.action_desc || shot.image_prompt}</p>
        </div>
      </div>
    );
  });
}

// Helper: Render Dialogue Track with Audio Waveforms
function renderDialogueTrack(shots: StoryboardShot[], zoom: number, activeShotId: string | null) {
  let accumulated = 0;
  return shots.map((shot) => {
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;

    if (!shot.dialogue) return null;

    return (
      <div
        key={shot.id}
        className="absolute h-9 rounded-lg bg-accent-pink/15 border border-accent-pink/40 flex items-center px-2 space-x-1.5 overflow-hidden"
        style={{ left: `${left}px`, width: `${width - 4}px` }}
      >
        <span className="text-[10px] font-semibold text-accent-pink truncate">
          {shot.speaker_name}: "{shot.dialogue}"
        </span>
        {/* Simulated Waveform Bars */}
        <div className="flex items-center space-x-0.5 ml-auto opacity-70">
          {[40, 70, 90, 60, 85, 45, 100, 50, 75, 30].map((h, i) => (
            <div
              key={i}
              className="w-[2px] bg-accent-pink rounded-full"
              style={{ height: `${h * 0.16}px` }}
            />
          ))}
        </div>
      </div>
    );
  });
}

// Helper: Render Voiceover Track
function renderVoiceoverTrack(shots: StoryboardShot[], zoom: number) {
  let accumulated = 0;
  return shots.map((shot) => {
    const left = accumulated * zoom;
    const width = shot.duration * zoom;
    accumulated += shot.duration;

    if (!shot.voiceover) return null;

    return (
      <div
        key={shot.id}
        className="absolute h-8 rounded-lg bg-brand-blue/15 border border-brand-blue/40 flex items-center px-2 space-x-1.5 overflow-hidden"
        style={{ left: `${left}px`, width: `${width - 4}px` }}
      >
        <span className="text-[10px] text-brand-blue font-medium truncate">
          [旁白] {shot.voiceover}
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
