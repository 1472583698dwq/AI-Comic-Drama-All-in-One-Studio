import React from 'react';
import { Film, Grid, Image as ImageIcon, Sparkles } from 'lucide-react';
import type { ShotSlotContext } from './types';

/** 制作模式状态块与动作栏展示件（自 ShotInspector 原样搬移，见 modes.tsx 说明）。 */

export const StatusComic: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { candidateCount, setCandidateCount } = ctx;
  return (
    <div className="flex items-center justify-between w-full">
      <span className="text-[11px] font-bold text-violet-400 flex items-center gap-1">
        <ImageIcon className="w-3.5 h-3.5" /> 漫画模式 · 只出图，不出视频
      </span>
      <div className="flex items-center gap-1 bg-surface-secondary border border-border rounded-full p-0.5 text-[11px]">
        <button onClick={()=> { setCandidateCount(1); localStorage.setItem('storyboard_candidate_count', '1'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all ${candidateCount===1 ? 'bg-surface-tertiary text-white shadow' : 'text-gray-400 hover:text-white'}`}>单张</button>
        <button onClick={()=> { setCandidateCount(4); localStorage.setItem('storyboard_candidate_count', '4'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 ${candidateCount===4 ? 'bg-brand text-white shadow' : 'text-gray-400 hover:text-white'}`}>
          <Grid className="w-3 h-3"/> 4张
        </button>
      </div>
    </div>
  );
};

export const StatusMotionComic: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { activeShot } = ctx;
  return (
    <div className="flex items-center justify-between w-full">
      <span className="text-[11px] font-bold text-orange-400 flex items-center gap-1">
        <Film className="w-3.5 h-3.5" /> 漫剧模式 · 立绘直接生成视频
      </span>
      <span className="text-[10px] text-gray-400 font-mono">
        {activeShot.camera_motion || 'push_in'}
      </span>
    </div>
  );
};

export const StatusImageToVideo: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { previewTab, setPreviewTab, activeShot, candidateCount, setCandidateCount } = ctx;
  return (
    <div className="flex items-center justify-between w-full">
      <div className="flex items-center p-0.5 rounded-full bg-surface-secondary border border-border shadow-sm">
        <button onClick={() => { setPreviewTab('image'); localStorage.setItem('storyboard_preview_tab', 'image'); }} className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold transition-all ${previewTab === 'image' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>
          <ImageIcon className="w-3 h-3" /><span>1. 首帧</span>
        </button>
        <button onClick={() => { setPreviewTab('video'); localStorage.setItem('storyboard_preview_tab', 'video'); }} className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold transition-all ${previewTab === 'video' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>
          <Film className="w-3 h-3" /><span>2. 视频</span>{activeShot.video_url && <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />}
        </button>
      </div>
      <div className="flex items-center gap-1 bg-surface-secondary border border-border rounded-full p-0.5 text-[11px]">
        <button onClick={()=> { setCandidateCount(1); localStorage.setItem('storyboard_candidate_count', '1'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all ${candidateCount===1 ? 'bg-surface-tertiary text-white shadow' : 'text-gray-400 hover:text-white'}`}>单张</button>
        <button onClick={()=> { setCandidateCount(4); localStorage.setItem('storyboard_candidate_count', '4'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 ${candidateCount===4 ? 'bg-brand text-white shadow' : 'text-gray-400 hover:text-white'}`}>
          <Grid className="w-3 h-3"/> 4张
        </button>
      </div>
    </div>
  );
};

export const ActionComic: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { handleRegenerateImage, isRegenerating, candidateCount } = ctx;
  return (
    <button
      onClick={() => handleRegenerateImage()}
      disabled={isRegenerating}
      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-brand text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
    >
      <Sparkles className="w-3.5 h-3.5" />
      <span>生成漫画画面 {candidateCount===4 ? '(4张选优)' : ''}</span>
    </button>
  );
};

export const ActionMotionComic: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { handleGenerateVideo, isGeneratingVid } = ctx;
  return (
    <button
      onClick={handleGenerateVideo}
      disabled={isGeneratingVid}
      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-accent-orange to-brand text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
    >
      <Film className="w-3.5 h-3.5" />
      <span>立绘直接生成视频</span>
    </button>
  );
};

export const ActionImageToVideo: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const { handleRegenerateImage, isRegenerating, candidateCount, handleGenerateVideo, isGeneratingVid, activeShot } = ctx;
  return (
    <div className="flex items-center gap-2 w-full">
      <button
        onClick={() => handleRegenerateImage()}
        disabled={isRegenerating}
        className="flex-1 py-2 rounded-xl bg-brand text-white text-xs font-bold shadow hover:bg-brand-light disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
      >
        <Sparkles className="w-3 h-3" />
        <span>1. 生成首帧 {candidateCount===4 ? '(4张选优)' : ''}</span>
      </button>
      <button
        onClick={handleGenerateVideo}
        disabled={isGeneratingVid || !activeShot.image_url}
        className="flex-1 py-2 rounded-xl bg-gradient-to-r from-accent-orange to-pink-500 text-white text-xs font-bold shadow hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
        title={!activeShot.image_url ? '请先完成步骤 1 生成首帧画面' : '用已定版的首帧生成动态视频'}
      >
        <Film className="w-3 h-3" />
        <span>2. 生成视频</span>
      </button>
    </div>
  );
};
