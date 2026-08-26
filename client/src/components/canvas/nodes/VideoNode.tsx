import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Video, Play, Film, Settings } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const VideoNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [mode, setMode] = useState(d.mode || 'i2v');
  const [provider, setProvider] = useState(d.provider || 'comfyui_video');
  const [prompt, setPrompt] = useState(d.video_prompt || d.prompt || '');
  const [firstFrame, setFirstFrame] = useState(d.first_frame_url || d.image_url || '');
  const [duration, setDuration] = useState(d.duration || 5);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState(d.video_url || '');

  const handleGenerate = async () => {
    const p = prompt || d.action_desc || 'cinematic motion';
    if (!p.trim()) { alert('请填写运动描述'); return; }
    if (mode==='i2v' && !firstFrame) { alert('I2V 需要首帧图像（连入上游 image）'); return; }
    setGenerating(true);
    try {
      const res = await apiService.generateShotVideo({
        prompt: p,
        mode: mode as any,
        first_frame_url: firstFrame || undefined,
        duration,
        provider,
      });
      const url = res.video_url;
      setVideoUrl(url);
      (d.onUpdate as any)?.(id, { video_url: url, video_prompt: p, mode, provider, duration, first_frame_url: firstFrame });
    } catch(e:any){ alert(e.message); } finally { setGenerating(false); }
  };

  // 接收上游 image 自动填充 firstFrame
  React.useEffect(()=> {
    const up = d._upstream?.image_url || d._upstream?.file_url;
    if (up && !firstFrame) setFirstFrame(up);
  }, [d._upstream]);

  return (
    <div className="w-[340px] bg-surface border border-accent-orange/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-orange-500/20 to-red-500/20 border-b border-accent-orange/20 flex items-center gap-1.5">
        <Film className="w-3.5 h-3.5 text-accent-orange"/><span className="text-xs font-bold text-white">生视频 (I2V/R2V/T2V)</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-gray-300">{mode.toUpperCase()}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-accent-orange !w-2 !h-2"/>
      <Handle type="target" position={Position.Top} id="image" className="!bg-brand !w-2 !h-2" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-accent-orange !w-2 !h-2"/>
      <Handle type="source" position={Position.Bottom} id="video" className="!bg-accent-green !w-2 !h-2"/>
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          {(['i2v','r2v','t2v'] as const).map(m=> (
            <button key={m} onClick={()=>{setMode(m); (d.onUpdate as any)?.(id,{mode:m});}} className={`py-1 rounded-lg text-xs border ${mode===m ? 'bg-accent-orange/20 border-accent-orange text-white' : 'bg-surface-secondary border-border text-gray-400'}`}>{m.toUpperCase()}</button>
          ))}
        </div>
        <select value={provider} onChange={e=>{setProvider(e.target.value); (d.onUpdate as any)?.(id,{provider:e.target.value});}} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white">
          <option value="comfyui_video">ComfyUI 本地 (SVD/AnimateDiff)</option>
          <option value="minimax_video">MiniMax 云端</option>
          <option value="kling">Kling</option>
        </select>
        <textarea value={prompt} onChange={e=>{setPrompt(e.target.value); (d.onUpdate as any)?.(id,{video_prompt:e.target.value});}} placeholder="运动/运镜描述：镜头极速推近，发丝狂舞…" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500"/>
        <input value={firstFrame} onChange={e=>{setFirstFrame(e.target.value); (d.onUpdate as any)?.(id,{first_frame_url:e.target.value});}} placeholder="首帧图像 URL (I2V 必选，连线自动填充)" className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400">时长</span>
          <input type="range" min={3} max={10} value={duration} onChange={e=>{setDuration(Number(e.target.value)); (d.onUpdate as any)?.(id,{duration:Number(e.target.value)});}} className="flex-1 accent-accent-orange"/>
          <span className="text-xs text-accent-orange font-mono">{duration}s</span>
        </div>
        {firstFrame && <div className="rounded-lg overflow-hidden border border-border h-20 bg-black/40"><img src={firstFrame.startsWith('/')? API_ORIGIN+firstFrame : firstFrame} alt="" className="w-full h-full object-cover"/></div>}
        {videoUrl ? <video src={videoUrl.startsWith('/')? API_ORIGIN+videoUrl : videoUrl} controls autoPlay loop className="w-full rounded-lg border border-accent-green/30 max-h-[160px]"/> : null}
        <button onClick={handleGenerate} disabled={generating} className="w-full py-2 rounded-xl bg-gradient-to-r from-accent-orange to-red-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Play className="w-3.5 h-3.5"/> 生成视频</>}
        </button>
      </div>
    </div>
  );
};
