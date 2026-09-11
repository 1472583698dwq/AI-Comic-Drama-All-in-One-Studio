import React, { useEffect, useState } from 'react';
import { Info, RefreshCw, CheckCircle2, XCircle, Loader2, TestTube2, Copy, Sparkles } from 'lucide-react';
import { toast } from '../../stores/useDialogStore';

export const SystemView: React.FC<{
  envFile: string;
  checks: Record<string, any>;
  form: Record<string,string>;
  onTest: (t:any)=>void;
  testing: string|null;
  testResult: Record<string, any>;
  onReload: ()=>void;
}> = ({ envFile, checks, form, onTest, testing, testResult, onReload }) => {
  const [health, setHealth] = useState<any>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  const fetchHealth = async ()=>{
    setLoadingHealth(true);
    try{
      const res = await fetch(`${window.location.port==='5173'?'http://127.0.0.1:8000':''}/api/v1/health`).then(r=>r.json());
      setHealth(res);
    }catch(err: any){
      setHealth({ status: 'unreachable', error: err?.message || '无法连接健康检查接口' });
    } finally{ setLoadingHealth(false); }
  };
  useEffect(()=>{ fetchHealth(); }, []);

  const copy = (t:string)=>{ 
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(t).then(() => {
          toast.success('诊断信息已复制');
        }).catch(() => {
          toast.info('剪贴板权限受限，请手动复制');
        });
      } else {
        toast.info('当前环境不支持直接写入剪贴板');
      }
    } catch {
      toast.info('复制失败');
    }
  };

  const renderProviders = (val: any) => {
    if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '—';
    if (typeof val === 'number') return `${val} 个提供源就绪`;
    if (val && typeof val === 'object') return Object.keys(val).join(', ') || '—';
    return val ? String(val) : '—';
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-bold text-white flex items-center gap-2"><Info className="w-4 h-4 text-brand-blue"/> 系统与诊断</h2>
        <p className="text-xs text-gray-400 mt-1">端点、健康检查与一键测试。</p>
      </div>

      <div className="bg-surface rounded-2xl border border-border p-4 space-y-3 text-xs">
        <div className="flex items-center justify-between py-2 border-b border-border"><span className="text-gray-400">后端</span><span className="font-mono text-white">http://127.0.0.1:8000</span></div>
        <div className="flex items-center justify-between py-2 border-b border-border"><span className="text-gray-400">MCP</span><span className="font-mono text-emerald-400">/mcp-server 已挂载</span></div>
        <div className="flex items-center justify-between py-2 border-b border-border"><span className="text-gray-400">.env 路径</span><span className="font-mono text-brand-light truncate max-w-[260px]">{envFile||'server/.env'}</span></div>
        <div className="flex items-center justify-between py-2"><span className="text-gray-400">LLM 就绪</span><span className={checks?.openai_configured?'text-emerald-400':'text-amber-400'}>{checks?.openai_configured?'OpenAI / 通用大模型已配':'未配置'}</span></div>
        <button onClick={onReload} className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1"><RefreshCw className="w-3 h-3"/> 重载配置</button>
        <button onClick={()=> window.dispatchEvent(new Event('open-first-run-wizard'))} className="text-[11px] text-brand-light hover:underline flex items-center gap-1"><Sparkles className="w-3 h-3"/> 重新运行安装向导（配置 Key 并测试联通）</button>
      </div>

      <div className="bg-surface rounded-2xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white">健康检查 /health</span>
          <button onClick={fetchHealth} disabled={loadingHealth} className="text-[11px] text-gray-400 flex items-center gap-1">{loadingHealth?<Loader2 className="w-3 h-3 animate-spin"/>:<RefreshCw className="w-3 h-3"/>} 刷新</button>
        </div>
        {health ? (
          <div className="text-xs space-y-1.5">
            <div className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${health.status==='healthy'?'bg-emerald-500':'bg-amber-500'}`}/><span className="text-white">{health.status}</span><span className="text-gray-500">comfyui: {health.comfyui_online?'在线':'离线'}</span></div>
            <div className="text-[11px] text-gray-400 font-mono">image providers: {renderProviders(health.providers?.image)}</div>
            <div className="text-[11px] text-gray-400 font-mono">audio providers: {renderProviders(health.providers?.audio)}</div>
            <button onClick={()=> copy(JSON.stringify(health,null,2))} className="text-[11px] text-brand-light flex items-center gap-1"><Copy className="w-3 h-3"/> 复制 JSON</button>
          </div>
        ) : <div className="text-xs text-gray-500">加载中…</div>}
      </div>

      <div className="bg-surface rounded-2xl border border-border p-4 space-y-3">
        <div className="text-xs font-bold text-white">一键测试</div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            {k:'openai', label:'大模型 LLM (OpenAI/OpenCode)'},
            {k:'comfyui', label:'ComfyUI'},
            {k:'siliconflow', label:'硅基流动'},
            {k:'dashscope', label:'DashScope'},
            {k:'elevenlabs', label:'ElevenLabs'},
            {k:'jianyin', label:'剪映目录'},
          ].map(item=>(
            <button key={item.k} onClick={()=> onTest(item.k)} disabled={!!testing} className="px-3 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white flex items-center justify-between disabled:opacity-40">
              <span className="flex items-center gap-1"><TestTube2 className="w-3 h-3 text-brand-light"/>{item.label}</span>
              {testing===item.k ? <Loader2 className="w-3 h-3 animate-spin"/> : testResult[item.k] ? (testResult[item.k].ok?<CheckCircle2 className="w-3 h-3 text-emerald-500"/>:<XCircle className="w-3 h-3 text-red-400"/>) : null}
            </button>
          ))}
        </div>
        {Object.entries(testResult).map(([k,v]:any)=> v && (
          <div key={k} className={`text-xs px-3 py-2 rounded-xl border ${v.ok?'bg-emerald-500/10 border-emerald-500/20 text-emerald-300':'bg-red-500/10 border-red-500/20 text-red-300'}`}>
            <span className="font-bold">{k}:</span> {typeof v.detail === 'string' ? v.detail : JSON.stringify(v.detail ?? v)}
          </div>
        ))}
      </div>
    </div>
  );
};
