import React, { useEffect, useState } from 'react';
import { Search, Plus, Layers, Users, Mountain, Box, Image as ImageIcon, Sparkles, Copy, Trash2, Edit3, Tag, Filter, Library, Upload, Wand2, CheckCircle2 } from 'lucide-react';
import { useAssetStore } from '../../stores/useAssetStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { AssetCategory } from '../../types';

const CATEGORY_TABS: { key: AssetCategory | 'all'; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Library className="w-3.5 h-3.5" /> },
  { key: 'character', label: '人物', icon: <Users className="w-3.5 h-3.5" /> },
  { key: 'scene', label: '场景', icon: <Mountain className="w-3.5 h-3.5" /> },
  { key: 'prop', label: '道具', icon: <Box className="w-3.5 h-3.5" /> },
  { key: 'background', label: '背景', icon: <ImageIcon className="w-3.5 h-3.5" /> },
  { key: 'effect', label: '特效', icon: <Sparkles className="w-3.5 h-3.5" /> },
  { key: 'other', label: '其他', icon: <Layers className="w-3.5 h-3.5" /> },
];

const API_ORIGIN = 'http://127.0.0.1:8000';
const resolveUrl = (u?: string) => u && u.startsWith('/') ? API_ORIGIN + u : u;

export const AssetLibrary: React.FC = () => {
  const { assets, total, category, q, isLoading, selectedId, fetchAssets, setCategory, setQuery, selectAsset, deleteAsset, duplicateAsset } = useAssetStore();
  const { project, updateShot } = useProjectStore();
  const [searchInput, setSearchInput] = useState(q);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', category: 'character' as AssetCategory, visual_prompt: '', tags: '', description: '' });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [detailAsset, setDetailAsset] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => { fetchAssets({ category: category, page: 1 }); }, []);
  useEffect(() => { fetch('/api/v1/assets/stats').then(r => r.json()).then(setStats).catch(()=>{}); }, [assets.length]);

  const handleSearch = () => { fetchAssets({ q: searchInput, page: 1 }); };
  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    setCreating(true);
    try {
      const fd = new FormData();
      fd.append('name', createForm.name);
      fd.append('category', createForm.category);
      fd.append('visual_prompt', createForm.visual_prompt);
      fd.append('description', createForm.description);
      if (createForm.tags) fd.append('tags', createForm.tags);
      if (uploadFile) fd.append('file', uploadFile);
      const res = await fetch('/api/v1/assets', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      setShowCreate(false);
      setCreateForm({ name: '', category: 'character', visual_prompt: '', tags: '', description: '' });
      setUploadFile(null);
      fetchAssets({ page: 1 });
    } catch (e: any) { alert(e.message); } finally { setCreating(false); }
  };

  const handleMigrate = async () => {
    if (!project?.characters?.length) { alert('当前项目无角色'); return; }
    if (!confirm(`将项目《${project.title}》的 ${project.characters.length} 个角色迁移为人物素材？`)) return;
    const res = await fetch('/api/v1/assets/migrate/characters', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ project_id: project.id, characters: project.characters })});
    if (!res.ok) { alert(await res.text()); return; }
    const data = await res.json();
    alert(`已迁移 ${data.migrated} 个角色`);
    fetchAssets({ category: 'character', page: 1 });
  };

  const handleApplyToShot = (asset: any) => {
    const activeShotId = useProjectStore.getState().activeShotId;
    if (!activeShotId) { alert('请先在分镜工作台选中一个镜头'); return; }
    // 根据类别注入不同字段
    if (asset.category === 'character' && asset.visual_prompt) {
      updateShot(activeShotId, { image_prompt: asset.visual_prompt + ', ' + (project?.style_preset || '') });
    } else if (asset.category === 'scene' || asset.category === 'background') {
      updateShot(activeShotId, { image_prompt: asset.visual_prompt || asset.description });
    } else {
      updateShot(activeShotId, { image_prompt: (asset.visual_prompt || asset.name) + ', detailed prop' });
    }
    alert(`已应用素材《${asset.name}》到当前镜头`);
  };

  const selected = assets.find(a => a.id === selectedId) || detailAsset;

  return (
    <div className="flex-1 flex h-[calc(100vh-3.5rem)] bg-background overflow-hidden">
      {/* Left: Filters */}
      <div className="w-60 bg-surface border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="flex items-center space-x-2 mb-3">
            <Library className="w-4 h-4 text-brand-light" />
            <span className="text-sm font-bold text-white">素材库</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/30">{total}</span>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input value={searchInput} onChange={e=>setSearchInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} placeholder="搜索 名称/标签/提示词" className="w-full bg-surface-secondary border border-border rounded-xl pl-8 pr-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
          </div>
          <button onClick={handleSearch} className="mt-2 w-full py-1.5 rounded-xl bg-brand text-white text-xs font-semibold hover:opacity-90">搜索</button>
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
          <button onClick={()=>setShowCreate(true)} className="w-full flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-gradient-to-r from-brand to-accent-pink text-white text-xs font-bold">
            <Plus className="w-3.5 h-3.5" /><span>新建素材</span>
          </button>
          <button onClick={handleMigrate} className="w-full flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-gray-300 hover:text-white">
            <Wand2 className="w-3.5 h-3.5" /><span>一键迁移角色</span>
          </button>
        </div>
      </div>

      {/* Center: Grid */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="h-10 px-4 flex items-center justify-between border-b border-border bg-surface/50">
          <div className="flex items-center space-x-2 text-xs text-gray-400">
            <Filter className="w-3.5 h-3.5" /><span>分类: {category==='all'?'全部':CATEGORY_TABS.find(c=>c.key===category)?.label}</span>
            {q && <span className="px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/30">关键词: {q}</span>}
          </div>
          <div className="text-[10px] text-gray-500">{isLoading?'加载中…':`${total} 个素材`}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">加载中…</div>
          ) : assets.length===0 ? (
            <div className="flex flex-col items-center justify-center h-60 text-gray-500 space-y-2">
              <Library className="w-8 h-8 opacity-50" />
              <span className="text-sm">暂无素材</span>
              <span className="text-xs">点击“新建素材”或“一键迁移角色”开始</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {assets.map(a => (
                <div key={a.id} onClick={()=>{selectAsset(a.id); setDetailAsset(a);}} className={`group bg-surface border rounded-2xl overflow-hidden cursor-pointer transition-all hover:shadow-lg ${selectedId===a.id ? 'border-brand ring-1 ring-brand/30' : 'border-border hover:border-border-active'}`}>
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
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 space-x-1">
                      <button onClick={(e)=>{e.stopPropagation(); handleApplyToShot(a);}} className="flex-1 py-1 rounded-lg bg-brand text-white text-[10px] font-bold">应用到镜头</button>
                      <button onClick={(e)=>{e.stopPropagation(); duplicateAsset(a.id);}} className="p-1 rounded-lg bg-white/20 text-white hover:bg-white/30"><Copy className="w-3 h-3" /></button>
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-xs font-semibold text-white truncate">{a.name}</div>
                    <div className="text-[10px] text-gray-400 truncate mt-0.5">{a.description || a.visual_prompt?.slice(0,40) || '—'}</div>
                    {a.tags?.length>0 && <div className="flex flex-wrap gap-1 mt-1.5">{a.tags.slice(0,3).map((t:string)=><span key={t} className="text-[9px] px-1 py-0.5 rounded bg-surface-tertiary text-gray-400 flex items-center space-x-0.5"><Tag className="w-2.5 h-2.5" /><span>{t}</span></span>)}{a.tags.length>3 && <span className="text-[9px] text-gray-500">+{a.tags.length-3}</span>}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail */}
      {selected && (
        <div className="w-80 bg-surface border-l border-border flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <span className="text-sm font-bold text-white">素材详情</span>
            <button onClick={()=>{selectAsset(null); setDetailAsset(null);}} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="aspect-square rounded-xl overflow-hidden bg-black/60 border border-border">
              {selected.file_url ? <img src={resolveUrl(selected.file_url)} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-gray-500">无预览</div>}
            </div>
            <div>
              <div className="text-sm font-bold text-white">{selected.name}</div>
              <div className="text-xs text-gray-400 mt-1">{selected.category} {selected.subcategory && `· ${selected.subcategory}`}</div>
              {selected.description && <p className="text-xs text-gray-300 mt-2 leading-5">{selected.description}</p>}
            </div>
            <div>
              <label className="text-xs font-semibold text-white block mb-1">视觉提示词</label>
              <div className="bg-surface-secondary border border-border rounded-xl p-2.5 text-xs font-mono text-gray-300 max-h-24 overflow-y-auto">{selected.visual_prompt || '—'}</div>
              <button onClick={()=>handleApplyToShot(selected)} className="mt-2 w-full py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center justify-center space-x-1">
                <Sparkles className="w-3.5 h-3.5" /><span>应用到当前镜头</span>
              </button>
            </div>
            {selected.tags?.length>0 && <div className="flex flex-wrap gap-1.5">{selected.tags.map((t:string)=><span key={t} className="text-xs px-2 py-1 rounded-full bg-brand/15 text-brand-light border border-brand/30">{t}</span>)}</div>}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-surface-secondary border border-border rounded-xl p-2">
                <div className="text-gray-500">尺寸</div><div className="text-white font-mono">{selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'}</div>
              </div>
              <div className="bg-surface-secondary border border-border rounded-xl p-2">
                <div className="text-gray-500">来源</div><div className="text-white">{selected.source}</div>
              </div>
            </div>
            <div className="flex space-x-2">
              <button onClick={()=>duplicateAsset(selected.id)} className="flex-1 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white flex items-center justify-center space-x-1"><Copy className="w-3.5 h-3.5" /><span>复制</span></button>
              <button onClick={async()=>{ if(confirm('确定删除？')){ await deleteAsset(selected.id); setDetailAsset(null); selectAsset(null); } }} className="flex-1 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-300 flex items-center justify-center space-x-1"><Trash2 className="w-3.5 h-3.5" /><span>删除</span></button>
            </div>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2"><Plus className="w-4 h-4 text-brand" /><span>新建素材</span></h3>
              <button onClick={()=>setShowCreate(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-300">名称 *</label>
                <input value={createForm.name} onChange={e=>setCreateForm({...createForm, name:e.target.value})} placeholder="如：叶凡-战损版、雪山神殿" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand" />
              </div>
              <div>
                <label className="text-xs text-gray-300">类别</label>
                <select value={createForm.category} onChange={e=>setCreateForm({...createForm, category: e.target.value as any})} className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                  <option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option><option value="background">背景</option><option value="effect">特效</option><option value="other">其他</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-300">视觉提示词 (用于一致性生成)</label>
              <textarea value={createForm.visual_prompt} onChange={e=>setCreateForm({...createForm, visual_prompt:e.target.value})} rows={2} placeholder="英文提示词，如：1boy, black hair, ancient robes, cinematic lighting" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white" />
            </div>
            <div>
              <label className="text-xs text-gray-300">描述</label>
              <input value={createForm.description} onChange={e=>setCreateForm({...createForm, description:e.target.value})} placeholder="简要描述" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white" />
            </div>
            <div>
              <label className="text-xs text-gray-300">标签（逗号分隔）</label>
              <input value={createForm.tags} onChange={e=>setCreateForm({...createForm, tags:e.target.value})} placeholder="如：主角, 玄幻, 战损" className="mt-1 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white" />
            </div>
            <div>
              <label className="text-xs text-gray-300 flex items-center space-x-1"><Upload className="w-3 h-3" /><span>上传文件（可选）</span></label>
              <input type="file" accept="image/*,audio/*,video/*" onChange={e=>setUploadFile(e.target.files?.[0]||null)} className="mt-1 w-full text-xs text-gray-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-brand file:text-white" />
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <button onClick={()=>setShowCreate(false)} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              <button onClick={handleCreate} disabled={creating} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40">{creating?'创建中…':'创建'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
