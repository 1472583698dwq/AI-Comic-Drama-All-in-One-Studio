import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Video, Play, Film, Settings } from 'lucide-react';
import { apiService } from '../../../services/api';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

import { API_ORIGIN } from '../../../utils/devOrigin';
import { pollVideoTask } from '../../../utils/videoTask';

export const VideoNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [mode, setMode] = useState(d.mode || 'i2v');
  const [provider, setProvider] = useState(d.provider || d.provider_id || '');
  const [providers, setProviders] = useState<any[]>([]);
  const [prompt, setPrompt] = useState(d.video_prompt || d.prompt || '');
  const [firstFrame, setFirstFrame] = useState(d.first_frame_url || d.image_url || '');
  const [duration, setDuration] = useState(d.duration || 5);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState(d.video_url || '');

  React.useEffect(()=> {
    const p = (d as any).provider || (d as any).provider_id || (d as any).provider_video;
    if (p && p !== provider) setProvider(p);
  }, [d.provider, d.provider_id, d.provider_video]);

  // 视频源列表 = 生成源接口（不再写死 comfyui_video/minimax_video/kling）
  React.useEffect(()=> { apiService.listProviders({ kind: 'video', production_only: true } as any).then((r:any)=> setProviders(r?.providers||[])).catch(()=>{}); }, []);

  const handleGenerate = async () => {
    const p = prompt || d.action_desc || 'cinematic motion';
    if (!p.trim()) { alert('请填写运动描述'); return; }
    if (mode==='i2v' && !firstFrame) { alert('I2V 需要首帧图像（连入上游 image）'); return; }
    setGenerating(true);
    try {
      const effectiveProvider = (d as any).provider || (d as any).provider_id || (d as any).provider_video || provider;
      const model = (d as any).model;
      const res: any = await apiService.generateShotVideo({
        prompt: p,
        mode: mode as any,
        first_frame_url: firstFrame || undefined,
        duration,
        provider: effectiveProvider,
      } as any);
      let url = res.video_url;
      // 处理 AutoDL 等异步排队：video_url 为空但返回 task_id 时统一轮询（pollVideoTask）
      if (!url && res.task_id) {
        const taskId = res.task_id;
        // 提示排队中
        (d.onUpdate as any)?.(id, { video_url: "", _taskId: taskId, _polling: true });
        url = await pollVideoTask(taskId);
      }
      setVideoUrl(url);
      (d.onUpdate as any)?.(id, { video_url: url, video_prompt: p, mode, provider: effectiveProvider, duration, first_frame_url: firstFrame, model, _polling: false });
    } catch(e:any){ alert(e.message); } finally { setGenerating(false); }
  };

  // 接收上游 image 自动填充 firstFrame
  React.useEffect(()=> {
    const up = d._upstream?.image_url || d._upstream?.file_url;
    if (up && !firstFrame) setFirstFrame(up);
  }, [d._upstream]);

  return (
    <div className="w-[340px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface/80 border-b border-white/70 dark:border-white/12 flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center"><Film className="w-3.5 h-3.5 text-orange-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">生视频 (I2V/R2V/T2V)</span>
        {(d.provider || d.provider_id || d.provider_video) && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full bg-brand text-white font-mono truncate max-w-[80px]">{String(d.provider || d.provider_id || d.provider_video).slice(0,10)}</span>}
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 [color:var(--color-text-muted)] font-mono">{mode.toUpperCase()}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="target" position={Position.Top} id="provider" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" style={{left:'15%'}} title="接 Provider-Video"/>
      <Handle type="target" position={Position.Top} id="image" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-surface" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="video" className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          {(['i2v','r2v','t2v'] as const).map(m=> (
            <button key={m} onClick={()=>{setMode(m); (d.onUpdate as any)?.(id,{mode:m});}} className={`py-1.5 rounded-xl text-xs font-medium border transition-all ${mode===m ? 'bg-orange-500 text-white border-orange-500 shadow-sm font-semibold' : 'bg-surface/80 border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:bg-surface-hover/80 hover:[color:var(--color-text-main)]'}`}>{m.toUpperCase()}</button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <select value={provider} onChange={e=>{setProvider(e.target.value); (d.onUpdate as any)?.(id,{provider:e.target.value});}} className="flex-1 bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
            <option value="">系统默认视频源</option>
            {providers.map((p:any)=> <option key={p.id} value={p.id}>{p.display_name || p.name || p.id}{p.builtin ? ' ·内置' : ' ·自定义'}</option>)}
          </select>
          {(d.provider || d.provider_id) && <span className="text-[10px] px-2 py-1 rounded bg-brand/10 border border-brand/20 text-brand flex items-center font-medium">已连线</span>}
        </div>
        {(d.provider || d.provider_id) && <div className="text-[11px] text-brand bg-brand/10 border border-brand/20 rounded-lg px-2 py-1 font-medium">✓ 已绑定 Provider：{String(d.provider || d.provider_id).slice(0,20)} · 执行时优先使用连线源</div>}
        <textarea value={prompt} onChange={e=>{setPrompt(e.target.value); (d.onUpdate as any)?.(id,{video_prompt:e.target.value});}} placeholder="运动/运镜描述：镜头极速推近，发丝狂舞…" rows={2} className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-2.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"/>
        <input value={firstFrame} onChange={e=>{setFirstFrame(e.target.value); (d.onUpdate as any)?.(id,{first_frame_url:e.target.value});}} placeholder="首帧图像 URL (I2V 必选，连线自动填充)" className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
        <div className="flex items-center gap-2">
          <span className="text-[11px] [color:var(--color-text-secondary)] font-medium">时长</span>
          <input type="range" min={3} max={10} value={duration} onChange={e=>{setDuration(Number(e.target.value)); (d.onUpdate as any)?.(id,{duration:Number(e.target.value)});}} className="flex-1 accent-orange-500"/>
          <span className="text-xs text-orange-500 font-mono font-bold">{duration}s</span>
        </div>
        {firstFrame && <AutoRatioMedia src={firstFrame.startsWith('/')? API_ORIGIN+firstFrame : firstFrame} fallbackAspect="16/9" maxHeight={200} className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80" />}
        {videoUrl ? <video src={videoUrl.startsWith('/')? API_ORIGIN+videoUrl : videoUrl} controls autoPlay loop className="w-full rounded-xl border border-white/70 dark:border-white/12 max-h-[160px] bg-surface/80"/> : null}
        <button onClick={handleGenerate} disabled={generating} className="w-full py-2.5 rounded-xl bg-brand hover:bg-brand-light text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 shadow-sm transition-colors">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Play className="w-3.5 h-3.5"/> 生成视频</>}
        </button>
      </div>
    </div>
  );
};
