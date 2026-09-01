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
  UserCheck,
  Users,
  Grid,
  Zap,
  Copy,
  Keyboard,
  Check,
  Wand2,
  FolderOpen,
  Mountain,
  Box
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot, EmotionType } from '../../types';
import { apiService } from '../../services/api';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';
import { ProviderPicker, ProviderParamForm } from '../ui/ProviderPicker';
import { AiPolishButton } from '../ui/AiPolishButton';
import { AssetPickerModal } from '../asset/AssetPickerModal';

const API_ORIGIN = 'http://127.0.0.1:8000';

export const ShotInspector: React.FC = () => {
  const { 
    project, 
    activeShotId, 
    setActiveShotId, 
    updateShot, 
    addShot, 
    duplicateShot,
    deleteShot,
    setActiveTab,
    generateShotVideo,
    bindCharacterToShot,
    unbindCharacterFromShot,
    setCharacterWeight,
    bindSceneToShot,
    unbindSceneFromShot,
    bindPropToShot,
    unbindPropFromShot,
    synthesizeShotPrompt,
    selectCandidate,
    autoFitShotDuration,
    autoFitAllDurations,
  } = useProjectStore();

  const [previewTab, setPreviewTab] = useState<'image' | 'video'>(
    (localStorage.getItem('storyboard_preview_tab') as any) || 'image'
  );
  const [inspectorTab, setInspectorTab] = useState<'dialogue' | 'visual' | 'motion'>(
    (localStorage.getItem('storyboard_inspector_tab') as any) || 'visual'
  );
  const [productionMode, setProductionMode] = useState<'comic' | 'motion_comic' | 'image_to_video'>('image_to_video');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isGeneratingVid, setIsGeneratingVid] = useState(false);
  const [candidateCount, setCandidateCount] = useState<1 | 4>(
    (Number(localStorage.getItem('storyboard_candidate_count')) as 1 | 4) || 4
  );
  const [videoMode, setVideoMode] = useState<'i2v' | 'r2v' | 't2v'>(
    (localStorage.getItem('storyboard_video_mode') as any) || 'i2v'
  );
  const [videoProvider, setVideoProvider] = useState<string>(
    localStorage.getItem('default_video_provider') || 'comfyui_video'
  );
  const [videoProviderDef, setVideoProviderDef] = useState<any>(null);
  const [videoProviderParams, setVideoProviderParams] = useState<Record<string,any>>({});
  const [imageProvider, setImageProvider] = useState<string>(
    localStorage.getItem('default_image_provider') || ''
  );
  const [imageProviderDef, setImageProviderDef] = useState<any>(null);
  const [imageProviderParams, setImageProviderParams] = useState<Record<string,any>>({});
  const [audioProvider, setAudioProvider] = useState<string>(
    localStorage.getItem('default_audio_provider') || 'minimax'
  );
  const [audioProviderDef, setAudioProviderDef] = useState<any>(null);
  const [audioProviderParams, setAudioProviderParams] = useState<Record<string,any>>({});
  const [healthMap, setHealthMap] = useState<Record<string, any>>({});
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<Array<{id:string, type:'image'|'video'|'audio', status:'queued'|'running'|'done'|'error'}>>([]);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoSuccess, setVideoSuccess] = useState(false);
  const [autoFitNotification, setAutoFitNotification] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [showHotkeysHint, setShowHotkeysHint] = useState(true);

  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    localStorage.getItem('default_workflow_id') || ''
  );
  const [workflowExposedInputs, setWorkflowExposedInputs] = useState<any[]>([]);
  const [shotDynamicInputs, setShotDynamicInputs] = useState<Record<string, any>>({});
  const [inspectingWorkflowId, setInspectingWorkflowId] = useState<string>('');
  const [projectAssets, setProjectAssets] = useState<any[]>([]);
  const [uploadingInputKey, setUploadingInputKey] = useState<string | null>(null);

  const [assetPickerConfig, setAssetPickerConfig] = useState<{
    isOpen: boolean;
    title: string;
    category: any;
    onSelect: (asset: any) => void;
  }>({
    isOpen: false,
    title: '从素材库选择素材',
    category: 'all',
    onSelect: () => {},
  });

  const shots: StoryboardShot[] = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

  useEffect(() => {
    if (activeShot?.production_mode) {
      setProductionMode(activeShot.production_mode);
      if (activeShot.production_mode === 'comic') setPreviewTab('image');
      if (activeShot.production_mode === 'motion_comic') setPreviewTab('video');
    }
  }, [activeShot?.id, activeShot?.production_mode]);

  useEffect(() => {
    loadWorkflowsAndAssets();
    const onAssetRefresh = () => loadWorkflowsAndAssets();
    const onAssetApplied = (e: any) => {
      if (e.detail?.shotId === activeShot?.id) loadWorkflowsAndAssets();
    };
    window.addEventListener('asset-refresh', onAssetRefresh as any);
    window.addEventListener('asset-applied', onAssetApplied as any);
    return () => {
      window.removeEventListener('asset-refresh', onAssetRefresh as any);
      window.removeEventListener('asset-applied', onAssetApplied as any);
    };
  }, [activeShot?.id]);

  useEffect(() => {
    loadWorkflowsAndAssets();
  }, [project?.id]);

  const loadWorkflowsAndAssets = async () => {
    try {
      const wfRes = await apiService.listWorkflows('all');
      setWorkflows(wfRes?.workflows || []);
    } catch (_) {}
    try {
      const pid = project?.id || (useProjectStore.getState() as any).activeProjectId || undefined;
      const assetRes = await apiService.listAssets({ project_id: pid, page: 1, limit: 100, scope: undefined });
      setProjectAssets(assetRes?.assets || []);
    } catch (_) {}
  };

  useEffect(()=>{
    if(!activeShot) return;
    const s:any = activeShot;
    const mode = s.production_mode || (project?.id ? localStorage.getItem(`storyboard_mode_${project.id}`) : null) || 'image_to_video';
    setProductionMode(mode as any);
    if(s.image_provider !== undefined) setImageProvider(s.image_provider || localStorage.getItem('default_image_provider') || '');
    if(s.video_provider !== undefined) setVideoProvider(s.video_provider || localStorage.getItem('default_video_provider') || 'comfyui_video');
    if(s.audio_provider !== undefined) setAudioProvider(s.audio_provider || localStorage.getItem('default_audio_provider') || 'minimax');
    if(s.workflow_id !== undefined) setSelectedWorkflowId(s.workflow_id || localStorage.getItem('default_workflow_id') || '');
    if(s.dynamic_inputs) setShotDynamicInputs(s.dynamic_inputs || {});
    if(s.provider_params?.image) setImageProviderParams(s.provider_params.image);
    if(s.provider_params?.video) setVideoProviderParams(s.provider_params.video);
    if(s.provider_params?.audio) setAudioProviderParams(s.provider_params.audio);
  }, [activeShot?.id, project?.id]);

  const probeProvider = async (pid: string) => {
    if(!pid) return;
    try {
      const res = await apiService.testProvider(pid);
      setHealthMap(prev => ({ ...prev, [pid]: { ok: res.status==='ok', detail: res.detail } }));
    } catch(e:any) {
      setHealthMap(prev => ({ ...prev, [pid]: { ok: false, detail: e.message } }));
    }
  };

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const tag = (activeEl?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (activeEl as any)?.isContentEditable) {
        return;
      }
      
      const shotList = project?.scenes.flatMap(s => s.shots) || [];
      const currentIdx = shotList.findIndex(s => s.id === activeShot?.id);

      if (e.code === 'Space') {
        e.preventDefault();
        const store = useProjectStore.getState();
        store.setIsPlaying(!store.isPlaying);
        return;
      }

      if (e.code === 'KeyA' || e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
        e.preventDefault();
        if (currentIdx > 0) {
          setActiveShotId(shotList[currentIdx - 1].id);
        }
        return;
      }

      if (e.code === 'KeyD' || e.code === 'ArrowRight' || e.code === 'ArrowDown') {
        e.preventDefault();
        if (currentIdx >= 0 && currentIdx < shotList.length - 1) {
          setActiveShotId(shotList[currentIdx + 1].id);
        }
        return;
      }

      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleRegenerateImage();
        return;
      }

      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleGenerateVideo();
        return;
      }

      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handlePlayTTS();
        return;
      }

      if (['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) {
        const cIdx = parseInt(e.code.replace('Digit', '')) - 1;
        if (activeShot?.candidates && activeShot.candidates[cIdx]) {
          e.preventDefault();
          selectCandidate(activeShot.id, cIdx);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
        e.preventDefault();
        if (activeShot) duplicateShot(activeShot.id);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeShot?.id, project?.scenes, isPlayingAudio, isRegenerating, isGeneratingVid, candidateCount]);

  if (!activeShot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm space-y-2 p-8">
        <span>请选择或添加分镜</span>
        {project && <button onClick={() => addShot(1)} className="px-3 py-1 rounded bg-brand text-white text-xs">新建分镜</button>}
      </div>
    );
  }

  const handlePlayTTS = async () => {
    const textToSpeak = activeShot.dialogue || activeShot.voiceover || '';
    if (!textToSpeak.trim()) { setTtsError('当前分镜无台词/旁白，无法配音'); return; }
    if (audioEl) { audioEl.pause(); setAudioEl(null); setIsPlayingAudio(false); }
    setTtsError(null);
    setIsPlayingAudio(true);
    updateShot(activeShot.id, { status: 'generating_audio', render_status: 'rendering' });
    try {
      const char = project?.characters.find((c) => c.name === activeShot.speaker_name);
      const voiceId = char?.voice_id || 'male-qn-qingse';
      const extraParams: any = { ...audioProviderParams };
      const res = await apiService.generateTTS(textToSpeak, voiceId, activeShot.emotion, { provider: audioProvider || undefined, ...extraParams });
      const url = res.audio_url?.startsWith('/') ? API_ORIGIN + res.audio_url : res.audio_url;
      if (!res.audio_url) throw new Error('TTS 未返回音频地址');
      
      const audioSec = res.duration || (res.audio_duration ? res.audio_duration : 3.5);
      const fittedSec = Math.max(1.5, Math.round((audioSec + 0.4) * 10) / 10);

      updateShot(activeShot.id, { 
        audio_url: res.audio_url, 
        audio_duration: audioSec,
        duration: fittedSec, 
        status: 'completed',
        render_status: 'done' 
      });

      setAutoFitNotification(`🎯 镜头时长已智能对齐为 ${fittedSec}s（配音 ${audioSec.toFixed(1)}s + 0.4s 留白）`);
      setTimeout(() => setAutoFitNotification(null), 4000);

      const a = new Audio(url);
      setAudioEl(a);
      a.onended = () => { setIsPlayingAudio(false); setAudioEl(null); };
      a.onerror = () => { setTtsError('音频播放失败，请检查后端存储'); setIsPlayingAudio(false); };
      await a.play();
    } catch (e: any) {
      setTtsError(e?.message || '配音生成失败');
      updateShot(activeShot.id, { status: 'error', render_status: 'error' });
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

  const handleRegenerateImage = async (customCount?: number) => {
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(activeShot.id, { status: 'generating_image', render_status: 'rendering' });

    let promptWithCharacters = activeShot.image_prompt;
    const boundCharIds = activeShot.character_ids || [];
    const boundChars = (project?.characters || []).filter(c => boundCharIds.includes(c.id));
    
    if (boundChars.length > 0) {
      const charTags = boundChars.map(c => `[角色: ${c.name}, ${c.visual_prompt || c.description}]`).join(' ');
      if (!promptWithCharacters.includes(boundChars[0].name)) {
        promptWithCharacters = `${charTags} ${promptWithCharacters}`;
      }
    }

    try {
      const isCustomImageProvider = !!imageProvider && (imageProvider.startsWith('prov_') || (imageProviderDef as any)?.provider_type === 'http');
      const isHttpImageProvider = isCustomImageProvider || (!!imageProvider && !['comfyui',''].includes(imageProvider));
      const useImageWorkflow = !!selectedWorkflowId && !isHttpImageProvider;
      
      let dynamic_inputs: Record<string,any> | undefined = undefined;
      if (useImageWorkflow) {
        dynamic_inputs = Object.keys(shotDynamicInputs).length ? { ...shotDynamicInputs } : undefined;
        const exposedKeys = new Set(Object.keys(shotDynamicInputs));
        const filtered: Record<string,any> = {};
        Object.entries(imageProviderParams).forEach(([k,v])=>{
          if(v!=='' && v!==null && v!==undefined && exposedKeys.has(k)) filtered[k]=v;
        });
        if(Object.keys(filtered).length) dynamic_inputs = { ...(dynamic_inputs||{}), ...filtered };
      } else {
        const merged: Record<string,any> = {};
        Object.entries(imageProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) merged[k]=v; });
        dynamic_inputs = Object.keys(merged).length ? merged : undefined;
      }

      if (boundChars.length > 0) {
        const primaryChar = boundChars[0];
        const charRef = primaryChar.three_views?.front || primaryChar.avatar_url || primaryChar.three_views?.three_quarter;
        if (charRef) {
          dynamic_inputs = {
            ...(dynamic_inputs || {}),
            reference_image: (dynamic_inputs as any)?.reference_image || charRef,
            character_weight: activeShot.character_weights?.[primaryChar.id] || 0.8,
          };
        }
      }

      const count = customCount || candidateCount;
      if (count === 4) {
        const seeds = [Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000)];
        const reqs = seeds.map(s => apiService.generateShotImage({
          prompt: promptWithCharacters,
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: useImageWorkflow ? selectedWorkflowId : undefined,
          provider: imageProvider || undefined,
          model: imageProviderDef?.default_model || undefined,
          dynamic_inputs: { ...(dynamic_inputs || {}), seed: s },
        }));
        
        const results = await Promise.allSettled(reqs);
        const successfulUrls = results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && !!r.value?.image_url)
          .map(r => r.value.image_url);
        
        if (successfulUrls.length === 0) {
          const firstErr = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
          throw new Error(firstErr?.reason?.message || '4 候选图生成全部失败');
        }
        
        updateShot(activeShot.id, {
          image_url: successfulUrls[0],
          candidates: successfulUrls,
          selected_candidate_index: 0,
          status: 'completed',
          render_status: 'done',
        });
      } else {
        const res = await apiService.generateShotImage({
          prompt: promptWithCharacters,
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: useImageWorkflow ? selectedWorkflowId : undefined,
          provider: imageProvider || undefined,
          model: imageProviderDef?.default_model || undefined,
          dynamic_inputs,
        });
        const currentCandidates = activeShot.candidates ? [res.image_url, ...activeShot.candidates.filter(u => u !== res.image_url)].slice(0, 4) : [res.image_url];
        updateShot(activeShot.id, { 
          image_url: res.image_url, 
          candidates: currentCandidates,
          selected_candidate_index: 0,
          status: 'completed',
          render_status: 'done' 
        });
      }
      setPreviewTab('image');
    } catch (e: any) {
      const msg = e?.message || '生图失败';
      if(msg.includes('未定义的参数') && selectedWorkflowId){
        setRegenError('工作流不支持部分生成源参数，已自动忽略。');
      } else {
        setRegenError(msg);
      }
      updateShot(activeShot.id, { status: 'error', render_status: 'error', render_error: msg });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleGenerateVideo = async () => {
    const prompt = activeShot.video_prompt?.trim() || activeShot.action_desc || activeShot.image_prompt;
    if (!prompt) {
      setVideoError('请填写视频运动运镜提示词');
      return;
    }
    
    // 获取参考图：图生视频使用首帧，漫剧直出模式优先使用分镜图或绑定角色的立绘/三视图
    let refImage = activeShot.image_url;
    if (productionMode === 'motion_comic' && !refImage) {
      const boundChar = (project?.characters || []).find(c => (activeShot.character_ids || []).includes(c.id));
      if (boundChar) {
        refImage = boundChar.three_views?.front || boundChar.avatar_url || boundChar.three_views?.three_quarter;
      }
    }

    if (productionMode === 'image_to_video' && !activeShot.image_url) {
      setVideoError('图生视频模式需要先在步骤 1 生成精控首帧画面');
      return;
    }

    setVideoError(null);
    setIsGeneratingVid(true);
    updateShot(activeShot.id, { status: 'generating_video', render_status: 'rendering' });
    try {
      const isCustomVideoProvider = !!videoProvider && (videoProvider.startsWith('prov_') || (videoProviderDef as any)?.provider_type === 'http');
      const isHttpVideoProvider = isCustomVideoProvider || (!!videoProvider && !['comfyui_video',''].includes(videoProvider));
      const useVideoWorkflow = !!selectedWorkflowId && !isHttpVideoProvider;
      let dynamic_inputs: Record<string,any> | undefined = undefined;
      if (useVideoWorkflow) {
        dynamic_inputs = Object.keys(shotDynamicInputs).length ? { ...shotDynamicInputs } : undefined;
        if (refImage && !dynamic_inputs?.reference_image) {
          dynamic_inputs = { ...(dynamic_inputs || {}), reference_image: refImage };
        }
        const exposedKeys = new Set(Object.keys(shotDynamicInputs));
        const filtered: Record<string,any> = {};
        Object.entries(videoProviderParams).forEach(([k,v])=>{
          if(v!=='' && v!==null && v!==undefined && exposedKeys.has(k)) filtered[k]=v;
        });
        if(Object.keys(filtered).length) dynamic_inputs = { ...(dynamic_inputs||{}), ...filtered };
      } else {
        const merged: Record<string,any> = {};
        if (refImage) merged.first_frame_url = refImage;
        Object.entries(videoProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) merged[k]=v; });
        dynamic_inputs = Object.keys(merged).length ? merged : undefined;
      }
      await generateShotVideo(activeShot.id, {
        mode: productionMode === 'motion_comic' ? (refImage ? 'r2v' : 't2v') : 'i2v',
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
      setVideoError(msg);
      updateShot(activeShot.id, { status: 'error', render_status: 'error' });
    } finally {
      setIsGeneratingVid(false);
    }
  };

  const handleBatchAllImages = async () => {
    const targetShots = batchSelected.size > 0 ? shots.filter(s => batchSelected.has(s.id)) : shots;
    if (targetShots.length === 0) return;
    const ids = targetShots.map(s => s.id);
    const jobs = ids.map(id => ({ id, type: 'image' as const, status: 'queued' as const }));
    setQueue(q => [...q, ...jobs]);
    for (const sh of targetShots) {
      setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'running' } : j));
      updateShot(sh.id, { status: 'generating_image', render_status: 'rendering' });
      try {
        const prov = (sh as any).image_provider || imageProvider || undefined;
        const res = await apiService.generateShotImage({
          prompt: sh.image_prompt,
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: (sh as any).workflow_id || selectedWorkflowId || undefined,
          provider: prov || undefined,
        });
        updateShot(sh.id, { image_url: res.image_url, candidates: [res.image_url], status: 'completed', render_status: 'done' });
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'done' } : j));
      } catch {
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'error' } : j));
        updateShot(sh.id, { status: 'error', render_status: 'error' });
      }
    }
    setTimeout(() => setQueue(q => q.filter(j => !ids.includes(j.id))), 4000);
  };

  const handleBatchAllTTS = async () => {
    const targetShots = batchSelected.size > 0 ? shots.filter(s => batchSelected.has(s.id)) : shots.filter(s => (s.dialogue || s.voiceover));
    if (targetShots.length === 0) { alert('没有需要配音的分镜（台词为空）'); return; }
    const ids = targetShots.map(s => s.id);
    const jobs = ids.map(id => ({ id, type: 'audio' as const, status: 'queued' as const }));
    setQueue(q => [...q, ...jobs]);
    for (const sh of targetShots) {
      setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'running' } : j));
      updateShot(sh.id, { status: 'generating_audio', render_status: 'rendering' });
      try {
        const text = sh.dialogue || sh.voiceover || '';
        const char = project?.characters.find(c => c.name === sh.speaker_name);
        const voiceId = char?.voice_id || 'male-qn-qingse';
        const res = await apiService.generateTTS(text, voiceId, sh.emotion, { provider: (sh as any).audio_provider || audioProvider || undefined });
        const audioSec = res.duration || 3.5;
        const fittedSec = Math.max(1.5, Math.round((audioSec + 0.4) * 10) / 10);
        updateShot(sh.id, {
          audio_url: res.audio_url,
          audio_duration: audioSec,
          duration: fittedSec,
          status: 'completed',
          render_status: 'done',
        });
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'done' } : j));
      } catch {
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'error' } : j));
        updateShot(sh.id, { status: 'error', render_status: 'error' });
      }
    }
    setTimeout(() => setQueue(q => q.filter(j => !ids.includes(j.id))), 4000);
  };

  const handleBatchAllVideos = async () => {
    const targetShots = batchSelected.size > 0 ? shots.filter(s => batchSelected.has(s.id)) : shots.filter(s => s.image_url);
    if (targetShots.length === 0) { alert('没有可转视频的分镜（请先生成首帧图片）'); return; }
    const ids = targetShots.map(s => s.id);
    const jobs = ids.map(id => ({ id, type: 'video' as const, status: 'queued' as const }));
    setQueue(q => [...q, ...jobs]);
    for (const sh of targetShots) {
      setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'running' } : j));
      try {
        const prov = (sh as any).video_provider || videoProvider;
        await generateShotVideo(sh.id, { 
          mode: videoMode, 
          prompt: sh.video_prompt || sh.action_desc || sh.image_prompt, 
          duration: Math.round(sh.duration) || 5, 
          provider: prov, 
          workflow_id: (sh as any).workflow_id || selectedWorkflowId || undefined, 
          dynamic_inputs: (sh as any).dynamic_inputs || shotDynamicInputs 
        });
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'done' } : j));
      } catch {
        setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'error' } : j));
      }
    }
    setTimeout(() => setQueue(q => q.filter(j => !ids.includes(j.id))), 4000);
  };

  const handleSaveShotToAsset = async (kind: 'image'|'video') => {
    const url = kind==='image' ? activeShot.image_url : activeShot.video_url;
    if (!url) { alert(kind==='image' ? '暂无首帧可保存' : '暂无视频可保存'); return; }
    if (!project) { alert('请先打开项目'); return; }
    setSavingAsset(true);
    try {
      const fd = new FormData();
      const safeName = `${project.title}-镜头${activeShot.shot_index}-${kind}`;
      fd.append('name', safeName);
      fd.append('category', kind==='image' ? 'scene' : 'other');
      fd.append('description', activeShot.action_desc || activeShot.image_prompt || '');
      fd.append('visual_prompt', activeShot.image_prompt || activeShot.action_desc || safeName);
      fd.append('file_url', url);
      fd.append('scope', 'project');
      fd.append('project_id', project.id);
      fd.append('tags', kind);
      await apiService.createAsset(fd);
      try { window.dispatchEvent(new CustomEvent('asset-refresh')); } catch {}
      alert(`已保存到素材库（项目）`);
    } catch (e:any) { alert(e.message || '保存失败'); } finally { setSavingAsset(false); }
  };

  const [savingAsset, setSavingAsset] = useState(false);

  const getMediaUrl = (url?: string | null) => {
    if (!url) return '';
    return url.startsWith('/') ? API_ORIGIN + url : url;
  };

  return (
    <div className="flex-1 flex gap-3 p-3 overflow-hidden bg-background relative">
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
          <button onClick={handleBatchAllImages} className="flex-1 py-1 rounded-lg bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light font-bold flex items-center justify-center gap-1 transition-all" title="对所有选中/全部镜头批量并发生成画面">
            <Sparkles className="w-3 h-3 text-brand" /> 批量生图
          </button>
          <button onClick={handleBatchAllTTS} className="flex-1 py-1 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量合成全剧台词配音">
            <Volume2 className="w-3 h-3 text-pink-400" /> 批量配音
          </button>
          <button onClick={handleBatchAllVideos} className="flex-1 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量转为动态视频">
            <Film className="w-3 h-3 text-orange-400" /> 批量视频
          </button>
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

      <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6 bg-surface border border-border rounded-2xl overflow-hidden relative">
        {/* 三大制作模式顶栏 */}
        <div className="mb-3 z-10 w-full max-w-md bg-surface-secondary/90 backdrop-blur border border-border p-1 rounded-2xl flex items-center gap-1 shadow-sm">
          {[
            { id: 'comic', label: '🎨 漫画制作', desc: '纯生图流 · 1/4抽定版' },
            { id: 'motion_comic', label: '🎬 漫剧制作', desc: '角色立绘直出视频' },
            { id: 'image_to_video', label: '⚡ 图生视频', desc: '首帧精控+I2V演化' },
          ].map((m) => {
            const isActive = productionMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => {
                  setProductionMode(m.id as any);
                  if (project?.id) localStorage.setItem(`storyboard_mode_${project.id}`, m.id);
                  updateShot(activeShot.id, { production_mode: m.id as any });
                  if (m.id === 'comic') {
                    setPreviewTab('image');
                    localStorage.setItem('storyboard_preview_tab', 'image');
                  }
                  if (m.id === 'motion_comic') {
                    setPreviewTab('video');
                    localStorage.setItem('storyboard_preview_tab', 'video');
                  }
                }}
                className={`flex-1 py-1.5 px-2 rounded-xl text-xs font-bold flex flex-col items-center gap-0.5 transition-all ${
                  isActive
                    ? 'bg-brand text-white shadow-md'
                    : 'text-gray-400 hover:text-white hover:bg-surface-tertiary'
                }`}
              >
                <span className="truncate">{m.label}</span>
                <span className={`text-[9px] font-normal truncate ${isActive ? 'text-white/80' : 'text-gray-500'}`}>{m.desc}</span>
              </button>
            );
          })}
        </div>

        {/* 模式状态与快捷控制 */}
        <div className="mb-2 z-10 flex items-center justify-between w-full max-w-md">
          {productionMode === 'comic' && (
            <div className="flex items-center justify-between w-full">
              <span className="text-[11px] font-bold text-violet-400 flex items-center gap-1">
                <ImageIcon className="w-3.5 h-3.5" /> 纯漫画生图模式 (专注出图与分镜画卡)
              </span>
              <div className="flex items-center gap-1 bg-surface-secondary border border-border rounded-full p-0.5 text-[11px]">
                <button onClick={()=> { setCandidateCount(1); localStorage.setItem('storyboard_candidate_count', '1'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all ${candidateCount===1 ? 'bg-surface-tertiary text-white shadow' : 'text-gray-400 hover:text-white'}`}>单张</button>
                <button onClick={()=> { setCandidateCount(4); localStorage.setItem('storyboard_candidate_count', '4'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 ${candidateCount===4 ? 'bg-brand text-white shadow' : 'text-gray-400 hover:text-white'}`}>
                  <Grid className="w-3 h-3"/> 4抽 ⚡
                </button>
              </div>
            </div>
          )}

          {productionMode === 'motion_comic' && (
            <div className="flex items-center justify-between w-full">
              <span className="text-[11px] font-bold text-orange-400 flex items-center gap-1">
                <Film className="w-3.5 h-3.5" /> 漫剧角色直出流 (绑定立绘直接生成动态视频)
              </span>
              <span className="text-[10px] text-gray-400 font-mono">
                {activeShot.camera_motion || 'push_in'}
              </span>
            </div>
          )}

          {productionMode === 'image_to_video' && (
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center p-0.5 rounded-full bg-surface-secondary border border-border shadow-sm">
                <button onClick={() => { setPreviewTab('image'); localStorage.setItem('storyboard_preview_tab', 'image'); }} className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold transition-all ${previewTab === 'image' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>
                  <ImageIcon className="w-3 h-3" /><span>1. 首帧定版</span>
                </button>
                <button onClick={() => { setPreviewTab('video'); localStorage.setItem('storyboard_preview_tab', 'video'); }} className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold transition-all ${previewTab === 'video' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}>
                  <Film className="w-3 h-3" /><span>2. I2V 视频</span>{activeShot.video_url && <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />}
                </button>
              </div>
              <div className="flex items-center gap-1 bg-surface-secondary border border-border rounded-full p-0.5 text-[11px]">
                <button onClick={()=> { setCandidateCount(1); localStorage.setItem('storyboard_candidate_count', '1'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all ${candidateCount===1 ? 'bg-surface-tertiary text-white shadow' : 'text-gray-400 hover:text-white'}`}>单张</button>
                <button onClick={()=> { setCandidateCount(4); localStorage.setItem('storyboard_candidate_count', '4'); }} className={`px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 ${candidateCount===4 ? 'bg-brand text-white shadow' : 'text-gray-400 hover:text-white'}`}>
                  <Grid className="w-3 h-3"/> 4抽
                </button>
              </div>
            </div>
          )}
        </div>

        {autoFitNotification && (
          <div className="mb-2 px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-300 font-bold max-w-md flex items-center gap-1.5 animate-fade-in">
            <Check className="w-3.5 h-3.5 text-emerald-400" /> {autoFitNotification}
          </div>
        )}

        {regenError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {regenError}</div>}
        {videoError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {videoError}</div>}
        {ttsError && <div className="mb-2 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300 max-w-md truncate">⚠️ {ttsError}</div>}

        <div className="relative max-h-[60vh] aspect-[9/16] rounded-2xl overflow-hidden shadow-2xl border border-border/80 group bg-black">
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
              <div className="w-full h-full min-h-[45vh] min-w-[26vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-6 text-center">
                <Film className="w-10 h-10 text-accent-orange/60" />
                <span className="font-semibold text-white">当前分镜尚未生成动态视频</span>
                <button
                  onClick={handleGenerateVideo}
                  disabled={isGeneratingVid}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-accent-orange to-brand-glow text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40"
                >
                  {isGeneratingVid ? '视频生成中...' : (productionMode === 'motion_comic' ? '🎬 角色立绘直出视频' : '立即生成动态视频')}
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
            <div className="w-full h-full min-h-[45vh] min-w-[26vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-4 text-center">
              <span>{activeShot.status === 'generating_image' ? '⚡ 画面生成中，请稍候...' : '该分镜暂无画面'}</span>
              <button onClick={() => handleRegenerateImage()} disabled={isRegenerating} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold shadow-lg hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> 立即生成画面 {candidateCount===4 ? '(4抽⚡)' : ''}
              </button>
            </div>
          )}

          <div className="absolute top-3 left-3 flex items-center space-x-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10 pointer-events-none">
            <span className="text-[11px] font-bold text-white font-mono">镜头 #{activeShot.shot_index}</span>
            <span className="text-[10px] px-1.5 rounded bg-brand/30 text-brand-light border border-brand/40">
              {activeShot.camera_framing}
            </span>
            <span className="text-[10px] px-1.5 rounded bg-accent-orange/20 text-accent-orange border border-accent-orange/40">
              {activeShot.camera_motion}
            </span>
          </div>

          {activeShot.subtitle_text && (
            <div className="absolute bottom-6 left-4 right-4 bg-black/75 backdrop-blur-md p-3 rounded-xl border border-white/15 text-center shadow-lg animate-fade-in pointer-events-none">
              <span className="text-xs font-bold text-white tracking-wide">
                {activeShot.subtitle_text}
              </span>
            </div>
          )}

          <div className="absolute top-3 right-3 flex flex-col space-y-2">
            <button
              onClick={() => setActiveTab('director3d')}
              className="p-2 rounded-xl bg-black/70 hover:bg-accent-orange text-white backdrop-blur-md border border-white/10 transition-all shadow-md"
              title="进入 3D 导演台规划姿态与机位"
            >
              <Compass className="w-4 h-4 text-accent-orange hover:text-white" />
            </button>

            <button
              onClick={() => handleRegenerateImage()}
              disabled={isRegenerating}
              className="p-2 rounded-xl bg-black/70 hover:bg-brand text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
              title={`重新生成画面 (按 R) ${candidateCount===4 ? '- 4抽模式' : ''}`}
            >
              <RefreshCw className={`w-4 h-4 text-brand-light ${isRegenerating ? 'animate-spin' : ''}`} />
            </button>
            {activeShot.image_url && (
              <button
                onClick={()=> handleSaveShotToAsset('image')}
                disabled={savingAsset}
                className="p-2 rounded-xl bg-black/70 hover:bg-emerald-600 text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
                title="保存首帧到素材库（项目）"
              >
                <ImageIcon className="w-4 h-4" />
              </button>
            )}
            {activeShot.video_url && previewTab==='video' && (
              <button
                onClick={()=> handleSaveShotToAsset('video')}
                disabled={savingAsset}
                className="p-2 rounded-xl bg-black/70 hover:bg-emerald-600 text-white backdrop-blur-md border border-white/10 transition-all shadow-md disabled:opacity-40"
                title="保存视频到素材库（项目）"
              >
                <Film className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* 候选切选区 */}
        {activeShot.candidates && activeShot.candidates.length > 1 && (
          <div className="mt-2.5 w-full max-w-md bg-surface-secondary/70 border border-border p-2 rounded-2xl flex items-center justify-between gap-2 animate-fade-in shadow-inner">
            <div className="text-[11px] font-bold text-gray-300 flex items-center gap-1 shrink-0 px-1">
              <Grid className="w-3.5 h-3.5 text-brand" />
              <span>候选定版:</span>
            </div>
            <div className="flex items-center gap-2 flex-1 justify-end">
              {activeShot.candidates.map((cUrl, idx) => {
                const isChosen = activeShot.image_url === cUrl;
                return (
                  <button
                    key={idx}
                    onClick={() => selectCandidate(activeShot.id, idx)}
                    className={`relative w-11 h-11 rounded-xl overflow-hidden border transition-all ${
                      isChosen ? 'border-brand ring-2 ring-brand shadow-lg scale-105' : 'border-border opacity-60 hover:opacity-100'
                    }`}
                    title={`选定第 ${idx + 1} 张作为正片定版 (快捷键 ${idx + 1})`}
                  >
                    <img src={getMediaUrl(cUrl)} alt="" className="w-full h-full object-cover" />
                    <span className={`absolute top-0.5 left-0.5 px-1 rounded text-[8px] font-mono font-bold ${isChosen ? 'bg-brand text-white' : 'bg-black/70 text-gray-300'}`}>
                      {idx + 1}
                    </span>
                    {isChosen && (
                      <span className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-brand text-white flex items-center justify-center">
                        <Check className="w-2 h-2" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 底部三大模式专属操作动作栏 */}
        <div className="mt-3 w-full max-w-md">
          {productionMode === 'comic' && (
            <button
              onClick={() => handleRegenerateImage()}
              disabled={isRegenerating}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-brand text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>✨ 生成漫画画面 {candidateCount===4 ? '(4抽比选⚡)' : ''}</span>
            </button>
          )}

          {productionMode === 'motion_comic' && (
            <button
              onClick={handleGenerateVideo}
              disabled={isGeneratingVid}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-accent-orange to-brand text-white text-xs font-bold shadow-lg hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
            >
              <Film className="w-3.5 h-3.5" />
              <span>🎬 绑定角色立绘直出动态视频 (Direct Video)</span>
            </button>
          )}

          {productionMode === 'image_to_video' && (
            <div className="flex items-center gap-2 w-full">
              <button
                onClick={() => handleRegenerateImage()}
                disabled={isRegenerating}
                className="flex-1 py-2 rounded-xl bg-brand text-white text-xs font-bold shadow hover:bg-brand-light disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
              >
                <Sparkles className="w-3 h-3" />
                <span>1. 生成精控首帧 {candidateCount===4 ? '(4抽⚡)' : ''}</span>
              </button>
              <button
                onClick={handleGenerateVideo}
                disabled={isGeneratingVid || !activeShot.image_url}
                className="flex-1 py-2 rounded-xl bg-gradient-to-r from-accent-orange to-pink-500 text-white text-xs font-bold shadow hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-all"
                title={!activeShot.image_url ? '请先完成步骤1生成首帧画面' : '将已选定首帧转化为动态视频'}
              >
                <Film className="w-3 h-3" />
                <span>2. 转化为I2V视频</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="w-[380px] bg-surface border border-border rounded-2xl flex flex-col overflow-hidden shrink-0 shadow-sm">
        <div className="h-11 px-3 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
          <div className="flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-brand" />
            <span className="text-xs font-bold text-white">
              {productionMode === 'comic' ? '漫画分镜参数' : productionMode === 'motion_comic' ? '漫剧直出参数' : '图生视频参数'}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface border border-border text-gray-400 font-mono">#{activeShot.shot_index}</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => duplicateShot(activeShot.id)} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand" title="复制此分镜 (Ctrl+D)"><Copy className="w-3.5 h-3.5"/></button>
            <button onClick={()=> {
              try{
                const payload = { shot: activeShot, projectId: project?.id };
                localStorage.setItem('canvas_pending_shot', JSON.stringify(payload));
                setActiveTab('canvas' as any);
                if(typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('canvas-import-shot', {detail: payload}));
              }catch{}
            }} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand" title="发送到无限画布"><Layers className="w-3.5 h-3.5"/></button>
            <button onClick={() => deleteShot(activeShot.id)} className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10" title="删除此分镜"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1.5 bg-surface-secondary/50 border-b border-border shrink-0">
          {[
            {id:'visual', label: productionMode === 'comic' ? '漫画画面与角色' : productionMode === 'motion_comic' ? '角色与运镜' : '首帧画面与角色', icon:'🎬', color:'text-violet-400'},
            {id:'dialogue', label: productionMode === 'comic' ? '气泡与对白' : '台词与配音', icon:'🗣️', color:'text-pink-400'},
            ...(productionMode !== 'comic' ? [{id:'motion', label:'运镜动态', icon:'🎥', color:'text-orange-400'}] : []),
          ].map(t=>(
            <button key={t.id} onClick={()=> { setInspectorTab(t.id as any); localStorage.setItem('storyboard_inspector_tab', t.id); }} className={`flex-1 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1 transition-all ${inspectorTab===t.id ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}>
              <span>{t.icon}</span><span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
          {inspectorTab==='visual' && (
            <div className="space-y-3.5">
              {/* 1. 出场角色锚定 (Character Anchor) */}
              <div className="p-3 rounded-2xl bg-brand/5 border border-brand/20 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-brand-light flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-brand" /> 出场角色锚定 (Character Anchor)
                  </span>
                  <span className="text-[10px] text-gray-400">自动同步立绘、三视图与专属音色</span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {(project?.characters || []).map((char) => {
                    const isBound = (activeShot.character_ids || []).includes(char.id);
                    const weight = activeShot.character_weights?.[char.id] ?? 0.8;
                    const charAvatar = char.three_views?.front || char.avatar_url || char.three_views?.three_quarter;

                    return (
                      <div
                        key={char.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-all text-xs ${
                          isBound
                            ? 'bg-brand text-white border-brand shadow-md'
                            : 'bg-surface-secondary border-border text-gray-300 hover:border-brand/40 hover:text-white'
                        }`}
                      >
                        <button
                          onClick={() => {
                            if (isBound) {
                              unbindCharacterFromShot(activeShot.id, char.id);
                            } else {
                              bindCharacterToShot(activeShot.id, char.id);
                              // 自动关联讲述人与 TTS 专属音色
                              updateShot(activeShot.id, {
                                speaker_id: char.id,
                                speaker_name: char.name,
                              });
                              if (char.voice_id) {
                                setAudioProviderParams(p => ({ ...p, voice_id: char.voice_id }));
                              }
                            }
                          }}
                          className="flex items-center gap-1.5 font-semibold"
                        >
                          {charAvatar ? (
                            <img src={getMediaUrl(charAvatar)} alt="" className="w-4 h-4 rounded-full object-cover border border-white/20" />
                          ) : (
                            <UserCheck className="w-3 h-3 text-brand-light" />
                          )}
                          <span>{char.name}</span>
                        </button>

                        {isBound && (
                          <div className="flex items-center gap-1 pl-1 border-l border-white/20 text-[10px] font-mono">
                            <span title="参考图强度">{(weight * 100).toFixed(0)}%</span>
                            <button
                              onClick={() => unbindCharacterFromShot(activeShot.id, char.id)}
                              className="w-3.5 h-3.5 rounded-full hover:bg-black/30 flex items-center justify-center text-white/80"
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(!project?.characters || project.characters.length === 0) && (
                    <div className="text-[11px] text-gray-500 py-1">当前项目无角色，可在顶部「角色」频道创建主角与三视图</div>
                  )}
                </div>

                {(activeShot.character_ids || []).length > 0 && (() => {
                  const boundChar = (project?.characters || []).find(c => (activeShot.character_ids || []).includes(c.id));
                  if (!boundChar) return null;
                  const currentRef = (activeShot as any).reference_image || boundChar.three_views?.front || boundChar.avatar_url || boundChar.three_views?.three_quarter;

                  return (
                    <div className="pt-2 border-t border-brand/15 space-y-2 text-[11px]">
                      {/* 参考图片预览与视角切换 */}
                      <div className="flex items-center justify-between bg-black/40 p-2 rounded-xl border border-brand/20">
                        <div 
                          onClick={() => {
                            setAssetPickerConfig({
                              isOpen: true,
                              title: `为分镜选择参考图 / 垫图（角色: ${boundChar.name}）`,
                              category: 'character',
                              onSelect: (asset) => {
                                setShotDynamicInputs(p => ({ ...p, reference_image: asset.url }));
                                updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: asset.url } } as any);
                              }
                            });
                          }}
                          className="flex items-center gap-2 cursor-pointer group"
                          title="点击从素材库更换参考垫图"
                        >
                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/60 border border-border shrink-0 relative group-hover:border-brand transition-all">
                            {currentRef ? (
                              <img src={getMediaUrl(currentRef)} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">无图</div>
                            )}
                            <div className="absolute inset-0 bg-brand/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                              <FolderOpen className="w-3.5 h-3.5 text-white" />
                            </div>
                          </div>
                          <div>
                            <div className="font-bold text-white flex items-center gap-1 group-hover:text-brand-light transition-colors">
                              <span>已绑定参考图:</span>
                              <span className="text-brand-light font-mono">{boundChar.name}</span>
                            </div>
                            <div className="text-[10px] text-emerald-400">
                              {currentRef ? '✓ IP-Adapter 垫图已就绪' : '⚠️ 点击从素材库选择'}
                            </div>
                          </div>
                        </div>

                        {/* 视角切换与素材库选取按钮 */}
                        <div className="flex items-center gap-1">
                          {boundChar.three_views?.front && (
                            <button
                              onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.front } } as any)}
                              className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                              title="使用正面图"
                            >
                              正面
                            </button>
                          )}
                          {boundChar.three_views?.side && (
                            <button
                              onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.side } } as any)}
                              className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                              title="使用侧面图"
                            >
                              侧面
                            </button>
                          )}
                          {boundChar.three_views?.three_quarter && (
                            <button
                              onClick={() => updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: boundChar.three_views?.three_quarter } } as any)}
                              className="px-1.5 py-0.5 rounded bg-surface-secondary hover:bg-brand/30 border border-border text-[9px] text-gray-300"
                              title="使用 3/4 动态图"
                            >
                              3/4
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setAssetPickerConfig({
                                isOpen: true,
                                title: `从素材库选择垫图 / 参考图`,
                                category: 'character',
                                onSelect: (asset) => {
                                  setShotDynamicInputs(p => ({ ...p, reference_image: asset.url }));
                                  updateShot(activeShot.id, { dynamic_inputs: { ...shotDynamicInputs, reference_image: asset.url } } as any);
                                }
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light text-[10px] font-bold flex items-center gap-1 transition-all"
                            title="从素材库选择任意图片作为垫图"
                          >
                            <FolderOpen className="w-3 h-3" />
                            <span>素材库</span>
                          </button>
                        </div>
                      </div>

                      {/* 权重滑块 */}
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-gray-300">垫图权重:</span>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min="0.2"
                            max="1.0"
                            step="0.05"
                            value={activeShot.character_weights?.[boundChar.id] || 0.8}
                            onChange={(e) => setCharacterWeight(activeShot.id, boundChar.id, parseFloat(e.target.value))}
                            className="w-24 accent-brand"
                          />
                          <span className="font-mono text-brand-light text-[10px] w-7">
                            {((activeShot.character_weights?.[boundChar.id] || 0.8) * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 2. 场景环境空间挂载 (Scene Anchor) */}
              <div className="p-3 rounded-2xl bg-emerald-500/5 border border-emerald-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                    <Mountain className="w-3.5 h-3.5 text-emerald-400" /> 场景环境空间 (Scene Space)
                  </span>
                  {activeShot.scene_name && (
                    <button
                      onClick={() => unbindSceneFromShot(activeShot.id)}
                      className="text-[10px] text-gray-400 hover:text-red-400"
                    >
                      解除挂载
                    </button>
                  )}
                </div>

                {activeShot.scene_name ? (
                  <div className="flex items-center justify-between bg-black/40 p-2 rounded-xl border border-emerald-500/30">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/60 border border-border shrink-0">
                        {activeShot.scene_ref_image ? (
                          <img src={getMediaUrl(activeShot.scene_ref_image)} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">场景</div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{activeShot.scene_name}</div>
                        <div className="text-[10px] text-gray-400 truncate">{activeShot.scene_prompt || '已注入环境光影'}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setAssetPickerConfig({
                          isOpen: true,
                          title: '从素材库更换场景空间',
                          category: 'scene',
                          onSelect: (asset) => bindSceneToShot(activeShot.id, asset),
                        });
                      }}
                      className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-[10px] font-bold shrink-0"
                    >
                      更换
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setAssetPickerConfig({
                        isOpen: true,
                        title: '从素材库选择场景空间素材',
                        category: 'scene',
                        onSelect: (asset) => bindSceneToShot(activeShot.id, asset),
                      });
                    }}
                    className="w-full py-2 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 text-emerald-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>+ 从素材库挂载场景空间 (青云大殿 / 荒漠战场...)</span>
                  </button>
                )}
              </div>

              {/* 3. 道具与法宝特效 (Prop Anchor) */}
              <div className="p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5 text-amber-400" /> 道具与法宝特效 (Props & FX)
                  </span>
                  <button
                    onClick={() => {
                      setAssetPickerConfig({
                        isOpen: true,
                        title: '从素材库添加道具/法宝素材',
                        category: 'prop',
                        onSelect: (asset) => bindPropToShot(activeShot.id, asset),
                      });
                    }}
                    className="text-[10px] text-amber-300 hover:underline flex items-center gap-0.5 font-bold"
                  >
                    <Plus className="w-3 h-3" /> 挂载道具
                  </button>
                </div>

                {activeShot.prop_prompts ? (
                  <div className="p-2 rounded-xl bg-black/40 border border-amber-500/30 flex items-center justify-between text-xs">
                    <span className="text-gray-300 truncate">{activeShot.prop_prompts}</span>
                    <button
                      onClick={() => updateShot(activeShot.id, { prop_asset_ids: [], prop_prompts: '' })}
                      className="text-[10px] text-gray-400 hover:text-red-400 ml-2 shrink-0"
                    >
                      清空
                    </button>
                  </div>
                ) : (
                  <div className="text-[11px] text-gray-500 py-0.5">暂无挂载道具，可从素材库挂载法宝剑气或关键物件</div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-gray-300 flex items-center gap-1"><Paintbrush className="w-3 h-3 text-violet-400"/> 画面动作描述</label>
                  <AiPolishButton value={activeShot.action_desc} onPolish={(v: any) => updateShot(activeShot.id, { action_desc: v })} contextType="prompt" size="xs" />
                </div>
                <textarea value={activeShot.action_desc} onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })} rows={2} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand leading-relaxed" placeholder="描述人物动作、情景与交互..."/>
              </div>

              {/* 4. 生图源 / ComfyUI 工作流专属全动态参数表单 */}
              <div className="p-3 rounded-2xl bg-surface-secondary/50 border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-violet-400" /> 生图生成源配置
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => synthesizeShotPrompt(activeShot.id)}
                      className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-brand to-violet-600 hover:opacity-90 text-white text-[11px] font-bold flex items-center gap-1 shadow-sm transition-all"
                      title="一键将角色特征、场景环境、道具法宝、3D机位词融合成完整提示词"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>⚡ 全要素合成</span>
                    </button>
                    <AiPolishButton value={activeShot.image_prompt} onPolish={(v: any) => updateShot(activeShot.id, { image_prompt: v })} contextType="prompt" size="xs" />
                  </div>
                </div>

                {/* 生图源选择 */}
                <ProviderPicker
                  kind="image"
                  value={imageProvider}
                  onChange={(pid, def) => {
                    setImageProvider(pid);
                    setImageProviderDef(def || null);
                    if (pid) localStorage.setItem('default_image_provider', pid);
                    updateShot(activeShot.id, { image_provider: pid, provider_params: { ...(activeShot as any).provider_params, image: imageProviderParams } } as any);
                    if (pid) probeProvider(pid);
                  }}
                  placeholder="— 选择生图源（空为系统默认） —"
                />

                {/* 生图源专有 Schema 参数动态表单 */}
                {imageProviderDef?.params_schema && (
                  <div className="rounded-xl bg-black/30 border border-violet-500/20 p-2.5 space-y-2">
                    <div className="text-[11px] font-bold text-violet-300 flex items-center justify-between">
                      <span>⚙️ {imageProviderDef.display_name || imageProviderDef.name || imageProviderDef.id} 专属参数</span>
                    </div>
                    <ProviderParamForm
                      definition={imageProviderDef}
                      values={imageProviderParams}
                      onChange={(next) => {
                        setImageProviderParams(next);
                        updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, image: next } } as any);
                      }}
                    />
                  </div>
                )}

                {/* ComfyUI 生图工作流选择 */}
                <div className="bg-surface border border-border rounded-xl p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-gray-300">ComfyUI 工作流</span>
                    {selectedWorkflowId && (
                      <button onClick={() => setInspectingWorkflowId(selectedWorkflowId)} className="text-[10px] text-brand-light hover:underline flex items-center gap-1">
                        <Sliders className="w-3 h-3" /> 参数与暴露
                      </button>
                    )}
                  </div>
                  <select
                    value={selectedWorkflowId}
                    onChange={(e) => {
                      setSelectedWorkflowId(e.target.value);
                      localStorage.setItem('default_workflow_id', e.target.value);
                      updateShot(activeShot.id, { workflow_id: e.target.value });
                    }}
                    className="w-full bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white"
                  >
                    <option value="">-- 系统默认 (API 生图) --</option>
                    {workflows.map((wf) => (
                      <option key={wf.id} value={wf.id}>
                        {wf.name || wf.id} ({wf.source === 'internal' ? '内部' : '外部'})
                      </option>
                    ))}
                  </select>

                  {/* 工作流动态暴露输入项（全类型自适应组件） */}
                  {workflowExposedInputs.length > 0 && (
                    <div className="pt-2 border-t border-border/60 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-amber-300 flex items-center gap-1">
                          <span>⭐️ 工作流暴露输入项 ({workflowExposedInputs.length})</span>
                        </span>
                        <span className="text-[10px] text-gray-400">已自适应映射节点</span>
                      </div>

                      <div className="space-y-2">
                        {workflowExposedInputs.map((exp: any) => {
                          const key = exp.id || exp.node_id;
                          const val = shotDynamicInputs[key];
                          const isImageType = exp.type === 'image' || exp.type === 'audio' || exp.type === 'video';

                          return (
                            <div key={key} className="space-y-1 bg-surface-secondary border border-border/80 rounded-lg p-2 text-xs">
                              <div className="flex items-center justify-between">
                                <span className="text-gray-300 font-medium">{exp.label || exp.param_name}</span>
                                <span className="text-[9px] text-gray-500 font-mono">#{exp.node_id}</span>
                              </div>

                              {isImageType ? (
                                <div className="space-y-1.5 pt-1">
                                  {val ? (
                                    <div className="flex items-center gap-2">
                                      {exp.type === 'image' ? (
                                        <img src={getMediaUrl(val)} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                                      ) : exp.type === 'audio' ? (
                                        <span className="text-xs font-mono truncate max-w-[140px] text-pink-300">🎵 {String(val).slice(0, 24)}...</span>
                                      ) : (
                                        <span className="text-xs font-mono truncate max-w-[140px] text-orange-300">🎬 {String(val).slice(0, 24)}...</span>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const next = { ...shotDynamicInputs, [key]: '' };
                                          setShotDynamicInputs(next);
                                          updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                        }}
                                        className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-xs hover:bg-red-500/30"
                                      >
                                        移除
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      {exp.type === 'image' && (
                                        <button
                                          type="button"
                                          onClick={() => handleInjectCurrentCharacter(key)}
                                          className="px-2 py-1 rounded bg-brand/20 hover:bg-brand/30 border border-brand/40 text-[11px] text-brand-light font-medium flex items-center gap-1 transition"
                                          title="一键注入该分镜出场角色的立绘或三视图"
                                        >
                                          <UserCheck className="w-3 h-3" />
                                          <span>🎭 注入当前角色</span>
                                        </button>
                                      )}
                                      <label className="px-2 py-1 rounded bg-surface-tertiary hover:bg-surface-tertiary/80 border border-border text-[11px] text-gray-300 cursor-pointer flex items-center gap-1 transition">
                                        <Upload className="w-3 h-3" />
                                        <span>{uploadingInputKey === key ? '上传中...' : `📁 上传${exp.type === 'audio' ? '音频' : exp.type === 'video' ? '视频' : '图片'}`}</span>
                                        <input
                                          type="file"
                                          accept={exp.type === 'image' ? 'image/*' : exp.type === 'audio' ? 'audio/*' : 'video/*'}
                                          className="hidden"
                                          onChange={(e) => {
                                            const f = e.target.files?.[0];
                                            if (f) {
                                              if (exp.type === 'image') handleUploadImageForInput(key, f);
                                              else {
                                                const r = new FileReader();
                                                r.onload = () => {
                                                  const next = { ...shotDynamicInputs, [key]: r.result as string };
                                                  setShotDynamicInputs(next);
                                                  updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                                };
                                                r.readAsDataURL(f);
                                              }
                                            }
                                          }}
                                        />
                                      </label>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setAssetPickerConfig({
                                            isOpen: true,
                                            title: `为工作流选择素材`,
                                            category: exp.type === 'image' ? 'character' : 'scene',
                                            onSelect: (asset) => {
                                              const next = { ...shotDynamicInputs, [key]: asset.url };
                                              setShotDynamicInputs(next);
                                              updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                            },
                                          });
                                        }}
                                        className="px-2 py-1 rounded bg-surface-tertiary hover:bg-brand/20 border border-border text-[11px] text-gray-300 hover:text-brand-light flex items-center gap-1"
                                      >
                                        <FolderOpen className="w-3 h-3" />
                                        <span>素材库</span>
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ) : (exp.type === 'select' || exp.type === 'combo') ? (
                                <select
                                  value={val ?? ''}
                                  onChange={(e) => {
                                    const next = { ...shotDynamicInputs, [key]: e.target.value };
                                    setShotDynamicInputs(next);
                                    updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                  }}
                                  className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white"
                                >
                                  <option value="">-- 请选择 --</option>
                                  {(exp.choices || []).map((c: string) => (
                                    <option key={c} value={c}>{c}</option>
                                  ))}
                                  {!(exp.choices || []).includes(val) && val && <option value={val}>{val}</option>}
                                </select>
                              ) : exp.type === 'boolean' ? (
                                <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                                  <input
                                    type="checkbox"
                                    checked={!!val}
                                    onChange={(e) => {
                                      const next = { ...shotDynamicInputs, [key]: e.target.checked };
                                      setShotDynamicInputs(next);
                                      updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                    }}
                                    className="w-4 h-4 rounded text-brand bg-surface-tertiary border-border"
                                  />
                                  <span className="text-xs text-gray-300">{val ? '开启' : '关闭'}</span>
                                </label>
                              ) : exp.type === 'number' ? (
                                <input
                                  type="number"
                                  value={val ?? ''}
                                  onChange={(e) => {
                                    const next = { ...shotDynamicInputs, [key]: parseFloat(e.target.value) || 0 };
                                    setShotDynamicInputs(next);
                                    updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                  }}
                                  className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white"
                                />
                              ) : (
                                <textarea
                                  value={val ?? ''}
                                  onChange={(e) => {
                                    const next = { ...shotDynamicInputs, [key]: e.target.value };
                                    setShotDynamicInputs(next);
                                    updateShot(activeShot.id, { dynamic_inputs: next } as any);
                                  }}
                                  rows={2}
                                  placeholder={exp.description || key}
                                  className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500 resize-none font-mono"
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* 提示词输入区（无工作流自定义提示词暴露时，使用首帧标准输入区） */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-gray-300 font-semibold">
                    <span>正向生图提示词</span>
                    <span className="text-[10px] text-gray-500 font-mono">{activeShot.image_prompt?.length || 0} 字</span>
                  </div>
                  <textarea
                    value={activeShot.image_prompt}
                    onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })}
                    rows={3}
                    className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                    placeholder="输入画面首帧提示词..."
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleRegenerateImage(1)}
                    disabled={isRegenerating}
                    className="flex-1 py-2.5 rounded-xl bg-surface-tertiary hover:bg-surface-hover border border-border text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 transition-all"
                  >
                    <span>单张生成</span>
                  </button>
                  <button
                    onClick={() => handleRegenerateImage(4)}
                    disabled={isRegenerating}
                    className="flex-[2] py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-light text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-lg shadow-brand/20 hover:opacity-90 disabled:opacity-40 transition-all"
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
                    <span>{isRegenerating ? '4 抽并发中…' : '1 镜 4 抽 (推荐 ⚡)'}</span>
                  </button>
                </div>
                {regenError && <div className="text-xs text-red-300">{regenError}</div>}
              </div>

              {/* 镜头机位与运动预设 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-gray-400">景别构图</label>
                  <select value={activeShot.camera_framing} onChange={(e) => updateShot(activeShot.id, { camera_framing: e.target.value as any })} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                    <option value="close_up">特写 (Close-Up)</option>
                    <option value="medium">中景 (Medium)</option>
                    <option value="full">全景 (Full)</option>
                    <option value="long">远景 (Long)</option>
                    <option value="bird_eye">俯视 (Bird Eye)</option>
                    <option value="low_angle">仰视 (Low Angle)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-gray-400">镜头运动</label>
                  <select value={activeShot.camera_motion} onChange={(e) => updateShot(activeShot.id, { camera_motion: e.target.value as any })} className="w-full mt-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                    <option value="static">静止 (Static)</option>
                    <option value="push_in">推近 (Push In)</option>
                    <option value="pull_out">拉远 (Pull Out)</option>
                    <option value="orbit">环绕 (Orbit)</option>
                    <option value="shake">震颤 (Shake)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 台词与配音 (TTS 智能吸附与语音源表单) */}
          {inspectorTab === 'dialogue' && (
            <div className="space-y-3.5">
              <div className="p-3 rounded-2xl bg-pink-500/5 border border-pink-500/20 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-pink-300 flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-pink-400" /> 角色台词 / 旁白
                  </span>
                  <div className="flex items-center gap-1.5">
                    <AiPolishButton
                      value={activeShot.dialogue || activeShot.voiceover || ''}
                      onPolish={(v, meta) => {
                        const polished = v;
                        const emo = (meta as any)?.suggested_emotion;
                        updateShot(activeShot.id, {
                          dialogue: activeShot.dialogue ? polished : '',
                          voiceover: activeShot.voiceover || !activeShot.dialogue ? polished : activeShot.voiceover,
                          subtitle_text: polished,
                          ...(emo ? { emotion: emo } : {}),
                        } as any);
                      }}
                      contextType="dialogue"
                      size="xs"
                    />
                    <span className={`w-2 h-2 rounded-full ${healthMap[audioProvider]?.ok ? 'bg-emerald-500' : healthMap[audioProvider]?.ok === false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
                  </div>
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
                  placeholder="输入角色台词或旁白..."
                  rows={3}
                  className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-pink-500/50 resize-none leading-relaxed"
                />

                <ProviderPicker
                  kind="audio"
                  value={audioProvider}
                  onChange={(pid, def) => {
                    setAudioProvider(pid);
                    setAudioProviderDef(def || null);
                    if (pid) localStorage.setItem('default_audio_provider', pid);
                    updateShot(activeShot.id, { audio_provider: pid, provider_params: { ...(activeShot as any).provider_params, audio: audioProviderParams } } as any);
                    if (pid) probeProvider(pid);
                  }}
                  placeholder="— 选择语音源 —"
                  compact
                />

                {/* 语音源专有 Schema 参数动态表单 */}
                {audioProviderDef?.params_schema && (
                  <div className="rounded-xl bg-black/30 border border-pink-500/20 p-2.5 space-y-2">
                    <div className="text-[11px] font-bold text-pink-300">
                      ⚙️ {audioProviderDef.display_name || audioProviderDef.name || audioProviderDef.id} 专属参数
                    </div>
                    <ProviderParamForm
                      definition={audioProviderDef}
                      values={audioProviderParams}
                      onChange={(next) => {
                        setAudioProviderParams(next);
                        updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, audio: next } } as any);
                      }}
                    />
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <select value={activeShot.speaker_name || project?.characters[0]?.name || ''} onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })} className="flex-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                    {project?.characters.map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                  <select value={activeShot.emotion} onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as EmotionType })} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                    <option value="neutral">😐 平静</option>
                    <option value="intense">🔥 怒吼</option>
                    <option value="sorrow">😢 悲痛</option>
                    <option value="excited">⚡ 兴奋</option>
                    <option value="whispering">🤫 耳语</option>
                  </select>
                </div>

                <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
                  <span>镜头时长: <b className="text-pink-300">{activeShot.duration}s</b></span>
                  <button
                    onClick={() => autoFitShotDuration(activeShot.id)}
                    className="px-2 py-1 rounded-lg bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 text-[11px] font-bold flex items-center gap-1"
                    title="根据台词字数/音频长度智能重算时长"
                  >
                    <Zap className="w-3 h-3 text-pink-400" /> 智能吸附时长
                  </button>
                </div>

                <button onClick={handlePlayTTS} disabled={isPlayingAudio} className="w-full py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-violet-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-pink-500/20 hover:opacity-95 disabled:opacity-40">
                  <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} />
                  <span>{isPlayingAudio ? '合成并播放中...' : '试听配音 (按 T 快捷生成)'}</span>
                </button>
                {ttsError && <div className="text-xs text-red-300">{ttsError}</div>}
                {activeShot.audio_url && <audio controls src={getMediaUrl(activeShot.audio_url)} className="w-full mt-1" />}
              </div>

              <div className="p-3 rounded-2xl bg-surface-secondary/40 border border-border space-y-1.5">
                <label className="text-[11px] font-semibold text-gray-300">分镜字幕 (导出剪映自动对齐)</label>
                <input value={activeShot.subtitle_text} onChange={(e) => updateShot(activeShot.id, { subtitle_text: e.target.value })} placeholder="字幕文本，留空则自动同步台词" className="w-full bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-500" />
              </div>
            </div>
          )}

          {/* TAB 3: 运镜与视频动态 (视频源与动态视频工作流) */}
          {inspectorTab === 'motion' && (
            <div className="p-3 rounded-2xl bg-orange-500/5 border border-orange-500/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-orange-400 flex items-center gap-1.5">
                  <Video className="w-3.5 h-3.5" /> 动态视频生成源配置
                </span>
                <span className={`w-2 h-2 rounded-full ${healthMap[videoProvider]?.ok ? 'bg-emerald-500' : healthMap[videoProvider]?.ok === false ? 'bg-amber-500' : 'bg-zinc-600'}`} />
              </div>

              <div className="grid grid-cols-3 gap-1">
                {[
                  { id: 'i2v', label: '图生视频' },
                  { id: 'r2v', label: '参考生视频' },
                  { id: 't2v', label: '文生视频' },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setVideoMode(m.id as any);
                      localStorage.setItem('storyboard_video_mode', m.id);
                    }}
                    className={`py-1.5 rounded-lg text-xs font-bold border transition-all ${
                      videoMode === m.id ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-surface-secondary text-gray-400 border-border hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <ProviderPicker
                kind="video"
                value={videoProvider}
                onChange={(pid, def) => {
                  setVideoProvider(pid);
                  setVideoProviderDef(def || null);
                  if (pid) localStorage.setItem('default_video_provider', pid);
                  updateShot(activeShot.id, { video_provider: pid, provider_params: { ...(activeShot as any).provider_params, video: videoProviderParams } } as any);
                  if (pid) probeProvider(pid);
                }}
                placeholder="— 选择视频源 —"
              />

              {/* 视频源专有 Schema 参数动态表单 */}
              {videoProviderDef?.params_schema && (
                <div className="rounded-xl bg-black/30 border border-orange-500/20 p-2.5 space-y-2">
                  <div className="text-[11px] font-bold text-orange-300">
                    ⚙️ {videoProviderDef.display_name || videoProviderDef.name || videoProviderDef.id} 专属参数
                  </div>
                  <ProviderParamForm
                    definition={videoProviderDef}
                    values={videoProviderParams}
                    onChange={(next) => {
                      setVideoProviderParams(next);
                      updateShot(activeShot.id, { provider_params: { ...(activeShot as any).provider_params, video: next } } as any);
                    }}
                  />
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-orange-300">运镜/运动描述</span>
                <AiPolishButton value={activeShot.video_prompt || ''} onPolish={(v: any) => updateShot(activeShot.id, { video_prompt: v })} contextType="prompt" size="xs" />
              </div>
              <textarea
                value={activeShot.video_prompt || ''}
                onChange={(e) => updateShot(activeShot.id, { video_prompt: e.target.value })}
                placeholder="运镜/运动描述..."
                rows={2}
                className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
              />

              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label: '🔥 推近 (Push In)', prompt: '镜头极速推向主角面部，眼神爆发光芒' },
                  { label: '🌀 环绕 (Orbit)', prompt: '360度动态环拍，发丝衣袂随风狂舞' },
                  { label: '⚡ 震颤 (Shake)', prompt: '手持镜头激烈震动，冲击波扩散' },
                  { label: '🌌 拉远 (Pull Out)', prompt: '缓缓拉出镜头，展现宏大背景与天地' },
                ].map((p) => (
                  <button
                    key={p.label}
                    onClick={() => updateShot(activeShot.id, { video_prompt: p.prompt })}
                    className="text-[11px] p-2 rounded-xl border border-border bg-surface-secondary hover:border-orange-500/40 text-gray-300 hover:text-white truncate text-left transition-all"
                    title={p.prompt}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
                <span>生成时长: <b className="text-orange-400">{Math.round(activeShot.duration)}s</b></span>
              </div>
              <input
                type="range"
                min="3"
                max="10"
                value={Math.round(activeShot.duration)}
                onChange={(e) => updateShot(activeShot.id, { duration: parseFloat(e.target.value) })}
                className="w-full accent-orange-500"
              />

              <button
                onClick={handleGenerateVideo}
                disabled={isGeneratingVid}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-orange-500/20 hover:opacity-95 disabled:opacity-40 transition-all"
              >
                <Film className={`w-3.5 h-3.5 ${isGeneratingVid ? 'animate-spin' : ''}`} />
                <span>{isGeneratingVid ? '生成中... (可按 V)' : videoSuccess ? '已生成' : '生成动态视频 (按 V)'}</span>
              </button>
              {videoError && <div className="text-xs text-red-300">{videoError}</div>}
            </div>
          )}
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

      {/* ⌨️ 底部悬浮专业快捷键指南 */}
      {showHotkeysHint && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-surface/90 backdrop-blur-md border border-border px-3.5 py-1.5 rounded-full shadow-2xl z-30 flex items-center gap-3 text-[11px] [color:var(--color-text-main)] animate-fade-in pointer-events-auto">
          <div className="flex items-center gap-1 text-brand font-bold">
            <Keyboard className="w-3.5 h-3.5" /> 快捷键:
          </div>
          <div className="flex items-center gap-2">
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">Space</kbd> 播放</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">A</kbd>/<kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">D</kbd> 切镜头</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">R</kbd> 抽卡</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">V</kbd> 视频</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">T</kbd> 配音</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">1-4</kbd> 选候选</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-surface-secondary border border-border [color:var(--color-text-main)] font-mono text-[10px]">Ctrl+D</kbd> 复制</span>
          </div>
          <button onClick={() => setShowHotkeysHint(false)} className="ml-1 [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] text-xs">×</button>
        </div>
      )}

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
              setWorkflowExposedInputs([]);
            }
          }}
        />
      )}

      {/* Universal Asset Picker Modal for Storyboard Reference & Dynamic Inputs */}
      <AssetPickerModal
        isOpen={assetPickerConfig.isOpen}
        title={assetPickerConfig.title}
        defaultCategory={assetPickerConfig.category}
        onSelect={(asset) => {
          assetPickerConfig.onSelect(asset);
          setAssetPickerConfig(p => ({ ...p, isOpen: false }));
        }}
        onClose={() => setAssetPickerConfig(p => ({ ...p, isOpen: false }))}
      />
    </div>
  );
};
