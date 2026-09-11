import React from 'react';
import { Film } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { getMode } from './registry';
import { ProviderSlotList } from './ProviderSlotList';
import { ProviderPicker, ProviderParamForm } from '../../ui/ProviderPicker';
import { AiPolishButton } from '../../ui/AiPolishButton';

/**
 * motion Tab：运镜与视频动态。
 * 直出模式（caps.direct）锁定参考生视频；i2v/t2v 切卡隐藏。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const MotionTab: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    activeShot, updateShot,
    healthMap, videoProvider, videoProviderDef, videoProviderParams,
    setVideoProvider, setVideoProviderParams,
    videoMode, setVideoMode,
    shotDynamicInputs, resolveRenderSlots,
    setSlotValue, handleSlotUploadFile, pickAssetForSlot,
    uploadingInputKey, getMediaUrl,
    handleGenerateVideo, isGeneratingVid, videoSuccess, videoError, probeProvider,
  } = ctx;
  const caps = getMode(ctx.productionMode).caps;
  return (
    <div className="p-3 rounded-2xl bg-orange-500/5 border border-orange-500/20 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-orange-400 flex items-center gap-1.5">
          <Film className="w-3.5 h-3.5" /> 动态视频生成源配置
        </span>
        <span className={`w-2 h-2 rounded-full ${healthMap[videoProvider]?.ok ? 'bg-emerald-500' : healthMap[videoProvider]?.ok === false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
      </div>

      {/* 直出模式锁定参考生视频：i2v/t2v 切卡隐藏，有无参考由生成时自动判定 r2v/t2v */}
      {caps.direct && (
        <div className="text-[11px] font-bold text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded-lg px-2.5 py-1.5">📌 参考生视频 (R2V)：上方绑定的角色 / 场景 / 道具自动作为多参考驱动</div>
      )}
      {!caps.direct && (
      <div className="grid grid-cols-3 gap-1">
        {[
          { id: 'i2v', label: '图生视频' },
          { id: 'r2v', label: '参考生视频' },
          { id: 't2v', label: '文生视频' },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setVideoMode(m.id as any);
              localStorage.setItem('storyboard_video_mode', m.id);
            }}
            className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
              videoMode === m.id ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      )}

      <ProviderPicker
        kind="video"
        value={videoProvider}
        capability={caps.needsFirstFrame ? 'i2v' : caps.direct ? 'r2v' : undefined}
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
        <div className="rounded-xl bg-black/30 border border-orange-500/20 p-2.5 space-y-2">
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
        return (
          <ProviderSlotList
            slots={vSlots}
            values={shotDynamicInputs}
            uploadingKey={uploadingInputKey}
            onWrite={setSlotValue}
            onUpload={handleSlotUploadFile}
            onPickFromLibrary={pickAssetForSlot}
            resolveUrl={getMediaUrl}
          />
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

      <div className="grid grid-cols-2 gap-1.5">
        {[
          { label: '🔥 推近 (Push In)', prompt: '镜头极速推向主角面部，眼神爆发光芒' },
          { label: '🌀 环绕 (Orbit)', prompt: '360度动态环拍，发丝衣袂随风狂舞' },
          { label: '⚡ 震颤 (Shake)', prompt: '手持镜头激烈震动，冲击波扩散' },
          { label: '🌌 拉远 (Pull Out)', prompt: '缓缓拉出镜头，展现宏大背景与天地' },
        ].map((p) => (
          <button
            key={p.label}
            onClick={() => updateShot(activeShot.id, { video_prompt: p.prompt })}
            className="text-[11px] p-2 rounded-xl border border-border bg-surface-secondary hover:border-orange-500/40 text-gray-300 hover:text-white truncate text-left transition-all"
            title={p.prompt}
          >
            {p.label}
          </button>
        ))}
      </div>

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

      <button
        onClick={handleGenerateVideo}
        disabled={isGeneratingVid}
        className="w-full py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-orange-500/20 hover:opacity-95 disabled:opacity-40 transition-all"
      >
        <Film className={`w-3.5 h-3.5 ${isGeneratingVid ? 'animate-spin' : ''}`} />
        <span>{isGeneratingVid ? '生成中... (可按 V)' : videoSuccess ? '已生成' : '生成动态视频 (按 V)'}</span>
      </button>
      {videoError && <div className="text-xs text-red-300">{videoError}</div>}
    </div>
  );
};
