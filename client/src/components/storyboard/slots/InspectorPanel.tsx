import React from 'react';
import { Copy, Layers, Sliders, Trash2 } from 'lucide-react';
import type { ShotSlotContext } from './types';
import { useTabDefs } from '../../../ui-registry/adapters/storyboardSlots';
import { SlotOutlet } from './PluginRender';
import { SlotManagerButton } from './SlotManagerModal';
import { lanesOf } from '../shotLanes';

/**
 * 右栏：分镜参数检查器宿主（shot.inspector）。
 * Tab 栏经 tabRegistry 渲染，内容为选中 Tab 的 render；
 * 队列脚与头操作区保持原样。
 * （自 ShotInspector 原样搬移，标识符改为 ctx.*，零行为变化）
 */
export const InspectorPanel: React.FC<{ ctx: ShotSlotContext; embedded?: boolean }> = ({ ctx, embedded = false }) => {
  const {
    activeShot, inspectorTab, setInspectorTab, updateShot,
    duplicateShot, deleteShot, openShotCtxMenu, openSlotManager, queue,
  } = ctx;
  // 槽从注册表取（内置 + 插件同一条管线），when(ctx) 过滤仍在宿主侧
  const tabs = useTabDefs(ctx);
  const lanes = lanesOf(activeShot);
  const flipLane = (key: 'image' | 'video' | 'audio') => {
    updateShot(activeShot.id, { lanes: { ...lanes, [key]: !lanes[key] } } as any);
  };
  return (
    <div className={`${embedded ? 'w-full rounded-none border-0 shadow-none' : 'w-[380px] rounded-2xl border shadow-sm'} bg-surface flex flex-col overflow-hidden shrink-0`}>
      <div className="h-11 px-3 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
        <div className="flex items-center gap-1.5">
          <Sliders className="w-3.5 h-3.5 text-brand" />
          <span className="text-xs font-bold text-white">
            这一镜
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface border border-border text-gray-400 font-mono">#{activeShot.shot_index}</span>
          <SlotManagerButton onOpen={openSlotManager} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => duplicateShot(activeShot.id)} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand" title="复制此分镜 (Ctrl+D)"><Copy className="w-3.5 h-3.5"/></button>
          <button onClick={(e)=> {
            if (activeShot) openShotCtxMenu(e as any, activeShot);
          }} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand" title="发送到无限画布：使用新画布 / 隶属画布，视频生成后回写"><Layers className="w-3.5 h-3.5"/></button>
          <button onClick={() => deleteShot(activeShot.id)} className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10" title="删除此分镜"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="flex items-center gap-1 p-1.5 bg-surface-secondary/50 border-b border-border shrink-0">
        {tabs.map((t) => {
          const laneKey = t.id === 'visual' ? 'image' : t.id === 'dialogue' ? 'audio' : t.id === 'motion' ? 'video' : null;
          const on = laneKey ? lanes[laneKey] : true;
          const selected = inspectorTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => { setInspectorTab(t.id as any); localStorage.setItem('storyboard_inspector_tab', t.id); }}
              className={`flex-1 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${selected ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}
            >
              <span>{t.icon}</span>
              <span>{t.label(ctx)}</span>
              {laneKey && (
                <span
                  role="switch"
                  aria-checked={on}
                  title={on ? `关闭本镜${t.label(ctx)}生成` : `打开本镜${t.label(ctx)}生成`}
                  onClick={(e) => { e.stopPropagation(); flipLane(laneKey); }}
                  className={`w-2 h-2 rounded-full shrink-0 ${on ? (selected ? 'bg-white' : 'bg-brand') : 'border border-current bg-transparent'}`}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
        {(() => {
          const t = tabs.find(t => t.id === inspectorTab);
          return t ? <SlotOutlet slotKey={t.id} render={t.render} ctx={ctx} /> : null;
        })()}
      </div>

      {/* 底部排队队列 */}
      {queue.length>0 && (
        <div className="p-2 border-t border-border bg-surface-secondary/50">
          <div className="text-[11px] font-bold text-white flex items-center justify-between">
            <span>渲染流水线</span>
            <span className="font-mono text-brand-light">{queue.filter(q=>q.status==='done').length}/{queue.length} 完成</span>
          </div>
          <div className="space-y-1 mt-1 max-h-20 overflow-y-auto">
            {queue.map(q=>(
              <div key={q.id} className="text-[11px] flex items-center justify-between px-2 py-1 rounded-lg bg-surface border border-border">
                <span>镜头 #{q.id.slice(-4)} · {q.type==='image'?'生图':q.type==='video'?'生视频':'配音'}</span>
                <span className={`font-bold ${q.status==='done'?'text-emerald-400':q.status==='error'?'text-red-400':q.status==='running'?'text-brand-light animate-pulse':'text-gray-400'}`}>{q.status==='running'?'进行中':q.status==='done'?'完成':q.status==='error'?'失败':'排队中'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
