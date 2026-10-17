/**
 * Agent 消息列表 — 页面与抽屉共用（含思考推演/计划模式执行按钮/产物卡/错误卡/工具步骤/建议）
 * 工具步骤与待办走 IDE 风格卡片（AgentToolSteps / AgentTodoPanel），审批行内完成。
 */
import React, { useState } from 'react';
import {
  Sparkles, ChevronDown, Check, Copy, Pencil, X, Music,
} from 'lucide-react';
import { MarkdownText } from './MarkdownText';
import { ArtifactCard, CapabilityProposalCard, ErrorCard, QuestionCard } from './AgentCards';
import { AgentToolSteps, AgentTodoPanel } from './AgentToolSteps';
import { API_ORIGIN } from '../../utils/devOrigin';
import type { AgentAttachment, ApprovalInfo, ChatMsg, QuestionInfo } from './agentTypes';

const resolveMediaUrl = (u?: string) => (!u ? '' : (u.startsWith('/') ? API_ORIGIN + u : u));

/** 用户消息里的附件预览（图=缩略图可点开；视频/音频=原生播放器） */
const UserAttachment: React.FC<{ att: AgentAttachment }> = ({ att }) => {
  const url = resolveMediaUrl(att.ref);
  if (att.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" title={att.name}
        className="block w-20 h-20 rounded-xl overflow-hidden border border-black/10 dark:border-white/20 hover:border-brand transition-colors bg-black/[.06] dark:bg-black/20">
        <img src={url} alt={att.name} className="w-full h-full object-cover" loading="lazy" />
      </a>
    );
  }
  if (att.kind === 'video') {
    return (
      <div className="rounded-xl overflow-hidden border border-black/10 dark:border-white/20 bg-black/[.06] dark:bg-black/20" title={att.name}>
        <video src={url} controls preload="metadata" className="w-44 max-h-28" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/[.06] dark:bg-black/20 border border-black/10 dark:border-white/20 max-w-[220px]" title={att.name}>
      <Music className="w-3 h-3 shrink-0 [color:var(--color-text-muted)]" />
      <audio src={url} controls preload="none" className="h-7" />
    </div>
  );
};

export { UserAttachment };

export interface AgentMessageListProps {
  messages: ChatMsg[];
  compact?: boolean;
  isRunning?: boolean;
  activeShotIndex?: number;
  onSendSuggestion: (text: string) => void;
  onExecutePlan: (msgId: string) => void;
  onProposalAction: (msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback') => void;
  proposalBusy: Record<string, string>;
  onApplyArtifact: (msgId: string, index: number) => void;
  /** 行内审批所需：待确认清单、始终允许表、审批回调 */
  approvals?: Record<string, ApprovalInfo>;
  autoAllowTools?: Record<string, boolean>;
  onApprove?: (aid: string, ok: boolean, always: boolean) => void;
  /** 模型问询卡（ask_user_question）：待答清单 + 回答回调 */
  questions?: Record<string, QuestionInfo>;
  onAnswerQuestion?: (qid: string, selections: string[], custom?: string) => void;
}

export const AgentMessageList: React.FC<AgentMessageListProps> = ({
  messages,
  compact,
  isRunning,
  activeShotIndex,
  onSendSuggestion,
  onExecutePlan,
  onProposalAction,
  proposalBusy,
  onApplyArtifact,
  approvals,
  autoAllowTools,
  onApprove,
  questions,
  onAnswerQuestion,
}) => {
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  /** 长文本（粘贴/超长）展开态：默认折叠为摘要 */
  const [expandedLong, setExpandedLong] = useState<Record<string, boolean>>({});

  const copyMsg = async (e: React.MouseEvent, id: string, text: string) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopiedId(id);
    setTimeout(() => setCopiedId((v) => (v === id ? null : v)), 1200);
  };

  // 用户消息编辑重发（Zed/Cline 式：改完作为新一轮发出）
  const startEdit = (e: React.MouseEvent, id: string, text: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditText(text);
  };
  const submitEdit = () => {
    const t = editText.trim();
    setEditingId(null);
    if (t) onSendSuggestion(t);
  };

