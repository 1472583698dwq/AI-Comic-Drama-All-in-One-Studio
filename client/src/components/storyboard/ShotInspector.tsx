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

  // 真实生图 — 更新该分镜的 image_url（支持全局 Provider 动态参数）
  const handleRegenerateImage = async () => {
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(activeShot.id, { status: 'generating_image' });
    try {
      const mergedDynamic: Record<string,any> = { ...shotDynamicInputs };
      // 合并 Provider 动态参数（不固定参数）
      Object.entries(imageProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) mergedDynamic[k]=v; });
      const res = await apiService.generateShotImage({
        prompt: activeShot.image_prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        workflow_id: selectedWorkflowId || undefined,
        provider: imageProvider || undefined,
        model: imageProviderDef?.default_model || undefined,
        dynamic_inputs: Object.keys(mergedDynamic).length > 0 ? mergedDynamic : undefined,
      });
      updateShot(activeShot.id, { image_url: res.image_url, status: 'completed' });
      setPreviewTab('image');
    } catch (e: any) {
      setRegenError(e?.message || '生图失败');
      updateShot(activeShot.id, { status: 'error' });
    } finally {
      setIsRegenerating(false);
    }
  };

  // 动态视频生成 (I2V / R2V / T2V) — 支持全局 Provider
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
      const mergedDynamic: Record<string,any> = { ...shotDynamicInputs };
      Object.entries(videoProviderParams).forEach(([k,v])=> { if(v!=='' && v!==null && v!==undefined) mergedDynamic[k]=v; });
      await generateShotVideo(activeShot.id, {
        mode: videoMode,
        prompt,
        duration: Math.round(activeShot.duration) || 5,
        provider: videoProvider,
        workflow_id: selectedWorkflowId || undefined,
        dynamic_inputs: Object.keys(mergedDynamic).length > 0 ? mergedDynamic : undefined,
      });
      setVideoSuccess(true);
      setPreviewTab('video');
      setTimeout(() => setVideoSuccess(false), 3000);
    } catch (e: any) {
      setVideoError(e?.message || '视频生成失败');
    } finally {
      setIsGeneratingVid(false);
    }
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
      <div className="w-[260px] bg-surface border border-border rounded-2xl flex flex-col shrink-0 overflow-hidden shadow-sm">
        <div className="h-11 px-3 border-b border-border flex items-center justify-between shrink-0 bg-surface-secondary/50">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Layers className="w-3.5 h-3.5 text-brand" /></div>
            <span className="text-xs font-bold tracking-tight text-white">分镜</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">{shots.length}</span>
          </div>
          <button onClick={() => addShot(1)} className="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center hover:bg-brand-light shadow-sm" title="添加分镜"><Plus className="w-3.5 h-3.5" /></button>
        </div>

        {/* Shot Scroll List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
          {shots.map((shot) => {
            const isSelected = shot.id === activeShot.id;
            const hasVideo = Boolean(shot.video_url);
            return (
              <div
                key={shot.id}
                onClick={() => setActiveShotId(shot.id)}
                className={`p-2 rounded-xl border cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-surface-tertiary border-brand glow-border'
                    : 'bg-surface-secondary/60 border-border hover:border-border-active'
                }`}
              >
                <div className="relative aspect-video rounded-lg overflow-hidden bg-black/60 mb-1.5">
                  {shot.image_url ? (
                    <img 
                      src={getMediaUrl(shot.image_url)} 
                      alt="" 
                      className="w-full h-full object-cover" 
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[9px] text-gray-500">
                      {shot.status === 'generating_image' ? '生图中...' : (shot.status === 'generating_video' ? '生视频中...' : '待生成')}
                    </div>
                  )}
                  <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] font-mono text-brand-light font-bold">
                    #{shot.shot_index}
                  </span>
                  {hasVideo && (
                    <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-accent-orange/90 text-[8px] font-bold text-white uppercase tracking-wider flex items-center space-x-0.5">
                      <Film className="w-2.5 h-2.5" />
                      <span>VID</span>
                    </span>
                  )}
                  <span className="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[9px] text-gray-300 font-mono">
                    {shot.duration}s
                  </span>
                </div>
                <p className="text-[11px] text-gray-300 truncate font-medium">{shot.action_desc}</p>
                {shot.dialogue && (
                  <p className="text-[10px] text-accent-pink truncate">🗣️ {shot.dialogue}</p>
                )}
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

      {/* 3. Right Column: Shot Inspector — 320px 卡片化 */}
      <div className="w-[340px] bg-surface border border-border rounded-2xl p-4 flex flex-col space-y-4 overflow-y-auto custom-scrollbar shrink-0 shadow-sm">
        <div className="h-8 flex items-center justify-between border-b border-border pb-2 shrink-0 -mx-1">
          <span className="text-xs font-bold tracking-tight text-white flex items-center gap-2"><Sliders className="w-3.5 h-3.5 text-brand" /> 检查器</span>
          <button
            onClick={() => deleteShot(activeShot.id)}
            className="p-1 rounded text-gray-500 hover:text-red-400"
            title="删除此分镜"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 1. Dialogue / Voiceover Editor */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block flex items-center justify-between">
            <span>🗣️ 角色台词 / 旁白</span>
            <span className="text-[10px] text-gray-500">MiniMax / 动态TTS</span>
          </label>
            <div className="space-y-2">
              <textarea
                value={activeShot.dialogue || activeShot.voiceover || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  updateShot(activeShot.id, {
                    dialogue: activeShot.dialogue ? val : '',
                    voiceover: activeShot.voiceover || !activeShot.dialogue ? val : activeShot.voiceover,
                    subtitle_text: val,
                  });
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,100)+'px';
                }}
                onInput={(e)=>{const el=e.target as HTMLTextAreaElement; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,100)+'px';}}
                placeholder="输入该分镜的台词或解说旁白（Shift+Enter换行）..."
                rows={1}
                className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none overflow-y-auto min-h-[36px] max-h-[100px] leading-relaxed"
              />
              {/* 全域语音源（与设置/画布同源） */}
              <ProviderPicker kind="audio" value={audioProvider} onChange={(pid, def)=> { setAudioProvider(pid); setAudioProviderDef(def||null); }} placeholder="— 选择语音源 —" compact />
              {audioProviderDef?.params_schema && (
                <div className="rounded-lg bg-black/20 border border-border p-2">
                  <ProviderParamForm definition={audioProviderDef} values={audioProviderParams} onChange={setAudioProviderParams} />
                </div>
              )}

              {/* Speaker & Emotion Selector */}
              <div className="flex items-center space-x-2">
              <select
                value={activeShot.speaker_name || project?.characters[0]?.name || ''}
                onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })}
                className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-brand-light focus:outline-none max-w-[110px]"
              >
                {project?.characters.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                value={activeShot.emotion}
                onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as EmotionType })}
                className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-accent-pink focus:outline-none"
              >
                <option value="neutral">😐 平静自然</option>
                <option value="intense">🔥 怒吼爆发</option>
                <option value="sorrow">😢 悲痛哽咽</option>
                <option value="excited">⚡ 兴奋狂喜</option>
                <option value="whispering">🤫 耳语低沉</option>
              </select>

              <button
                onClick={handlePlayTTS}
                className="p-1.5 rounded-lg bg-accent-pink/20 border border-accent-pink/40 hover:bg-accent-pink text-accent-pink hover:text-white transition-all flex items-center space-x-1 text-xs px-2.5"
                title="调用 TTS 真实生成并试听"
              >
                <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} />
                <span>{isPlayingAudio ? '播放中' : '试听'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* 2. Visual Action Description */}
        <div>
          <label className="text-xs text-gray-300 font-medium mb-1.5 block">
            🎬 画面剧情动作描述
          </label>
          <textarea
            value={activeShot.action_desc}
            onChange={(e) => updateShot(activeShot.id, { action_desc: e.target.value })}
            rows={2}
            className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-brand"
          />
        </div>

        {/* 3. Image Prompt (首帧静态生图) */}
          <div className="p-3 rounded-xl bg-surface-secondary/40 border border-border space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-300 font-semibold flex items-center space-x-1">
                <ImageIcon className="w-3.5 h-3.5 text-accent-green" />
                <span>首帧提示词 (Image Prompt)</span>
              </label>
              <span className="text-[10px] text-accent-green">全域生图源</span>
            </div>
            {/* 全域生图源选择（与设置/画布同源） */}
            <ProviderPicker kind="image" value={imageProvider} onChange={(pid, def)=> { setImageProvider(pid); setImageProviderDef(def||null); }} placeholder="— 选择生图源（空为系统默认） —" />
            {imageProviderDef?.params_schema && (
              <div className="rounded-lg bg-black/20 border border-border p-2">
                <div className="text-[11px] font-semibold text-gray-300 mb-1">该生图源扩展参数（不固定）</div>
                <ProviderParamForm definition={imageProviderDef} values={imageProviderParams} onChange={setImageProviderParams} />
              </div>
            )}

            <textarea
              value={activeShot.image_prompt}
              onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })}
              rows={2}
              className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs font-mono text-gray-300 placeholder-gray-500 focus:outline-none focus:border-brand"
              placeholder="输入画面首帧提示词..."
            />

          {/* Workflow Selector & Inspector Trigger */}
          <div className="bg-surface-secondary/70 border border-border rounded-xl p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-gray-300 flex items-center gap-1">
                <span>ComfyUI 生图工作流</span>
              </label>
              {selectedWorkflowId && (
                <button
                  type="button"
                  onClick={() => setInspectingWorkflowId(selectedWorkflowId)}
                  className="text-[10px] text-brand-light hover:underline flex items-center gap-0.5"
                >
                  <Sliders className="w-3 h-3" />
                  <span>⚙️ 参数与暴露诊断</span>
                </button>
              )}
            </div>

            <select
              value={selectedWorkflowId}
              onChange={(e) => setSelectedWorkflowId(e.target.value)}
              className="w-full bg-surface-tertiary border border-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-brand"
            >
              <option value="">-- 系统默认生图工作流 --</option>
              {workflows.map((wf) => (
                <option key={wf.id} value={wf.id}>
                  {wf.name || wf.id} ({wf.source === 'internal' ? '内部' : '外部'})
                </option>
              ))}
            </select>

            {/* Dynamic Exposed Inputs for this Shot */}
            {workflowExposedInputs.length > 0 && (
              <div className="pt-2 border-t border-border/60 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-amber-300 flex items-center gap-1">
                    <span>⭐️ 专属输入暴露项 ({workflowExposedInputs.length})</span>
                  </span>
                  <span className="text-[10px] text-gray-400">已自适应映射节点</span>
                </div>

                <div className="space-y-2">
                  {workflowExposedInputs.map((exp: any) => {
                    const key = exp.id || exp.node_id;
                    const val = shotDynamicInputs[key];
                    return (
                      <div key={key} className="space-y-1 bg-surface-secondary border border-border/80 rounded-lg p-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-gray-300 font-medium">{exp.label || exp.param_name}</span>
                          <span className="text-[9px] text-gray-500 font-mono">#{exp.node_id}</span>
                        </div>

                        {exp.type === 'image' ? (
                          <div className="space-y-1.5 pt-1">
                            {val ? (
                              <div className="relative group w-20 h-20 rounded-lg overflow-hidden border border-brand/40 bg-black/40">
                                <img
                                  src={val.startsWith('/') ? API_ORIGIN + val : val.startsWith('http') || val.startsWith('data:') ? val : `${API_ORIGIN}/storage/${val}`}
                                  alt="垫图预览"
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.display = 'none';
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => setShotDynamicInputs(p => ({ ...p, [key]: '' }))}
                                  className="absolute top-1 right-1 bg-red-500/80 hover:bg-red-500 text-white rounded p-1 text-[10px]"
                                  title="移除此垫图"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {/* 快速注入当前角色立绘 */}
                                <button
                                  type="button"
                                  onClick={() => handleInjectCurrentCharacter(key)}
                                  className="px-2 py-1 rounded bg-brand/20 hover:bg-brand/30 border border-brand/40 text-[11px] text-brand-light font-medium flex items-center gap-1 transition"
                                  title="一键注入该分镜说话角色的立绘/三视图"
                                >
                                  <UserCheck className="w-3 h-3" />
                                  <span>🎭 注入当前角色立绘</span>
                                </button>

                                {/* 本地上传 */}
                                <label className="px-2 py-1 rounded bg-surface-tertiary hover:bg-surface-tertiary/80 border border-border text-[11px] text-gray-300 cursor-pointer flex items-center gap-1 transition">
                                  <Upload className="w-3 h-3" />
                                  <span>{uploadingInputKey === key ? '上传中...' : '📁 上传'}</span>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      const f = e.target.files?.[0];
                                      if (f) handleUploadImageForInput(key, f);
                                    }}
                                  />
                                </label>

                                {/* 从素材库选择 */}
                                {projectAssets.length > 0 && (
                                  <select
                                    onChange={(e) => {
                                      if (e.target.value) {
                                        setShotDynamicInputs(p => ({ ...p, [key]: e.target.value }));
                                        e.target.value = '';
                                      }
                                    }}
                                    defaultValue=""
                                    className="bg-surface-tertiary border border-border rounded px-1.5 py-1 text-[10px] text-gray-300 max-w-[120px]"
                                  >
                                    <option value="" disabled>🖼️ 从素材库选...</option>
                                    {projectAssets.filter(a => a.image_url).map(a => (
                                      <option key={a.id} value={a.image_url}>{a.name}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            )}
                          </div>
                        ) : exp.type === 'number' ? (
                          <input
                            type="number"
                            value={val ?? ''}
                            onChange={(e) => setShotDynamicInputs(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
                            className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-xs text-white"
                          />
                        ) : (
                          <input
                            type="text"
                            value={val ?? ''}
                            onChange={(e) => setShotDynamicInputs(p => ({ ...p, [key]: e.target.value }))}
                            placeholder={exp.description || '输入动态参数值...'}
                            className="w-full bg-surface-tertiary border border-border rounded px-2 py-1 text-xs font-mono text-white placeholder-gray-500"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={handleRegenerateImage}
            disabled={isRegenerating}
            className="w-full py-2 rounded-xl bg-brand hover:opacity-90 text-white text-xs font-semibold disabled:opacity-40 transition-all shadow-md flex items-center justify-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
            <span>{isRegenerating ? '生成首帧画面中...' : '生成 / 重绘首帧画面'}</span>
          </button>
        </div>

        {/* 4. Video Prompt & Generation (图生视频 / 参考生视频) */}
        <div className="p-3 rounded-xl bg-accent-orange/5 border border-accent-orange/30 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-accent-orange flex items-center space-x-1">
              <Film className="w-4 h-4" />
              <span>动态视频生成 (I2V / R2V)</span>
            </span>
            <span className="text-[10px] bg-accent-orange/20 text-accent-orange px-2 py-0.5 rounded-full font-mono">
              {videoMode.toUpperCase()}
            </span>
          </div>

          {/* Mode Switcher */}
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { id: 'i2v', label: '图生视频', desc: '首帧驱动' },
              { id: 'r2v', label: '参考生视频', desc: '强一致性' },
              { id: 't2v', label: '文生视频', desc: '自由生成' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setVideoMode(m.id as any)}
                className={`p-1.5 rounded-lg text-center border transition-all ${
                  videoMode === m.id
                    ? 'bg-accent-orange/20 border-accent-orange text-white font-bold'
                    : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                }`}
              >
                <div className="text-[11px]">{m.label}</div>
                <div className="text-[8px] text-gray-500">{m.desc}</div>
              </button>
            ))}
          </div>

          {/* 全域视频源（与设置/画布同源，动态参数） */}
            <ProviderPicker kind="video" value={videoProvider} onChange={(pid, def)=> { setVideoProvider(pid); setVideoProviderDef(def||null); }} placeholder="— 选择视频源 —" />
            {videoProviderDef?.params_schema && (
              <div className="rounded-lg bg-black/20 border border-border p-2">
                <div className="text-[11px] font-semibold text-gray-300 mb-1">该视频源扩展参数</div>
                <ProviderParamForm definition={videoProviderDef} values={videoProviderParams} onChange={setVideoProviderParams} />
              </div>
            )}

          {/* Video Prompt Textarea */}
          <div>
            <label className="text-[11px] text-gray-300 font-medium mb-1 block">
              🚀 运镜与运动描述 (Motion Prompt)
            </label>
            <textarea
              value={activeShot.video_prompt || ''}
              onChange={(e) => updateShot(activeShot.id, { video_prompt: e.target.value })}
              placeholder="描述镜头运动与主体动态（例如：镜头急速拉近，角色眼神发光，发丝随风飘扬...）"
              rows={2}
              className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-accent-orange"
            />
          </div>

          {/* Preset Chips */}
          <div className="space-y-1">
            <span className="text-[10px] text-gray-500">常用运镜预设:</span>
            <div className="grid grid-cols-2 gap-1">
              {videoMotionPresets.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => updateShot(activeShot.id, { video_prompt: preset.prompt })}
                  className="text-left text-[10px] p-1.5 rounded bg-surface-secondary/80 border border-border hover:border-accent-orange text-gray-300 truncate"
                  title={preset.prompt}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Video Duration */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1">
              <span>视频生成时长:</span>
              <span className="font-mono text-accent-orange font-bold">{Math.round(activeShot.duration)} 秒</span>
            </div>
            <input
              type="range"
              min="3"
              max="10"
              step="1"
              value={Math.round(activeShot.duration)}
              onChange={(e) => updateShot(activeShot.id, { duration: parseFloat(e.target.value) })}
              className="w-full accent-accent-orange"
            />
          </div>

          {/* Generate Video Action Button */}
          <button
            onClick={handleGenerateVideo}
            disabled={isGeneratingVid}
            className={`w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center space-x-2 transition-all shadow-lg ${
              videoSuccess
                ? 'bg-accent-green text-white shadow-accent-green/30'
                : 'bg-gradient-to-r from-accent-orange to-brand-glow hover:opacity-95 text-white shadow-accent-orange/30 disabled:opacity-40'
            }`}
          >
            {videoSuccess ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>动态视频生成成功！</span>
              </>
            ) : (
              <>
                <Film className={`w-4 h-4 ${isGeneratingVid ? 'animate-spin' : ''}`} />
                <span>{isGeneratingVid ? '正在生成动态视频...' : '🚀 生成当前分镜动态视频'}</span>
              </>
            )}
          </button>
        </div>
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
