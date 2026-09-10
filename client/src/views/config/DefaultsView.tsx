import React, { useEffect, useState } from 'react';
import { Route, Globe, Video, Mic, Cpu, Save, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import { apiService } from '../../services/api';
import { ProviderPicker } from '../../components/ui/ProviderPicker';

export const DefaultsView: React.FC<{
  form: Record<string,string>;
  setField: (k:string,v:string)=>void;
  onSave: ()=>void;
  saving: boolean;
  providers: any[];
}> = ({ form, setField, onSave, saving, providers }) => {
  const [health, setHealth] = useState<Record<string, any>>({});

  const test = async (id:string)=>{
    if(!id) return;
    try{
      const r = await apiService.testProvider(id);
      setHealth(prev=> ({...prev, [id]: r}));
    }catch(e:any){ setHealth(prev=> ({...prev, [id]: {ok:false, detail:e.message}})); }
  };

  const pick = (kind:'image'|'video'|'audio', key:string, label:string, desc:string)=>{
    const current = form[key] || '';
    const def = providers.find(p=> p.id===current);
    const h = health[current];
    return (
      <div className="p-4 rounded-2xl bg-surface border border-border space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white flex items-center gap-1.5">{label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-gray-400 font-mono">{key}</span></span>
          {current && <button onClick={()=> test(current)} className="text-[11px] px-2.5 py-1 rounded-full bg-surface-secondary border border-border text-white hover:border-brand">测试</button>}
        </div>
        <div className="text-[11px] text-gray-400">{desc}</div>
        <ProviderPicker kind={kind} value={current} onChange={(pid)=> setField(key, pid)} />
        {def && (
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <span className="px-1.5 py-0.5 rounded bg-black/30 text-gray-300 truncate max-w-[180px]">{def.display_name || def.name}</span>
            <span className="ml-auto flex items-center gap-1">{h ? (h.ok? <CheckCircle2 className="w-3 h-3 text-emerald-500"/> : <span className="text-amber-400">{h.detail?.slice(0,40)}</span>) : null}</span>
          </div>
        )}
        {!current && <div className="text-[11px] text-amber-300 flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> 未选择，将回退到首个已配置源</div>}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-bold text-white flex items-center gap-2"><Route className="w-4 h-4 text-brand"/> 默认路由 <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/15 text-brand-light border border-brand/20">保存后热重载</span></h2>
        <p className="text-xs text-gray-400 mt-1">选择各模态的全局默认生成源，分镜/画布未指定时自动使用此处。单镜可通过 ProviderPicker 覆盖。</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {pick('image','IMAGE_PROVIDER','生图默认 IMAGE_PROVIDER','分镜首帧 / 资产生图 / 三视图 默认通道')}
        {pick('audio','TTS_PROVIDER','语音默认 TTS_PROVIDER','角色对白 / 旁白 默认通道')}
        {pick('video','VIDEO_PROVIDER','视频默认 VIDEO_PROVIDER','图生视频 / 参考生视频 默认通道')}
        {/* LLM */}
        <div className="p-4 rounded-2xl bg-surface border border-border space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5 text-cyan-400"/> 大模型默认 LLM_PROVIDER <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary border border-border text-gray-400 font-mono">LLM_PROVIDER</span></span>
          </div>
          <div className="text-[11px] text-gray-400">剧本拆解 / 导演Agent 的 LLM 通道（openai_compatible / opencode / deepseek / qwen 等）</div>
          <select value={form.LLM_PROVIDER || 'openai_compatible'} onChange={e=> setField('LLM_PROVIDER', e.target.value)} className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand">
            <option value="openai_compatible">openai_compatible (OpenCode / 兼容源)</option>
            <option value="deepseek">deepseek</option>
            <option value="qwen">qwen</option>
            <option value="siliconflow">siliconflow</option>
            <option value="responses_api">responses_api</option>
          </select>
          <div className="text-[11px] text-gray-500">详细 Key/URL 请到“基础设施”或“生成源(llm)”配置，此处仅路由。</div>
        </div>
      </div>

      <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20 text-[11px] text-gray-300 leading-relaxed">
        <span className="font-bold text-amber-300">说明：</span> 具体模型、采样参数、鉴权 Key 请到 <span className="text-white">生成源中枢</span> 的对应 Provider 卡片编辑；此处只决定“用哪个源”。导演 Agent 可在对话中动态指定 <code className="px-1 py-0.5 rounded bg-black/30 text-brand-light">provider</code> 参数覆盖。
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gray-500">修改后需“保存全部配置”才写入 .env 并热重载。</span>
        <button onClick={onSave} disabled={saving} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-40">
          <Save className="w-3.5 h-3.5"/> {saving?'保存中…':'保存路由'}
        </button>
      </div>
    </div>
  );
};
