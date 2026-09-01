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
  const liveShot = project?.scenes.flatMap(s => s.shots).find(s => s.id === (d.shotId || d.id || id)) || localData;
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

  // 动态输入：来自 NodeSpec + Provider input_schema
  const providerDef: any = (d as any).providerDef || (d as any).definition;
  const extraHandles: any[] = providerDef?.input_schema ? Object.entries(providerDef.input_schema.properties || {}).filter(([,def]:any)=> def['x-handle'] || (def.type==='array' && def.items?.format==='uri')).map(([k,def]:any)=>({id:k, label:k, type: (def['x-handle']|| (k.includes('image')?'image':k.includes('audio')?'audio':k.includes('video')?'video':'text'))})) : [];
  // 使用 nodeRegistry 统一输入（P0）
  const specInputs = [
    {id:'provider', label:'生图源', type:'image'},
    {id:'reference', label:'参考图', type:'image'},
    {id:'prompt', label:'提示词', type:'text'},
    {id:'character', label:'角色', type:'text'},
  ];
  const allInputs = [...specInputs, ...extraHandles].slice(0,6);

  return (
    <div className="w-[300px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center justify-between">
        <span className="text-xs font-bold [color:var(--color-text-main)] flex items-center gap-1.5"><Film className="w-3.5 h-3.5 text-brand"/> 分镜卡 {localData.shot_index ? `#${localData.shot_index}`: ''}</span>
        <span className="flex items-center gap-1">
          {providerBadge && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand text-white font-mono truncate max-w-[90px] shadow-sm" title={String(providerBadge)}>{String(providerBadge).slice(0,12)}</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-muted)] border border-border font-mono">{localData.camera_framing || 'medium'} · {localData.camera_motion || 'push_in'}</span>
        </span>
      </div>
      {/* 输入：左侧动态 */}
      {allInputs.map((h:any, idx:number)=> (
        <Handle key={h.id} type="target" position={Position.Left} id={h.id} className={`!w-3 !h-3 !border-2 !border-surface ${h.type==='image'?'!bg-violet-500':h.type==='audio'?'!bg-pink-500':h.type==='video'?'!bg-orange-500':'!bg-sky-500'}`} style={{ top: `${18 + idx*14}%` }} title={`${h.label} (${h.type})`} />
      ))}
      {/* 输出：右侧 */}
      <Handle type="source" position={Position.Right} id="image" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" style={{ top: '30%' }} title="输出 image" />
      <Handle type="source" position={Position.Right} id="video" className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface" style={{ top: '55%' }} title="输出 video" />
      <Handle type="source" position={Position.Right} id="shot" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-surface" style={{ top: '80%' }} title="输出 shot" />

      {/* 挂载的人物与场景徽章 */}
      {(liveShot?.character_ids?.length || liveShot?.scene_name || liveShot?.prop_prompts) && (
        <div className="px-2.5 py-1.5 bg-surface-secondary/80 border-b border-border flex items-center gap-1.5 flex-wrap">
          {(liveShot.character_ids || []).map((cid: string) => {
            const char = project?.characters.find(c => c.id === cid);
            if (!char) return null;
            const avatar = char.three_views?.front || char.avatar_url;
            return (
              <span key={cid} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand/20 text-brand-light text-[9px] font-bold border border-brand/30">
                {avatar && <img src={avatar.startsWith('/') ? API_ORIGIN + avatar : avatar} alt="" className="w-2.5 h-2.5 rounded-full object-cover" />}
                <span>{char.name}</span>
              </span>
            );
          })}
          {liveShot?.scene_name && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-medium border border-emerald-500/30 truncate max-w-[100px]">
              🏞️ {liveShot.scene_name}
            </span>
          )}
          {liveShot?.prop_prompts && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[9px] font-medium border border-amber-500/30 truncate max-w-[80px]">
              🗡️ 道具
            </span>
          )}
        </div>
      )}

      <div className="aspect-[9/16] max-h-[220px] bg-surface-secondary relative overflow-hidden flex items-center justify-center border-b border-border">
        {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover"/> : <div className="text-xs [color:var(--color-text-muted)] flex flex-col items-center gap-1"><ImageIcon className="w-6 h-6 opacity-50"/><span>{generating ? '生成中…' : '暂无画面'}</span></div>}
        {localData.subtitle_text && <div className="absolute bottom-2 left-2 right-2 bg-black/70 backdrop-blur px-2 py-1 rounded text-[11px] text-white text-center border border-white/10">{localData.subtitle_text}</div>}
      </div>

      <div className="p-2.5 space-y-2 bg-surface">
        <textarea value={localData.action_desc || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p, action_desc:v})); (d.onUpdate as any)?.(id,{action_desc:v}); }} placeholder="画面动作描述…（支持多行）" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"/>
        <textarea value={localData.image_prompt || ''} onChange={e=>{ const v=e.target.value; setLocalData((p:any)=>({...p,image_prompt:v})); (d.onUpdate as any)?.(id,{image_prompt:v}); }} placeholder="英文画面提示词…（可粘贴长段）" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs font-mono [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"/>
        {allInputs.length>0 && <div className="text-[10px] text-brand bg-brand/10 border border-brand/20 rounded-lg px-2 py-1 font-medium">已接入 {allInputs.map((h:any)=>h.label).join('、')} · 多模态输入就绪</div>}
        <div className="flex gap-1.5">
          <button onClick={handleGenerate} disabled={generating} className="flex-1 py-1.5 rounded-xl bg-brand hover:bg-brand-light text-white text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-40 shadow-sm">{generating ? <RefreshCw className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3"/>}{generating ? '生成中' : '生成首帧'}</button>
          <button onClick={async()=>{
            const prompt = localData.video_prompt || localData.action_desc || localData.image_prompt;
            if(!prompt){ alert('请填写视频运动描述'); return; }
            const provider = (d as any).provider || (d as any).provider_id || localData.provider;
            try{
              const res: any = await apiService.generateShotVideo({ prompt, mode: 'i2v', first_frame_url: localData.image_url, duration: 5, provider: provider || undefined });
              let url = res.video_url;
              if (!url && res.task_id) {
                const taskId = res.task_id;
                // 轮询排队任务
                for (let i=0;i<120;i++) {
                  await new Promise(r=> setTimeout(r, 3000));
                  try{
                    const st:any = await apiService.getVideoTaskStatus(taskId);
                    const status=(st.status||"").toString().toUpperCase();
                    if(status==="SUCCESS"||status==="COMPLETED"){ url=st.video_url||st.videoUrl||(st.results&&st.results[0])||""; if(url) break; }
                    else if(status==="FAILED"||status==="FAIL") throw new Error(st.error||"任务失败");
                  }catch(e:any){ if(e?.message?.includes("not_found")) continue; }
                }
                if(!url) throw new Error("排队超时");
              }
              setLocalData((p:any)=>({...p, video_url: url})); (d.onUpdate as any)?.(id,{video_url:url});
            }catch(e:any){ alert(e.message); }
          }} className="px-3 py-1.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-500 hover:bg-orange-500 hover:text-white text-xs flex items-center gap-1 transition-colors font-medium"><Play className="w-3 h-3"/> 生视频</button>
        </div>
        {localData.video_url && <div className="text-[10px] text-emerald-500 font-medium truncate">✓ 视频已生成</div>}
      </div>
    </div>
  );
};
