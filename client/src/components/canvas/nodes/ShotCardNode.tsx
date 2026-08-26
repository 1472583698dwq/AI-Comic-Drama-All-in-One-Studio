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

  const handleGenerate = async () => {
    if (!localData.image_prompt?.trim()) { alert('请填写画面提示词'); return; }
    setGenerating(true);
    try {
      const res = await apiService.generateShotImage({
        prompt: localData.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        workflow_id: localData.workflow_id || undefined,
        dynamic_inputs: localData.dynamic_inputs,
      });
      const next = { ...localData, image_url: res.image_url };
      setLocalData(next);
      // 透传给父画布更新
      (d.onUpdate as any)?.(id, { image_url: res.image_url });
    } catch (e: any) { alert(e.message); } finally { setGenerating(false); }
  };

  const imgUrl = localData.image_url ? (localData.image_url.startsWith('/') ? API_ORIGIN + localData.image_url : localData.image_url) : '';

  return (
    <div className="w-[300px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-brand/20 to-accent-pink/20 border-b border-border flex items-center justify-between">
        <span className="text-xs font-bold text-white flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-brand-light"/> 分镜卡 {localData.shot_index ? `#${localData.shot_index}`: ''}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-gray-300">{localData.camera_framing || 'medium'} · {localData.camera_motion || 'push_in'}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-brand !w-2 !h-2" />
      <Handle type="source" position={Position.Right} className="!bg-accent-pink !w-2 !h-2" />
      <Handle type="target" position={Position.Top} id="ref" className="!bg-amber-400 !w-2 !h-2" style={{ left: '70%' }} />
      <Handle type="source" position={Position.Bottom} id="image" className="!bg-brand !w-2 !h-2" style={{ left: '50%' }} />

      <div className="aspect-[9/16] max-h-[220px] bg-black/60 relative overflow-hidden flex items-center justify-center">
        {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover"/> : <div className="text-xs text-gray-500 flex flex-col items-center gap-1"><ImageIcon className="w-6 h-6 opacity-50"/><span>{generating ? '生成中…' : '暂无画面'}</span></div>}
        {localData.subtitle_text && <div className="absolute bottom-2 left-2 right-2 bg-black/70 backdrop-blur px-2 py-1 rounded text-[11px] text-white text-center">{localData.subtitle_text}</div>}
      </div>

      <div className="p-2.5 space-y-2">
        <textarea value={localData.action_desc || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p, action_desc:v})); (d.onUpdate as any)?.(id,{action_desc:v}); }} placeholder="画面动作描述…" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
        <textarea value={localData.image_prompt || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p,image_prompt:v})); (d.onUpdate as any)?.(id,{image_prompt:v}); }} placeholder="英文画面提示词…" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs font-mono text-gray-300 placeholder-gray-500 focus:outline-none focus:border-brand"/>
        <div className="flex gap-1.5">
          <button onClick={handleGenerate} disabled={generating} className="flex-1 py-1.5 rounded-xl bg-brand text-white text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-40">{generating ? <RefreshCw className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3"/>}{generating ? '生成中' : '生成首帧'}</button>
          <button onClick={()=>{
            const prompt = localData.video_prompt || localData.action_desc || localData.image_prompt;
            if(!prompt){ alert('请填写视频运动描述'); return; }
            apiService.generateShotVideo({ prompt, mode: 'i2v', first_frame_url: localData.image_url, duration: 5 }).then(r=>{ setLocalData((p:any)=>({...p, video_url: r.video_url})); (d.onUpdate as any)?.(id,{video_url:r.video_url}); }).catch(e=>alert(e.message));
          }} className="px-3 py-1.5 rounded-xl bg-accent-orange/20 border border-accent-orange/30 text-accent-orange text-xs flex items-center gap-1"><Play className="w-3 h-3"/> 生视频</button>
        </div>
        {localData.video_url && <div className="text-[10px] text-accent-green truncate">✓ 视频已生成</div>}
      </div>
    </div>
  );
};
