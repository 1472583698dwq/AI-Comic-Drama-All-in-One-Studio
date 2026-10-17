import React, { useState } from 'react';
import { Film, Link2 } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { ProviderSlotList } from './ProviderSlotList';
import { providerVideoOffers, videoInputOf, providerAudioSlot } from '../videoInput';
import { imageLayoutOf, lanesOf, videoUsesOf } from '../shotLanes';
import { ProviderPicker, ProviderParamForm } from '../../ui/ProviderPicker';
import { AiPolishButton } from '../../ui/AiPolishButton';

/**
 * motion Tab：运镜与视频动态。
 * 直出模式（caps.direct）锁定参考生视频；i2v/t2v 切卡隐藏。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const MotionTab: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    shots, activeShot, updateShot,
    healthMap, videoProvider, videoProviderDef, videoProviderParams,
    setVideoProvider, setVideoProviderParams,
    setVideoMode,
    shotDynamicInputs, resolveRenderSlots,
    setSlotValue, handleSlotUploadFile, pickAssetForSlot,
    uploadingInputKey, getMediaUrl,
    carryPreviousFrame, videoError, probeProvider,
    autoCarryPreviousFrame, setAutoCarryPreviousFrame,
    handleGenerateVideo, isGeneratingVid, videoSuccess,
    handleOneClickBind, hasBindUndo, undoLastBind,
  } = ctx;
  const [carrying, setCarrying] = useState(false);
  const offers = providerVideoOffers(videoProviderDef);
  const choice = videoInputOf(activeShot, offers);
  const prevShot = shots[shots.findIndex((s) => s.id === activeShot.id) - 1];
  const prevVideo = !!(prevShot as any)?.video_url;
  const prevStill = !!prevShot?.image_url;
  const uses = videoUsesOf(activeShot);
  const layout = imageLayoutOf(activeShot);
  const lanes = lanesOf(activeShot);
  const audioSlot = providerAudioSlot(videoProviderDef);
  const gridReady = layout === 'grid' && !!activeShot.image_url && lanes.image;
  const audioReady = !!activeShot.audio_url && lanes.audio;
  const setUse = (key: 'grid' | 'audio', on: boolean) => {
    updateShot(activeShot.id, { video_uses: { ...((activeShot as any).video_uses || {}), [key]: on } } as any);
  };
  const pickInput = (next: 'frame' | 'cast') => {
    setVideoMode(next === 'frame' ? 'i2v' : 'r2v');
    updateShot(activeShot.id, { video_input: next } as any);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-gray-400 px-1">
        <span>出视频</span>
        <span className={lanes.video ? 'text-gray-200' : 'text-gray-500'}>{!lanes.video ? '已关闭' : activeShot.video_url ? '已有视频' : '未生成'}</span>
      </div>
    <div className="p-3 rounded-2xl bg-orange-500/5 border border-orange-500/20 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-orange-400 flex items-center gap-1.5">
          <Film className="w-3.5 h-3.5" /> 动态视频生成源配置
        </span>
        <span className={`w-2 h-2 rounded-full ${healthMap[videoProvider]?.ok ? 'bg-emerald-500' : healthMap[videoProvider]?.ok === false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
      </div>

      {(offers.frame || offers.cast) && (
        <div className="grid grid-cols-2 gap-1">
          {offers.frame && (
            <button
              onClick={() => pickInput('frame')}
              className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${choice === 'frame' ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'}`}
            >
              用本镜画面
            </button>
          )}
          {offers.cast && (
            <button
              onClick={() => pickInput('cast')}
              className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${choice === 'cast' ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'}`}
            >
              用角色和场景
            </button>
          )}
        </div>
      )}
      {choice === 'frame' && (prevVideo || prevStill) && (
        <button
          disabled={carrying}
          onClick={async () => { setCarrying(true); try { await carryPreviousFrame(); } finally { setCarrying(false); } }}
          className="w-full py-1.5 rounded-lg border border-orange-500/30 text-[11px] font-bold text-orange-200 hover:bg-orange-500/10 disabled:opacity-40"
        >
          {carrying ? '正在截取尾帧…' : prevVideo ? '承接上一镜尾帧' : '承接上一镜画面'}
        </button>
      )}
      <label className="flex items-center gap-2 text-[11px] text-orange-100">
        <input
          type="checkbox"
          checked={autoCarryPreviousFrame}
          disabled={!prevVideo && !prevStill}
          onChange={(e) => setAutoCarryPreviousFrame(e.target.checked)}
        />
        自动同步上一镜尾帧到本镜首帧
      </label>
      <div className="text-[10px] text-gray-500">
        开启后，切到没有首帧的镜头会自动截取上一镜视频尾帧；没有视频时使用上一镜画面。
      </div>

      {choice === 'frame' && layout === 'grid' && (
        <div className="text-[11px] text-gray-500">四宫格不当首帧。勾下面的「参考四宫格」，视频按格子的顺序表演。</div>
      )}
      <label className={`flex items-center gap-2 text-[11px] ${gridReady ? 'text-orange-100' : 'text-gray-500'}`}>
        <input type="checkbox" disabled={!gridReady} checked={gridReady && uses.grid} onChange={(e) => setUse('grid', e.target.checked)} />
        参考四宫格
      </label>
      {!gridReady && <div className="text-[10px] text-gray-500 -mt-2">先在预览里选「四宫格」并生成画面，这里才能勾。</div>}
      <label className={`flex items-center gap-2 text-[11px] ${audioReady && audioSlot ? 'text-orange-100' : 'text-gray-500'}`}>
        <input type="checkbox" disabled={!audioReady || !audioSlot} checked={!!(audioReady && audioSlot && uses.audio)} onChange={(e) => setUse('audio', e.target.checked)} />
        使用本镜配音
      </label>
      {audioReady && !audioSlot && <div className="text-[10px] text-gray-500 -mt-2">当前视频源没有音频槽，配音留在时间线上。</div>}
      {lanes.audio && !activeShot.audio_url && <div className="text-[10px] text-gray-500 -mt-2">还没有配音。先在「音频」打开并合成台词。</div>}

      <ProviderPicker
        kind="video"
        value={videoProvider}
        capability={choice === 'frame' ? 'i2v' : 'r2v'}
        onChange={(pid, def) => {
          setVideoProvider(pid, def);
          if (pid) localStorage.setItem('default_video_provider', pid);
          updateShot(activeShot.id, { video_provider: pid, provider_params: { ...(activeShot as any).provider_params, video: videoProviderParams } } as any);
          if (pid) probeProvider(pid);
        }}
        placeholder="— 选择视频源 —"
      />

      {/* 视频源专有 Schema 参数动态表单 */}
      {videoProviderDef?.params_schema && (
        <div className="rounded-xl bg-surface-secondary border border-orange-500/20 p-2.5 space-y-2">
          <div className="text-[11px] font-bold text-orange-300">
            ⚙️ {videoProviderDef.display_name || videoProviderDef.name || videoProviderDef.id} 专属参数
          </div>
          <ProviderParamForm
            definition={videoProviderDef}
            values={videoProviderParams}
            onChange={(next) => {
              setVideoProviderParams(next);
              updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, video: next } } as any);
            }}
          />
        </div>
      )}

      {/* 视频源声明的素材插槽（首帧由分镜图自动供给，其余按 input_schema 逐条挂载） */}
      {(() => {
        const vSlots = resolveRenderSlots(videoProviderDef, 'video')
          .filter((s: any) => s.role !== 'first_frame' && s.key !== 'first_frame');
        if (!vSlots.length) return null;
        return (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">参考插槽（按该源声明）</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleOneClickBind('video')}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold flex items-center gap-1 transition-all"
                  title="按该视频源声明的参考插槽，自动填入绑定的人物 / 场景 / 道具 / 白模 / 参考音频"
                >
                  <Link2 className="w-3 h-3" />
                  <span>一键绑定参考</span>
                </button>
                {hasBindUndo && (
                  <button onClick={undoLastBind} className="px-2 py-1 rounded-lg border border-border text-gray-400 hover:text-white text-[11px] transition-all" title="撤销上一次一键绑定">
                    ↩ 撤销
                  </button>
                )}
              </div>
            </div>
            <ProviderSlotList
              slots={vSlots}
              values={shotDynamicInputs}
              uploadingKey={uploadingInputKey}
              onWrite={setSlotValue}
              onUpload={handleSlotUploadFile}
              onPickFromLibrary={pickAssetForSlot}
              resolveUrl={getMediaUrl}
            />
          </>
        );
      })()}

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-orange-300">运镜/运动描述</span>
        <AiPolishButton value={activeShot.video_prompt || ''} onPolish={(v: any) => updateShot(activeShot.id, { video_prompt: v })} contextType="prompt" size="xs" />
      </div>
      <textarea
        value={activeShot.video_prompt || ''}
        onChange={(e) => updateShot(activeShot.id, { video_prompt: e.target.value })}
        placeholder="运镜/运动描述..."
        rows={2}
        className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
      />

      {(() => {
        // 时长是镜头属性，滑杆始终保留；但名称与可拖动范围取自该源声明的 duration 参数（未声明则用镜头通用范围）
        const props = (videoProviderDef?.params_schema?.properties || {}) as Record<string, any>;
        const durKey = Object.keys(props).find((k) => k === 'duration' || props[k]?.['x-std-key'] === 'duration');
        const dur = durKey ? props[durKey] : null;
        return (
          <>
            <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
              <span>{dur?.title || '镜头时长'}: <b className="text-orange-400">{Math.round(activeShot.duration)}s</b></span>
              {dur && <span className="text-[10px] text-gray-500 font-mono">{dur.minimum}~{dur.maximum}s 由该源声明</span>}
            </div>
            <input
              type="range"
              min={dur?.minimum ?? 1}
              max={dur?.maximum ?? 30}
              step={dur?.step ?? 1}
              value={Math.round(activeShot.duration)}
              onChange={(e) => updateShot(activeShot.id, { duration: parseFloat(e.target.value) })}
              className="w-full accent-orange-500"
            />
          </>
        );
      })()}

      {videoError && <div className="text-xs text-red-300">{videoError}</div>}
      <button
        type="button"
        onClick={handleGenerateVideo}
        disabled={!lanes.video || isGeneratingVid}
        className="w-full py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40"
      >
        <Film className={`w-3.5 h-3.5 ${isGeneratingVid ? 'animate-spin' : ''}`} />
        <span>{isGeneratingVid ? '生成中…' : videoSuccess ? '已生成，可再生成' : '用此源生成视频'}</span>
      </button>
    </div>
    </div>
  );
};
