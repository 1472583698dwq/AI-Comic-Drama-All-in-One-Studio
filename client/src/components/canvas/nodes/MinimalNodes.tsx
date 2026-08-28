import React, { useEffect, useState, useRef } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Type, Image as ImageIcon, Video as VideoIcon, Mic, Box, Download, Plus, Upload, Library, Sparkles, Play, Volume2, Settings, ChevronDown, FileText, Layers } from 'lucide-react';
import { apiService } from '../../../services/api';
import { useProjectStore } from '../../../stores/useProjectStore';
import { DynamicControl } from '../controls/DynamicControl';

const API_ORIGIN = typeof window !== 'undefined' && window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';
// 全局缓存，避免每个节点重复请求导致并发风暴
let _wfCache: any[] | null = null;
let _wfCacheTime = 0;
const getWorkflowsCached = async () => {
  if(_wfCache && Date.now() - _wfCacheTime < 15000) return _wfCache;
  try{
    const r = await apiService.listWorkflows('all');
    _wfCache = r.workflows||[];
    _wfCacheTime = Date.now();
    return _wfCache;
  } catch{ return []; }
};
let _provCache: Record<string, any[]> = {};
const getProvidersCached = async (kind:string) => {
  if(_provCache[kind] && Date.now() - (_provCache[kind] as any)._ts < 15000) return _provCache[kind];
  try{
    const r = await apiService.listProviders({ kind: kind as any, include_builtin:true });
    _provCache[kind] = r.providers||[];
    (_provCache[kind] as any)._ts = Date.now();
    return _provCache[kind];
  } catch{ return []; }
};

// 共用：请求在下游添加节点
function emitAddNext(sourceId: string, pos?: {x:number,y:number}) {
  window.dispatchEvent(new CustomEvent('canvas-add-next', { detail: { sourceId, pos } }));
}

