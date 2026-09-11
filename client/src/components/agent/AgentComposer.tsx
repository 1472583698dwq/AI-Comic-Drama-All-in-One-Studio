/**
 * Agent 输入区 — 页面与抽屉共用（Enter 发送 / 运行中 Enter 暂停）
 */
import React, { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import type { AgentMode, RunMode, WsStatus } from './agentTypes';

export interface AgentComposerProps {
  mode: AgentMode;
  runMode?: RunMode;
  isRunning: boolean;
  wsStatus: WsStatus;
  onSend: (text: string) => void;
  onAbort: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  mode,
  runMode,
  isRunning,
  wsStatus,
  onSend,
  onAbort,
  compact,
  autoFocus,
}) => {
  const [input, setInput] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (isRunning) { onAbort(); return; }
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
  };

  const placeholder = runMode === 'plan'
    ? '计划模式：只读侦察并产出完整计划，如“分析当前项目给出制作计划”'
    : mode === 'chat'
      ? '问答模式：只讲解不生成，如“首尾帧和参考图有什么区别？”'
      : '执行模式：直接调工具生成，如“为当前镜头规划特写推镜并配音”';

  return (
    <div className={compact ? '' : 'p-4 border-t border-border bg-surface shrink-0'}>
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
        <button
          onClick={submit}
          disabled={!isRunning && !input.trim()}
          title={isRunning ? '暂停当前任务' : wsStatus === 'open' ? '发送（WS 在线）' : '发送（HTTP 降级）'}
          className={`p-3 rounded-xl text-white shrink-0 ${isRunning ? 'bg-red-500' : 'bg-brand'} disabled:opacity-40`}
        >
          {isRunning ? <Square className="w-4 h-4 fill-white" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};
