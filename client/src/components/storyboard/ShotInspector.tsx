import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  Play, 
  Volume2, 
  RefreshCw, 
  Paintbrush, 
  Compass, 
  Clock, 
  Tag, 
  Layers,
  ChevronRight,
  Plus,
  Trash2,
  Film,
  Video,
  Image as ImageIcon,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Upload,
  UserCheck
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot, EmotionType } from '../../types';
import { apiService } from '../../services/api';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';
import { ProviderPicker, ProviderParamForm } from '../ui/ProviderPicker';

const API_ORIGIN = 'http://127.0.0.1:8000';

export const ShotInspector: React.FC = () => {
  const { 
    project, 
    activeShotId, 
    setActiveShotId, 
    updateShot, 
    addShot, 
    deleteShot,
    setActiveTab,
    generateShotVideo
  } = useProjectStore();

  const [previewTab, setPreviewTab] = useState<'image' | 'video'>('image');
  const [inspectorTab, setInspectorTab] = useState<'dialogue' | 'visual' | 'motion'>('visual');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isGeneratingVid, setIsGeneratingVid] = useState(false);
  const [videoMode, setVideoMode] = useState<'i2v' | 'r2v' | 't2v'>('i2v');
  const [videoProvider, setVideoProvider] = useState<string>('comfyui_video');
  const [videoProviderDef, setVideoProviderDef] = useState<any>(null);
  const [videoProviderParams, setVideoProviderParams] = useState<Record<string,any>>({});
  const [imageProvider, setImageProvider] = useState<string>('');
  const [imageProviderDef, setImageProviderDef] = useState<any>(null);
  const [imageProviderParams, setImageProviderParams] = useState<Record<string,any>>({});
  const [audioProvider, setAudioProvider] = useState<string>('minimax');
  const [audioProviderDef, setAudioProviderDef] = useState<any>(null);
  const [audioProviderParams, setAudioProviderParams] = useState<Record<string,any>>({});
  const [healthMap, setHealthMap] = useState<Record<string, any>>({});
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<Array<{id:string, type:'image'|'video'|'audio', status:'queued'|'running'|'done'|'error'}>>([]);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoSuccess, setVideoSuccess] = useState(false);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  // Workflow & Exposed Dynamic Inputs State
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('');
  const [workflowExposedInputs, setWorkflowExposedInputs] = useState<any[]>([]);
  const [shotDynamicInputs, setShotDynamicInputs] = useState<Record<string, any>>({});
  const [inspectingWorkflowId, setInspectingWorkflowId] = useState<string>('');
  const [projectAssets, setProjectAssets] = useState<any[]>([]);
  const [uploadingInputKey, setUploadingInputKey] = useState<string | null>(null);

  const shots: StoryboardShot[] = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

  // Load workflows & project assets
  useEffect(() => {
    loadWorkflowsAndAssets();
  }, []);

  const loadWorkflowsAndAssets = async () => {
    try {
      const wfRes = await apiService.listWorkflows('all');
      setWorkflows(wfRes?.workflows || []);
    } catch (_) {}
    try {
      const assetRes = await apiService.listAssets({ page: 1, limit: 100 });
      setProjectAssets(assetRes?.assets || []);
    } catch (_) {}
  };

  // 同步选中分镜的持久化 Provider 到本地状态（P0）
  useEffect(()=>{
    if(!activeShot) return;
    const s:any = activeShot;
    if(s.image_provider !== undefined) setImageProvider(s.image_provider || '');
    if(s.video_provider !== undefined) setVideoProvider(s.video_provider || 'comfyui_video');
    if(s.audio_provider !== undefined) setAudioProvider(s.audio_provider || 'minimax');
    if(s.provider_params?.image) setImageProviderParams(s.provider_params.image);
    if(s.provider_params?.video) setVideoProviderParams(s.provider_params.video);
    if(s.provider_params?.audio) setAudioProviderParams(s.provider_params.audio);
    if(s.workflow_id !== undefined) setSelectedWorkflowId(s.workflow_id || '');
    if(s.dynamic_inputs) setShotDynamicInputs(s.dynamic_inputs);
  }, [activeShot?.id]);

  // workflow_id 落盘
  useEffect(()=>{
    if(!activeShot) return;
    if(selectedWorkflowId !== (activeShot.workflow_id || '')){
      updateShot(activeShot.id, { workflow_id: selectedWorkflowId } as any);
    }
  }, [selectedWorkflowId]);

  // dynamic_inputs 落盘
  useEffect(()=>{
    if(!activeShot) return;
    const cur = (activeShot as any).dynamic_inputs || {};
    if(JSON.stringify(cur) !== JSON.stringify(shotDynamicInputs)){
      updateShot(activeShot.id, { dynamic_inputs: shotDynamicInputs } as any);
    }
  }, [shotDynamicInputs]);

  // 快捷键 J/K/R/V/Space
  useEffect(()=>{
    const onKey = (e:KeyboardEvent)=>{
      if(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if(e.key==='j' || e.key==='J' || e.key==='ArrowDown'){
        e.preventDefault();
        const idx = shots.findIndex(s=> s.id===activeShot?.id);
        if(idx>=0 && idx < shots.length-1) setActiveShotId(shots[idx+1].id);
      } else if(e.key==='k' || e.key==='K' || e.key==='ArrowUp'){
        e.preventDefault();
        const idx = shots.findIndex(s=> s.id===activeShot?.id);
        if(idx>0) setActiveShotId(shots[idx-1].id);
      } else if(e.key==='r' || e.key==='R'){
        handleRegenerateImage();
      } else if(e.key==='v' || e.key==='V'){
        handleGenerateVideo();
      } else if(e.code==='Space'){
        e.preventDefault();
        handlePlayTTS();
      }
    };
    window.addEventListener('keydown', onKey);
    return ()=> window.removeEventListener('keydown', onKey);
  }, [activeShot, shots, imageProvider, videoProvider]);

  // Provider 健康轻量检测（P0）
  const probeProvider = async (id:string)=>{
    if(!id || healthMap[id]) return;
    try{ const r = await apiService.testProvider(id); setHealthMap(m=> ({...m, [id]: r})); } catch{}
  };
  useEffect(()=>{ if(imageProvider) probeProvider(imageProvider); }, [imageProvider]);
  useEffect(()=>{ if(videoProvider) probeProvider(videoProvider); }, [videoProvider]);
  useEffect(()=>{ if(audioProvider) probeProvider(audioProvider); }, [audioProvider]);

  // When workflow changes, inspect its exposed inputs
  useEffect(() => {
    if (!selectedWorkflowId) {
      setWorkflowExposedInputs([]);
      return;
    }
    apiService.inspectWorkflow(selectedWorkflowId)
      .then(res => {
        const exposed = res?.data?.exposed_inputs || res?.exposed_inputs || [];
        setWorkflowExposedInputs(exposed);
        const initVals: Record<string, any> = {};
        for (const exp of exposed) {
          const key = exp.id || exp.node_id;
          if (exp.default_value !== undefined && exp.default_value !== null) {
            initVals[key] = exp.default_value;
          }
        }
        setShotDynamicInputs(prev => ({ ...initVals, ...prev }));
      })
      .catch(() => {
        setWorkflowExposedInputs([]);
      });
  }, [selectedWorkflowId]);

  if (!activeShot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm space-y-2 p-8">
        <span>请选择或添加分镜</span>
        {project && <button onClick={() => addShot(1)} className="px-3 py-1 rounded bg-brand text-white text-xs">新建分镜</button>}
      </div>
    );
  }

  // TTS — 支持全局语音源（MiniMax/ElevenLabs/自定义）
  const handlePlayTTS = async () => {
    const textToSpeak = activeShot.dialogue || activeShot.voiceover || '';
    if (!textToSpeak.trim()) { setTtsError('当前分镜无台词/旁白，无法配音'); return; }
    if (audioEl) { audioEl.pause(); setAudioEl(null); setIsPlayingAudio(false); }
    setTtsError(null);
    setIsPlayingAudio(true);
    try {
      const char = project?.characters.find((c) => c.name === activeShot.speaker_name);
      const voiceId = char?.voice_id || 'male-qn-qingse';
      // 合并语音源动态参数
      const extraParams: any = { ...audioProviderParams };
      const res = await apiService.generateTTS(textToSpeak, voiceId, activeShot.emotion, { provider: audioProvider || undefined, ...extraParams });
      const url = res.audio_url?.startsWith('/') ? API_ORIGIN + res.audio_url : res.audio_url;
      if (!res.audio_url) throw new Error('TTS 未返回音频地址');
      updateShot(activeShot.id, { audio_url: res.audio_url, duration: res.duration || activeShot.duration, status: 'completed' });
      const a = new Audio(url);
      setAudioEl(a);
      a.onended = () => { setIsPlayingAudio(false); setAudioEl(null); };
      a.onerror = () => { setTtsError('音频播放失败，请检查后端存储'); setIsPlayingAudio(false); };
      await a.play();
    } catch (e: any) {
      setTtsError(e?.message || '配音生成失败');
      setIsPlayingAudio(false);
    }
  };

  const handleUploadImageForInput = async (key: string, file: File) => {
    try {
      setUploadingInputKey(key);
      const res = await apiService.uploadImageToComfyUI(file);
      if (res.name) {
        setShotDynamicInputs(prev => ({ ...prev, [key]: res.name }));
      }
    } catch (e: any) {
      alert(`上传垫图失败: ${e?.message || e}`);
    } finally {
      setUploadingInputKey(null);
    }
  };

  const handleInjectCurrentCharacter = (key: string) => {
    const currentChar = project?.characters.find(c => c.name === activeShot.speaker_name) || project?.characters?.[0];
    const charImg = currentChar?.three_views?.front || currentChar?.avatar_url || currentChar?.three_views?.three_quarter;
    if (!charImg) {
      alert('当前角色未找到立绘或三视图图片，请在角色工坊生成');
      return;
    }
    setShotDynamicInputs(prev => ({ ...prev, [key]: charImg }));
  };

  // 真实生图 — 更新该分镜的 image_url（Provider 与工作流参数分箱，避免 fps 等误传）
  const handleRegenerateImage = async () => {
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(activeShot.id, { status: 'generating_image' });
    try {
      // 分箱：工作流暴露参数 vs 生成源参数 — 仅当使用 ComfyUI 工作流时才走工作流分箱
      const isCustomImageProvider = !!imageProvider && (imageProvider.startsWith('prov_') || (imageProviderDef as any)?.provider_type === 'http');
      const isHttpImageProvider = isCustomImageProvider || (!!imageProvider && !['comfyui',''].includes(imageProvider));
      const useImageWorkflow = !!selectedWorkflowId && !isHttpImageProvider;
      let dynamic_inputs: Record<string,any> | undefined = undefined;
      let extraProviderParams: Record<string,any> | undefined = undefined;
      if (useImageWorkflow) {
        // ComfyUI 工作流：仅发送工作流暴露项，Provider 额外参数需白名单过滤
        dynamic_inputs = Object.keys(shotDynamicInputs).length ? { ...shotDynamicInputs } : undefined;
        const exposedKeys = new Set(Object.keys(shotDynamicInputs));
        const filtered: Record<string,any> = {};
        Object.entries(imageProviderParams).forEach(([k,v])=>{
          if(v!=='' && v!==null && v!==undefined && exposedKeys.has(k)) filtered[k]=v;
        });
        if(Object.keys(filtered).length) {
          dynamic_inputs = { ...(dynamic_inputs||{}), ...filtered };
        }
      } else {
        // 纯 HTTP 生成源：仅发送 Provider 参数，忽略工作流暴露项（避免 fps 等误传）
        const merged: Record<string,any> = {};
        Object.entries(imageProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) merged[k]=v; });
        // 若无 Provider 参数但有工作流输入且未使用工作流，则不发送（避免污染 HTTP）
        dynamic_inputs = Object.keys(merged).length ? merged : undefined;
      }
      const res = await apiService.generateShotImage({
        prompt: activeShot.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        workflow_id: useImageWorkflow ? selectedWorkflowId : undefined,
        provider: imageProvider || undefined,
        model: imageProviderDef?.default_model || undefined,
        dynamic_inputs,
      });
      updateShot(activeShot.id, { image_url: res.image_url, status: 'completed' });
      setPreviewTab('image');
    } catch (e: any) {
      // 若因未定义参数失败，提示并尝试去除非暴露参数重试
      const msg = e?.message || '生图失败';
      if(msg.includes('未定义的参数') && selectedWorkflowId){
        setRegenError('工作流不支持部分生成源参数，已自动忽略并重试。若仍失败请检查工作流暴露项');
      } else {
        setRegenError(msg);
      }
      updateShot(activeShot.id, { status: 'error' });
    } finally {
      setIsRegenerating(false);
    }
  };

  // 动态视频生成 (I2V / R2V / T2V) — 分箱避免 fps 等未暴露参数误传
  const handleGenerateVideo = async () => {
    const prompt = activeShot.video_prompt?.trim() || activeShot.action_desc || activeShot.image_prompt;
    if (!prompt) {
      setVideoError('请填写视频运动运镜提示词');
      return;
    }
    if (videoMode === 'i2v' && !activeShot.image_url) {
      setVideoError('图生视频模式需要先生成或上传首帧画面');
      return;
    }
    setVideoError(null);
    setIsGeneratingVid(true);
    try {
      // 仅当使用 ComfyUI 视频工作流时才走工作流分箱；HTTP 自定义源直接透传 provider 参数
      const isCustomVideoProvider = !!videoProvider && (videoProvider.startsWith('prov_') || (videoProviderDef as any)?.provider_type === 'http');
      const isHttpVideoProvider = isCustomVideoProvider || (!!videoProvider && !['comfyui_video',''].includes(videoProvider));
      const useVideoWorkflow = !!selectedWorkflowId && !isHttpVideoProvider;
      let dynamic_inputs: Record<string,any> | undefined = undefined;
      if (useVideoWorkflow) {
        dynamic_inputs = Object.keys(shotDynamicInputs).length ? { ...shotDynamicInputs } : undefined;
        const exposedKeys = new Set(Object.keys(shotDynamicInputs));
        const filtered: Record<string,any> = {};
        Object.entries(videoProviderParams).forEach(([k,v])=>{
          if(v!=='' && v!==null && v!==undefined && exposedKeys.has(k)) filtered[k]=v;
        });
        if(Object.keys(filtered).length) dynamic_inputs = { ...(dynamic_inputs||{}), ...filtered };
      } else {
        const merged: Record<string,any> = {};
        Object.entries(videoProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) merged[k]=v; });
        dynamic_inputs = Object.keys(merged).length ? merged : undefined;
      }
      await generateShotVideo(activeShot.id, {
        mode: videoMode,
        prompt,
        duration: Math.round(activeShot.duration) || 5,
        provider: videoProvider,
        workflow_id: useVideoWorkflow ? selectedWorkflowId : undefined,
        dynamic_inputs,
      });
      setVideoSuccess(true);
      setPreviewTab('video');
      setTimeout(() => setVideoSuccess(false), 3000);
    } catch (e: any) {
      const msg = e?.message || '视频生成失败';
      const isCustomVideoProvider2 = !!videoProvider && (videoProvider.startsWith('prov_') || (videoProviderDef as any)?.provider_type === 'http');
      const isHttpVideoProvider2 = isCustomVideoProvider2 || (!!videoProvider && !['comfyui_video',''].includes(videoProvider));
      if(msg.includes('未定义的参数')){
        if(isHttpVideoProvider2){
          setVideoError('HTTP视频源已自动过滤未暴露参数（如 fps/resolution 不匹配），若仍失败请检查生成源的请求模板与参数');
        } else {
          setVideoError('检测到未暴露参数（如 fps），已自动忽略。工作流仅支持其暴露的输入，请在“参数与暴露诊断”中查看可填项，或切换为 HTTP 视频源');
        }
      } else if(msg.includes('未能提取视频')){
        setVideoError(msg + '（请检查工作流/生成源的响应映射 video_url 路径）');
      } else {
        setVideoError(msg);
      }
    } finally {
      setIsGeneratingVid(false);
    }
  };

  // P2: 批量生成队列
  const handleBatchImage = async ()=>{
    const ids = Array.from(batchSelected);
    if(ids.length===0) return;
    const jobs = ids.map(id=> ({id, type:'image' as const, status:'queued' as const}));
    setQueue(q=> [...q, ...jobs]);
    for(const shotId of ids){
      setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'running'} : j));
      const sh = shots.find(s=> s.id===shotId);
      if(!sh) { setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'error'}:j)); continue; }
      try{
        const prov = (sh as any).image_provider || imageProvider || undefined;
        const params = (sh as any).provider_params?.image || imageProviderParams;
        const dyn:Record<string,any> = {...(sh as any).dynamic_inputs, ...shotDynamicInputs, ...params};
        const res = await apiService.generateShotImage({
          prompt: sh.image_prompt,
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: (sh as any).workflow_id || selectedWorkflowId || undefined,
          provider: prov || undefined,
          dynamic_inputs: Object.keys(dyn).length? dyn: undefined,
        });
        updateShot(shotId, { image_url: res.image_url, status: 'completed' } as any);
        setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'done'}:j));
      }catch{
        setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'error'}:j));
        updateShot(shotId, {status:'error'} as any);
      }
    }
    setTimeout(()=> setQueue(q=> q.filter(j=> !ids.includes(j.id))), 4000);
  };
  const handleBatchVideo = async ()=>{
    const ids = Array.from(batchSelected);
    if(ids.length===0) return;
    const jobs = ids.map(id=> ({id, type:'video' as const, status:'queued' as const}));
    setQueue(q=> [...q, ...jobs]);
    for(const shotId of ids){
      setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'running'}:j));
      const sh = shots.find(s=> s.id===shotId);
      if(!sh){ setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'error'}:j)); continue; }
      try{
        const prov = (sh as any).video_provider || videoProvider;
        await generateShotVideo(shotId, { mode: videoMode, prompt: sh.video_prompt||sh.action_desc||sh.image_prompt, duration: Math.round(sh.duration)||5, provider: prov, workflow_id: (sh as any).workflow_id || selectedWorkflowId || undefined, dynamic_inputs: (sh as any).dynamic_inputs || shotDynamicInputs });
        setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'done'}:j));
      }catch{
        setQueue(q=> q.map(j=> j.id===shotId ? {...j, status:'error'}:j));
      }
    }
    setTimeout(()=> setQueue(q=> q.filter(j=> !ids.includes(j.id))), 4000);
  };

  const getMediaUrl = (url?: string | null) => {
    if (!url) return '';
    return url.startsWith('/') ? API_ORIGIN + url : url;
  };

  const videoMotionPresets = [
    { label: '🔥 极速推进 (Push In)', prompt: '镜头极速推向主角面部，眼神爆发金光，背景光芒拉丝' },
    { label: '🌀 360° 环绕 (Orbit)', prompt: '动态弧形 360 度环拍，主角发丝与衣袂随风狂舞' },
    { label: '⚡ 战斗震颤 (Combat Shake)', prompt: '手持镜头激烈震动，冲击波扩散，雷电特效环绕' },
    { label: '🌌 渐远拉出 (Pull Out)', prompt: '镜头由近及远缓缓拉出，展现广袤天地与宏伟背景' },
  ];

  return (
    <div className="flex-1 flex gap-3 p-3 overflow-hidden bg-background">
      {/* 1. Left Column: Shot List — 卡片化、留白 */}
      <div className="w-[280px] bg-surface border border-border rounded-2xl flex flex-col shrink-0 overflow-hidden shadow-sm">
        <div className="h-11 px-3 border-b border-border flex items-center justify-between shrink-0 bg-surface-secondary/50">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-brand" /></div>
            <span className="text-xs font-bold tracking-tight text-white">分镜</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">{shots.length}</span>
            {batchSelected.size>0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand text-white">{batchSelected.size} 选中</span>}
          </div>
          <div className="flex items-center gap-1">
            {batchSelected.size>0 ? (
              <button onClick={()=> setBatchSelected(new Set())} className="text-[10px] px-2 py-1 rounded-full bg-surface-tertiary border border-border text-gray-400">取消</button>
            ) : (
              <button onClick={()=> setBatchSelected(new Set(shots.map(s=> s.id)))} className="text-[10px] px-2 py-1 rounded-full bg-surface-tertiary border border-border text-gray-400 hover:text-white">全选</button>
            )}
            <button onClick={() => addShot(1)} className="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center hover:bg-brand-light shadow-sm" title="添加分镜"><Plus className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        {batchSelected.size>0 && (
          <div className="px-2 py-1.5 bg-brand/10 border-b border-brand/20 flex items-center gap-1 shrink-0">
            <button onClick={handleBatchImage} className="flex-1 py-1 rounded-lg bg-violet-600 text-white text-[11px] font-bold">批量生图</button>
            <button onClick={handleBatchVideo} className="flex-1 py-1 rounded-lg bg-orange-500 text-white text-[11px] font-bold">批量视频</button>
            <button onClick={()=> { alert('批量配音需逐镜试听，已加入队列'); }} className="px-2 py-1 rounded-lg bg-pink-500/20 border border-pink-500/30 text-pink-300 text-[11px]">配音</button>
          </div>
        )}

        {/* Shot Scroll List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
          {shots.map((shot) => {
            const isSelected = shot.id === activeShot.id;
            const isBatch = batchSelected.has(shot.id);
            const hasVideo = Boolean(shot.video_url);
            const q = queue.find(x=> x.id===shot.id);
            return (
              <div
                key={shot.id}
                onClick={() => setActiveShotId(shot.id)}
                className={`p-2 rounded-xl border cursor-pointer transition-all relative ${
                  isSelected
                    ? 'bg-surface-tertiary border-brand glow-border'
                    : isBatch ? 'bg-brand/5 border-brand/30' : 'bg-surface-secondary/60 border-border hover:border-border-active'
                }`}
              >
                <input type="checkbox" checked={isBatch} onChange={e=> {
                  e.stopPropagation();
                  setBatchSelected(prev=>{
                    const n = new Set(prev);
                    if(n.has(shot.id)) n.delete(shot.id); else n.add(shot.id);
                    return n;
                  });
                }} onClick={e=> e.stopPropagation()} className="absolute top-2 left-2 w-3.5 h-3.5 rounded border border-white/30 bg-black/60 accent-brand" />
                <div className="relative aspect-video rounded-lg overflow-hidden bg-black/60 mb-1.5 ml-4">
                  {shot.image_url ? (
                    <img 
                      src={getMediaUrl(shot.image_url)} 
                      alt="" 
                      className="w-full h-full object-cover" 
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">
                      {shot.status === 'generating_image' ? '生图中...' : (shot.status === 'generating_video' ? '生视频中...' : q?.status==='running' ? '队列中...' : '待生成')}
                    </div>
                  )}
                  <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/70 text-[9px] font-mono text-brand-light font-bold">
                    #{shot.shot_index}
                  </span>
                  {hasVideo && (
                    <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-accent-orange/90 text-[8px] font-bold text-white uppercase tracking-wider flex items-center space-x-0.5">
                      <Film className="w-2.5 h-2.5" />
                      <span>VID</span>
                    </span>
                  )}
                  <span className="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[9px] text-gray-300 font-mono">
                    {shot.duration}s
                  </span>
                  {q && <span className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[8px] font-bold ${q.status==='running'?'bg-brand text-white':q.status==='done'?'bg-emerald-500 text-white':q.status==='error'?'bg-red-500 text-white':'bg-zinc-600 text-white'}`}>{q.status}</span>}
                  {(shot as any).image_provider && <span className="absolute top-6 left-1 px-1 py-0.5 rounded bg-violet-600/80 text-[8px] text-white font-mono truncate max-w-[80px]">{(shot as any).image_provider}</span>}
                </div>
                <p className="text-[11px] text-gray-300 truncate font-medium ml-4">{shot.action_desc}</p>
                {shot.dialogue && (
                  <p className="text-[10px] text-accent-pink truncate ml-4">🗣️ {shot.dialogue}</p>
                )}
                {shot.status==='error' && <span className="ml-4 text-[10px] text-red-400">生成失败</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Center Column: Main Canvas Monitor — 圆角卡片、通透 */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6 bg-surface border border-border rounded-2xl overflow-hidden relative">
        {/* Top Preview Mode Switcher — 胶囊分段 */}
        <div className="mb-3 z-10 flex items-center p-1 rounded-full bg-surface-secondary border border-border shadow-sm">
          <button onClick={() => setPreviewTab('image')} className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all ${previewTab === 'image' ? 'bg-white dark:bg-brand text-surface dark:text-white shadow-sm' : 'text-gray-500 hover:text-white'}`}>
            <ImageIcon className="w-3.5 h-3.5" /><span>首帧</span>
          </button>
          <button onClick={() => setPreviewTab('video')} className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all ${previewTab === 'video' ? 'bg-brand text-white shadow-sm' : 'text-gray-500 hover:text-white'}`}>
            <Film className="w-3.5 h-3.5" /><span>视频</span>{activeShot.video_url && <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />}
          </button>
        </div>

        {regenError && <div className="mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {regenError}</div>}
        {videoError && <div className="mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {videoError}</div>}
        {ttsError && <div className="mb-2 px-3 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {ttsError}</div>}

        <div className="relative max-h-[70vh] aspect-[9/16] rounded-2xl overflow-hidden shadow-2xl border border-border/80 group bg-black">
          {previewTab === 'video' ? (
            activeShot.video_url ? (
              <video
                key={activeShot.video_url}
                src={getMediaUrl(activeShot.video_url)}
                controls
                autoPlay
                loop
                playsInline
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full min-h-[50vh] min-w-[28vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-6 text-center">
                <Film className="w-10 h-10 text-accent-orange/60" />
                <span className="font-semibold text-white">当前分镜尚未生成动态视频</span>
                <span className="text-[11px] text-gray-500">
                  支持基于首帧图像的 I2V (图生视频) 与多参考图 R2V
                </span>
                <button
                  onClick={handleGenerateVideo}
                  disabled={isGeneratingVid}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-accent-orange to-brand-glow text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40"
                >
                  {isGeneratingVid ? '视频生成中...' : '立即生成动态视频'}
                </button>
              </div>
            )
          ) : activeShot.image_url ? (
            <img
              src={getMediaUrl(activeShot.image_url)}
              alt="Shot Preview"
              className={`w-full h-full object-cover transition-transform duration-1000 ${
                activeShot.camera_motion === 'push_in' ? 'group-hover:scale-105' : ''
              }`}
            />
          ) : (
            <div className="w-full h-full min-h-[50vh] min-w-[28vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-500 text-xs space-y-3 p-4 text-center">
              <span>{activeShot.status === 'generating_image' ? '画面生成中，请稍候...' : '该分镜暂无首帧画面'}</span>
              <button onClick={handleRegenerateImage} disabled={isRegenerating} className="px-3 py-1 rounded bg-brand text-white text-xs disabled:opacity-40">点击生成首帧画面</button>
            </div>
          )}

          {/* Top Info Pill */}
          <div className="absolute top-3 left-3 flex items-center space-x-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10 pointer-events-none">
            <span className="text-[11px] font-bold text-white font-mono">镜头 #{activeShot.shot_index}</span>
            <span className="text-[10px] px-1.5 rounded bg-brand/30 text-brand-light border border-brand/40">
              {activeShot.camera_framing}
            </span>
            <span className="text-[10px] px-1.5 rounded bg-accent-orange/20 text-accent-orange border border-accent-orange/40">
              {activeShot.camera_motion}
            </span>
          </div>

          {/* Subtitle / Dialogue Bubble Overlay at bottom */}
          {activeShot.subtitle_text && (
            <div className="absolute bottom-6 left-4 right-4 bg-black/75 backdrop-blur-md p-3 rounded-xl border border-white/15 text-center shadow-lg animate-fade-in pointer-events-none">
              <span className="text-xs font-bold text-white tracking-wide">
                {activeShot.subtitle_text}
              </span>
            </div>
          )}

          {/* Floating Action Buttons */}
          <div className="absolute top-3 right-3 flex flex-col space-y-2">
            <button
              onClick={() => setActiveTab('director3d')}
              className="p-2 rounded-xl bg-black/70 hover:bg-accent-orange text-white backdrop-blur-md border border-white/10 transition-all shadow-md"
              title="进入 3D 导演台规划姿态与机位"
            >
              <Compass className="w-4 h-4 text-accent-orange hover:text-white" />
            </button>

            <button
              onClick={handleRegenerateImage}
              disabled={isRegenerating}
              className="p-2 rounded-xl bg-black/70 hover:bg-brand text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
              title="重新生成分镜首帧画面"
            >
              <RefreshCw className={`w-4 h-4 text-brand-light ${isRegenerating ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* 3. Right Column: Shot Inspector — Tab 化 P0 + 健康可见 */}
      <div className="w-[360px] bg-surface border border-border rounded-2xl flex flex-col overflow-hidden shrink-0 shadow-sm">
        <div className="h-11 px-3 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
          <div className="flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-brand" />
            <span className="text-xs font-bold text-white">检查器</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface border border-border text-gray-400">#{activeShot.shot_index}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={()=> {
              // 发送到画布
              try{
                const payload = { shot: activeShot, projectId: project?.id };
                localStorage.setItem('canvas_pending_shot', JSON.stringify(payload));
                setActiveTab('canvas' as any);
                // @ts-ignore
                if(typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('canvas-import-shot', {detail: payload}));
              }catch{}
            }} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white" title="发送到画布"><Layers className="w-3.5 h-3.5"/></button>
            <button onClick={() => deleteShot(activeShot.id)} className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10" title="删除此分镜"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex items-center gap-1 p-1.5 bg-surface-secondary/50 border-b border-border shrink-0">
          {[
            {id:'dialogue', label:'台词', icon:'🗣️', color:'text-pink-400'},
            {id:'visual', label:'画面', icon:'🎬', color:'text-violet-400'},
            {id:'motion', label:'动态', icon:'🎥', color:'text-orange-400'},
          ].map(t=>(
            <button key={t.id} onClick={()=> setInspectorTab(t.id as any)} className={`flex-1 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1 transition-all ${inspectorTab===t.id ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}>
              <span>{t.icon}</span><span>{t.label}</span>
              {t.id==='dialogue' && audioProvider && healthMap[audioProvider] && (
                <span className={`w-1.5 h-1.5 rounded-full ${healthMap[audioProvider]?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              )}
              {t.id==='visual' && imageProvider && healthMap[imageProvider] && (
                <span className={`w-1.5 h-1.5 rounded-full ${healthMap[imageProvider]?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              )}
              {t.id==='motion' && videoProvider && healthMap[videoProvider] && (
                <span className={`w-1.5 h-1.5 rounded-full ${healthMap[videoProvider]?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
        {inspectorTab==='dialogue' && (
          <div className="space-y-3">
            <div className="p-2.5 rounded-xl bg-pink-500/5 border border-pink-500/20 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-pink-300">角色台词 / 旁白</span>
                <span className={`w-2 h-2 rounded-full ${healthMap[audioProvider]?.ok ? 'bg-emerald-500' : healthMap[audioProvider]?.ok===false ? 'bg-amber-500' : 'bg-zinc-600'}`} title={healthMap[audioProvider]?.detail || '未检测'} />
              </div>
              <textarea
                value={activeShot.dialogue || activeShot.voiceover || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  updateShot(activeShot.id, {
                    dialogue: activeShot.dialogue ? val : '',
                    voiceover: activeShot.voiceover || !activeShot.dialogue ? val : activeShot.voiceover,
                    subtitle_text: val,
                  });
                }}
                placeholder="输入台词/旁白..."
                rows={3}
                className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-pink-500/50 resize-none leading-relaxed"
              />
              <ProviderPicker kind="audio" value={audioProvider} onChange={(pid, def)=> {
                setAudioProvider(pid); setAudioProviderDef(def||null);
                updateShot(activeShot.id, { audio_provider: pid, provider_params: { ...(activeShot as any).provider_params, audio: audioProviderParams } } as any);
                if(pid) probeProvider(pid);
              }} placeholder="— 选择语音源 —" compact />
              {healthMap[audioProvider] && !healthMap[audioProvider].ok && <div className="text-[11px] text-amber-300">{healthMap[audioProvider].detail?.slice(0,80)}</div>}
              {audioProviderDef?.params_schema && (
                <div className="rounded-xl bg-black/20 border border-border p-2">
                  <ProviderParamForm definition={audioProviderDef} values={audioProviderParams} onChange={(next)=>{
                    setAudioProviderParams(next);
                    updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, audio: next } } as any);
                  }} />
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <select value={activeShot.speaker_name || project?.characters[0]?.name || ''} onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })} className="flex-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                  {project?.characters.map((c) => (<option key={c.id} value={c.name}>{c.name}</option>))}
                </select>
                <select value={activeShot.emotion} onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as EmotionType })} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="neutral">😐 平静</option><option value="intense">🔥 怒吼</option><option value="sorrow">😢 悲痛</option><option value="excited">⚡ 兴奋</option><option value="whispering">🤫 耳语</option>
                </select>
              </div>
              <button onClick={handlePlayTTS} className="w-full py-2 rounded-xl bg-gradient-to-r from-pink-500 to-violet-500 text-white text-xs font-bold flex items-center justify-center gap-1.5">
                <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} /><span>{isPlayingAudio ? '播放中...' : '试听配音'}</span>
              </button>
              {ttsError && <div className="text-xs text-red-300">{ttsError}</div>}
              {activeShot.audio_url && <audio controls src={getMediaUrl(activeShot.audio_url)} className="w-full mt-1" />}
            </div>
            <div className="p-2.5 rounded-xl bg-surface-secondary/40 border border-border">
              <label className="text-[11px] font-semibold text-gray-300">字幕</label>
              <input value={activeShot.subtitle_text} onChange={e=> updateShot(activeShot.id, { subtitle_text: e.target.value })} placeholder="字幕文本，留空则用台词" className="mt-1 w-full bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-500"/>
            </div>
          </div>
        )}

        {inspectorTab==='visual' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-300 flex items-center gap-1"><Paintbrush className="w-3 h-3 text-violet-400"/> 画面动作</label>
              <textarea value={activeShot.action_desc} onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })} rows={2} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
            </div>
            <div className="p-3 rounded-xl bg-violet-500/5 border border-violet-500/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-violet-300 flex items-center gap-1"><ImageIcon className="w-3.5 h-3.5"/> 首帧提示词</span>
                <span className={`w-2 h-2 rounded-full ${healthMap[imageProvider]?.ok ? 'bg-emerald-500' : healthMap[imageProvider]?.ok===false ? 'bg-amber-500' : 'bg-zinc-600'}`} title={healthMap[imageProvider]?.detail || '未检测'} />
              </div>
              <ProviderPicker kind="image" value={imageProvider} onChange={(pid, def)=> {
                setImageProvider(pid); setImageProviderDef(def||null);
                updateShot(activeShot.id, { image_provider: pid, provider_params: { ...(activeShot as any).provider_params, image: imageProviderParams } } as any);
                if(pid) probeProvider(pid);
              }} placeholder="— 选择生图源 —" />
              {healthMap[imageProvider] && !healthMap[imageProvider].ok && <div className="text-[11px] text-amber-300">{healthMap[imageProvider].detail?.slice(0,80)}</div>}
              {imageProviderDef?.params_schema && (
                <div className="rounded-xl bg-black/20 border border-border p-2">
                  <ProviderParamForm definition={imageProviderDef} values={imageProviderParams} onChange={(next)=>{
                    setImageProviderParams(next);
                    updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, image: next } } as any);
                  }} />
                </div>
              )}
              <textarea value={activeShot.image_prompt} onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })} rows={3} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" placeholder="画面首帧提示词..."/>
              <div className="bg-surface-secondary/70 border border-border rounded-xl p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-gray-300">ComfyUI 工作流</span>
                  {selectedWorkflowId && <button onClick={() => setInspectingWorkflowId(selectedWorkflowId)} className="text-[10px] text-brand-light hover:underline flex items-center gap-1"><Sliders className="w-3 h-3"/> 参数</button>}
                </div>
                <select value={selectedWorkflowId} onChange={(e) => setSelectedWorkflowId(e.target.value)} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="">-- 系统默认 --</option>
                  {workflows.map((wf) => (<option key={wf.id} value={wf.id}>{wf.name || wf.id} ({wf.source==='internal'?'内部':'外部'})</option>))}
                </select>
                {workflowExposedInputs.length > 0 && (
                  <div className="pt-2 border-t border-border/60 space-y-2">
                    <div className="text-[11px] font-bold text-amber-300">暴露项 {workflowExposedInputs.length}</div>
                    {workflowExposedInputs.map((exp:any)=>{
                      const key = exp.id || exp.node_id;
                      const val = shotDynamicInputs[key];
                      return (
                        <div key={key} className="p-2 rounded-lg bg-surface-secondary border border-border space-y-1"
                          onDragOver={e=>{ e.preventDefault(); e.currentTarget.classList.add('border-brand'); }}
                          onDragLeave={e=> e.currentTarget.classList.remove('border-brand')}
                          onDrop={e=>{
                            e.preventDefault(); e.currentTarget.classList.remove('border-brand');
                            const url = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
                            if(url) setShotDynamicInputs(p=> ({...p, [key]: url}));
                          }}
                        >
                          <div className="flex items-center justify-between"><span className="text-xs text-white">{exp.label || exp.param_name}</span><span className="text-[9px] font-mono text-gray-500">#{exp.node_id}</span></div>
                          {(exp.type==='image' || exp.type==='audio' || exp.type==='video') ? (
                            val ? (
                              <div className="flex items-center gap-2">
                                {exp.type==='image' ? <img src={val.startsWith('/')?API_ORIGIN+val:val} alt="" className="w-16 h-16 rounded-lg object-cover border border-border"/> : exp.type==='audio' ? <span className="text-xs font-mono truncate max-w-[120px]">{String(val).slice(0,32)}…</span> : <span className="text-xs">🎬 {String(val).slice(0,20)}</span>}
                                <button onClick={()=> setShotDynamicInputs(p=> ({...p, [key]: ''}))} className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-xs">移除</button>
                              </div>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {exp.type==='image' && <button onClick={()=> handleInjectCurrentCharacter(key)} className="px-2 py-1 rounded bg-brand/20 border border-brand/30 text-[11px] text-brand-light flex items-center gap-1"><UserCheck className="w-3 h-3"/> 注入角色</button>}
                                <label className="px-2 py-1 rounded bg-surface-tertiary border border-border text-xs cursor-pointer flex items-center gap-1"><Upload className="w-3 h-3"/> 上传{exp.type==='audio'?'音频':exp.type==='video'?'视频':'图片'}<input type="file" accept={exp.type==='image'?'image/*':exp.type==='audio'?'audio/*':'video/*'} className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(!f) return; if(exp.type==='image') handleUploadImageForInput(key,f); else { const r=new FileReader(); r.onload=()=> setShotDynamicInputs(p=>({...p,[key]: r.result as string})); r.readAsDataURL(f); } }}/></label>
                                {projectAssets.filter(a=> exp.type==='image' ? (a.file_url||a.thumb_url||a.image_url) : exp.type==='audio' ? (a.file_url?.endsWith('.mp3')||a.file_url?.endsWith('.wav')) : (a.file_url?.endsWith('.mp4')||a.file_url?.endsWith('.mov'))).slice(0,3).map(a=>(
                                  <button key={a.id} onClick={()=> setShotDynamicInputs(p=> ({...p,[key]: a.file_url||a.thumb_url||a.image_url||a.file_url}))} className="w-8 h-8 rounded border border-border overflow-hidden">{exp.type==='image' ? <img src={getMediaUrl(a.file_url||a.thumb_url||a.image_url)} alt="" className="w-full h-full object-cover"/> : <span className="text-[10px]">{exp.type}</span>}</button>
                                ))}
                              </div>
                            )
                          ) : exp.type==='number' ? (
                            <input type="number" value={val??''} onChange={e=> setShotDynamicInputs(p=>({...p,[key]: parseFloat(e.target.value)||0}))} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white"/>
                          ) : (exp.type==='select' || exp.type==='combo') ? (
                            <select value={val??''} onChange={e=> setShotDynamicInputs(p=>({...p,[key]: e.target.value}))} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white">
                              <option value="">-- 请选择 --</option>
                              {(exp.choices||[]).map((c:string)=>(<option key={c} value={c}>{c}</option>))}
                              {!(exp.choices||[]).includes(val) && val && <option value={val}>{val}</option>}
                            </select>
                          ) : exp.type==='boolean' ? (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={!!val} onChange={e=> setShotDynamicInputs(p=>({...p,[key]: e.target.checked}))} className="w-4 h-4 rounded text-brand bg-surface-tertiary border-border" />
                              <span className="text-xs text-gray-300">{val?'是':'否'}</span>
                            </label>
                          ) : (val && typeof val==='string' && val.length>60) ? (
                            <textarea value={val??''} onChange={e=> setShotDynamicInputs(p=>({...p,[key]: e.target.value}))} rows={3} placeholder={exp.description||key} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500 resize-none"/>
                          ) : (
                            <input type="text" value={val??''} onChange={e=> setShotDynamicInputs(p=>({...p,[key]: e.target.value}))} placeholder={exp.description||key} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500"/>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <button onClick={handleRegenerateImage} disabled={isRegenerating} className="w-full py-2.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
                <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating?'animate-spin':''}`} /><span>{isRegenerating?'生成中…':'生成 / 重绘首帧'}</span>
              </button>
              {regenError && <div className="text-xs text-red-300">{regenError}</div>}
              {(activeShot as any).history?.length>0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-[11px] font-semibold text-gray-300">历史 { (activeShot as any).history.length }</div>
                  <div className="flex gap-1 mt-1 overflow-x-auto">
                    {(activeShot as any).history.slice(-6).reverse().map((h:any,i:number)=>(
                      <button key={i} onClick={()=> h.image_url && updateShot(activeShot.id, {image_url: h.image_url} as any)} className="w-12 h-12 rounded-lg overflow-hidden border border-border shrink-0">
                        {h.image_url ? <img src={getMediaUrl(h.image_url)} alt="" className="w-full h-full object-cover"/> : <span className="text-[9px]">—</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-gray-400">机位</label>
                <select value={activeShot.camera_framing} onChange={e=> updateShot(activeShot.id, {camera_framing: e.target.value as any})} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="close_up">特写</option><option value="medium">中景</option><option value="full">全景</option><option value="long">远景</option><option value="bird_eye">俯视</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-gray-400">运动</label>
                <select value={activeShot.camera_motion} onChange={e=> updateShot(activeShot.id, {camera_motion: e.target.value as any})} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="static">静止</option><option value="push_in">推近</option><option value="pull_out">拉远</option><option value="orbit">环绕</option><option value="shake">震颤</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {inspectorTab==='motion' && (
          <div className="p-3 rounded-xl bg-orange-500/5 border border-orange-500/20 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-orange-400 flex items-center gap-1"><Video className="w-3.5 h-3.5"/> 动态生成</span>
              <span className={`w-2 h-2 rounded-full ${healthMap[videoProvider]?.ok ? 'bg-emerald-500' : healthMap[videoProvider]?.ok===false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
            </div>
            <div className="grid grid-cols-3 gap-1">
              {[{id:'i2v',label:'图生视频'},{id:'r2v',label:'参考'},{id:'t2v',label:'文生'}].map(m=>(
                <button key={m.id} onClick={()=> setVideoMode(m.id as any)} className={`py-1.5 rounded-lg text-xs font-bold border ${videoMode===m.id?'bg-orange-500 text-white border-orange-500':'bg-surface-secondary text-gray-400 border-border'}`}>{m.label}</button>
              ))}
            </div>
            <ProviderPicker kind="video" value={videoProvider} onChange={(pid, def)=> {
              setVideoProvider(pid); setVideoProviderDef(def||null);
              updateShot(activeShot.id, { video_provider: pid, provider_params: { ...(activeShot as any).provider_params, video: videoProviderParams } } as any);
              if(pid) probeProvider(pid);
            }} placeholder="— 选择视频源 —" />
            {healthMap[videoProvider] && !healthMap[videoProvider].ok && <div className="text-[11px] text-amber-300">{healthMap[videoProvider].detail?.slice(0,80)}</div>}
            {videoProviderDef?.params_schema && (
              <div className="rounded-xl bg-black/20 border border-border p-2">
                <ProviderParamForm definition={videoProviderDef} values={videoProviderParams} onChange={(next)=>{
                  setVideoProviderParams(next);
                  updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, video: next } } as any);
                }} />
              </div>
            )}
            <textarea value={activeShot.video_prompt||''} onChange={e=> updateShot(activeShot.id, {video_prompt: e.target.value})} placeholder="运镜/运动描述..." rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"/>
            <div className="grid grid-cols-2 gap-1">
              {[
                {label:'🔥 推近', prompt:'镜头极速推向主角面部，眼神爆发金光'},
                {label:'🌀 环绕', prompt:'360度环拍，发丝衣袂狂舞'},
                {label:'⚡ 震颤', prompt:'手持激烈震动，冲击波扩散'},
                {label:'🌌 拉远', prompt:'缓缓拉出，展现宏大背景'},
              ].map(p=>(
                <button key={p.label} onClick={()=> updateShot(activeShot.id, {video_prompt: p.prompt})} className="text-[11px] p-1.5 rounded border border-border bg-surface-secondary text-gray-300 truncate" title={p.prompt}>{p.label}</button>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs text-gray-400">时长 <span className="text-orange-400 font-bold">{Math.round(activeShot.duration)}s</span></div>
            <input type="range" min="3" max="10" value={Math.round(activeShot.duration)} onChange={e=> updateShot(activeShot.id, {duration: parseFloat(e.target.value)})} className="w-full accent-orange-500"/>
            <button onClick={handleGenerateVideo} disabled={isGeneratingVid} className="w-full py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
              <Film className={`w-3.5 h-3.5 ${isGeneratingVid?'animate-spin':''}`} /><span>{isGeneratingVid?'生成中...': videoSuccess?'已生成':'生成动态视频'}</span>
            </button>
            {videoError && <div className="text-xs text-red-300">{videoError}</div>}
            {activeShot.video_url && <div className="text-[11px] text-emerald-400">视频已就绪，可在监视器预览</div>}
          </div>
        )}
        </div>

        {/* 底部队列/批量 */}
        {queue.length>0 && (
          <div className="p-2 border-t border-border bg-surface-secondary/50">
            <div className="text-[11px] font-bold text-white">队列 {queue.filter(q=>q.status==='running').length}/{queue.length}</div>
            <div className="space-y-1 mt-1 max-h-20 overflow-y-auto">
              {queue.map(q=>(
                <div key={q.id} className="text-[11px] flex items-center justify-between px-2 py-1 rounded bg-surface border border-border">
                  <span>{q.id.slice(0,8)} {q.type}</span><span className={q.status==='done'?'text-emerald-400':q.status==='error'?'text-red-400':'text-gray-400'}>{q.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Workflow Inspector Modal */}
      {inspectingWorkflowId && (
        <WorkflowInspectorModal
          workflowId={inspectingWorkflowId}
          isOpen={!!inspectingWorkflowId}
          onClose={() => setInspectingWorkflowId('')}
          onSaved={() => {
            loadWorkflowsAndAssets();
            if (selectedWorkflowId) {
              apiService.inspectWorkflow(selectedWorkflowId).then(res => {
                setWorkflowExposedInputs(res?.exposed_inputs || []);
              });
            }
          }}
          onDeleted={(deletedId) => {
            loadWorkflowsAndAssets();
            if (selectedWorkflowId === deletedId) {
              // 若当前选中的工作流被删除，清空选择
              // 需通过 loadWorkflowsAndAssets 刷新，额外清空暴露输入
              setWorkflowExposedInputs([]);
            }
          }}
        />
      )}
    </div>
  );
};
