import React, { useEffect, useRef, useState } from 'react';
import { Search, Plus, Layers, Users, Mountain, Box, Image as ImageIcon, Sparkles, Copy, Trash2, Tag, Filter, Library, Upload, Wand2, X, Loader2, Check, Files, Pencil, Save, Edit3, Clapperboard, Send, FileText } from 'lucide-react';
import { useAssetStore } from '../../stores/useAssetStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { apiService } from '../../services/api';
import { AssetCategory } from '../../types';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

const CATEGORY_TABS: { key: AssetCategory | 'all'; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Library className="w-3.5 h-3.5" /> },
  { key: 'character', label: '人物', icon: <Users className="w-3.5 h-3.5" /> },
  { key: 'scene', label: '场景', icon: <Mountain className="w-3.5 h-3.5" /> },
  { key: 'prop', label: '道具', icon: <Box className="w-3.5 h-3.5" /> },
  { key: 'background', label: '背景', icon: <ImageIcon className="w-3.5 h-3.5" /> },
  { key: 'effect', label: '特效', icon: <Sparkles className="w-3.5 h-3.5" /> },
  { key: 'previz', label: '预演', icon: <Clapperboard className="w-3.5 h-3.5" /> },
  { key: 'text', label: '提示词', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'other', label: '其他', icon: <Layers className="w-3.5 h-3.5" /> },
];

import { API_ORIGIN } from '../../utils/devOrigin';
const resolveUrl = (u?: string) => u && u.startsWith('/') ? API_ORIGIN + u : u;

