import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { BookOpen, Sparkles } from 'lucide-react';

export const BriefNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  return (
    <div className="w-[320px] bg-[#1A1A22] border border-[#2A2A32] rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-b border-[#2A2A32] flex items-center gap-1.5">
        <BookOpen className="w-3.5 h-3.5 text-amber-400"/><span className="text-xs font-bold text-white">灵感简报</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-gray-300">{d.style_preset || 'donghua_xianxia'}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-amber-400 !w-2 !h-2"/>
      <Handle type="source" position={Position.Bottom} className="!bg-brand !w-2 !h-2" id="brief"/>
      <div className="p-3 space-y-2">
        <textarea value={d.brief || ''} onChange={e=> (d.onUpdate as any)?.(id,{brief:e.target.value})} placeholder="粘贴小说/策划简报… 将连到 剧本拆解节点" rows={5} className="w-full bg-[#24242F] border border-[#2A2A32] rounded-xl p-2.5 text-xs text-white placeholder-gray-500 leading-relaxed focus:outline-none focus:border-brand"/>
        <div className="flex gap-1.5">
          <select value={d.style_preset || 'donghua_xianxia'} onChange={e=> (d.onUpdate as any)?.(id,{style_preset:e.target.value})} className="flex-1 bg-[#24242F] border border-[#2A2A32] rounded-xl px-2 py-1 text-xs text-white">
            <option value="donghua_xianxia">国漫仙侠</option>
            <option value="japanese_anime">日式二次元</option>
            <option value="modern_webtoon">韩漫条漫</option>
            <option value="cinematic_3d">影视3D</option>
            <option value="dark_comic">暗黑漫画</option>
          </select>
          <select value={d.aspect_ratio || '9:16'} onChange={e=> (d.onUpdate as any)?.(id,{aspect_ratio:e.target.value})} className="bg-[#24242F] border border-[#2A2A32] rounded-xl px-2 py-1 text-xs text-white">
            <option value="9:16">9:16</option><option value="16:9">16:9</option><option value="1:1">1:1</option>
          </select>
        </div>
        <div className="text-[10px] text-gray-500 flex items-center gap-1"><Sparkles className="w-3 h-3"/> 拖出连线到「剧本拆解」节点</div>
      </div>
    </div>
  );
};

export const ScriptSplitNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  return (
    <div className="w-[320px] bg-[#1A1A22] border-2 border-brand/40 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-brand/20 border-b border-brand/30 flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5 text-brand-light"/><span className="text-xs font-bold text-white">剧本拆解 (MiniMax LLM)</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-amber-400 !w-2 !h-2"/>
      <Handle type="target" position={Position.Top} id="brief" className="!bg-amber-400 !w-2 !h-2"/>
      <Handle type="source" position={Position.Right} className="!bg-brand !w-2 !h-2"/>
      <Handle type="source" position={Position.Bottom} id="shots" className="!bg-accent-pink !w-2 !h-2"/>
      <div className="p-3 space-y-2">
        <div className="text-[11px] text-gray-400">输入简报 → 输出角色/分镜，真实调用 <code className="bg-black/30 px-1 rounded">split_novel_script</code></div>
        <button onClick={()=> (d.onExecute as any)?.(id)} disabled={!!d.loading} className="w-full py-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold disabled:opacity-40">
          {d.loading ? '拆解中…' : '一键拆解并生成分镜卡'}
        </button>
        {d.error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2">{d.error}</div>}
        {d.result && <div className="text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded-lg p-2">✓ {d.result.characters?.length||0} 角色 · {d.result.scenes?.[0]?.shots?.length||0} 镜 已生成，连到分镜卡</div>}
      </div>
    </div>
  );
};
