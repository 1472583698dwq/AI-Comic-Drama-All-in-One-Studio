import React, { useState, useRef, useEffect } from 'react';
import { 
  ChevronUp, 
  ChevronDown, 
  Sparkles, 
  RefreshCw, 
  Volume2, 
  Edit3, 
  Share2, 
  Play,
  Pause,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot } from '../../types';
import { apiService } from '../../services/api';

const API_ORIGIN = 'http://127.0.0.1:8000';

interface MobileCardFlowProps {
  onOpenExport: () => void;
  /** 移动端独立入口（mobile.html）时为 true：去掉手机拟真外框，改为全屏沉浸 */
  standalone?: boolean;
}

export const MobileCardFlow: React.FC<MobileCardFlowProps> = ({ onOpenExport, standalone = false }) => {
  const { 
    project, 
    activeShotId, 
    setActiveShotId, 
    updateShot, 
    isPlaying, 
    setIsPlaying 
  } = useProjectStore();

  const shots: StoryboardShot[] = project?.scenes.flatMap((s) => s.shots) || [];
  
  const activeIndex = Math.max(0, shots.findIndex((s) => s.id === activeShotId));
  const currentShot = shots[activeIndex] || shots[0];

  const [isEditingDialogue, setIsEditingDialogue] = useState(false);
  const [isPlayingTTS, setIsPlayingTTS] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 播放：按每镜 duration 自动推进卡片，到末尾自动停。
  // 修复前这里没有任何消费方，顶栏/底部的「播放」只是切了个图标，卡片一动不动。
  useEffect(() => {
    if (!isPlaying) return;
    if (shots.length === 0 || activeIndex >= shots.length - 1) {
      setIsPlaying(false);
      return;
    }
    const ms = Math.max(500, (shots[activeIndex]?.duration || 3) * 1000);
    const timer = setTimeout(() => setActiveShotId(shots[activeIndex + 1].id), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, activeIndex, shots.length]);

  if (!currentShot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 space-y-3 p-8 text-center">
        <span>暂无分镜卡片</span>
        <span className="text-xs text-gray-600">请先在桌面端或导入小说后生成分镜</span>
      </div>
    );
  }

  const handleNext = () => {
    if (activeIndex < shots.length - 1) {
      setActiveShotId(shots[activeIndex + 1].id);
    }
  };

  const handlePrev = () => {
    if (activeIndex > 0) {
      setActiveShotId(shots[activeIndex - 1].id);
    }
  };

  const handleTTS = async () => {
    const text = currentShot.dialogue || currentShot.voiceover || '';
    if (!text.trim()) { setTtsError('该分镜无台词/旁白'); return; }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; setIsPlayingTTS(false); }
    setTtsError(null);
    setIsPlayingTTS(true);
    try {
      const char = project?.characters.find((c) => c.name === currentShot.speaker_name);
      const voiceId = char?.voice_id || '';
      const res = await apiService.generateTTS(text, voiceId, currentShot.emotion);
      const url = res.audio_url?.startsWith('/') ? API_ORIGIN + res.audio_url : res.audio_url;
      if (!res.audio_url) throw new Error('未返回音频');
      updateShot(currentShot.id, { audio_url: res.audio_url });
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { setIsPlayingTTS(false); audioRef.current = null; };
      a.onerror = () => { setTtsError('播放失败'); setIsPlayingTTS(false); };
      await a.play();
    } catch (e: any) {
      setTtsError(e?.message || '配音失败');
      setIsPlayingTTS(false);
    }
  };

  const handleRegenerate = async () => {
    if (!currentShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(currentShot.id, { status: 'generating_image' });
    try {
      const res = await apiService.generateShotImage({
        prompt: currentShot.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
      });
      updateShot(currentShot.id, { image_url: res.image_url, status: 'completed' });
    } catch (e: any) {
      setRegenError(e?.message || '生图失败');
      updateShot(currentShot.id, { status: 'error' });
    } finally {
      setIsRegenerating(false);
    }
  };

  const imgSrc = currentShot.image_url
    ? (currentShot.image_url.startsWith('/') ? API_ORIGIN + currentShot.image_url : currentShot.image_url)
    : '';

  const Inner = (
    <>
      {/* 1. Mobile Top Status Bar */}
      <div className={`pt-8 px-4 pb-2 flex items-center justify-between z-20 ${standalone ? 'bg-gradient-to-b from-black/80 to-transparent' : 'bg-gradient-to-b from-black/80 to-transparent'}`}>
        <div className="flex items-center space-x-2">
          <span className="text-[11px] font-bold text-white font-mono bg-brand/30 px-2 py-0.5 rounded-full border border-brand/50">
            第 {activeIndex + 1}/{shots.length} 镜
          </span>
          <span className="text-[10px] text-gray-400 font-medium truncate max-w-[120px]">
            {project?.title}
          </span>
        </div>

        <button
          onClick={onOpenExport}
          className="flex items-center space-x-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-brand to-brand-blue text-[10px] font-bold text-white shadow-md"
        >
          <Share2 className="w-3 h-3" />
          <span>导出剪映</span>
        </button>
      </div>

      {(regenError || ttsError) && (
        <div className="mx-4 mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/30 text-xs text-red-300">{regenError || ttsError}</div>
      )}

      {/* 2. Fullscreen Vertical Storyboard Canvas */}
      <div className="flex-1 relative flex items-center justify-center bg-surface-secondary overflow-hidden group">
        {imgSrc ? (
          <img
            src={imgSrc}
            alt=""
            className="w-full h-full object-cover animate-fade-in"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 text-xs space-y-3 p-4 text-center bg-surface-secondary">
            <span>{currentShot.status === 'generating_image' ? '生成中...' : '该分镜暂无画面'}</span>
            <button onClick={handleRegenerate} disabled={isRegenerating} className="px-3 py-1.5 rounded bg-brand text-white text-xs disabled:opacity-40">
              {isRegenerating ? '生成中...' : '点击生成画面'}
            </button>
          </div>
        )}

        {/* Subtitle / Dialogue Bubble (Comic Overlay) */}
        <div className="absolute bottom-20 left-4 right-4 z-20">
          {isEditingDialogue ? (
            <div className="bg-surface-secondary p-3 rounded-2xl border border-brand space-y-2 backdrop-blur-md">
              <input
                type="text"
                value={currentShot.dialogue || currentShot.voiceover || ''}
                onChange={(e) =>
                  updateShot(currentShot.id, {
                    dialogue: currentShot.dialogue ? e.target.value : '',
                    voiceover: currentShot.voiceover || !currentShot.dialogue ? e.target.value : currentShot.voiceover,
                    subtitle_text: e.target.value,
                  })
                }
                className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white focus:outline-none"
                autoFocus
              />
              <button
                onClick={() => setIsEditingDialogue(false)}
                className="w-full py-1.5 rounded-lg bg-brand text-white text-xs font-bold"
              >
                完成修改
              </button>
            </div>
          ) : (
            <div className="bg-surface-secondary backdrop-blur-md p-3.5 rounded-2xl border border-white/20 text-center shadow-2xl">
              <div className="flex items-center justify-center space-x-1.5 mb-1">
                <span className="text-[10px] font-bold text-brand-light">
                  {currentShot.speaker_name || '旁白'}
                </span>
                <span className="text-[9px] px-1.5 py-0.2 rounded bg-accent-pink/20 text-accent-pink">
                  {currentShot.emotion === 'intense' ? '怒吼' : currentShot.emotion === 'excited' ? '兴奋' : '自然'}
                </span>
              </div>
              <p className="text-xs font-bold text-white tracking-wide">
                {currentShot.dialogue || currentShot.voiceover || currentShot.action_desc}
              </p>
            </div>
          )}
        </div>

        {/* Right Floating Vertical Control Dock */}
        <div className="absolute right-3 top-1/3 z-20 flex flex-col space-y-3">
          {/* Prev Shot */}
          <button
            onClick={handlePrev}
            disabled={activeIndex === 0}
            className="p-2.5 rounded-full bg-surface-secondary backdrop-blur-md text-white border border-white/10 disabled:opacity-30 active:scale-90 transition-all shadow-lg"
          >
            <ChevronUp className="w-4 h-4" />
          </button>

          {/* Next Shot */}
          <button
            onClick={handleNext}
            disabled={activeIndex === shots.length - 1}
            className="p-2.5 rounded-full bg-surface-secondary backdrop-blur-md text-white border border-white/10 disabled:opacity-30 active:scale-90 transition-all shadow-lg"
          >
            <ChevronDown className="w-4 h-4" />
          </button>

          {/* Play TTS Voice — 走当前配置的音频生成源 */}
          <button
            onClick={handleTTS}
            className="p-2.5 rounded-full bg-accent-pink/80 backdrop-blur-md text-white active:scale-90 transition-all shadow-lg"
            title="试听配音（使用当前配置的音频生成源）"
          >
            <Volume2 className={`w-4 h-4 ${isPlayingTTS ? 'animate-bounce' : ''}`} />
          </button>

          {/* Quick Inpaint / Regenerate — 走当前配置的图片生成源 */}
          <button
            onClick={handleRegenerate}
            disabled={isRegenerating}
            className="p-2.5 rounded-full bg-brand/80 backdrop-blur-md text-white active:scale-90 transition-all shadow-lg disabled:opacity-40"
            title="智能重绘（使用当前配置的图片生成源）"
          >
            <RefreshCw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
          </button>

          {/* Edit Dialogue */}
          <button
            onClick={() => setIsEditingDialogue(!isEditingDialogue)}
            className="p-2.5 rounded-full bg-surface-secondary backdrop-blur-md text-white border border-white/10 active:scale-90 transition-all shadow-lg"
            title="改台词"
          >
            <Edit3 className="w-4 h-4 text-accent-orange" />
          </button>
        </div>
      </div>

      {/* 3. Bottom Gesture & Action Bar */}
      <div className="h-16 bg-surface/95 border-t border-border px-4 flex items-center justify-around z-20">
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className="flex flex-col items-center text-gray-400 hover:text-white"
        >
          {isPlaying ? <Pause className="w-4 h-4 text-brand-light" /> : <Play className="w-4 h-4 fill-current" />}
          <span className="text-[10px] mt-0.5">{isPlaying ? '暂停' : '播放'}</span>
        </button>

        <button
          onClick={handleTTS}
          className="flex flex-col items-center text-gray-400 hover:text-white"
        >
          <Volume2 className="w-4 h-4 text-accent-pink" />
          <span className="text-[10px] mt-0.5">配音</span>
        </button>

        <button
          onClick={handleRegenerate}
          disabled={isRegenerating}
          className="flex flex-col items-center text-gray-400 hover:text-white disabled:opacity-40"
        >
          <Sparkles className="w-4 h-4 text-accent-green" />
          <span className="text-[10px] mt-0.5">智能重绘</span>
        </button>

        <button
          onClick={onOpenExport}
          className="flex flex-col items-center text-gray-400 hover:text-white"
        >
          <Share2 className="w-4 h-4 text-accent-orange" />
          <span className="text-[10px] mt-0.5">导出剪映</span>
        </button>
      </div>
    </>
  );

  if (standalone) {
    // 移动端独立入口：全屏沉浸，不套手机拟真边框
    return (
      <div className="flex-1 flex flex-col bg-background overflow-hidden min-h-screen">
        {Inner}
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-background p-4 overflow-hidden">
      {/* Mobile Device Mockup Frame（桌面端嵌套展示用） */}
      <div className="w-full max-w-sm h-[90vh] bg-surface-secondary rounded-[40px] border-[6px] border-[#22222E] shadow-2xl relative flex flex-col overflow-hidden ring-1 ring-white/10">
        {/* Dynamic Island / Speaker */}
        <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-24 h-4 bg-surface-tertiary rounded-full z-30" />
        {Inner}
      </div>
    </div>
  );
};
