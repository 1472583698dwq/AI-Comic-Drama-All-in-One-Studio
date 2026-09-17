import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api';
import { Cpu, Globe, Mic, Video, Plug, Activity } from 'lucide-react';
import { DynamicControl, groupSpecs } from '../canvas/controls/DynamicControl';
import { paramsSchemaToSpecs } from '../canvas/providerSkills';
import { CAPABILITIES_BY_KIND, capabilityLabel, hasCapability } from '../provider/providerCapabilities';

type Kind = 'image' | 'video' | 'audio' | 'llm';

interface ProviderPickerProps {
  kind: Kind;
  value?: string;
  onChange: (providerId: string, definition?: any) => void;
  placeholder?: string;
  compact?: boolean;
  /** 能力过滤（如 video 选 'i2v' 则只列出图生视频源；不传则不过滤） */
  capability?: string;
  /** 配置端显示全部（含未配置）；生产端显示「已配置/已接入」的源（未配置 Key 的内置源隐藏） */
  includeUnverified?: boolean;
}

const kindMeta: Record<Kind, {icon:any, color:string, bg:string, label:string}> = {
  image: {icon: Globe, color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20', label: '生图'},
  video: {icon: Video, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', label: '视频'},
  audio: {icon: Mic, color: 'text-pink-400', bg: 'bg-pink-500/10 border-pink-500/20', label: '语音'},
  llm:   {icon: Cpu, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20', label: 'LLM'},
};

export const ProviderPicker: React.FC<ProviderPickerProps> = ({ kind, value, onChange, placeholder, compact=false, capability, includeUnverified=false }) => {
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = async () => {
    setLoading(true);
    try {
      const res = await apiService.listProviders({ kind, include_builtin: true });
      setProviders(res.providers || []);
    } catch {}
    setLoading(false);
  };

  useEffect(()=> { fetch(); }, [kind]);

  // 监听全局新增事件，实时刷新
  useEffect(()=>{
    const h = ()=> fetch();
    window.addEventListener('provider-list-refresh', h as any);
    return ()=> window.removeEventListener('provider-list-refresh', h as any);
  }, [kind]);

  const selected = providers.find(p=> p.id===value);
  // 生产端显示「已配置/已接入」的源（内置=已填 Key，自定义=接入即显示）；配置端(includeUnverified)显示全部。
  const pool = includeUnverified ? providers : providers.filter(p=> p.production_ready === true);
  const pendingCount = includeUnverified ? 0 : providers.filter(p=> p.production_ready !== true).length;
  const visibleProviders = pool.filter(p=> p.id===value
    || (capability ? hasCapability(p, capability) : true));
  if (value && !visibleProviders.some(p=> p.id===value)) {
    const sel = providers.find(p=> p.id===value);
    if (sel) visibleProviders.unshift(sel);
  }
  const meta = kindMeta[kind] || kindMeta.image;
  const Icon = meta.icon;

  return (
    <div className={`space-y-1 ${compact?'':'w-full'}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-300 flex items-center gap-1">
          <Icon className={`w-3 h-3 ${meta.color}`} /> {meta.label}源 {loading && <span className="text-[10px] text-gray-500">加载中…</span>}
        </span>
        <button onClick={fetch} className="text-[10px] text-brand-light hover:underline">刷新</button>
      </div>
      <select
        value={value || ''}
        onChange={e=>{
          const pid = e.target.value;
          const def = providers.find(p=> p.id===pid);
          onChange(pid, def);
        }}
        className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-brand"
      >
        <option value="">{placeholder || `— 选择${meta.label}生成源 —`}</option>
        {visibleProviders.map(p=> (
          <option key={p.id} value={p.id}>
            {p.display_name || p.name || p.id} {p.builtin ? '·内置' : '·自定义'} {p.models?.length ? `·${p.models.length}模型` : ''}
          </option>
        ))}
      </select>
      {capability && (
        <div className="text-[10px] text-gray-500">已按能力过滤：<span className="text-brand-light font-bold">{capabilityLabel(kind, capability)}</span>（当前选中始终保留）</div>
      )}
      {selected && (
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 flex-wrap">
          <span className={`px-1.5 py-0.5 rounded border ${selected.builtin ? 'bg-brand/10 border-brand/20 text-brand-light' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{selected.builtin?'内置':'自定义'}</span>
          {(Array.isArray(selected.capabilities) && selected.capabilities.length ? selected.capabilities : []).map((c: string)=> (
            <span key={c} className="px-1.5 py-0.5 rounded border bg-surface-secondary border-border text-gray-300">{capabilityLabel(kind, c)}</span>
          ))}
          <span className="truncate" title={selected.transport?.url || ''}>{selected.transport?.url ? `URL: ${selected.transport.url.slice(0,32)}…` : ''}</span>
          {selected.health?.ok !== undefined && <span className={`w-2 h-2 rounded-full ${selected.health.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />}
        </div>
      )}
      {visibleProviders.length===0 && !loading && (
        <div className="text-[10px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5 leading-4">
          暂无已配置的{meta.label}源。请到 <span className="font-bold">设置 → 生成源</span> 填写内置源 Key，或接入自定义源（接入即显示）。
          {pendingCount > 0 && <span className="text-gray-500">（当前有 {pendingCount} 个源未配置）</span>}
        </div>
      )}
    </div>
  );
};

export const ProviderParamForm: React.FC<{ definition: any; values: Record<string,any>; onChange: (next: Record<string,any>)=>void; compact?: boolean }> = ({ definition, values, onChange, compact }) => {
  const [showAll, setShowAll] = useState(false);
  if (!definition?.params_schema?.properties || Object.keys(definition.params_schema.properties).length===0) {
    return <div className="text-[10px] text-gray-500 text-center py-2">该源无额外参数（使用 prompt/size/seed 等通用字段）</div>;
  }
  // 全系统唯一映射（与画布 NodeAgentConsole 同一函数），分组/暴露/人机分工只认 x-*
  const all = paramsSchemaToSpecs(definition.params_schema);
  const specs = all.filter((s:any)=> s.visibility!=='hidden');
  const hiddenCount = all.length - specs.length;
  const visible = showAll ? all : specs;
  if (visible.length===0) return <div className="text-[10px] text-gray-500 text-center py-2">该源无可调参数（{all.length}项为内部隐藏）</div>;
  const { basic, advanced } = groupSpecs(visible);
  const renderSpec = (spec:any) => (
    <DynamicControl key={spec.param_name} spec={spec} value={values[spec.param_name] ?? definition.default_params?.[spec.param_name] ?? spec.default_value} onChange={(v:any)=> onChange({...values, [spec.param_name]: v})} compact={compact} />
  );
  return (
    <div className="space-y-3">
      {basic.length>0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold text-gray-400 tracking-wider flex items-center gap-1.5"><span className="w-1 h-3 rounded-full bg-emerald-500/60" /> 基础 · Agent可自动</div>
          <div className="grid grid-cols-1 gap-2">{basic.map(renderSpec)}</div>
        </div>
      )}
      {advanced.length>0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold text-gray-400 tracking-wider flex items-center gap-1.5"><span className="w-1 h-3 rounded-full bg-amber-500/60" /> 高级 · 建议/手填</div>
          <div className="grid grid-cols-1 gap-2">{advanced.map(renderSpec)}</div>
        </div>
      )}
      {hiddenCount>0 && (
        <button onClick={()=>setShowAll(v=>!v)} className="w-full py-1 rounded-lg border border-border bg-surface-secondary/60 hover:border-brand/50 text-[10px] text-gray-400 hover:text-brand-light transition-colors">
          {showAll ? `收起内部参数（隐藏 ${hiddenCount} 项）` : `展开内部参数（${hiddenCount} 项未在 App 契约中声明）`}
        </button>
      )}
      {basic.length===0 && advanced.length===0 && <div className="text-[10px] text-gray-500">无可视参数</div>}
    </div>
  );
};
