import React, { useState } from 'react';
import { Play } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { substituteTpl, useRunSlotAction } from './slotRun';

/**
 * 插件槽通用渲染器（P1，仅组件；运行辅助见 slotRun）。
 * 插件 slots/*.json 的声明式 UI：Tab blocks / 锚点字段 / 动作按钮。
 */

/**
 * 槽出口：给每个槽独立的组件实例（按 slot id keyed），
 * 槽内 hooks（执行状态等）挂在自己名下，重排序/增删不串 state。
 */
export const SlotOutlet: React.FC<{
  slotKey: string;
  render: (ctx: ShotSlotContext) => React.ReactNode;
  ctx: ShotSlotContext;
}> = ({ render, ctx }) => <>{render(ctx)}</>;

function WriteBackButtons({ res, ctx }: { res: any; ctx: ShotSlotContext }) {
  if (!res) return null;
  const pairs: Array<[string, string]> = [];
  if (res.image_url) pairs.push(['image_url', '写入首帧']);
  if (res.video_url) pairs.push(['video_url', '写入视频']);
  if (res.audio_url) pairs.push(['audio_url', '写入配音']);
  if (!pairs.length) return <pre className="text-[10px] font-mono text-gray-400 whitespace-pre-wrap break-all">{JSON.stringify(res).slice(0, 500)}</pre>;
  return (
    <div className="space-y-1">
      <pre className="text-[10px] font-mono text-gray-400 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">{JSON.stringify(res).slice(0, 300)}</pre>
      <div className="flex gap-1.5">
        {pairs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => ctx.updateShot(ctx.activeShot.id, { [k]: (res as any)[k] } as any)}
            className="px-2 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const PluginTab: React.FC<{ ctx: ShotSlotContext; doc: any }> = ({ ctx, doc }) => {
  const { activeShot } = ctx;
  const [lastRes, setLastRes] = useState<any>(null);
  const { running, result, run } = useRunSlotAction(ctx);
  return (
    <div className="space-y-3">
      {(doc.blocks || []).map((b: any, i: number) => {
        if (b.kind === 'info') {
          return <div key={i} className="text-[11px] text-gray-400 bg-surface-secondary/60 border border-border rounded-lg px-2.5 py-1.5">{String(substituteTpl(b.text || '', activeShot, ctx.project?.id))}</div>;
        }
        if (b.kind === 'shot_field') {
          const v: any = (activeShot as any)?.[b.field];
          return (
            <div key={i} className="space-y-1">
              <label className="text-xs font-semibold text-gray-300">{b.label || b.field}</label>
              {typeof v === 'string' || v === undefined || v === null ? (
                <textarea
                  value={v || ''}
                  onChange={(e) => ctx.updateShot(activeShot.id, { [b.field]: e.target.value } as any)}
                  rows={2}
                  className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                  placeholder={`${b.label || b.field}（写入分镜字段 ${b.field}）`}
                />
              ) : (
                <pre className="text-[10px] font-mono text-gray-400 bg-black/30 rounded-lg p-2 whitespace-pre-wrap break-all">{JSON.stringify(v)}</pre>
              )}
            </div>
          );
        }
        if (b.kind === 'buttons') {
          return (
            <div key={i} className="flex flex-wrap gap-1.5">
              {(b.buttons || []).map((btn: any, j: number) => (
                <button
                  key={j}
                  disabled={running}
                  onClick={async () => { const r = await run(btn.run); if (r) setLastRes(r); }}
                  className="px-3 py-1.5 rounded-xl bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light text-xs font-bold disabled:opacity-40 flex items-center gap-1"
                >
                  <Play className="w-3 h-3" />{btn.label || '运行'}
                </button>
              ))}
            </div>
          );
        }
        return null;
      })}
      {running && <div className="text-[11px] text-gray-400">执行中…</div>}
      {result && <div className="text-[11px] text-amber-300">{result}</div>}
      {lastRes && <WriteBackButtons res={lastRes} ctx={ctx} />}
    </div>
  );
};

export const PluginAnchor: React.FC<{ ctx: ShotSlotContext; doc: any }> = ({ ctx, doc }) => {
  const { activeShot, updateShot, setAssetPickerConfig, getMediaUrl } = ctx;
  const field = String(doc.field || '');
  const v: any = field ? (activeShot as any)?.[field] : undefined;
  const isUrl = typeof v === 'string' && (v.startsWith('/') || v.startsWith('http') || v.startsWith('data:'));
  return (
    <div className="p-3 rounded-2xl bg-teal-500/5 border border-teal-500/20 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-teal-300 flex items-center gap-1.5">
          <span>{doc.icon || '🧩'}</span> {doc.label || doc.id} <span className="text-[9px] font-mono text-gray-500">插件槽</span>
        </span>
        {v ? (
          <button onClick={() => updateShot(activeShot.id, { [field]: '' } as any)} className="text-[10px] text-gray-400 hover:text-red-400">清除</button>
        ) : null}
      </div>
      {v ? (
        <div className="flex items-center gap-2 bg-black/40 p-2 rounded-xl border border-teal-500/30">
          {isUrl && !v.startsWith('data:audio') ? (
            <img src={getMediaUrl(v)} alt="" className="w-10 h-10 rounded-lg object-cover border border-border shrink-0" />
          ) : null}
          <div className="min-w-0 text-[11px] text-gray-300 truncate flex-1">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
          <button
            onClick={() => setAssetPickerConfig({
              isOpen: true, title: `为 ${doc.label || doc.id} 选择素材`, category: doc.category || 'all',
              onSelect: (asset: any) => updateShot(activeShot.id, { [field]: asset.url } as any),
            })}
            className="px-2 py-1 rounded-lg bg-teal-500/20 hover:bg-teal-500/30 text-teal-300 text-[10px] font-bold shrink-0"
          >
            更换
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAssetPickerConfig({
            isOpen: true, title: `为 ${doc.label || doc.id} 选择素材`, category: doc.category || 'all',
            onSelect: (asset: any) => updateShot(activeShot.id, { [field]: asset.url } as any),
          })}
          className="w-full py-2 rounded-xl border border-dashed border-teal-500/30 bg-teal-500/5 hover:bg-teal-500/10 text-teal-300 text-xs font-medium transition-colors"
        >
          + 挂载{doc.label || doc.id}（写入字段 {field}）
        </button>
      )}
    </div>
  );
};

export const PluginActionButton: React.FC<{ ctx: ShotSlotContext; doc: any }> = ({ ctx, doc }) => {
  const { run, running, result } = useRunSlotAction(ctx);
  const [lastRes, setLastRes] = useState<any>(null);
  return (
    <span className="flex-1 flex flex-col min-w-0" title={doc.description || doc.id}>
      <button
        disabled={running}
        onClick={async () => { const r = await run(doc.run); if (r) setLastRes(r); }}
        className="flex-1 py-1 rounded-lg bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/30 text-teal-300 font-bold flex items-center justify-center gap-1 transition-all disabled:opacity-40"
      >
        <Play className="w-3 h-3" /> {running ? '执行中…' : (doc.label || doc.id)}
      </button>
      {result && <span className="text-[9px] text-amber-300 truncate">{result}</span>}
      {lastRes && lastRes.video_url === undefined && lastRes.image_url === undefined && lastRes.audio_url === undefined && (
        <span className="text-[9px] text-emerald-400 truncate">✓ 完成</span>
      )}
    </span>
  );
};