  return (
    <>
      {messages.map((m) => {
        const isAgent = m.sender === 'agent';
        const hasThinking = isAgent && !!(m.thinking || m.isThinkingStreaming);
        // IDE 式：思考过程默认折叠（流式进行中保持展开），不与正文混排
        const thinkingOpen = expandedThinking[m.id] !== undefined ? expandedThinking[m.id] : !!m.isThinkingStreaming;
        const isPlaceholder = isAgent && isRunning && !m.text && !m.thinking;
        const isEditing = editingId === m.id;
        // 长文本折叠：粘贴产生的长文（或超过 2000 字的用户消息）默认只显示摘要
        const isLongUser = !isAgent && !!m.text && (m.pastedBulk || m.text.length > 2000);
        const longOpen = !!expandedLong[m.id];

        return (
          <div key={m.id} className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`relative group/msg leading-[1.7] ${
                compact
                  ? `max-w-[92%] p-3 rounded-2xl text-[13px] ${isAgent ? 'bg-surface/80 [color:var(--color-text-main)]' : 'bg-brand/15 border border-brand/25 [color:var(--color-text-main)]'}`
                  : isAgent
                    // 页面版：助手回复去气泡化——通栏正文直接铺在背景上（ChatGPT/Claude 式），
                    // 只有用户的输入保留一个浅色块，让「谁说的」靠位置和底色就能区分。
                    ? 'w-full min-w-0 text-sm [color:var(--color-text-main)]'
                    : 'max-w-[85%] px-3.5 py-2.5 rounded-2xl bg-brand/15 border border-brand/25 text-sm [color:var(--color-text-main)]'
              }`}
            >
              {/* 用户消息编辑重发入口：气泡内悬浮按钮（浮在右上角外侧，不占气泡内空间） */}
              {!compact && m.sender === 'user' && !isRunning && (
                <button
                  onClick={(e) => startEdit(e, m.id, m.text)}
                  className="absolute -top-2.5 -right-2 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-surface border border-border [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] shadow-sm"
                  title="编辑并重新发送"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}

              {compact && m.text && (
                <button
                  onClick={(e) => copyMsg(e, m.id, m.text)}
                  className="absolute top-1.5 right-1.5 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-surface border border-border [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]"
                  title="复制本条消息"
                >
                  {copiedId === m.id ? <Check className="w-3 h-3 text-emerald-500 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              )}
              {compact && m.sender === 'user' && !isRunning && (
                <button
                  onClick={(e) => startEdit(e, m.id, m.text)}
                  className="absolute top-1.5 right-8 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-surface border border-border [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]"
                  title="编辑并重新发送"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}

              {hasThinking && (
                <div className={`${compact ? 'mb-2.5' : 'mb-3'} rounded-xl border border-brand/30 bg-brand/5 overflow-hidden`}>
                  <button
                    type="button"
                    onClick={() => setExpandedThinking((prev) => ({ ...prev, [m.id]: !thinkingOpen }))}
                    className="w-full px-3 py-1.5 flex items-center justify-between text-[11px] font-bold text-brand-light hover:bg-brand/10 transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles className={`w-3.5 h-3.5 text-brand ${m.isThinkingStreaming ? 'animate-spin' : ''}`} />
                      <span>{m.isThinkingStreaming ? '思考推演中…' : '思考过程'}</span>
                    </span>
                    <span className="flex items-center gap-1 text-[10px] [color:var(--color-text-main)] font-normal">
                      <span>{thinkingOpen ? '收起' : '展开'}</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${thinkingOpen ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                  {thinkingOpen && (
                    <div className="px-3 py-2 border-t border-brand/15 text-[11px] leading-relaxed [color:var(--color-text-main)] font-mono whitespace-pre-wrap max-h-60 overflow-y-auto custom-scrollbar select-text bg-surface/80">
                      {m.thinking || (m.isThinkingStreaming ? '正在感知导演意图与分析分镜机位…' : '')}
                      {m.isThinkingStreaming && <span className="inline-block w-1.5 h-3.5 bg-brand ml-1 animate-pulse align-middle" />}
                    </div>
                  )}
                </div>
              )}

              {/* 用户消息携带的多模态附件（图/视频/音频） */}
              {!isAgent && (m.attachments?.length || 0) > 0 && (
                <div className={`flex flex-wrap gap-1.5 ${m.text ? 'mb-2' : ''}`}>
                  {m.attachments!.map((a) => (
                    <UserAttachment key={a.id} att={a} />
                  ))}
                </div>
              )}

              {isAgent ? (
                // 阅读行宽收在 ~68ch（与容器宽度解耦）：长回复不会一行拉到屏幕边缘
                <MarkdownText text={m.text || (isPlaceholder ? '思考中…' : '')} className={compact ? undefined : 'max-w-[68ch]'} />
              ) : isEditing ? (
                <div className="space-y-1.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={Math.min(8, Math.max(2, editText.split('\n').length))}
                    autoFocus
                    className="w-full bg-surface/80 border border-brand/50 rounded-lg px-2 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none resize-none"
                  />
                  <div className="flex gap-1.5 justify-end">
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2.5 py-1 rounded-lg border border-brand/40 text-[11px] [color:var(--color-text-main)] flex items-center gap-1"
                    >
                      <X className="w-3 h-3" />取消
                    </button>
                    <button
                      onClick={submitEdit}
                      disabled={!editText.trim()}
                      className="px-2.5 py-1 rounded-lg bg-brand text-white text-[11px] font-bold disabled:opacity-40"
                    >
                      修改并重发
                    </button>
                  </div>
                </div>
              ) : isLongUser && !longOpen ? (
                <div className="whitespace-pre-wrap">
                  {m.text.slice(0, 400)}
                  <span className="opacity-70">…</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedLong((prev) => ({ ...prev, [m.id]: true })); }}
                    className="ml-1.5 px-1.5 py-0.5 rounded-md bg-brand/15 hover:bg-brand/25 text-[10px] font-bold align-middle"
                    title="展开全文"
                  >
                    展开全文（{m.text.length.toLocaleString()} 字）
                  </button>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">
                  {m.text}
                  {isLongUser && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setExpandedLong((prev) => { const n = { ...prev }; delete n[m.id]; return n; }); }}
                      className="ml-1.5 px-1.5 py-0.5 rounded-md bg-brand/15 hover:bg-brand/25 text-[10px] font-bold align-middle"
                      title="收起长文"
                    >
                      收起
                    </button>
                  )}
                </div>
              )}

              {isAgent && (m.plan as any)?.creator_proposal && (
                <CapabilityProposalCard
                  proposal={(m.plan as any).creator_proposal}
                  busy={proposalBusy[(m.plan as any).creator_proposal.proposal_id] || null}
                  onStart={() => onProposalAction(m.id, (m.plan as any).creator_proposal.proposal_id, 'start')}
                  onFinalize={(a) => onProposalAction(m.id, (m.plan as any).creator_proposal.proposal_id, a)}
                />
              )}
              {isAgent && m.planMode && m.text && !m.isThinkingStreaming && (
                m.planExecuted ? (
                  <div className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">✓ 计划已批准，正在执行…</div>
                ) : (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => onExecutePlan(m.id)}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white text-[11px] font-bold hover:opacity-90"
                    >
                      按此计划执行
                    </button>
                    <span className="text-[10px] [color:var(--color-text-main)]">或继续输入，让 Agent 修订计划</span>
                  </div>
                )
              )}

              {(m.artifacts?.length || 0) > 0 && (
                <div className="space-y-1.5">
                  {m.artifacts!.map((a, i) => (
                    <ArtifactCard
                      key={`${m.id}-a${i}-${a.url.slice(-16)}`}
                      kind={a.kind}
                      url={a.url}
                      tool={a.tool}
                      label={a.label}
                      shotLabel={activeShotIndex ? `#${activeShotIndex}` : undefined}
                      applied={a.applied}
                      onApply={activeShotIndex ? () => onApplyArtifact(m.id, i) : undefined}
                    />
                  ))}
                </div>
              )}

              {(m.errors?.length || 0) > 0 && (
                <div className="space-y-1.5">
                  {m.errors!.map((e, i) => (
                    <ErrorCard key={`${m.id}-e${i}`} what={e.what} why={e.why} next={e.next} />
                  ))}
                </div>
              )}

              {(m.steps?.length || 0) > 0 && (
                <AgentToolSteps
                  steps={m.steps!}
                  approvals={approvals || {}}
                  autoAllowTools={autoAllowTools || {}}
                  onApprove={onApprove || (() => {})}
                />
              )}

              {isAgent && m.todo && m.todo.length > 0 && <AgentTodoPanel todo={m.todo} />}

              {m.suggested && m.suggested.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.suggested.map((s) => (
                    <button
                      key={s}
                      onClick={() => onSendSuggestion(s)}
                      className="px-2 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-[10px] [color:var(--color-text-main)] hover:border-brand"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {/* 模型问询卡：附在消息流末尾（已回答的保留只读，供回看） */}
      {questions && Object.entries(questions).map(([qid, q]) => (
        <div key={qid} className="flex justify-start">
          <div className={`${compact ? 'max-w-[92%]' : 'max-w-[85%]'} w-full`}>
            <QuestionCard
              question={q.question}
              options={q.options || []}
              multiSelect={q.multi_select}
              detail={q.detail}
              answered={q.answered}
              onAnswer={(sels, custom) => onAnswerQuestion?.(qid, sels, custom)}
            />
          </div>
        </div>
      ))}
    </>
  );
};
