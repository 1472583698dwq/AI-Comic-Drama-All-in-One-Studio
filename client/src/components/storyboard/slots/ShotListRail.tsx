import React from 'react';
import { Layers, Plus, Film, Volume2, Users } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { getVisibleActions } from './registry';
import { SlotOutlet } from './PluginRender';

/**
 * 左栏：分镜场记（shot.list）。
 * 头部批量操作按钮经 actionRegistry 渲染（内置三个：批量生图/配音/视频）。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const ShotListRail: React.FC<{ ctx: ShotSlotContext }> = ({ ctx }) => {
  const {
    shots, activeShot, batchSelected, setBatchSelected,
    setActiveShotId, addShot, openShotCtxMenu, getMediaUrl, project, queue,
  } = ctx;
  return (
    <div className="w-[300px] bg-surface border border-border rounded-2xl flex flex-col shrink-0 overflow-hidden shadow-sm">
      <div className="h-11 px-3 border-b border-border flex items-center justify-between shrink-0 bg-surface-secondary/50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-brand" /></div>
          <span className="text-xs font-bold tracking-tight text-white">分镜场记</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400 font-mono">{shots.length}</span>
          {batchSelected.size>0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand text-white font-bold">{batchSelected.size} 选中</span>}
        </div>
        <div className="flex items-center gap-1">
          {batchSelected.size>0 ? (
            <button onClick={()=> setBatchSelected(new Set())} className="text-[10px] px-2 py-1 rounded-full bg-surface-tertiary border border-border text-gray-400">取消</button>
          ) : (
            <button onClick={()=> setBatchSelected(new Set(shots.map(s=> s.id)))} className="text-[10px] px-2 py-1 rounded-full bg-surface-tertiary border border-border text-gray-400 hover:text-white">全选</button>
          )}
          <button onClick={() => addShot(1)} className="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center hover:bg-brand-light shadow-sm transition-transform active:scale-95" title="添加分镜"><Plus className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="px-2.5 py-1.5 bg-surface-secondary/30 border-b border-border flex items-center justify-between gap-1 text-[10px] shrink-0">
        {getVisibleActions(ctx).map((a) => (
          <SlotOutlet key={a.id} slotKey={a.id} render={a.render} ctx={ctx} />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
        {shots.map((shot) => {
          const isSelected = shot.id === activeShot.id;
          const isBatch = batchSelected.has(shot.id);
          const hasVideo = Boolean(shot.video_url);
          const hasAudio = Boolean(shot.audio_url);
          const q = queue.find(x=> x.id===shot.id);
          const boundCharNames = (project?.characters || []).filter(c => (shot.character_ids || []).includes(c.id)).map(c => c.name);

          return (
            <div
              key={shot.id}
              onClick={() => setActiveShotId(shot.id)}
              onContextMenu={(e) => openShotCtxMenu(e, shot)}
              className={`p-2 rounded-xl border cursor-pointer transition-all relative ${
                isSelected
                  ? 'bg-surface-tertiary border-brand glow-border shadow-md'
                  : isBatch ? 'bg-brand/5 border-brand/30' : 'bg-surface-secondary/60 border-border hover:border-border-active'
              }`}
            >
              <input
                type="checkbox"
                checked={isBatch}
                onChange={e=> {
                  e.stopPropagation();
                  setBatchSelected(prev=>{
                    const n = new Set(prev);
                    if(n.has(shot.id)) n.delete(shot.id); else n.add(shot.id);
                    return n;
                  });
                }}
                onClick={e=> e.stopPropagation()}
                className="absolute top-2 left-2 w-3.5 h-3.5 rounded border border-white/30 bg-black/60 accent-brand z-10"
              />

              <div className="relative aspect-video rounded-lg overflow-hidden bg-black/60 mb-1.5 ml-5">
                {shot.image_url ? (
                  <img
                    src={getMediaUrl(shot.image_url)}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500 font-mono">
                    {shot.status === 'generating_image' ? '⚡ 画面生成中...' : (shot.status === 'generating_video' ? '🎬 视频生成中...' : q?.status==='running' ? '⏳ 队列排队...' : '📷 待生成')}
                  </div>
                )}

                <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] font-mono text-brand-light font-bold">
                  #{shot.shot_index}
                </span>

                {shot.candidates && shot.candidates.length > 1 && (
                  <span className="absolute top-1 left-9 px-1 py-0.5 rounded bg-brand/80 text-[8px] font-mono text-white font-bold">
                    {shot.candidates.length}抽
                  </span>
                )}

                {hasVideo && (
                  <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-accent-orange/90 text-[8px] font-bold text-white uppercase tracking-wider flex items-center space-x-0.5">
                    <Film className="w-2.5 h-2.5" />
                    <span>VID</span>
                  </span>
                )}

                {hasAudio && !hasVideo && (
                  <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-pink-500/90 text-[8px] font-bold text-white flex items-center space-x-0.5">
                    <Volume2 className="w-2.5 h-2.5" />
                    <span>TTS</span>
                  </span>
                )}

                <span className="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[9px] text-gray-300 font-mono">
                  {shot.duration}s
                </span>

                {q && <span className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[8px] font-bold ${q.status==='running'?'bg-brand text-white':q.status==='done'?'bg-emerald-500 text-white':q.status==='error'?'bg-red-500 text-white':'bg-zinc-600 text-white'}`}>{q.status}</span>}
              </div>

              <div className="ml-5 space-y-0.5">
                <p className="text-[11px] text-gray-200 truncate font-medium">{shot.action_desc || shot.image_prompt}</p>
                {shot.dialogue && (
                  <p className="text-[10px] text-accent-pink truncate">🗣️ {shot.dialogue}</p>
                )}
                {boundCharNames.length > 0 && (
                  <div className="flex items-center gap-1 pt-0.5">
                    <Users className="w-2.5 h-2.5 text-brand" />
                    <span className="text-[9px] text-brand-light truncate">{boundCharNames.join(', ')}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
