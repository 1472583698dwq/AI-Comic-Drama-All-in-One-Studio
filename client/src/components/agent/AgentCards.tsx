import React from 'react';
import { Image as ImageIcon, Film, Mic, AlertTriangle, ExternalLink, Copy, Check, Wand2, Lightbulb, FlaskConical, PackageCheck, Trash2 } from 'lucide-react';
import type { CreatorProposal } from './agentTypes';
import { resolveMediaUrl } from '../../utils/devOrigin';

// 兼容旧引用：类型口径已收敛到 agentTypes.ts
export type { PlanStep, PlanPreview, CreatorProposal } from './agentTypes';

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
  const full = resolveMediaUrl(url.startsWith('/') ? url : `/${url}`);
  return (
    <div className="mt-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
        {kind === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : kind === 'video' ? <Film className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        {label} · <span className="font-mono font-normal [color:var(--color-text-muted)]">{tool}</span>
        {applied && <span className="ml-1 px-1.5 py-px rounded bg-emerald-500/20 text-[10px]">已应用{shotLabel || ''}</span>}
      </div>
      <div className="px-2.5 pb-2">
        {kind === 'image' && <img src={full} alt={label} className="w-full rounded-lg border border-white/10 max-h-56 object-contain bg-white/55 dark:bg-white/[.06]" loading="lazy" />}
        {kind === 'video' && <video src={full} controls className="w-full rounded-lg border border-white/10 max-h-56 bg-white/55 dark:bg-white/[.06]" />}
        {kind === 'audio' && <audio src={full} controls className="w-full h-8" />}
        <div className="flex gap-1.5 mt-1.5">
          {onApply && !applied && (
            <button onClick={onApply} className="flex-1 py-1 rounded-lg bg-emerald-500 text-black text-[11px] font-bold flex items-center justify-center gap-1">
              <Wand2 className="w-3 h-3" />应用到{shotLabel || '本镜'}
            </button>
          )}
          <button onClick={doCopy} className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-[11px] [color:var(--color-text-main)] flex items-center gap-1">
            {copied ? <Check className="w-3 h-3 text-emerald-500 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}复制
          </button>
          <a href={full} target="_blank" rel="noreferrer" className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-[11px] [color:var(--color-text-main)] flex items-center gap-1">
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
    <div className="font-bold text-red-600 dark:text-red-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{what}</div>
    <div className="[color:var(--color-text-secondary)] mt-1"><span className="[color:var(--color-text-muted)]">原因：</span>{why}</div>
    <div className="[color:var(--color-text-main)]"><span className="[color:var(--color-text-muted)]">下一步：</span>{next}</div>
    {onRetry && <button onClick={onRetry} className="mt-1.5 px-2.5 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-700 dark:text-red-200 text-[11px] font-bold">换源重试</button>}
  </div>
);

/** Creator 能力提案状态中文口径（卡头展示） */
const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  proposed: '待试跑', testing: '试跑中…', tested: '试跑通过', test_failed: '试跑未通过',
  persisted: '已持久化', discarded: '已丢弃', rolled_back: '已回滚', needs_manual: '需人工接入',
};

/** Creator 能力提案卡：临时提案，需人 Start 试跑，试跑后 persist 真写生产（备份+回滚）/discard/rollback */
export const CapabilityProposalCard: React.FC<{
  proposal: CreatorProposal;
  busy?: string | null;
  onStart: () => void;
  onFinalize: (action: 'persist' | 'discard' | 'rollback') => void;
}> = ({ proposal, busy, onStart, onFinalize }) => {
  const status = proposal.status || 'proposed';
  const isPersisted = status === 'persisted';
  const canStart = !busy && !isPersisted && status !== 'discarded';
  const canPersist = !busy && status === 'tested';
  return (
  <div className="mt-2 rounded-xl border border-violet-500/30 bg-violet-500/5 overflow-hidden">
    <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold text-violet-600 dark:text-violet-300">
      <Lightbulb className="w-3.5 h-3.5" />能力提案 · {proposal.title}
      <span className="ml-1 px-1.5 py-px rounded bg-violet-500/20 text-[10px] font-mono">{proposal.kind}</span>
      <span className={`ml-auto text-[10px] font-normal ${isPersisted ? 'text-emerald-500 dark:text-emerald-400' : '[color:var(--color-text-muted)]'}`}>{PROPOSAL_STATUS_LABEL[status] || status}</span>
    </div>
    <div className="px-2.5 pb-2 text-[11px] leading-5 [color:var(--color-text-main)]">
      <div className="font-mono text-[10px] [color:var(--color-text-muted)] break-all">{proposal.proposal_id}</div>
      <div className="mt-1 [color:var(--color-text-main)]">{proposal.diff_preview}</div>
      <div className="mt-1 text-[10px] [color:var(--color-text-muted)]">试跑计划：{(proposal.test_plan || []).join(' → ')}</div>
      <div className="mt-0.5 text-[10px] [color:var(--color-text-muted)]">可逆性：{proposal.reversible}</div>
      <div className="flex gap-1.5 mt-2">
        <button
          onClick={onStart}
          disabled={!canStart}
          title={isPersisted ? '已持久化，如需调整请重新提案' : '只读/小参试跑，不写生产'}
          className="flex-1 py-1.5 rounded-lg bg-violet-500 text-white text-[11px] font-bold disabled:opacity-50 flex items-center justify-center gap-1"
        >
          <FlaskConical className="w-3 h-3" />{busy === 'start' ? '试跑中…' : 'Start 试跑（只读/小参）'}
        </button>
        <button
          onClick={() => onFinalize('persist')}
          disabled={!canPersist}
          title={canPersist ? '真写生产：备份→写入→热重载→试跑（失败自回滚）' : '需先点 Start 试跑通过后才能持久化'}
          className="px-2.5 py-1.5 rounded-lg border border-violet-500/40 text-violet-700 dark:text-violet-200 text-[11px] font-bold disabled:opacity-50 flex items-center gap-1"
        >
          <PackageCheck className="w-3 h-3" />{busy === 'persist' ? '…' : '持久化'}
        </button>
        {isPersisted ? (
          <button onClick={() => onFinalize('rollback')} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-700 dark:text-amber-200 text-[11px] font-bold disabled:opacity-50 flex items-center gap-1">
            {busy === 'rollback' ? '…' : '回滚'}
          </button>
        ) : (
          <button onClick={() => onFinalize('discard')} disabled={!!busy} className="px-2.5 py-1.5 rounded-lg border border-white/70 dark:border-white/12 text-[11px] [color:var(--color-text-secondary)] disabled:opacity-50 flex items-center gap-1">
            <Trash2 className="w-3 h-3" />{busy === 'discard' ? '…' : '丢弃'}
          </button>
        )}
      </div>
      <div className="mt-1 text-[10px] [color:var(--color-text-muted)]">持久化=备份→写入→热重载→试跑（失败自回滚）；丢弃即卸载，已发生的外部计费不可逆。</div>
    </div>
  </div>
  );
};
