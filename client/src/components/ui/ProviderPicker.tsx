import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api';
import { Cpu, Globe, Mic, Video, Plug, Activity } from 'lucide-react';

type Kind = 'image' | 'video' | 'audio' | 'llm';

interface ProviderPickerProps {
  kind: Kind;
  value?: string;
  onChange: (providerId: string, definition?: any) => void;
  placeholder?: string;
  compact?: boolean;
}

const kindMeta: Record<Kind, {icon:any, color:string, bg:string, label:string}> = {
  image: {icon: Globe, color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20', label: '生图'},
  video: {icon: Video, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', label: '视频'},
  audio: {icon: Mic, color: 'text-pink-400', bg: 'bg-pink-500/10 border-pink-500/20', label: '语音'},
  llm:   {icon: Cpu, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20', label: 'LLM'},
};

export const ProviderPicker: React.FC<ProviderPickerProps> = ({ kind, value, onChange, placeholder, compact=false }) => {
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
        {providers.map(p=> (
          <option key={p.id} value={p.id}>
            {p.display_name || p.name || p.id} {p.builtin ? '·内置' : '·自定义'} {p.models?.length ? `·${p.models.length}模型` : ''}
          </option>
        ))}
      </select>
      {selected && (
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className={`px-1.5 py-0.5 rounded border ${selected.builtin ? 'bg-brand/10 border-brand/20 text-brand-light' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{selected.builtin?'内置':'自定义'}</span>
          <span className="truncate" title={selected.transport?.url || ''}>{selected.transport?.url ? `URL: ${selected.transport.url.slice(0,32)}…` : ''}</span>
          {selected.health?.ok !== undefined && <span className={`w-2 h-2 rounded-full ${selected.health.ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />}
        </div>
      )}
      {providers.length===0 && !loading && <div className="text-[10px] text-gray-500 text-center py-1">暂无{meta.label}源，请去设置或让导演接入</div>}
    </div>
  );
};

export const ProviderParamForm: React.FC<{ definition: any; values: Record<string,any>; onChange: (next: Record<string,any>)=>void }> = ({ definition, values, onChange }) => {
  if (!definition?.params_schema?.properties || Object.keys(definition.params_schema.properties).length===0) {
    return <div className="text-[10px] text-gray-500 text-center py-2">该源无额外参数（使用 prompt/size/seed 等通用字段）</div>;
  }
  const props = definition.params_schema.properties as Record<string, any>;
  return (
    <div className="space-y-2">
      {Object.entries(props).map(([key, def]: any)=>{
        const val = values[key] ?? definition.default_params?.[key] ?? def.default ?? '';
        const isNumber = def.type==='integer' || def.type==='number';
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-gray-300">{key}</span>
              <span className="text-[10px] text-gray-500 max-w-[140px] truncate" title={def.description}>{def.description || def.type}</span>
            </div>
            {isNumber ? (
              <input type="number" value={val} onChange={e=> onChange({...values, [key]: def.type==='integer' ? parseInt(e.target.value)||0 : parseFloat(e.target.value)||0})} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white"/>
            ) : def.enum ? (
              <select value={val} onChange={e=> onChange({...values, [key]: e.target.value})} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white">
                <option value="">— 选择 —</option>
                {def.enum.map((opt:string)=> <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : (
              <input type="text" value={val} onChange={e=> onChange({...values, [key]: e.target.value})} placeholder={def.description || key} className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500"/>
            )}
          </div>
        );
      })}
    </div>
  );
};
