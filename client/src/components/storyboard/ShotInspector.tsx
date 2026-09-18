import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { StoryboardShot } from '../../types';
import { apiService } from '../../services/api';
import { extractSlotsFromProvider } from '../canvas/providerSkills';
import { buildShotReferenceInputs, promptWithCharacterTags, withCameraIntent } from './shotReference';
import { getMode } from './slots/registry';
import { registerBuiltinSlots } from './slots/builtin';
import { syncStoryboardSlots } from './slots/loader';
import { ShotListRail } from './slots/ShotListRail';
import { PreviewStage } from './slots/PreviewStage';
import { InspectorPanel } from './slots/InspectorPanel';
import { ShotOverlays } from './slots/Overlays';
import { SlotManagerModal } from './slots/SlotManagerModal';
import type { ProductionMode, ShotSlotContext } from './slots/types';

const API_ORIGIN = 'http://127.0.0.1:8000';

// 内置 Slot 注册（P0）：P1 时替换为插件 slots/*.json 加载，宿主不动
registerBuiltinSlots();

// 批量生成的并发上限（镜头间并行，防止一次性打爆外部源的并发配额）
const BATCH_CONCURRENCY = 3;

// 受限并发执行：所有镜头并行推进，最多同时 BATCH_CONCURRENCY 个
async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }));
}

// Set<shotId> 增删：生成态按镜头隔离
const addShotId = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
  setter((prev) => { const next = new Set(prev); next.add(id); return next; });
const removeShotId = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
  setter((prev) => { const next = new Set(prev); next.delete(id); return next; });

