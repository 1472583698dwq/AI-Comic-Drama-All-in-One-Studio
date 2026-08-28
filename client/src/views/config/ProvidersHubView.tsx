import React, { useState, useEffect } from 'react';
import { Plug, Globe, Video, Mic, Cpu, Search, Trash2, Edit3, Activity, Plus, FileText, Save, X, KeyRound, Settings, Code2, Languages, FileCode, ArrowUpCircle, Copy } from 'lucide-react';
import { apiService } from '../../services/api';
import { DynamicControl } from '../../components/canvas/controls/DynamicControl';

const kindIcon: any = { image: Globe, video: Video, audio: Mic, llm: Cpu };
const kindColor: any = { image: 'text-violet-400', video: 'text-orange-400', audio: 'text-pink-400', llm: 'text-cyan-400' };

const CODE_TEMPLATES_FALLBACK: Record<string, string> = {
  "python:image": `import httpx\nasync def generate(ctx, api):\n    headers={"Authorization": f"Bearer {ctx['api_key']}", "Content-Type":"application/json"}\n    payload={"prompt": ctx["prompt"], "size": ctx.get("size","1024x1024")}\n    url="https://api.example.com/v1/images/generations"\n    async with httpx.AsyncClient(timeout=60) as client:\n        r=await client.post(url, headers=headers, json=payload)\n        r.raise_for_status()\n        d=r.json()\n        return {"image_url": d.get("data",[{}])[0].get("url") or d.get("url")}\n`,
  "python:video": `import httpx, asyncio\nasync def generate(ctx, api):\n    headers={"Authorization": f"Bearer {ctx['api_key']}"}\n    payload={"prompt": ctx["prompt"], "duration": ctx.get("duration",5)}\n    url="https://api.example.com/v1/videos/generations"\n    async with httpx.AsyncClient(timeout=60) as client:\n        r=await client.post(url, headers=headers, json=payload)\n        r.raise_for_status()\n        d=r.json()\n        v=d.get("video_url") or d.get("url")\n        if v: return {"video_url": v}\n        task_id=d.get("task_id") or d.get("id")\n        poll=f"https://api.example.com/v1/videos/status/{task_id}"\n        for _ in range(30):\n            await asyncio.sleep(3)\n            pr=await client.get(poll, headers=headers)\n            pj=pr.json()\n            s=str(pj.get("status") or pj.get("data",{}).get("status","")).upper()\n            if s in ("SUCCESS","COMPLETED"):\n                return {"video_url": pj.get("video_url") or pj.get("data",{}).get("video_url")}\n            if s=="FAILED": raise RuntimeError(str(pj))\n        raise TimeoutError(task_id)\n`,
}

