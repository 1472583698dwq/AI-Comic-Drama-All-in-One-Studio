import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Library, Tag } from 'lucide-react';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const AssetNode: React.FC<NodeProps> = ({ data }) => {
  const d:any = data;
  const url = d.thumb_url || d.file_url;
  return (
    <div className="w-[200px] bg-surface border border-border rounded-2xl shadow-lg overflow-hidden">
      <div className="px-2.5 py-2 bg-surface border-b border-border flex items-center gap-1.5">
        <Library className="w-3 h-3 text-pink-500"/><span className="text-[11px] font-bold [color:var(--color-text-main)] truncate">{d.name || '素材'}</span>
        <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-muted)] border border-border">{d.category || 'other'}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-pink-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="image" className="!bg-brand !w-3 !h-3 !border-2 !border-surface"/>
      {url ? (
        <AutoRatioMedia src={url.startsWith('/')? API_ORIGIN+url : url} fallbackAspect="1/1" className="bg-surface-secondary border-b border-border" />
      ) : (
        <div className="aspect-square bg-surface-secondary flex items-center justify-center overflow-hidden border-b border-border">
          <span className="text-xs [color:var(--color-text-muted)]">无预览</span>
        </div>
      )}
      <div className="p-2 space-y-1 bg-surface">
        <div className="text-[10px] [color:var(--color-text-muted)] truncate">{d.visual_prompt?.slice(0,60) || d.description?.slice(0,40) || '—'}</div>
        {d.tags?.length>0 && <div className="flex gap-1 flex-wrap">{d.tags.slice(0,3).map((t:string)=><span key={t} className="text-[9px] px-1 py-0.5 rounded bg-surface-secondary text-[color:var(--color-text-secondary)] border border-border"><Tag className="w-2 h-2 inline mr-0.5"/>{t}</span>)}</div>}
        {d.scope==='global' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20 font-medium">全局</span>}
      </div>
    </div>
  );
};

export const Director3DNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [focal, setFocal] = React.useState(d.focal_length_mm || 35);
  const [roll, setRoll] = React.useState(d.camera_roll_deg || 0);
  React.useEffect(()=> { setFocal(d.focal_length_mm || 35); setRoll(d.camera_roll_deg || 0); }, [d.focal_length_mm, d.camera_roll_deg]);
  const livePrompt = `[Camera: Motion: ${d.motion || 'push_in'}, Framing: ${d.framing || 'medium'}, Lens: ${focal}mm${Math.abs(roll)>0.5 ? ', Dutch Roll: '+roll+'°' : ''}]`;

  return (
    <div className="w-[320px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <span className="text-xs font-bold [color:var(--color-text-main)]">🎬 3D导演台</span>
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border [color:var(--color-text-muted)] font-mono">{d.framing || 'medium'} · {d.motion || 'push_in'}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="target" position={Position.Top} id="pose" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="camera" className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-2 gap-1.5 text-xs">
          <select value={d.framing || 'medium'} onChange={e=> (d.onUpdate as any)?.(id,{framing:e.target.value})} className="bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 [color:var(--color-text-main)] text-xs focus:outline-none focus:border-brand">
            <option value="extreme_close_up">大特写 ECU 85mm</option><option value="close_up">特写 CU 50mm</option><option value="medium">中景 MS 35mm</option><option value="full">全景 FS 28mm</option><option value="long">远景 LS 24mm</option><option value="bird_eye">鸟瞰</option><option value="low_angle">仰角</option><option value="over_shoulder">过肩</option><option value="dutch_angle">荷兰角</option>
          </select>
          <select value={d.motion || 'push_in'} onChange={e=> (d.onUpdate as any)?.(id,{motion:e.target.value})} className="bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 [color:var(--color-text-main)] text-xs focus:outline-none focus:border-brand">
            <option value="static">固定</option><option value="push_in">推镜</option><option value="pull_out">拉出</option><option value="orbit">环绕</option><option value="pan_left">左摇</option><option value="pan_right">右摇</option><option value="tilt_up">仰摇</option><option value="shake">震颤</option><option value="dolly_zoom">希区柯克变焦</option><option value="orbit_boom_up">弧旋升镜</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="text-[11px] [color:var(--color-text-secondary)] font-medium">焦距 {focal}mm<input type="range" min={16} max={135} value={focal} onChange={e=>{setFocal(Number(e.target.value)); (d.onUpdate as any)?.(id,{focal_length_mm:Number(e.target.value)});}} className="w-full accent-amber-500"/></label>
          <label className="text-[11px] [color:var(--color-text-secondary)] font-medium">荷兰角 {roll}°<input type="range" min={-45} max={45} value={roll} onChange={e=>{setRoll(Number(e.target.value)); (d.onUpdate as any)?.(id,{camera_roll_deg:Number(e.target.value)});}} className="w-full accent-amber-500"/></label>
        </div>
        <select value={d.cast_layout || 'solo'} onChange={e=> (d.onUpdate as any)?.(id,{cast_layout:e.target.value})} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
          <option value="solo">单人焦点</option><option value="duel">双人对峙</option><option value="ots">过肩纵深</option><option value="surrounded">群戏包围</option>
        </select>
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 font-mono text-[11px] text-amber-600 dark:text-amber-400 break-words">{d.minimax_camera_prompt || livePrompt}</div>
        <div className="flex gap-1.5">
          <button onClick={()=> (d.onExecute as any)?.(id)} className="flex-1 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 shadow-sm transition-colors">计算机位</button>
          <button onClick={()=> { const sel = (d.onGetSelectedShotId as any)?.(); if(sel) { (d.onApplyToShot as any)?.(sel, { camera_framing: d.framing, camera_motion: d.motion, focal_length_mm: focal, camera_roll_deg: roll, cast_layout: d.cast_layout }); alert('已同步到分镜'); } else alert('请先选中分镜'); }} className="px-3 py-2 rounded-xl bg-surface-secondary border border-border text-xs [color:var(--color-text-main)] hover:bg-surface-tertiary transition-colors">同步到分镜</button>
        </div>
      </div>
    </div>
  );
};
