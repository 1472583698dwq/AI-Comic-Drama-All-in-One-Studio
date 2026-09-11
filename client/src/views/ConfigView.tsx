import React, { useEffect, useState } from 'react';
import {
  Settings, ArrowLeft, RefreshCw, Save, Loader2,
  Plug, Layers, Route, Cpu, Info, Sparkles, Boxes,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { apiService } from '../services/api';
import { useProjectStore } from '../stores/useProjectStore';
import { DashboardView } from './config/DashboardView';
import { ProvidersHubView } from './config/ProvidersHubView';
import { DefaultsView } from './config/DefaultsView';
import { InfraView } from './config/InfraView';
import { SystemView } from './config/SystemView';
import { PluginsHubView } from './config/PluginsHubView';
import { ExtensionsCenterView } from './config/ExtensionsCenterView';

type TabKey = 'dashboard' | 'providers' | 'extensions' | 'plugins' | 'defaults' | 'infra' | 'system';

const TABS: Array<{key: TabKey; label: string; sub: string; icon: any; badge?: string}> = [
  { key: 'dashboard', label: '概览', sub: '健康与统计', icon: Layers },
  { key: 'providers', label: '生成源', sub: '增删改查 · 全域', icon: Plug, badge: '核心' },
  { key: 'extensions', label: '扩展中心', sub: '全 kind 聚合 · 启停', icon: Boxes, badge: '新' },
  { key: 'plugins', label: '插件', sub: '扩展包 · P0', icon: Sparkles },
  { key: 'defaults', label: '默认路由', sub: '全局默认通道', icon: Route },
  { key: 'infra', label: '基础设施', sub: 'ComfyUI / 工作流 / 剪映', icon: Cpu },
  { key: 'system', label: '系统诊断', sub: '端点与测试', icon: Info },
];

export const ConfigView: React.FC = () => {
  const { setActiveTab } = useProjectStore();
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setFormState] = useState<Record<string,string>>({});
  const [msg, setMsg] = useState<{type:'success'|'error', text:string}|null>(null);
  const [testResult, setTestResult] = useState<Record<string, any>>({});
  const [testing, setTesting] = useState<string|null>(null);
  const [envFile, setEnvFile] = useState('');
  const [checks, setChecks] = useState<Record<string,any>>({});
  const [providers, setProviders] = useState<any[]>([]);
  const [healthMap] = useState<Record<string,any>>({});

  const setField = (k:string, v:string)=> {
    setFormState(prev=> ({...prev, [k]: v}));
    setMsg(null);
  };

  const loadProviders = async ()=>{
    try{
      const res = await apiService.listProviders({ include_builtin: true });
      setProviders(res.providers || []);
    }catch{}
  };

  const load = async (silent: boolean = false)=>{
    if (!silent) setLoading(true);
    if (!silent) setMsg(null);
    try{
      const res = await apiService.getConfig();
      const loaded = res.config || {};
      setFormState(loaded);
      setEnvFile(res.env_file || '');
      setChecks(res.checks || {});
      try{ localStorage.setItem('ai_studio_config_backup', JSON.stringify(loaded)); }catch{}
    }catch(e:any){
      try{
        const cached = localStorage.getItem('ai_studio_config_backup');
        if(cached){ setFormState(JSON.parse(cached)); if (!silent) setMsg({type:'error', text:'后端连接异常，已从本地缓存恢复'}); }
        else if (!silent) setMsg({type:'error', text: e?.message||'加载配置失败'});
      }catch{ if (!silent) setMsg({type:'error', text: e?.message||'加载配置失败'}); }
    } finally{ if (!silent) setLoading(false); }
  };

  useEffect(()=>{ load(); loadProviders(); }, []);
  useEffect(()=>{
    if(tab==='providers' || tab==='dashboard' || tab==='defaults') loadProviders();
  }, [tab]);
  useEffect(()=>{
    const h = ()=> loadProviders();
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, []);

  const handleSave = async ()=>{
    setSaving(true);
    setMsg(null);
    try{
      const res = await apiService.saveConfig({ ...form });
      const savedConfig = res?.config || form;
      setFormState(savedConfig);
      if (res?.env_file) setEnvFile(res.env_file);
      try{ localStorage.setItem('ai_studio_config_backup', JSON.stringify(savedConfig)); }catch{}
      setMsg({type:'success', text:`配置已成功持久化至 ${res?.env_file||envFile||'.env'} 并热重载生效！`});
      await load(true);
      await loadProviders();
    }catch(e:any){ setMsg({type:'error', text: e?.message||'保存失败'}); } finally{ setSaving(false); }
  };

  const handleTest = async (target:any)=>{
    setTesting(target);
    setTestResult(p=> ({...p, [target]: null}));
    try{
      const res = await apiService.testConfig(target, form);
      setTestResult(p=> ({...p, [target]: {ok: res.ok, detail: res.detail}}));
    }catch(e:any){
      setTestResult(p=> ({...p, [target]: {ok:false, detail: e?.message||'测试失败'}}));
    } finally{ setTesting(null); }
  };

  const handlePickFolder = async (fieldKey:string, title:string='请选择文件夹')=>{
    try{
      const res = await apiService.browseFolder({ initialDir: form[fieldKey]||'', title });
      if(res?.selected_path){ setField(fieldKey, res.selected_path); setMsg({type:'success', text:`已选择: ${res.selected_path}`}); }
    }catch(e:any){ setMsg({type:'error', text: e?.message||'打开文件夹选择器失败'}); }
  };
  const handleOpenFolder = async (fieldKey:string)=>{
    const p = form[fieldKey]||'';
    if(!p){ setMsg({type:'error', text:'请先配置路径'}); return; }
    try{ await apiService.openFolder(p); } catch(e:any){ setMsg({type:'error', text: e?.message||'打开目录失败'}); }
  };

  if(loading){
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm bg-background">
        <Loader2 className="w-5 h-5 animate-spin mr-2 text-brand-light"/><span>正在读取系统配置...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Top Header */}
      <div className="h-12 bg-surface border-b border-border px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <button onClick={()=> setActiveTab('studio')} className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-surface-secondary hover:bg-surface-tertiary text-xs text-gray-300 hover:text-white border border-border">
            <ArrowLeft className="w-3.5 h-3.5"/><span>返回漫剧工作台</span>
          </button>
          <span className="text-gray-600">/</span>
          <div className="flex items-center space-x-2">
            <div className="p-1 rounded bg-brand/20 border border-brand/40 text-brand-light"><Settings className="w-3.5 h-3.5"/></div>
            <span className="text-xs font-bold text-white">设置中心</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">Provider 中枢</span>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button onClick={()=> load()} className="flex items-center space-x-1.5 text-xs text-gray-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-surface-secondary">
            <RefreshCw className="w-3 h-3"/><span>重载</span>
          </button>
          <button onClick={handleSave} disabled={saving} className="flex items-center space-x-1.5 px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold shadow-md shadow-brand/25 disabled:opacity-40">
            {saving?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Save className="w-3.5 h-3.5"/>}<span>{saving?'保存中…':'保存全部配置'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-64 bg-surface border-r border-border flex flex-col shrink-0">
          <div className="p-3 space-y-1.5 flex-1 overflow-y-auto custom-scrollbar">
            {TABS.map(t=>{
              const Icon = t.icon;
              const active = tab===t.key;
              return (
                <button key={t.key} onClick={()=> setTab(t.key)} className={`w-full flex items-start space-x-3 p-2.5 rounded-xl border text-left transition-all ${active?'bg-brand/15 border-brand text-white ring-1 ring-brand/30':'border-transparent text-gray-400 hover:text-gray-200 hover:bg-surface-secondary'}`}>
                  <div className={`p-1.5 rounded-lg mt-0.5 ${active?'bg-brand text-white':'bg-surface-secondary text-gray-400'}`}><Icon className="w-4 h-4"/></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold truncate ${active?'text-white':'text-white'}`}>{t.label}</span>
                      {t.badge && <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand/20 text-brand-light border border-brand/30">{t.badge}</span>}
                    </div>
                    <p className="text-[10px] text-gray-500 truncate mt-0.5">{t.sub}</p>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="p-3 border-t border-border bg-surface-secondary/30">
            <div className="text-[10px] text-gray-400 flex items-center gap-1 mb-1"><Sparkles className="w-3 h-3 text-accent-orange"/><span>热重载</span></div>
            <div className="text-[9px] text-gray-500 font-mono truncate" title={envFile}>{envFile||'server/.env'}</div>
            <div className="text-[9px] text-gray-500 mt-1">{providers.length} 生成源 · {providers.filter(p=>!p.builtin).length} 自定义</div>
          </div>
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#07070A]">
          <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar max-w-5xl">
            {msg && (
              <div className={`px-4 py-3 rounded-2xl border text-xs flex items-center justify-between ${msg.type==='success'?'bg-emerald-500/10 border-emerald-500/30 text-emerald-300':'bg-red-500/10 border-red-500/30 text-red-300'}`}>
                <span className="flex items-center gap-2">{msg.type==='success'?<CheckCircle2 className="w-4 h-4"/>:<XCircle className="w-4 h-4"/>}{msg.text}</span>
                <button onClick={()=> setMsg(null)} className="px-2 py-0.5 rounded hover:bg-white/10">✕</button>
              </div>
            )}

            {tab==='dashboard' && <DashboardView providers={providers} onNavigate={(k)=> setTab(k as TabKey)} healthMap={healthMap} checks={checks} envFile={envFile} />}
            {tab==='providers' && <ProvidersHubView providers={providers} onRefresh={loadProviders} />}
            {tab==='extensions' && <ExtensionsCenterView />}
            {tab==='plugins' && <PluginsHubView />}
            {tab==='defaults' && <DefaultsView form={form} setField={setField} onSave={handleSave} saving={saving} providers={providers} />}
            {tab==='infra' && <InfraView form={form} setField={setField} onTest={handleTest} testing={testing} testResult={testResult} onPickFolder={handlePickFolder} onOpenFolder={handleOpenFolder} onSave={handleSave} saving={saving} onMsg={setMsg} />}
            {tab==='system' && <SystemView envFile={envFile} checks={checks} form={form} onTest={handleTest} testing={testing} testResult={testResult} onReload={()=> load()} />}
          </div>

          <div className="h-14 px-6 border-t border-border bg-surface flex items-center justify-between shrink-0">
            <button onClick={()=> load()} className="text-xs text-gray-400 hover:text-white">放弃未保存更改</button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-6 py-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold shadow-lg shadow-brand/30 disabled:opacity-40">
              {saving?<Loader2 className="w-4 h-4 animate-spin"/>:<Save className="w-4 h-4"/>}<span>{saving?'正在写入并热重载…':'保存全部配置'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
