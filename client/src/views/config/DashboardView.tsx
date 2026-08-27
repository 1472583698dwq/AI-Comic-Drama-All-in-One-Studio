import React, { useEffect, useState } from 'react';
import { Activity, Plug, Globe, Video, Mic, Cpu, ArrowRight, Zap, CheckCircle2, XCircle, Layers, Bot, Film } from 'lucide-react';
import { apiService } from '../../services/api';

interface Props {
  providers: any[];
  onNavigate: (tab: string) => void;
  healthMap: Record<string, any>;
  checks?: Record<string, any>;
  envFile?: string;
}

const kindMeta: any = {
  image: { icon: Globe, color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20', label: '生图' },
  video: { icon: Video, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', label: '视频' },
  audio: { icon: Mic, color: 'text-pink-400', bg: 'bg-pink-500/10 border-pink-500/20', label: '语音' },
  llm: { icon: Cpu, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20', label: 'LLM' },
};

export const DashboardView: React.FC<Props> = ({ providers, onNavigate, healthMap, checks, envFile }) => {
  const total = providers.length;
  const builtin = providers.filter(p=>p.builtin).length;
  const custom = total - builtin;
  const groups: Record<string, any[]> = { image: [], video: [], audio: [], llm: [] };
  providers.forEach(p=> { if(groups[p.kind]) groups[p.kind].push(p); else groups.image.push(p); });

  const issues = providers.filter(p=>{
    const h = healthMap[p.id];
    return h && h.ok===false;
  });

  return (
    <div className="space-y-5">
      {/* 顶部统计 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: '总生成源', value: total, sub: `${builtin} 内置 · ${custom} 自定义`, icon: Plug, color: 'text-brand' },
          { label: '生图源', value: groups.image.length, sub: 'image · ComfyUI/云端', icon: Globe, color: 'text-violet-400' },
          { label: '视频源', value: groups.video.length, sub: 'video · i2v/r2v', icon: Video, color: 'text-orange-400' },
          { label: '语音源', value: groups.audio.length, sub: 'audio · TTS', icon: Mic, color: 'text-pink-400' },
        ].map(card=>(
          <div key={card.label} className="p-4 rounded-2xl bg-surface border border-border flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-surface-secondary border border-border flex items-center justify-center"><card.icon className={`w-4 h-4 ${card.color}`} /></div>
            <div>
              <div className="text-lg font-bold text-white leading-none">{card.value}</div>
              <div className="text-xs font-semibold text-white">{card.label}</div>
              <div className="text-[11px] text-gray-500">{card.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 快捷操作 */}
      <div className="p-4 rounded-2xl bg-gradient-to-br from-brand/10 via-violet-500/5 to-brand-blue/10 border border-brand/20 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-white flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-brand"/> 快速开始</span>
        <span className="text-[11px] text-gray-400 hidden sm:inline">— 在生成源中枢新增源后，全局自动可用（分镜/画布/导演）</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button onClick={()=> onNavigate('providers')} className="px-3 py-1.5 rounded-full bg-brand text-white text-xs font-bold flex items-center gap-1">去管理生成源 <ArrowRight className="w-3 h-3"/></button>
          <button onClick={()=> onNavigate('defaults')} className="px-3 py-1.5 rounded-full bg-surface border border-border text-xs text-white">配置默认路由</button>
          <button onClick={()=> onNavigate('infra')} className="px-3 py-1.5 rounded-full bg-surface border border-border text-xs text-white">基础设施</button>
        </span>
      </div>

      {/* 按 kind 分组预览 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {(['image','video','audio','llm'] as const).map(k=>{
          const list = groups[k] || [];
          const meta = kindMeta[k];
          const Icon = meta.icon;
          if(list.length===0) return null;
          return (
            <div key={k} className="p-4 rounded-2xl bg-surface border border-border">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-white flex items-center gap-1.5"><Icon className={`w-3.5 h-3.5 ${meta.color}`}/> {meta.label} · {list.length}</span>
                <button onClick={()=> onNavigate('providers')} className="text-[11px] text-brand-light hover:underline">管理 →</button>
              </div>
              <div className="space-y-1.5">
                {list.slice(0,4).map((p:any)=>{
                  const h = healthMap[p.id];
                  return (
                    <div key={p.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-surface-secondary border border-border">
                      <span className="text-xs text-white truncate max-w-[140px]">{p.display_name || p.name || p.id}</span>
                      <span className="flex items-center gap-1.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${p.builtin?'bg-surface border-border text-gray-400':'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>{p.builtin?'内置':'自定义'}</span>
                        {h ? (h.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500"/> : <XCircle className="w-3 h-3 text-amber-500"/>) : <span className="w-2 h-2 rounded-full bg-zinc-600"/>}
                      </span>
                    </div>
                  );
                })}
                {list.length>4 && <div className="text-[11px] text-gray-500 text-center">还有 {list.length-4} 个 → 去生成源查看全部</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* 健康告警 */}
      {issues.length>0 && (
        <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20">
          <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5"/> {issues.length} 个源检测未通过</div>
          <div className="text-[11px] text-gray-400 mt-1">可能未配 Key 或服务不可达，请到生成源页逐个“测试”并补 Key。</div>
        </div>
      )}

      {/* 环境 */}
      <div className="p-4 rounded-2xl bg-surface border border-border text-xs space-y-2">
        <div className="flex items-center justify-between py-1 border-b border-border"><span className="text-gray-400">后端</span><span className="font-mono text-white">http://127.0.0.1:8000</span></div>
        <div className="flex items-center justify-between py-1 border-b border-border"><span className="text-gray-400">.env 路径</span><span className="font-mono text-brand-light truncate max-w-[260px]">{envFile || 'server/.env'}</span></div>
        <div className="flex items-center justify-between py-1"><span className="text-gray-400">LLM 就绪</span><span className={checks?.openai_configured || checks?.minimax_configured ? 'text-emerald-400' : 'text-amber-400'}>{checks?.openai_configured ? 'OpenAI/DeepSeek 已配' : checks?.minimax_configured ? 'MiniMax 已配' : '未配置'}</span></div>
      </div>

      {/* 遗留提示 */}
      <div className="p-3 rounded-xl bg-surface-secondary border border-border text-[11px] text-gray-400 leading-relaxed">
        <span className="font-semibold text-white">提示：</span> 旧版 <code className="px-1 py-0.5 rounded bg-black/30 text-brand-light">image/voice/video</code> 引擎配置已收敛到“生成源 + 默认路由”，具体模型/参数请在生成源卡片编辑，Key 请在生成源编辑页填写。
      </div>
    </div>
  );
};
