import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Cpu, Settings, Image as ImageIcon, Type, Upload, Check } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const ComfyWorkflowNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string>(d.workflow_id || '');
  const [exposed, setExposed] = useState<any[]>([]);
  const [dynamicInputs, setDynamicInputs] = useState<Record<string, any>>(d.dynamic_inputs || {});
  const [inspectId, setInspectId] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState<string>(d.result_url || '');

  useEffect(() => {
    apiService.listWorkflows('all').then(r=> setWorkflows(r.workflows || [])).catch(()=>{});
  }, []);

  useEffect(() => {
    if (!selectedId) { setExposed([]); return; }
    apiService.inspectWorkflow(selectedId).then(r=>{
      const ex = r?.data?.exposed_inputs || r?.exposed_inputs || [];
      setExposed(ex);
      // 合并默认值
      const defaults: Record<string, any> = {};
      ex.forEach((e:any)=> { if(e.default_value!==undefined && dynamicInputs[e.id||e.node_id]==null) defaults[e.id||e.node_id]=e.default_value; });
      if(Object.keys(defaults).length) setDynamicInputs(prev=> ({...defaults, ...prev}));
    }).catch(()=> setExposed([]));
  }, [selectedId]);

  const handleSelect = (wfId: string) => {
    setSelectedId(wfId);
    (d.onUpdate as any)?.(id, { workflow_id: wfId });
  };

  const handleDynamicChange = (key: string, val: any) => {
    const next = { ...dynamicInputs, [key]: val };
    setDynamicInputs(next);
    (d.onUpdate as any)?.(id, { dynamic_inputs: next });
  };

  const handleGenerate = async () => {
    if (!selectedId) { alert('请先选择工作流'); return; }
    const prompt = (d.prompt as string) || d.image_prompt || 'masterpiece, high quality';
    setGenerating(true);
    try {
      const res = await apiService.generateShotImage({
        prompt,
        workflow_id: selectedId,
        dynamic_inputs: Object.keys(dynamicInputs).length ? dynamicInputs : undefined,
        aspect_ratio: '9:16',
      });
      const url = res.image_url;
      setResultUrl(url);
      (d.onUpdate as any)?.(id, { result_url: url, dynamic_inputs: dynamicInputs });
    } catch (e:any) { alert(e.message); } finally { setGenerating(false); }
  };

  return (
    <div className="w-[340px] bg-surface border-2 border-brand/40 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-violet-600/30 to-brand/30 border-b border-brand/30 flex items-center justify-between">
        <span className="text-xs font-bold text-white flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5 text-violet-300"/> ComfyUI 工作流</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 text-gray-300">{selectedId ? '已绑定' : '未选择'}</span>
      </div>

      <Handle type="target" position={Position.Left} className="!bg-violet-400 !w-2 !h-2" />
      <Handle type="target" position={Position.Top} id="prompt" className="!bg-brand !w-2 !h-2" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Right} className="!bg-brand !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} id="image" className="!bg-accent-green !w-2 !h-2" />

      <div className="p-3 space-y-3">
        <select value={selectedId} onChange={e=>handleSelect(e.target.value)} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white">
          <option value="">— 选择工作流 (内部/外部直读) —</option>
          {workflows.map((w:any)=> <option key={w.id} value={w.id}>{w.name||w.id} {w.source==='external' ? '(外部)' : '(内部)'} · {w.node_count}节点</option>)}
        </select>

        {selectedId && (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-400">{exposed.length} 个暴露输入</span>
            <button onClick={()=> window.dispatchEvent(new CustomEvent('open-workflow-inspector',{detail:{workflowId:selectedId}}))} className="text-brand-light hover:underline flex items-center gap-1"><Settings className="w-3 h-3"/> 参数与诊断</button>
          </div>
        )}

        {/* 动态端口区 */}
        {exposed.length>0 && (
          <div className="space-y-2 max-h-[220px] overflow-y-auto border border-brand/20 rounded-xl p-2 bg-surface-secondary/50">
            {exposed.map((exp:any)=>{
              const key = exp.id || exp.node_id;
              const val = dynamicInputs[key];
              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-gray-200 flex items-center gap-1">{exp.type==='image' ? <ImageIcon className="w-3 h-3 text-brand"/> : <Type className="w-3 h-3 text-gray-400"/>} {exp.label || exp.param_name}</span>
                    <span className="text-[10px] text-gray-500 font-mono">#{exp.node_id}</span>
                  </div>
                  {exp.type==='image' ? (
                    <div className="flex items-center gap-2">
                      {val ? <div className="w-12 h-12 rounded border border-brand overflow-hidden"><img src={val.startsWith('/')? API_ORIGIN+val : val} alt="" className="w-full h-full object-cover"/></div> : null}
                      <label className="flex-1 border border-dashed border-border hover:border-brand rounded-lg px-2 py-1.5 text-[11px] text-gray-300 cursor-pointer text-center">
                        <input type="file" accept="image/*" className="hidden" onChange={e=>{
                          const f=e.target.files?.[0]; if(!f) return;
                          const reader=new FileReader(); reader.onload=()=> handleDynamicChange(key, reader.result as string); reader.readAsDataURL(f);
                        }}/>
                        <span className="flex items-center justify-center gap-1"><Upload className="w-3 h-3"/> {val ? '更换' : '上传垫图'}</span>
                      </label>
                      {val && <button onClick={()=>handleDynamicChange(key,'')} className="text-[10px] text-red-400">移除</button>}
                    </div>
                  ) : exp.type==='number' ? (
                    <input type="number" value={val ?? ''} onChange={e=> handleDynamicChange(key, parseFloat(e.target.value)||0)} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white"/>
                  ) : (
                    <input type="text" value={val ?? ''} onChange={e=> handleDynamicChange(key, e.target.value)} placeholder={exp.description || ''} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500"/>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <textarea value={d.prompt || ''} onChange={e=> (d.onUpdate as any)?.(id,{prompt:e.target.value})} placeholder="主提示词 (将注入 workflow 的 prompt_node)…" rows={2} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs font-mono text-white placeholder-gray-500"/>

        {resultUrl && <div className="rounded-xl overflow-hidden border border-accent-green/30"><img src={resultUrl.startsWith('/')? API_ORIGIN+resultUrl : resultUrl} alt="result" className="w-full"/></div>}

        <button onClick={handleGenerate} disabled={generating || !selectedId} className="w-full py-2 rounded-xl bg-gradient-to-r from-violet-600 to-brand text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Check className="w-3.5 h-3.5"/> 使用此工作流生成</>}
        </button>
      </div>
    </div>
  );
};