/**
 * 分镜工作台宿主（ShotInspector）。
 * P0 重构：本文件只拥有状态 + 数据 handler + 快捷键 + ctx 组装；
 * 所有渲染经 slots/ 注册表（左场记栏 / 中央预览台 / 右检查器 / 浮层）。
 * 渲染逻辑与条件与重构前逐行一致，零行为变化。
 */
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
    synthesizeShotPrompt,
    selectCandidate,
    autoFitShotDuration,
  } = useProjectStore();

  const [previewTab, setPreviewTab] = useState<'image' | 'video'>(
    (localStorage.getItem('storyboard_preview_tab') as any) || 'image'
  );
  const [inspectorTab, setInspectorTab] = useState<'dialogue' | 'visual' | 'motion'>(
    (localStorage.getItem('storyboard_inspector_tab') as any) || 'visual'
  );
  const [productionMode, setProductionMode] = useState<ProductionMode>('image_to_video');
  // 三模式预览锁定收敛到模式 caps：漫画锁图、直出锁视频、图生可切（避免跨模式串台）
  const effectivePreviewTab = getMode(productionMode).caps.lockPreview ?? previewTab;
  // 预览框跟随项目画幅（9:16 / 16:9 / 1:1），不再写死竖屏
  const previewAspect = (project?.aspect_ratio || '9:16').replace(':', '/');
  // 生成/播放态按镜头隔离：A 镜头生成中不锁死 B 镜头（多镜可并行提交与轮询）
  const [imageGenIds, setImageGenIds] = useState<Set<string>>(new Set());
  const [videoGenIds, setVideoGenIds] = useState<Set<string>>(new Set());
  const [audioPlayingIds, setAudioPlayingIds] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
  const [showHotkeysHint, setShowHotkeysHint] = useState(true);
  const [savingAsset, setSavingAsset] = useState(false);
  // P1 插件槽：弹窗开关 + 注册表版本号（同步后 bump 触发重渲染）
  const [slotMgrOpen, setSlotMgrOpen] = useState(false);
  const [, setSlotsRev] = useState(0);

  // 旧分镜可能只存了 workflow_id 而没选源，仅作为未选源时的兜底
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    localStorage.getItem('default_workflow_id') || ''
  );
  const [shotDynamicInputs, setShotDynamicInputs] = useState<Record<string, any>>({});
  const [inspectingWorkflowId, setInspectingWorkflowId] = useState<string>('');
  const [_projectAssets, setProjectAssets] = useState<any[]>([]);
  const [uploadingInputKey, setUploadingInputKey] = useState<string | null>(null);
  // 生成源插槽的素材选择（复用画布的四源选择器，支持多选累积）
  const [slotPicker, setSlotPicker] = useState<{ slot: any; writeKeys: string[]; multi: boolean } | null>(null);

  // 语音源若自行声明了情绪参数（x-role: emotion），情绪就由源参数表单唯一负责
  // NOTE：必须在 early return 之前调用（hooks 顺序），仅依赖 audioProviderDef
  const audioEmotionKey = useMemo(() => {
    const props = (audioProviderDef?.params_schema?.properties || {}) as Record<string, any>;
    return Object.keys(props).find((k) => props[k]?.['x-role'] === 'emotion') || '';
  }, [audioProviderDef]);

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

  // 按镜头派生：只有"当前镜头"在生成/播放时才禁用其按钮，其他镜头可并行操作
  const isRegenerating = activeShot ? imageGenIds.has(activeShot.id) : false;
  const isGeneratingVid = activeShot ? videoGenIds.has(activeShot.id) : false;
  const isPlayingAudio = activeShot ? audioPlayingIds.has(activeShot.id) : false;

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

  // P1：随项目同步插件槽声明（内置不受影响，动态槽精确重载）
  useEffect(() => {
    let cancelled = false;
    syncStoryboardSlots(project?.id)
      .then(() => { if (!cancelled) setSlotsRev((v) => v + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project?.id]);

  const loadProjectAssets = async () => {
    try {
      const pid = project?.id || (useProjectStore.getState() as any).activeProjectId || undefined;
      const assetRes = await apiService.listAssets({ project_id: pid, page: 1, limit: 100, scope: undefined });
      setProjectAssets(assetRes?.assets || []);
    } catch { /* ignore */ }
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
        if (getMode(productionMode).caps.canImage === false) return;
        handleRegenerateImage();
        return;
      }

      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (getMode(productionMode).caps.canVideo === false) return;
        handleGenerateVideo();
        return;
      }

      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (getMode(productionMode).caps.canTts === false) return;
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
    const shot = activeShot;
    if (!shot) return;
    // 漫画模式仅编辑对白文字：拦截试听配音
    if (getMode(productionMode).caps.canTts === false) { setTtsError('漫画模式仅编辑对白，切到视频模式再试听配音'); return; }
    const textToSpeak = shot.dialogue || shot.voiceover || '';
    if (!textToSpeak.trim()) { setTtsError('当前分镜无台词/旁白，无法配音'); return; }
    // 播放器单例（起新的先停旧的），生成/播放态按镜头隔离：不同镜头可并行合成
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setAudioPlayingIds(new Set());
    setTtsError(null);
    addShotId(setAudioPlayingIds, shot.id);
    updateShot(shot.id, { status: 'generating_audio', render_status: 'rendering' });
    try {
      const char = project?.characters.find((c) => c.name === shot.speaker_name);
      const voiceId = char?.voice_id;
      const extraParams: any = { ...audioProviderParams };
      const res = await apiService.generateTTS(textToSpeak, voiceId, shot.emotion, { provider: audioProvider || undefined, ...extraParams });
      const url = res.audio_url?.startsWith('/') ? API_ORIGIN + res.audio_url : res.audio_url;
      if (!res.audio_url) throw new Error('TTS 未返回音频地址');

      const audioSec = res.duration || (res.audio_duration ? res.audio_duration : 3.5);
      const fittedSec = Math.max(1.5, Math.round((audioSec + 0.4) * 10) / 10);

      updateShot(shot.id, {
        audio_url: res.audio_url,
        audio_duration: audioSec,
        duration: fittedSec,
        status: 'completed',
        render_status: 'done'
      });

      setAutoFitNotification(`🎯 镜头时长已智能对齐为 ${fittedSec}s（配音 ${audioSec.toFixed(1)}s + 0.4s 留白）`);
      setTimeout(() => setAutoFitNotification(null), 4000);

      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => { if (audioRef.current === a) audioRef.current = null; removeShotId(setAudioPlayingIds, shot.id); };
      a.onerror = () => { setTtsError('音频播放失败，请检查后端存储'); if (audioRef.current === a) audioRef.current = null; removeShotId(setAudioPlayingIds, shot.id); };
      await a.play();
    } catch (e: any) {
      setTtsError(e?.message || '配音生成失败');
      updateShot(shot.id, { status: 'error', render_status: 'error' });
      removeShotId(setAudioPlayingIds, shot.id);
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
  // （实现已上移至 early return 之前，见顶部 NOTE）


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
    if (getMode(productionMode).caps.canImage === false) { setRegenError('直出模式无需生图，直接点「直出动态视频」'); return; }
    if (!activeShot.image_prompt?.trim()) { setRegenError('生图提示词为空'); return; }
    setRegenError(null);
    addShotId(setImageGenIds, activeShot.id);
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
      removeShotId(setImageGenIds, activeShot.id);
    }
  };

  const handleGenerateVideo = async () => {
    // 漫画模式为纯生图流：拦截视频生成（含快捷键/兜底入口）
    if (getMode(productionMode).caps.canVideo === false) {
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
    const caps = getMode(productionMode).caps;
    const isDirect = caps.direct;
    const shotRefs = buildShotReferenceInputs(activeShot, project, 'video');
    const refImage = isDirect ? '' : (activeShot.image_url || '');
    const hasVideoRefs = shotRefs.reference_images.length > 0;

    if (caps.needsFirstFrame && !activeShot.image_url) {
      setVideoError('图生视频模式需要先在步骤 1 生成精控首帧画面');
      return;
    }

    setVideoError(null);
    addShotId(setVideoGenIds, activeShot.id);
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
      removeShotId(setVideoGenIds, activeShot.id);
    }
  };

  const handleBatchAllImages = async () => {
    const targetShots = batchSelected.size > 0 ? shots.filter(s => batchSelected.has(s.id)) : shots;
    if (targetShots.length === 0) return;
    const ids = targetShots.map(s => s.id);
    const jobs = ids.map(id => ({ id, type: 'image' as const, status: 'queued' as const }));
    setQueue(q => [...q, ...jobs]);
    await runLimited(targetShots, BATCH_CONCURRENCY, async (sh) => {
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
    });
    setTimeout(() => setQueue(q => q.filter(j => !ids.includes(j.id))), 4000);
  };

  const handleBatchAllTTS = async () => {
    const targetShots = batchSelected.size > 0 ? shots.filter(s => batchSelected.has(s.id)) : shots.filter(s => (s.dialogue || s.voiceover));
    if (targetShots.length === 0) { alert('没有需要配音的分镜（台词为空）'); return; }
    const ids = targetShots.map(s => s.id);
    const jobs = ids.map(id => ({ id, type: 'audio' as const, status: 'queued' as const }));
    setQueue(q => [...q, ...jobs]);
    await runLimited(targetShots, BATCH_CONCURRENCY, async (sh) => {
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
    });
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
    await runLimited(targetShots, BATCH_CONCURRENCY, async (sh) => {
      setQueue(q => q.map(j => j.id === sh.id ? { ...j, status: 'running' } : j));
      try {
        const prov = (sh as any).video_provider || videoProvider;
        // 批量与单镜同口径：直出镜跳过旧首帧（纯绑定驱动 r2v/t2v），图生镜首帧只放真首帧
        const shCaps = getMode(((sh as any).production_mode || productionMode) as ProductionMode).caps;
        const shDirect = shCaps.direct;
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
    });
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

  const getMediaUrl = (url?: string | null) => {
    if (!url) return '';
    return url.startsWith('/') ? API_ORIGIN + url : url;
  };

  // ---- Slot 上下文组装（宿主唯一出口，P1 插件槽按此接口拿数） ----
  const ctx: ShotSlotContext = {
    project, shots, activeShot,
    setActiveShotId, updateShot, addShot, duplicateShot, deleteShot,
    setActiveTab, setWorkspace, generateShotVideo,
    bindCharacterToShot, unbindCharacterFromShot, setCharacterWeight,
    bindSceneToShot, unbindSceneFromShot, bindPropToShot,
    synthesizeShotPrompt, selectCandidate, autoFitShotDuration,
    previewTab, setPreviewTab, effectivePreviewTab, previewAspect,
    inspectorTab, setInspectorTab: (t: string) => setInspectorTab(t as any),
    productionMode, setProductionMode,
    isPlayingAudio, isRegenerating, isGeneratingVid,
    candidateCount, setCandidateCount, videoMode, setVideoMode,
    videoProvider,
    setVideoProvider: (pid: string, def?: any) => { setVideoProvider(pid); setVideoProviderDef(def || null); },
    videoProviderDef, videoProviderParams, setVideoProviderParams,
    imageProvider,
    setImageProvider: (pid: string, def?: any) => { setImageProvider(pid); setImageProviderDef(def || null); },
    imageProviderDef, imageProviderParams, setImageProviderParams,
    audioProvider,
    setAudioProvider: (pid: string, def?: any) => { setAudioProvider(pid); setAudioProviderDef(def || null); },
    audioProviderDef, audioProviderParams, setAudioProviderParams,
    audioEmotionKey, healthMap, batchSelected, setBatchSelected, queue,
    ttsError, regenError, videoError, videoSuccess, autoFitNotification,
    uploadingInputKey, savingAsset, shotDynamicInputs, setShotDynamicInputs,
    showHotkeysHint, setShowHotkeysHint,
    inspectingWorkflowId, setInspectingWorkflowId,
    slotPicker, setSlotPicker, assetPickerConfig, setAssetPickerConfig,
    ctxMenu, setCtxMenu, ctxCanvases, ctxLoadingCanvas,
    handlePlayTTS, handleRegenerateImage, handleGenerateVideo,
    handleBatchAllImages, handleBatchAllTTS, handleBatchAllVideos,
    handleSaveShotToAsset, sendShotToCanvas, openShotCtxMenu,
    setSlotValue, handleSlotUploadFile, injectCharacterToSlot, pickAssetForSlot,
    handleSlotPicked, resolveRenderSlots, keepDeclaredOnly, shotBatchInputs,
    probeProvider, refreshSourceDefs, loadProjectAssets, getMediaUrl,
    openSlotManager: () => setSlotMgrOpen(true),
  };

  return (
    <div className="flex-1 flex gap-3 p-3 overflow-hidden bg-background relative">
      <ShotListRail ctx={ctx} />
      <PreviewStage ctx={ctx} />
      <InspectorPanel ctx={ctx} />
      <ShotOverlays ctx={ctx} />
      {slotMgrOpen && (
        <SlotManagerModal
          projectId={project?.id}
          onClose={() => setSlotMgrOpen(false)}
          onChanged={() => {
            syncStoryboardSlots(project?.id)
              .then(() => setSlotsRev((v) => v + 1))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
};
