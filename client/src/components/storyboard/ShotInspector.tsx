import React, { useState } from 'react';
import { 
  Sparkles, 
  Play, 
  Volume2, 
  RefreshCw, 
  Paintbrush, 
  Compass, 
  Clock, 
  Tag, 
  Layers,
  ChevronRight,
  Plus,
  Trash2
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot, EmotionType } from '../../types';
import { apiService } from '../../services/api';

const API_ORIGIN = 'http://127.0.0.1:8000';

export const ShotInspector: React.FC = () => {
  const { 
    project, 
    activeShotId, 
    setActiveShotId, 
    updateShot, 
    addShot, 
    deleteShot,
    setActiveTab
  } = useProjectStore();

  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  const shots: StoryboardShot[] = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

  if (!activeShot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm space-y-2 p-8">
        <span>请选择或添加分镜</span>
        {project && <button onClick={() => addShot(1)} className="px-3 py-1 rounded bg-brand text-white text-xs">新建分镜</button>}
      </div>
    );
  }

  // MiniMax Speech-01 真实 TTS
  const handlePlayTTS = async () => {
    const textToSpeak = activeShot.dialogue || activeShot.voiceover || '';
    if (!textToSpeak.trim()) { setTtsError('当前分镜无台词/旁白，无法配音'); return; }
    if (audioEl) { audioEl.pause(); setAudioEl(null); setIsPlayingAudio(false); }
    setTtsError(null);
    setIsPlayingAudio(true);
    try {
      const char = project?.characters.find((c) => c.name === activeShot.speaker_name);
      const voiceId = char?.voice_id || 'male-qn-qingse';
      const res = await apiService.generateTTS(textToSpeak, voiceId, activeShot.emotion);
      const url = res.audio_url?.startsWith('/') ? API_ORIGIN + res.audio_url : res.audio_url;
      if (!res.audio_url) throw new Error('TTS 未返回音频地址');
      updateShot(activeShot.id, { audio_url: res.audio_url, duration: res.duration || activeShot.duration, status: 'completed' });
      const a = new Audio(url);
      setAudioEl(a);
      a.onended = () => { setIsPlayingAudio(false); setAudioEl(null); };
      a.onerror = () => { setTtsError('音频播放失败，请检查后端存储'); setIsPlayingAudio(false); };
      await a.play();
    } catch (e: any) {
      setTtsError(e?.message || '配音生成失败');
      setIsPlayingAudio(false);
    }
  };

  // ComfyUI 真实生图 — 更新该分镜的 image_url
  const handleRegenerateImage = async () => {
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(activeShot.id, { status: 'generating_image' });
    try {
      const res = await apiService.generateShotImage({
        prompt: activeShot.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
      });
      updateShot(activeShot.id, { image_url: res.image_url, status: 'completed' });
    } catch (e: any) {
      setRegenError(e?.message || '生图失败');
      updateShot(activeShot.id, { status: 'error' });
    } finally {
      setIsRegenerating(false);
    }
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden bg-background">
      {/* 1. Left Column: Shot List Thumbnail Drawer */}
      <div className="w-64 bg-surface border-r border-border flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center space-x-1.5">
            <Layers className="w-4 h-4 text-brand-light" />
            <span className="text-xs font-semibold text-white">分镜序列 ({shots.length})</span>
          </div>
          <button
            onClick={() => addShot(1)}
            className="p-1 rounded-lg bg-surface-secondary border border-border hover:border-brand text-gray-300 transition-all flex items-center space-x-1 text-[11px] px-2"
          >
            <Plus className="w-3 h-3 text-brand-light" />
            <span>加镜</span>
          </button>
        </div>

        {/* Shot Scroll List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
          {shots.map((shot) => {
            const isSelected = shot.id === activeShot.id;
            return (
              <div
                key={shot.id}
                onClick={() => setActiveShotId(shot.id)}
                className={`p-2 rounded-xl border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-surface-tertiary border-brand glow-border'
                    : 'bg-surface-secondary/60 border-border hover:border-border-active'
                }`}
              >
                <div className="relative aspect-video rounded-lg overflow-hidden bg-black/60 mb-1.5">
                  {shot.image_url ? (
                    <img 
                      src={shot.image_url.startsWith('/') ? API_ORIGIN + shot.image_url : shot.image_url}
                      alt="" 
                      className="w-full h-full object-cover" 
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">
                      {shot.status === 'generating_image' ? '生成中...' : '待生成'}
                    </div>
                  )}
                  <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] font-mono text-brand-light font-bold">
                    #{shot.shot_index}
                  </span>
                  <span className="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[9px] text-gray-300 font-mono">
                    {shot.duration}s
                  </span>
                </div>
                <p className="text-[11px] text-gray-300 truncate font-medium">{shot.action_desc}</p>
                {shot.dialogue && (
                  <p className="text-[10px] text-accent-pink truncate">🗣️ {shot.dialogue}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Center Column: Main Canvas Monitor */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#08080B] relative">
        {regenError && <div className="mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {regenError}</div>}
        {ttsError && <div className="mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {ttsError}</div>}
        <div className="relative max-h-[70vh] aspect-[9/16] rounded-2xl overflow-hidden shadow-2xl border border-border/80 group">
          {activeShot.image_url ? (
            <img
              src={activeShot.image_url.startsWith('/') ? API_ORIGIN + activeShot.image_url : activeShot.image_url}
              alt="Shot Preview"
              className={`w-full h-full object-cover transition-transform duration-1000 ${
                activeShot.camera_motion === 'push_in' ? 'group-hover:scale-105' : ''
              }`}
            />
          ) : (
            <div className="w-full h-full min-h-[50vh] min-w-[28vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-500 text-xs space-y-3 p-4 text-center">
              <span>{activeShot.status === 'generating_image' ? 'ComfyUI 生成中，请稍候...' : '该分镜暂无画面'}</span>
              <button onClick={handleRegenerateImage} disabled={isRegenerating} className="px-3 py-1 rounded bg-brand text-white text-xs disabled:opacity-40">点击生成画面</button>
            </div>
          )}

          {/* Top Info Pill */}
          <div className="absolute top-3 left-3 flex items-center space-x-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10">
            <span className="text-[11px] font-bold text-white font-mono">镜头 #{activeShot.shot_index}</span>
            <span className="text-[10px] px-1.5 rounded bg-brand/30 text-brand-light border border-brand/40">
              {activeShot.camera_framing}
            </span>
            <span className="text-[10px] px-1.5 rounded bg-accent-orange/20 text-accent-orange border border-accent-orange/40">
              {activeShot.camera_motion}
            </span>
          </div>

          {/* Subtitle / Dialogue Bubble Overlay at bottom */}
          {activeShot.subtitle_text && (
            <div className="absolute bottom-6 left-4 right-4 bg-black/75 backdrop-blur-md p-3 rounded-xl border border-white/15 text-center shadow-lg animate-fade-in">
              <span className="text-xs font-bold text-white tracking-wide">
                {activeShot.subtitle_text}
              </span>
            </div>
          )}

          {/* Floating Action Buttons */}
          <div className="absolute top-3 right-3 flex flex-col space-y-2">
            <button
              onClick={() => setActiveTab('director3d')}
              className="p-2 rounded-xl bg-black/70 hover:bg-accent-orange text-white backdrop-blur-md border border-white/10 transition-all shadow-md"
              title="进入 3D 导演台规划姿态与机位"
            >
              <Compass className="w-4 h-4 text-accent-orange hover:text-white" />
            </button>

            <button
              onClick={handleRegenerateImage}
              disabled={isRegenerating}
              className="p-2 rounded-xl bg-black/70 hover:bg-brand text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
              title="通过 ComfyUI 真实生成分镜画面"
            >
              <RefreshCw className={`w-4 h-4 text-brand-light ${isRegenerating ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* 3. Right Column: Shot Inspector Properties */}
      <div className="w-80 bg-surface border-l border-border p-4 flex flex-col space-y-4 overflow-y-auto custom-scrollbar">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="text-xs font-semibold text-white">分镜参数检查器</span>
          <button
            onClick={() => deleteShot(activeShot.id)}
            className="p-1 rounded text-gray-500 hover:text-red-400"
            title="删除此分镜"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 1. Dialogue / Voiceover Editor */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block flex items-center justify-between">
            <span>🗣️ 角色台词 / 旁白</span>
            <span className="text-[10px] text-gray-500">MiniMax Speech-01 (真实)</span>
          </label>
          <div className="space-y-2">
            <input
              type="text"
              value={activeShot.dialogue || activeShot.voiceover || ''}
              onChange={(e) => {
                const val = e.target.value;
                updateShot(activeShot.id, {
                  dialogue: activeShot.dialogue ? val : '',
                  voiceover: activeShot.voiceover || !activeShot.dialogue ? val : activeShot.voiceover,
                  subtitle_text: val,
                });
              }}
              placeholder="输入该分镜的台词或解说旁白..."
              className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"
            />

            {/* Speaker & Emotion Selector */}
            <div className="flex items-center space-x-2">
              <select
                value={activeShot.speaker_name || project?.characters[0]?.name || ''}
                onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })}
                className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-brand-light focus:outline-none max-w-[110px]"
              >
                {project?.characters.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                value={activeShot.emotion}
                onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as EmotionType })}
                className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-accent-pink focus:outline-none"
              >
                <option value="neutral">😐 平静自然</option>
                <option value="intense">🔥 怒吼爆发</option>
                <option value="sorrow">😢 悲痛哽咽</option>
                <option value="excited">⚡ 兴奋狂喜</option>
                <option value="whispering">🤫 耳语低沉</option>
              </select>

              <button
                onClick={handlePlayTTS}
                className="p-1.5 rounded-lg bg-accent-pink/20 border border-accent-pink/40 hover:bg-accent-pink text-accent-pink hover:text-white transition-all flex items-center space-x-1 text-xs px-2.5"
                title="调用 MiniMax TTS 真实生成并试听"
              >
                <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} />
                <span>{isPlayingAudio ? '播放中' : '试听'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* 2. Visual Action Description */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block">
            🎬 画面剧情动作
          </label>
          <textarea
            value={activeShot.action_desc}
            onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })}
            rows={2}
            className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand"
          />
        </div>

        {/* 3. Image Prompt */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block flex items-center justify-between">
            <span>✨ 生图提示词 (Prompt)</span>
            <span className="text-[10px] text-accent-green">ComfyUI · 真实</span>
          </label>
          <textarea
            value={activeShot.image_prompt}
            onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })}
            rows={3}
            className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-gray-300 placeholder-gray-500 focus:outline-none focus:border-brand"
          />
          <button onClick={handleRegenerateImage} disabled={isRegenerating} className="mt-1 w-full py-1.5 rounded-lg bg-brand text-white text-xs font-semibold disabled:opacity-40">
            {isRegenerating ? 'ComfyUI 生成中...' : '用 ComfyUI 生成/重绘画面'}
          </button>
        </div>

        {/* 4. Shot Duration */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block flex items-center justify-between">
            <span>⏱️ 镜头时长: {activeShot.duration} 秒</span>
          </label>
          <input
            type="range"
            min="1.5"
            max="10.0"
            step="0.5"
            value={activeShot.duration}
            onChange={(e) => updateShot(activeShot.id, { duration: parseFloat(e.target.value) })}
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
};
