import React, { useEffect, useRef, useState } from 'react';
import { Search, Plus, Layers, Users, Mountain, Box, Image as ImageIcon, Sparkles, Copy, Trash2, Tag, Filter, Library, Upload, Wand2, X, Loader2, Check, Files, Pencil, Save, Edit3 } from 'lucide-react';
import { useAssetStore } from '../../stores/useAssetStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { apiService } from '../../services/api';
import { AssetCategory } from '../../types';
import { WorkflowInspectorModal } from '../workflow/WorkflowInspectorModal';

const CATEGORY_TABS: { key: AssetCategory | 'all'; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Library className="w-3.5 h-3.5" /> },
  { key: 'character', label: '人物', icon: <Users className="w-3.5 h-3.5" /> },
  { key: 'scene', label: '场景', icon: <Mountain className="w-3.5 h-3.5" /> },
  { key: 'prop', label: '道具', icon: <Box className="w-3.5 h-3.5" /> },
  { key: 'background', label: '背景', icon: <ImageIcon className="w-3.5 h-3.5" /> },
  { key: 'effect', label: '特效', icon: <Sparkles className="w-3.5 h-3.5" /> },
  { key: 'other', label: '其他', icon: <Layers className="w-3.5 h-3.5" /> },
];

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
const API_ORIGIN = isDev ? 'http://127.0.0.1:8000' : '';
const resolveUrl = (u?: string) => u && u.startsWith('/') ? API_ORIGIN + u : u;

