/**
 * Agent 输入区 — 页面与抽屉共用（Enter 发送；运行中 Enter 插话 Steer，停止走独立按钮）
 * IDE 式：运行中允许插话进入下一轮，不打断已产出；暂停是显式动作。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, MessageSquarePlus } from 'lucide-react';
import type { AgentMode, BehaviorMode, ExecutionMode, WsStatus } from './agentTypes';

export interface AgentComposerProps {
  mode: AgentMode;
  /** 行为维度：标准/创造/计划 */
  behavior?: BehaviorMode;
  /** 执行维度：审批/自动 */
  execution?: ExecutionMode;
  isRunning: boolean;
  wsStatus: WsStatus;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** 运行中插话（steer）：不填则回退为暂停 */
  onSteer?: (text: string) => void;
  /** 输入框内两个维度各自循环切换（IDE 式；不填则不显示） */
  onCycleMode?: () => void;
  onCycleBehavior?: () => void;
  onCycleExecution?: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}

const BEHAVIOR_META: Record<BehaviorMode, { label: string; cls: string }> = {
  standard: { label: '标准', cls: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
  create: { label: '创造', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  plan: { label: '计划', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
};

const EXECUTION_META: Record<ExecutionMode, { label: string; cls: string }> = {
  approve: { label: '审批', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  auto: { label: '自动', cls: 'bg-brand/15 text-brand-light border-brand/40' },
};

export const AgentComposer: React.FC<AgentComposerProps> = ({
  mode,
  behavior = 'standard',
  execution = 'approve',
  isRunning,
  wsStatus,
  onSend,
  onAbort,
  onSteer,
  onCycleMode,
  onCycleBehavior,
  onCycleExecution,
  compact,
  autoFocus,
}) => {
  const [input, setInput] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const text = input.trim();
    if (isRunning) {
      // 运行中：有插话通道则投进下一轮，否则暂停
      if (onSteer) {
        if (!text) return;
        onSteer(text);
        setInput('');
      } else {
        onAbort();
      }
      return;
    }
    if (!text) return;
    onSend(text);
    setInput('');
  };

  const placeholder = isRunning && onSteer
    ? '运行中：输入补充指令后回车插话（进入下一轮，不打断已产出）'
    : behavior === 'plan'
      ? '计划模式：只读侦察并产出完整计划，如“分析当前项目给出制作计划”'
      : mode === 'chat'
        ? '问答模式：只讲解不生成，如“首尾帧和参考图有什么区别？”'
        : execution === 'auto'
          ? '执行模式（自动）：全部工具自动执行不弹确认，如“把画布现有节点全量执行一遍”'
          : '执行模式（审批）：变异动作先确认，如“为当前镜头规划特写推镜并配音”';

  const bm = BEHAVIOR_META[behavior] || BEHAVIOR_META.standard;
  const em = EXECUTION_META[execution] || EXECUTION_META.approve;
  return (
    <div className={compact ? '' : 'p-4 border-t border-border bg-surface shrink-0'}>
      {(onCycleMode || onCycleBehavior || onCycleExecution) && (
        <div className={`flex items-center gap-1.5 mb-1.5 ${compact ? '' : 'max-w-4xl mx-auto'}`}>
          {onCycleMode && (
            <button
              onClick={onCycleMode}
              title="点击循环切换 问答 ⇄ 执行"
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition-all ${
                mode === 'execute'
                  ? 'bg-brand/15 text-brand-light border-brand/40'
                  : 'bg-accent-green/15 text-accent-green border-accent-green/30'
              }`}
            >
              {mode === 'execute' ? '⚡ 执行' : '💬 问答'}
            </button>
          )}
          {onCycleBehavior && (
            <button
              onClick={onCycleBehavior}
              title="行为模式：标准（常规能力）→ 创造（缺能力先造）→ 计划（只读规划不执行）"
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition-all ${bm.cls}`}
            >
              行为·{bm.label} ▾
            </button>
          )}
          {onCycleExecution && (
            <button
              onClick={onCycleExecution}
              title="执行方式：审批（变异动作先确认）⇄ 自动（全部自动执行不弹确认）"
              className={`px-2 py-0.5 rounded-full border text-[10px] font-bold transition-all ${em.cls}`}
            >
              执行·{em.label} ▾
            </button>
          )}
          {isRunning && <span className="text-[10px] text-amber-300 animate-pulse">● 运行中</span>}
        </div>
      )}
      <div className={`flex items-end gap-2 ${compact ? '' : 'max-w-4xl mx-auto'}`}>
        <textarea
          ref={ref}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? 1 : 2}
          className={`flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none custom-scrollbar ${compact ? 'max-h-24' : ''}`}
        />
        {isRunning && onSteer ? (
          <>
            <button
              onClick={submit}
              disabled={!input.trim()}
              title="把输入投进当前运行的下一轮（插话，不打断已产出）"
              className="p-3 rounded-xl text-white shrink-0 bg-brand disabled:opacity-40"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
            <button
              onClick={onAbort}
              title="暂停当前任务"
              className="p-3 rounded-xl text-white shrink-0 bg-red-500"
            >
              <Square className="w-4 h-4 fill-white" />
            </button>
          </>
        ) : (
          <button
            onClick={submit}
            disabled={!isRunning && !input.trim()}
            title={isRunning ? '暂停当前任务' : wsStatus === 'open' ? '发送（WS 在线）' : '发送（HTTP 降级）'}
            className={`p-3 rounded-xl text-white shrink-0 ${isRunning ? 'bg-red-500' : 'bg-brand'} disabled:opacity-40`}
          >
            {isRunning ? <Square className="w-4 h-4 fill-white" /> : <Send className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
};
