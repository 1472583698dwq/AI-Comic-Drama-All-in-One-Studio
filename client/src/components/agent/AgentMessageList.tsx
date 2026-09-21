/**
 * Agent 消息列表 — 页面与抽屉共用（含思考推演/计划模式执行按钮/产物卡/错误卡/工具步骤/建议）
 * 工具步骤与待办走 IDE 风格卡片（AgentToolSteps / AgentTodoPanel），审批行内完成。
 */
import React, { useState } from 'react';
import {
  Bot, User, Sparkles, ChevronDown, Check, Copy, Pencil, X,
} from 'lucide-react';
import { MarkdownText } from './MarkdownText';
import { ArtifactCard, CapabilityProposalCard, ErrorCard } from './AgentCards';
import { AgentToolSteps, AgentTodoPanel } from './AgentToolSteps';
import type { ApprovalInfo, ChatMsg } from './agentTypes';

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
}) => {
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

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

        return (
          <div key={m.id} className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`${compact ? 'max-w-[92%] p-3' : 'max-w-[85%] p-4'} rounded-2xl leading-relaxed text-xs relative group/msg ${
                m.sender === 'user'
                  ? 'bg-brand text-white rounded-br-none'
                  : 'bg-surface-secondary border border-border text-gray-100 rounded-bl-none'
              }`}
            >
              {!compact && (
                <div className="flex items-center gap-1.5 mb-1.5 text-[10px] text-gray-500">
                  {m.sender === 'user' ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3 text-brand-light" />}
                  <span>{m.sender === 'user' ? '你' : 'Agent'}</span>
                  {m.mode && (
                    <span className={`px-1.5 py-px rounded font-bold ${m.mode === 'execute' ? 'bg-brand/20 text-brand-light' : 'bg-accent-green/20 text-accent-green'}`}>
                      {m.mode === 'execute' ? '执行' : '问答'}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {m.sender === 'user' && !isRunning && (
                      <button
                        onClick={(e) => startEdit(e, m.id, m.text)}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white"
                        title="编辑并重新发送"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                    <span>{m.time}</span>
                  </span>
                </div>
              )}

              {compact && m.text && (
                <button
                  onClick={(e) => copyMsg(e, m.id, m.text)}
                  className="absolute top-1.5 right-1.5 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-surface/85 hover:bg-surface/85 text-white/70 hover:text-white"
                  title="复制本条消息"
                >
                  {copiedId === m.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              )}
              {compact && m.sender === 'user' && !isRunning && (
                <button
                  onClick={(e) => startEdit(e, m.id, m.text)}
                  className="absolute top-1.5 right-8 p-1 rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity bg-surface/85 text-white/70 hover:text-white"
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
                    <span className="flex items-center gap-1 text-[10px] text-gray-400 font-normal">
                      <span>{thinkingOpen ? '收起' : '展开'}</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${thinkingOpen ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                  {thinkingOpen && (
                    <div className="px-3 py-2 border-t border-brand/15 text-[11px] leading-relaxed text-gray-300 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto custom-scrollbar select-text bg-surface-secondary">
                      {m.thinking || (m.isThinkingStreaming ? '正在感知导演意图与分析分镜机位…' : '')}
                      {m.isThinkingStreaming && <span className="inline-block w-1.5 h-3.5 bg-brand ml-1 animate-pulse align-middle" />}
                    </div>
                  )}
                </div>
              )}

              {isAgent ? (
                <MarkdownText text={m.text || (isPlaceholder ? '思考中…' : '')} />
              ) : isEditing ? (
                <div className="space-y-1.5 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={Math.min(8, Math.max(2, editText.split('\n').length))}
                    autoFocus
                    className="w-full bg-surface border border-brand/50 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none resize-none"
                  />
                  <div className="flex gap-1.5 justify-end">
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2.5 py-1 rounded-lg border border-white/20 text-[11px] text-gray-200 flex items-center gap-1"
                    >
                      <X className="w-3 h-3" />取消
                    </button>
                    <button
                      onClick={submitEdit}
                      disabled={!editText.trim()}
                      className="px-2.5 py-1 rounded-lg bg-white text-brand text-[11px] font-bold disabled:opacity-40"
                    >
                      修改并重发
                    </button>
                  </div>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">{m.text}</div>
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
                  <div className="mt-1.5 text-[10px] text-emerald-300">✓ 计划已批准，正在执行…</div>
                ) : (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => onExecutePlan(m.id)}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white text-[11px] font-bold hover:opacity-90"
                    >
                      按此计划执行
                    </button>
                    <span className="text-[10px] text-gray-500">或继续输入，让 Agent 修订计划</span>
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
                      className="px-2 py-1 rounded-full bg-surface border border-border text-[10px] text-gray-300 hover:border-brand hover:text-white"
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
    </>
  );
};
