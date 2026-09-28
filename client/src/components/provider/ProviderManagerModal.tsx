import React, { useEffect, useState } from 'react';
import { X, Plus, Plug, Globe, Video, Mic, Cpu, Trash2, Edit3, Activity, Save, Upload, FileText, Link2, TestTube } from 'lucide-react';
import { apiService } from '../../services/api';
import { CAPABILITIES_BY_KIND, getCapabilities } from './providerCapabilities';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { CustomHeadersEditor } from './CustomHeadersEditor';
import { useEscapeClose } from '../../hooks/useEscapeClose';

interface Props {
  isOpen: boolean;
  onClose: ()=>void;
  /** 打开即直接进入该生成源的编辑态（设置→扩展里点「编辑」用，调用方已取好完整定义） */
  editProvider?: any;
}

const kindIcon: any = { image: Globe, video: Video, audio: Mic, llm: Cpu };
const kindColor: any = { image: 'text-violet-400', video: 'text-orange-400', audio: 'text-pink-400', llm: 'text-cyan-400' };

export const ProviderManagerModal: React.FC<Props> = ({ isOpen, onClose, editProvider }) => {
  const [providers, setProviders] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all'|'image'|'video'|'audio'>('all');
  const [q, setQ] = useState('');
  const [capFilter, setCapFilter] = useState<string>('all');
  const [editing, setEditing] = useState<any>(null);
  const [editApiKey, setEditApiKey] = useState('');
  const [editSrc, setEditSrc] = useState<any>(null);
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
  /** 列表项不含 code/params_schema，进编辑前先拉完整定义，避免代码框空白 */
  const openEdit = async (p:any)=>{
    try {
      const r = await apiService.getProvider(p.id);
      setEditApiKey('');
      setEditing({ ...(r.provider || p), code: (r.provider?.code ?? r.raw?.code ?? p.code ?? '') });
    } catch {
      setEditApiKey('');
      setEditing(p);
    }
  };

  useEffect(()=> { if (isOpen) fetchAll(); }, [isOpen]);

  useEffect(()=>{
    const h = ()=> fetchAll();
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);

  const filtered = providers.filter(p=>{
    if (filter!=='all' && p.kind!==filter) return false;
    if (capFilter!=='all' && !getCapabilities(p).includes(capFilter)) return false;
    if (q && !(`${p.name||''} ${p.display_name||''} ${p.id}`.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  // 能力筛选项随类型过滤联动（各 kind 能力 id 无重名，直接用 id 匹配）
  const capOptions = filter==='all'
    ? Object.values(CAPABILITIES_BY_KIND).flat()
    : (CAPABILITIES_BY_KIND[filter] || []);
  const customCount = providers.filter(p=> !p.builtin).length;

  const handleDelete = async (id:string)=>{
    const confirmed = await confirmAsync({
      title: '删除生成源',
      message: `确定要删除自定义源 ${id} 吗？\n删除后相关引用的节点可能需要重新指定生成源。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消'
    });
    if (!confirmed) return;
    try {
      await apiService.deleteProvider(id);
      toast.success(`生成源 ${id} 已删除`);
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ toast.error(e.message || '删除失败'); }
  };
  const handleTest = async (id:string)=>{
    try {
      const res = await apiService.testProvider(id);
      if (res.ok) toast.success(`✓ ${id} 连通正常`);
      else toast.error(`✗ ${id} 检测未通过: ${res.detail || JSON.stringify(res)}`);
      await fetchAll();
    } catch(e:any){ toast.error(e.message || '测试失败'); }
  };
  const handleSaveEdit = async ()=>{
    if (!editing) return;
    try {
      const payload: any = { ...editing };
      // 清理只读字段
      delete payload.health;
      // 处理 JSON 字符串字段
      for (const k of ['params_schema','input_schema','output_schema','default_params','headers']) {
        if (typeof payload[k] === 'string' && payload[k].trim()) {
          try { payload[k] = JSON.parse(payload[k]); } catch { alert(`${k} JSON 格式错误`); return; }
        }
        if (payload[k]==='' || payload[k]==='null') delete payload[k];
      }
      if (editing.headers) payload.headers = editing.headers;
      if (editApiKey) payload.api_key = editApiKey;
      await apiService.updateProvider(editing.id, payload);
      if (editProvider) { onClose(); } else { setEditing(null); }
      await fetchAll();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch(e:any){ alert(e.message); }
  };

  const handleAutoFixVideoCode = ()=>{
    if (!editing || editing.kind!=='video') return;
    // 智能一键修正：按真实代码与当前 schema 动态映射，而非全量固定模板
    const curParams = editing.params_schema && typeof editing.params_schema === 'object' ? editing.params_schema : {type:"object", properties:{}};
    const curInput = editing.input_schema && typeof editing.input_schema === 'object' ? editing.input_schema : {type:"object", properties:{}};
    // 解析当前 params 的 properties（兼容 JSON 字符串或对象）
    let props: any = {};
    try {
      const raw = typeof curParams === 'string' ? JSON.parse(curParams) : curParams;
      props = raw.properties || {};
    } catch { props = (curParams as any).properties || {}; }
    let iprops: any = {};
    try {
      const raw2 = typeof curInput === 'string' ? JSON.parse(curInput) : curInput;
      iprops = raw2.properties || {};
    } catch { iprops = (curInput as any).properties || {}; }
    // 1) params: 保留已有的真实枚举，仅修正通用误套
    const codeStr: string = typeof editing.code === 'string' ? editing.code : '';
    const hasAspectInCode = codeStr.includes('aspect_ratio');
    const hasFpsInCode = codeStr.includes('fps') || codeStr.includes('"fps"') || codeStr.includes("'fps'");
    // 若当前 resolution 是通用 3 值且代码实际要 4 值，则替换
    let resEnum = props.resolution?.enum;
    if (Array.isArray(resEnum) && resEnum.length===3 && resEnum.includes('480p') && resEnum.includes('720p')) {
      resEnum = ["480p竖","768p竖","480p横","768p横"];
    }
    // 若当前无 resolution 或为通用，则用 4 值；若已有 6 值则保留
    if (!resEnum || (Array.isArray(resEnum) && resEnum.length===3)) {
      resEnum = ["480p竖","768p竖","480p横","768p横"];
    }
    const newProps: any = { ...props };
    // 写入/修正 resolution
    newProps.resolution = { type: "string", title: "分辨率", enum: resEnum, default: resEnum.includes("768p竖") ? "768p竖" : resEnum[0], description: "分辨率（竖=9:16 横=16:9）", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20 };
    // 保留 duration，若无则补
    if (!newProps.duration) newProps.duration = { type: "integer", title: "时长", default: 5, minimum: 3, maximum: 15, description: "时长秒 3-15", "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30 };
    // 补 seed（若代码里有 seed 但 UI 没有）
    if (!newProps.seed && codeStr.includes('seed')) newProps.seed = { type: "integer", title: "随机种子", description: "随机种子，留空随机", "x-category": "quality", "x-visibility": "advanced", "x-agent": "manual", "x-priority": 99 };
    // 清理多余的 aspect_ratio/fps（若代码未使用）
    if (!hasAspectInCode && newProps.aspect_ratio) delete newProps.aspect_ratio;
    if (!hasFpsInCode && newProps.fps) delete newProps.fps;
    // 移除误入 params 的文件类字段（prompt/first_frame 等应只在 input）
    for (const k of ['prompt','first_frame','last_frame','reference_images','reference_audios','first_frame_url','ref_audio','text']) {
      if (newProps[k] && newProps[k].format === 'uri') delete newProps[k];
    }
    // 兜底：若 params 为空则至少保留 resolution/duration/seed
    const fixedParams = { type: "object", properties: newProps };
    // 2) input: 补齐 9 张 / 3 条 上限，按真实 max 映射
    const newIProps: any = { ...iprops };
    // 确保基础字段存在（尾帧不再默认补：未声明支持尾帧的源挂上会误导）
    if (!newIProps.prompt) newIProps.prompt = { type: "string", description: "运动描述", "x-handle": "text" };
    if (!newIProps.first_frame) newIProps.first_frame = { type: "string", format: "uri", description: "首帧（定格开头画面）", "x-handle": "image" };
    if (!newIProps.reference_images) newIProps.reference_images = { type: "array", items: { type: "string", format: "uri" }, description: "参考集，最多9张", "x-handle": "image", maxItems: 9, minItems: 0 };
    else { newIProps.reference_images.maxItems = 9; newIProps.reference_images.minItems = 0; newIProps.reference_images.description = "参考集，最多9张"; newIProps.reference_images["x-handle"] = "image"; }
    if (!newIProps.reference_audios) newIProps.reference_audios = { type: "array", items: { type: "string", format: "uri" }, description: "参考音频，最多3条", "x-handle": "audio", maxItems: 3, minItems: 0 };
    else { newIProps.reference_audios.maxItems = 3; newIProps.reference_audios.minItems = 0; newIProps.reference_audios.description = "参考音频，最多3条"; newIProps.reference_audios["x-handle"] = "audio"; }
    const fixedInput = { type: "object", properties: newIProps, required: ["prompt"] };
    setEditing({...editing, params_schema: fixedParams, input_schema: fixedInput});
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

  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;

  /** 从设置页点某个源的「编辑」进来：只给编辑表单，不摆一层管理列表 */
  const directEdit = !!editProvider;
  // 渲染期同步对齐 props：React 会在这一帧内重渲染，不会先把空态画出来。
  // 按对象引用比对（每次打开都是新拉的定义），保证同一个源再次打开也是干净的。
  if (directEdit && editSrc !== editProvider) {
    setEditSrc(editProvider);
    setEditing(editProvider);
    setEditApiKey('');
    return null;
  }
  const closeEdit = ()=> { if (directEdit) { onClose(); } else { setEditing(null); } };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className={directEdit ? 'contents' : 'w-full max-w-6xl h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl'}>
        {!directEdit && (<>
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
            <textarea value={importDoc} onChange={e=> setImportDoc(e.target.value)} placeholder="粘贴 API 文档 / cURL / OpenAPI JSON… 导演将自动解析 transport/auth/input_schema/output_schema" rows={4} className="w-full bg-surface-secondary border border-border rounded-xl p-3 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"/>
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
              <button key={k} onClick={()=> { setFilter(k); setCapFilter('all'); }} className={`px-3 py-1 rounded-full text-xs font-medium ${filter===k?'bg-brand text-white shadow-sm':'text-gray-400 hover:text-white'}`}>{k==='all'?'全部':k==='image'?'生图':k==='video'?'视频':'语音'}</button>
            ))}
          </div>
          <input value={q} onChange={e=> setQ(e.target.value)} placeholder="搜索 名称/ID…" className="flex-1 max-w-xs bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
          <select value={capFilter} onChange={e=> setCapFilter(e.target.value)} className="bg-surface-secondary border border-border rounded-full px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand" title="按能力细分筛选">
            <option value="all">全部能力</option>
            {capOptions.map(o=> <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
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
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center border bg-surface-secondary ${p.builtin?'border-border':'border-brand/20'}`}><Icon className={`w-4 h-4 ${color}`} /></div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{p.display_name || p.name || p.id}</div>
                        <div className="text-[10px] font-mono text-gray-500 truncate">{p.id} · {p.kind} {p.provider_type?`·${p.provider_type}`:''}</div>
                      </div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${p.builtin?'bg-surface border-border text-gray-400':'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>
                  </div>
                  {p.description && <div className="text-[11px] text-gray-400 line-clamp-2">{p.description}</div>}
                  <div className="flex flex-wrap items-center gap-1">
                    {getCapabilities(p).map(c=> (
                      <span key={c} title={c} className={`text-[10px] px-1.5 py-0.5 rounded border ${Array.isArray(p.capabilities) && p.capabilities.length ? 'bg-brand/10 border-brand/30 text-brand-light' : 'bg-surface-secondary border-border text-gray-500'}`}>{(CAPABILITIES_BY_KIND[p.kind] || []).find(o=>o.id===c)?.label || c}</span>
                    ))}
                  </div>
                  <div className="text-[10px] font-mono text-gray-500 truncate" title={p.transport?.url}>URL: {p.transport?.url || '—'}</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    <span>模型:</span><span className="px-1.5 py-0.5 rounded bg-surface-secondary text-gray-300 truncate max-w-[140px]">{p.default_model || p.models?.[0] || '—'}</span>
                    <span className="ml-auto flex items-center gap-1">{p.health?.ok ? <span className="w-2 h-2 rounded-full bg-emerald-500"/> : p.health?.ok===false ? <span className="w-2 h-2 rounded-full bg-amber-500"/> : null}{p.builtin?'':<span className="px-1 py-0.5 rounded bg-surface-secondary">{p.params_schema ? Object.keys(p.params_schema.properties||{}).length+' 参数' : '无参'}</span>}</span>
                  </div>
                  <div className="flex items-center gap-1.5 pt-1">
                    <button onClick={()=> handleTest(p.id)} className="flex-1 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white hover:border-brand flex items-center justify-center gap-1"><Activity className="w-3 h-3"/> 测试</button>
                    <button onClick={()=> openEdit(p)} className="flex-1 py-1.5 rounded-lg bg-brand/10 border border-brand/20 text-brand-light text-xs flex items-center justify-center gap-1"><Edit3 className="w-3 h-3"/> {p.builtin?'查看':'编辑'}</button>
                    {!p.builtin && <button onClick={()=> handleDelete(p.id)} className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-1"><Trash2 className="w-3 h-3"/> 删除</button>}
                  </div>
                </div>
              );
            })}
          </div>
          {filtered.length===0 && <div className="text-center py-12 text-sm text-gray-500">暂无匹配的生成源</div>}
        </div>

        </>)}

        {/* Edit Drawer */}
        {editing && (
          <div className="absolute inset-0 bg-surface/85 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-2xl max-h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden">
              <div className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-sm font-bold text-white">{editing.builtin?'查看':'编辑'} {editing.id}</span>
                <button onClick={closeEdit} className="p-1 rounded hover:bg-surface-tertiary"><X className="w-4 h-4 text-gray-400"/></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar text-xs">
                {/* 代码型一键修正 */}
                {editing.kind==='video' && editing.provider_type==='code' && !editing.builtin && (
                  <div className="p-3 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-between gap-2">
                    <div className="text-[11px] leading-tight">
                      <div className="font-bold text-violet-300">检测到代码型 video 通用模板 mismatch</div>
                      <div className="text-violet-200/70">点击一键修正为真实 API：4 分辨率（竖/横）· 去除多余 aspect_ratio/fps · 补 seed/reference_audios</div>
                    </div>
                    <button onClick={handleAutoFixVideoCode} className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-bold shrink-0">一键修正</button>
                  </div>
                )}
                {!editing.builtin && editing.provider_type !== 'comfyui' && (
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-400 block">API Key</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="password" value={editApiKey} autoComplete="off"
                        onChange={e=> setEditApiKey(e.target.value)}
                        placeholder="留空则不改动已保存的 Key"
                        className="flex-1 bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 font-mono"
                      />
                      <button
                        onClick={async ()=>{
                          const ok = await confirmAsync({ title:'清除 API Key', isDanger:true, confirmText:'确认清除', cancelText:'取消',
                            message:`清除「${editing.name || editing.id}」已保存的 Key？清除后这个源会变成未配置。` });
                          if (!ok) return;
                          try {
                            // 清 Key 走 PUT（api_key:"" = 删除，走 POST /api-key 会被 400 拒绝）
                            await apiService.updateProvider(editing.id, { api_key: '' });
                            toast.success('已清除');
                            window.dispatchEvent(new Event('provider-list-refresh'));
                          } catch(e:any){ toast.error(e?.message || '清除失败'); }
                        }}
                        className="px-2.5 py-2 rounded-lg bg-surface border border-border text-[11px] text-gray-400 hover:text-white shrink-0"
                      >清除</button>
                    </div>
                    <div className="text-[10.5px] text-gray-500">代码里用 <code className="font-mono">api.get("api_key")</code> 取，不用写死在代码中</div>
                  </div>
                )}
                {[
                  {k:'name', label:'名称', type:'text'},
                  {k:'kind', label:'类型 kind (image|video|audio)', type:'select', opts:['image','video','audio','llm']},
                  {k:'capabilities', label:'能力细分（多选；不选=按插槽自动推断）', type:'caps'},
                  {k:'headers', label:'自定义请求头 (Custom Headers)', type:'custom_headers'},
                  {k:'description', label:'描述', type:'textarea'},
                  {k:'code', label:'code (python/javascript, 完整 generate)', type:'code'},
                  {k:'input_schema', label:'input_schema JSON (文件插槽: prompt/首帧/参考图/参考音频)', type:'json'},
                  {k:'params_schema', label:'params_schema JSON (非文件参数, 需带 x-* 分组)', type:'json'},
                  {k:'output_schema', label:'output_schema JSON', type:'json'},
                  {k:'models', label:'models (逗号分隔)', type:'text'},
                  {k:'default_model', label:'default_model', type:'text'},
                  {k:'default_params', label:'default_params JSON', type:'json'},
                ].map(f=>{
                  const val = editing[f.k];
                  const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : (val ?? '');
                  return (
                    <div key={f.k} className="space-y-1">
                      <span className="text-[11px] font-semibold text-gray-300">{f.label} <span className="text-[10px] text-gray-500">{f.k}</span></span>
                      {f.type==='textarea' ? (
                        <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={2} className="w-full bg-surface-secondary border border-border rounded-lg p-2 font-mono text-xs text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                      ) : f.type==='code' ? (
                        <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={10} className="w-full bg-surface-secondary border border-border rounded-lg p-2 font-mono text-[11px] text-white focus:outline-none focus:border-brand" disabled={editing.builtin} placeholder="async def generate(ctx, api): ... # 末尾可追加 # PARAMS_SCHEMA: {...}"/>
                      ) : f.type==='custom_headers' ? (
                        <CustomHeadersEditor
                          headers={editing.headers || editing.custom_headers || {}}
                          onChange={h => setEditing({ ...editing, headers: h, custom_headers: h })}
                          disabled={editing.builtin}
                        />
                      ) : f.type==='json' ? (
                        <textarea value={display} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} rows={4} className="w-full bg-surface-secondary border border-border rounded-lg p-2 font-mono text-[11px] text-white focus:outline-none focus:border-brand" disabled={editing.builtin}/>
                      ) : f.type==='select' ? (
                        <select value={val||''} onChange={e=> setEditing({...editing, [f.k]: e.target.value})} className="w-full bg-surface-secondary border border-border rounded-lg px-2 py-1.5 text-xs text-white" disabled={editing.builtin}>
                          {f.opts?.map((o:string)=> <option key={o} value={o}>{o}</option>
                          )}
                        </select>
                      ) : f.type==='caps' ? (
                        <div className="flex flex-wrap gap-1.5 p-2 rounded-lg bg-surface-secondary border border-border">
                          {!(CAPABILITIES_BY_KIND[editing.kind] || []).length && <span className="text-[11px] text-gray-500">该类型暂无能力选项</span>}
                          {(CAPABILITIES_BY_KIND[editing.kind] || []).map(o=> {
                            const cur: string[] = Array.isArray(editing.capabilities) ? editing.capabilities : [];
                            const on = cur.includes(o.id);
                            return (
                              <button key={o.id} disabled={editing.builtin} title={o.desc} onClick={()=> setEditing({...editing, capabilities: on ? cur.filter(c=>c!==o.id) : [...cur, o.id]})} className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all ${on ? 'bg-brand/20 border-brand text-white' : 'bg-surface-secondary border-border text-gray-400 hover:text-white'}`}>{o.label}</button>
                            );
                          })}
                          {!editing.builtin && Array.isArray(editing.capabilities) && editing.capabilities.length > 0 && <button onClick={()=> setEditing({...editing, capabilities: []})} className="px-2 py-1 text-[11px] text-gray-500 hover:text-white underline">清空（改自动推断）</button>}
                        </div>
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
                <button onClick={closeEdit} className="px-4 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white">取消</button>
                {!editing.builtin && <button onClick={handleSaveEdit} className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1"><Save className="w-3.5 h-3.5"/> 保存</button>}
              </div>
            </div>
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="absolute inset-0 bg-surface/85 backdrop-blur-sm flex items-center justify-center p-4">
            <CreateForm onClose={()=> setShowCreate(false)} onCreated={()=> { setShowCreate(false); fetchAll(); window.dispatchEvent(new Event('provider-list-refresh')); }} />
          </div>
        )}
      </div>
    </div>
  );
};

const CreateForm: React.FC<{onClose:()=>void, onCreated:()=>void}> = ({ onClose, onCreated })=>{
  const [form, setForm] = useState<any>({ name:'', kind:'image', language:'python', code:'', description:'', models:'', default_model:'', capabilities: [] });
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [tplBusy, setTplBusy] = useState(false);
  const toggleCap = (id: string)=>{
    const cur: string[] = Array.isArray(form.capabilities) ? form.capabilities : [];
    setForm({ ...form, capabilities: cur.includes(id) ? cur.filter(c=>c!==id) : [...cur, id] });
  };
  const loadTemplate = async ()=>{
    try {
      setTplBusy(true);
      const r = await apiService.getCodeTemplate(form.language, form.kind);
      setForm((f:any)=> ({ ...f, code: r.template || '' }));
    } catch(e:any){ alert(e?.message || '模板加载失败'); } finally { setTplBusy(false); }
  };
  const handleSubmit = async ()=>{
    try {
      if (!form.code || String(form.code).trim().length < 20) { alert('代码模式为唯一方式：请提供 python/javascript 携程源码（可点「加载模板」起步）'); return; }
      const payload: any = {
        name: form.name, kind: form.kind, language: form.language,
        code: form.code, description: form.description,
        capabilities: Array.isArray(form.capabilities) ? form.capabilities : [],
      };
      if (form.models) payload.models = String(form.models).split(',').map((s:string)=>s.trim()).filter(Boolean);
      if (form.default_model) payload.default_model = form.default_model;
      if (apiKey) payload.api_key = apiKey;
      if (Object.keys(headers).length > 0) payload.headers = headers;
      await apiService.createProvider(payload);
      onCreated();
    } catch(e:any){ alert(e.message); }
  };
  return (
    <div className="w-full max-w-xl bg-surface rounded-2xl border border-border p-4 space-y-3 max-h-[85vh] overflow-y-auto">
      <div className="flex items-center justify-between"><span className="text-sm font-bold text-white">新建自定义源 · 代码模式</span><button onClick={onClose}><X className="w-4 h-4 text-gray-400"/></button></div>
      <input value={form.name} onChange={e=> setForm({...form, name:e.target.value})} placeholder="名称，如 我的FLUX" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500"/>
      <select value={form.kind} onChange={e=> setForm({...form, kind:e.target.value, capabilities: []})} className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white">
        <option value="image">生图 image</option><option value="video">视频 video</option><option value="audio">语音 audio</option>
      </select>
      <div>
        <div className="text-[11px] text-gray-400 mb-1.5">能力细分（多选；不选=按插槽自动推断：{(CAPABILITIES_BY_KIND[form.kind] || []).map(o=>o.label).join(' / ') || '—'}）</div>
        <div className="flex flex-wrap gap-1.5">
          {(CAPABILITIES_BY_KIND[form.kind] || []).map(o=> {
            const on = (form.capabilities || []).includes(o.id);
            return <button key={o.id} type="button" title={o.desc} onClick={()=> toggleCap(o.id)} className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all ${on ? 'bg-brand/20 border-brand text-white' : 'bg-surface-secondary border-border text-gray-400 hover:text-white'}`}>{o.label}</button>;
          })}
        </div>
      </div>
      <textarea value={form.description} onChange={e=> setForm({...form, description:e.target.value})} placeholder="描述" rows={2} className="w-full bg-surface-secondary border border-border rounded-lg p-2 text-xs text-white"/>
      <div className="space-y-1">
        <label className="text-[11px] font-semibold text-gray-300">自定义请求头 (Custom Headers / OpenCode 规范)</label>
        <CustomHeadersEditor headers={headers} onChange={setHeaders} />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-300">代码（异步携程 async def generate(ctx, api)）</span>
          <select value={form.language} onChange={e=> setForm({...form, language:e.target.value})} className="ml-auto bg-surface-secondary border border-border rounded-lg px-2 py-1 text-[11px] text-white">
            <option value="python">python</option><option value="javascript">javascript</option>
          </select>
          <button type="button" onClick={loadTemplate} disabled={tplBusy} className="px-2.5 py-1 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white disabled:opacity-40">{tplBusy ? '加载中…' : '加载模板'}</button>
        </div>
        <textarea value={form.code} onChange={e=> setForm({...form, code:e.target.value})} rows={10} placeholder="async def generate(ctx, api): ...  # 末尾可追加 # PARAMS_SCHEMA: {...}" className="w-full bg-surface-secondary border border-border rounded-lg p-2 font-mono text-[11px] text-white placeholder-gray-500 focus:outline-none focus:border-brand"/>
      </div>
      <input value={form.models} onChange={e=> setForm({...form, models:e.target.value})} placeholder="models 逗号分隔，可空" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white"/>
      <input value={form.default_model} onChange={e=> setForm({...form, default_model:e.target.value})} placeholder="default_model，可空" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white"/>
      <input value={apiKey} onChange={e=> setApiKey(e.target.value)} placeholder="API Key（可选）" className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-xs text-white font-mono"/>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-surface-secondary border border-border text-xs text-white">取消</button>
        <button onClick={handleSubmit} className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-bold">创建</button>
      </div>
    </div>
  );
};
