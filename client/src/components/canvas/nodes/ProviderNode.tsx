import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Plug, Cpu, Globe, Mic, Video, Settings, Activity, Trash2, Edit3, Plus, Zap, Key } from 'lucide-react';
import { apiService } from '../../../services/api';
import { confirmAsync, toast } from '../../../stores/useDialogStore';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

type ProviderKind = 'image' | 'video' | 'audio' | 'llm';

export const ProviderNode: React.FC<NodeProps> = ({ data, id, type }) => {
  const d: any = data;
  const nodeKind: ProviderKind = (d.kind as ProviderKind) || (type === 'provider-video' ? 'video' : type === 'provider-audio' ? 'audio' : 'image');
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string>(d.provider_id || d.providerId || '');
  const [selectedDef, setSelectedDef] = useState<any>(d.definition || null);
  const [model, setModel] = useState<string>(d.model || d.default_model || '');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, any>>(d.default_params || d.params || selectedDef?.default_params || {});
  const [showParams, setShowParams] = useState(true);
  const [savingParams, setSavingParams] = useState(false);

  const fetchProviders = async () => {
    try {
      const res = await fetch(`${API_ORIGIN || ''}/api/v1/providers?kind=${nodeKind}&include_builtin=true`).then(r=>r.json()).catch(()=>null);
      if (res?.providers) {
        setProviders(res.providers);
        if (selectedId) {
          const found = res.providers.find((p:any)=> p.id===selectedId);
          if (found) setSelectedDef(found);
        }
        return;
      }
      // fallback to apiService providers? use image providers
      const alt = await apiService.listImageProviders().catch(()=>null);
      if (alt?.providers) {
        // 生产端只显示已验证源
        const filtered = alt.providers.filter((p:any)=> p.production_ready === true);
        setProviders(filtered);
      }
    } catch {}
  };

  useEffect(()=> { fetchProviders(); }, [nodeKind]);

  useEffect(()=> {
    if (selectedId) {
      const found = providers.find(p=> p.id===selectedId);
      if (found) {
        setSelectedDef(found);
        if (found.default_model && !model) setModel(found.default_model);
        if (found.models && found.models.length && !model) setModel(found.models[0]);
        if (found.default_params) setParamValues(found.default_params);
      } else if (!selectedDef) {
        // fetch single
        fetch(`${API_ORIGIN || ''}/api/v1/providers/${selectedId}`).then(r=>r.json()).then(r=>{
          if (r.provider) {
            setSelectedDef(r.provider);
            if (r.provider.default_params) setParamValues(r.provider.default_params);
          }
        }).catch(()=>{});
      }
    }
  }, [selectedId, providers]);

  // 同步选中定义的默认参数到本地状态，并透传至画布节点
  useEffect(()=>{
    if (selectedDef) {
      const dp = selectedDef.default_params || {};
      setParamValues(dp);
      // 透传至节点，供下游消费
      (d.onUpdate as any)?.(id, { definition: selectedDef, default_params: dp, params: dp, provider_id: selectedDef.id, kind: selectedDef.kind || nodeKind });
    }
  }, [selectedDef]);

  const handleSelect = (pid: string) => {
    setSelectedId(pid);
    const found = providers.find(p=> p.id===pid);
    setSelectedDef(found || null);
    const m = found?.default_model || found?.models?.[0] || '';
    setModel(m);
    (d.onUpdate as any)?.(id, { provider_id: pid, provider: pid, kind: nodeKind, definition: found, model: m });
  };

  const handleModelChange = (m: string) => {
    setModel(m);
    (d.onUpdate as any)?.(id, { model: m, provider_id: selectedId, kind: nodeKind });
  };

  const handleTest = async () => {
    if (!selectedId) return;
    setTesting(true);
    try {
      const res = await fetch(`${API_ORIGIN || ''}/api/v1/providers/${selectedId}/test`, { method: 'POST' }).then(r=>r.json());
      setHealth(res);
      if (res.ok) alert(`✓ 连通正常`);
      else alert(`✗ 检测结果: ${res.detail || JSON.stringify(res)}`);
    } catch(e:any){ alert(e.message); } finally { setTesting(false); }
  };

  const handleSaveKey = async () => {
    if (!selectedId || !apiKeyInput.trim()) { alert('请输入 API Key'); return; }
    try {
      const res = await fetch(`${API_ORIGIN || ''}/api/v1/providers/${selectedId}/api-key`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ api_key: apiKeyInput.trim() })
      }).then(r=>r.json());
      if (res.status==='success' || res.has_key) {
        alert('✓ API Key 已保存');
        setApiKeyInput('');
      } else alert(JSON.stringify(res));
    } catch(e:any){ alert(e.message); }
  };

  const kindMeta = {
    image: { label: '生图源', icon: Globe, color: 'text-violet-400', border: 'border-violet-500/30', bg: 'from-violet-600/20 to-brand/20' },
    video: { label: '视频源', icon: Video, color: 'text-orange-400', border: 'border-orange-500/30', bg: 'from-orange-500/20 to-red-500/20' },
    audio: { label: '语音源', icon: Mic, color: 'text-pink-400', border: 'border-pink-500/30', bg: 'from-pink-500/20 to-violet-500/20' },
    llm: { label: 'LLM源', icon: Cpu, color: 'text-cyan-400', border: 'border-cyan-500/30', bg: 'from-cyan-500/20 to-blue-500/20' },
  }[nodeKind] || { label: '生成源', icon: Plug, color: 'text-brand', border: 'border-brand/30', bg: 'from-brand/20 to-violet-500/20' };

  const Icon = kindMeta.icon;
  const isBuiltin = selectedDef?.builtin;

  // 动态 I/O：基于 input_schema/output_schema 的 x-handle（支持多图/多音）
  const inputProps = selectedDef?.input_schema?.properties || {};
  const outputProps = selectedDef?.output_schema?.properties || {};
  const dynamicInputs = Object.entries(inputProps).filter(([, def]: any)=> {
    const h = (def as any)['x-handle'];
    if (h && ['image','images','reference_images','audio','audios','reference_audios','video','videos','reference_videos','text','prompt'].includes(h)) return true;
    if ((def as any).type==='array' && (def as any).items?.format==='uri') return true;
    if ((def as any).format==='uri' && ['image','audio','video'].some(k=> (def as any).description?.toLowerCase().includes(k))) return true;
    if ((def as any).type==='string' && (def as any)['x-handle']==='text') return true;
    return !!(def as any)['x-handle'];
  });
  const dynamicOutputs = Object.entries(outputProps).filter(([, def]: any)=> !!(def as any)['x-handle'] || (def as any).format==='uri');
  const getHandleColor = (key:string, def:any)=>{
    const h = (def as any)['x-handle'] || '';
    if(['image','images','reference_images'].includes(h) || (h==='' && key.includes('image'))) return '!bg-violet-500 !border-surface';
    if(['video','videos','reference_videos'].includes(h) || key.includes('video')) return '!bg-orange-500 !border-surface';
    if(['audio','audios','reference_audios'].includes(h) || key.includes('audio')) return '!bg-pink-500 !border-surface';
    return '!bg-sky-500 !border-surface';
  };

  return (
    <div className={`w-[340px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden`}>
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><Icon className={`w-3.5 h-3.5 ${kindMeta.color}`}/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">{kindMeta.label}节点</span>
        {selectedDef && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-main)] truncate max-w-[110px] border border-border">{selectedDef.display_name || selectedDef.name || selectedId}</span>}
        <span className="ml-auto flex items-center gap-1">
          {selectedDef && <span className={`w-2 h-2 rounded-full ${selectedDef.enabled===false ? 'bg-zinc-500' : health?.ok ? 'bg-emerald-500' : selectedDef.builtin ? 'bg-violet-500' : 'bg-amber-500'} animate-pulse`} title={health?.detail || (selectedDef.builtin?'内置':'自定义')}/>}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-muted)] border border-border">{selectedDef?.builtin ? '内置' : selectedDef ? '自定义' : '未绑定'}</span>
        </span>
      </div>

      {/* 输入：左侧数据流 */}
      {dynamicInputs.length>0 ? dynamicInputs.map(([key, def]:any, idx:number)=> (
        <Handle key={`in-${key}`} type="target" position={Position.Left} id={key} className={`!w-3 !h-3 !border-2 !border-surface ${getHandleColor(key, def)}`} style={{ top: `${18 + idx*14}%` }} title={`${key} (${(def as any)['x-handle']|| (def as any).type})`} />
      )) : (
        <Handle type="target" position={Position.Left} id="prompt" className={`!w-3 !h-3 !border-2 !border-surface ${nodeKind==='image'?'!bg-sky-500': nodeKind==='video'?'!bg-sky-500':'!bg-pink-500'}`} style={{ top: '28%' }} title="prompt (text)" />
      )}
      {/* 输出：右侧数据流 */}
      {dynamicOutputs.length>0 ? dynamicOutputs.map(([key, def]:any, idx:number)=> (
        <Handle key={`out-${key}`} type="source" position={Position.Right} id={key} className={`!w-3 !h-3 !border-2 !border-surface ${getHandleColor(key, def)}`} style={{ top: `${28 + idx*14}%` }} title={`${key} (${(def as any)['x-handle']})`} />
      )) : (
        <Handle type="source" position={Position.Right} id={nodeKind==='image'?'image': nodeKind==='video'?'video': nodeKind==='audio'?'audio':'output'} className={`!w-3 !h-3 ${nodeKind==='image' ? '!bg-violet-500' : nodeKind==='video' ? '!bg-orange-500' : '!bg-pink-500'} !border-2 !border-surface`} style={{ top: '28%' }} />
      )}
      {/* 配置输出：底部 provider 供下游注入 */}
      <Handle type="source" position={Position.Bottom} id="provider" className={`!w-3 !h-3 ${nodeKind==='image' ? '!bg-violet-500' : nodeKind==='video' ? '!bg-orange-500' : '!bg-pink-500'} !border-2 !border-surface`} />
      {/* 隐藏兼容 */}
      <Handle type="target" position={Position.Top} id="config" className="!bg-transparent !w-1 !h-1 !border-0" />

      <div className="p-3 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold [color:var(--color-text-main)]">选择生成源</span>
            <button onClick={fetchProviders} className="text-[10px] text-brand hover:underline font-medium">刷新</button>
          </div>
          <select value={selectedId} onChange={e=>handleSelect(e.target.value)} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-2 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
            <option value="">— 请选择 —</option>
            {providers.map((p:any)=> (
              <option key={p.id} value={p.id}>{p.display_name || p.name || p.id} {p.builtin ? '· 内置' : '· 自定义'} {p.kind ? `· ${p.kind}`: ''}</option>
            ))}
          </select>
          {providers.length===0 && <div className="text-[10px] [color:var(--color-text-muted)] text-center py-1">暂无可用源，内置源加载中或请创建</div>}
        </div>

        {selectedDef && (
          <div className="rounded-xl bg-surface-secondary/50 border border-border p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold [color:var(--color-text-main)] truncate">{selectedDef.display_name || selectedDef.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border [color:var(--color-text-muted)] font-mono">{selectedDef.id}</span>
            </div>
            {selectedDef.description && <div className="text-[11px] [color:var(--color-text-muted)] line-clamp-2">{selectedDef.description}</div>}
            <div className="flex items-center gap-1.5 text-[10px] [color:var(--color-text-muted)]">
              <span>类型</span><span className="px-1.5 py-0.5 rounded bg-surface border border-border [color:var(--color-text-secondary)]">{selectedDef.kind || nodeKind}</span>
              <span className="ml-auto">来源</span><span className="px-1.5 py-0.5 rounded bg-surface border border-border [color:var(--color-text-secondary)]">{selectedDef.provider_type || (selectedDef.builtin?'builtin':'http')}</span>
            </div>
            {selectedDef.transport?.url && <div className="text-[10px] font-mono [color:var(--color-text-muted)] truncate" title={selectedDef.transport.url}>URL: {selectedDef.transport.url}</div>}
            {/* Model 选择 */}
            <div className="space-y-1">
              <span className="text-[11px] font-medium [color:var(--color-text-main)]">模型</span>
              {selectedDef.models?.length ? (
                <select value={model} onChange={e=>handleModelChange(e.target.value)} className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
                  {selectedDef.models.map((m:string)=> <option key={m} value={m}>{m}</option>)}
                  {model && !selectedDef.models.includes(model) && <option value={model}>{model} (自定义)</option>}
                  <option value="__custom__">— 手动输入 —</option>
                </select>
              ) : (
                <input value={model} onChange={e=>handleModelChange(e.target.value)} placeholder={selectedDef.default_model || "输入模型名，如 FLUX.1-schnell"} className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
              )}
            </div>
            {/* 参数配置 */}
            {selectedDef.params_schema?.properties && Object.keys(selectedDef.params_schema.properties).length>0 && (
              <div className="space-y-2 rounded-lg bg-surface border border-border p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold [color:var(--color-text-main)] flex items-center gap-1"><Settings className="w-3 h-3 text-brand"/> 参数</span>
                  <button onClick={()=>setShowParams(v=>!v)} className="text-[10px] text-brand hover:underline font-medium">{showParams?'收起':'展开'}</button>
                </div>
                {showParams && (
                  <div className="space-y-2">
                    {Object.entries(selectedDef.params_schema.properties as Record<string, any>).map(([pname, pdef]: any)=>{
                      const val = paramValues[pname] ?? selectedDef.default_params?.[pname] ?? pdef.default ?? "";
                      const isNumber = pdef.type==='integer' || pdef.type==='number';
                      return (
                        <div key={pname} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] [color:var(--color-text-main)] font-medium">{pname}</span>
                            <span className="text-[10px] [color:var(--color-text-muted)] truncate max-w-[120px]" title={pdef.description}>{pdef.description || pdef.type}</span>
                          </div>
                          {isNumber ? (
                            <input type="number" value={val} onChange={e=>{
                              const v = pdef.type==='integer' ? parseInt(e.target.value)||0 : parseFloat(e.target.value)||0;
                              const next = {...paramValues, [pname]: v};
                              setParamValues(next);
                              (d.onUpdate as any)?.(id, { default_params: next, params: next });
                            }} className="w-full bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand"/>
                          ) : (
                            <input type="text" value={val} onChange={e=>{
                              const next = {...paramValues, [pname]: e.target.value};
                              setParamValues(next);
                              (d.onUpdate as any)?.(id, { default_params: next, params: next });
                            }} placeholder={pdef.description || `输入 ${pname}`} className="w-full bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"/>
                          )}
                        </div>
                      );
                    })}
                    <button
                      onClick={async()=>{
                        if (!selectedId) return;
                        setSavingParams(true);
                        try {
                          const res = await fetch(`${API_ORIGIN || ''}/api/v1/providers/${selectedId}`, {
                            method: 'PUT',
                            headers: {'Content-Type':'application/json'},
                            body: JSON.stringify({ default_params: paramValues, default_model: model })
                          }).then(r=>r.json());
                          if (res.status==='success' || res.provider) {
                            alert('✓ 参数已保存');
                            setSelectedDef(res.provider || {...selectedDef, default_params: paramValues, default_model: model});
                            (d.onUpdate as any)?.(id, { default_params: paramValues, params: paramValues, model });
                          } else alert('保存失败: '+JSON.stringify(res).slice(0,300));
                        } catch(e:any){ alert(e.message); } finally { setSavingParams(false); }
                      }}
                      disabled={savingParams || isBuiltin}
                      className="w-full py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-40 hover:bg-brand-light shadow-sm"
                    >
                      {savingParams?'保存中...':'保存参数到 Provider'}
                    </button>
                    {isBuiltin && <div className="text-[10px] text-amber-500 text-center">内置源参数仅本地生效（连线时透传），如需持久化请复制为自定义源</div>}
                  </div>
                )}
              </div>
            )}
            {/* API Key 快捷设置 */}
            {!isBuiltin && (
              <div className="space-y-1">
                <span className="text-[11px] font-medium [color:var(--color-text-main)] flex items-center gap-1"><Key className="w-3 h-3 text-brand"/> API Key</span>
                <div className="flex gap-1.5">
                  <input type={showKey?'text':'password'} value={apiKeyInput} onChange={e=>setApiKeyInput(e.target.value)} placeholder={selectedDef.auth?.has_key ? '已配置（输入新 Key 覆盖）' : '输入 API Key'} className="flex-1 bg-surface border border-border rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
                  <button onClick={()=>setShowKey(v=>!v)} className="px-2 py-1 rounded-lg bg-surface border border-border text-[11px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)]">{showKey?'隐藏':'显示'}</button>
                </div>
                <button onClick={handleSaveKey} className="w-full py-1.5 rounded-lg bg-brand/10 border border-brand/20 text-brand text-xs font-semibold hover:bg-brand/20">保存 Key</button>
              </div>
            )}
            <div className="flex gap-1.5">
              <button onClick={handleTest} disabled={testing || !selectedId} className="flex-1 py-1.5 rounded-lg bg-surface border border-border text-xs [color:var(--color-text-main)] flex items-center justify-center gap-1 disabled:opacity-40 hover:bg-surface-secondary"><Activity className="w-3 h-3 text-brand"/>{testing?'检测中…':'测试连通'}</button>
              {!isBuiltin && <button onClick={async ()=>{
                const ok = await confirmAsync({
                  title: '删除生成源',
                  message: `确定要删除生成源 ${selectedId} 吗？`,
                  isDanger: true,
                  confirmText: '确认删除',
                  cancelText: '取消'
                });
                if(!ok) return;
                fetch(`${API_ORIGIN || ''}/api/v1/providers/${selectedId}`, {method:'DELETE'}).then(r=>r.json()).then(r=>{
                  if(r.status==='deleted'){ 
                    toast.success(`生成源 ${selectedId} 已删除`); 
                    setSelectedId(''); 
                    setSelectedDef(null); 
                    fetchProviders(); 
                    (d.onUpdate as any)?.(id, {provider_id:'', definition:null}); 
                  } else {
                    toast.error(JSON.stringify(r));
                  }
                }).catch(e=>toast.error(e.message || '删除失败'));
              }} className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 flex items-center gap-1 text-xs hover:bg-red-500/20"><Trash2 className="w-3 h-3"/>删</button>}
            </div>
            {health && <div className={`text-[11px] px-2 py-1 rounded-lg border font-medium ${health.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'}`}>{health.detail || (health.ok?'正常':'异常')}</div>}
          </div>
        )}

        {/* 快捷创建入口 */}
        <div className="rounded-xl border border-dashed border-brand/30 bg-brand/5 p-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-brand"><Plus className="w-3 h-3"/> 扩展新生成源</div>
          <div className="text-[11px] [color:var(--color-text-muted)] leading-relaxed">粘贴 API 文档/cURL/OpenAPI，让导演自动接入。或手动创建。</div>
          <div className="flex gap-1.5">
            <button onClick={()=> setShowCreate(v=>!v)} className="flex-1 py-1.5 rounded-lg bg-brand text-white text-xs font-semibold hover:bg-brand-light shadow-sm">{showCreate?'收起':'新建Provider'}</button>
            <button onClick={()=> {
              window.dispatchEvent(new CustomEvent('open-provider-create', {detail:{kind: nodeKind}}));
              alert('可在右侧 Agent 输入框粘贴 API 文档，例如：\n“帮我接入这个生图 API：https://... 文档：... Key是...”\n导演将自动调用 register_custom_provider');
            }} className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs [color:var(--color-text-main)] hover:bg-surface-secondary">让导演接入</button>
          </div>
          {showCreate && (
            <div className="space-y-2 pt-2 border-t border-brand/20">
              <input id={`prov-name-${id}`} placeholder="名称，如 我的FLUX" className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"/>
              <input id={`prov-url-${id}`} placeholder="API URL https://api.xxx.com/v1/images/generations" className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
              <select id={`prov-auth-${id}`} className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
                <option value="bearer">Bearer (Authorization: Bearer)</option>
                <option value="apikey_header">Header (X-API-Key)</option>
                <option value="apikey_query">Query (api_key)</option>
                <option value="none">无鉴权</option>
              </select>
              <input id={`prov-key-${id}`} placeholder="API Key (可选)" className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
              <button onClick={async()=>{
                const name = (document.getElementById(`prov-name-${id}`) as HTMLInputElement)?.value?.trim() || `自定义${nodeKind}源`;
                const url = (document.getElementById(`prov-url-${id}`) as HTMLInputElement)?.value?.trim();
                const authType = (document.getElementById(`prov-auth-${id}`) as HTMLSelectElement)?.value || 'bearer';
                const key = (document.getElementById(`prov-key-${id}`) as HTMLInputElement)?.value?.trim();
                if(!url){ alert('请填写 API URL'); return; }
                try{
                  const body:any = {
                    name, kind: nodeKind, provider_type: 'http',
                    transport: { method: 'POST', url, headers: {'Content-Type':'application/json'}, timeout: 60 },
                    auth: { type: authType, header_name: authType==='apikey_header' ? 'X-API-Key' : 'Authorization', query_name: 'api_key', prefix: 'Bearer ' },
                    mapping: { request_template: { model: '{model}', prompt: '{prompt}', size: '{size}', seed: '{seed}' }, response_mappings: { image_url: 'data[0].url' } },
                    models: [], description: '手动创建'
                  };
                  const res = await fetch(`${API_ORIGIN || ''}/api/v1/providers`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({...body, api_key: key || undefined})}).then(r=>r.json());
                  if(res.status==='success' || res.provider){
                    alert(`✓ 已创建 ${res.provider?.id || ''}`);
                    fetchProviders();
                    if(res.provider?.id) handleSelect(res.provider.id);
                  } else alert(`失败: ${JSON.stringify(res).slice(0,400)}`);
                }catch(e:any){ alert(e.message); }
              }} className="w-full py-2 rounded-lg bg-brand text-white text-xs font-bold hover:bg-brand-light shadow-sm">快速创建</button>
            </div>
          )}
        </div>

        <div className="text-[10px] [color:var(--color-text-muted)] text-center leading-relaxed">
          将本节点连线至 <span className="[color:var(--color-text-main)] font-medium">分镜卡/生图/视频/TTS</span> 的 <span className="text-brand font-medium">Provider 输入</span>，下游将使用此源生成
        </div>
      </div>
    </div>
  );
};

export const ProviderImageNode = ProviderNode;
export const ProviderVideoNode: React.FC<NodeProps> = (props) => <ProviderNode {...props} data={{...(props.data as any), kind:'video'}} />;
export const ProviderAudioNode: React.FC<NodeProps> = (props) => <ProviderNode {...props} data={{...(props.data as any), kind:'audio'}} />;
