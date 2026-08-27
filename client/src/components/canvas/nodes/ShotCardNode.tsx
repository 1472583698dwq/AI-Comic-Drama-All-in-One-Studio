import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Film, Image as ImageIcon, Play, RefreshCw, Sparkles } from 'lucide-react';
import { apiService } from '../../../services/api';
import { useProjectStore } from '../../../stores/useProjectStore';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const ShotCardNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [generating, setGenerating] = useState(false);
  const [localData, setLocalData] = useState(d);
  const { project } = useProjectStore();
  // 保持与 d 同步（处理连线注入的 provider）
  React.useEffect(()=> { setLocalData(d); }, [d.provider, d.provider_id, d.model]);

  const handleGenerate = async () => {
    if (!localData.image_prompt?.trim()) { alert('请填写画面提示词'); return; }
    setGenerating(true);
    try {
      // 解耦：优先使用连线注入的 Provider（d.provider），否则回退
      const provider = (d as any).provider || (d as any).provider_id || localData.provider || undefined;
      const model = (d as any).model || localData.model || undefined;
      const res = await apiService.generateShotImage({
        prompt: localData.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        workflow_id: localData.workflow_id || undefined,
        dynamic_inputs: localData.dynamic_inputs,
        provider: provider,
        model: model,
      });
      const next = { ...localData, image_url: res.image_url };
      setLocalData(next);
      // 透传给父画布更新
      (d.onUpdate as any)?.(id, { image_url: res.image_url });
    } catch (e: any) { alert(e.message); } finally { setGenerating(false); }
  };

  const imgUrl = localData.image_url ? (localData.image_url.startsWith('/') ? API_ORIGIN + localData.image_url : localData.image_url) : '';
  const providerBadge = d.provider || d.provider_id || localData.provider;

  // 动态输入：若连接了 Provider 且其 input_schema 含多图/多音等，自动展示对应 Handle
  const providerDef: any = (d as any).providerDef || (d as any).definition;
  const dynamicHandles: any[] = providerDef?.input_schema ? Object.entries(providerDef.input_schema.properties || {}).filter(([,def]:any)=> def['x-handle'] || (def.type==='array' && def.items?.format==='uri')).map(([k,def]:any)=>({id:k, label:k, type: (def['x-handle']|| (k.includes('image')?'image':k.includes('audio')?'audio':k.includes('video')?'video':'text'))})) : [];

  return (
    <div className="w-[300px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-xs font-bold text-white flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-violet-300"/> 分镜卡 {localData.shot_index ? `#${localData.shot_index}`: ''}</span>
        <span className="flex items-center gap-1">
          {providerBadge && <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-600 text-white font-mono truncate max-w-[90px] border border-white/20" title={String(providerBadge)}>{String(providerBadge).slice(0,12)}</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 border border-white/10">{localData.camera_framing || 'medium'} · {localData.camera_motion || 'push_in'}</span>
        </span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" title="输入" />
      <Handle type="source" position={Position.Right} className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" title="输出 image" />
      <Handle type="target" position={Position.Top} id="provider" className="!bg-brand !w-3 !h-3 !border-2 !border-white" style={{ left: '25%' }} title="接 Provider (动态多模态)" />
      <Handle type="target" position={Position.Top} id="ref" className="!bg-amber-400 !w-3 !h-3 !border-2 !border-white" style={{ left: '70%' }} title="参考图" />
      <Handle type="source" position={Position.Bottom} id="image" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" style={{ left: '50%' }} title="输出 image" />
      {/* 动态 Handle 额外展示 */}
      {dynamicHandles.slice(0,3).map((h:any, idx:number)=> (
        <Handle key={h.id} type="target" position={Position.Left} id={h.id} className={`!w-3 !h-3 !border-2 !border-white ${h.type==='image'?'!bg-violet-500':h.type==='audio'?'!bg-pink-500':h.type==='video'?'!bg-orange-500':'!bg-sky-500'}`} style={{ top: `${30 + idx*22}%` }} title={`${h.label} (${h.type})`} />
      ))}

      <div className="aspect-[9/16] max-h-[220px] bg-zinc-950 relative overflow-hidden flex items-center justify-center">
        {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover"/> : <div className="text-xs text-zinc-400 flex flex-col items-center gap-1"><ImageIcon className="w-6 h-6 opacity-50"/><span>{generating ? '生成中…' : '暂无画面'}</span></div>}
        {localData.subtitle_text && <div className="absolute bottom-2 left-2 right-2 bg-black/70 backdrop-blur px-2 py-1 rounded text-[11px] text-white text-center border border-white/10">{localData.subtitle_text}</div>}
      </div>

      <div className="p-2.5 space-y-2 bg-[var(--color-surface)]">
        <textarea value={localData.action_desc || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p, action_desc:v})); (d.onUpdate as any)?.(id,{action_desc:v}); }} placeholder="画面动作描述…（支持多行）" rows={2} className="w-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl p-2 text-xs text-[var(--color-text-main)] placeholder:text-zinc-500 focus:outline-none focus:border-violet-500 resize-none"/>
        <textarea value={localData.image_prompt || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p,image_prompt:v})); (d.onUpdate as any)?.(id,{image_prompt:v}); }} placeholder="英文画面提示词…（可粘贴长段）" rows={2} className="w-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-xl p-2 text-xs font-mono text-[var(--color-text-main)] placeholder:text-zinc-500 focus:outline-none focus:border-violet-500 resize-none"/>
        {dynamicHandles.length>0 && <div className="text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-lg px-2 py-1">已接入 {dynamicHandles.map((h:any)=>h.label).join('、')} · 多模态输入就绪</div>}
        <div className="flex gap-1.5">
          <button onClick={handleGenerate} disabled={generating} className="flex-1 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-40 shadow-md shadow-violet-600/20">{generating ? <RefreshCw className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3"/>}{generating ? '生成中' : '生成首帧'}</button>
          <button onClick={()=>{
            const prompt = localData.video_prompt || localData.action_desc || localData.image_prompt;
            if(!prompt){ alert('请填写视频运动描述'); return; }
            apiService.generateShotVideo({ prompt, mode: 'i2v', first_frame_url: localData.image_url, duration: 5 }).then(r=>{ setLocalData((p:any)=>({...p, video_url: r.video_url})); (d.onUpdate as any)?.(id,{video_url:r.video_url}); }).catch(e=>alert(e.message));
          }} className="px-3 py-1.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-500 hover:bg-orange-500 hover:text-white text-xs flex items-center gap-1 transition-colors"><Play className="w-3 h-3"/> 生视频</button>
        </div>
        {localData.video_url && <div className="text-[10px] text-emerald-500 truncate">✓ 视频已生成</div>}
      </div>
    </div>
  );
};
