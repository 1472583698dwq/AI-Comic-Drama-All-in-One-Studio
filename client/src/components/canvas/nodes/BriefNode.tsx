import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { BookOpen, Sparkles } from 'lucide-react';
import { AiPolishButton } from '../../ui/AiPolishButton';

export const BriefNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  return (
    <div className="w-[320px] bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-white/60 dark:bg-white/[.05] border-b border-white/70 dark:border-white/12 flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 flex items-center justify-center"><BookOpen className="w-3.5 h-3.5 text-amber-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">灵感简报</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-white/55 dark:bg-white/[.06] [color:var(--color-text-muted)] border border-white/70 dark:border-white/12 font-mono">{d.style_preset || 'donghua_xianxia'}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} className="!bg-brand !w-3 !h-3 !border-2 !border-surface" id="brief"/>
      <div className="p-3 space-y-2">
        <div className="flex justify-end">
          <AiPolishButton value={d.brief || ''} onPolish={(v: any) => (d.onUpdate as any)?.(id, { brief: v })} contextType="general" size="xs" label="AI 润色简报" />
        </div>
        <textarea value={d.brief || ''} onChange={e=> (d.onUpdate as any)?.(id,{brief:e.target.value})} placeholder="粘贴小说/策划简报… 将连到 剧本拆解节点" rows={5} className="w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl p-2.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] leading-relaxed focus:outline-none focus:border-brand resize-none"/>
        <div className="flex gap-1.5">
          <select value={d.style_preset || 'donghua_xianxia'} onChange={e=> (d.onUpdate as any)?.(id,{style_preset:e.target.value})} className="flex-1 bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
            <option value="donghua_xianxia">国漫仙侠</option>
            <option value="japanese_anime">日式二次元</option>
            <option value="modern_webtoon">韩漫条漫</option>
            <option value="cinematic_3d">影视3D</option>
            <option value="dark_comic">暗黑漫画</option>
          </select>
          <select value={d.aspect_ratio || '9:16'} onChange={e=> (d.onUpdate as any)?.(id,{aspect_ratio:e.target.value})} className="bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
            <option value="9:16">9:16</option><option value="16:9">16:9</option><option value="1:1">1:1</option>
          </select>
        </div>
        <div className="text-[10px] [color:var(--color-text-muted)] flex items-center gap-1"><Sparkles className="w-3 h-3 text-brand"/> 拖出连线到「剧本拆解」节点</div>
      </div>
    </div>
  );
};

export const ScriptSplitNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  return (
    <div className="w-[320px] bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-white/60 dark:bg-white/[.05] border-b border-white/70 dark:border-white/12 flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 flex items-center justify-center"><Sparkles className="w-3.5 h-3.5 text-brand"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">剧本拆解 (LLM)</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-amber-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="target" position={Position.Top} id="brief" className="!bg-amber-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Right} className="!bg-brand !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="shots" className="!bg-pink-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        <div className="text-[11px] [color:var(--color-text-secondary)]">输入简报 → 输出角色/分镜，真实调用 <code className="bg-white/55 dark:bg-white/[.06] px-1 py-0.5 rounded border border-white/70 dark:border-white/12 font-mono text-[10px]">split_novel_script</code></div>
        <button onClick={()=> (d.onExecute as any)?.(id)} disabled={!!d.loading} className="w-full py-2.5 rounded-xl bg-brand hover:bg-brand-light text-white text-xs font-bold disabled:opacity-40 shadow-sm transition-colors">
          {d.loading ? '拆解中…' : '一键拆解并生成分镜卡'}
        </button>
        {d.error && <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg p-2">{d.error}</div>}
        {d.result && <div className="text-[11px] text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-2">✓ {d.result.characters?.length||0} 角色 · {d.result.scenes?.[0]?.shots?.length||0} 镜 已生成，连到分镜卡</div>}
      </div>
    </div>
  );
};