// 共用：素材选择器弹窗
const AssetPicker: React.FC<{ onPick: (url:string)=>void, onClose:()=>void, kind?: 'image'|'video'|'audio'}> = ({ onPick, onClose, kind }) => {
  const [assets, setAssets] = useState<any[]>([]);
  const [q, setQ] = useState('');
  useEffect(()=> {
    apiService.listAssets({ limit: 24, q: q || undefined }).then(r=> setAssets(r.assets||[])).catch(()=>{});
  }, [q]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-[720px] max-h-[80vh] overflow-hidden shadow-2xl flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 flex items-center gap-2">
          <Library className="w-4 h-4 text-violet-500"/><span className="text-sm font-bold">选择素材</span>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜索素材…" className="ml-auto flex-1 max-w-[240px] bg-zinc-100 border border-zinc-200 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:border-violet-400"/>
          <button onClick={onClose} className="ml-2 w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center hover:bg-zinc-200">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-4 gap-3">
          {assets.map((a:any)=>{
            const url = a.thumb_url || a.file_url;
            const abs = url?.startsWith('/') ? API_ORIGIN+url : url;
            return (
              <button key={a.id} onClick={()=> { onPick(abs||url); onClose(); }} className="group border border-zinc-200 rounded-xl overflow-hidden hover:border-violet-400 hover:shadow-md text-left bg-white">
                <div className="aspect-square bg-zinc-50 flex items-center justify-center overflow-hidden">{abs ? <img src={abs} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform"/> : <ImageIcon className="w-6 h-6 text-zinc-300"/>}</div>
                <div className="p-2"><div className="text-xs font-medium truncate">{a.name}</div><div className="text-[10px] text-zinc-500">{a.category}</div></div>
              </button>
            );
          })}
          {assets.length===0 && <div className="col-span-4 text-center text-sm text-zinc-400 py-12">暂无素材</div>}
        </div>
      </div>
    </div>
  );
};

// 壳
const Shell: React.FC<{ icon: any, label: string, desc?: string, color: string, children: React.ReactNode, id:string, data:any, handles?: React.ReactNode }> = ({ icon:Icon, label, desc, color, children, id, data, handles }) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const h = (e:any)=> { if(menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false); };
    if(showMenu) document.addEventListener('mousedown', h);
    return ()=> document.removeEventListener('mousedown', h);
  }, [showMenu]);
  return (
    <div className="w-[360px] bg-white border border-zinc-200 rounded-[20px] shadow-[0_8px_24px_rgba(0,0,0,0.08)] overflow-visible relative group">
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-zinc-100">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${color} bg-zinc-50 border border-zinc-200`}><Icon className="w-3.5 h-3.5"/></div>
        <div><div className="text-[13px] font-bold text-zinc-900 leading-none">{label}</div>{desc && <div className="text-[11px] text-zinc-500 leading-none mt-0.5">{desc}</div>}</div>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-zinc-500">#{id.slice(-4)}</span>
      </div>
      {handles}
      <div className="p-3 space-y-3">
        {children}
      </div>
      {/* 右侧 + 添加下游 */}
      <button
        onClick={()=> setShowMenu(v=>!v)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white border border-zinc-300 shadow-md flex items-center justify-center hover:border-violet-400 hover:text-violet-600 hover:shadow-violet-100 transition-all z-20"
        title="添加下一步"
      >
        <Plus className="w-3.5 h-3.5"/>
      </button>
      {showMenu && (
        <div ref={menuRef} className="absolute -right-2 top-[52%] translate-x-full z-30 w-[180px] bg-white border border-zinc-200 rounded-2xl shadow-xl overflow-hidden py-1">
          <div className="px-3 py-1.5 text-[11px] font-semibold text-zinc-500">添加下一步</div>
          {[
            {type:'prompt', label:'提示词', icon:Type},
            {type:'image', label:'生成图片', icon:ImageIcon},
            {type:'video', label:'生成视频', icon:VideoIcon},
            {type:'audio', label:'生成音频', icon:Mic},
            {type:'director3d', label:'3D导演台', icon:Box},
            {type:'export', label:'导出', icon:Download},
          ].map(it=> (
            <button key={it.type} onClick={()=> { setShowMenu(false); window.dispatchEvent(new CustomEvent('canvas-add-node', { detail:{ sourceId:id, nextType: it.type }})); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-violet-50 text-zinc-700 text-sm">
              <it.icon className="w-3.5 h-3.5 text-zinc-400"/>{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// 1. 提示词节点
export const PromptNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [text, setText] = useState(d.prompt || d.text || '');
  useEffect(()=> { if(d.prompt && d.prompt!==text) setText(d.prompt); }, [d.prompt]);
  useEffect(()=> { if(d.text && d.text!==text) setText(d.text); }, [d.text]);
  const onChange = (v:string)=> { setText(v); (d.onUpdate as any)?.(id, { prompt: v, text: v }); };
  return (
    <Shell id={id} data={d} icon={Type} label="提示词" desc="描述画面/运动" color="text-sky-600">
      <Handle type="source" position={Position.Right} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white !right-[-6px]" />
      <Handle type="target" position={Position.Left} id="prompt_in" className="!bg-sky-500 !w-2 !h-2 !border-2 !border-white opacity-0" />
      <textarea value={text} onChange={e=>onChange(e.target.value)} placeholder="例如：赛博朋克少女站在雨夜霓虹街道，电影感，THE DAY..." rows={4} className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-violet-400 focus:bg-white resize-none leading-relaxed"/>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>{text.length} 字 · 将作为下游提示词输入</span>
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"/>
      </div>
    </Shell>
  );
};

// 2. 生成图片节点
export const ImageNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const { project } = useProjectStore();
  const [prompt, setPrompt] = useState(d.prompt || d.image_prompt || '');
  const [ref, setRef] = useState(d.reference || d.reference_image || d.first_frame || '');
  const [engine, setEngine] = useState(d.engine_type || 'auto'); // auto | provider | comfy
  const [providerId, setProviderId] = useState(d.provider || d.provider_id || '');
  const [workflowId, setWorkflowId] = useState(d.workflow_id || '');
  const [providers, setProviders] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(d.image_url || d.result_url || '');
  const [showPicker, setShowPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [dynamicInputs, setDynamicInputs] = useState(d.dynamic_inputs || {});
  const [exposed, setExposed] = useState<any[]>([]);
  const [providerSchema, setProviderSchema] = useState<any>(null);
  const [providerParams, setProviderParams] = useState<Record<string,any>>(d.provider_params || {});

  useEffect(()=> {
    getProvidersCached('image').then(r=> setProviders(r as any)).catch(()=>{});
  }, []);
  useEffect(()=>{
    if(engine==='comfy'){
      getWorkflowsCached().then(r=> setWorkflows(r as any)).catch(()=>{});
    }
  }, [engine]);

  useEffect(()=> {
    if(engine==='comfy' && workflowId){
      apiService.inspectWorkflow(workflowId).then(r=>{
        const ex = r?.data?.exposed_inputs || r?.exposed_inputs || [];
        setExposed(ex);
      }).catch(()=> setExposed([]));
    } else setExposed([]);
  }, [engine, workflowId]);

  // 上游注入（逐步执行：下游自动回填）
  useEffect(()=>{
    const upPrompt = d._upstream?.prompt || d._upstream?.text || d._upstream?.image_prompt;
    if(upPrompt && upPrompt!==prompt) setPrompt(upPrompt);
    const upImg = d._upstream?.image_url || d._upstream?.image || d._upstream?.file_url || d._upstream?.reference;
    if(upImg && upImg!==ref) setRef(upImg);
  }, [d._upstream]);
  // 下游传播后的直连字段同步
  useEffect(()=>{ if(d.prompt!==undefined && d.prompt!==prompt) setPrompt(d.prompt); }, [d.prompt]);
  useEffect(()=>{ if(d.reference!==undefined && d.reference!==ref) setRef(d.reference); }, [d.reference]);
  useEffect(()=>{ if((d.image_url||d.result_url) && (d.image_url||d.result_url)!==result) setResult(d.image_url||d.result_url); }, [d.image_url, d.result_url]);
  // 监听生成源新增后刷新下拉
  useEffect(()=>{
    const h=()=> apiService.listProviders({ kind:'image', include_builtin:true }).then(r=> setProviders(r.providers||[])).catch(()=>{});
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);
  useEffect(()=>{
    if(engine==='provider' && providerId){
      const p = providers.find((x:any)=> x.id===providerId);
      if(p?.params_schema?.properties){
        setProviderSchema(p.params_schema);
        // 初始化默认值
        const defaults: Record<string,any> = {};
        for(const [k,v] of Object.entries(p.params_schema.properties as any)){
          if(providerParams[k]===undefined && (v as any).default!==undefined) defaults[k]=(v as any).default;
        }
        if(Object.keys(defaults).length) setProviderParams(prev=> ({...defaults, ...prev}));
      } else if(providerId){
        apiService.getProvider(providerId).then(r=>{
          const s = r.provider?.params_schema || r.raw?.params_schema;
          if(s) setProviderSchema(s);
        }).catch(()=>{});
      }
    } else {
      setProviderSchema(null);
    }
  }, [engine, providerId, providers]);

  const persist = (patch:any)=> (d.onUpdate as any)?.(id, patch);
  const isReady = (engine!=='provider' || !!providerId) && (engine!=='comfy' || !!workflowId);

  const handleGenerate = async ()=>{
    if(!prompt.trim() && !providerParams.prompt && !Object.values(dynamicInputs).some(v=> typeof v==='string' && v.trim())){ /* 提示词可来自上游或独立控件，不强制 */ }
    setGenerating(true);
    try{
      const prov = engine==='provider' ? providerId : engine==='auto' ? undefined : undefined;
      const wf = engine==='comfy' ? workflowId : undefined;
      if(engine==='comfy' && !wf){ alert('请选择 ComfyUI 工作流'); setGenerating(false); return; }
      if(engine==='provider' && !prov){ alert('请选择生成源'); setGenerating(false); return; }
      // ComfyUI: 将参考图注入到首个暴露的 image 输入（img_*），否则用通用 reference_image
      let dyn = { ...dynamicInputs };
      if(engine==='comfy' && ref){
        const firstImg = exposed.find((ex:any)=> ex.type==='image');
        if(firstImg){
          const key = firstImg.id || firstImg.node_id;
          if(!dyn[key]) dyn[key] = ref;
        } else if(!dyn['reference_image'] && Object.keys(dyn).length===0){
          dyn['reference_image'] = ref;
        }
      } else if(ref && Object.keys(dyn).length===0){
        dyn = { reference_image: ref };
      }
      const hasDyn = Object.keys(dyn).length>0;
      const res = await apiService.generateShotImage({
        prompt,
        aspect_ratio: project?.aspect_ratio || '9:16',
        style_preset: project?.style_preset,
        provider: prov,
        workflow_id: wf,
        dynamic_inputs: hasDyn ? dyn : undefined,
        ...providerParams,
      } as any);
      // 兼容后端返回 prompt_id 轮询（ComfyUI 超时场景）
      let url = (res as any).image_url || (res as any).local_path;
      if(!url && (res as any).prompt_id){
        // 轮询 ComfyUI history（最多 90s）
        for(let i=0;i<45;i++){
          await new Promise(r=> setTimeout(r, 2000));
          try{
            // 通过再次查询工作流状态或直接重试生成（简化：等待后再次查询最近生成）
            // 此处简化为等待后端落盘后通过轮询 generated 目录（实际由后端 _poll_for_output 已处理，此分支仅兜底）
            break;
          }catch{}
        }
      }
      if(!url) throw new Error((res as any).detail || 'ComfyUI 未返回图像，请检查 ComfyUI 是否运行、工作流是否含 SaveImage 且 COMFYUI_SERVER_URL 配置正确');
      setResult(url);
      persist({ prompt, image_prompt: prompt, reference: ref, image_url: url, result_url: url, engine_type: engine, provider: prov, provider_id: prov, workflow_id: wf, dynamic_inputs: dyn });
    }catch(e:any){
      const msg = e?.message || String(e);
      if(msg.includes('ComfyUI')){
        alert(`ComfyUI 生成失败:\n${msg}\n\n请检查：\n1. ComfyUI 已启动 (http://127.0.0.1:8188)\n2. 工作流含 SaveImage/PreviewImage 且已导出为 API Format\n3. 参考图已正确上传`);
      } else {
        alert(msg);
      }
    } finally{ setGenerating(false); }
  };

  const absResult = result ? (result.startsWith('/')? API_ORIGIN+result : result) : '';
  const absRef = ref ? (ref.startsWith('/')? API_ORIGIN+ref : ref) : ref;

  return (
    <Shell id={id} data={d} icon={ImageIcon} label="生成图片" desc="文生图 / 垫图生成" color="text-violet-600">
      <Handle type="target" position={Position.Left} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white" style={{top:'28%'}}/>
      <Handle type="target" position={Position.Left} id="reference" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" style={{top:'54%'}}/>
      <Handle type="source" position={Position.Right} id="image" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white"/>
      {/* 提示词/参考图已移除：全部来自生成源内部（上游连线或独立控件），不再使用预制模板参数 */}
      {/* 参考图已移除：由上游连线或工作流/生成源独立控件提供 */}
      {/* 引擎选择 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between"><span className="text-xs font-medium text-zinc-700">内部操作</span><button onClick={()=> setShowAdvanced(v=>!v)} className="text-[11px] text-violet-600 flex items-center gap-1">{showAdvanced?'收起':'高级'}<ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced?'rotate-180':''}`}/></button></div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            {k:'auto', label:'自动'},
            {k:'provider', label:'API'},
            {k:'comfy', label:'ComfyUI'},
          ].map(o=>(
            <button key={o.k} onClick={()=>{setEngine(o.k); persist({engine_type:o.k});}} className={`py-1.5 rounded-xl text-xs font-medium border ${engine===o.k?'bg-violet-600 text-white border-violet-600 shadow':'bg-white text-zinc-700 border-zinc-200 hover:border-zinc-300'}`}>{o.label}</button>
          ))}
        </div>
        {engine==='provider' && (
          <select value={providerId} onChange={e=>{setProviderId(e.target.value); persist({provider:e.target.value, provider_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm text-zinc-900 focus:outline-none focus:border-violet-400">
            <option value="">选择生成源</option>
            {providers.map((p:any)=> <option key={p.id} value={p.id}>{p.display_name||p.name} · {p.kind}</option>)}
          </select>
        )}
        {engine==='provider' && providerSchema?.properties && (
          <div className="space-y-2 p-2.5 rounded-xl bg-violet-50/50 border border-violet-200">
            <div className="text-xs font-semibold text-violet-700">生成源独立参数</div>
            {Object.entries(providerSchema.properties as any).map(([pname, pdef]:any)=>{
              const spec: any = {
                id: pname,
                param_name: pname,
                label: (pdef as any).title || pname,
                type: (pdef as any).enum ? 'combo' : (pdef as any).type==='integer' || (pdef as any).type==='number' ? 'number' : (pdef as any).type==='boolean' ? 'boolean' : 'text',
                description: (pdef as any).description,
                options: (pdef as any).enum,
                default_value: (pdef as any).default,
                min: (pdef as any).minimum,
                max: (pdef as any).maximum,
              };
              return (
                <DynamicControl key={pname} spec={spec} value={providerParams[pname] ?? (pdef as any).default} onChange={v=>{
                  const n={...providerParams, [pname]: v};
                  setProviderParams(n);
                  persist({ provider_params: n });
                }} />
              );
            })}
          </div>
        )}
        {engine==='comfy' && (
          <select value={workflowId} onChange={e=>{setWorkflowId(e.target.value); persist({workflow_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm text-zinc-900">
            <option value="">选择 ComfyUI 工作流</option>
            {workflows.map((w:any)=> <option key={w.id} value={w.id}>{w.name||w.id} · {w.node_count}节点</option>)}
          </select>
        )}
        {engine==='comfy' && exposed.length>0 && (
          <div className="space-y-2 p-2.5 rounded-xl bg-zinc-50 border border-zinc-200">
            <div className="text-xs font-semibold text-zinc-700">工作流参数</div>
            {exposed.map((ex:any)=>{
              const key = ex.id||ex.node_id;
              const val = dynamicInputs[key];
              return (
                <DynamicControl key={key} spec={{
                  id: key,
                  node_id: ex.node_id,
                  param_name: ex.param_name,
                  label: ex.label || ex.param_name,
                  alias: (ex as any).alias || ex.label,
                  type: ex.type==='image' ? 'image' : ex.type==='number' ? 'number' : ex.type==='combo' ? 'combo' : ex.type==='boolean' ? 'boolean' : 'text',
                  required: ex.required,
                  default_value: ex.default_value,
                  description: ex.description,
                  options: ex.options,
                  min: ex.min,
                  max: ex.max,
                  step: ex.step,
                }} value={val ?? ex.default_value} onChange={v=>{ const n={...dynamicInputs, [key]: v}; setDynamicInputs(n); persist({dynamic_inputs:n}); }} onAliasChange={alias=>{
                  const newExposed = exposed.map((e:any)=> e.id===key ? {...e, label: alias, alias} : e);
                  setExposed(newExposed);
                  apiService.saveWorkflowOverrides(workflowId, { exposed_inputs: newExposed }).catch(()=>{});
                }} />
              );
            })}
          </div>
        )}
      </div>
      <div className={`text-[11px] px-2 py-1 rounded-full border text-center ${isReady ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{isReady ? '● 就绪 · 执行后自动流向下游' : '○ 待输入提示词/上游'}</div>
      {/* 结果 */}
      {absResult && <div className="rounded-xl overflow-hidden border border-zinc-200"><img src={absResult} alt="" className="w-full"/></div>}
      <button onClick={handleGenerate} disabled={generating} className="w-full py-2.5 rounded-xl bg-zinc-900 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-black disabled:opacity-40">
        {generating ? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</>: <><Sparkles className="w-4 h-4"/> 生成图片</>}
      </button>
      {showPicker && <AssetPicker onPick={(url)=>{setRef(url); persist({reference:url});}} onClose={()=>setShowPicker(false)} kind="image"/>}
    </Shell>
  );
};

// 3. 生成视频（独立控件 + ComfyUI 动态 + provider 独立参数）
export const VideoGenNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [prompt, setPrompt] = useState(d.prompt || d.video_prompt || '');
  const [firstFrame, setFirstFrame] = useState(d.first_frame || d.first_frame_url || d.image_url || '');
  const [engine, setEngine] = useState(d.engine_type || 'auto');
  const [providerId, setProviderId] = useState(d.provider || d.provider_id || '');
  const [workflowId, setWorkflowId] = useState(d.workflow_id || '');
  const [mode, setMode] = useState(d.mode || 'i2v');
  const [duration, setDuration] = useState(d.duration || 5);
  const [providers, setProviders] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState(d.video_url || '');
  const [showPicker, setShowPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [dynamicInputs, setDynamicInputs] = useState(d.dynamic_inputs || {});
  const [exposed, setExposed] = useState<any[]>([]);
  const [providerSchema, setProviderSchema] = useState<any>(null);
  const [providerParams, setProviderParams] = useState<Record<string,any>>(d.provider_params || {});

  useEffect(()=> {
    getProvidersCached('video').then(r=> setProviders(r as any)).catch(()=>{});
  }, []);
  useEffect(()=>{
    if(engine==='comfy'){
      getWorkflowsCached().then(r=> setWorkflows(r as any)).catch(()=>{});
    }
  }, [engine]);
  useEffect(()=>{
    if(engine==='comfy' && workflowId){
      apiService.inspectWorkflow(workflowId).then(r=>{
        const ex = r?.data?.exposed_inputs || r?.exposed_inputs || [];
        setExposed(ex);
      }).catch(()=> setExposed([]));
    } else setExposed([]);
  }, [engine, workflowId]);
  useEffect(()=>{
    const upPrompt = d._upstream?.prompt || d._upstream?.text;
    if(upPrompt && upPrompt!==prompt) setPrompt(upPrompt);
    const upImg = d._upstream?.image_url || d._upstream?.image || d._upstream?.file_url || d._upstream?.reference;
    if(upImg && upImg!==firstFrame) setFirstFrame(upImg);
  }, [d._upstream]);
  useEffect(()=>{ if(d.prompt!==undefined && d.prompt!==prompt) setPrompt(d.prompt); }, [d.prompt]);
  useEffect(()=>{ if((d.first_frame||d.first_frame_url||d.image_url) && (d.first_frame||d.first_frame_url||d.image_url)!==firstFrame) setFirstFrame(d.first_frame||d.first_frame_url||d.image_url); }, [d.first_frame, d.first_frame_url, d.image_url]);
  useEffect(()=>{ if(d.video_url && d.video_url!==videoUrl) setVideoUrl(d.video_url); }, [d.video_url]);
  useEffect(()=>{
    const h=()=> apiService.listProviders({ kind:'video', include_builtin:true }).then(r=> setProviders(r.providers||[])).catch(()=>{});
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);
  useEffect(()=>{
    if(engine==='provider' && providerId){
      const p = providers.find((x:any)=> x.id===providerId);
      if(p?.params_schema?.properties){
        setProviderSchema(p.params_schema);
        const defaults: Record<string,any> = {};
        for(const [k,v] of Object.entries(p.params_schema.properties as any)){
          if(providerParams[k]===undefined && (v as any).default!==undefined) defaults[k]=(v as any).default;
        }
        if(Object.keys(defaults).length) setProviderParams(prev=> ({...defaults, ...prev}));
      } else if(providerId){
        apiService.getProvider(providerId).then(r=>{
          const s = r.provider?.params_schema || r.raw?.params_schema;
          if(s) setProviderSchema(s);
        }).catch(()=>{});
      }
    } else {
      setProviderSchema(null);
    }
  }, [engine, providerId, providers]);

  const persist = (p:any)=> (d.onUpdate as any)?.(id, p);
  const isReady = (engine!=='provider' || !!providerId) && (engine!=='comfy' || !!workflowId);

  const handleGenerate = async ()=>{
    if(!prompt.trim() && !providerParams.prompt && !Object.values(dynamicInputs).some(v=> typeof v==='string' && v.trim())){ /* 运动描述可来自上游或独立控件 */ }
    if(mode==='i2v' && !firstFrame && !Object.values(dynamicInputs).some(v=> typeof v==='string' && v.startsWith('data:'))){ /* 首帧可来自上游或独立控件 */ }
    setGenerating(true);
    try{
      const prov = engine==='provider'? providerId : engine==='auto'? (providerId || undefined) : undefined;
      const wf = engine==='comfy'? workflowId : undefined;
      let dyn = { ...dynamicInputs };
      if(engine==='comfy' && firstFrame){
        const firstImg = exposed.find((ex:any)=> ex.type==='image');
        if(firstImg){
          const key = firstImg.id || firstImg.node_id;
          if(!dyn[key]) dyn[key] = firstFrame;
        }
      }
      const hasDyn = Object.keys(dyn).length>0;
      const res:any = await apiService.generateShotVideo({ prompt, mode: mode as any, first_frame_url: firstFrame || undefined, duration, provider: prov, workflow_id: wf, dynamic_inputs: hasDyn ? dyn : undefined, ...providerParams } as any);
      let url = res.video_url;
      if(!url && res.task_id){
        for(let i=0;i<120;i++){
          await new Promise(r=> setTimeout(r,3000));
          try{
            const st:any = await apiService.getVideoTaskStatus(res.task_id);
            const s=(st.status||'').toString().toUpperCase();
            if(s==="SUCCESS"||s==="COMPLETED"){ url=st.video_url||st.videoUrl||st.results?.[0]||""; if(url) break; }
            if(s==="FAILED"||s==="FAIL") throw new Error(st.error||"任务失败");
          }catch{}
        }
      }
      setVideoUrl(url);
      persist({ prompt, video_prompt:prompt, first_frame:firstFrame, first_frame_url:firstFrame, video_url:url, mode, duration, engine_type:engine, provider:prov, provider_id:prov, workflow_id:wf, dynamic_inputs: dyn, provider_params: providerParams });
    }catch(e:any){ alert(e.message); } finally{ setGenerating(false); }
  };

  const absFirst = firstFrame ? (firstFrame.startsWith('/')? API_ORIGIN+firstFrame : firstFrame) : '';
  const absVideo = videoUrl ? (videoUrl.startsWith('/')? API_ORIGIN+videoUrl : videoUrl) : '';

  return (
    <Shell id={id} data={d} icon={VideoIcon} label="生成视频" desc="I2V / R2V / T2V" color="text-orange-600">
      <Handle type="target" position={Position.Left} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white" style={{top:'28%'}}/>
      <Handle type="target" position={Position.Left} id="first_frame" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" style={{top:'52%'}}/>
      <Handle type="source" position={Position.Right} id="video" className="!bg-orange-500 !w-3 !h-3 !border-2 !border-white"/>
      {/* 运动描述已移除：由上游或生成源内部提供 */}
      {/* 首帧/参考已移除：由上游连线或独立控件提供 */}
      <div className="grid grid-cols-3 gap-1.5">
        {(['i2v','r2v','t2v'] as const).map(m=> <button key={m} onClick={()=>{setMode(m); persist({mode:m});}} className={`py-1.5 rounded-xl text-xs font-medium border ${mode===m?'bg-orange-500 text-white border-orange-500':'bg-white text-zinc-700 border-zinc-200'}`}>{m.toUpperCase()}</button>)}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between"><span className="text-xs font-medium text-zinc-700">内部操作</span><button onClick={()=> setShowAdvanced(v=>!v)} className="text-[11px] text-orange-600 flex items-center gap-1">{showAdvanced?'收起':'高级'}<ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced?'rotate-180':''}`}/></button></div>
        <div className="grid grid-cols-3 gap-1.5">
          {[{k:'auto',l:'自动'},{k:'provider',l:'API'},{k:'comfy',l:'ComfyUI'}].map(o=> <button key={o.k} onClick={()=>{setEngine(o.k); persist({engine_type:o.k});}} className={`py-1.5 rounded-xl text-xs border ${engine===o.k?'bg-zinc-900 text-white border-zinc-900':'bg-white border-zinc-200 text-zinc-700'}`}>{o.l}</button>)}
        </div>
        {engine==='provider' && <select value={providerId} onChange={e=>{setProviderId(e.target.value); persist({provider:e.target.value, provider_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm"><option value="">自动 / 选择视频源</option>{providers.map((p:any)=> <option key={p.id} value={p.id}>{p.display_name||p.name}</option>)}</select>}
        {engine==='provider' && providerSchema?.properties && (
          <div className="space-y-2 p-2.5 rounded-xl bg-orange-50/50 border border-orange-200">
            <div className="text-xs font-semibold text-orange-700">生成源独立参数</div>
            {Object.entries(providerSchema.properties as any).map(([pname, pdef]:any)=>{
              const spec: any = {
                id: pname,
                param_name: pname,
                label: (pdef as any).title || pname,
                type: (pdef as any).enum ? 'combo' : (pdef as any).type==='integer' || (pdef as any).type==='number' ? 'number' : (pdef as any).type==='boolean' ? 'boolean' : 'text',
                description: (pdef as any).description,
                options: (pdef as any).enum?.map((x:any)=> String(x)),
                default_value: (pdef as any).default,
                min: (pdef as any).minimum,
                max: (pdef as any).maximum,
                step: (pdef as any).step,
              };
              return (
                <DynamicControl key={pname} spec={spec} value={providerParams[pname] ?? (pdef as any).default} onChange={v=>{
                  const n={...providerParams, [pname]: v};
                  setProviderParams(n);
                  persist({ provider_params: n });
                  if(pname==='duration' && typeof v==='number'){ setDuration(v); persist({duration:v}); }
                }} />
              );
            })}
          </div>
        )}
        {engine==='comfy' && <select value={workflowId} onChange={e=>{setWorkflowId(e.target.value); persist({workflow_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm"><option value="">选择工作流</option>{workflows.map((w:any)=> <option key={w.id} value={w.id}>{w.name||w.id}</option>)}</select>}
        {engine==='comfy' && exposed.length>0 && (
          <div className="space-y-2 p-2.5 rounded-xl bg-zinc-50 border border-zinc-200">
            <div className="text-xs font-semibold text-zinc-700">工作流参数（独立控件 + 别名）</div>
            {exposed.map((ex:any)=>{
              const key = ex.id||ex.node_id;
              const val = dynamicInputs[key];
              return (
                <DynamicControl key={key} spec={{
                  id: key,
                  node_id: ex.node_id,
                  param_name: ex.param_name,
                  label: ex.label || ex.param_name,
                  alias: (ex as any).alias || ex.label,
                  type: ex.type==='image' ? 'image' : ex.type==='number' ? 'number' : ex.type==='combo' ? 'combo' : ex.type==='boolean' ? 'boolean' : 'text',
                  required: ex.required,
                  default_value: ex.default_value,
                  description: ex.description,
                  options: ex.options,
                  min: ex.min,
                  max: ex.max,
                  step: ex.step,
                }} value={val ?? ex.default_value} onChange={v=>{ const n={...dynamicInputs, [key]: v}; setDynamicInputs(n); persist({dynamic_inputs:n}); }} onAliasChange={alias=>{
                  const newExposed = exposed.map((e:any)=> e.id===key ? {...e, label: alias, alias} : e);
                  setExposed(newExposed);
                  apiService.saveWorkflowOverrides(workflowId, { exposed_inputs: newExposed }).catch(()=>{});
                }} />
              );
            })}
          </div>
        )}
      </div>
      {!showAdvanced && (
        {/* 时长已移除：由生成源独立控件提供 */}
      )}
      <div className={`text-[11px] px-2 py-1 rounded-full border text-center ${isReady ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{isReady ? '● 就绪 · 执行后自动流向下游' : '○ 待上游首帧/提示词'}</div>
      {absVideo && <video src={absVideo} controls className="w-full rounded-xl border border-zinc-200 max-h-[160px] bg-black"/>}
      <button onClick={handleGenerate} disabled={generating} className="w-full py-2.5 rounded-xl bg-zinc-900 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-black disabled:opacity-40">{generating? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</>: <><Play className="w-4 h-4"/> 生成视频</>}</button>
      {showPicker && <AssetPicker onPick={(url)=>{setFirstFrame(url); persist({first_frame:url, first_frame_url:url});}} onClose={()=> setShowPicker(false)} kind="image"/>}
    </Shell>
  );
};

// 4. 生成音频（独立控件 + provider 独立参数）
export const AudioNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [text, setText] = useState(d.text || d.prompt || '');
  const [engine, setEngine] = useState(d.engine_type || 'auto');
  const [providerId, setProviderId] = useState(d.provider || d.provider_id || 'minimax');
  const [voiceId, setVoiceId] = useState(d.voice_id || 'male-qn-qingse');
  const [emotion, setEmotion] = useState(d.emotion || 'neutral');
  const [voices, setVoices] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState(d.audio_url || '');
  const [audioEl, setAudioEl] = useState<HTMLAudioElement|null>(null);
  const [providerSchema, setProviderSchema] = useState<any>(null);
  const [providerParams, setProviderParams] = useState<Record<string,any>>(d.provider_params || {});

  useEffect(()=>{
    apiService.listProviders({ kind:'audio', include_builtin:true }).then(r=> setProviders(r.providers||[])).catch(()=>{});
  }, []);
  useEffect(()=>{ apiService.listTtsVoices(providerId).then(r=> setVoices(r.voices||[])).catch(()=>{}); }, [providerId]);
  useEffect(()=>{
    const up = d._upstream?.prompt || d._upstream?.text || d._upstream?.dialogue;
    if(up && up!==text) setText(up);
  }, [d._upstream]);
  useEffect(()=>{ if(d.text!==undefined && d.text!==text) setText(d.text); }, [d.text]);
  useEffect(()=>{ if(d.prompt!==undefined && d.prompt!==text) setText(d.prompt); }, [d.prompt]);
  useEffect(()=>{ if(d.audio_url && d.audio_url!==audioUrl) setAudioUrl(d.audio_url); }, [d.audio_url]);
  useEffect(()=>{
    const h=()=> apiService.listProviders({ kind:'audio', include_builtin:true }).then(r=> setProviders(r.providers||[])).catch(()=>{});
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);
  useEffect(()=>{
    if(engine==='provider' && providerId){
      const p = providers.find((x:any)=> x.id===providerId);
      if(p?.params_schema?.properties){
        setProviderSchema(p.params_schema);
        const defaults: Record<string,any> = {};
        for(const [k,v] of Object.entries(p.params_schema.properties as any)){
          if(providerParams[k]===undefined && (v as any).default!==undefined) defaults[k]=(v as any).default;
        }
        if(Object.keys(defaults).length) setProviderParams(prev=> ({...defaults, ...prev}));
      } else if(providerId){
        apiService.getProvider(providerId).then(r=>{
          const s = r.provider?.params_schema || r.raw?.params_schema;
          if(s) setProviderSchema(s);
        }).catch(()=>{});
      }
    } else if(engine==='auto' && providerId){
      const p = providers.find((x:any)=> x.id===providerId);
      if(p?.params_schema?.properties) setProviderSchema(p.params_schema);
    } else {
      // auto 无独立 provider 时仍可展示通用 audio 参数（speed/pitch/volume）
      setProviderSchema(null);
    }
  }, [engine, providerId, providers]);

  const persist = (p:any)=> (d.onUpdate as any)?.(id, p);
  const isReady = true; // 文本可来自上游或独立控件
  const handleGenerate = async ()=>{
    if(!text.trim() && !providerParams.text && !providerParams.prompt){ /* 文本可来自上游 */ }
    setGenerating(true);
    try{
      const prov = engine==='auto'? undefined : providerId;
      const res = await apiService.generateTTS(text, voiceId, emotion, { provider: prov, ...providerParams });
      setAudioUrl(res.audio_url);
      persist({ text, prompt:text, audio_url: res.audio_url, voice_id: voiceId, emotion, provider: prov||providerId, provider_id: prov||providerId, engine_type: engine, provider_params: providerParams });
    }catch(e:any){ alert(e.message); } finally{ setGenerating(false); }
  };
  const handlePlay = ()=>{
    if(!audioUrl) return;
    if(audioEl){ audioEl.pause(); setAudioEl(null); return; }
    const url = audioUrl.startsWith('/')? API_ORIGIN+audioUrl : audioUrl;
    const a = new Audio(url); setAudioEl(a); a.onended=()=> setAudioEl(null); a.play().catch(()=>{});
  };
  return (
    <Shell id={id} data={d} icon={Mic} label="生成音频" desc="TTS 配音" color="text-pink-600">
      <Handle type="target" position={Position.Left} id="text" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white" style={{top:'30%'}}/>
      <Handle type="source" position={Position.Right} id="audio" className="!bg-pink-500 !w-3 !h-3 !border-2 !border-white"/>
      {/* 文本已移除：由上游连线或生成源内部提供 */}
      <div className="grid grid-cols-2 gap-1.5">
        {[{k:'auto',l:'自动'},{k:'provider',l:'API'}].map(o=> <button key={o.k} onClick={()=>{setEngine(o.k); persist({engine_type:o.k});}} className={`py-1.5 rounded-xl text-xs border ${engine===o.k?'bg-pink-500 text-white border-pink-500':'bg-white border-zinc-200 text-zinc-700'}`}>{o.l}</button>)}
      </div>
      <select value={providerId} onChange={e=>{setProviderId(e.target.value); persist({provider:e.target.value, provider_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm">
        {providers.length? providers.map((p:any)=><option key={p.id} value={p.id}>{p.display_name||p.name}</option>) : <><option value="minimax">MiniMax</option><option value="elevenlabs">ElevenLabs</option></>}
        {!providers.find(p=>p.id===providerId) && providerId && <option value={providerId}>{providerId}</option>}
      </select>
      <select value={voiceId} onChange={e=>{setVoiceId(e.target.value); persist({voice_id:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm">
        {voices.length? voices.map((v:any)=> <option key={v.voice_id||v.id} value={v.voice_id||v.id}>{v.voice_name||v.name||v.voice_id}</option>) : <option value={voiceId}>{voiceId}</option>}
      </select>
      <select value={emotion} onChange={e=>{setEmotion(e.target.value); persist({emotion:e.target.value});}} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm">
        <option value="neutral">平静</option><option value="intense">怒吼</option><option value="sorrow">悲痛</option><option value="excited">兴奋</option><option value="whispering">低语</option>
      </select>
      {providerSchema?.properties && (
        <div className="space-y-2 p-2.5 rounded-xl bg-pink-50/50 border border-pink-200">
          <div className="text-xs font-semibold text-pink-700">生成源独立参数</div>
          {Object.entries(providerSchema.properties as any).map(([pname, pdef]:any)=>{
            if(['speed','pitch','volume'].includes(pname) && false) return null;
            const spec: any = {
              id: pname,
              param_name: pname,
              label: (pdef as any).title || pname,
              type: (pdef as any).enum ? 'combo' : (pdef as any).type==='integer' || (pdef as any).type==='number' ? 'number' : (pdef as any).type==='boolean' ? 'boolean' : 'text',
              description: (pdef as any).description,
              options: (pdef as any).enum?.map((x:any)=> String(x)),
              default_value: (pdef as any).default,
              min: (pdef as any).minimum,
              max: (pdef as any).maximum,
              step: (pdef as any).step,
            };
            return (
              <DynamicControl key={pname} spec={spec} value={providerParams[pname] ?? (pdef as any).default} onChange={v=>{
                const n={...providerParams, [pname]: v};
                setProviderParams(n);
                persist({ provider_params: n });
              }} />
            );
          })}
        </div>
      )}
      <div className={`text-[11px] px-2 py-1 rounded-full border text-center ${isReady ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>{isReady ? '● 就绪 · 执行后自动流向下游' : '○ 待输入文本/上游'}</div>
      <button onClick={handleGenerate} disabled={generating} className="w-full py-2.5 rounded-xl bg-zinc-900 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-black disabled:opacity-40">{generating? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</>: <><Volume2 className="w-4 h-4"/> 生成配音</>}</button>
      {audioUrl && <button onClick={handlePlay} className="w-full py-2 rounded-xl bg-white border border-zinc-200 text-sm flex items-center justify-center gap-1.5 hover:bg-zinc-50"><Play className="w-3.5 h-3.5"/>{audioEl?'暂停':'试听'}</button>}
    </Shell>
  );
};

// 5. 3D导演台（轻量白卡）
export const Director3DMinimalNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [framing, setFraming] = useState(d.framing || 'medium');
  const [motion, setMotion] = useState(d.motion || 'push_in');
  const [focal, setFocal] = useState(d.focal_length_mm || 35);
  const persist = (p:any)=> (d.onUpdate as any)?.(id, p);
  return (
    <Shell id={id} data={d} icon={Box} label="3D导演台" desc="机位 / 运镜编排" color="text-amber-600">
      <Handle type="target" position={Position.Left} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white" style={{top:'30%'}}/>
      <Handle type="source" position={Position.Right} id="camera_prompt" className="!bg-amber-500 !w-3 !h-3 !border-2 !border-white"/>
      <div className="grid grid-cols-2 gap-1.5">
        <select value={framing} onChange={e=>{setFraming(e.target.value); persist({framing:e.target.value});}} className="bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm">
          <option value="extreme_close_up">大特写</option><option value="close_up">特写</option><option value="medium">中景</option><option value="full">全景</option><option value="long">远景</option><option value="bird_eye">鸟瞰</option><option value="low_angle">仰角</option>
        </select>
        <select value={motion} onChange={e=>{setMotion(e.target.value); persist({motion:e.target.value});}} className="bg-white border border-zinc-200 rounded-xl px-2.5 py-2 text-sm">
          <option value="static">固定</option><option value="push_in">推镜</option><option value="pull_out">拉镜</option><option value="orbit">环绕</option><option value="pan_left">左摇</option><option value="pan_right">右摇</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-700">焦距 {focal}mm<input type="range" min={16} max={135} value={focal} onChange={e=>{setFocal(Number(e.target.value)); persist({focal_length_mm:Number(e.target.value)});}} className="flex-1 accent-amber-500"/></label>
      <div className="rounded-xl bg-amber-50 border border-amber-200 p-2.5 font-mono text-xs text-amber-800 break-words">{d.minimax_camera_prompt || `[Camera: ${framing} · ${motion} · ${focal}mm]`}</div>
      <button onClick={()=> (d.onExecute as any)?.(id)} className="w-full py-2 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600">计算机位</button>
    </Shell>
  );
};

// 6. 导出节点
export const ExportNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [desc, setDesc] = useState(d.export_desc || '');
  const project = useProjectStore(s=> s.project);
  const pid = project?.id;
  const handleExport = async ()=>{
    if(!pid){ alert('请先在项目看板打开项目'); return; }
    // 收集上游 videos/audios
    const ups = (d._upstream || {}) as any;
    // 简易：提示前往漫剧制作导出
    const videos = ups.videos || (ups.video_url ? [ups.video_url] : []);
    const audios = ups.audios || (ups.audio_url ? [ups.audio_url] : []);
    try{
      // 若有工程数据则直接导出草稿
      const proj = (window as any).__lastProject || project;
      if(proj && (videos.length||audios.length)){
        const res = await apiService.exportJianYingDraft(proj);
        alert(`已导出剪映草稿：${res.draft_path||'完成'}  视频${videos.length} 音频${audios.length}`);
      } else {
        // 兜底：创建一个最小项目并导出
        await apiService.exportJianYingDraft({ id: pid, title: project?.title||'导出', scenes: [{ id:'s1', scene_index:1, title:'场景1', shots:[]}]} as any);
        alert('已触发导出，请在 漫剧制作→导出 查看');
      }
    }catch(e:any){ alert(e.message); }
  };
  return (
    <Shell id={id} data={d} icon={Download} label="导出" desc="成片 / 剪映草稿" color="text-emerald-600">
      <Handle type="target" position={Position.Left} id="video" className="!bg-orange-500 !w-3 !h-3 !border-2 !border-white" style={{top:'32%'}}/>
      <Handle type="target" position={Position.Left} id="audio" className="!bg-pink-500 !w-3 !h-3 !border-2 !border-white" style={{top:'58%'}}/>
      <textarea value={desc} onChange={e=>{setDesc(e.target.value); (d.onUpdate as any)?.(id,{export_desc:e.target.value});}} placeholder="导出备注（可选）" rows={2} className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-2.5 text-sm placeholder:text-zinc-400 focus:outline-none focus:border-emerald-300"/>
      <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-2.5 text-xs text-emerald-800 leading-relaxed">将自动聚合上游 <b>视频+音频</b> 生成剪映草稿，可携带时间线。若无视频，将导出项目结构。</div>
      <button onClick={handleExport} className="w-full py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-emerald-700"><Download className="w-4 h-4"/> 导出剪映草稿</button>
      <button onClick={()=> window.dispatchEvent(new CustomEvent('canvas-export-shots'))} className="w-full py-2 rounded-xl bg-white border border-zinc-200 text-sm font-medium hover:bg-zinc-50">导出为分镜到项目</button>
    </Shell>
  );
};
