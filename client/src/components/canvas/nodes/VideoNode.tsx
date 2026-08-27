import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Video, Play, Film, Settings } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const VideoNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [mode, setMode] = useState(d.mode || 'i2v');
  const [provider, setProvider] = useState(d.provider || d.provider_id || 'comfyui_video');
  const [prompt, setPrompt] = useState(d.video_prompt || d.prompt || '');
  const [firstFrame, setFirstFrame] = useState(d.first_frame_url || d.image_url || '');
  const [duration, setDuration] = useState(d.duration || 5);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState(d.video_url || '');

  React.useEffect(()=> {
    const p = (d as any).provider || (d as any).provider_id || (d as any).provider_video;
    if (p && p !== provider) setProvider(p);
  }, [d.provider, d.provider_id, d.provider_video]);

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
      // 处理 AutoDL 等异步排队：video_url 为空但返回 task_id 时轮询
      if (!url && res.task_id) {
        const taskId = res.task_id;
        // 提示排队中
        (d.onUpdate as any)?.(id, { video_url: "", _taskId: taskId, _polling: true });
        for (let i = 0; i < 120; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const st: any = await apiService.getVideoTaskStatus(taskId);
            const status = (st.status || st.state || "").toString().toUpperCase();
            if (status === "SUCCESS" || status === "COMPLETED") {
              url = st.video_url || st.videoUrl || (st.results && st.results[0]) || "";
              if (url) break;
            } else if (status === "FAILED" || status === "FAIL" || status === "ERROR") {
              throw new Error(st.error || st.msg || "视频任务失败");
            }
          } catch (e: any) {
            if (e?.message && e.message.includes("not_found")) continue;
          }
        }
        if (!url) throw new Error("视频生成排队超时，请稍后在画布执行结果中查看或重试");
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
    <div className="w-[340px] bg-[#1A1A22] border border-accent-orange/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-orange-500/20 to-red-500/20 border-b border-accent-orange/20 flex items-center gap-1.5">
        <Film className="w-3.5 h-3.5 text-accent-orange"/><span className="text-xs font-bold text-white">生视频 (I2V/R2V/T2V)</span>
        { (d.provider || d.provider_id || d.provider_video) && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-600 text-white font-mono truncate max-w-[80px]">{String(d.provider || d.provider_id || d.provider_video).slice(0,10)}</span>}
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-gray-300">{mode.toUpperCase()}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-accent-orange !w-2 !h-2"/>
      <Handle type="target" position={Position.Top} id="provider" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" style={{left:'15%'}} title="接 Provider-Video"/>
      <Handle type="target" position={Position.Top} id="image" className="!bg-brand !w-2 !h-2" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-accent-orange !w-2 !h-2"/>
      <Handle type="source" position={Position.Bottom} id="video" className="!bg-accent-green !w-2 !h-2"/>
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          {(['i2v','r2v','t2v'] as const).map(m=> (
            <button key={m} onClick={()=>{setMode(m); (d.onUpdate as any)?.(id,{mode:m});}} className={`py-1 rounded-lg text-xs border ${mode===m ? 'bg-accent-orange/20 border-accent-orange text-white' : 'bg-[#24242F] border-[#2A2A32] text-gray-400'}`}>{m.toUpperCase()}</button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <select value={provider} onChange={e=>{setProvider(e.target.value); (d.onUpdate as any)?.(id,{provider:e.target.value});}} className="flex-1 bg-[#24242F] border border-[#2A2A32] rounded-xl px-2 py-1.5 text-xs text-white">
            <option value="comfyui_video">ComfyUI 本地 (SVD/AnimateDiff)</option>
            <option value="minimax_video">MiniMax 云端</option>
            <option value="kling">Kling</option>
            {d.provider && !['comfyui_video','minimax_video','kling'].includes(d.provider) && <option value={d.provider}>{d.provider} (连线)</option>}
          </select>
          {(d.provider || d.provider_id) && <span className="text-[10px] px-2 py-1 rounded bg-violet-600/20 border border-violet-500/30 text-violet-300 flex items-center">已连线</span>}
        </div>
        {(d.provider || d.provider_id) && <div className="text-[11px] text-violet-300 bg-violet-500/10 border border-violet-500/20 rounded px-2 py-1">✓ 已绑定 Provider：{String(d.provider || d.provider_id).slice(0,20)} · 执行时优先使用连线源</div>}
        <textarea value={prompt} onChange={e=>{setPrompt(e.target.value); (d.onUpdate as any)?.(id,{video_prompt:e.target.value});}} placeholder="运动/运镜描述：镜头极速推近，发丝狂舞…" rows={2} className="w-full bg-[#24242F] border border-[#2A2A32] rounded-xl p-2 text-xs text-white placeholder-gray-500"/>
        <input value={firstFrame} onChange={e=>{setFirstFrame(e.target.value); (d.onUpdate as any)?.(id,{first_frame_url:e.target.value});}} placeholder="首帧图像 URL (I2V 必选，连线自动填充)" className="w-full bg-[#24242F] border border-[#2A2A32] rounded-xl px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400">时长</span>
          <input type="range" min={3} max={10} value={duration} onChange={e=>{setDuration(Number(e.target.value)); (d.onUpdate as any)?.(id,{duration:Number(e.target.value)});}} className="flex-1 accent-accent-orange"/>
          <span className="text-xs text-accent-orange font-mono">{duration}s</span>
        </div>
        {firstFrame && <div className="rounded-lg overflow-hidden border border-[#2A2A32] h-20 bg-black/40"><img src={firstFrame.startsWith('/')? API_ORIGIN+firstFrame : firstFrame} alt="" className="w-full h-full object-cover"/></div>}
        {videoUrl ? <video src={videoUrl.startsWith('/')? API_ORIGIN+videoUrl : videoUrl} controls autoPlay loop className="w-full rounded-lg border border-accent-green/30 max-h-[160px]"/> : null}
        <button onClick={handleGenerate} disabled={generating} className="w-full py-2 rounded-xl bg-gradient-to-r from-accent-orange to-red-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Play className="w-3.5 h-3.5"/> 生成视频</>}
        </button>
      </div>
    </div>
  );
};
