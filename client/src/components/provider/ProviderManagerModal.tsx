import React, { useEffect, useState } from 'react';
import { X, Plus, Plug, Globe, Video, Mic, Cpu, Trash2, Edit3, Activity, Save, Upload, FileText, Link2, TestTube } from 'lucide-react';
import { apiService } from '../../services/api';

interface Props { isOpen: boolean; onClose: ()=>void; }

const kindIcon: any = { image: Globe, video: Video, audio: Mic, llm: Cpu };
const kindColor: any = { image: 'text-violet-400', video: 'text-orange-400', audio: 'text-pink-400', llm: 'text-cyan-400' };

export const ProviderManagerModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [providers, setProviders] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all'|'image'|'video'|'audio'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [importMode, setImportMode] = useState(false);
  const [importDoc, setImportDoc] = useState('');
  const [importKind, setImportKind] = useState<'image'|'video'|'audio'>('image');
  const [importName, setImportName] = useState('');
  const [importKey, setImportKey] = useState('');

  const fetchAll = async ()=>{
    try {
      const res = await apiService.listProviders({ include_builtin: true });
      setProviders(res.providers || []);
    } catch {}
  };
  useEffect(()=> { if (isOpen) fetchAll(); }, [isOpen]);
  useEffect(()=>{
    const h = ()=> fetchAll();
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);

  const filtered = providers.filter(p=>{
    if (filter!=='all' && p.kind!==filter) return false;
    if (q && !(`${p.name||''} ${p.display_name||''} ${p.id}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const customCount = providers.filter(p=> !p.builtin).length;

  const handleDelete = async (id:string)=>{
    if (!confirm(`删除自定义源 ${id}？`)) return;
    try {
      await apiService.deleteProvider(id);
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ alert(e.message); }
  };
  const handleTest = async (id:string)=>{
    try {
      const res = await apiService.testProvider(id);
      alert(res.ok ? `✓ ${id} 连通正常` : `✗ ${id} 检测未通过: ${res.detail || JSON.stringify(res)}`);
      await fetchAll();
    } catch(e:any){ alert(e.message); }
  };
  const handleSaveEdit = async ()=>{
    if (!editing) return;
    try {
      const payload: any = { ...editing };
      // 清理只读字段
      delete payload.health;
      // 处理 JSON 字符串字段
      if (typeof payload.params_schema === 'string') {
        try { payload.params_schema = JSON.parse(payload.params_schema); } catch { alert('params_schema JSON 格式错误'); return; }
      }
      if (typeof payload.default_params === 'string') {
        try { payload.default_params = JSON.parse(payload.default_params); } catch { alert('default_params JSON 格式错误'); return; }
      }
      if (typeof payload.transport === 'string') {
        try { payload.transport = JSON.parse(payload.transport); } catch {}
      }
      await apiService.updateProvider(editing.id, payload);
      setEditing(null);
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ alert(e.message); }
  };
  const handleCreate = async (form: any)=>{
    try {
      const res = await apiService.createProvider(form);
      setShowCreate(false);
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
      alert(`✓ 已创建 ${res.provider?.id}`);
    } catch(e:any){ alert(e.message); }
  };
  const handleImport = async ()=>{
    if (!importDoc.trim()) { alert('请粘贴 API 文档/cURL/OpenAPI'); return; }
    try {
      const res = await apiService.importProvider({ kind: importKind, name: importName || undefined, doc_text: importDoc, api_key: importKey || undefined });
      setImportMode(false);
      setImportDoc(''); setImportName(''); setImportKey('');
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
      alert(`✓ 已导入 ${res.provider?.id} (${res.mode})`);
    } catch(e:any){ alert(e.message); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-6xl h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-brand/20 border border-brand/30 text-brand"><Plug className="w-5 h-5" /></div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">自定义生成源管理 <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">{customCount} 自定义</span> <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface border border-border text-gray-400">{providers.length} 总计</span></h2>
              <p className="text-[11px] text-gray-400">增删改查 · 与设置/画布/分镜全域同源 · 导演通过 kind 自动分类</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={()=> setImportMode(!importMode)} className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 ${importMode?'bg-brand border-brand text-white':'bg-surface-secondary border-border text-white hover:border-brand'}`}><FileText className="w-3.5 h-3.5"/> {importMode?'关闭导入':'从文档导入'}</button>
            <button onClick={()=> setShowCreate(true)} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5"/> 新建</button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary"><X className="w-5 h-5"/></button>
          </div>
        </div>

        {/* Import Panel */}
        {importMode && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-brand/5 border border-brand/20 space-y-3">
            <div className="flex items-center gap-2">
              <select value={importKind} onChange={e=> setImportKind(e.target.value as any)} className="bg-surface border border-border rounded-lg px-2 py-1.5 text-xs text-white">
                <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option>
              </select>
              <input value={importName} onChange={e=> setImportName(e.target.value)} placeholder="名称（可选，如 我的FLUX）" className="flex-1 bg-surface border border-border rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500"/>
              <input value={importKey} onChange={e=> setImportKey(e.target.value)} placeholder="API Key（可选）" className="flex-1 bg-surface border border-border rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
            </div>
            <textarea value={importDoc} onChange={e=> setImportDoc(e.target.value)} placeholder="粘贴 API 文档 / cURL / OpenAPI JSON… 导演将自动解析 transport/auth/input_schema/output_schema" rows={4} className="w-full bg-black/40 border border-border rounded-xl p-3 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"/>
            <div className="flex justify-end gap-2">
              <button onClick={()=> setImportMode(false)} className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-white">取消</button>
              <button onClick={handleImport} className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-bold">让导演解析并创建</button>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="px-6 py-3 border-b border-border flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 p-1 rounded-full bg-surface-secondary border border-border">
            {(['all','image','video','audio'] as const).map(k=> (
              <button key={k} onClick={()=> setFilter(k)} className={`px-3 py-1 rounded-full text-xs font-medium ${filter===k?'bg-white dark:bg-brand text-surface dark:text-white shadow-sm':'text-gray-400 hover:text-white'}`}>{k==='all'?'全部':k==='image'?'生图':k==='video'?'视频':'语音'}</button>
            ))}
          </div>
          <input value={q} onChange={e=> setQ(e.target.value)} placeholder="搜索 名称/ID…" className="flex-1 max-w-xs bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
          <span className="ml-auto text-[11px] text-gray-500">内置不可删改 · 自定义可增删改查</span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {filtered.map(p=>{
              const Icon = kindIcon[p.kind] || Plug;
              const color = kindColor[p.kind] || 'text-brand';
              return (
                <div key={p.id} className={`p-4 rounded-xl border flex flex-col gap-2 ${p.builtin?'bg-surface-secondary/40 border-border':'bg-surface border-brand/20 shadow-sm'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center border bg-black/20 ${p.builtin?'border-border':'border-brand/20'}`}><Icon className={`w-4 h-4 ${color}`} /></div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{p.display_name || p.name || p.id}</div>
                        <div className="text-[10px] font-mono text-gray-500 truncate">{p.id} · {p.kind} {p.provider_type?`·${p.provider_type}`:''}</div>
                      </div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${p.builtin?'bg-surface border-border text-gray-400':'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>
                  </div>
                  {p.description && <div className="text-[11px] text-gray-400 line-clamp-2">{p.description}</div>}
                  <div className="text-[10px] font-mono text-gray-500 truncate" title={p.transport?.url}>URL: {p.transport?.url || '—'}</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    <span>模型:</span><span className="px-1.5 py-0.5 rounded bg-black/30 text-gray-300 truncate max-w-[140px]">{p.default_model || p.models?.[0] || '—'}</span>
                    <span className="ml-auto flex items-center gap-1">{p.health?.ok ? <span className="w-2 h-2 rounded-full bg-emerald-500"/> : p.health?.ok===false ? <span className="w-2 h-2 rounded-full bg-amber-500"/> : null}{p.builtin?'':<span className="px-1 py-0.5 rounded bg-black/30">{p.params_schema ? Object.keys(p.params_schema.properties||{}).length+' 参数' : '无参'}</span>}</span>
                  </div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <button onClick={()=> handleTest(p.id)} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white hover:border-brand flex items-center justify-center gap-1"><Activity className="w-3 h-3"/> 测试</button>
                    <button onClick={()=> setEditing(p)} className="flex-1 py-1.5 rounded-lg bg-brand/10 border border-brand/20 text-brand-light text-xs flex items-center justify-center gap-1"><Edit3 className="w-3 h-3"/> {p.builtin?'查看':'编辑'}</button>
                    {!p.builtin && <button onClick={()=> handleDelete(p.id)} className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-1"><Trash2 className="w-3 h-3"/> 删除</button>}
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length===0 && <div className="text-center py-12 text-sm text-gray-500">暂无匹配的生成源</div>}
        </div>

        {/* Edit Drawer */}
        {editing && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-2xl max-h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden">
              <div className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-sm font-bold text-white">{editing.builtin?'查看':'编辑'} {editing.id}</span>
                <button onClick={()=> setEditing(null)} className="p-1 rounded hover:bg-surface-tertiary"><X className="w-4 h-4 text-gray-400"/></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar text-xs">
                {[
                  {k:'name', label:'名称', type:'text'},
                  {k:'kind', label:'类型 kind (image|video|audio)', type:'select', opts:['image','video','audio','llm']},
                  {k:'description', label:'描述', type:'textarea'},
                  {k:'transport', label:'transport JSON', type:'json'},
                  {k:'auth', label:'auth JSON', type:'json'},
                  {k:'mapping', label:'mapping JSON', type:'json'},
                  {k:'models', label:'models (逗号分隔)', type:'text'},
                  {k:'default_model', label:'default_model', type:'text'},
                  {k:'params_schema', label:'params_schema JSON (不固定参数)', type:'json'},
                  {k:'default_params', label:'default_params JSON', type:'json'},
                ].map(f=>{
                  const val = editing[f.k];
                  const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : (val ?? '');
                  return (
                    <div key={f.k} className="space-y-1">
                      <span className="text-[11px] font-semibold text-gray-300">{f.label} <span className="text-[10px] text-gray-500">{f.k}</span></span>
                      {f.type==='textarea' ? (
                        <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={2} className="w-full bg-black/40 border border-border rounded-lg p-2 font-mono text-xs text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                      ) : f.type==='json' ? (
                        <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={4} className="w-full bg-black/40 border border-border rounded-lg p-2 font-mono text-[11px] text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                      ) : f.type==='select' ? (
                        <select value={val||''} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} className="w-full bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white" disabled={editing.builtin}>
                          {f.opts?.map((o:string)=> <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input value={f.k==='models' && Array.isArray(val) ? val.join(',') : display} onChange={e=> {
                          if (f.k==='models') setEditing({...editing, [f.k]: e.target.value.split(',').map((s:string)=>s.trim()).filter(Boolean)});
                          else setEditing({...editing, [f.k]: e.target.value});
                        }} className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                      )}
                    </div>
                  );
                })}
                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200">内置源只读；自定义源可直接改 JSON 后保存。kind 决定全局分类（设置/画布/分镜），由导演通过 MCP kind 参数自动填。</div>
              </div>
              <div className="p-3 border-t border-border flex justify-end gap-2 shrink-0">
                <button onClick={()=> setEditing(null)} className="px-4 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white">取消</button>
                {!editing.builtin && <button onClick={handleSaveEdit} className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1"><Save className="w-3.5 h-3.5"/> 保存</button>}
              </div>
            </div>
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <CreateForm onClose={()=> setShowCreate(false)} onCreated={()=> { setShowCreate(false); fetchAll(); window.dispatchEvent(new Event('provider-list-refresh')); }} />
          </div>
        )}
      </div>
    </div>
  );
};

const CreateForm: React.FC<{onClose:()=>void, onCreated:()=>void}> = ({ onClose, onCreated })=>{
  const [form, setForm] = useState<any>({ name:'', kind:'image', description:'', transport: { method:'POST', url:'', headers:{'Content-Type':'application/json'}, timeout:60 }, auth:{type:'bearer'}, models:[], default_model:'', params_schema:'', default_params:'' });
  const [apiKey, setApiKey] = useState('');
  const handleSubmit = async ()=>{
    try {
      const payload: any = { ...form };
      if (typeof payload.models === 'string') payload.models = payload.models.split(',').map((s:string)=>s.trim()).filter(Boolean);
      ['transport','auth','params_schema','default_params'].forEach(k=>{
        if (typeof payload[k]==='string' && payload[k].trim()) {
          try { payload[k]=JSON.parse(payload[k]); } catch { /* keep string for backend validation */ }
        }
        if (payload[k]==='') delete payload[k];
      });
      if (apiKey) payload.api_key = apiKey;
      await apiService.createProvider(payload);
      onCreated();
    } catch(e:any){ alert(e.message); }
  };
  return (
    <div className="w-full max-w-xl bg-surface rounded-2xl border border-border p-4 space-y-3 max-h-[85vh] overflow-y-auto">
      <div className="flex items-center justify-between"><span className="text-sm font-bold text-white">新建自定义源</span><button onClick={onClose}><X className="w-4 h-4 text-gray-400"/></button></div>
      <input value={form.name} onChange={e=> setForm({...form, name:e.target.value})} placeholder="名称，如 我的FLUX" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500"/>
      <select value={form.kind} onChange={e=> setForm({...form, kind:e.target.value})} className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white">
        <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option>
      </select>
      <textarea value={form.description} onChange={e=> setForm({...form, description:e.target.value})} placeholder="描述" rows={2} className="w-full bg-surface-secondary border border-border rounded-lg p-2 text-xs text-white"/>
      <textarea value={typeof form.transport==='string'?form.transport:JSON.stringify(form.transport, null, 2)} onChange={e=> setForm({...form, transport:e.target.value})} rows={4} placeholder='transport JSON，如 {"method":"POST","url":"https://...","headers":{"Content-Type":"application/json"}}' className="w-full bg-black/40 border border-border rounded-lg p-2 font-mono text-[11px] text-white"/>
      <textarea value={typeof form.auth==='string'?form.auth:JSON.stringify(form.auth, null, 2)} onChange={e=> setForm({...form, auth:e.target.value})} rows={2} placeholder='auth JSON，如 {"type":"bearer"}' className="w-full bg-black/40 border border-border rounded-lg p-2 font-mono text-[11px] text-white"/>
      <input value={Array.isArray(form.models)?form.models.join(','):form.models} onChange={e=> setForm({...form, models:e.target.value})} placeholder="models 逗号分隔，可空" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white"/>
      <input value={form.default_model} onChange={e=> setForm({...form, default_model:e.target.value})} placeholder="default_model，可空" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white"/>
      <input value={apiKey} onChange={e=> setApiKey(e.target.value)} placeholder="API Key（可选）" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white font-mono"/>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white">取消</button>
        <button onClick={handleSubmit} className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-bold">创建</button>
      </div>
    </div>
  );
};
