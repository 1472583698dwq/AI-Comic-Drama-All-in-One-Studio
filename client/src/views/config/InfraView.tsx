import React, { useState, useEffect } from 'react';
import { Cpu, FolderSearch, FolderOpen, RefreshCw, Trash2, Sliders, TestTube2, CheckCircle2, XCircle, Loader2, Layers, Film, Server, KeyRound, AlertTriangle, Eye, EyeOff, Bot } from 'lucide-react';
import { apiService } from '../../services/api';
import { WorkflowInspectorModal } from '../../components/workflow/WorkflowInspectorModal';

export const InfraView: React.FC<{
  form: Record<string,string>;
  setField: (k:string,v:string)=>void;
  onTest: (target:any)=>void;
  testing: string|null;
  testResult: Record<string, any>;
  onPickFolder: (key:string,title:string)=>void;
  onOpenFolder: (key:string)=>void;
  onSave: ()=>void;
  saving: boolean;
  onMsg: (msg:{type:'success'|'error', text:string})=>void;
}> = ({ form, setField, onTest, testing, testResult, onPickFolder, onOpenFolder, onSave, saving, onMsg }) => {
  const [workflowList, setWorkflowList] = useState<any[]>([]);
  const [loadingWfs, setLoadingWfs] = useState(false);
  const [inspectId, setInspectId] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string,boolean>>({});
  const toggleKey = (k:string)=> setShowKeys(p=> ({...p, [k]: !p[k]}));

  const loadWfs = async ()=>{
    setLoadingWfs(true);
    try{ const r=await apiService.listWorkflows('all'); setWorkflowList(r.workflows||r||[]);} catch{} finally{ setLoadingWfs(false); }
  };
  useEffect(()=>{ loadWfs(); }, []);

  const handleDeleteWf = async (wf:any)=>{
    if(wf.source!=='internal'){ alert('外部直读工作流为只读，请直接在文件系统中删除'); return; }
    if(!confirm(`删除内部工作流 ${wf.name||wf.id}？`)) return;
    try{
      await apiService.deleteWorkflow(wf.id);
      setWorkflowList(prev=> prev.filter((w:any)=> w.id!==wf.id));
      if(form.COMFYUI_DEFAULT_IMAGE_WORKFLOW===wf.id) setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW','');
      if(form.COMFYUI_DEFAULT_VIDEO_WORKFLOW===wf.id) setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW','');
      onMsg({type:'success', text:`已删除 ${wf.id}`});
      loadWfs();
    }catch(e:any){ alert(e.message); }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-bold text-white flex items-center gap-2"><Server className="w-4 h-4 text-accent-green"/> 基础设施 <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-gray-400">ComfyUI / 工作流 / 存储</span></h2>
        <p className="text-xs text-gray-400 mt-1">与生成源解耦：此处只配服务地址与工作流，Key 请到生成源中枢编辑。</p>
      </div>

      {/* ComfyUI 服务 */}
      <div className="bg-surface rounded-2xl border border-border p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="text-xs font-bold text-white flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-accent-green"/> ComfyUI 服务</span>
          <button onClick={()=> onTest('comfyui')} disabled={!!testing} className="px-2.5 py-1 rounded-full bg-surface-tertiary border border-border text-[11px] text-white flex items-center gap-1 disabled:opacity-40">
            {testing==='comfyui'?<Loader2 className="w-3 h-3 animate-spin"/>:<TestTube2 className="w-3 h-3"/>} 测试连通
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-300">COMFYUI_SERVER_URL</label>
            <div className="mt-1.5 flex gap-1.5">
              <input value={form.COMFYUI_SERVER_URL||''} onChange={e=> setField('COMFYUI_SERVER_URL', e.target.value)} placeholder="http://127.0.0.1:8188" className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
              <button onClick={()=> setField('COMFYUI_SERVER_URL','http://127.0.0.1:8188')} className="px-3 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-300">本机</button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300">COMFYUI_TIMEOUT_SECONDS</label>
            <input type="number" value={form.COMFYUI_TIMEOUT_SECONDS||'240'} onChange={e=> setField('COMFYUI_TIMEOUT_SECONDS', e.target.value)} className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300">COMFYUI_CHECKPOINT (首选底模)</label>
            <input value={form.COMFYUI_CHECKPOINT||''} onChange={e=> setField('COMFYUI_CHECKPOINT', e.target.value)} placeholder="留空自动选择" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          </div>
          <div className="flex items-end text-[11px] text-gray-500">{testResult.comfyui && <span className={`flex items-center gap-1 ${testResult.comfyui.ok?'text-emerald-400':'text-red-400'}`}>{testResult.comfyui.ok?<CheckCircle2 className="w-3 h-3"/>:<XCircle className="w-3 h-3"/>}{testResult.comfyui.detail}</span>}</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-300 flex items-center justify-between">COMFYUI_DEFAULT_IMAGE_WORKFLOW {form.COMFYUI_DEFAULT_IMAGE_WORKFLOW && <button onClick={()=> setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW','')} className="text-[10px] text-gray-500 hover:text-red-400">清除</button>}</label>
            <select value={form.COMFYUI_DEFAULT_IMAGE_WORKFLOW||''} onChange={e=> setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', e.target.value)} className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
              <option value="">-- 系统内置 SDXL --</option>
              {workflowList.map((wf:any)=> <option key={wf.id} value={wf.id}>{wf.name||wf.id} ({wf.source==='internal'?'内部':'外部'})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300 flex items-center justify-between">COMFYUI_DEFAULT_VIDEO_WORKFLOW {form.COMFYUI_DEFAULT_VIDEO_WORKFLOW && <button onClick={()=> setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW','')} className="text-[10px] text-gray-500 hover:text-red-400">清除</button>}</label>
            <select value={form.COMFYUI_DEFAULT_VIDEO_WORKFLOW||''} onChange={e=> setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', e.target.value)} className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white">
              <option value="">-- 自动/Mock --</option>
              {workflowList.map((wf:any)=> <option key={wf.id} value={wf.id}>{wf.name||wf.id} ({wf.source==='internal'?'内部':'外部'})</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* LLM 基础设施（遗留兼容，已收敛到生成源，仍保留以便迁移） */}
      <div className="bg-surface rounded-2xl border border-border p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="text-xs font-bold text-white flex items-center gap-2"><Bot className="w-3.5 h-3.5 text-cyan-400"/> 大模型 LLM 基础设施</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300">遗留兼容 · 建议迁移到生成源(llm)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-300">OPENAI_API_KEY</label>
            <div className="mt-1.5 relative">
              <input type={showKeys['OPENAI_API_KEY']?'text':'password'} value={form.OPENAI_API_KEY||''} onChange={e=> setField('OPENAI_API_KEY', e.target.value)} placeholder="sk-..." className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-9 text-xs font-mono text-white"/>
              <button type="button" onClick={()=> toggleKey('OPENAI_API_KEY')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white">{showKeys['OPENAI_API_KEY']?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}</button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300">OPENAI_BASE_URL</label>
            <input value={form.OPENAI_BASE_URL||''} onChange={e=> setField('OPENAI_BASE_URL', e.target.value)} placeholder="https://api.deepseek.com/v1" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300">OPENAI_MODEL</label>
            <input value={form.OPENAI_MODEL||''} onChange={e=> setField('OPENAI_MODEL', e.target.value)} placeholder="deepseek-chat" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-300">MINIMAX_API_KEY</label>
            <div className="mt-1.5 relative">
              <input type={showKeys['MINIMAX_API_KEY']?'text':'password'} value={form.MINIMAX_API_KEY||''} onChange={e=> setField('MINIMAX_API_KEY', e.target.value)} placeholder="sk-..." className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-9 text-xs font-mono text-white"/>
              <button type="button" onClick={()=> toggleKey('MINIMAX_API_KEY')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white">{showKeys['MINIMAX_API_KEY']?<EyeOff className="w-3 h-3"/>:<Eye className="w-3 h-3"/>}</button>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={()=> onTest('openai')} disabled={!!testing} className="px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border text-xs text-white flex items-center gap-1 disabled:opacity-40">{testing==='openai'?<Loader2 className="w-3 h-3 animate-spin"/>:<TestTube2 className="w-3 h-3"/>} 测试 OpenAI</button>
          {testResult.openai && <span className={`text-xs flex items-center gap-1 ${testResult.openai.ok?'text-emerald-400':'text-red-400'}`}>{testResult.openai.ok?<CheckCircle2 className="w-3 h-3"/>:<XCircle className="w-3 h-3"/>}{testResult.openai.detail}</span>}
          <button onClick={()=> onTest('minimax')} disabled={!!testing} className="px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border text-xs text-white flex items-center gap-1 disabled:opacity-40"><TestTube2 className="w-3 h-3"/> 测试 MiniMax</button>
          {testResult.minimax && <span className={`text-xs ${testResult.minimax.ok?'text-emerald-400':'text-red-400'}`}>{testResult.minimax.detail?.slice(0,40)}</span>}
        </div>
      </div>

      {/* 工作流目录 */}
      <div className="bg-surface rounded-2xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <span className="text-xs font-bold text-white">ComfyUI 工作流目录直读</span>
          <span className="text-[10px] text-gray-500">指定后自动扫描 *.json</span>
        </div>
        <div className="flex gap-1.5">
          <input value={form.COMFYUI_WORKFLOWS_DIR||''} onChange={e=> setField('COMFYUI_WORKFLOWS_DIR', e.target.value)} placeholder="D:/ComfyUI/workflows" className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          <button onClick={()=> onPickFolder('COMFYUI_WORKFLOWS_DIR','请选择 ComfyUI 工作流文件夹')} className="px-3 py-2 rounded-xl bg-brand/20 border border-brand/30 text-xs text-brand-light flex items-center gap-1"><FolderSearch className="w-3.5 h-3.5"/> 选择</button>
          {form.COMFYUI_WORKFLOWS_DIR && <button onClick={()=> onOpenFolder('COMFYUI_WORKFLOWS_DIR')} className="px-2.5 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-white"><FolderOpen className="w-3.5 h-3.5"/></button>}
        </div>
        <div className="text-[11px] text-gray-500">仅 API Format 可执行，Save Format 需 Export API Format。外部 id 以 <code className="px-1 py-0.5 rounded bg-black/30 text-brand-light">ext_</code> 开头可直接用。</div>
      </div>

      {/* 工作流列表 */}
      <div className="bg-surface rounded-2xl border border-border p-4">
        <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
          <span className="text-xs font-bold text-white">工作流列表与参数</span>
          <button onClick={loadWfs} disabled={loadingWfs} className="text-[11px] text-gray-400 flex items-center gap-1"><RefreshCw className={`w-3 h-3 ${loadingWfs?'animate-spin':''}`}/> 刷新</button>
        </div>
        {loadingWfs ? <div className="py-6 text-center text-xs text-gray-500 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> 扫描中…</div> : workflowList.length===0 ? <div className="py-6 text-center text-xs text-gray-500">暂无工作流</div> : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {workflowList.map((wf:any)=>{
              const isDefImg = form.COMFYUI_DEFAULT_IMAGE_WORKFLOW===wf.id;
              const isDefVid = form.COMFYUI_DEFAULT_VIDEO_WORKFLOW===wf.id;
              return (
                <div key={wf.id} className={`p-3 rounded-xl border flex flex-col gap-2 ${isDefImg||isDefVid?'border-brand/60 bg-surface-secondary':'border-border'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white truncate">{wf.name||wf.id}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${wf.source==='internal'?'bg-emerald-500/10 text-emerald-400 border-emerald-500/20':'bg-violet-500/10 text-violet-300 border-violet-500/20'}`}>{wf.source==='internal'?'内部':'外部'}</span>
                  </div>
                  <div className="text-[10px] font-mono text-gray-500">ID: {wf.id} {wf.node_count?`· ${wf.node_count} 节点`:''}</div>
                  <div className="flex items-center justify-between pt-1 border-t border-border/50">
                    <div className="flex gap-2 text-[10px]">
                      <button onClick={()=> setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', isDefImg?'':wf.id)} className={isDefImg?'text-amber-300':'text-gray-400'}>{isDefImg?'取消默认生图':'设默认生图'}</button>
                      <button onClick={()=> setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', isDefVid?'':wf.id)} className={isDefVid?'text-violet-300':'text-gray-400'}>{isDefVid?'取消默认视频':'设默认视频'}</button>
                    </div>
                    <span className="flex gap-1.5">
                      {wf.source==='internal' && <button onClick={()=> handleDeleteWf(wf)} className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-400"><Trash2 className="w-3 h-3"/></button>}
                      <button onClick={()=> setInspectId(wf.id)} className="px-2.5 py-1 rounded-lg bg-brand/10 border border-brand/20 text-[11px] text-brand-light flex items-center gap-1"><Sliders className="w-3 h-3"/> 参数</button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 剪映 */}
      <div className="bg-surface rounded-2xl border border-border p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white"><Layers className="w-3.5 h-3.5 text-orange-400"/> 剪映草稿箱</div>
        <div className="flex gap-1.5">
          <input value={form.JIANYIN_DRAFT_PATH||''} onChange={e=> setField('JIANYIN_DRAFT_PATH', e.target.value)} placeholder="C:/Users/.../com.lveditor.draft" className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white"/>
          <button onClick={()=> onPickFolder('JIANYIN_DRAFT_PATH','请选择剪映草稿目录')} className="px-3 py-2 rounded-xl bg-orange-500/15 border border-orange-500/20 text-xs text-orange-300 flex items-center gap-1"><FolderSearch className="w-3.5 h-3.5"/> 选择</button>
          {form.JIANYIN_DRAFT_PATH && <button onClick={()=> onOpenFolder('JIANYIN_DRAFT_PATH')} className="px-2.5 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-white"><FolderOpen className="w-3.5 h-3.5"/></button>}
        </div>
        <button onClick={()=> onTest('jianyin')} disabled={!!testing} className="px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border text-xs text-white flex items-center gap-1.5 disabled:opacity-40"><TestTube2 className="w-3.5 h-3.5"/> 验证目录</button>
        {testResult.jianyin && <span className={`ml-2 text-xs ${testResult.jianyin.ok?'text-emerald-400':'text-red-400'}`}>{testResult.jianyin.detail}</span>}
      </div>

      <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5"/> 云端 Key（硅基/阿里/ElevenLabs等）已迁移到“生成源”编辑，请勿在此页填 Key。</div>

      <div className="flex justify-end"><button onClick={onSave} disabled={saving} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40">{saving?'保存中…':'保存基础设施'}</button></div>

      {inspectId && <WorkflowInspectorModal workflowId={inspectId} isOpen={!!inspectId} onClose={()=> setInspectId('')} onSaved={loadWfs} onDeleted={(id)=>{ setWorkflowList(prev=> prev.filter((w:any)=> w.id!==id)); if(form.COMFYUI_DEFAULT_IMAGE_WORKFLOW===id) setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW',''); if(form.COMFYUI_DEFAULT_VIDEO_WORKFLOW===id) setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW',''); loadWfs(); }} />}
    </div>
  );
};
