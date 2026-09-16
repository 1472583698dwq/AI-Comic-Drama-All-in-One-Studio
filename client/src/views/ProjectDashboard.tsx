import React, { useEffect, useState } from 'react';
import { FolderKanban, Plus, Upload, Search, Trash2, Copy, Archive, ExternalLink, Sparkles, Clock, Film, Users, Filter, Zap } from 'lucide-react';
import { useProjectListStore } from '../stores/useProjectListStore';
import { useProjectStore } from '../stores/useProjectStore';
import { apiService } from '../services/api';
import { OneKeyRunModal } from '../components/workflow/OneKeyRunModal';
import { confirmAsync, toast } from '../stores/useDialogStore';
import { useEscapeClose } from '../hooks/useEscapeClose';

export const ProjectDashboard: React.FC = () => {
  const { projects, fetchProjects, createBlank, importProjectFile, openProject, deleteProject, duplicateProject, isLoading } = useProjectListStore();
  const { setProject } = useProjectStore();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('updated_at');
  const [showCreate, setShowCreate] = useState(false);
  useEscapeClose(showCreate, () => setShowCreate(false));
  const [showOneKey, setShowOneKey] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStyle, setNewStyle] = useState('donghua_xianxia');
  const [newRatio, setNewRatio] = useState('9:16');

  useEffect(() => { fetchProjects({ q: q || undefined, status, sort }); }, [status, sort]);
  const handleSearch = () => fetchProjects({ q: q || undefined, status, sort });

  const buildBlankProject = (id: string, meta?: any): any => ({
    id,
    title: meta?.title || newTitle.trim() || '未命名项目',
    original_novel: '',
    style_preset: meta?.style_preset || newStyle || 'donghua_xianxia',
    aspect_ratio: meta?.aspect_ratio || newRatio || '9:16',
    characters: [],
    scenes: [{ id: 'scene-1', scene_index: 1, title: '场景 1', location: '', time_of_day: 'day', atmosphere: 'epic', shots: [] }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const meta = await createBlank({ title: newTitle.trim(), style_preset: newStyle, aspect_ratio: newRatio });
      setShowCreate(false); setNewTitle('');
      // 空白新建后端不落 content.json（content 为 null 是正常态）：必须兜底空工程，否则工作台无项目直接黑屏
      try {
        const data = await apiService.getProject(meta.id);
        if (data?.content?.scenes) setProject(data.content);
        else setProject(buildBlankProject(meta.id, meta));
      } catch {
        setProject(buildBlankProject(meta.id, undefined));
      }
      // 双 store 的 activeProjectId 保持一致（画布/素材按它隔离）
      try { useProjectListStore.getState().setActiveProjectId(meta.id); } catch {}
      try { localStorage.setItem('activeProjectId', meta.id); } catch {}
      useProjectStore.getState().setActiveTab('studio');
    } catch (e: any) {
      toast.error(e?.message || '创建项目失败');
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const res = await importProjectFile(f);
      // 若返回内容则直接加载
      try {
        const data = await apiService.getProject(res.id);
        if (data?.content?.scenes) setProject(data.content);
        useProjectStore.getState().setActiveTab('studio');
      } catch {}
    } catch (err: any) { toast.error(err.message || '导入项目失败'); }
    e.target.value = '';
  };

  const handleOpen = async (id: string) => {
    await openProject(id);
    try {
      const data = await apiService.getProject(id);
      if (data?.content?.scenes) {
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
    } catch (e:any) { toast.error(e.message || '打开项目失败'); }
  };

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden">
      {/* Toolbar — 单行、分组、呼吸感 */}
      <div className="h-[56px] px-5 border-b border-border flex items-center gap-4 shrink-0 bg-surface/50">
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center"><FolderKanban className="w-4 h-4 text-brand" /></div>
          <div>
            <h2 className="text-[13px] font-bold tracking-tight text-white leading-none">项目看板</h2>
            <p className="text-[11px] text-gray-500 leading-none mt-1">{projects.length} 个项目 · 按更新排序</p>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center max-w-[640px] mx-auto gap-2">
          <div className="flex-1 flex items-center gap-2 rounded-full bg-surface-secondary border border-border px-3 py-1.5 focus-within:border-brand/40 focus-within:bg-surface transition-all">
            <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleSearch()} placeholder="搜索项目标题…" className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none min-w-0" />
            {q && <button onClick={()=>{setQ(''); fetchProjects({q:'', status, sort});}} className="text-[11px] text-gray-500 hover:text-white">清空</button>}
          </div>
          <select value={status} onChange={e=>setStatus(e.target.value)} className="hidden sm:block bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-gray-300 focus:outline-none">
            <option value="all">全部</option><option value="draft">草稿</option><option value="producing">制作中</option><option value="done">已完成</option><option value="archived">已归档</option>
          </select>
          <select value={sort} onChange={e=>setSort(e.target.value)} className="hidden lg:block bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-gray-300 focus:outline-none">
            <option value="updated_at">最近更新</option><option value="last_opened_at">最近打开</option><option value="created_at">创建时间</option><option value="name">名称</option>
          </select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-border text-xs font-medium text-[color:var(--color-text-main)] hover:border-border-active cursor-pointer">
            <Upload className="w-3.5 h-3.5"/> 导入 <input type="file" accept=".json,.zip" className="hidden" onChange={handleImport} />
          </label>
          <button onClick={()=>setShowOneKey(true)} className="px-4 py-1.5 rounded-full bg-gradient-to-r from-amber-500 to-brand text-white text-xs font-bold shadow-md flex items-center gap-1.5"><Zap className="w-3.5 h-3.5"/> 一键成片</button>
          <button onClick={()=>setShowCreate(true)} className="px-4 py-1.5 rounded-full bg-brand text-white text-xs font-bold shadow-md shadow-brand/20 hover:bg-brand-light flex items-center gap-1.5"><Plus className="w-3.5 h-3.5"/> 新建项目</button>
        </div>
      </div>

      {/* Grid — 留白与卡片节奏 */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1280px] mx-auto w-full p-5 lg:p-6">
        {isLoading ? (
          <div className="py-20 text-center text-gray-500 text-sm">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-20 h-20 mx-auto rounded-[20px] bg-surface border border-border flex items-center justify-center mb-4"><FolderKanban className="w-8 h-8 text-gray-500" /></div>
            <p className="text-sm font-bold text-white">还没有项目</p>
            <p className="text-xs text-gray-500 mt-1 max-w-[420px] mx-auto leading-relaxed">创建空白项目或导入小说/项目包开始创作，素材将按项目隔离并支持全局共享</p>
            <div className="flex justify-center gap-2 pt-4">
              <button onClick={()=>setShowCreate(true)} className="px-5 py-2 rounded-full bg-brand text-white text-xs font-bold shadow-md">新建空白项目</button>
              <label className="px-5 py-2 rounded-full bg-surface border border-border text-xs font-medium cursor-pointer hover:border-border-active">导入项目包 <input type="file" accept=".json,.zip" className="hidden" onChange={handleImport} /></label>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {projects.map(p=> (
              <div key={p.id} className="group bg-surface border border-border rounded-[16px] overflow-hidden hover:border-brand/30 hover:shadow-xl hover:shadow-brand/5 hover:-translate-y-0.5 transition-all flex flex-col">
                <div className="h-[118px] bg-surface-secondary relative flex items-center justify-center overflow-hidden">
                  {p.cover_url ? <img src={p.cover_url} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"/> : <span className="text-2xl opacity-40">🎬</span>}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
                  <span className="absolute top-2.5 left-2.5 text-[10px] px-2 py-1 rounded-full bg-surface/85 text-white backdrop-blur border border-white/10">{p.style_preset}</span>
                  <span className="absolute top-2.5 right-2.5 text-[10px] px-2 py-1 rounded-full bg-surface/90 text-[color:var(--color-text-main)] text-[10px] font-bold">{p.aspect_ratio}</span>
                  <span className={`absolute bottom-2.5 left-2.5 text-[10px] px-2 py-1 rounded-full border font-medium ${p.status==='done' ? 'bg-accent-green text-white border-accent-green' : p.status==='producing' ? 'bg-accent-orange text-white border-accent-orange' : 'bg-surface text-gray-300 border-border'}`}>{p.status==='draft'?'草稿':p.status==='producing'?'制作中':p.status==='done'?'已完成':'已归档'}</span>
                </div>
                <div className="p-3.5 flex-1 flex flex-col gap-2.5">
                  <div className="text-[13px] font-bold tracking-tight text-white truncate leading-none">{p.title}</div>
                  <div className="flex items-center gap-3 text-[11px] text-gray-500">
                    <span className="flex items-center gap-1"><Film className="w-3 h-3"/>{p.stats.shots}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3"/>{p.stats.duration}s</span>
                    <span className="flex items-center gap-1"><Users className="w-3 h-3"/>{p.stats.characters}</span>
                  </div>
                  <div className="flex items-center gap-1.5 pt-1 mt-auto">
                    <button onClick={()=>handleOpen(p.id)} className="flex-1 py-2 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-brand-light">打开 <ExternalLink className="w-3 h-3"/></button>
                    <button onClick={()=>duplicateProject(p.id)} className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-border-active text-gray-400 hover:text-white flex items-center justify-center" title="复制"><Copy className="w-3.5 h-3.5"/></button>
                    <button 
                      onClick={async () => { 
                        if (await confirmAsync({
                          title: '删除项目',
                          message: `确定要删除项目「${p.title}」吗？\n相关场景与分镜素材将被同步清理且无法撤销。`,
                          isDanger: true,
                          confirmText: '确认删除',
                          cancelText: '保留项目'
                        })) {
                          await deleteProject(p.id);
                          toast.success(`项目「${p.title}」已删除`);
                        }
                      }} 
                      className="w-8 h-8 rounded-full bg-surface-secondary border border-border hover:border-red-500/40 text-gray-400 hover:text-red-400 flex items-center justify-center transition-colors" 
                      title="删除项目"
                    >
                      <Trash2 className="w-3.5 h-3.5"/>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
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

      {/* 一键成片 Agent */}
      <OneKeyRunModal isOpen={showOneKey} onClose={()=>setShowOneKey(false)} />
    </div>
  );
};
