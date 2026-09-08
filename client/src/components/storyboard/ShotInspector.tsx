import React, { useState, useEffect, useMemo } from 'react';
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
import { extractSlotsFromProvider } from '../canvas/providerSkills';
import { buildShotReferenceInputs, promptWithCharacterTags, withCameraIntent } from './shotReference';
import { AiPolishButton } from '../ui/AiPolishButton';
import { AssetPickerModal } from '../asset/AssetPickerModal';
import { CanvasResourcePickerModal } from '../canvas/CanvasResourcePickerModal';

const API_ORIGIN = 'http://127.0.0.1:8000';

/**
 * 生成源插槽挂载区：完全按该源 input_schema 声明的媒体槽位逐条渲染（首帧/尾帧/参考图/参考音频…），
 * 源未声明即不显示，不再有任何按 kind 写死的输入块。
 */
const ProviderSlotList: React.FC<{
  slots: any[];
  values: Record<string, any>;
  uploadingKey: string | null;
  onWrite: (keys: string[], v: any) => void;
  onUpload: (keys: string[], f: File, multi: boolean) => void;
  onPickFromLibrary: (slot: any, keys: string[], multi: boolean) => void;
  onInjectCharacter?: (keys: string[], multi: boolean) => void;
  resolveUrl: (u?: string | null) => string;
}> = ({ slots, values, uploadingKey, onWrite, onUpload, onPickFromLibrary, onInjectCharacter, resolveUrl }) => {
  if (!slots.length) return null;
  return (
    <div className="space-y-1.5">
      {slots.map((slot: any) => {
        const writeKeys = Array.from(new Set([slot.key, slot.originalKey].filter(Boolean) as string[]));
        const raw = values[slot.key] ?? (slot.originalKey ? values[slot.originalKey] : undefined);
        const urls: string[] = Array.isArray(raw) ? raw.filter(Boolean).map(String) : (raw ? [String(raw)] : []);
        const isMulti = !!slot.multi || (slot.maxCount ?? 1) > 1;
        const typeWord = slot.type === 'audio' ? '音频' : slot.type === 'video' ? '视频' : '图片';
        return (
          <div key={slot.key} className="space-y-1 bg-surface-secondary border border-border/80 rounded-lg p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-300 font-medium">{slot.label}{slot.required && <span className="text-red-400"> *</span>}</span>
              <span className="text-[9px] text-gray-500 font-mono" title={slot.description || ''}>{slot.originalKey || slot.key}</span>
            </div>
            {urls.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {urls.map((u) => (
                  slot.type === 'audio'
                    ? <span key={u} className="px-2 py-1 rounded bg-black/40 text-[10px] font-mono text-pink-300 max-w-[150px] truncate">🎵 {u.split(/[\\/]/).pop()}</span>
                    : <img key={u} src={resolveUrl(u)} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                ))}
                <button type="button" onClick={() => onWrite(writeKeys, isMulti ? [] : '')} className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-[11px] hover:bg-red-500/30">清除</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {slot.type === 'image' && onInjectCharacter && (
                  <button
                    type="button"
                    onClick={() => onInjectCharacter(writeKeys, isMulti)}
                    className="px-2 py-1 rounded bg-brand/20 hover:bg-brand/30 border border-brand/40 text-[11px] text-brand-light font-medium flex items-center gap-1 transition"
                    title="一键注入该分镜出场角色的立绘或三视图"
                  >
                    <UserCheck className="w-3 h-3" />
                    <span>🎭 注入当前角色</span>
                  </button>
                )}
                <label className="px-2 py-1 rounded bg-surface-tertiary hover:bg-surface-tertiary/80 border border-border text-[11px] text-gray-300 cursor-pointer flex items-center gap-1 transition">
                  <Upload className="w-3 h-3" />
                  <span>{uploadingKey === slot.key ? '上传中...' : `📁 上传${typeWord}`}</span>
                  <input
                    type="file"
                    accept={slot.type === 'image' ? 'image/*' : slot.type === 'audio' ? 'audio/*' : 'video/*'}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(writeKeys, f, isMulti);
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => onPickFromLibrary(slot, writeKeys, isMulti)}
                  className="px-2 py-1 rounded bg-surface-tertiary hover:bg-brand/20 border border-border text-[11px] text-gray-300 hover:text-brand-light flex items-center gap-1"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>素材库</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

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
    setWorkspace,
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
  // 三模式预览锁定：漫画只看图、直出只看视频、图生两步可切（避免跨模式串台）
  const effectivePreviewTab = productionMode === 'comic' ? 'image' : productionMode === 'motion_comic' ? 'video' : previewTab;
  // 预览框跟随项目画幅（9:16 / 16:9 / 1:1），不再写死竖屏
  const previewAspect = (project?.aspect_ratio || '9:16').replace(':', '/');
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
    localStorage.getItem('default_video_provider') || ''
  );
  const [videoProviderDef, setVideoProviderDef] = useState<any>(null);
  const [videoProviderParams, setVideoProviderParams] = useState<Record<string,any>>({});
  const [imageProvider, setImageProvider] = useState<string>(
    localStorage.getItem('default_image_provider') || ''
  );
  const [imageProviderDef, setImageProviderDef] = useState<any>(null);
  const [imageProviderParams, setImageProviderParams] = useState<Record<string,any>>({});
  const [audioProvider, setAudioProvider] = useState<string>(
    localStorage.getItem('default_audio_provider') || ''
  );
  const [audioProviderDef, setAudioProviderDef] = useState<any>(null);
  const [audioProviderParams, setAudioProviderParams] = useState<Record<string,any>>({});
  const [healthMap, setHealthMap] = useState<Record<string, any>>({});
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<Array<{id:string, type:'image'|'video'|'audio', status:'queued'|'running'|'done'|'error'}>>([]);
  // 分镜右键菜单：使用新画布 / 隶属到现有画布（视频在该画布生成后回写分镜）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; shotId: string } | null>(null);
  const [ctxCanvases, setCtxCanvases] = useState<Array<{ id: string; name: string; node_count: number }>>([]);
  const [ctxLoadingCanvas, setCtxLoadingCanvas] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoSuccess, setVideoSuccess] = useState(false);
  const [autoFitNotification, setAutoFitNotification] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [showHotkeysHint, setShowHotkeysHint] = useState(true);

  // 旧分镜可能只存了 workflow_id 而没选源，仅作为未选源时的兜底
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    localStorage.getItem('default_workflow_id') || ''
  );
  const [shotDynamicInputs, setShotDynamicInputs] = useState<Record<string, any>>({});
  const [inspectingWorkflowId, setInspectingWorkflowId] = useState<string>('');
  const [projectAssets, setProjectAssets] = useState<any[]>([]);
  const [uploadingInputKey, setUploadingInputKey] = useState<string | null>(null);
  // 生成源插槽的素材选择（复用画布的四源选择器，支持多选累积）
  const [slotPicker, setSlotPicker] = useState<{ slot: any; writeKeys: string[]; multi: boolean } | null>(null);

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
    loadProjectAssets();
    const onAssetRefresh = () => loadProjectAssets();
    const onAssetApplied = (e: any) => {
      if (e.detail?.shotId === activeShot?.id) loadProjectAssets();
    };
    window.addEventListener('asset-refresh', onAssetRefresh as any);
    window.addEventListener('asset-applied', onAssetApplied as any);
    return () => {
      window.removeEventListener('asset-refresh', onAssetRefresh as any);
      window.removeEventListener('asset-applied', onAssetApplied as any);
    };
  }, [activeShot?.id]);

  useEffect(() => {
    loadProjectAssets();
  }, [project?.id]);

  const loadProjectAssets = async () => {
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
    if(s.video_provider !== undefined) setVideoProvider(s.video_provider || localStorage.getItem('default_video_provider') || '');
    if(s.audio_provider !== undefined) setAudioProvider(s.audio_provider || localStorage.getItem('default_audio_provider') || '');
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

  // 恢复选中源时从接口拉回 definition（工作流/API 路由、参数表单、插槽全部按 definition 映射，不再用 id 前缀猜）
  useEffect(() => {
    if (imageProvider && imageProviderDef?.id !== imageProvider) {
      apiService.getProvider(imageProvider).then((r: any) => setImageProviderDef(r?.provider || null)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageProvider]);
  useEffect(() => {
    if (videoProvider && videoProviderDef?.id !== videoProvider) {
      apiService.getProvider(videoProvider).then((r: any) => setVideoProviderDef(r?.provider || null)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoProvider]);
  useEffect(() => {
    if (audioProvider && audioProviderDef?.id !== audioProvider) {
      apiService.getProvider(audioProvider).then((r: any) => setAudioProviderDef(r?.provider || null)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioProvider]);

  // 后端重建 schema 后（改暴露清单/新增源）强制重拉三个当前源的 definition
  const refreshSourceDefs = async () => {
    const pairs: Array<[string, (d: any) => void]> = [
      [imageProvider, setImageProviderDef],
      [videoProvider, setVideoProviderDef],
      [audioProvider, setAudioProviderDef],
    ];
    await Promise.all(pairs.filter(([pid]) => !!pid).map(([pid, setDef]) =>
      apiService.getProvider(pid).then((r: any) => setDef(r?.provider || null)).catch(() => {})
    ));
  };

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
        if (productionMode === 'motion_comic') return;
        handleRegenerateImage();
        return;
      }

      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (productionMode === 'comic') return;
        handleGenerateVideo();
        return;
      }

      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (productionMode === 'comic') return;
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
  }, [activeShot?.id, project?.scenes, isPlayingAudio, isRegenerating, isGeneratingVid, candidateCount, productionMode]);

  if (!activeShot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm space-y-2 p-8">
        <span>请选择或添加分镜</span>
        {project && <button onClick={() => addShot(1)} className="px-3 py-1 rounded bg-brand text-white text-xs">新建分镜</button>}
      </div>
    );
  }

  const handlePlayTTS = async () => {
    // 漫画模式仅编辑对白文字：拦截试听配音
    if (productionMode === 'comic') { setTtsError('漫画模式仅编辑对白，切到视频模式再试听配音'); return; }
    const textToSpeak = activeShot.dialogue || activeShot.voiceover || '';
    if (!textToSpeak.trim()) { setTtsError('当前分镜无台词/旁白，无法配音'); return; }
    if (audioEl) { audioEl.pause(); setAudioEl(null); setIsPlayingAudio(false); }
    setTtsError(null);
    setIsPlayingAudio(true);
    updateShot(activeShot.id, { status: 'generating_audio', render_status: 'rendering' });
    try {
      const char = project?.characters.find((c) => c.name === activeShot.speaker_name);
      const voiceId = char?.voice_id;
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

  // 插槽写穿透：同一插槽的归一键与源真实键一起写，避免下游读到半更新状态
  const setSlotValue = (writeKeys: string[], value: any) => {
    const next = { ...shotDynamicInputs };
    writeKeys.forEach((k) => { next[k] = value; });
    setShotDynamicInputs(next);
    if (activeShot) updateShot(activeShot.id, { dynamic_inputs: next } as any);
  };

  const handleSlotUploadFile = async (writeKeys: string[], file: File, multi: boolean) => {
    const key = writeKeys[0];
    try {
      setUploadingInputKey(key);
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
      let value = '';
      if (isImage) {
        const res = await apiService.uploadImageToComfyUI(file);
        value = res?.name || '';
      } else {
        value = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(new Error('读取文件失败'));
          r.readAsDataURL(file);
        });
      }
      if (!value) throw new Error('上传未返回文件名');
      setSlotValue(writeKeys, multi ? [value] : value);
    } catch (e: any) {
      alert(`上传素材失败: ${e?.message || e}`);
    } finally {
      setUploadingInputKey(null);
    }
  };

  const injectCharacterToSlot = (writeKeys: string[], multi: boolean) => {
    const currentChar = project?.characters.find(c => c.name === activeShot.speaker_name) || project?.characters?.[0];
    const charImg = currentChar?.three_views?.front || currentChar?.avatar_url || currentChar?.three_views?.three_quarter;
    if (!charImg) {
      alert('当前角色未找到立绘或三视图图片，请在角色工坊生成');
      return;
    }
    setSlotValue(writeKeys, multi ? [charImg] : charImg);
  };

  const pickAssetForSlot = (slot: any, writeKeys: string[], multi: boolean) => {
    setSlotPicker({ slot, writeKeys, multi });
  };

  // 画布产出 / 角色库 / 素材库 / 本地上传 四源统一选择，多选时累积而非覆盖
  const handleSlotPicked = (urlOrUrls: string | string[], meta?: any) => {
    if (!slotPicker) return;
    const { writeKeys, multi } = slotPicker;
    const incoming = Array.isArray(urlOrUrls) ? urlOrUrls.filter(Boolean) : (urlOrUrls ? [urlOrUrls] : []);
    if (!incoming.length) return;
    let value: any;
    if (multi) {
      const cur = shotDynamicInputs[writeKeys[0]];
      const existing: string[] = Array.isArray(cur) ? cur : (cur ? [String(cur)] : []);
      const merged = [...existing];
      incoming.forEach((u) => { if (!merged.includes(u)) merged.push(u); });
      const max = slotPicker.slot?.maxCount;
      value = typeof max === 'number' && max > 0 ? merged.slice(-max) : merged;
    } else {
      value = incoming[incoming.length - 1];
    }
    setSlotValue(writeKeys, value);
    // 选中角色素材时顺带把形象词并入提示词，与画布行为一致
    if (meta?.visual_prompt && activeShot && !(activeShot.image_prompt || '').includes(meta.visual_prompt)) {
      updateShot(activeShot.id, { image_prompt: `${activeShot.image_prompt || ''}${activeShot.image_prompt ? ', ' : ''}${meta.visual_prompt}` } as any);
    }
    setSlotPicker(null);
  };

  // 源已提供逐节点独立槽时不再渲染聚合数组槽，避免同一节点两个入口、以及靠位置猜归属
  const resolveRenderSlots = (def: any, kind: 'image' | 'video' | 'audio') => {
    const all = extractSlotsFromProvider(def, kind);
    const perNode = all.filter((s: any) => !s.aggregate);
    if (perNode.length) return perNode;
    if (all.length) return all;
    return [{ key: 'reference_images', originalKey: 'reference_images', label: '参考图/垫图', type: 'image', multi: true, maxCount: 4 }];
  };

  // 语音源若自行声明了情绪参数（x-role: emotion），情绪就由源参数表单唯一负责，页面不再重复放一个下拉
  const audioEmotionKey = useMemo(() => {
    const props = (audioProviderDef?.params_schema?.properties || {}) as Record<string, any>;
    return Object.keys(props).find((k) => props[k]?.['x-role'] === 'emotion') || '';
  }, [audioProviderDef]);


  // 只提交该源声明过的键（input_schema + params_schema 的并集），杜绝切换源后残留上一源的参数；
  // 未选源（definition 为空）时原样放行，保持系统默认通道的旧行为。
  // LEGACY_SLOT_ALIASES：旧代码里的单数 / 带 _url 后缀写法，归并到源真正声明的槽位键。
  const LEGACY_SLOT_ALIASES: Record<string, string[]> = {
    reference_image: ['reference_images', 'reference'],
    first_frame_url: ['first_frame'],
    last_frame_url: ['last_frame'],
    reference_audio_url: ['reference_audio', 'reference_audios'],
  };

  const keepDeclaredOnly = (def: any, values: Record<string, any>): Record<string, any> => {
    const declared = new Set<string>([
      ...Object.keys(def?.input_schema?.properties || {}),
      ...Object.keys(def?.params_schema?.properties || {}),
    ]);
    if (!declared.size) return { ...values };
    const out: Record<string, any> = {};
    const put = (k: string, v: any) => {
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return;
      out[k] = v;
    };
    Object.entries(values).forEach(([k, v]) => {
      if (declared.has(k)) { put(k, v); return; }
      const alias = (LEGACY_SLOT_ALIASES[k] || []).find((a) => declared.has(a));
      if (alias) put(alias, v);
    });
    return out;
  };

  // 批量渲染取各分镜自己存下的插槽值与源参数（按该镜所选源，而非当前激活源）
  const shotBatchInputs = (sh: any, kind: 'image' | 'video') => {
    const merged: Record<string, any> = { ...(sh?.dynamic_inputs || {}) };
    Object.entries((sh?.provider_params?.[kind]) || {}).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) merged[k] = v;
    });
    return Object.keys(merged).length ? merged : undefined;
  };

  const handleRegenerateImage = async (customCount?: number) => {
    // 直出模式无需单张生图：角色立绘直接驱动视频，避免误触污染首帧
    if (productionMode === 'motion_comic') { setRegenError('直出模式无需生图，直接点「直出动态视频」'); return; }
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    setIsRegenerating(true);
    updateShot(activeShot.id, { status: 'generating_image', render_status: 'rendering' });

    // 角色标签 + 相机意图统一装配（shotReference 唯一口径）：全量绑定角色进 prompt，
    // 景别/运镜自动补后缀（已含 [Camera: / [运镜: 的不动，导演台保存的优先）
    let promptWithCharacters = withCameraIntent(
      promptWithCharacterTags(activeShot.image_prompt, activeShot, project),
      activeShot,
    );

    try {
      // 工作流来自所选生成源本身；仅在未选源时回退旧分镜遗留的 workflow_id
      const defWfId = (imageProviderDef as any)?.workflow_id || '';
      const imageWorkflowId = defWfId || (imageProvider ? '' : selectedWorkflowId);

      // 插槽值与源参数一并直传：params_schema 的 key 即暴露项原生 id，后端可直接落节点
      const mergedInputs: Record<string, any> = keepDeclaredOnly(imageProviderDef, shotDynamicInputs);
      Object.entries(imageProviderParams).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) mergedInputs[k] = v;
      });
      let dynamic_inputs: Record<string, any> | undefined = Object.keys(mergedInputs).length ? mergedInputs : undefined;

            // 参考装配（唯一口径）：全量绑定角色 + 场景底图 + 白模截图；用户手填优先，不覆盖
      const shotRefs = buildShotReferenceInputs(activeShot, project, 'image');
      if (shotRefs.reference_images.length) {
        const di: any = dynamic_inputs || {};
        dynamic_inputs = {
          ...di,
          reference_image: di.reference_image || di.reference_images || shotRefs.reference_image,
          reference_images: di.reference_images || di.reference_image || shotRefs.reference_images,
          character_weight: di.character_weight ?? shotRefs.character_weight,
          ...(di.character_weights || shotRefs.character_weights ? { character_weights: { ...(shotRefs.character_weights || {}), ...(di.character_weights || {}) } } : {}),
        };
      }

      const count = customCount || candidateCount;
      if (count === 4) {
        const seeds = [Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000), Math.floor(Math.random()*1000000)];
        const reqs = seeds.map(s => apiService.generateShotImage({
          prompt: promptWithCharacters,
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: imageWorkflowId || undefined,
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
          workflow_id: imageWorkflowId || undefined,
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
      // 参数由源自身清单生成，不再出现"工作流不支持某参数"的静默忽略，一律如实上报
      setRegenError(msg);
      updateShot(activeShot.id, { status: 'error', render_status: 'error', render_error: msg });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleGenerateVideo = async () => {
    // 漫画模式为纯生图流：拦截视频生成（含快捷键/兜底入口）
    if (productionMode === 'comic') {
      setVideoError('漫画模式仅生图，切到「漫剧制作 / 图生视频」再生成动态视频');
      return;
    }
    const rawPrompt = activeShot.video_prompt?.trim() || activeShot.action_desc || activeShot.image_prompt;
    // 相机意图兜底：没去过导演台也按分镜自身景别/运镜补后缀（已有 [Camera: / [运镜: 的不动）
    const prompt = withCameraIntent(rawPrompt, activeShot);
    if (!prompt) {
      setVideoError('请填写视频运动运镜提示词');
      return;
    }

    // 直出（多参考 r2v）只吃绑定：角色/场景/道具进参考槽，旧首帧一律不注入；
    // 图生（i2v）才用真首帧。无绑定的直出走 t2v。
    const isDirect = productionMode === 'motion_comic';
    const shotRefs = buildShotReferenceInputs(activeShot, project, 'video');
    const refImage = isDirect ? '' : (activeShot.image_url || '');
    const hasVideoRefs = shotRefs.reference_images.length > 0;

    if (productionMode === 'image_to_video' && !activeShot.image_url) {
      setVideoError('图生视频模式需要先在步骤 1 生成精控首帧画面');
      return;
    }

    setVideoError(null);
    setIsGeneratingVid(true);
    updateShot(activeShot.id, { status: 'generating_video', render_status: 'rendering' });
    try {
      // 工作流来自所选视频源本身；仅在未选源时回退旧分镜遗留的 workflow_id
      const defVideoWfId = (videoProviderDef as any)?.workflow_id || '';
      const videoWorkflowId = defVideoWfId || (videoProvider ? '' : selectedWorkflowId);

      const merged: Record<string, any> = {
        ...(shotRefs.reference_images.length ? { reference_images: shotRefs.reference_images, reference_image: shotRefs.reference_images[0] } : {}),
        ...(shotRefs.character_weight !== undefined ? { character_weight: shotRefs.character_weight } : {}),
        ...(shotRefs.character_weights ? { character_weights: shotRefs.character_weights } : {}),
        ...(shotRefs.previz_video_url ? { previz_video_url: shotRefs.previz_video_url } : {}),
        ...keepDeclaredOnly(videoProviderDef, shotDynamicInputs),
      };
      if (refImage) {
        // 首帧喂给哪个键：按该源 input_schema 声明的插槽，无声明再回退 first_frame_url
        const vSlots = extractSlotsFromProvider(videoProviderDef, 'video');
        const ffSlot = vSlots.find(s => s.key === 'first_frame' || (s.originalKey || '').toLowerCase().includes('first'));
        const ffKey = ffSlot?.originalKey || ffSlot?.key || 'first_frame_url';
        if (!merged[ffKey]) merged[ffKey] = refImage;
        if (ffSlot && ffSlot.key !== ffSlot.originalKey && !merged[ffSlot.key]) merged[ffSlot.key] = refImage;
      }
      Object.entries(videoProviderParams).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) merged[k] = v;
      });
      const dynamic_inputs = Object.keys(merged).length ? merged : undefined;
      await generateShotVideo(activeShot.id, {
        mode: isDirect ? (hasVideoRefs ? 'r2v' : 't2v') : 'i2v',
        prompt,
        duration: Math.round(activeShot.duration) || 5,
        provider: videoProvider,
        workflow_id: videoWorkflowId || undefined,
        dynamic_inputs,
        omit_first_frame: isDirect,
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
        // 批量与单镜同口径：角色标签 + 相机意图进 prompt，全量参考进 inputs
        const bRefs = buildShotReferenceInputs(sh, project, 'image');
        const bInputs: Record<string, any> = {
          ...(bRefs.reference_images.length ? { reference_images: bRefs.reference_images, reference_image: bRefs.reference_images[0] } : {}),
          ...(bRefs.character_weight !== undefined ? { character_weight: bRefs.character_weight } : {}),
          ...(bRefs.character_weights ? { character_weights: bRefs.character_weights } : {}),
          ...shotBatchInputs(sh, 'image'),
        };
        const res = await apiService.generateShotImage({
          prompt: withCameraIntent(promptWithCharacterTags(sh.image_prompt, sh, project), sh),
          aspect_ratio: project?.aspect_ratio || '9:16',
          style_preset: project?.style_preset,
          workflow_id: (sh as any).workflow_id || undefined,
          provider: prov || undefined,
          dynamic_inputs: bInputs,
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
        const voiceId = char?.voice_id;
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

  // 分镜 → 画布：使用新画布 / 隶属到现有画布（视频在该画布生成后回写分镜）。
  // payload 去掉 dataURL 级大字段，避免 localStorage 配额爆炸。
  const sendShotToCanvas = (shot: any, opts: { mode: 'new' | 'existing'; canvas_id?: string }) => {
    if (!shot?.id) return;
    const cp: any = { ...shot };
    if (typeof cp.previz_url === 'string' && cp.previz_url.startsWith('data:')) delete cp.previz_url;
    const payload = {
      shot: cp,
      projectId: project?.id,
      nonce: Date.now(),
      mode: opts.mode,
      canvas_id: opts.canvas_id,
      canvas_name: opts.mode === 'new' ? `分镜#${shot.shot_index || ''}画布` : undefined,
      autoRun: true,
    };
    try { localStorage.setItem('canvas_pending_shot', JSON.stringify(payload)); } catch {}
    // 必须同时切换工作台到 creative，否则 App 仍停留在 production 视图，画布挂载后由兜底消费 pending
    try { setWorkspace('creative'); } catch {}
    setActiveTab('canvas' as any);
    try { window.dispatchEvent(new CustomEvent('canvas-import-shot', { detail: payload })); } catch {}
    setCtxMenu(null);
  };

  const openShotCtxMenu = async (e: React.MouseEvent, shot: any) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveShotId(shot.id);
    const x = Math.min(e.clientX, window.innerWidth - 250);
    const y = Math.min(e.clientY, window.innerHeight - 260);
    setCtxMenu({ x, y, shotId: shot.id });
    setCtxCanvases([]);
    setCtxLoadingCanvas(true);
    try {
      if (project?.id) {
        const r = await apiService.listProjectCanvases(project.id);
        setCtxCanvases(r.canvases || []);
      }
    } catch {} finally { setCtxLoadingCanvas(false); }
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
        // 批量与单镜同口径：直出镜跳过旧首帧（纯绑定驱动 r2v/t2v），图生镜首帧只放真首帧
        const shDirect = ((sh as any).production_mode || productionMode) === 'motion_comic';
        const bvRefs = buildShotReferenceInputs(sh, project, 'video');
        const bvInputs: Record<string, any> = {
          ...(bvRefs.reference_images.length ? { reference_images: bvRefs.reference_images, reference_image: bvRefs.reference_images[0] } : {}),
          ...(bvRefs.character_weight !== undefined ? { character_weight: bvRefs.character_weight } : {}),
          ...(bvRefs.character_weights ? { character_weights: bvRefs.character_weights } : {}),
          ...(!shDirect && bvRefs.first_frame_url ? { first_frame_url: bvRefs.first_frame_url } : {}),
          ...(bvRefs.previz_video_url ? { previz_video_url: bvRefs.previz_video_url } : {}),
          ...shotBatchInputs(sh, 'video'),
        };
        // 直出镜若调用方残留首帧键也一并剥离，避免旧图污染
        if (shDirect) {
          for (const k of Object.keys(bvInputs)) {
            if (/first/i.test(k)) delete bvInputs[k];
          }
        }
        await generateShotVideo(sh.id, {
          mode: shDirect ? (bvRefs.reference_images.length ? 'r2v' : 't2v') : videoMode,
          prompt: withCameraIntent(sh.video_prompt || sh.action_desc || sh.image_prompt, sh),
          duration: Math.round(sh.duration) || 5,
          provider: prov,
          workflow_id: (sh as any).workflow_id || undefined,
          dynamic_inputs: bvInputs,
          omit_first_frame: shDirect,
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
          {productionMode !== 'motion_comic' && (
          <button onClick={handleBatchAllImages} className="flex-1 py-1 rounded-lg bg-brand/20 hover:bg-brand/30 border border-brand/30 text-brand-light font-bold flex items-center justify-center gap-1 transition-all" title="对所有选中/全部镜头批量并发生成画面">
            <Sparkles className="w-3 h-3 text-brand" /> 批量生图
          </button>
          )}
          {productionMode !== 'comic' && (
          <button onClick={handleBatchAllTTS} className="flex-1 py-1 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/30 text-pink-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量合成全剧台词配音">
            <Volume2 className="w-3 h-3 text-pink-400" /> 批量配音
          </button>
          )}
          {productionMode !== 'comic' && (
          <button onClick={handleBatchAllVideos} className="flex-1 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 font-bold flex items-center justify-center gap-1 transition-all" title="批量转为动态视频">
            <Film className="w-3 h-3 text-orange-400" /> 批量视频
          </button>
          )}
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
                onContextMenu={(e) => openShotCtxMenu(e, shot)}
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

        <div className="relative max-h-[60vh] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-border/80 group bg-black" style={{ aspectRatio: previewAspect }}>
          {effectivePreviewTab === 'video' ? (
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
              <div className="w-full h-full min-h-[30vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-6 text-center">
                <Film className="w-10 h-10 text-accent-orange/60" />
                <span className="font-semibold text-white">当前分镜尚未生成动态视频</span>
                {productionMode === 'motion_comic' && buildShotReferenceInputs(activeShot, project, 'video').reference_images.length === 0 && (
                  <span className="text-[11px] text-amber-300">⚠️ 尚未绑定角色 / 场景，直接生成将退为文生视频</span>
                )}
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
            <div className="w-full h-full min-h-[30vh] bg-surface-secondary flex flex-col items-center justify-center text-gray-400 text-xs space-y-3 p-4 text-center">
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
            {activeShot.video_url && effectivePreviewTab==='video' && (
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
            <button onClick={(e)=> {
              if (activeShot) openShotCtxMenu(e as any, activeShot);
            }} className="p-1.5 rounded-lg bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand" title="发送到无限画布：使用新画布 / 隶属画布，视频生成后回写"><Layers className="w-3.5 h-3.5"/></button>
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

              {/* 4. 生图源专属表单（直出模式隐藏：立绘直驱视频，无需单张生图） */}
              {productionMode === 'motion_comic' && (
                <div className="text-[11px] text-gray-500 bg-surface-secondary/60 border border-border rounded-lg px-2.5 py-1.5">直出模式跳过生图：绑定上方角色 / 场景 / 道具后，直接去「运镜动态」页生成参考生视频</div>
              )}
              {productionMode !== 'motion_comic' && (
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

                {/* 源声明的输入区：提示词 + 媒体插槽，全部来自该源 input_schema，零写死模板 */}
                {(() => {
                  const def: any = imageProviderDef;
                  const inProps = def?.input_schema?.properties || {};
                  const promptLabel = String(inProps?.prompt?.title || inProps?.prompt?.description || '正向生图提示词');
                  const slots: any[] = resolveRenderSlots(def, 'image');
                  return (
                    <div className="space-y-2.5">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-gray-300 font-semibold">
                          <span className="truncate" title={promptLabel}>{promptLabel}</span>
                          <span className="flex items-center gap-2 shrink-0">
                            {def?.workflow_id && (
                              <button onClick={() => setInspectingWorkflowId(def.workflow_id)} className="text-[10px] font-normal text-brand-light hover:underline flex items-center gap-1" title="编辑该工作流的暴露清单">
                                <Sliders className="w-3 h-3" /> 参数与暴露
                              </button>
                            )}
                            <span className="text-[10px] text-gray-500 font-mono">{activeShot.image_prompt?.length || 0} 字</span>
                          </span>
                        </div>
                        <textarea
                          value={activeShot.image_prompt}
                          onChange={(e) => updateShot(activeShot.id, { image_prompt: e.target.value })}
                          rows={3}
                          className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                          placeholder={inProps?.prompt?.description ? `${inProps.prompt.description}...` : '输入画面提示词...'}
                        />
                      </div>

                      <ProviderSlotList
                        slots={slots}
                        values={shotDynamicInputs}
                        uploadingKey={uploadingInputKey}
                        onWrite={setSlotValue}
                        onUpload={handleSlotUploadFile}
                        onPickFromLibrary={pickAssetForSlot}
                        onInjectCharacter={injectCharacterToSlot}
                        resolveUrl={getMediaUrl}
                      />
                    </div>
                  );
                })()}

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
              )}

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

                {/* 漫画模式仅编辑对白文字：隐藏语音源/TTS试听（切到漫剧/图生模式可配音） */}
                {productionMode === 'comic' && (
                  <div className="text-[11px] text-gray-500 bg-surface-secondary/60 border border-border rounded-lg px-2.5 py-1.5">漫画模式仅编辑对白与字幕，切到「漫剧制作 / 图生视频」可配音</div>
                )}
                {productionMode !== 'comic' && (
                  <>
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
                        // 源自行声明情绪时，把值同步回镜头情绪字段（配音与剪映导出都读镜头上的 emotion）
                        const emo = audioEmotionKey ? next[audioEmotionKey] : undefined;
                        updateShot(activeShot.id, {
                          provider_params: { ...(activeShot as any).provider_params, audio: next },
                          ...(emo ? { emotion: emo as EmotionType } : {}),
                        } as any);
                      }}
                    />
                  </div>
                )}
                  </>
                )}

                <div className="flex items-center gap-2">
                  <select value={activeShot.speaker_name || project?.characters[0]?.name || ''} onChange={(e) => updateShot(activeShot.id, { speaker_name: e.target.value })} className="flex-1 bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                    {project?.characters.map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                  {!audioEmotionKey && (
                    <select value={activeShot.emotion} onChange={(e) => updateShot(activeShot.id, { emotion: e.target.value as EmotionType })} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                      {/* 情绪选项 = 所选语音源 params_schema.emotion 声明的枚举；源未声明时回退系统 EmotionType 域模型 */}
                      {(['neutral', 'intense', 'sorrow', 'excited', 'fearful', 'whispering'] as string[]).map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  )}
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

                {productionMode !== 'comic' && (
                  <>
                <button onClick={handlePlayTTS} disabled={isPlayingAudio} className="w-full py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-violet-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-md shadow-pink-500/20 hover:opacity-95 disabled:opacity-40">
                  <Volume2 className={`w-3.5 h-3.5 ${isPlayingAudio ? 'animate-bounce' : ''}`} />
                  <span>{isPlayingAudio ? '合成并播放中...' : '试听配音 (按 T 快捷生成)'}</span>
                </button>
                {ttsError && <div className="text-xs text-red-300">{ttsError}</div>}
                {activeShot.audio_url && <audio controls src={getMediaUrl(activeShot.audio_url)} className="w-full mt-1" />}
                  </>
                )}
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

              {/* 直出模式锁定参考生视频：i2v/t2v 切卡隐藏，有无参考由生成时自动判定 r2v/t2v */}
              {productionMode === 'motion_comic' && (
                <div className="text-[11px] font-bold text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded-lg px-2.5 py-1.5">📌 参考生视频 (R2V)：上方绑定的角色 / 场景 / 道具自动作为多参考驱动</div>
              )}
              {productionMode !== 'motion_comic' && (
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
              )}

              <ProviderPicker
                kind="video"
                value={videoProvider}
                capability={productionMode === 'image_to_video' ? 'i2v' : productionMode === 'motion_comic' ? 'r2v' : undefined}
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

              {/* 视频源声明的素材插槽（首帧由分镜图自动供给，其余按 input_schema 逐条挂载） */}
              {(() => {
                const vSlots = resolveRenderSlots(videoProviderDef, 'video')
                  .filter((s: any) => s.role !== 'first_frame' && s.key !== 'first_frame');
                return (
                  <ProviderSlotList
                    slots={vSlots}
                    values={shotDynamicInputs}
                    uploadingKey={uploadingInputKey}
                    onWrite={setSlotValue}
                    onUpload={handleSlotUploadFile}
                    onPickFromLibrary={pickAssetForSlot}
                    resolveUrl={getMediaUrl}
                  />
                );
              })()}

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

              {(() => {
                // 时长是镜头属性，滑杆始终保留；但名称与可拖动范围取自该源声明的 duration 参数（未声明则用镜头通用范围）
                const props = (videoProviderDef?.params_schema?.properties || {}) as Record<string, any>;
                const durKey = Object.keys(props).find((k) => k === 'duration' || props[k]?.['x-std-key'] === 'duration');
                const dur = durKey ? props[durKey] : null;
                return (
                  <>
                    <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
                      <span>{dur?.title || '镜头时长'}: <b className="text-orange-400">{Math.round(activeShot.duration)}s</b></span>
                      {dur && <span className="text-[10px] text-gray-500 font-mono">{dur.minimum}~{dur.maximum}s 由该源声明</span>}
                    </div>
                    <input
                      type="range"
                      min={dur?.minimum ?? 1}
                      max={dur?.maximum ?? 30}
                      step={dur?.step ?? 1}
                      value={Math.round(activeShot.duration)}
                      onChange={(e) => updateShot(activeShot.id, { duration: parseFloat(e.target.value) })}
                      className="w-full accent-orange-500"
                    />
                  </>
                );
              })()}

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
            loadProjectAssets();
            // 暴露清单变了 → 该工作流对应生成源的 schema 已在后端重建，必须重新拉 definition 才能反映到表单
            refreshSourceDefs();
            window.dispatchEvent(new Event('provider-list-refresh'));
          }}
          onDeleted={() => {
            loadProjectAssets();
            refreshSourceDefs();
            window.dispatchEvent(new Event('provider-list-refresh'));
          }}
        />
      )}

      {/* 生成源插槽素材选择：画布产出 / 角色库 / 素材库 / 本地上传 */}
      {slotPicker && (
        <CanvasResourcePickerModal
          isOpen={!!slotPicker}
          onClose={() => setSlotPicker(null)}
          onSelect={handleSlotPicked}
          slotKey={slotPicker.writeKeys[0]}
          slotLabel={slotPicker.slot?.label}
          multiSelect={slotPicker.multi}
          acceptType={slotPicker.slot?.type || 'image'}
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

      {/* 分镜右键菜单：使用新画布 / 隶属到现有画布（视频在该画布生成后回写分镜） */}
      {ctxMenu && (() => {
        const shot: any = shots.find((s: any) => s.id === ctxMenu.shotId);
        if (!shot) return null;
        const affil = ctxCanvases.find(c => c.id === shot.canvas_id);
        return (
          <div className="fixed inset-0 z-[70]" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }}>
            <div className="absolute w-60 rounded-xl bg-surface border border-border shadow-2xl p-1.5 space-y-0.5" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
              <div className="px-2.5 py-1.5 text-[11px] font-bold text-gray-400">分镜 #{shot.shot_index}{affil ? ` · 隶属「${affil.name}」` : ''}</div>
              <button onClick={() => sendShotToCanvas(shot, { mode: 'new' })} className="w-full text-left px-2.5 py-2 rounded-lg text-xs text-white hover:bg-brand/20 flex items-center gap-2"><Plus className="w-3.5 h-3.5 text-brand-light" /><span>使用新画布生成视频</span></button>
              <div className="px-2.5 pt-1.5 text-[10px] text-gray-500 font-bold">隶属到现有画布</div>
              {ctxLoadingCanvas && <div className="px-2.5 py-1.5 text-[11px] text-gray-500">加载画布列表…</div>}
              {!ctxLoadingCanvas && ctxCanvases.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-gray-500">暂无画布（先用新画布）</div>}
              {ctxCanvases.map(c => (
                <button key={c.id} onClick={() => sendShotToCanvas(shot, { mode: 'existing', canvas_id: c.id })} className="w-full text-left px-2.5 py-2 rounded-lg text-xs text-gray-200 hover:bg-brand/20 flex items-center gap-2 truncate">
                  <Layers className="w-3.5 h-3.5 text-gray-500" />
                  <span className="truncate">{shot.canvas_id === c.id ? '✓ ' : ''}{c.name}（{c.node_count}节点）</span>
                </button>
              ))}
              <div className="px-2.5 py-1.5 text-[10px] text-gray-600 leading-4">视频在所选画布自动生成后回写本分镜</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
