import React from 'react';
import { Check, Compass, Film, Grid, Image as ImageIcon, RefreshCw, Sparkles } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { getModes } from './registry';
import { getModeSlot } from './modes';
import { buildShotReferenceInputs } from '../shotReference';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

/**
 * 中央预览台（shot.preview）。
 * 模式顶栏/标题/状态块/动作栏全部走模式注册表；预览与候选区与模式无关。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const PreviewStage: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    project, activeShot, updateShot, productionMode, setProductionMode,
    setPreviewTab, effectivePreviewTab, previewAspect,
    autoFitNotification, regenError, videoError, ttsError,
    handleGenerateVideo, isGeneratingVid, handleRegenerateImage, isRegenerating,
    candidateCount, getMediaUrl, setActiveTab, handleSaveShotToAsset, savingAsset,
    selectCandidate,
  } = ctx;
  const mode = getModeSlot(productionMode);
  const stageMaxHeight = Math.round((typeof window !== 'undefined' ? window.innerHeight : 900) * 0.6);
  const stageOverlays = (
    <>
      <div className="absolute top-3 left-3 flex items-center space-x-2 bg-surface/85 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10 pointer-events-none">
        <span className="text-[11px] font-bold text-white font-mono">镜头 #{activeShot.shot_index}</span>
        <span className="text-[10px] px-1.5 rounded bg-brand/30 text-brand-light border border-brand/40">
          {activeShot.camera_framing}
        </span>
        <span className="text-[10px] px-1.5 rounded bg-accent-orange/20 text-accent-orange border border-accent-orange/40">
          {activeShot.camera_motion}
        </span>
      </div>

      {activeShot.subtitle_text && (
        <div className="absolute bottom-6 left-4 right-4 bg-surface/85 backdrop-blur-md p-3 rounded-xl border border-white/15 text-center shadow-lg animate-fade-in pointer-events-none">
          <span className="text-xs font-bold text-white tracking-wide">
            {activeShot.subtitle_text}
          </span>
        </div>
      )}

      <div className="absolute top-3 right-3 flex flex-col space-y-2">
        <button
          onClick={() => setActiveTab('director3d')}
          className="p-2 rounded-xl bg-surface-secondary hover:bg-accent-orange text-white backdrop-blur-md border border-white/10 transition-all shadow-md"
          title="进入 3D 导演台规划姿态与机位"
        >
          <Compass className="w-4 h-4 text-accent-orange hover:text-white" />
        </button>

        <button
          onClick={() => handleRegenerateImage()}
          disabled={isRegenerating}
          className="p-2 rounded-xl bg-surface-secondary hover:bg-brand text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
          title={`重新生成画面 (按 R)${candidateCount===4 ? ' · 一次出4张' : ''}`}
        >
          <RefreshCw className={`w-4 h-4 text-brand-light ${isRegenerating ? 'animate-spin' : ''}`} />
        </button>
        {activeShot.image_url && (
          <button
            onClick={()=> handleSaveShotToAsset('image')}
            disabled={savingAsset}
            className="p-2 rounded-xl bg-surface-secondary hover:bg-emerald-600 text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
            title="保存首帧到素材库（项目）"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
        )}
        {activeShot.video_url && effectivePreviewTab==='video' && (
          <button
            onClick={()=> handleSaveShotToAsset('video')}
            disabled={savingAsset}
            className="p-2 rounded-xl bg-surface-secondary hover:bg-emerald-600 text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
            title="保存视频到素材库（项目）"
          >
            <Film className="w-4 h-4" />
          </button>
        )}
      </div>
    </>
  );
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6 bg-surface border border-border rounded-2xl overflow-hidden relative">
      {/* 三大制作模式顶栏 */}
      <div className="mb-3 z-10 w-full max-w-md bg-surface-secondary/90 backdrop-blur border border-border p-1 rounded-2xl flex items-center gap-1 shadow-sm">
        {getModes().map((m) => {
          const isActive = productionMode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => {
                setProductionMode(m.id as any);
                if (project?.id) localStorage.setItem(`storyboard_mode_${project.id}`, m.id);
                updateShot(activeShot.id, { production_mode: m.id as any });
                if (m.caps.lockPreview) {
                  setPreviewTab(m.caps.lockPreview);
                  localStorage.setItem('storyboard_preview_tab', m.caps.lockPreview);
                }
              }}
              className={`flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex flex-col items-center gap-0.5 transition-all ${
                isActive
                  ? 'bg-brand text-white shadow-md'
                  : 'text-gray-400 hover:text-white hover:bg-surface-tertiary'
              }`}
            >
              <span className="truncate">{m.label}</span>
              <span className={`text-[9px] font-normal truncate ${isActive ? 'text-white/80' : 'text-gray-500'}`}>{m.desc}</span>
            </button>
          );
        })}
      </div>

      {/* 模式状态与快捷控制 */}
      <div className="mb-2 z-10 flex items-center justify-between w-full max-w-md">
        {mode.renderStatus(ctx)}
      </div>

      {autoFitNotification && (
        <div className="mb-2 px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-300 font-bold max-w-md flex items-center gap-1.5 animate-fade-in">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {autoFitNotification}
        </div>
      )}

      {regenError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {regenError}</div>}
      {videoError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {videoError}</div>}
      {ttsError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {ttsError}</div>}

      {effectivePreviewTab === 'video' ? (
        activeShot.video_url ? (
          <AutoRatioMedia
            key={activeShot.video_url}
            kind="video"
            src={getMediaUrl(activeShot.video_url)}
            fallbackAspect={previewAspect}
            maxHeight={stageMaxHeight}
            style={{ maxWidth: '28rem' }}
            className="rounded-2xl shadow-2xl border border-border/80 group bg-surface-secondary"
            videoProps={{ controls: true, autoPlay: true, loop: true, playsInline: true }}
          >
            {stageOverlays}
          </AutoRatioMedia>
        ) : (
          <div className="relative max-h-[60vh] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-border/80 group bg-surface-secondary" style={{ aspectRatio: previewAspect }}>
            <div className="w-full h-full min-h-[30vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-6 text-center">
              <Film className="w-10 h-10 text-accent-orange/60" />
              <span className="font-semibold text-white">当前分镜尚未生成动态视频</span>
              {mode.caps.direct && buildShotReferenceInputs(activeShot, project, 'video').reference_images.length === 0 && (
                <span className="text-[11px] text-amber-300">⚠️ 尚未绑定角色 / 场景，直接生成将退为文生视频</span>
              )}
              <button
                onClick={handleGenerateVideo}
                disabled={isGeneratingVid}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-accent-orange to-brand-glow text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40"
              >
                {isGeneratingVid ? '视频生成中...' : (mode.caps.direct ? '🎬 立绘直接生成视频' : '立即生成动态视频')}
              </button>
            </div>
            {stageOverlays}
          </div>
        )
      ) : activeShot.image_url ? (
        <AutoRatioMedia
          src={getMediaUrl(activeShot.image_url)}
          alt="Shot Preview"
          fallbackAspect={previewAspect}
          maxHeight={stageMaxHeight}
          style={{ maxWidth: '28rem' }}
          className="rounded-2xl shadow-2xl border border-border/80 group bg-surface-secondary"
          mediaClassName={`transition-transform duration-1000 ${
            activeShot.camera_motion === 'push_in' ? 'group-hover:scale-105' : ''
          }`}
        >
          {stageOverlays}
        </AutoRatioMedia>
      ) : (
        <div className="relative max-h-[60vh] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-border/80 group bg-surface-secondary" style={{ aspectRatio: previewAspect }}>
          <div className="w-full h-full min-h-[30vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-4 text-center">
            <span>{activeShot.status === 'generating_image' ? '⚡ 画面生成中，请稍候...' : '该分镜暂无画面'}</span>
            <button onClick={() => handleRegenerateImage()} disabled={isRegenerating} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold shadow-lg hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> 立即生成画面 {candidateCount===4 ? '(4张选优)' : ''}
            </button>
          </div>
          {stageOverlays}
        </div>
      )}

      {/* 候选切选区 */}
      {activeShot.candidates && activeShot.candidates.length > 1 && (
        <div className="mt-2.5 w-full max-w-md bg-surface-secondary/70 border border-border p-2 rounded-2xl flex items-center justify-between gap-2 animate-fade-in shadow-inner">
          <div className="text-[11px] font-bold text-gray-300 flex items-center gap-1 shrink-0 px-1">
            <Grid className="w-3.5 h-3.5 text-brand" />
            <span>候选定版:</span>
          </div>
          <div className="flex items-center gap-2 flex-1 justify-end">
            {activeShot.candidates.map((cUrl, idx) => {
              const isChosen = activeShot.image_url === cUrl;
              return (
                <button
                  key={idx}
                  onClick={() => selectCandidate(activeShot.id, idx)}
                  className={`relative w-11 h-11 rounded-xl overflow-hidden border transition-all ${
                    isChosen ? 'border-brand ring-2 ring-brand shadow-lg scale-105' : 'border-border opacity-60 hover:opacity-100'
                  }`}
                  title={`选定第 ${idx + 1} 张作为正片定版 (快捷键 ${idx + 1})`}
                >
                  <img src={getMediaUrl(cUrl)} alt="" className="w-full h-full object-contain" />
                  <span className={`absolute top-0.5 left-0.5 px-1 rounded text-[8px] font-mono font-bold ${isChosen ? 'bg-brand text-white' : 'bg-surface-secondary text-gray-300'}`}>
                    {idx + 1}
                  </span>
                  {isChosen && (
                    <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-brand text-white flex items-center justify-center">
                      <Check className="w-2 h-2" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 底部模式专属操作动作栏 */}
      <div className="mt-3 w-full max-w-md">
        {mode.renderAction(ctx)}
      </div>
    </div>
  );
};
