import React from 'react';
import { Volume2, Zap } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { getMode } from './registry';
import { ProviderPicker, ProviderParamForm } from '../../ui/ProviderPicker';
import { AiPolishButton } from '../../ui/AiPolishButton';

/**
 * dialogue Tab：台词与配音。
 * 漫画模式（!caps.canTts）仅编辑对白文字。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const DialogueTab: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    project, activeShot, updateShot,
    audioProvider, audioProviderDef, audioProviderParams,
    setAudioProvider, setAudioProviderParams,
    audioEmotionKey, healthMap, probeProvider,
    autoFitShotDuration, handlePlayTTS, isPlayingAudio,
    ttsError, getMediaUrl,
  } = ctx;
  const canTts = getMode(ctx.productionMode).caps.canTts;
  return (
    <div className="space-y-3.5">
      <div className="p-3 rounded-2xl bg-pink-500/5 border border-pink-500/20 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-pink-300 flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-pink-400" /> 角色台词 / 旁白
          </span>
          <div className="flex items-center gap-1.5">
            <AiPolishButton
              value={activeShot.dialogue || activeShot.voiceover || ''}
              onPolish={(v, meta) => {
                const polished = v;
                const emo = (meta as any)?.suggested_emotion;
                updateShot(activeShot.id, {
                  dialogue: activeShot.dialogue ? polished : '',
                  voiceover: activeShot.voiceover || !activeShot.dialogue ? polished : activeShot.voiceover,
                  subtitle_text: polished,
                  ...(emo ? { emotion: emo } : {}),
                } as any);
              }}
              contextType="dialogue"
              size="xs"
            />
            <span className={`w-2 h-2 rounded-full ${healthMap[audioProvider]?.ok ? 'bg-emerald-500' : healthMap[audioProvider]?.ok === false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
          </div>
        </div>

        <textarea
          value={activeShot.dialogue || activeShot.voiceover || ''}
          onChange={(e) => {
            const val = e.target.value;
            updateShot(activeShot.id, {
              dialogue: activeShot.dialogue ? val : '',
              voiceover: activeShot.voiceover || !activeShot.dialogue ? val : activeShot.voiceover,
              subtitle_text: val,
            });
          }}
          placeholder="输入角色台词或旁白..."
          rows={3}
          className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-pink-500/50 resize-none leading-relaxed"
        />

        {/* 漫画模式仅编辑对白文字：隐藏语音源/TTS试听（切到漫剧/图生模式可配音） */}
        {!canTts && (
          <div className="text-[11px] text-gray-500 bg-surface-secondary/60 border border-border rounded-lg px-2.5 py-1.5">漫画模式仅编辑对白与字幕，切到「漫剧制作 / 图生视频」可配音</div>
        )}
        {canTts && (
          <>
        <ProviderPicker
          kind="audio"
          value={audioProvider}
          onChange={(pid, def) => {
            setAudioProvider(pid, def);
            if (pid) localStorage.setItem('default_audio_provider', pid);
            updateShot(activeShot.id, { audio_provider: pid, provider_params: { ...(activeShot as any).provider_params, audio: audioProviderParams } } as any);
            if (pid) probeProvider(pid);
          }}
          placeholder="— 选择语音源 —"
          compact
        />

        {/* 语音源专有 Schema 参数动态表单 */}
        {audioProviderDef?.params_schema && (
          <div className="rounded-xl bg-surface-secondary border border-pink-500/20 p-2.5 space-y-2">
            <div className="text-[11px] font-bold text-pink-300">
              ⚙️ {audioProviderDef.display_name || audioProviderDef.name || audioProviderDef.id} 专属参数
            </div>
            <ProviderParamForm
              definition={audioProviderDef}
              values={audioProviderParams}
              onChange={(next) => {
                setAudioProviderParams(next);
                // 源自行声明情绪时，把值同步回镜头情绪字段（配音与剪映导出都读镜头上的 emotion）
                const emo = audioEmotionKey ? next[audioEmotionKey] : undefined;
                updateShot(activeShot.id, {
                  provider_params: { ...(activeShot as any).provider_params, audio: next },
                  ...(emo ? { emotion: emo as any } : {}),
                } as any);
              }}
            />
          </div>
        )}
          </>
        )}

        <div className="flex items-center gap-2">
          <select value={activeShot.speaker_name || project?.characters[0]?.name || ''} onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })} className="flex-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
            {project?.characters.map((c) => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
          {!audioEmotionKey && (
            <select value={activeShot.emotion} onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as any })} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
              {/* 情绪选项 = 所选语音源 params_schema.emotion 声明的枚举；源未声明时回退系统 EmotionType 域模型 */}
              {(['neutral', 'intense', 'sorrow', 'excited', 'fearful', 'whispering'] as string[]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
          <span>镜头时长: <b className="text-pink-300">{activeShot.duration}s</b></span>
          <button
            onClick={() => autoFitShotDuration(activeShot.id)}
            className="px-2 py-1 rounded-lg bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 text-[11px] font-bold flex items-center gap-1"
            title="根据台词字数/音频长度智能重算时长"
          >
            <Zap className="w-3 h-3 text-pink-400" /> 智能吸附时长
          </button>
        </div>

        {canTts && (
          <>
        <button onClick={handlePlayTTS} disabled={isPlayingAudio} className="w-full py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-violet-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-pink-500/20 hover:opacity-95 disabled:opacity-40">
          <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} />
          <span>{isPlayingAudio ? '合成并播放中...' : '试听配音 (按 T 快捷生成)'}</span>
        </button>
        {ttsError && <div className="text-xs text-red-300">{ttsError}</div>}
        {activeShot.audio_url && <audio controls src={getMediaUrl(activeShot.audio_url)} className="w-full mt-1" />}
          </>
        )}
      </div>

      <div className="p-3 rounded-2xl bg-surface-secondary/40 border border-border space-y-1.5">
        <label className="text-[11px] font-semibold text-gray-300">分镜字幕 (导出剪映自动对齐)</label>
        <input value={activeShot.subtitle_text} onChange={(e) => updateShot(activeShot.id, { subtitle_text: e.target.value })} placeholder="字幕文本，留空则自动同步台词" className="w-full bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-500" />
      </div>
    </div>
  );
};
