import React from 'react';
import { ClipboardList, Image as ImageIcon, Film, Mic, AlertTriangle, ExternalLink, Copy, Check, Wand2, Lightbulb, FlaskConical, PackageCheck, Trash2 } from 'lucide-react';
import type { PlanPreview, CreatorProposal } from './agentTypes';

// 兼容旧引用：类型口径已收敛到 agentTypes.ts
export type { PlanStep, PlanPreview, CreatorProposal } from './agentTypes';

/** Plan预览卡：可编辑前置确认，高风险必须确认才执行 */
export const PlanCard: React.FC<{
  plan: PlanPreview;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
}> = ({ plan, onConfirm, onCancel, confirming }) => {
  const fmtEst = (s: number) => (s >= 60 ? `约${Math.round(s / 60)}分钟` : `约${s}s`);
  return (
    <div className="mt-2 rounded-xl border border-brand/30 bg-brand/5 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold text-brand-light">
        <ClipboardList className="w-3.5 h-3.5" />执行计划 · {plan.label}
        <span className={`ml-1 px-1.5 py-px rounded text-[10px] ${plan.risk === 'high' ? 'bg-red-500/20 text-red-300' : plan.risk === 'medium' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
          {plan.risk === 'high' ? '高风险·需确认' : plan.risk === 'medium' ? '中风险' : '低风险'}
        </span>
        <span className="ml-auto text-[10px] text-gray-500 font-normal">{fmtEst(plan.est_total_s)} · {plan.autonomy_hint || ''}</span>
      </div>
      <div className="border-t border-brand/10 divide-y divide-white/5">
        {plan.steps.map((s, i) => (
          <div key={s.id} className="px-2.5 py-1.5 flex items-center gap-2 text-[11px]">
            <span className="w-4 h-4 rounded-full bg-brand/20 text-brand-light text-[10px] flex items-center justify-center font-bold shrink-0">{i + 1}</span>
            <span className="text-gray-100 truncate flex-1">{s.title}</span>
            <span className="font-mono text-[10px] text-gray-500 truncate max-w-[140px]">{s.tool}</span>
            {s.target && <span className="text-[10px] text-gray-500 shrink-0">{s.target}</span>}
          </div>
        ))}
        {plan.steps.length === 0 && <div className="px-2.5 py-2 text-[11px] text-gray-500">纯问答，不调工具，零副作用。</div>}
      </div>
      {plan.needs_confirm && (
        <div className="px-2.5 py-2 flex gap-1.5 border-t border-brand/10 bg-surface-secondary">
          <button onClick={onConfirm} disabled={confirming} className="flex-1 py-1.5 rounded-lg bg-brand text-white text-[11px] font-bold hover:opacity-90 disabled:opacity-50">
            {confirming ? '执行中…' : '确认执行计划'}
          </button>
          <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-border text-[11px] text-gray-300">取消</button>
        </div>
      )}
    </div>
  );
};

/** 产物卡：图/视频/音频 inline 预览 + 一键应用到本镜 */
export const ArtifactCard: React.FC<{
  kind: 'image' | 'video' | 'audio';
  url: string;
  tool: string;
  label: string;
  shotLabel?: string;
  applied?: boolean;
  onApply?: () => void;
}> = ({ kind, url, tool, label, shotLabel, applied, onApply }) => {
  const [copied, setCopied] = React.useState(false);
  const doCopy = async () => {
    try { await navigator.clipboard.writeText(url); } catch {}
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  const full = url.startsWith('http') ? url : `http://127.0.0.1:8000${url.startsWith('/') ? '' : '/'}${url}`;
  return (
    <div className="mt-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-300">
        {kind === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : kind === 'video' ? <Film className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        {label} · <span className="font-mono font-normal text-gray-500">{tool}</span>
        {applied && <span className="ml-1 px-1.5 py-px rounded bg-emerald-500/20 text-[10px]">已应用{shotLabel || ''}</span>}
      </div>
      <div className="px-2.5 pb-2">
        {kind === 'image' && <img src={full} alt={label} className="w-full rounded-lg border border-white/10 max-h-56 object-contain bg-surface-secondary" loading="lazy" />}
        {kind === 'video' && <video src={full} controls className="w-full rounded-lg border border-white/10 max-h-56 bg-surface-secondary" />}
        {kind === 'audio' && <audio src={full} controls className="w-full h-8" />}
        <div className="flex gap-1.5 mt-1.5">
          {onApply && !applied && (
            <button onClick={onApply} className="flex-1 py-1 rounded-lg bg-emerald-500 text-black text-[11px] font-bold flex items-center justify-center gap-1">
              <Wand2 className="w-3 h-3" />应用到{shotLabel || '本镜'}
            </button>
          )}
          <button onClick={doCopy} className="px-2 py-1 rounded-lg border border-border text-[11px] text-gray-300 flex items-center gap-1">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}复制
          </button>
          <a href={full} target="_blank" rel="noreferrer" className="px-2 py-1 rounded-lg border border-border text-[11px] text-gray-300 flex items-center gap-1">
            <ExternalLink className="w-3 h-3" />打开
          </a>
        </div>
      </div>
    </div>
  );
};

/** 结构化错误卡：what/why/next */
export const ErrorCard: React.FC<{ what: string; why: string; next: string; onRetry?: () => void }> = ({ what, why, next, onRetry }) => (
  <div className="mt-2 rounded-xl border border-red-500/30 bg-red-500/5 p-2.5 text-[11px] leading-5">
    <div className="font-bold text-red-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{what}</div>
    <div className="text-gray-400 mt-1"><span className="text-gray-500">原因：</span>{why}</div>
    <div className="text-gray-300"><span className="text-gray-500">下一步：</span>{next}</div>
    {onRetry && <button onClick={onRetry} className="mt-1.5 px-2.5 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-200 text-[11px] font-bold">换源重试</button>}
  </div>
);

/** Creator 能力提案卡：临时提案，需人 Start 试跑，试跑后 persist 真写生产（备份+回滚）/discard/rollback */
export const CapabilityProposalCard: React.FC<{
  proposal: CreatorProposal;
  busy?: string | null;
  onStart: () => void;
  onFinalize: (action: 'persist' | 'discard' | 'rollback') => void;
}> = ({ proposal, busy, onStart, onFinalize }) => (
  <div className="mt-2 rounded-xl border border-violet-500/30 bg-violet-500/5 overflow-hidden">
    <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold text-violet-300">
      <Lightbulb className="w-3.5 h-3.5" />能力提案 · {proposal.title}
      <span className="ml-1 px-1.5 py-px rounded bg-violet-500/20 text-[10px] font-mono">{proposal.kind}</span>
      <span className="ml-auto text-[10px] font-normal text-gray-500">{proposal.status}</span>
    </div>
    <div className="px-2.5 pb-2 text-[11px] leading-5 text-gray-300">
      <div className="font-mono text-[10px] text-gray-500 break-all">{proposal.proposal_id}</div>
      <div className="mt-1 text-gray-200">{proposal.diff_preview}</div>
      <div className="mt-1 text-[10px] text-gray-500">试跑计划：{(proposal.test_plan || []).join(' → ')}</div>
      <div className="mt-0.5 text-[10px] text-gray-500">可逆性：{proposal.reversible}</div>
      <div className="flex gap-1.5 mt-2">
        <button onClick={onStart} disabled={!!busy} className="flex-1 py-1.5 rounded-lg bg-violet-500 text-white text-[11px] font-bold disabled:opacity-50 flex items-center justify-center gap-1">
          <FlaskConical className="w-3 h-3" />{busy === 'start' ? '试跑中…' : 'Start 试跑（只读/小参）'}
        </button>
        <button onClick={() => onFinalize('persist')} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg border border-violet-500/40 text-violet-200 text-[11px] font-bold disabled:opacity-50 flex items-center gap-1">
          <PackageCheck className="w-3 h-3" />{busy === 'persist' ? '…' : '持久化'}
        </button>
        {proposal.status === 'persisted' ? (
          <button onClick={() => onFinalize('rollback')} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-200 text-[11px] font-bold disabled:opacity-50 flex items-center gap-1">
            {busy === 'rollback' ? '…' : '回滚'}
          </button>
        ) : (
          <button onClick={() => onFinalize('discard')} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg border border-border text-[11px] text-gray-400 disabled:opacity-50 flex items-center gap-1">
            <Trash2 className="w-3 h-3" />{busy === 'discard' ? '…' : '丢弃'}
          </button>
        )}
      </div>
      <div className="mt-1 text-[10px] text-gray-600">持久化=备份→写入→热重载→试跑（失败自回滚）；丢弃即卸载，已发生的外部计费不可逆。</div>
    </div>
  </div>
);