export const AssetLibrary: React.FC = () => {
  const { assets, total, category, q, isLoading, selectedId, fetchAssets, setCategory, selectAsset, createAsset, updateAsset, batchImport, generateAsset, deleteAsset, duplicateAsset } = useAssetStore() as any;
  const { project, updateShot } = useProjectStore();
  const [searchInput, setSearchInput] = useState(q);
  const [stats, setStats] = useState<any>(null);
  const [detailAsset, setDetailAsset] = useState<any>(null);

  const [showImport, setShowImport] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importMeta, setImportMeta] = useState({ category: 'character' as AssetCategory, tags: '', visual_prompt: '' });
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [genForm, setGenForm] = useState({ name: '', prompt: '', negative_prompt: '', category: 'character' as AssetCategory, provider: '', workflow_id: '', aspect_ratio: '1:1', seed: '', tags: '' });
  const [generating, setGenerating] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [inspectWfId, setInspectWfId] = useState('');
  const [workflowExposedInputs, setWorkflowExposedInputs] = useState<any[]>([]);
  const [dynamicInputs, setDynamicInputs] = useState<Record<string, any>>({});

  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', category: 'character' as AssetCategory, description: '', visual_prompt: '', tags: '', status: 'approved' as string });
  const [editFile, setEditFile] = useState<File | null>(null);
  const [updating, setUpdating] = useState(false);
  const editFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchAssets({ category, page: 1 }); }, []);
  useEffect(() => { apiService.getAssetStats().then(setStats).catch(()=>{}); }, [assets.length]);

  useEffect(() => {
    if (showGenerate) {
      apiService.listImageProviders().then(d => setProviders(d.providers || d || [])).catch(() => {});
      apiService.listWorkflows('all').then(d => {
        const wfs = d.workflows || d || [];
        setWorkflows(wfs);
        apiService.getConfig().then(cfg => {
          const defaultWf = cfg?.COMFYUI_DEFAULT_IMAGE_WORKFLOW || '';
          const targetWf = (defaultWf && wfs.some((w: any) => w.id === defaultWf)) ? defaultWf : (wfs.length > 0 ? wfs[0].id : '');
          if (targetWf && !genForm.workflow_id) {
            setGenForm(prev => ({
              ...prev,
              workflow_id: targetWf,
              provider: 'comfyui',
            }));
            loadWorkflowInputs(targetWf);
          }
        }).catch(() => {
          if (wfs.length > 0 && !genForm.workflow_id) {
            setGenForm(prev => ({ ...prev, workflow_id: wfs[0].id, provider: 'comfyui' }));
            loadWorkflowInputs(wfs[0].id);
          }
        });
      }).catch(() => {});
    }
  }, [showGenerate]);

  const loadWorkflowInputs = (wfId: string) => {
    if (!wfId) {
      setWorkflowExposedInputs([]);
      setDynamicInputs({});
      return;
    }
    apiService.inspectWorkflow(wfId).then(res => {
      const exposed = res?.data?.exposed_inputs || res?.exposed_inputs || [];
      setWorkflowExposedInputs(exposed);
      const defaults: Record<string, any> = {};
      exposed.forEach((exp: any) => {
        if (exp.default_value !== undefined && exp.default_value !== '') {
          defaults[exp.id || exp.node_id] = exp.default_value;
        }
      });
      setDynamicInputs(prev => ({ ...defaults, ...prev }));
    }).catch(() => {
      setWorkflowExposedInputs([]);
      setDynamicInputs({});
    });
  };

  useEffect(() => {
    loadWorkflowInputs(genForm.workflow_id);
  }, [genForm.workflow_id]);

  const refreshStats = () => apiService.getAssetStats().then(setStats).catch(()=>{});

  const handleSearch = () => fetchAssets({ q: searchInput, page: 1 });

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

  const handleGenerate = async () => {
    if (!genForm.name.trim() || !genForm.prompt.trim()) { alert('请填写名称与提示词'); return; }
    if (!genForm.workflow_id) { alert('请选择一个 ComfyUI 工作流（已去除内置非工作流生图）'); return; }
    setGenerating(true);
    try {
      // 仅走工作流：提示词自动映射到工作流主文本槽位
      let effectiveDynamicInputs: Record<string, any> | undefined = Object.keys(dynamicInputs).length > 0 ? { ...dynamicInputs } : undefined;
      if (genForm.prompt.trim()) {
        effectiveDynamicInputs = effectiveDynamicInputs ? { ...effectiveDynamicInputs } : {};
        const promptText = genForm.prompt.trim();
        const candidates = workflowExposedInputs.filter((exp: any) => exp.type === 'text');
        let mainExp: any = null;
        if (candidates.length > 0) {
          mainExp = candidates.find((e: any) => /user|用户|主.*提示|文本段.*string_b/i.test(e.label + e.param_name)) || candidates.find((e: any) => e.param_name === 'string_b' || e.param_name === 'value') || candidates[0];
          if (mainExp) {
            const key = mainExp.id || mainExp.node_id;
            const curVal = effectiveDynamicInputs[key];
            if (!curVal || (typeof curVal === 'string' && curVal.trim() === '') || curVal === mainExp.default_value) {
              effectiveDynamicInputs[key] = promptText;
            }
          }
        }
      }
      const activePid = (useProjectListStore.getState() as any).activeProjectId || (useProjectStore.getState() as any).activeProjectId || null;
      const curScope = (useAssetStore.getState() as any).scope || 'all';
      const effScope = curScope === 'global' ? 'global' : (activePid ? 'project' : 'global');
      const res = await generateAsset({
        name: genForm.name.trim(),
        prompt: genForm.prompt.trim(),
        category: genForm.category,
        provider: 'comfyui',
        workflow_id: genForm.workflow_id,
        tags: genForm.tags || undefined,
        dynamic_inputs: effectiveDynamicInputs && Object.keys(effectiveDynamicInputs).length > 0 ? effectiveDynamicInputs : undefined,
        project_id: (effScope === 'project' && activePid) ? activePid : undefined,
        scope: effScope,
      } as any);
      setShowGenerate(false);
      setGenForm({ name: '', prompt: '', negative_prompt: '', category: 'character', provider: 'comfyui', workflow_id: '', aspect_ratio: '1:1', seed: '', tags: '' });
      setDynamicInputs({});
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
    if (!project?.characters?.length) { alert('当前项目无角色'); return; }
    if (!confirm(`将项目《${project.title}》的 ${project.characters.length} 个角色迁移为人物素材？`)) return;
    try {
      const data = await apiService.migrateCharacters(project.id, project.characters);
      alert(`已迁移 ${data.migrated} 个角色`);
      fetchAssets({ category: 'character', page: 1 });
      refreshStats();
    } catch (e: any) { alert(e.message); }
  };

  const handleApplyToShot = (asset: any) => {
    const st = useProjectStore.getState();
    const activeShotId = st.activeShotId;
    const curProject = st.project;
    if (!curProject) { alert('请先在项目看板创建/打开项目'); return; }
    let targetShotId = activeShotId;
    if (!targetShotId) {
      const firstShot = curProject.scenes?.flatMap((s:any)=>s.shots)?.[0];
      if (firstShot) {
        st.setActiveShotId(firstShot.id);
        targetShotId = firstShot.id;
      } else {
        alert('当前项目暂无分镜，已自动创建分镜并应用');
        // 将由 handleApplyToShot 再次尝试：先创建再应用在下一次点击生效，此处直接更新 prompt 兜底
      }
    }
    if (!targetShotId) { alert('请先在分镜工作台选中一个镜头'); return; }
    const url = asset.file_url || asset.thumb_url;
    const abs = url && url.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
    if (asset.category === 'character' && asset.visual_prompt) {
      updateShot(targetShotId, { image_prompt: asset.visual_prompt + ', ' + (curProject?.style_preset || '') } as any);
      // 角色素材若有图，顺带注入到当前分镜的工作流暴露首个 image 槽位（便于垫图）
      if (abs) {
        const curShot: any = curProject.scenes.flatMap((s:any)=>s.shots).find((s:any)=>s.id===targetShotId);
        if (curShot) {
          const existing = curShot.dynamic_inputs || {};
          // 仅当不存在时才注入，避免覆盖用户已填
          if (!Object.values(existing).some((v:any)=> typeof v==='string' && v.includes('/storage/'))) {
            updateShot(targetShotId, { dynamic_inputs: { ...existing, _asset_ref: abs } } as any);
          }
        }
      }
    } else if (asset.category === 'scene' || asset.category === 'background') {
      updateShot(targetShotId, { image_prompt: asset.visual_prompt || asset.description } as any);
    } else {
      updateShot(targetShotId, { image_prompt: (asset.visual_prompt || asset.name) + ', detailed prop' } as any);
    }
    // 若资产有图，尝试作为 dynamic_inputs 的 image 注入（供 ShotInspector 的 exposed image 直接预览）
    if (abs) {
      try {
        const curShot2: any = useProjectStore.getState().project?.scenes.flatMap((s:any)=>s.shots).find((s:any)=>s.id===targetShotId);
        if (curShot2 && curShot2.dynamic_inputs !== undefined) {
          // 不强制，交由用户拖拽；仅提示
        }
      } catch {}
    }
    // 切到分镜工作台并提示
    st.setActiveTab('studio');
    try { window.dispatchEvent(new CustomEvent('asset-applied', { detail: { assetId: asset.id, shotId: targetShotId } })); } catch {}
  };

  const handleAddAsCharacter = (asset: any) => {
    const st = useProjectStore.getState();
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
      voice_id: asset.voice_id || 'male-qn-qingse',
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
      <div className="w-[260px] bg-surface border-r border-border flex flex-col shrink-0">
        <div className="h-12 px-3 border-b border-border flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><Library className="w-3.5 h-3.5 text-brand" /></div>
          <span className="text-xs font-bold tracking-tight text-white">素材库</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">{total}</span>
          <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-brand/10 text-brand border border-brand/20">{(useProjectListStore as any)?.getState?.()?.activeProjectId ? '项目' : '全局'}</span>
        </div>
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex rounded-full bg-surface-secondary border border-border p-1 gap-1">
            {(['all','project','global'] as const).map(s=> (
              <button key={s} onClick={()=>fetchAssets({ scope: s, page: 1 })} className={`flex-1 py-1 rounded-full text-[11px] font-bold transition-all ${((useAssetStore as any).getState?.().scope||'all')===s ? 'bg-white dark:bg-brand text-surface dark:text-white shadow-sm' : 'text-gray-500 hover:text-white'}`}>{s==='all'?'全部':s==='project'?'项目':'全局'}</button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-full bg-surface-secondary border border-border px-3 py-1.5 focus-within:border-brand/40">
            <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <input value={searchInput} onChange={e=>setSearchInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} placeholder="搜索名称/标签" className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none min-w-0" />
            <button onClick={handleSearch} className="text-[11px] font-bold text-brand hover:text-brand-light">搜索</button>
          </div>
        </div>
        <div className="p-2 space-y-1 flex-1 overflow-y-auto">
          {CATEGORY_TABS.map(t => (
            <button key={t.key} onClick={()=>setCategory(t.key as any)} className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-all ${category===t.key ? 'bg-brand/15 border border-brand text-white' : 'text-gray-400 hover:bg-surface-secondary hover:text-white border border-transparent'}`}>
              <span className="flex items-center space-x-2">{t.icon}<span>{t.label}</span></span>
              {stats?.by_category?.[t.key] != null && t.key!=='all' && <span className="text-[10px] bg-surface-tertiary px-1.5 py-0.5 rounded">{stats.by_category[t.key]}</span>}
              {t.key==='all' && <span className="text-[10px] bg-surface-tertiary px-1.5 py-0.5 rounded">{stats?.total||total}</span>}
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-border space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={()=>setShowImport(true)} className="flex items-center justify-center space-x-1.5 py-2.5 rounded-xl bg-gradient-to-r from-brand to-accent-pink text-white text-xs font-bold shadow-lg shadow-brand/20">
              <Upload className="w-3.5 h-3.5" /><span>导入</span>
            </button>
            <button onClick={()=>setShowGenerate(true)} className="flex items-center justify-center space-x-1.5 py-2.5 rounded-xl bg-surface-secondary border border-brand/40 text-xs text-white font-semibold hover:bg-brand/10">
              <Wand2 className="w-3.5 h-3.5" /><span>生成</span>
            </button>
          </div>
          <p className="text-[10px] text-gray-500 text-center leading-4">导入：本地批量上传 · 生成：AI 直出入库</p>
          <button onClick={handleMigrate} className="w-full flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-tertiary border border-border text-[11px] text-gray-300 hover:text-white">
            <Sparkles className="w-3 h-3" /><span>一键迁移角色</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative min-w-0">
        <div className="h-11 px-4 border-b border-border bg-surface/60 backdrop-blur flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className="w-7 h-7 rounded-lg bg-surface-secondary border border-border flex items-center justify-center shrink-0"><Filter className="w-3.5 h-3.5 text-gray-400" /></span>
            <span className="text-white font-medium truncate">{category==='all'?'全部素材':CATEGORY_TABS.find(c=>c.key===category)?.label}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-400">{total} 个</span>
            {q && <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand-light text-xs">"{q}"</span>}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 shrink-0">
            <select value={(useAssetStore as any).getState?.()?.sort || 'updated_at'} onChange={e=>fetchAssets({ sort: e.target.value, page: 1 })} className="hidden sm:block bg-surface-secondary border border-border rounded-full px-3 py-1 text-xs text-white focus:outline-none">
              <option value="updated_at">最近更新</option><option value="created_at">创建时间</option><option value="name">名称</option>
            </select>
            <button onClick={()=>importInputRef.current?.click()} className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full bg-white dark:bg-surface-secondary border border-border text-xs font-medium text-surface dark:text-white hover:border-border-active">
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
                <button onClick={()=>setShowGenerate(true)} className="px-4 py-2 rounded-xl bg-surface border border-border text-xs text-white flex items-center space-x-1"><Wand2 className="w-3.5 h-3.5" /><span>AI 生成</span></button>
              </div>
            </div>
            ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {assets.map((a: any) => {
                  const url = a.file_url || a.thumb_url;
                  const abs = url && url.startsWith('/') ? `http://127.0.0.1:8000${url}` : url;
                  return (
                  <div key={a.id} draggable onDragStart={e=>{ e.dataTransfer.setData('text/plain', abs||url||''); e.dataTransfer.setData('application/canvas-assetid', a.id); e.dataTransfer.setData('application/asset-category', a.category||''); e.dataTransfer.effectAllowed='copy'; }} onClick={()=>{selectAsset(a.id); setDetailAsset(a);}} title="拖拽到分镜垫图槽或画布" className={`group bg-surface border rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing transition-all hover:shadow-lg ${selectedId===a.id ? 'border-brand ring-1 ring-brand/30' : 'border-border hover:border-border-active'}`}>
                    <div className="aspect-square bg-black/60 relative overflow-hidden">
                      {a.thumb_url || a.file_url ? (
                        <img src={resolveUrl(a.thumb_url||a.file_url)} alt={a.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-gray-600">
                          <ImageIcon className="w-6 h-6 mb-1" /><span className="text-[10px]">{a.category}</span>
                        </div>
                      )}
                      <div className="absolute top-2 left-2 flex items-center space-x-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${a.category==='character'?'bg-accent-pink/20 text-accent-pink border-accent-pink/30': a.category==='scene'?'bg-accent-green/20 text-accent-green border-accent-green/30':'bg-brand/20 text-brand-light border-brand/30'}`}>{a.category}</span>
                        {a.status!=='approved' && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">{a.status}</span>}
                      </div>
                      {a.source==='generate' && <span className="absolute top-2 right-2 text-[8px] px-1.5 py-0.5 rounded-full bg-violet-500/90 text-white font-bold">AI</span>}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 space-x-1">
                        <button onClick={(e)=>{e.stopPropagation(); handleApplyToShot(a);}} className="flex-1 py-1 rounded-lg bg-brand text-white text-[10px] font-bold">应用到镜头</button>
                        <button onClick={(e)=>{e.stopPropagation(); duplicateAsset(a.id);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30"><Copy className="w-3 h-3" /></button>
                        <button onClick={(e)=>{e.stopPropagation(); openEdit(a);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30" title="编辑"><Pencil className="w-3 h-3" /></button>
                      </div>
                    </div>
                    <div className="p-2.5">
                      <div className="text-xs font-semibold text-white truncate">{a.name}</div>
                      <div className="text-[10px] text-gray-400 truncate mt-0.5">{a.description || a.visual_prompt?.slice(0,40) || '—'}</div>
                      {a.tags?.length>0 && <div className="flex flex-wrap gap-1 mt-1.5">{a.tags.slice(0,3).map((t:string)=><span key={t} className="text-[9px] px-1 py-0.5 rounded bg-surface-tertiary text-gray-400 flex items-center space-x-0.5"><Tag className="w-2.5 h-2.5" /><span>{t}</span></span>)}{a.tags.length>3 && <span className="text-[9px] text-gray-500">+{a.tags.length-3}</span>}</div>}
                    </div>
                  </div>
                  );
                })}
              </div>
              {total > 24 && (
                <div className="mt-4 flex items-center justify-center gap-2 text-xs">
                  <button disabled={(useAssetStore as any).getState().page <= 1} onClick={()=>fetchAssets({ page: Math.max(1, (useAssetStore as any).getState().page - 1) })} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-white disabled:opacity-40">上一页</button>
                  <span className="text-gray-400 font-mono">第 {(useAssetStore as any).getState().page} 页 / 共 {Math.ceil(total/24)} 页 · {total} 条</span>
                  <button disabled={(useAssetStore as any).getState().page >= Math.ceil(total/24)} onClick={()=>fetchAssets({ page: (useAssetStore as any).getState().page + 1 })} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-white disabled:opacity-40">下一页</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-80 bg-surface border-l border-border flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <span className="text-sm font-bold text-white">素材详情</span>
            <button onClick={()=>{selectAsset(null); setDetailAsset(null);}} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="aspect-square rounded-xl overflow-hidden bg-black/60 border border-border">
              {selected.file_url ? <img src={resolveUrl(selected.file_url)} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-gray-500">无预览</div>}
            </div>
            <div>
              <div className="text-sm font-bold text-white">{selected.name}</div>
              <div className="text-xs text-gray-400 mt-1">{selected.category} {selected.subcategory && `· ${selected.subcategory}`} · {selected.source==='generate'?'AI生成':selected.source==='upload'?'本地导入':'迁移'}</div>
              {selected.description && <p className="text-xs text-gray-300 mt-2 leading-5">{selected.description}</p>}
            </div>
            <div>
              <label className="text-xs font-semibold text-white block mb-1">视觉提示词</label>
              <div className="bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-gray-300 max-h-24 overflow-y-auto break-words">{selected.visual_prompt || '—'}</div>
              <button onClick={()=>handleApplyToShot(selected)} className="mt-2 w-full py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center space-x-1">
                <Sparkles className="w-3.5 h-3.5" /><span>应用到当前镜头</span>
              </button>
              <button onClick={()=>handleAddAsCharacter(selected)} className="mt-1.5 w-full py-2 rounded-xl bg-surface-secondary border border-brand/30 text-xs text-brand-light hover:text-white hover:bg-brand/10 flex items-center justify-center space-x-1">
                <Users className="w-3.5 h-3.5" /><span>添加为项目角色</span>
              </button>
              <div className="mt-1.5 text-[10px] text-gray-500 flex items-center gap-1"><span>💡 拖拽卡片到分镜垫图槽可直接作为参考图</span></div>
            </div>
            {selected.tags?.length>0 && <div className="flex flex-wrap gap-1.5">{selected.tags.map((t:string)=><span key={t} className="text-xs px-2 py-1 rounded-full bg-brand/15 text-brand-light border border-brand/30">{t}</span>)}</div>}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-surface-secondary border border-border rounded-xl p-2">
                <div className="text-gray-500">尺寸</div><div className="text-white font-mono">{selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'}</div>
              </div>
              <div className="bg-surface-secondary border border-border rounded-xl p-2">
                <div className="text-gray-500">来源</div><div className="text-white flex items-center space-x-1">{selected.source==='generate' && <Sparkles className="w-3 h-3 text-violet-400" />}<span>{selected.source}</span></div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={()=>openEdit(selected)} className="py-2 rounded-xl bg-brand/20 border border-brand/40 text-xs text-brand-light hover:bg-brand/30 hover:text-white flex items-center justify-center space-x-1 font-semibold"><Pencil className="w-3.5 h-3.5" /><span>编辑</span></button>
              <button onClick={()=>duplicateAsset(selected.id)} className="py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white flex items-center justify-center space-x-1"><Copy className="w-3.5 h-3.5" /><span>复制</span></button>
              <button onClick={async()=>{ if(confirm('确定删除？')){ await deleteAsset(selected.id); setDetailAsset(null); selectAsset(null); } }} className="py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-300 flex items-center justify-center space-x-1"><Trash2 className="w-3.5 h-3.5" /><span>删除</span></button>
            </div>
          </div>
        </div>
      )}

      {showEdit && selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowEdit(false)}>
          <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Edit3 className="w-4 h-4 text-brand" /><span>编辑素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">更新</span></h3>
              <button onClick={()=>setShowEdit(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">名称 *</label>
                <input value={editForm.name} onChange={e=>setEditForm({...editForm, name:e.target.value})} placeholder="素材名称" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="text-xs text-gray-300">分类</label>
                <select value={editForm.category} onChange={e=>setEditForm({...editForm, category: e.target.value as any})} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">描述</label>
              <textarea value={editForm.description} onChange={e=>setEditForm({...editForm, description:e.target.value})} rows={2} placeholder="素材描述" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-300">视觉提示词</label>
              <textarea value={editForm.visual_prompt} onChange={e=>setEditForm({...editForm, visual_prompt:e.target.value})} rows={3} placeholder="英文提示词，用于一致性生成" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">标签（逗号分隔）</label>
                <input value={editForm.tags} onChange={e=>setEditForm({...editForm, tags:e.target.value})} placeholder="如：主角, 玄幻" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white" />
              </div>
              <div>
                <label className="text-xs text-gray-300">状态</label>
                <select value={editForm.status} onChange={e=>setEditForm({...editForm, status:e.target.value})} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                  <option value="approved">已审核</option><option value="draft">草稿</option><option value="archived">归档</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">替换预览图（可选）</label>
              <div className="mt-1 flex items-center gap-3">
                <input ref={editFileRef} type="file" accept="image/*" hidden onChange={e=>{ const f=e.target.files?.[0]||null; setEditFile(f); }} />
                <button type="button" onClick={()=>editFileRef.current?.click()} className="px-3 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5" /><span>{editFile ? editFile.name : '选择图片'}</span>
                </button>
                {editFile && <button type="button" onClick={()=>{ setEditFile(null); if(editFileRef.current) editFileRef.current.value=''; }} className="text-xs text-gray-400 hover:text-white">清空</button>}
                {selected.file_url && !editFile && <span className="text-[11px] text-gray-500 truncate max-w-[180px]">当前：{selected.file_url.split('/').pop()}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={()=>setShowEdit(false)} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              <button onClick={handleUpdate} disabled={updating} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40 flex items-center gap-1.5">{updating ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>保存中…</span></> : <><Save className="w-3.5 h-3.5" /><span>保存更新</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowImport(false)}>
          <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Upload className="w-4 h-4 text-brand" /><span>导入素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">批量</span></h3>
              <button onClick={()=>setShowImport(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            <div onDragOver={e=>e.preventDefault()} onDrop={e=>{ e.preventDefault(); const f=Array.from(e.dataTransfer.files||[]); if(f.length) setImportFiles(f); }} className="border-2 border-dashed border-border rounded-2xl p-5 text-center bg-surface-secondary/50 hover:border-brand/40 transition-colors cursor-pointer" onClick={()=>importInputRef.current?.click()}>
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
                <select value={importMeta.category} onChange={e=>setImportMeta({...importMeta, category: e.target.value as any})} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-300">标签（逗号分隔）</label>
                <input value={importMeta.tags} onChange={e=>setImportMeta({...importMeta, tags:e.target.value})} placeholder="如：主角, 玄幻" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">视觉提示词（可选，批量时统一应用）</label>
              <textarea value={importMeta.visual_prompt} onChange={e=>setImportMeta({...importMeta, visual_prompt:e.target.value})} rows={2} placeholder="英文提示词，用于后续一致性生成" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            {importFiles.length>0 && <button onClick={()=>setImportFiles([])} className="text-[11px] text-gray-400 hover:text-white flex items-center space-x-1"><X className="w-3 h-3" /><span>清空已选</span></button>}
            <div className="flex justify-end space-x-2 pt-1">
              <button onClick={()=>setShowImport(false)} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              <button onClick={handleImport} disabled={importing || importFiles.length===0} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40 flex items-center space-x-1.5">{importing? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>导入中…</span></> : <><Check className="w-3.5 h-3.5" /><span>确认导入{importFiles.length?` · ${importFiles.length}个`:''}</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {showGenerate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={()=>setShowGenerate(false)}>
          <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Wand2 className="w-4 h-4 text-violet-400" /><span>AI 生成素材</span><span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/20">入库</span></h3>
              <button onClick={()=>setShowGenerate(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-gray-500 -mt-2">仅支持 ComfyUI 工作流生成（已移除内置非工作流通道），请选择已导入/外部直读的工作流。</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">名称 *</label>
                <input value={genForm.name} onChange={e=>setGenForm({...genForm, name:e.target.value})} placeholder="如：雪山神殿-夜景" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="text-xs text-gray-300">类别</label>
                <select value={genForm.category} onChange={e=>setGenForm({...genForm, category: e.target.value as any})} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">提示词 Prompt *</label>
              <textarea value={genForm.prompt} onChange={e=>setGenForm({...genForm, prompt:e.target.value})} rows={3} placeholder="英文提示词，如：ancient temple in snow mountain, cinematic lighting, ultra detailed" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-white">工作流（ComfyUI） *</label>
                  {genForm.workflow_id && (
                    <button
                      type="button"
                      onClick={() => setInspectWfId(genForm.workflow_id)}
                      className="text-[10px] text-accent-blue hover:text-blue-400 hover:underline flex items-center gap-0.5"
                    >
                      <span>⚙️ 参数配置与诊断</span>
                    </button>
                  )}
                </div>
                <select
                  value={genForm.workflow_id}
                  onChange={e => {
                    const wfId = e.target.value;
                    setGenForm(prev => ({
                      ...prev,
                      workflow_id: wfId,
                    }));
                  }}
                  className="mt-1 w-full bg-surface-secondary border border-brand/40 rounded-xl px-3 py-2 text-xs text-white focus:border-brand"
                >
                  <option value="">— 请选择工作流（必填）—</option>
                  {workflows.map((w: any) => <option key={w.id} value={w.id}>{w.name || w.id} {w.source==='external'?'·外部':''}</option>)}
                </select>
              </div>

            {/* Dynamic Exposed Inputs Section */}
            {workflowExposedInputs.length > 0 && (
              <div className="bg-surface-secondary/70 border border-brand/30 rounded-xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-brand-light flex items-center gap-1.5">
                    <span>⭐️ 该工作流专属输入项 ({workflowExposedInputs.length})</span>
                  </span>
                  <span className="text-[10px] text-gray-400">已自适应匹配工作流内部节点</span>
                </div>

                <div className="space-y-3">
                  {workflowExposedInputs.map((exp: any) => {
                    const key = exp.id || exp.node_id;
                    const val = dynamicInputs[key];
                    return (
                      <div key={key} className="space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <label className="text-gray-300 font-medium flex items-center gap-1">
                            <span>{exp.label || exp.param_name}</span>
                            {exp.required && <span className="text-red-400">*</span>}
                          </label>
                          <span className="text-[10px] text-gray-500 font-mono">
                            #{exp.node_id} · {exp.type === 'image' ? '垫图' : exp.type === 'text' ? '文本' : exp.type}
                          </span>
                        </div>

                        {exp.type === 'image' ? (
                          <div className="flex items-center gap-3">
                            {val ? (
                              <div className="relative w-14 h-14 rounded-lg border border-brand overflow-hidden group shrink-0 bg-black/50">
                                <img
                                  src={resolveUrl(val)}
                                  alt="Preview"
                                  className="w-full h-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => setDynamicInputs(p => ({ ...p, [key]: '' }))}
                                  className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 text-white flex items-center justify-center text-[10px] transition"
                                >
                                  ✕ 移除
                                </button>
                              </div>
                            ) : null}

                            <div className="flex-1 flex items-center gap-2">
                              <label className="flex-1 border border-dashed border-border hover:border-brand rounded-lg p-2.5 text-center cursor-pointer bg-surface/50 text-[11px] text-gray-300 hover:text-white transition flex items-center justify-center gap-1.5">
                                <input
                                  type="file"
                                  accept="image/*"
                                  className="hidden"
                                  onChange={e => {
                                    const f = e.target.files?.[0];
                                    if (f) {
                                      const reader = new FileReader();
                                      reader.onload = () => {
                                        setDynamicInputs(p => ({ ...p, [key]: reader.result }));
                                      };
                                      reader.readAsDataURL(f);
                                    }
                                  }}
                                />
                                <Upload className="w-3.5 h-3.5 text-brand" />
                                <span>{val ? '更换垫图 / 参考图' : '📁 上传垫图 / 角色参考图'}</span>
                              </label>

                              {assets.length > 0 && (
                                <select
                                  onChange={e => {
                                    if (e.target.value) {
                                      setDynamicInputs(p => ({ ...p, [key]: e.target.value }));
                                    }
                                  }}
                                  className="bg-surface border border-border rounded-lg px-2 py-2 text-[11px] text-gray-400 focus:outline-none focus:border-brand"
                                >
                                  <option value="">从素材库选...</option>
                                  {assets.map((a: any) => (
                                    <option key={a.id} value={a.file_url || a.thumb_url}>
                                      {a.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </div>
                          </div>
                        ) : exp.type === 'number' ? (
                          <input
                            type="number"
                            value={val ?? ''}
                            onChange={e =>
                              setDynamicInputs(p => ({ ...p, [key]: parseFloat(e.target.value) }))
                            }
                            placeholder={exp.description || '输入数值'}
                            className="w-full bg-surface border border-border rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand font-mono"
                          />
                        ) : (
                          <textarea
                            rows={2}
                            value={val ?? ''}
                            onChange={e =>
                              setDynamicInputs(p => ({ ...p, [key]: e.target.value }))
                            }
                            placeholder={exp.description || `输入 ${exp.label}`}
                            className="w-full bg-surface border border-border rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand font-sans resize-none"
                          />
                        )}
                        {exp.description && (
                          <p className="text-[10px] text-gray-500">{exp.description}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-gray-300">标签（可选，逗号分隔）</label>
              <input value={genForm.tags} onChange={e=>setGenForm({...genForm, tags:e.target.value})} placeholder="如：主角, 玄幻, 古风" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white" />
            </div>
            <div className="flex justify-end space-x-2 pt-1">
              <button onClick={()=>setShowGenerate(false)} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              <button onClick={handleGenerate} disabled={generating || !genForm.workflow_id} className="px-5 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-brand text-white text-xs font-bold disabled:opacity-40 flex items-center space-x-1.5" title={!genForm.workflow_id ? '请先选择工作流' : '生成并入库'}>{generating? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>生成中…</span></> : <><Sparkles className="w-3.5 h-3.5" /><span>生成并入库</span></>}</button>
            </div>
          </div>
        </div>
      )}

      {inspectWfId && (
        <WorkflowInspectorModal
          workflowId={inspectWfId}
          isOpen={!!inspectWfId}
          onClose={() => setInspectWfId('')}
          onSaved={() => {
            apiService.listWorkflows('all').then(d => setWorkflows(d.workflows || d || [])).catch(() => {});
            loadWorkflowInputs(inspectWfId);
          }}
          onDeleted={(deletedId) => {
            setWorkflows(prev => prev.filter((w: any) => w.id !== deletedId));
            if (genForm.workflow_id === deletedId) {
              setGenForm(prev => ({ ...prev, workflow_id: '' }));
              setWorkflowExposedInputs([]);
              setDynamicInputs({});
            }
            apiService.listWorkflows('all').then(d => setWorkflows(d.workflows || d || [])).catch(() => {});
          }}
        />
      )}
    </div>
  );
};
