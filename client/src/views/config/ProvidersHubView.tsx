import React, { useState } from 'react';
import { Plug, Globe, Video, Mic, Cpu, Search, Trash2, Edit3, Activity, Plus, FileText, Save, X, KeyRound, Settings } from 'lucide-react';
import { apiService } from '../../services/api';

const kindIcon: any = { image: Globe, video: Video, audio: Mic, llm: Cpu };
const kindColor: any = { image: 'text-violet-400', video: 'text-orange-400', audio: 'text-pink-400', llm: 'text-cyan-400' };

export const ProvidersHubView: React.FC<{
  providers: any[];
  onRefresh: ()=>void;
}> = ({ providers, onRefresh }) => {
  const [filter, setFilter] = useState<'all'|'image'|'video'|'audio'|'llm'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [importMode, setImportMode] = useState(false);
  const [importDoc, setImportDoc] = useState('');
  const [importKind, setImportKind] = useState<'image'|'video'|'audio'>('image');
  const [importName, setImportName] = useState('');
  const [importKey, setImportKey] = useState('');

  const filtered = providers.filter(p=>{
    if(filter!=='all' && p.kind!==filter) return false;
    if(q && !(`${p.name||''} ${p.display_name||''} ${p.id}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const customCount = providers.filter(p=>!p.builtin).length;

  const handleDelete = async (id:string)=>{
    if(!confirm(`删除自定义源 ${id}？`)) return;
    try { await apiService.deleteProvider(id); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh')); } catch(e:any){ alert(e.message); }
  };
  const handleTest = async (id:string)=>{
    try { const r=await apiService.testProvider(id); alert(r.ok?`✓ ${id} 连通正常`:`✗ ${r.detail||JSON.stringify(r)}`);} catch(e:any){ alert(e.message); }
  };
  const handleSaveEdit = async ()=>{
    if(!editing) return;
    try {
      const payload:any={...editing};
      delete payload.health;
      ['params_schema','default_params','transport','auth','mapping','health_check'].forEach(k=>{
        if(typeof payload[k]==='string' && payload[k].trim()){
          try{ payload[k]=JSON.parse(payload[k]); } catch { /* keep string for backend error */ }
        }
        if(payload[k]==='') delete payload[k];
      });
      if(typeof payload.models==='string') payload.models = payload.models.split(',').map((s:string)=>s.trim()).filter(Boolean);
      await apiService.updateProvider(editing.id, payload);
      setEditing(null); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ alert(e.message); }
  };
  const handleImport = async ()=>{
    if(!importDoc.trim()){ alert('请粘贴 API 文档/cURL/OpenAPI'); return; }
    try{
      const r=await apiService.importProvider({ kind: importKind, name: importName||undefined, doc_text: importDoc, api_key: importKey||undefined });
      setImportMode(false); setImportDoc(''); setImportName(''); setImportKey('');
      onRefresh(); window.dispatchEvent(new Event('provider-list-refresh'));
      alert(`✓ 已导入 ${r.provider?.id} (${r.mode})`);
    } catch(e:any){ alert(e.message); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><Plug className="w-4 h-4 text-brand"/> 生成源中枢 <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">{customCount} 自定义</span> <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">{providers.length} 总计</span></h2>
          <p className="text-[11px] text-gray-400 mt-1">此处增删改查即全局生效（设置 / 画布 Provider节点 / 分镜 / 导演Agent 同源），按 kind 自动分类。</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={()=> setImportMode(v=>!v)} className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 ${importMode?'bg-brand border-brand text-white':'bg-surface-secondary border-border text-white hover:border-brand'}`}><FileText className="w-3.5 h-3.5"/>{importMode?'关闭导入':'从文档导入'}</button>
          <button onClick={()=> setShowCreate(true)} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5"/> 新建</button>
        </div>
      </div>

      {/* Import panel */}
      {importMode && (
        <div className="p-4 rounded-2xl bg-brand/5 border border-brand/20 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={importKind} onChange={e=> setImportKind(e.target.value as any)} className="bg-surface border border-border rounded-xl px-2 py-1.5 text-xs text-white">
              <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option>
            </select>
            <input value={importName} onChange={e=> setImportName(e.target.value)} placeholder="名称（可选，如 我的FLUX）" className="flex-1 min-w-[160px] bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-white placeholder-gray-500"/>
            <input value={importKey} onChange={e=> setImportKey(e.target.value)} placeholder="API Key（可选）" className="flex-1 min-w-[160px] bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
          </div>
          <textarea value={importDoc} onChange={e=> setImportDoc(e.target.value)} placeholder="粘贴 API 文档 / cURL / OpenAPI JSON… 导演将自动解析 transport/auth/mapping/params_schema" rows={4} className="w-full bg-black/40 border border-border rounded-xl p-3 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"/>
          <div className="flex justify-end gap-2">
            <button onClick={()=> setImportMode(false)} className="px-3 py-1.5 rounded-xl bg-surface border border-border text-xs text-white">取消</button>
            <button onClick={handleImport} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold">让导演解析并创建</button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="flex items-center gap-1 p-1 rounded-full bg-surface-secondary border border-border shrink-0">
          {(['all','image','video','audio','llm'] as const).map(k=>(
            <button key={k} onClick={()=> setFilter(k)} className={`px-3 py-1 rounded-full text-xs font-medium ${filter===k?'bg-brand text-white':'text-gray-400 hover:text-white'}`}>{k==='all'?'全部':k==='image'?'生图':k==='video'?'视频':k==='audio'?'语音':'LLM'}</button>
          ))}
        </div>
        <div className="flex-1 relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2"/>
          <input value={q} onChange={e=> setQ(e.target.value)} placeholder="搜索 名称/ID…" className="w-full bg-surface-secondary border border-border rounded-full pl-9 pr-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
        </div>
        <button onClick={onRefresh} className="px-3 py-2 rounded-full bg-surface-secondary border border-border text-xs text-white hover:border-brand shrink-0">刷新</button>
        <button onClick={()=> window.dispatchEvent(new CustomEvent('open-provider-manager'))} className="hidden lg:block px-3 py-2 rounded-full bg-surface-secondary border border-border text-xs text-white hover:border-brand shrink-0">弹窗管理</button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filtered.map(p=>{
          const Icon = kindIcon[p.kind] || Plug;
          const color = kindColor[p.kind] || 'text-brand';
          return (
            <div key={p.id} className={`p-4 rounded-2xl border flex flex-col gap-2.5 ${p.builtin?'bg-surface-secondary/40 border-border':'bg-surface border-brand/20 shadow-sm'}`}>
              <div className="flex items-center justify-between min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center border bg-black/20 ${p.builtin?'border-border':'border-brand/20'}`}><Icon className={`w-4 h-4 ${color}`}/></div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white truncate">{p.display_name || p.name || p.id}</div>
                    <div className="text-[10px] font-mono text-gray-500 truncate">{p.id} · {p.kind} {p.provider_type?`·${p.provider_type}`:''}</div>
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${p.builtin?'bg-surface border-border text-gray-400':'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>
              </div>
              {p.description && <div className="text-[11px] text-gray-400 line-clamp-2">{p.description}</div>}
              <div className="text-[10px] font-mono text-gray-500 truncate" title={p.transport?.url}>URL: {p.transport?.url || '—'}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                <span>模型</span><span className="px-1.5 py-0.5 rounded bg-black/30 text-gray-300 truncate max-w-[140px]">{p.default_model || p.models?.[0] || '—'}</span>
                <span className="ml-auto flex items-center gap-1.5"><span className="px-1.5 py-0.5 rounded bg-black/30">{p.params_schema ? Object.keys(p.params_schema.properties||{}).length+' 参数' : '无参'}</span>{p.health?.ok!==undefined && <span className={`w-2 h-2 rounded-full ${p.health.ok?'bg-emerald-500':'bg-amber-500'}`}/>}</span>
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <button onClick={()=> handleTest(p.id)} className="flex-1 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white hover:border-brand flex items-center justify-center gap-1"><Activity className="w-3 h-3"/> 测试</button>
                <button onClick={()=> setEditing(p)} className="flex-1 py-1.5 rounded-xl bg-brand/10 border border-brand/20 text-brand-light text-xs flex items-center justify-center gap-1"><Edit3 className="w-3 h-3"/> {p.builtin?'查看':'编辑'}</button>
                {!p.builtin && <button onClick={()=> handleDelete(p.id)} className="px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-1"><Trash2 className="w-3 h-3"/> 删除</button>}
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length===0 && <div className="text-center py-10 text-sm text-gray-500">暂无匹配的生成源</div>}

      {/* Edit drawer */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden">
            <div className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
              <span className="text-sm font-bold text-white flex items-center gap-2"><Settings className="w-4 h-4"/>{editing.builtin?'查看':'编辑'} {editing.id}</span>
              <button onClick={()=> setEditing(null)} className="p-1 rounded hover:bg-surface-tertiary"><X className="w-4 h-4 text-gray-400"/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs custom-scrollbar">
              {[
                {k:'name', label:'名称', type:'text'},
                {k:'kind', label:'类型 kind (image|video|audio|llm)', type:'select', opts:['image','video','audio','llm']},
                {k:'description', label:'描述', type:'textarea'},
                {k:'transport', label:'transport JSON', type:'json'},
                {k:'auth', label:'auth JSON', type:'json'},
                {k:'mapping', label:'mapping JSON', type:'json'},
                {k:'health_check', label:'health_check JSON', type:'json'},
                {k:'models', label:'models (逗号分隔)', type:'text'},
                {k:'default_model', label:'default_model', type:'text'},
                {k:'params_schema', label:'params_schema JSON', type:'json'},
                {k:'default_params', label:'default_params JSON', type:'json'},
              ].map(f=>{
                const val = editing[f.k];
                const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : (val ?? '');
                return (
                  <div key={f.k} className="space-y-1">
                    <span className="text-[11px] font-semibold text-gray-300">{f.label} <span className="text-[10px] text-gray-500">{f.k}</span></span>
                    {f.type==='textarea' ? (
                      <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={2} className="w-full bg-black/40 border border-border rounded-xl p-2 font-mono text-xs text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                    ) : f.type==='json' ? (
                      <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={4} className="w-full bg-black/40 border border-border rounded-xl p-2 font-mono text-[11px] text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                    ) : f.type==='select' ? (
                      <select value={val||''} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white" disabled={editing.builtin}>
                        {f.opts?.map((o:string)=> <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input value={f.k==='models' && Array.isArray(val) ? val.join(',') : display} onChange={e=>{
                        if(f.k==='models') setEditing({...editing, [f.k]: e.target.value.split(',').map((s:string)=>s.trim()).filter(Boolean)});
                        else setEditing({...editing, [f.k]: e.target.value});
                      }} className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand" disabled={editing.builtin && f.k!=='default_model'}/>
                    )}
                  </div>
                );
              })}
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200">内置源只读；自定义源可改 JSON 后保存。Key 请用“API Key”单独设置（见下方快捷区）。</div>
              {!editing.builtin && (
                <div className="p-3 rounded-xl bg-surface-secondary border border-border space-y-2">
                  <span className="text-[11px] font-semibold text-white flex items-center gap-1"><KeyRound className="w-3 h-3"/> API Key 快捷设置</span>
                  <SetKeyInline providerId={editing.id} />
                </div>
              )}
            </div>
            <div className="p-3 border-t border-border flex justify-end gap-2 shrink-0">
              <button onClick={()=> setEditing(null)} className="px-4 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              {!editing.builtin && <button onClick={handleSaveEdit} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Save className="w-3.5 h-3.5"/> 保存</button>}
            </div>
          </div>
        </div>
      )}

      {/* Create */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <CreateForm onClose={()=> setShowCreate(false)} onCreated={()=> { setShowCreate(false); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh')); }} />
        </div>
      )}
    </div>
  );
};

const SetKeyInline: React.FC<{providerId:string}> = ({ providerId })=>{
  const [k, setK] = useState('');
  const save = async ()=>{
    if(!k.trim()){ alert('请输入 Key'); return; }
    try{ await apiService.setProviderApiKey(providerId, k.trim()); alert('✓ 已保存'); setK(''); } catch(e:any){ alert(e.message); }
  };
  return (
    <div className="flex gap-1.5">
      <input value={k} onChange={e=> setK(e.target.value)} placeholder="输入新 API Key" className="flex-1 bg-black/40 border border-border rounded-xl px-3 py-1.5 text-xs font-mono text-white placeholder-gray-500"/>
      <button onClick={save} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold">保存Key</button>
    </div>
  );
};

const CreateForm: React.FC<{onClose:()=>void, onCreated:()=>void}> = ({ onClose, onCreated })=>{
  const [form, setForm] = useState<any>({ name:'', kind:'image', description:'', transport: { method:'POST', url:'', headers:{'Content-Type':'application/json'}, timeout:60 }, auth:{type:'bearer'}, models:[], default_model:'', params_schema:'', default_params:'' });
  const [apiKey, setApiKey] = useState('');
  const handleSubmit = async ()=>{
    try{
      const payload:any={...form};
      if(typeof payload.models==='string') payload.models = payload.models.split(',').map((s:string)=>s.trim()).filter(Boolean);
      ['transport','auth','params_schema','default_params'].forEach(k=>{
        if(typeof payload[k]==='string' && payload[k].trim()){ try{ payload[k]=JSON.parse(payload[k]); } catch{} }
        if(payload[k]==='') delete payload[k];
      });
      if(apiKey) payload.api_key = apiKey;
      await apiService.createProvider(payload);
      onCreated();
    }catch(e:any){ alert(e.message); }
  };
  return (
    <div className="w-full max-w-xl bg-surface rounded-2xl border border-border p-4 space-y-3 max-h-[85vh] overflow-y-auto">
      <div className="flex items-center justify-between"><span className="text-sm font-bold text-white">新建自定义源</span><button onClick={onClose}><X className="w-4 h-4 text-gray-400"/></button></div>
      <input value={form.name} onChange={e=> setForm({...form, name:e.target.value})} placeholder="名称，如 我的FLUX" className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500"/>
      <select value={form.kind} onChange={e=> setForm({...form, kind:e.target.value as any})} className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
        <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option><option value="llm">LLM</option>
      </select>
      <textarea value={form.description} onChange={e=> setForm({...form, description:e.target.value})} placeholder="描述" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500"/>
      <textarea value={typeof form.transport==='string'?form.transport:JSON.stringify(form.transport, null, 2)} onChange={e=> setForm({...form, transport:e.target.value})} rows={4} placeholder='transport JSON' className="w-full bg-black/40 border border-border rounded-xl p-2 font-mono text-[11px] text-white"/>
      <textarea value={typeof form.auth==='string'?form.auth:JSON.stringify(form.auth, null, 2)} onChange={e=> setForm({...form, auth:e.target.value})} rows={2} placeholder='auth JSON，如 {"type":"bearer"}' className="w-full bg-black/40 border border-border rounded-xl p-2 font-mono text-[11px] text-white"/>
      <input value={Array.isArray(form.models)?form.models.join(','):form.models} onChange={e=> setForm({...form, models:e.target.value})} placeholder="models 逗号分隔，可空" className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500"/>
      <input value={form.default_model} onChange={e=> setForm({...form, default_model:e.target.value})} placeholder="default_model，可空" className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500"/>
      <input value={apiKey} onChange={e=> setApiKey(e.target.value)} placeholder="API Key（可选）" className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white font-mono placeholder-gray-500"/>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
        <button onClick={handleSubmit} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold">创建</button>
      </div>
    </div>
  );
};