export const AssetLibrary: React.FC = () => {
  const { assets, total, category, q, isLoading, selectedId, fetchAssets, setCategory, selectAsset, createAsset, updateAsset, batchImport, generateAsset, deleteAsset, duplicateAsset } = useAssetStore() as any;
  const { project, updateShot } = useProjectStore();
  const [searchInput, setSearchInput] = useState(q);
  const [stats, setStats] = useState<any>(null);
  const [detailAsset, setDetailAsset] = useState<any>(null);

  const [showImport, setShowImport] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  // 新建文本/提示词素材（无文件资源，正文存 content）
  const [showText, setShowText] = useState(false);
  const [textForm, setTextForm] = useState({ name: '', content: '', tags: '' });
  const [creatingText, setCreatingText] = useState(false);

  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importMeta, setImportMeta] = useState({ category: 'character' as AssetCategory, tags: '', visual_prompt: '' });
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [genForm, setGenForm] = useState({ name: '', prompt: '', negative_prompt: '', category: 'character' as AssetCategory, provider: '', aspect_ratio: '1:1', seed: '', tags: '' });
  // 生成源系统：所选源的完整定义（params_schema/provider_type）+ 用户改动过的源参数 + 通用参考图
  const [provDetail, setProvDetail] = useState<any>(null);
  const [genParams, setGenParams] = useState<Record<string, any>>({});
  const [showAdvParams, setShowAdvParams] = useState(false);
  const [refImage, setRefImage] = useState('');
  // 派生源参数：工作流分析清单（inspect exposed_inputs，含 图片/文本/数值/下拉 全类型）
  const [wfInputs, setWfInputs] = useState<any[]>([]);
  /** 打开生成弹窗：事件驱动重置本会话的源参数/高级参数/参考图（避免在 effect 里同步 setState） */
  const openGenerate = () => {
    setGenParams({});
    setShowAdvParams(false);
    setRefImage('');
    setWfInputs([]);
    setShowGenerate(true);
  };
  const [generating, setGenerating] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);

  const [showEdit, setShowEdit] = useState(false);
  useEscapeClose(showEdit, () => setShowEdit(false));
  useEscapeClose(showImport, () => setShowImport(false));
  useEscapeClose(showGenerate, () => setShowGenerate(false));
  useEscapeClose(showText, () => setShowText(false));
  const [editForm, setEditForm] = useState({ name: '', category: 'character' as AssetCategory, description: '', visual_prompt: '', content: '', tags: '', status: 'approved' as string });
  const [editFile, setEditFile] = useState<File | null>(null);
  const [updating, setUpdating] = useState(false);
  const editFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchAssets({ category, page: 1 }); }, []);
  useEffect(() => { apiService.getAssetStats().then(setStats).catch(()=>{}); }, [assets.length]);

  useEffect(() => {
    if (showGenerate) {
      // 只走生成源系统：全量加载图片源（内置 API / 自定义代码源 / 派生源），裸 comfyui 工作流壳不进本界面
      // withHealth:false —— 弹窗只消费列表/生产可用标记，跳过后端健康探测，秒开
      apiService.listImageProviders({ withHealth: false }).then(d => {
        const list = d.providers || d || [];
        setProviders(list);
        // 自动选中首个可用源
        setGenForm(prev => {
          if (prev.provider && prev.provider !== 'comfyui' && list.some((p: any) => p.id === prev.provider)) return prev;
          const first = list.find((p: any) => p.production_ready !== false && p.id !== 'comfyui')
            || list.find((p: any) => p.production_ready !== false);
          return first ? { ...prev, provider: first.id } : prev;
        });
      }).catch(() => {});
    }
  }, [showGenerate]);

  // 生成源切换 → 拉取完整定义（含真实 params_schema）
  useEffect(() => {
    if (!showGenerate || !genForm.provider) return;
    let dead = false;
    apiService.getProvider(genForm.provider)
      .then((r: any) => { if (!dead) setProvDetail(r?.provider || null); })
      .catch(() => { if (!dead) setProvDetail(null); });
    return () => { dead = true; };
  }, [showGenerate, genForm.provider]);
  // 只认属于当前所选源的详情（异步在途/弹窗重开时的旧值一律忽略，避免串源显示）
  const liveDetail = provDetail && provDetail.id === genForm.provider ? provDetail : null;

  // 派生源参数清单：inspect 工作流得到的分析暴露项（含图片/文本/数值/下拉全类型，即旧弹窗「专属输入项」口径）
  useEffect(() => {
    if (!showGenerate) return;
    const wfId = (liveDetail && liveDetail.provider_type === 'comfyui') ? liveDetail.workflow_id : '';
    if (!wfId) return;
    let dead = false;
    apiService.inspectWorkflow(wfId)
      .then((r: any) => {
        if (dead) return;
        const d = r?.data || r || {};
        // 优先用户白名单 exposed_inputs；为空时用工作流真实输入 detected_inputs（源未配置白名单时的展示口径）
        const list = (d.exposed_inputs && d.exposed_inputs.length) ? d.exposed_inputs : (d.detected_inputs || []);
        setWfInputs(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!dead) setWfInputs([]); });
    return () => { dead = true; };
  }, [showGenerate, liveDetail]);

  const refreshStats = () => apiService.getAssetStats().then(setStats).catch(()=>{});

  const handleSearch = () => fetchAssets({ q: searchInput, page: 1 });

  /** 新建文本/提示词素材：无文件，正文进 content，category=text */
  const handleCreateText = async () => {
    if (!textForm.name.trim()) { toast.warning('请填写素材名称'); return; }
    if (!textForm.content.trim()) { toast.warning('正文不能为空'); return; }
    setCreatingText(true);
    try {
      const fd = new FormData();
      fd.append('name', textForm.name.trim());
      fd.append('category', 'text');
      fd.append('content', textForm.content);
      fd.append('description', textForm.content.slice(0, 80));
      if (textForm.tags.trim()) fd.append('tags', textForm.tags.trim());
      await createAsset(fd as any);
      setShowText(false);
      setTextForm({ name: '', content: '', tags: '' });
      toast.success('文本素材已创建，可在列表中拖入画布');
      fetchAssets({ category, page: 1 });
      refreshStats();
    } catch (e: any) { toast.error(e?.message || '创建失败'); } finally { setCreatingText(false); }
  };

  const handleImport = async () => {
    if (importFiles.length === 0) { alert('请选择至少一个文件'); return; }
    setImporting(true);
    try {
      const activePid = (useProjectListStore.getState() as any).activeProjectId || (useProjectStore.getState() as any).activeProjectId || null;
      const curScope = (useAssetStore.getState() as any).scope || 'all';
      const effScope = curScope === 'global' ? 'global' : (activePid ? 'project' : 'global');
      if (importFiles.length === 1) {
        const fd = new FormData();
        const f = importFiles[0];
        const base = f.name.replace(/\.[^.]+$/, '') || '素材';
        fd.append('name', base);
        fd.append('category', importMeta.category);
        fd.append('visual_prompt', importMeta.visual_prompt);
        if (importMeta.tags) fd.append('tags', importMeta.tags);
        fd.append('scope', effScope);
        if (activePid && effScope === 'project') fd.append('project_id', activePid);
        fd.append('file', f);
        await createAsset(fd);
      } else {
        // batchImport 暂不支持 project_id，逐个创建以保证归属
        if (activePid && effScope === 'project') {
          for (const f of importFiles) {
            const fd = new FormData();
            const base = f.name.replace(/\.[^.]+$/, '') || '素材';
            fd.append('name', base);
            fd.append('category', importMeta.category);
            fd.append('visual_prompt', importMeta.visual_prompt);
            if (importMeta.tags) fd.append('tags', importMeta.tags);
            fd.append('scope', effScope);
            fd.append('project_id', activePid);
            fd.append('file', f);
            await createAsset(fd);
          }
        } else {
          const res = await batchImport(importFiles, { category: importMeta.category, tags: importMeta.tags, visual_prompt: importMeta.visual_prompt });
          if (res.errors?.length) alert(`部分失败：\n${res.errors.join('\n')}`);
        }
      }
      setShowImport(false);
      setImportFiles([]);
      setImportMeta({ category: 'character', tags: '', visual_prompt: '' });
      refreshStats();
      try { window.dispatchEvent(new CustomEvent('asset-refresh')); } catch {}
    } catch (e: any) { alert(e.message || '导入失败'); } finally { setImporting(false); }
  };

  // ── 生成源系统派生值：一切参数按所选源的真实声明显示，源没有的字段一律不出现 ──
  const genProviders: any[] = providers.filter((p: any) => p.id !== 'comfyui');
  const selProv: any = genProviders.find((p: any) => p.id === genForm.provider) || null;
  const caps: any = liveDetail || selProv || {};
  // 工作流派生源：params_schema 会被后端注入通用默认（480p/720p 等假参数），一律改用
  // workflow_exposed（用户白名单 = 该源真实启用的参数；空 = 此源只吃提示词，无任何参数）
  const isWfSrc = liveDetail ? liveDetail.provider_type === 'comfyui' : caps.supports_workflow === true;
  const exposed: any[] = isWfSrc ? (liveDetail?.workflow_exposed || []) : [];
  const provProps: Record<string, any> = isWfSrc
    ? {}
    : (liveDetail?.params_schema?.properties || selProv?.params_schema?.properties || {});
  // 比例 / 种子 / 负提示词：仅当源真实声明（派生源一律不显示——真实参数全部走 exposed）
  const hasAspect = !isWfSrc && !!(provProps.aspect_ratio || caps.supports_aspect_ratio);
  const hasSeed = !isWfSrc && !!(provProps.seed || caps.supports_seed);
  const hasNegative = !isWfSrc && !!(provProps.negative_prompt || caps.supports_negative_prompt);
  // 比例枚举：源真实 schema 优先（出网护栏按 enum 校验），其次 capabilities，最后通用档
  const aspectEnum: string[] = provProps.aspect_ratio?.enum || caps.supports_aspect_ratio || ['1:1', '9:16', '16:9', '3:4', '4:3'];
  // 参考图/垫图（通用单图位）：仅代码源与内置源按 input_schema 图槽显示；
  // 派生源的图片是「多个节点图片槽」，在参数区按 exposed 逐槽渲染（见 wfParamEntries），不走通用位
  const inputProps: Record<string, any> = isWfSrc
    ? {}
    : (liveDetail?.input_schema?.properties || selProv?.input_schema?.properties || {});
  const hasRefImage = !isWfSrc && Object.entries(inputProps).some(([k, d]: [string, any]) =>
    d?.['x-handle'] === 'image' || (((d?.format === 'uri') || d?.items?.format === 'uri') && !/audio|video/i.test(String(d?.['x-handle'] || k))));
  const provLabel = liveDetail?.display_name || liveDetail?.name || selProv?.display_name || selProv?.name || genForm.provider || '未选择';
  // 派生源参数 = 工作流分析清单（inspect 全类型：图片/文本/数值/下拉；空时回退白名单暴露项）
  const wfParamEntries: any[] = (wfInputs.length ? wfInputs : exposed)
    .filter((e: any) => e && ['image', 'number', 'combo', 'text', 'boolean'].includes(String(e.type)));
  // 其余源参数 = params_schema（比例/种子/负提示词/提示词/参考图等已有专属 UI 的键跳过）
  const SKIP_PARAM_KEYS = new Set(['aspect_ratio', 'seed', 'negative_prompt', 'prompt', 'text', 'workflow_id', 'reference_images', 'task_id', 'style_preset']);
  const paramEntries = isWfSrc ? [] : (Object.entries(provProps) as Array<[string, any]>)
    .filter(([k, def]) => !SKIP_PARAM_KEYS.has(k) && ['string', 'integer', 'number', 'boolean'].includes(String(def?.type)))
    .sort((a, b) => ((a[1]?.['x-priority'] ?? 999) - (b[1]?.['x-priority'] ?? 999)));
  const isVis = (def: any, want: 'basic' | 'advanced') => {
    const v = def?.['x-visibility'] || 'basic';
    if (v === 'hidden') return false;
    return want === 'advanced' ? v === 'advanced' : v !== 'advanced';
  };
  const basicParamEntries = paramEntries.filter(([, def]) => isVis(def, 'basic'));
  const advParamEntries = paramEntries.filter(([, def]) => isVis(def, 'advanced'));

  const handleGenerate = async () => {
    if (!genForm.name.trim() || (!isWfSrc && !genForm.prompt.trim())) { alert(isWfSrc ? '请填写素材名称' : '请填写名称与提示词'); return; }
    const provider = genForm.provider || '';
    if (!provider) { alert('请选择生成源'); return; }
    setGenerating(true);
    try {
      // 通用参考图 → dynamic_inputs.reference_images（仅源声明了图槽才发送；代码源 ctx.reference_images）
      let dyn: Record<string, any> | undefined;
      if (hasRefImage && refImage) dyn = { reference_images: [refImage] };
      // 派生源：提示词自动映射工作流主文本槽（用户已显式填写的槽位不覆盖）
      if (isWfSrc) {
        const texts = wfParamEntries.filter((e: any) => e.type === 'text');
        let main: any = null;
        if (texts.length > 0) {
          main = texts.find((e: any) => /user|用户|主.*提示|文本段.*string_b/i.test(`${e.label || ''}${e.param_name || ''}`))
            || texts.find((e: any) => ['prompt', 'value', 'text', 'string'].includes(String(e.param_name || '').toLowerCase()) || String(e.param_name || '').startsWith('string_'))
            || texts[0];
        }
        if (main) {
          const mk = String(main.id || main.node_id || '');
          const cur = genParams[mk];
          if (mk && (!cur || (typeof cur === 'string' && cur.trim() === '') || cur === main.default_value)) {
            dyn = { ...(dyn || {}), [mk]: genForm.prompt.trim() };
          }
        }
      }
      // 源参数：只发送用户显式改过的（空值剔除，不发默认值，避免与源真实 API 不符）
      const params: Record<string, any> = { ...genParams };
      for (const k of Object.keys(params)) if (params[k] === '' || params[k] == null) delete params[k];
      const activePid = (useProjectListStore.getState() as any).activeProjectId || (useProjectStore.getState() as any).activeProjectId || null;
      const curScope = (useAssetStore.getState() as any).scope || 'all';
      const effScope = curScope === 'global' ? 'global' : (activePid ? 'project' : 'global');
      const res = await generateAsset({
        name: genForm.name.trim(),
        prompt: genForm.prompt.trim(),
        category: genForm.category,
        provider,
        negative_prompt: hasNegative && genForm.negative_prompt.trim() ? genForm.negative_prompt.trim() : undefined,
        aspect_ratio: hasAspect ? (aspectEnum.includes(genForm.aspect_ratio) ? genForm.aspect_ratio : (aspectEnum[0] || '1:1')) : undefined,
        seed: hasSeed && genForm.seed !== '' && !Number.isNaN(Number(genForm.seed)) ? Number(genForm.seed) : undefined,
        params: Object.keys(params).length ? params : undefined,
        tags: genForm.tags || undefined,
        dynamic_inputs: dyn,
        project_id: (effScope === 'project' && activePid) ? activePid : undefined,
        scope: effScope,
      } as any);
      setShowGenerate(false);
      // 保留所选生成源，清空内容类字段
      setGenForm(prev => ({ ...prev, name: '', prompt: '', negative_prompt: '', category: 'character', aspect_ratio: '1:1', seed: '', tags: '' }));
      setGenParams({});
      setRefImage('');
      if (res?.asset) { selectAsset(res.asset.id); setDetailAsset(res.asset); }
      refreshStats();
      try { window.dispatchEvent(new CustomEvent('asset-refresh')); } catch {}
    } catch (e: any) { alert(e.message || '生成失败'); } finally { setGenerating(false); }
  };

  const openEdit = (asset: any) => {
    setEditForm({
      name: asset.name || '',
      category: (asset.category as AssetCategory) || 'character',
      description: asset.description || '',
      visual_prompt: asset.visual_prompt || '',
      content: asset.content || '',
      tags: asset.tags?.join(', ') || '',
      status: asset.status || 'approved',
    });
    setEditFile(null);
    setShowEdit(true);
  };

  const handleUpdate = async () => {
    if (!selected) return;
    if (!editForm.name.trim()) { alert('名称不能为空'); return; }
    setUpdating(true);
    try {
      const fd = new FormData();
      fd.append('name', editForm.name.trim());
      fd.append('category', editForm.category);
      if (editForm.description) fd.append('description', editForm.description);
      if (editForm.visual_prompt) fd.append('visual_prompt', editForm.visual_prompt);
      fd.append('content', editForm.content || '');
      if (editForm.tags) fd.append('tags', editForm.tags);
      if (editForm.status) fd.append('status', editForm.status);
      if (editFile) fd.append('file', editFile);
      const updated: any = await (updateAsset as any)(selected.id, fd);
      setDetailAsset(updated);
      // 同步更新列表中的项
      // fetchAssets 会在 store 内自动就地更新，但为确保立即反映，额外刷新统计
      refreshStats();
      setShowEdit(false);
      setEditFile(null);
    } catch (e: any) { alert(e.message || '更新失败'); } finally { setUpdating(false); }
  };

  const handleMigrate = async () => {
    if (!project?.characters?.length) { toast.warning('当前项目无角色'); return; }
    const confirmed = await confirmAsync({
      title: '迁移角色为素材',
      message: `确定要将项目《${project.title}》的 ${project.characters.length} 个角色迁移为全局人物素材吗？`,
      confirmText: '确认迁移'
    });
    if (!confirmed) return;
    try {
      const data = await apiService.migrateCharacters(project.id, project.characters);
      toast.success(`已迁移 ${data.migrated} 个角色到素材库`);
      fetchAssets({ category: 'character', page: 1 });
      refreshStats();
    } catch (e: any) { toast.error(e.message || '迁移失败'); }
  };

  /** 确保素材对应项目角色存在（同名复用，否则创建），返回角色 id */
  const ensureProjectCharacter = (asset: any): string | null => {
    const st = useProjectStore.getState();
    const curProject: any = st.project;
    if (!curProject) return null;
    const url = asset.file_url || asset.thumb_url;
    const exist = (curProject.characters || []).find((c: any) => c.name === asset.name);
    if (exist) return exist.id;
    const newChar: any = {
      id: 'char-' + Date.now(),
      name: asset.name,
      gender: 'other',
      age_group: 'youth',
      role: 'supporting',
      description: asset.description || asset.visual_prompt?.slice(0, 120) || '',
      visual_prompt: asset.visual_prompt || asset.description || asset.name,
      voice_id: asset.voice_id || '',
      voice_name: asset.voice_name || '',
      emotion_preset: 'neutral',
      avatar_url: url,
      three_views: {},
    };
    st.setProject({ ...curProject, characters: [...(curProject.characters || []), newChar] } as any);
    return newChar.id;
  };

  const appendPromptOnce = (base: string, add: string): string => {
    if (!add) return base;
    if (base.includes(add)) return base;
    return base ? `${base} ${add}` : add;
  };

  const handleApplyToShot = (asset: any) => {
    const st = useProjectStore.getState();
    const activeShotId = st.activeShotId;
    const curProject: any = st.project;
    if (!curProject) { alert('请先在项目看板创建/打开项目'); return; }
    let targetShotId = activeShotId;
    if (!targetShotId) {
      const firstShot = curProject.scenes?.flatMap((s:any)=>s.shots)?.[0];
      if (firstShot) {
        st.setActiveShotId(firstShot.id);
        targetShotId = firstShot.id;
      } else {
        alert('当前项目暂无分镜');
        return;
      }
    }
    const shot: any = curProject.scenes.flatMap((s:any)=>s.shots).find((s:any)=>s.id===targetShotId);
    if (!shot || !targetShotId) { alert('请先在分镜台选中一个镜头'); return; }
    const shotId: string = targetShotId;
    const url = asset.file_url || asset.thumb_url;
    const abs = url && url.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
    const patch: any = {};
    // 人物 → 绑定 character_ids（生成参考装配的唯一口径），描述只缺失才追加， never 覆盖
    if (asset.category === 'character') {
      const charId = ensureProjectCharacter(asset);
      if (charId) {
        const ids: string[] = [...(shot.character_ids || [])];
        if (!ids.includes(charId)) ids.push(charId);
        patch.character_ids = ids;
        const weights = { ...(shot.character_weights || {}) };
        if (weights[charId] === undefined) weights[charId] = 0.8;
        patch.character_weights = weights;
      }
      const tag = `[角色: ${asset.name}${asset.visual_prompt ? `, ${asset.visual_prompt}` : ''}]`;
      patch.image_prompt = appendPromptOnce(shot.image_prompt || '', tag);
    } else if (asset.category === 'scene' || asset.category === 'background') {
      // 场景/背景 → 写 scene_ref_image + scene_asset_id（不再覆盖 image_prompt）
      if (abs) { patch.scene_ref_image = abs; patch.scene_asset_id = asset.id; }
      const desc = asset.visual_prompt || asset.description || '';
      if (desc) patch.image_prompt = appendPromptOnce(shot.image_prompt || '', desc);
    } else if (asset.category === 'prop' || asset.category === 'effect') {
      // 道具/特效 → prop_asset_ids + 描述追加
      const ids: string[] = [...(shot.prop_asset_ids || [])];
      if (!ids.includes(asset.id)) ids.push(asset.id);
      patch.prop_asset_ids = ids;
      const desc = asset.visual_prompt || asset.description || asset.name;
      if (desc) {
        const add = asset.category === 'prop' ? `${desc}, detailed prop` : desc;
        patch.image_prompt = appendPromptOnce(shot.image_prompt || '', add);
      }
      // 特效氛围图可兼做白模参考
      if (asset.category === 'effect' && abs && !shot.previz_url) patch.previz_url = abs;
    } else if (asset.category === 'previz' || (asset.tags || []).includes('previz')) {
      // 预演 → 白模参考（图/视频各归其位）
      if (abs && /\.(mp4|webm|mov)$/i.test(abs)) patch.previz_video_url = abs;
      else if (abs) patch.previz_url = abs;
    } else if (asset.category === 'text') {
      // 文本/提示词素材 → 正文追加进镜头提示词
      const desc = asset.content || asset.visual_prompt || '';
      if (desc) patch.image_prompt = appendPromptOnce(shot.image_prompt || '', desc);
    } else {
      const desc = asset.visual_prompt || asset.name;
      if (desc) patch.image_prompt = appendPromptOnce(shot.image_prompt || '', `${desc}, detailed prop`);
    }
    if (!Object.keys(patch).length) { alert('该素材无可用信息写入分镜'); return; }
    updateShot(shotId, patch);
    // 切到分镜台并提示
    st.setActiveTab('studio');
    try { window.dispatchEvent(new CustomEvent('asset-applied', { detail: { assetId: asset.id, shotId: targetShotId } })); } catch {}
  };

  const isVideoAsset = (asset: any) => /\.(mp4|webm|mov)$/i.test(asset?.file_url || '');
  const isAudioAsset = (asset: any) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(asset?.file_url || '');

  /** 发送到无限画布：按素材类型装配节点（人物/场景/道具→参考图节点，视频→首帧节点，音频→复刻参考） */
  const handleSendToCanvas = (asset: any) => {
    try {
      const st = useProjectStore.getState();
      if (!st.project) { alert('请先在项目看板创建/打开项目'); return; }
      const payload = {
        nonce: Date.now(),
        asset: {
          id: asset.id, name: asset.name, category: asset.category,
          file_url: asset.file_url || asset.thumb_url, visual_prompt: asset.visual_prompt || '',
          description: asset.description || '',
          content: asset.content || '',
        },
      };
      localStorage.setItem('canvas_pending_asset', JSON.stringify(payload));
      st.setWorkspace('creative');
      st.setActiveTab('canvas' as any);
      window.dispatchEvent(new CustomEvent('canvas-import-asset', { detail: payload }));
    } catch (e: any) { alert(e?.message || '发送失败'); }
  };

  /** 设为分镜白模参考：图进 previz_url，视频进 previz_video_url（生成参考装配直接消费） */
  const handleSetAsPreviz = (asset: any) => {
    const st = useProjectStore.getState();
    const curProject: any = st.project;
    if (!curProject) { alert('请先在项目看板创建/打开项目'); return; }
    const targetShotId = st.activeShotId || curProject.scenes?.flatMap((s: any) => s.shots)?.[0]?.id;
    if (!targetShotId) { alert('当前项目暂无分镜'); return; }
    const url = asset.file_url || asset.thumb_url;
    const abs = url && url.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
    if (!abs) { alert('该素材无可用文件'); return; }
    updateShot(targetShotId, isVideoAsset(asset) ? { previz_video_url: abs } : { previz_url: abs });
    st.setActiveTab('studio');
  };

  const handleAddAsCharacter = (asset: any) => {    const st = useProjectStore.getState();
    const curProject = st.project;
    if (!curProject) { alert('请先打开项目'); return; }
    const exists = curProject.characters.some((c:any)=> c.name===asset.name);
    if (exists) { alert('该角色名已存在于当前项目'); return; }
    const url = asset.file_url || asset.thumb_url;
    const newChar: any = {
      id: 'char-' + Date.now(),
      name: asset.name,
      gender: 'other',
      age_group: 'youth',
      role: asset.category==='character' ? 'supporting' : 'supporting',
      description: asset.description || asset.visual_prompt?.slice(0,120) || '',
      visual_prompt: asset.visual_prompt || asset.description || asset.name,
      voice_id: asset.voice_id || '',
      voice_name: asset.voice_name || '',
      emotion_preset: 'neutral',
      avatar_url: url,
      three_views: {},
    };
    const next = { ...curProject, characters: [...curProject.characters, newChar] } as any;
    st.setProject(next);
    alert(`已将素材《${asset.name}》添加为项目角色`);
    st.setActiveTab('characters');
  };

  const onDropFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const arr = Array.from(files);
    const valid = arr.filter(f => f.size > 0);
    if (valid.length > 20) { alert('单次最多20个文件'); return; }
    setImportFiles(valid);
    setShowImport(true);
  };

  const selected = assets.find((a: any) => a.id === selectedId) || detailAsset;

  return (
    <div className="flex-1 flex h-[calc(100vh-56px)] bg-background overflow-hidden">
      <div className="w-[260px] bg-surface/80 border-r border-white/70 dark:border-white/12 flex flex-col shrink-0">
        <div className="h-12 px-3 border-b border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Library className="w-3.5 h-3.5 text-brand" /></div>
          <span className="text-xs font-bold tracking-tight text-white">素材库</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-gray-400">{total}</span>
          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-brand/10 text-brand border border-brand/20">{(useProjectListStore as any)?.getState?.()?.activeProjectId ? '项目' : '全局'}</span>
        </div>
        <div className="p-3 border-b border-white/70 dark:border-white/12 space-y-2">
          <div className="flex rounded-full bg-surface/80 border border-white/70 dark:border-white/12 p-1 gap-1">
            {(['all','project','global'] as const).map(s=> (
              <button key={s} onClick={()=>fetchAssets({ scope: s, page: 1 })} className={`flex-1 py-1 rounded-full text-[11px] font-bold transition-all ${((useAssetStore as any).getState?.().scope||'all')===s ? 'bg-brand text-white shadow-sm' : 'text-gray-500 hover:text-white'}`}>{s==='all'?'全部':s==='project'?'项目':'全局'}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 px-3 py-1.5 focus-within:border-brand/40">
            <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <input value={searchInput} onChange={e=>setSearchInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} placeholder="搜索名称/标签" className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none min-w-0" />
            <button onClick={handleSearch} className="text-[11px] font-bold text-brand hover:text-brand-light">搜索</button>
          </div>
        </div>
        <div className="p-2 space-y-1 flex-1 overflow-y-auto">
          {CATEGORY_TABS.map(t => (
            <button key={t.key} onClick={()=>setCategory(t.key as any)} className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-all ${category===t.key ? 'bg-brand/15 border border-brand text-white' : 'text-gray-400 hover:bg-surface/80 hover:text-white border border-transparent'}`}>
              <span className="flex items-center space-x-2">{t.icon}<span>{t.label}</span></span>
              {stats?.by_category?.[t.key] != null && t.key!=='all' && <span className="text-[10px] bg-surface-hover/80 px-1.5 py-0.5 rounded">{stats.by_category[t.key]}</span>}
              {t.key==='all' && <span className="text-[10px] bg-surface-hover/80 px-1.5 py-0.5 rounded">{stats?.total||total}</span>}
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-white/70 dark:border-white/12 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={()=>setShowImport(true)} className="flex items-center justify-center space-x-1.5 py-2.5 rounded-xl bg-gradient-to-r from-brand to-accent-pink text-white text-xs font-bold shadow-lg shadow-brand/20">
              <Upload className="w-3.5 h-3.5" /><span>导入</span>
            </button>
            <button onClick={openGenerate} className="flex items-center justify-center space-x-1.5 py-2.5 rounded-xl bg-surface/80 border border-brand/40 text-xs text-white font-semibold hover:bg-brand/10">
              <Wand2 className="w-3.5 h-3.5" /><span>生成</span>
            </button>
          </div>
          <p className="text-[10px] text-gray-500 text-center leading-4">导入：本地批量上传 · 生成：AI 直出入库</p>
          <button onClick={handleMigrate} className="w-full flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-hover/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white">
            <Sparkles className="w-3 h-3" /><span>一键迁移角色</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative min-w-0">
        <div className="h-11 px-4 border-b border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/35 backdrop-blur flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className="w-7 h-7 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center shrink-0"><Filter className="w-3.5 h-3.5 text-gray-400" /></span>
            <span className="text-white font-medium truncate">{category==='all'?'全部素材':CATEGORY_TABS.find(c=>c.key===category)?.label}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-400">{total} 个</span>
            {q && <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand-light text-xs">"{q}"</span>}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 shrink-0">
            <select value={(useAssetStore as any).getState?.()?.sort || 'updated_at'} onChange={e=>fetchAssets({ sort: e.target.value, page: 1 })} className="hidden sm:block bg-surface/80 border border-white/70 dark:border-white/12 rounded-full px-3 py-1 text-xs text-white focus:outline-none">
              <option value="updated_at">最近更新</option><option value="created_at">创建时间</option><option value="name">名称</option>
            </select>
            <button onClick={()=>importInputRef.current?.click()} className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-xs font-medium text-[color:var(--color-text-main)] hover:border-white/80 dark:border-white/20">
              <Files className="w-3.5 h-3.5" /><span>批量</span>
            </button>
            <input ref={importInputRef} type="file" multiple accept="image/*,audio/*,video/*,.glb,.fbx" className="hidden" onChange={e=>{ onDropFiles(e.target.files); if(e.target) e.target.value=''; }} />
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto p-4"
          onDragOver={e=>{ e.preventDefault(); setDragOver(true); }}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{ e.preventDefault(); setDragOver(false); onDropFiles(e.dataTransfer.files); }}
        >
          {dragOver && (
            <div className="absolute inset-0 z-10 bg-brand/10 backdrop-blur-sm border-2 border-dashed border-brand rounded-2xl m-2 flex flex-col items-center justify-center pointer-events-none">
              <Upload className="w-10 h-10 text-brand mb-2" />
              <span className="text-sm font-bold text-white">松开即可导入</span>
              <span className="text-xs text-gray-400 mt-1">支持图片/音频/视频，单次最多20个</span>
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin mr-2" />加载中…</div>
          ) : assets.length===0 ? (
            <div className="flex flex-col items-center justify-center h-60 text-gray-500 space-y-3">
              <Library className="w-8 h-8 opacity-50" />
              <span className="text-sm">暂无素材</span>
              <span className="text-xs">拖拽文件到此处导入，或点击「生成」AI 创作</span>
              <div className="flex space-x-2 pt-1">
                <button onClick={()=>setShowImport(true)} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center space-x-1"><Upload className="w-3.5 h-3.5" /><span>导入素材</span></button>
                <button onClick={()=>setShowText(true)} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white flex items-center space-x-1 hover:border-brand" title="新建纯文本/提示词素材（可拖入画布自动填充）"><FileText className="w-3.5 h-3.5" /><span>新建文本</span></button>
                <button onClick={openGenerate} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white flex items-center space-x-1"><Wand2 className="w-3.5 h-3.5" /><span>AI 生成</span></button>
              </div>
            </div>
            ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 items-start">
                {assets.map((a: any) => {
                  const url = a.file_url || a.thumb_url;
                  const abs = url && url.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
                  return (
                  <div key={a.id} draggable onDragStart={e=>{ e.dataTransfer.setData('text/plain', abs||url||''); e.dataTransfer.setData('application/canvas-assetid', a.id); e.dataTransfer.setData('application/asset-category', a.category||''); if (a.category==='text') { e.dataTransfer.setData('application/canvas-assetkind','text'); e.dataTransfer.setData('application/canvas-text', a.content || a.visual_prompt || ''); } e.dataTransfer.effectAllowed='copy'; }} onClick={()=>{selectAsset(a.id); setDetailAsset(a);}} title={a.category==='text' ? '拖入画布：填充到命中的节点，或新建文本节点' : '拖拽到分镜垫图槽或画布'} className={`group bg-surface/80 border rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing transition-all hover:shadow-lg ${selectedId===a.id ? 'border-brand ring-1 ring-brand/30' : 'border-white/70 dark:border-white/12 hover:border-white/80 dark:border-white/20'}`}>
                    {a.category === 'text' ? (
                      <div className="aspect-square bg-surface/80 relative overflow-hidden p-3">
                        <div className="absolute top-2 left-2 flex items-center space-x-1 z-10">
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-medium bg-sky-500/15 text-sky-400 border-sky-500/30">text</span>
                        </div>
                        <div className="text-[10px] text-gray-400 leading-relaxed overflow-hidden whitespace-pre-wrap break-words" style={{ display: '-webkit-box', WebkitLineClamp: 7, WebkitBoxOrient: 'vertical' }}>
                          {(a.content || a.visual_prompt || '').slice(0, 240) || '（空文本素材）'}
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 space-x-1">
                          <button onClick={(e)=>{e.stopPropagation(); handleSendToCanvas(a);}} className="flex-1 py-1 rounded-lg bg-brand text-white text-[10px] font-bold">发送到画布</button>
                          <button onClick={(e)=>{e.stopPropagation(); const t=a.content||a.visual_prompt||''; if(t&&navigator.clipboard){navigator.clipboard.writeText(t); toast.success('已复制文本');} }} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30" title="复制文本"><Copy className="w-3 h-3" /></button>
                          <button onClick={(e)=>{e.stopPropagation(); openEdit(a);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30" title="编辑"><Pencil className="w-3 h-3" /></button>
                        </div>
                      </div>
                    ) : a.thumb_url || a.file_url ? (
                      <AutoRatioMedia
                        src={resolveUrl(a.thumb_url||a.file_url) || ''}
                        alt={a.name}
                        fallbackAspect="1/1"
                        className="bg-surface/80"
                        mediaClassName="group-hover:scale-105 transition-transform"
                      >
                      <div className="absolute top-2 left-2 flex items-center space-x-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${a.category==='character'?'bg-accent-pink/20 text-accent-pink border-accent-pink/30': a.category==='scene'?'bg-accent-green/20 text-accent-green border-accent-green/30':'bg-brand/20 text-brand-light border-brand/30'}`}>{a.category}</span>
                        {a.status!=='approved' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">{a.status}</span>}
                      </div>
                      {a.source==='generate' && <span className="absolute top-2 right-2 text-[8px] px-1.5 py-0.5 rounded-full bg-violet-500/90 text-white font-bold">AI</span>}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 space-x-1">
                        <button onClick={(e)=>{e.stopPropagation(); handleApplyToShot(a);}} className="flex-1 py-1 rounded-lg bg-brand text-white text-[10px] font-bold">应用到镜头</button>
                        <button onClick={(e)=>{e.stopPropagation(); handleSendToCanvas(a);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30" title="发送到无限画布"><Send className="w-3 h-3" /></button>
                        <button onClick={(e)=>{e.stopPropagation(); duplicateAsset(a.id);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30"><Copy className="w-3 h-3" /></button>
                        <button onClick={(e)=>{e.stopPropagation(); openEdit(a);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30" title="编辑"><Pencil className="w-3 h-3" /></button>
                      </div>
                      </AutoRatioMedia>
                    ) : (
                      <div className="aspect-square bg-surface/80 relative overflow-hidden flex flex-col items-center justify-center text-gray-600">
                        <ImageIcon className="w-6 h-6 mb-1" /><span className="text-[10px]">{a.category}</span>
                      </div>
                    )}
                    <div className="p-2.5">
                      <div className="text-xs font-semibold text-white truncate">{a.name}</div>
                      <div className="text-[10px] text-gray-400 truncate mt-0.5">{a.description || a.visual_prompt?.slice(0,40) || '—'}</div>
                      {a.tags?.length>0 && <div className="flex flex-wrap gap-1 mt-1.5">{a.tags.slice(0,3).map((t:string)=><span key={t} className="text-[9px] px-1 py-0.5 rounded bg-surface-hover/80 text-gray-400 flex items-center space-x-0.5"><Tag className="w-2.5 h-2.5" /><span>{t}</span></span>)}{a.tags.length>3 && <span className="text-[9px] text-gray-500">+{a.tags.length-3}</span>}</div>}
                    </div>
                  </div>
                  );
                })}
              </div>
              {total > 24 && (
                <div className="mt-4 flex items-center justify-center gap-2 text-xs">
                  <button disabled={(useAssetStore as any).getState().page <= 1} onClick={()=>fetchAssets({ page: Math.max(1, (useAssetStore as any).getState().page - 1) })} className="px-3 py-1.5 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-white disabled:opacity-40">上一页</button>
                  <span className="text-gray-400 font-mono">第 {(useAssetStore as any).getState().page} 页 / 共 {Math.ceil(total/24)} 页 · {total} 条</span>
                  <button disabled={(useAssetStore as any).getState().page >= Math.ceil(total/24)} onClick={()=>fetchAssets({ page: (useAssetStore as any).getState().page + 1 })} className="px-3 py-1.5 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-white disabled:opacity-40">下一页</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-80 bg-surface/80 border-l border-white/70 dark:border-white/12 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-white/70 dark:border-white/12 flex items-center justify-between">
            <span className="text-sm font-bold text-white">素材详情</span>
            <button onClick={()=>{selectAsset(null); setDetailAsset(null);}} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {selected.file_url ? (
              <AutoRatioMedia src={resolveUrl(selected.file_url) || ''} fallbackAspect="1/1" className="rounded-xl bg-surface/80 border border-white/70 dark:border-white/12" />
            ) : (
              <div className="aspect-square rounded-xl overflow-hidden bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center text-gray-500">无预览</div>
            )}
            <div>
              <div className="text-sm font-bold text-white">{selected.name}</div>
              <div className="text-xs text-gray-400 mt-1">{selected.category} {selected.subcategory && `· ${selected.subcategory}`} · {selected.source==='generate'?'AI生成':selected.source==='upload'?'本地导入':'迁移'}</div>
              {selected.description && <p className="text-xs text-gray-300 mt-2 leading-5">{selected.description}</p>}
              {selected.category === 'text' && (
                <div className="mt-2">
                  <label className="text-xs font-semibold text-white block mb-1">正文</label>
                  <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-2.5 text-xs text-gray-300 max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-5">{selected.content || selected.visual_prompt || '—'}</div>
                </div>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-white block mb-1">视觉提示词</label>
              <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-2.5 text-xs font-mono text-gray-300 max-h-24 overflow-y-auto break-words">{selected.visual_prompt || '—'}</div>
              <button onClick={()=>handleApplyToShot(selected)} className="mt-2 w-full py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center space-x-1">
                <Sparkles className="w-3.5 h-3.5" /><span>应用到当前镜头</span>
              </button>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <button onClick={()=>handleSendToCanvas(selected)} className="py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white hover:border-brand flex items-center justify-center space-x-1">
                  <Send className="w-3.5 h-3.5" /><span>发送到画布</span>
                </button>
                <button onClick={()=>handleSetAsPreviz(selected)} className="py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white hover:border-brand flex items-center justify-center space-x-1" title="图进 previz_url，视频进 previz_video_url，生成参考装配直接消费">
                  <Clapperboard className="w-3.5 h-3.5" /><span>设为白模参考</span>
                </button>
              </div>
              <button onClick={()=>handleAddAsCharacter(selected)} className="mt-1.5 w-full py-2 rounded-xl bg-surface/80 border border-brand/30 text-xs text-brand-light hover:text-white hover:bg-brand/10 flex items-center justify-center space-x-1">
                <Users className="w-3.5 h-3.5" /><span>添加为项目角色</span>
              </button>
              <div className="mt-1.5 text-[10px] text-gray-500 flex items-center gap-1"><span>💡 拖拽卡片到分镜垫图槽可直接作为参考图</span></div>
            </div>
            {selected.tags?.length>0 && <div className="flex flex-wrap gap-1.5">{selected.tags.map((t:string)=><span key={t} className="text-xs px-2 py-1 rounded-full bg-brand/15 text-brand-light border border-brand/30">{t}</span>)}</div>}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-2">
                <div className="text-gray-500">尺寸</div><div className="text-white font-mono">{selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'}</div>
              </div>
              <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-2">
                <div className="text-gray-500">来源</div><div className="text-white flex items-center space-x-1">{selected.source==='generate' && <Sparkles className="w-3 h-3 text-violet-400" />}<span>{selected.source}</span></div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={()=>openEdit(selected)} className="py-2 rounded-xl bg-brand/20 border border-brand/40 text-xs text-brand-light hover:bg-brand/30 hover:text-white flex items-center justify-center space-x-1 font-semibold"><Pencil className="w-3.5 h-3.5" /><span>编辑</span></button>
              <button 
                onClick={async () => { 
                  if (await confirmAsync({
                    title: '删除素材',
                    message: `确定要删除素材「${selected.name}」吗？\n删除后该素材将无法恢复。`,
                    isDanger: true,
                    confirmText: '确认删除',
                    cancelText: '取消'
                  })) { 
                    await deleteAsset(selected.id); 
                    setDetailAsset(null); 
                    selectAsset(null); 
                    toast.success('素材已删除');
                  } 
                }} 
                className="py-2 rounded-xl bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 text-xs text-red-300 flex items-center justify-center space-x-1 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>删除</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showEdit && selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowEdit(false)}>
          <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Edit3 className="w-4 h-4 text-brand" /><span>编辑素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">更新</span></h3>
              <button onClick={()=>setShowEdit(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">名称 *</label>
                <input value={editForm.name} onChange={e=>setEditForm({...editForm, name:e.target.value})} placeholder="素材名称" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="text-xs text-gray-300">分类</label>
                <select value={editForm.category} onChange={e=>setEditForm({...editForm, category: e.target.value as any})} className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">描述</label>
              <textarea value={editForm.description} onChange={e=>setEditForm({...editForm, description:e.target.value})} rows={2} placeholder="素材描述" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white font-mono" />
            </div>
            {(editForm.category === 'text' || selected.category === 'text') && (
              <div>
                <label className="text-xs text-gray-300">正文（文本/提示词素材）</label>
                <textarea value={editForm.content} onChange={e=>setEditForm({...editForm, content:e.target.value})} rows={5} placeholder="提示词 / 剧本片段正文" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white font-mono" />
              </div>
            )}
            <div>
              <label className="text-xs text-gray-300">视觉提示词</label>
              <textarea value={editForm.visual_prompt} onChange={e=>setEditForm({...editForm, visual_prompt:e.target.value})} rows={3} placeholder="英文提示词，用于一致性生成" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">标签（逗号分隔）</label>
                <input value={editForm.tags} onChange={e=>setEditForm({...editForm, tags:e.target.value})} placeholder="如：主角, 玄幻" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white" />
              </div>
              <div>
                <label className="text-xs text-gray-300">状态</label>
                <select value={editForm.status} onChange={e=>setEditForm({...editForm, status:e.target.value})} className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white">
                  <option value="approved">已审核</option><option value="draft">草稿</option><option value="archived">归档</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">替换预览图（可选）</label>
              <div className="mt-1 flex items-center gap-3">
                <input ref={editFileRef} type="file" accept="image/*" hidden onChange={e=>{ const f=e.target.files?.[0]||null; setEditFile(f); }} />
                <button type="button" onClick={()=>editFileRef.current?.click()} className="px-3 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5" /><span>{editFile ? editFile.name : '选择图片'}</span>
                </button>
                {editFile && <button type="button" onClick={()=>{ setEditFile(null); if(editFileRef.current) editFileRef.current.value=''; }} className="text-xs text-gray-400 hover:text-white">清空</button>}
                {selected.file_url && !editFile && <span className="text-[11px] text-gray-500 truncate max-w-[180px]">当前：{selected.file_url.split('/').pop()}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={()=>setShowEdit(false)} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white">取消</button>
              <button onClick={handleUpdate} disabled={updating} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40 flex items-center gap-1.5">{updating ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>保存中…</span></> : <><Save className="w-3.5 h-3.5" /><span>保存更新</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowImport(false)}>
          <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Upload className="w-4 h-4 text-brand" /><span>导入素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">批量</span></h3>
              <button onClick={()=>setShowImport(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            <div onDragOver={e=>e.preventDefault()} onDrop={e=>{ e.preventDefault(); const f=Array.from(e.dataTransfer.files||[]); if(f.length) setImportFiles(f); }} className="border-2 border-dashed border-white/70 dark:border-white/12 rounded-2xl p-5 text-center bg-surface/80 hover:border-brand/40 transition-colors cursor-pointer" onClick={()=>importInputRef.current?.click()}>
              <Upload className="w-7 h-7 text-gray-500 mx-auto mb-2" />
              <div className="text-xs text-white font-semibold">点击选择或拖拽文件到此处</div>
              <div className="text-[11px] text-gray-500 mt-1">图片 / 音频 / 视频 / 模型 · 单次最多20个 · 已选 {importFiles.length} 个</div>
              {importFiles.length>0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
                  {importFiles.slice(0,8).map((f,i)=><span key={i} className="text-[10px] px-2 py-1 rounded-full bg-brand/15 text-brand-light border border-brand/20 truncate max-w-[120px]">{f.name}</span>)}
                  {importFiles.length>8 && <span className="text-[10px] text-gray-500">+{importFiles.length-8} 个</span>}
                </div>
              )}
            </div>
            <input ref={importInputRef} type="file" multiple accept="image/*,audio/*,video/*,.glb,.fbx" className="hidden" onChange={e=>{ const v=e.target.files?Array.from(e.target.files):[]; if(v.length) setImportFiles(v); e.target.value=''; }} />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">类别</label>
                <select value={importMeta.category} onChange={e=>setImportMeta({...importMeta, category: e.target.value as any})} className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-300">标签（逗号分隔）</label>
                <input value={importMeta.tags} onChange={e=>setImportMeta({...importMeta, tags:e.target.value})} placeholder="如：主角, 玄幻" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">视觉提示词（可选，批量时统一应用）</label>
              <textarea value={importMeta.visual_prompt} onChange={e=>setImportMeta({...importMeta, visual_prompt:e.target.value})} rows={2} placeholder="英文提示词，用于后续一致性生成" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            {importFiles.length>0 && <button onClick={()=>setImportFiles([])} className="text-[11px] text-gray-400 hover:text-white flex items-center space-x-1"><X className="w-3 h-3" /><span>清空已选</span></button>}
            <div className="flex justify-end space-x-2 pt-1">
              <button onClick={()=>setShowImport(false)} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white">取消</button>
              <button onClick={handleImport} disabled={importing || importFiles.length===0} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40 flex items-center space-x-1.5">{importing? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>导入中…</span></> : <><Check className="w-3.5 h-3.5" /><span>确认导入{importFiles.length?` · ${importFiles.length}个`:''}</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {showText && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowText(false)}>
          <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><FileText className="w-4 h-4 text-sky-400" /><span>新建文本 / 提示词素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20">可拖入画布</span></h3>
              <button onClick={()=>setShowText(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div>
              <label className="text-xs text-gray-300">名称 *</label>
              <input value={textForm.name} onChange={e=>setTextForm({...textForm, name:e.target.value})} placeholder="如：玄幻打斗运镜提示词" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="text-xs text-gray-300">正文 *（提示词 / 剧本片段）</label>
              <textarea value={textForm.content} onChange={e=>setTextForm({...textForm, content:e.target.value})} rows={8} placeholder="粘贴提示词或文本，创建后可拖入画布填充到任意生成节点，或连线自动填充下游" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-brand resize-y" />
              <div className="text-[10px] text-gray-500 mt-1">{textForm.content.length} 字符</div>
            </div>
            <div>
              <label className="text-xs text-gray-300">标签（逗号分隔）</label>
              <input value={textForm.tags} onChange={e=>setTextForm({...textForm, tags:e.target.value})} placeholder="如：运镜, 打斗" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white" />
            </div>
            <div className="flex justify-end space-x-2 pt-1">
              <button onClick={()=>setShowText(false)} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white">取消</button>
              <button onClick={handleCreateText} disabled={creatingText} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40 flex items-center space-x-1.5">{creatingText ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>创建中…</span></> : <><Check className="w-3.5 h-3.5" /><span>创建素材</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {showGenerate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowGenerate(false)}>
          <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Wand2 className="w-4 h-4 text-violet-400" /><span>AI 生成素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/20">入库</span></h3>
              <button onClick={()=>setShowGenerate(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-gray-500 -mt-2">完全走生成源系统：内置 API / 自定义代码源 / 派生源，参数按所选源的真实 API 自动展开，不再选择工作流。</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">名称 *</label>
                <input value={genForm.name} onChange={e=>setGenForm({...genForm, name:e.target.value})} placeholder="如：雪山神殿-夜景" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="text-xs text-gray-300">类别</label>
                <select value={genForm.category} onChange={e=>setGenForm({...genForm, category: e.target.value as any})} className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
            </div>
            {!isWfSrc && (
            <div>
              <label className="text-xs text-gray-300">提示词 Prompt *</label>
              <textarea value={genForm.prompt} onChange={e=>setGenForm({...genForm, prompt:e.target.value})} rows={3} placeholder="英文提示词，如：ancient temple in snow mountain, cinematic lighting, ultra detailed" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            )}
            {isWfSrc && (
            <p className="text-[11px] text-gray-500 bg-white/40 dark:bg-white/[.03] border border-white/70 dark:border-white/12 rounded-xl px-3 py-2">本生成源的提示词直接填在下方「生成源参数」的文本槽中（按工作流真实入口映射，无需额外提示词框）。</p>
            )}

            {/* 生成源选择：全部图片源（内置 / 代码源 / ComfyUI） */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-300">生成源 *</label>
                <span className="text-[10px] text-gray-500">{genProviders.filter((p:any)=>p.production_ready!==false).length}/{genProviders.length || '—'} 可用</span>
              </div>
              <select
                value={genForm.provider}
                onChange={e => {
                  const v = e.target.value;
                  setGenForm(prev => ({ ...prev, provider: v }));
                  // 切源即重置源参数与高级参数显隐（事件驱动，不进 effect）
                  setGenParams({});
                  setShowAdvParams(false);
                  setWfInputs([]);
                }}
                className="mt-1 w-full bg-surface/80 border border-brand/40 rounded-xl px-3 py-2 text-xs text-white focus:border-brand"
              >
                <option value="">— 请选择生成源 —</option>
                {genProviders.map((p: any) => (
                  <option key={p.id} value={p.id} disabled={p.production_ready === false}>
                    {(p.display_name || p.name || p.id)}
                    {p.provider_type === 'code' ? ' · 代码源' : p.provider_type === 'comfyui' ? ' · ComfyUI' : ' · 内置'}
                    {p.production_ready === false ? '（未配置）' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* 通用参数：仅显示所选源真实声明的字段（派生源不显示——其参数全部在下方按暴露白名单渲染） */}
            {(hasAspect || hasSeed || hasNegative) && (
            <div className="grid grid-cols-3 gap-3">
              {hasAspect && (
              <div>
                <label className="text-xs text-gray-300">比例</label>
                <select value={aspectEnum.includes(genForm.aspect_ratio) ? genForm.aspect_ratio : (aspectEnum[0] || '1:1')} onChange={e=>setGenForm({...genForm, aspect_ratio:e.target.value})} className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white">
                  {aspectEnum.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              )}
              {hasSeed && (
              <div>
                <label className="text-xs text-gray-300">种子（可选）</label>
                <input type="number" value={genForm.seed} onChange={e=>setGenForm({...genForm, seed:e.target.value})} placeholder="留空随机" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white font-mono" />
              </div>
              )}
              {hasNegative && (
              <div>
                <label className="text-xs text-gray-300">负提示词（可选）</label>
                <input value={genForm.negative_prompt} onChange={e=>setGenForm({...genForm, negative_prompt:e.target.value})} placeholder="不想要的元素" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white" />
              </div>
              )}
            </div>
            )}
            {hasRefImage && (
            <div>
              <label className="text-xs text-gray-300">参考图 / 垫图（可选）</label>
              <div className="mt-1 flex items-center gap-2">
                <label className="flex-1 border border-dashed border-white/70 dark:border-white/12 hover:border-brand rounded-lg p-2 text-center cursor-pointer bg-surface/80 dark:bg-black/30 text-[11px] text-gray-300 hover:text-white transition flex items-center justify-center gap-1.5">
                  <input type="file" accept="image/*" className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>setRefImage(String(r.result||'')); r.readAsDataURL(f); e.target.value=''; }} />
                  <Upload className="w-3.5 h-3.5 text-brand" />
                  <span>{refImage ? '更换参考图' : '上传参考图 / 角色垫图'}</span>
                </label>
                {refImage && <button type="button" onClick={()=>setRefImage('')} className="px-2.5 py-1.5 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-400 hover:text-white">移除</button>}
              </div>
              {refImage && <img src={refImage} alt="参考图" className="mt-1.5 h-14 rounded-lg border border-white/70 dark:border-white/12 object-cover" />}
            </div>
            )}

            {/* 生成源专属参数：派生源按工作流分析清单渲染（含图片/文本/数值/下拉全类型），其余源按 params_schema */}
            {(isWfSrc ? wfParamEntries.length : paramEntries.length) > 0 && (
              <div className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-200">生成源参数 · {provLabel}</span>
                  {isWfSrc ? (
                    <span className="text-[10px] text-gray-400">源声明 {wfParamEntries.length} 项</span>
                  ) : advParamEntries.length > 0 && (
                    <button type="button" onClick={()=>setShowAdvParams(v=>!v)} className="text-[10px] text-gray-400 hover:text-white">
                      {showAdvParams ? '收起高级参数' : `高级参数 (${advParamEntries.length})`}
                    </button>
                  )}
                </div>
                {isWfSrc ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  {wfParamEntries.map((exp: any) => {
                    const key = String(exp.id || exp.node_id || '');
                    const title = exp.label || exp.param_name || key;
                    const val = genParams[key] ?? '';
                    const clear = () => setGenParams(prev => { const n = { ...prev }; delete n[key]; return n; });
                    const setVal = (v: any) => setGenParams(prev => ({ ...prev, [key]: v }));
                    const rowCls = 'flex items-center justify-between gap-2';
                    const lblCls = 'text-[11px] text-gray-300 shrink-0 max-w-[45%] truncate';
                    const titleAttr = `源节点 #${exp.node_id} · ${exp.param_name || ''}`;
                    if (exp.type === 'image') {
                      const libOpts = (assets || []).filter((a: any) => a.file_url && a.category !== 'text');
                      const src = String(val || '');
                      const preview = src.startsWith('/') ? resolveUrl(src) : src;
                      return (
                        <div key={key} className="col-span-2 space-y-1" title={titleAttr}>
                          <div className="flex items-center justify-between">
                            <label className="text-[11px] text-gray-300 truncate" style={{ maxWidth: '70%' }}>{title}</label>
                            <span className="text-[10px] text-gray-500">图片槽</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {val ? (
                              <div className="relative shrink-0">
                                <img src={preview} alt="" className="h-12 rounded-lg border border-white/70 dark:border-white/12 object-cover" />
                                <button type="button" onClick={clear} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-gray-400 hover:text-white text-[9px] leading-none" title="移除">×</button>
                              </div>
                            ) : null}
                            <label className="flex-1 border border-dashed border-white/70 dark:border-white/12 hover:border-brand rounded-lg p-1.5 text-center cursor-pointer bg-surface/80 dark:bg-black/30 text-[11px] text-gray-300 hover:text-white transition flex items-center justify-center gap-1.5">
                              <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => setVal(String(r.result || '')); r.readAsDataURL(f); e.target.value = ''; }} />
                              <Upload className="w-3.5 h-3.5 text-brand" />
                              <span>{val ? '更换' : '上传图片'}</span>
                            </label>
                            <select onChange={e => { if (e.target.value) setVal(e.target.value); e.target.value = ''; }} className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-gray-400 focus:outline-none focus:border-brand max-w-[120px]">
                              <option value="">素材库选…</option>
                              {libOpts.map((a: any) => <option key={a.id} value={a.file_url || a.thumb_url}>{a.name}</option>)}
                            </select>
                          </div>
                        </div>
                      );
                    }
                    if (exp.type === 'number') {
                      return (
                        <div key={key} className={rowCls} title={titleAttr}>
                          <label className={lblCls}>{title}</label>
                          <input type="number" value={val === '' ? '' : val} onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(Number(v)); }} placeholder={exp.default_value != null ? String(exp.default_value) : '默认'} className="flex-1 max-w-[110px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white font-mono focus:outline-none focus:border-brand" />
                        </div>
                      );
                    }
                    if (exp.type === 'combo' && Array.isArray(exp.options) && exp.options.length > 0) {
                      return (
                        <div key={key} className={rowCls} title={titleAttr}>
                          <label className={lblCls}>{title}</label>
                          <select value={String(val)} onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(v); }} className="flex-1 max-w-[150px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-brand">
                            <option value="">默认{exp.default_value != null && exp.default_value !== '' ? `（${exp.default_value}）` : ''}</option>
                            {exp.options.map((o: any) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                          </select>
                        </div>
                      );
                    }
                    if (exp.type === 'boolean') {
                      return (
                        <div key={key} className={rowCls} title={titleAttr}>
                          <label className={lblCls}>{title}</label>
                          <select value={val === '' ? '' : String(val)} onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(v === 'true'); }} className="flex-1 max-w-[150px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-brand">
                            <option value="">默认{exp.default_value != null && exp.default_value !== '' ? `（${exp.default_value}）` : ''}</option>
                            <option value="true">是</option>
                            <option value="false">否</option>
                          </select>
                        </div>
                      );
                    }
                    // text（及无 options 的 combo 兜底）→ 文本输入；留空时提交阶段自动把提示词填进主文本槽
                    return (
                      <div key={key} className="col-span-2 space-y-1" title={titleAttr}>
                        <label className="text-[11px] text-gray-300 truncate block">{title}</label>
                        <textarea rows={2} value={val === '' ? '' : String(val)} onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(v); }} placeholder={exp.default_value != null && exp.default_value !== '' ? String(exp.default_value) : (exp.description || `输入 ${title}`)} className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white resize-none focus:outline-none focus:border-brand" />
                      </div>
                    );
                  })}
                </div>
                ) : [...basicParamEntries, ...(showAdvParams ? advParamEntries : [])].map(([key, def]) => {
                  const title = def?.title || def?.description || key;
                  const typ = def?.type;
                  const val = genParams[key] ?? '';
                  const clear = () => setGenParams(prev => { const n = { ...prev }; delete n[key]; return n; });
                  const setVal = (v: any) => setGenParams(prev => ({ ...prev, [key]: v }));
                  if (Array.isArray(def?.enum)) {
                    return (
                      <div key={key} className="flex items-center justify-between gap-2">
                        <label className="text-[11px] text-gray-300 shrink-0 max-w-[45%] truncate" title={def?.description || title}>{title}</label>
                        <select
                          value={val === '' ? '' : String(val)}
                          onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal((typ === 'integer' || typ === 'number') ? Number(v) : v); }}
                          className="flex-1 max-w-[190px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-brand"
                        >
                          <option value="">默认{def?.default != null && def.default !== '' ? `（${def.default}）` : ''}</option>
                          {def.enum.map((o: any) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                        </select>
                      </div>
                    );
                  }
                  if (typ === 'integer' || typ === 'number') {
                    return (
                      <div key={key} className="flex items-center justify-between gap-2">
                        <label className="text-[11px] text-gray-300 shrink-0 max-w-[45%] truncate" title={def?.description || title}>{title}{def?.minimum != null ? ` (${def.minimum}-${def.maximum ?? '…'})` : ''}</label>
                        <input
                          type="number"
                          value={val === '' ? '' : val}
                          min={def?.minimum} max={def?.maximum} step={def?.step || (typ === 'number' ? 'any' : 1)}
                          onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(Number(v)); }}
                          placeholder={def?.default != null ? String(def.default) : '默认'}
                          className="flex-1 max-w-[140px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white font-mono focus:outline-none focus:border-brand"
                        />
                      </div>
                    );
                  }
                  if (typ === 'boolean') {
                    return (
                      <div key={key} className="flex items-center justify-between gap-2">
                        <label className="text-[11px] text-gray-300 shrink-0">{title}</label>
                        <input type="checkbox" checked={!!val} onChange={e => { if (e.target.checked) setVal(true); else clear(); }} className="w-4 h-4 accent-brand" />
                      </div>
                    );
                  }
                  return (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-gray-300 shrink-0 max-w-[45%] truncate" title={def?.description || title}>{title}</label>
                      <input
                        type="text"
                        value={val === '' ? '' : String(val)}
                        onChange={e => { const v = e.target.value; if (v === '') clear(); else setVal(v); }}
                        placeholder={def?.default != null && def.default !== '' ? String(def.default) : '默认'}
                        className="flex-1 max-w-[190px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1.5 text-[11px] text-white font-mono focus:outline-none focus:border-brand"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <div>
              <label className="text-xs text-gray-300">标签（可选，逗号分隔）</label>
              <input value={genForm.tags} onChange={e=>setGenForm({...genForm, tags:e.target.value})} placeholder="如：主角, 玄幻, 古风" className="mt-1 w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white" />
            </div>
            <div className="flex justify-end space-x-2 pt-1">
              <button onClick={()=>setShowGenerate(false)} className="px-4 py-2 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-xs text-white">取消</button>
              <button
                onClick={handleGenerate}
                disabled={generating || !genForm.provider}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-brand text-white text-xs font-bold disabled:opacity-40 flex items-center space-x-1.5"
                title={!genForm.provider ? '请先选择生成源' : `用「${provLabel}」生成并入库`}
              >{generating? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>生成中…</span></> : <><Sparkles className="w-3.5 h-3.5" /><span>生成并入库</span></>}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
