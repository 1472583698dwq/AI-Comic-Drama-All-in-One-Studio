import React from 'react';
import { AlertTriangle, Check, FolderOpen, Link2, Sparkles, X } from 'lucide-react';
import type { BindPlan } from '../referenceBinder';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

/**
 * 一键绑定预览抽屉：资源 → 槽位一目了然，缺口/超限/残留显式列出。
 * 确认后由宿主一次性写入 shot.dynamic_inputs（归一键 + 源真实键双写）。
 */
export const BindPreviewModal: React.FC<{
  open: boolean;
  kind: 'image' | 'video';
  providerName?: string;
  shotLabel?: string;
  plan: BindPlan | null;
  /** 已绑定但没有立绘/三视图的角色名（显式提示，避免预览为空却不知原因） */
  missingChars?: string[];
  overwrite: boolean;
  onToggleOverwrite: (v: boolean) => void;
  onApply: () => void;
  onClose: () => void;
  resolveUrl: (u?: string | null) => string;
}> = ({ open, kind, providerName, shotLabel, plan, missingChars = [], overwrite, onToggleOverwrite, onApply, onClose, resolveUrl }) => {
  if (!open || !plan) return null;
  const sourceLabel: Record<string, string> = {
    frame: '首帧', character: '角色', scene: '场景', prop: '道具/素材',
    previz: '白模截图', previz_video: '白模视频', audio_ref: '参考音频', existing: '保留原值',
  };
  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-md z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-surface border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-surface-secondary/60 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-xl bg-brand/20 border border-brand/40 text-brand-light"><Link2 className="w-4 h-4" /></div>
            <div>
              <div className="text-sm font-bold text-white flex items-center gap-2">
                <span>⚡ 一键绑定参考</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/30 font-mono">
                  {kind === 'image' ? '生图源' : '视频源'} · {providerName || '未选源'}
                </span>
              </div>
              <div className="text-[11px] text-gray-400">
                {shotLabel ? `镜头 ${shotLabel} · ` : ''}把绑定的人物 / 场景 / 道具 / 参考音频按该源声明的插槽自动填入
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-surface-tertiary text-gray-400 hover:text-white transition"><X className="w-4 h-4" /></button>
        </div>

        {/* Mode switch */}
        <div className="px-4 py-2 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onToggleOverwrite(false)}
              className={`px-3 py-1 rounded-lg text-[11px] font-bold border transition ${!overwrite ? 'bg-brand text-white border-brand' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'}`}
            >
              仅填空槽
            </button>
            <button
              onClick={() => onToggleOverwrite(true)}
              className={`px-3 py-1 rounded-lg text-[11px] font-bold border transition ${overwrite ? 'bg-brand text-white border-brand' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'}`}
            >
              覆盖重绑
            </button>
          </div>
          <span className="text-[10px] text-gray-500">
            {overwrite ? '将替换已填槽位（未匹配到的槽保持原值）' : '手工选过的槽位不动，只补空缺'}
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {missingChars.length > 0 && (
            <div className="px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-300 leading-relaxed">
              <b>已绑定角色缺参考图：</b>{missingChars.join('、')}
              —— 请到「角色工坊」为 TA 生成定妆图（正面），或在分镜台改绑其它角色。
            </div>
          )}

          {plan.filled.length === 0 && plan.gaps.length === 0 && missingChars.length === 0 && (
            <div className="py-10 text-center text-xs text-gray-500">没有可绑定的资源：先在上方绑定角色 / 场景 / 道具，或给角色绑定参考音频</div>
          )}
          {plan.filled.length === 0 && plan.gaps.length === 0 && missingChars.length > 0 && (
            <div className="py-2 text-center text-[11px] text-gray-500">除上述缺失参考图的角色外，本镜没有其它可自动绑定的资源</div>
          )}

          {plan.filled.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold text-emerald-300 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> 将写入 {plan.filled.length} 项</div>
              {plan.filled.map((it, i) => (
                <div key={`${it.slotKey}_${it.url}_${i}`} className={`flex items-center gap-2.5 px-2.5 py-2 rounded-xl border text-xs ${it.kept ? 'bg-surface-secondary/70 border-border' : 'bg-emerald-500/5 border-emerald-500/20'}`}>
                  {it.kept ? (
                    <span className="w-12 h-12 shrink-0 rounded-lg bg-surface-tertiary border border-border flex items-center justify-center text-[9px] text-gray-400">原值</span>
                  ) : it.source === 'audio_ref' ? (
                    <span className="w-12 h-12 shrink-0 rounded-lg bg-pink-500/10 border border-pink-500/30 flex items-center justify-center text-pink-300 text-sm">🎵</span>
                  ) : it.source === 'previz_video' ? (
                    <span className="w-12 h-12 shrink-0 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-300 text-sm">🎞</span>
                  ) : (
                    <AutoRatioMedia src={resolveUrl(it.url)} fallbackAspect="1/1" maxHeight={48} className="shrink-0 rounded-lg border border-border" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-white truncate">{it.slotLabel} <span className="text-[9px] font-mono text-gray-500">{it.slotKey}</span></div>
                    <div className="text-[10px] text-gray-400 truncate">{it.name}{it.weight !== undefined ? ` · 权重 ${it.weight}` : ''}</div>
                  </div>
                  <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-surface border border-border text-gray-400">{sourceLabel[it.source] || it.source}</span>
                </div>
              ))}
            </div>
          )}

          {plan.gaps.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-bold text-red-300 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> 必填缺口 {plan.gaps.length} 个</div>
              {plan.gaps.map((g) => (
                <div key={g.slotKey} className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-[11px] text-red-300">
                  <b>{g.slotLabel}</b>（{g.slotKey}）：{g.reason}
                </div>
              ))}
            </div>
          )}

          {plan.truncated.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-bold text-amber-300 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> 超出上限未写入 {plan.truncated.length} 项</div>
              {plan.truncated.map((t, i) => (
                <div key={`${t.slotKey}_${i}`} className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-300">
                  <b>{t.slotLabel}</b>：{t.name} — {t.reason}
                </div>
              ))}
            </div>
          )}

          {plan.stale.length > 0 && (
            <div className="px-2.5 py-2 rounded-lg bg-surface-secondary border border-border text-[10px] text-gray-400">
              <FolderOpen className="w-3 h-3 inline mr-1" />
              该源不声明的旧键 {plan.stale.length} 个（生成时自动忽略，不影响存盘）：<span className="font-mono">{plan.stale.slice(0, 8).join(', ')}{plan.stale.length > 8 ? ' …' : ''}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-surface-secondary/40 flex items-center justify-between shrink-0">
          <span className="text-[10px] text-gray-500">写入后可在各槽位手工微调；生图/生视频时按源声明自动透传</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3.5 py-1.5 rounded-xl border border-border text-xs text-gray-300 hover:bg-surface-tertiary hover:text-white transition">取消</button>
            <button
              onClick={onApply}
              disabled={plan.filled.filter((f) => !f.kept).length === 0}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-emerald-600 hover:opacity-90 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-brand/20 transition disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>应用绑定</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