export const ProvidersHubView: React.FC<{
  providers: any[];
  onRefresh: ()=>void;
}> = ({ providers, onRefresh }) => {
  const [filter, setFilter] = useState<'all'|'image'|'video'|'audio'|'llm'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [editCode, setEditCode] = useState('');
  const [editLang, setEditLang] = useState<'python'|'javascript'>('python');
  const [showCreate, setShowCreate] = useState(false);
  const [importMode, setImportMode] = useState(false);
  const [importDoc, setImportDoc] = useState('');
  const [importKind, setImportKind] = useState<'image'|'video'|'audio'>('image');
  const [importLang, setImportLang] = useState<'python'|'javascript'>('python');
  const [importName, setImportName] = useState('');
  const [importKey, setImportKey] = useState('');

  const filtered = providers.filter(p=>{
    if(filter!=='all' && p.kind!==filter) return false;
    if(q && !(`${p.name||''} ${p.display_name||''} ${p.id} ${p.language||''}`.toLowerCase().includes(q.toLowerCase()))) return false;
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
  const handleUpgrade = async (id:string)=>{
    if(!confirm(`将 ${id} 的 JSON 模板升级为代码模式？`)) return;
    try { const r=await apiService.upgradeProviderToCode(id, 'python'); alert(`✓ 已升级为代码模式`); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh')); } catch(e:any){ alert(e.message); }
  };
  const openEdit = async (p:any)=>{
    // 若列表未返回完整 code/params_schema，则单独拉取
    try{
      const r=await apiService.getProvider(p.id);
      const full = r.provider || p;
      setEditing({...full, _raw: r.raw});
      setEditLang(full.language||'python');
      setEditCode(full.code||r.raw?.code||p.code||'');
    } catch{
      setEditing(p);
      setEditLang(p.language||'python');
      setEditCode(p.code||'');
    }
  };
  const handleSaveEdit = async ()=>{
    if(!editing) return;
    try {
      const payload:any={
        name: editing.name,
        description: editing.description,
        language: editLang,
        code: editCode,
        code_entry: editing.code_entry || 'generate',
        kind: editing.kind,
        params_schema: editing.params_schema,
        default_params: editing.default_params,
      };
      if(editing.models){
        payload.models = typeof editing.models==='string' ? editing.models.split(',').map((s:string)=>s.trim()).filter(Boolean) : editing.models;
      }
      if(editing.default_model) payload.default_model = editing.default_model;
      await apiService.updateProvider(editing.id, payload);
      setEditing(null); setEditCode(''); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ alert(e.message); }
  };
  const handleImport = async ()=>{
    if(!importDoc.trim()){ alert('请粘贴 API 文档/cURL/OpenAPI'); return; }
    try{
      const r=await apiService.importProvider({ kind: importKind, name: importName||undefined, doc_text: importDoc, api_key: importKey||undefined, language: importLang } as any);
      setImportMode(false); setImportDoc(''); setImportName(''); setImportKey('');
      onRefresh(); window.dispatchEvent(new Event('provider-list-refresh'));
      alert(`✓ 已导入 ${r.provider?.id} (${r.mode}) lang=${r.provider?.language||importLang}`);
    } catch(e:any){ alert(e.message); }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><Plug className="w-4 h-4 text-brand"/> 生成源中枢 <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">{customCount} 自定义</span> <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">{providers.length} 总计</span></h2>
          <p className="text-[11px] text-gray-400 mt-1">代码为唯一执行方式（python/javascript 携程），导演可直接编辑/升级。旧 JSON 源需一键升级。</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={()=> setImportMode(v=>!v)} className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 ${importMode?'bg-brand border-brand text-white':'bg-surface-secondary border-border text-white hover:border-brand'}`}><FileText className="w-3.5 h-3.5"/>{importMode?'关闭导入':'从文档导入'}</button>
          <button onClick={()=> setShowCreate(true)} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Plus className="w-3.5 h-3.5"/> 新建代码源</button>
        </div>
      </div>

      {/* Import panel - 代码模式 */}
      {importMode && (
        <div className="p-4 rounded-2xl bg-brand/5 border border-brand/20 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={importKind} onChange={e=> setImportKind(e.target.value as any)} className="bg-surface border border-border rounded-xl px-2 py-1.5 text-xs text-white">
              <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option>
            </select>
            <select value={importLang} onChange={e=> setImportLang(e.target.value as any)} className="bg-surface border border-border rounded-xl px-2 py-1.5 text-xs text-white">
              <option value="python">Python</option><option value="javascript">JavaScript</option>
            </select>
            <input value={importName} onChange={e=> setImportName(e.target.value)} placeholder="名称（可选）" className="flex-1 min-w-[160px] bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-white placeholder-gray-500"/>
            <input value={importKey} onChange={e=> setImportKey(e.target.value)} placeholder="API Key（可选）" className="flex-1 min-w-[160px] bg-surface border border-border rounded-xl px-3 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
          </div>
          <textarea value={importDoc} onChange={e=> setImportDoc(e.target.value)} placeholder="粘贴 API 文档 / cURL / OpenAPI JSON… 导演将直接生成 python/js 携程源码（含轮询/签名）" rows={4} className="w-full bg-black/40 border border-border rounded-xl p-3 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"/>
          <div className="flex justify-end gap-2">
            <button onClick={()=> setImportMode(false)} className="px-3 py-1.5 rounded-xl bg-surface border border-border text-xs text-white">取消</button>
            <button onClick={handleImport} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Code2 className="w-3.5 h-3.5"/> 让导演生成代码</button>
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
          <input value={q} onChange={e=> setQ(e.target.value)} placeholder="搜索 名称/ID/语言…" className="w-full bg-surface-secondary border border-border rounded-full pl-9 pr-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
        </div>
        <button onClick={onRefresh} className="px-3 py-2 rounded-full bg-surface-secondary border border-border text-xs text-white hover:border-brand shrink-0">刷新</button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filtered.map(p=>{
          const Icon = kindIcon[p.kind] || Plug;
          const color = kindColor[p.kind] || 'text-brand';
          const isLegacy = p.legacy_json_mode || (!p.has_code && !p.code && p.transport?.url);
          return (
            <div key={p.id} className={`p-4 rounded-2xl border flex flex-col gap-2.5 ${p.builtin?'bg-surface-secondary/40 border-border': isLegacy?'bg-amber-500/5 border-amber-500/30':'bg-surface border-brand/20 shadow-sm'}`}>
              <div className="flex items-center justify-between min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center border bg-black/20 ${p.builtin?'border-border':'border-brand/20'}`}><Icon className={`w-4 h-4 ${color}`}/></div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">{p.display_name || p.name || p.id}
                      {!p.builtin && <span className={`text-[10px] px-1.5 py-0 rounded border flex items-center gap-1 ${p.language==='javascript'?'bg-yellow-500/15 text-yellow-300 border-yellow-500/20':'bg-blue-500/15 text-blue-300 border-blue-500/20'}`}><Languages className="w-3 h-3"/>{p.language||'python'}</span>}
                      {isLegacy && <span className="text-[10px] px-1.5 py-0 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">旧JSON</span>}
                    </div>
                    <div className="text-[10px] font-mono text-gray-500 truncate">{p.id} · {p.kind} {p.has_code?'·有代码':''}</div>
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${p.builtin?'bg-surface border-border text-gray-400':'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>
              </div>
              {p.description && <div className="text-[11px] text-gray-400 line-clamp-2">{p.description}</div>}
              <div className="text-[10px] font-mono text-gray-500 truncate flex items-center gap-1"><FileCode className="w-3 h-3"/> {p.has_code||p.code ? `代码 ${p.code_entry||'generate'} (${(p.code||'').split('\n').length} 行)` : (p.transport?.url?`URL: ${p.transport.url}`:'— 无代码')}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                <span>模型</span><span className="px-1.5 py-0.5 rounded bg-black/30 text-gray-300 truncate max-w-[140px]">{p.default_model || p.models?.[0] || '—'}</span>
                <span className="ml-auto flex items-center gap-1.5">{p.health?.ok!==undefined && <span className={`w-2 h-2 rounded-full ${p.health.ok?'bg-emerald-500':'bg-amber-500'}`}/>}{p.language && <span className="px-1 py-0 rounded bg-black/30">{p.language}</span>}</span>
              </div>
              <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                <button onClick={()=> handleTest(p.id)} className="flex-1 min-w-[60px] py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white hover:border-brand flex items-center justify-center gap-1"><Activity className="w-3 h-3"/> 测试</button>
                <button onClick={()=> openEdit(p)} className="flex-1 min-w-[60px] py-1.5 rounded-xl bg-brand/10 border border-brand/20 text-brand-light text-xs flex items-center justify-center gap-1"><Edit3 className="w-3 h-3"/> {p.builtin?'查看':'编辑代码'}</button>
                {!p.builtin && isLegacy && <button onClick={()=> handleUpgrade(p.id)} className="px-3 py-1.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-1"><ArrowUpCircle className="w-3 h-3"/> 升级</button>}
                {!p.builtin && <button onClick={()=> handleDelete(p.id)} className="px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-1"><Trash2 className="w-3 h-3"/> 删除</button>}
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length===0 && <div className="text-center py-10 text-sm text-gray-500">暂无匹配的生成源</div>}

      {/* Edit drawer - Code Editor */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[85vh] bg-[#0f0f12] rounded-2xl border border-zinc-800 flex flex-col overflow-hidden">
            <div className="h-12 px-4 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-[#18181b]">
              <span className="text-sm font-bold text-white flex items-center gap-2"><Code2 className="w-4 h-4 text-violet-400"/>{editing.builtin?'查看':'编辑'} {editing.id} <span className="text-xs font-normal text-zinc-500">· {editing.kind} · {editLang}</span></span>
              <div className="flex items-center gap-2">
                <select value={editLang} onChange={e=> setEditLang(e.target.value as any)} className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-white" disabled={editing.builtin}>
                  <option value="python">Python</option><option value="javascript">JavaScript</option>
                </select>
                <button onClick={()=> setEditing(null)} className="p-1 rounded hover:bg-zinc-800"><X className="w-4 h-4 text-zinc-400"/></button>
              </div>
            </div>
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 flex flex-col min-w-0">
                <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 bg-[#18181b]">
                  <span className="text-xs text-zinc-400">入口: </span>
                  <input value={editing.code_entry||'generate'} onChange={e=> setEditing({...editing, code_entry:e.target.value})} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono w-32" disabled={editing.builtin}/>
                  <span className="ml-auto text-[11px] text-zinc-500">ctx/api 参考：prompt/size/api_key/reference_images/first_frame_url/duration/text/voice_id | api.httpx/api.asyncio/api.download</span>
                </div>
                <textarea value={editCode} onChange={e=> setEditCode(e.target.value)} spellCheck={false} disabled={editing.builtin} className="flex-1 w-full bg-[#0f0f12] p-4 font-mono text-[13px] leading-5 text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none" placeholder={`async def generate(ctx, api):\n    # ctx: {prompt, width, height, api_key, ...}\n    # api: {httpx, asyncio, download, json, re}\n    ...\n    return {"image_url": url}`} />
              </div>
              <div className="w-[320px] border-l border-zinc-800 bg-[#18181b] p-3 space-y-3 overflow-y-auto hidden lg:flex flex-col">
                <div className="text-xs font-bold text-white">元信息</div>
                <input value={editing.name||''} onChange={e=> setEditing({...editing, name:e.target.value})} placeholder="名称" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white" disabled={editing.builtin}/>
                <textarea value={editing.description||''} onChange={e=> setEditing({...editing, description:e.target.value})} placeholder="描述" rows={2} className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2 text-xs text-white" disabled={editing.builtin}/>
                <div className="text-xs font-bold text-white mt-2">模型</div>
                <input value={Array.isArray(editing.models)?editing.models.join(','):editing.models||''} onChange={e=> setEditing({...editing, models:e.target.value.split(',').map((s:string)=>s.trim()).filter(Boolean)})} placeholder="models 逗号分隔" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono" disabled={editing.builtin}/>
                <input value={editing.default_model||''} onChange={e=> setEditing({...editing, default_model:e.target.value})} placeholder="default_model" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono" disabled={editing.builtin}/>
                {/* 独立参数：每源独立 DynamicControl，不再共享 JSON 手填 */}
                <div className="rounded-xl bg-white border border-zinc-200 p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-900">独立参数</span>
                    {!editing.builtin && <button onClick={()=>{
                      const pname = prompt('参数名 (英文，如 aspect_ratio)');
                      if(!pname) return;
                      const title = prompt('显示名', pname) || pname;
                      const type = prompt('类型 combo/number/text/boolean', 'text') || 'text';
                      const def = prompt('默认值', '');
                      const optsRaw = type==='combo' ? prompt('枚举逗号分隔，如 9:16,16:9,1:1', '') : '';
                      const cur = editing.params_schema || {type:'object', properties:{}};
                      const props = {...(cur.properties||{})};
                      const schema:any = {type, title, description: title, default: def};
                      if(type==='combo' && optsRaw) schema.enum = optsRaw.split(',').map((s:string)=>s.trim()).filter(Boolean);
                      if(type==='number') { schema.minimum=0; schema.maximum=100; }
                      props[pname]=schema;
                      setEditing({...editing, params_schema:{...cur, properties: props}});
                    }} className="text-[11px] px-2 py-1 rounded-full bg-violet-600 text-white hover:bg-violet-700">+ 添加</button>}
                  </div>
                  <div className="text-[11px] text-zinc-500">每个参数独立控件类型自动匹配（combo→下拉 number→滑杆 image→上传），按源独立，与 ComfyUI 节点一致。</div>
                  {editing.params_schema?.properties && Object.keys(editing.params_schema.properties).length>0 ? (
                    <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                      {Object.entries(editing.params_schema.properties as any).map(([pname, pdef]:any)=>{
                        const spec:any = {
                          id: pname,
                          param_name: pname,
                          label: (pdef as any).title || pname,
                          type: (pdef as any).enum ? 'combo' : (pdef as any).type==='integer' || (pdef as any).type==='number' ? 'number' : (pdef as any).type==='boolean' ? 'boolean' : (pdef as any).type==='image' || (pdef as any).format==='uri' ? 'image' : 'text',
                          description: (pdef as any).description || (pdef as any).title || pname,
                          options: (pdef as any).enum?.map((x:any)=> String(x)),
                          default_value: (pdef as any).default,
                          min: (pdef as any).minimum,
                          max: (pdef as any).maximum,
                          step: (pdef as any).step,
                        };
                        const val = editing.default_params?.[pname] ?? (pdef as any).default;
                        return (
                          <div key={pname} className="p-2 rounded-xl border border-zinc-200 bg-zinc-50/50">
                            <DynamicControl spec={spec} value={val} onChange={v=>{
                              const nd = {...(editing.default_params||{}), [pname]: v};
                              // 同时更新 schema default 保持一致
                              const np = {...editing.params_schema.properties, [pname]: {...pdef, default: v}};
                              setEditing({...editing, default_params: nd, params_schema:{...editing.params_schema, properties: np}});
                            }} />
                            {!editing.builtin && (
                              <div className="flex gap-1 mt-1">
                                <button onClick={()=>{
                                  const np = prompt('重命名显示名', spec.label) || spec.label;
                                  const props = {...editing.params_schema.properties, [pname]: {...pdef, title: np}};
                                  setEditing({...editing, params_schema:{...editing.params_schema, properties: props}});
                                }} className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-zinc-200 hover:border-violet-300">✎ 重命名</button>
                                <button onClick={()=>{
                                  if(!confirm(`删除参数 ${pname}?`)) return;
                                  const props = {...editing.params_schema.properties}; delete props[pname];
                                  const nd = {...editing.default_params}; delete nd[pname];
                                  setEditing({...editing, params_schema:{...editing.params_schema, properties: props}, default_params: nd});
                                }} className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-600">删除</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[11px] text-zinc-400 text-center py-3 border border-dashed border-zinc-300 rounded-xl">暂无独立参数 · 点击“添加”按 {editing.kind} 预设填充<br/>建议：image→aspect_ratio/resolution/steps/cfg · video→aspect_ratio/resolution/duration/fps</div>
                  )}
                  {!editing.builtin && !editing.params_schema?.properties && (
                    <button onClick={()=>{
                      const preset:any = editing.kind==='image' ? {aspect_ratio:{type:'string',title:'画面比例',enum:["9:16","16:9","1:1"],default:"9:16"}, resolution:{type:'string',title:'分辨率',enum:["480p","720p","1080p"],default:"720p"}, steps:{type:'integer',title:'步数',default:20,minimum:4,maximum:60}, cfg:{type:'number',title:'CFG',default:7,minimum:1,maximum:15,step:0.5}} :
                        editing.kind==='video' ? {aspect_ratio:{type:'string',title:'画面比例',enum:["9:16","16:9","1:1"],default:"9:16"}, resolution:{type:'string',title:'分辨率',enum:["480p","720p","1080p"],default:"720p"}, duration:{type:'integer',title:'时长',default:5,minimum:3,maximum:15}, fps:{type:'integer',title:'帧率',enum:[16,24,30],default:24}} :
                        {speed:{type:'number',title:'语速',default:1,minimum:0.5,maximum:2,step:0.1}};
                      setEditing({...editing, params_schema:{type:'object', properties: preset}, default_params:{}});
                    }} className="w-full py-1.5 rounded-xl bg-zinc-900 text-white text-xs">一键填充 {editing.kind} 预设</button>
                  )}
                </div>
                <div className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-[11px] leading-relaxed text-zinc-400">
                  <div className="font-semibold text-zinc-200 mb-1">代码约定</div>
                  Python: <code className="text-violet-300">async def generate(ctx, api)</code> 返回 <code className="text-emerald-300">{"{"+`"image_url": url`+"}"}</code><br/>
                  JS: <code className="text-violet-300">async function generate(ctx, api)</code> 返回同<br/>
                  <code className="text-zinc-500">ctx.api_key</code> 自动注入（无需写死）<br/>
                  <code className="text-zinc-500">await api.download(url)</code> 可下载落盘<br/>
                  支持任意轮询、签名、重试逻辑
                </div>
                {!editing.builtin && (
                  <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-700 space-y-2">
                    <span className="text-[11px] font-semibold text-white flex items-center gap-1"><KeyRound className="w-3 h-3"/> 改 API Key</span>
                    <SetKeyInline providerId={editing.id} />
                  </div>
                )}
                <button onClick={()=>{
                  const tmpl = CODE_TEMPLATES_FALLBACK[`${editLang}:${editing.kind}`] || CODE_TEMPLATES_FALLBACK["python:image"];
                  if(confirm('用模板覆盖当前代码？')) setEditCode(tmpl);
                }} className="w-full py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-xs text-white hover:bg-zinc-700 flex items-center justify-center gap-1" disabled={editing.builtin}><Copy className="w-3 h-3"/> 填充模板</button>
              </div>
            </div>
            <div className="p-3 border-t border-zinc-800 flex justify-end gap-2 shrink-0 bg-[#18181b]">
              <button onClick={()=> setEditing(null)} className="px-4 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-xs text-white">取消</button>
              {!editing.builtin && <button onClick={handleSaveEdit} className="px-4 py-1.5 rounded-xl bg-violet-600 text-white text-xs font-bold flex items-center gap-1 hover:bg-violet-700"><Save className="w-3.5 h-3.5"/> 保存代码</button>}
            </div>
          </div>
        </div>
      )}

      {/* Create - Code */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <CreateCodeForm onClose={()=> setShowCreate(false)} onCreated={()=> { setShowCreate(false); onRefresh(); window.dispatchEvent(new Event('provider-list-refresh')); }} />
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
      <input value={k} onChange={e=> setK(e.target.value)} placeholder="输入新 API Key" className="flex-1 bg-black/40 border border-zinc-700 rounded-xl px-3 py-1.5 text-xs font-mono text-white placeholder-zinc-500"/>
      <button onClick={save} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold">保存Key</button>
    </div>
  );
};

const CreateCodeForm: React.FC<{onClose:()=>void, onCreated:()=>void}> = ({ onClose, onCreated })=>{
  const [form, setForm] = useState<any>({ name:'', kind:'image', language:'python', description:'', code:'', code_entry:'generate', models:'', default_model:'' });
  const [apiKey, setApiKey] = useState('');
  const [loadingTmpl, setLoadingTmpl] = useState(false);
  const loadTemplate = async ()=>{
    setLoadingTmpl(true);
    try{
      const r = await apiService.getCodeTemplate(form.language, form.kind);
      setForm({...form, code: r.template});
    } catch{
      // fallback
      const fb = CODE_TEMPLATES_FALLBACK[`${form.language}:${form.kind}`] || CODE_TEMPLATES_FALLBACK["python:image"];
      setForm({...form, code: fb});
    } finally{ setLoadingTmpl(false); }
  };
  useEffect(()=>{ if(!form.code) loadTemplate(); }, []);
  useEffect(()=>{ loadTemplate(); }, [form.language, form.kind]);
  const handleSubmit = async ()=>{
    try{
      const payload:any={
        name: form.name,
        kind: form.kind,
        language: form.language,
        code: form.code,
        code_entry: form.code_entry||'generate',
        description: form.description,
        models: typeof form.models==='string' ? form.models.split(',').map((s:string)=>s.trim()).filter(Boolean) : form.models,
        default_model: form.default_model||undefined,
      };
      if(apiKey) payload.api_key = apiKey;
      await apiService.createProvider(payload);
      onCreated();
    }catch(e:any){ alert(e.message); }
  };
  return (
    <div className="w-full max-w-5xl h-[85vh] bg-[#0f0f12] rounded-2xl border border-zinc-800 flex flex-col overflow-hidden">
      <div className="h-12 px-4 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-[#18181b]">
        <span className="text-sm font-bold text-white flex items-center gap-2"><FileCode className="w-4 h-4 text-violet-400"/> 新建代码生成源</span>
        <button onClick={onClose}><X className="w-4 h-4 text-zinc-400"/></button>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="p-3 border-b border-zinc-800 flex items-center gap-2 bg-[#18181b]">
            <select value={form.language} onChange={e=> setForm({...form, language:e.target.value})} className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white">
              <option value="python">Python</option><option value="javascript">JavaScript</option>
            </select>
            <input value={form.code_entry} onChange={e=> setForm({...form, code_entry:e.target.value})} placeholder="入口" className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-mono text-white w-28"/>
            <button onClick={loadTemplate} disabled={loadingTmpl} className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-white hover:bg-zinc-700">{loadingTmpl?'加载中…':'填充模板'}</button>
          </div>
          <textarea value={form.code} onChange={e=> setForm({...form, code:e.target.value})} spellCheck={false} className="flex-1 w-full bg-[#0f0f12] p-4 font-mono text-[13px] leading-5 text-zinc-100 focus:outline-none resize-none" placeholder={`async def generate(ctx, api):\n    ...\n    return {"image_url": url}`}/>
        </div>
        <div className="w-[320px] border-l border-zinc-800 bg-[#18181b] p-3 space-y-3 overflow-y-auto">
          <input value={form.name} onChange={e=> setForm({...form, name:e.target.value})} placeholder="名称，如 我的Flux" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-500"/>
          <select value={form.kind} onChange={e=> setForm({...form, kind:e.target.value})} className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white">
            <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option><option value="llm">LLM</option>
          </select>
          <textarea value={form.description} onChange={e=> setForm({...form, description:e.target.value})} placeholder="描述" rows={2} className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2 text-xs text-white placeholder-zinc-500"/>
          <input value={form.models} onChange={e=> setForm({...form, models:e.target.value})} placeholder="models 逗号分隔，可空" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-500"/>
          <input value={form.default_model} onChange={e=> setForm({...form, default_model:e.target.value})} placeholder="default_model，可空" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-500"/>
          <input value={apiKey} onChange={e=> setApiKey(e.target.value)} placeholder="API Key（可选）" className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono placeholder-zinc-500"/>
        </div>
      </div>
      <div className="p-3 border-t border-zinc-800 flex justify-end gap-2 shrink-0 bg-[#18181b]">
        <button onClick={onClose} className="px-3 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-xs text-white">取消</button>
        <button onClick={handleSubmit} className="px-4 py-1.5 rounded-xl bg-violet-600 text-white text-xs font-bold">创建</button>
      </div>
    </div>
  );
};
