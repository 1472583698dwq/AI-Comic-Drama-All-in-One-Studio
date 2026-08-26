import React, { useEffect, useState } from 'react';
import { FolderKanban, Plus, Upload, Search, Trash2, Copy, Archive, ExternalLink, Sparkles, Clock, Film, Users, Filter } from 'lucide-react';
import { useProjectListStore } from '../stores/useProjectListStore';
import { useProjectStore } from '../stores/useProjectStore';
import { apiService } from '../services/api';

export const ProjectDashboard: React.FC = () => {
  const { projects, fetchProjects, createBlank, importProjectFile, openProject, deleteProject, duplicateProject, isLoading } = useProjectListStore();
  const { setProject } = useProjectStore();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('updated_at');
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStyle, setNewStyle] = useState('donghua_xianxia');
  const [newRatio, setNewRatio] = useState('9:16');

  useEffect(() => { fetchProjects({ q: q || undefined, status, sort }); }, [status, sort]);
  const handleSearch = () => fetchProjects({ q: q || undefined, status, sort });

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    const meta = await createBlank({ title: newTitle.trim(), style_preset: newStyle, aspect_ratio: newRatio });
    setShowCreate(false); setNewTitle('');
    // 打开后自动尝试加载内容
    try {
      const data = await apiService.getProject(meta.id);
      if (data.content) setProject(data.content);
    } catch {}
    useProjectStore.getState().setActiveTab('studio');
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const res = await importProjectFile(f);
      // 若返回内容则直接加载
      try {
        const data = await apiService.getProject(res.id);
        if (data.content) setProject(data.content);
        useProjectStore.getState().setActiveTab('studio');
      } catch {}
    } catch (err: any) { alert(err.message); }
    e.target.value = '';
  };

  const handleOpen = async (id: string) => {
    await openProject(id);
    try {
      const data = await apiService.getProject(id);
      if (data.content) {
        setProject(data.content);
        useProjectStore.getState().setActiveTab('studio');
      } else {
        // 空白项目：创建一个默认空 Project 供编辑
        const meta = projects.find(p=>p.id===id);
        setProject({
          id,
          title: meta?.title || '未命名项目',
          original_novel: '',
          style_preset: meta?.style_preset || 'donghua_xianxia',
          aspect_ratio: (meta?.aspect_ratio as any) || '9:16',
          characters: [],
          scenes: [{ id: 'scene-1', scene_index: 1, title: '场景 1', location: '', time_of_day: 'day', atmosphere: 'epic', shots: [] }],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any);
        useProjectStore.getState().setActiveTab('studio');
      }
    } catch (e:any) { alert(e.message); }
  };

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden">
      {/* Toolbar */}
      <div className="px-6 py-4 border-b border-border flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <FolderKanban className="w-5 h-5 text-brand" />
          <h2 className="text-sm font-bold text-white">项目看板</h2>
          <span className="text-xs text-gray-400">{projects.length} 个项目</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-surface-secondary border border-border rounded-xl px-2">
            <Search className="w-4 h-4 text-gray-500" />
            <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} placeholder="搜索项目标题…" className="bg-transparent px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none w-40" />
          </div>
          <select value={status} onChange={e=>setStatus(e.target.value)} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-gray-300">
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="producing">制作中</option>
            <option value="done">已完成</option>
            <option value="archived">已归档</option>
          </select>
          <select value={sort} onChange={e=>setSort(e.target.value)} className="bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-gray-300">
            <option value="updated_at">最近更新</option>
            <option value="last_opened_at">最近打开</option>
            <option value="created_at">创建时间</option>
            <option value="name">名称</option>
          </select>
          <button onClick={()=>setShowCreate(true)} className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-semibold flex items-center gap-1"><Plus className="w-3.5 h-3.5"/> 新建空白项目</button>
          <label className="px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-200 flex items-center gap-1 cursor-pointer hover:border-brand">
            <Upload className="w-3.5 h-3.5"/> 导入项目包 <input type="file" accept=".json,.zip" className="hidden" onChange={handleImport} />
          </label>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="py-16 text-center text-gray-500 text-sm">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center text-3xl">📁</div>
            <p className="text-sm text-gray-300 font-semibold">还没有项目</p>
            <p className="text-xs text-gray-500">创建空白项目或导入小说/项目包开始创作，素材将按项目隔离并支持全局共享</p>
            <div className="flex justify-center gap-2 pt-2">
              <button onClick={()=>setShowCreate(true)} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-semibold">新建空白项目</button>
              <label className="px-5 py-2 rounded-xl bg-surface-secondary border border-border text-xs cursor-pointer">导入小说/项目包 <input type="file" accept=".json,.zip" className="hidden" onChange={handleImport} /></label>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map(p=> (
              <div key={p.id} className="group bg-surface border border-border rounded-2xl overflow-hidden hover:border-brand/40 hover:shadow-lg hover:shadow-brand/10 transition-all flex flex-col">
                <div className="h-28 bg-gradient-to-br from-surface-secondary to-surface-tertiary relative flex items-center justify-center">
                  {p.cover_url ? <img src={p.cover_url} alt="" className="w-full h-full object-cover"/> : <span className="text-3xl opacity-60">🎬</span>}
                  <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white border border-white/10">{p.style_preset}</span>
                  <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white border border-white/10">{p.aspect_ratio}</span>
                  <span className="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-brand/20 text-brand-light border border-brand/30">{p.status}</span>
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="text-xs font-semibold text-white truncate">{p.title}</div>
                  <div className="flex items-center gap-2 text-[11px] text-gray-400">
                    <span className="flex items-center gap-1"><Film className="w-3 h-3"/>{p.stats.shots} 镜</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3"/>{p.stats.duration}s</span>
                    <span className="flex items-center gap-1"><Users className="w-3 h-3"/>{p.stats.characters}</span>
                  </div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <button onClick={()=>handleOpen(p.id)} className="flex-1 py-1.5 rounded-lg bg-brand text-white text-xs font-semibold flex items-center justify-center gap-1"><ExternalLink className="w-3 h-3"/> 打开</button>
                    <button onClick={()=>duplicateProject(p.id)} className="p-1.5 rounded-lg bg-surface-secondary border border-border hover:border-brand text-gray-300" title="复制"><Copy className="w-3.5 h-3.5"/></button>
                    <button onClick={async()=>{ if(confirm(`删除项目「${p.title}」？`)) await deleteProject(p.id); }} className="p-1.5 rounded-lg bg-surface-secondary border border-border hover:border-red-500 text-gray-400 hover:text-red-400" title="删除"><Trash2 className="w-3.5 h-3.5"/></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-surface border border-border rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><Sparkles className="w-4 h-4 text-brand"/> 新建空白项目</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400">项目标题</label>
                <input value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder="例如：玄幻第一季 · 第一集" className="w-full mt-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400">画风</label>
                  <select value={newStyle} onChange={e=>setNewStyle(e.target.value)} className="w-full mt-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                    <option value="donghua_xianxia">国漫仙侠</option>
                    <option value="japanese_anime">日式二次元</option>
                    <option value="modern_webtoon">韩漫条漫</option>
                    <option value="cinematic_3d">影视 3D</option>
                    <option value="dark_comic">暗黑漫画</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400">画幅</label>
                  <select value={newRatio} onChange={e=>setNewRatio(e.target.value)} className="w-full mt-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
                    <option value="9:16">9:16 竖屏</option>
                    <option value="16:9">16:9 横屏</option>
                    <option value="1:1">1:1 方形</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={()=>setShowCreate(false)} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-gray-300">取消</button>
              <button onClick={handleCreate} disabled={!newTitle.trim()} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-semibold disabled:opacity-40">创建并打开</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
