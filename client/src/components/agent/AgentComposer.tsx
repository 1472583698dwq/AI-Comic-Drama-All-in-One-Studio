/**
 * Agent 输入区 — 页面 / 悬浮抽屉 / 画布侧栏共用。
 *
 * 形态：一整块圆角输入框 —— 上方是「上下文 chip 槽 + 多行输入」，下方是一条工具条
 * （左侧模式 + 行为/执行两个下拉、右侧停止与发送），整体 `focus-within` 变色。
 *
 * 两处刻意的分工：
 * - `compact` 才渲染这三组切换。全屏「AI 导演」页的头部已经有这些切换器，
 *   在这里再放一份就是重复；而抽屉与画布侧栏原本**没有**切换入口，属于真实缺口。
 * - 输入框顶部留 `headerSlot` 插槽（画布侧栏用来放「已加入会话」的节点 chip）。
 *   组件本身不读画布状态 —— 那会把通用 Agent 组件绑死在画布上。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, ChevronUp, Check } from 'lucide-react';
import { useAgentDraftStore } from './agentDraftStore';
import {
  behaviorOfRunMode, composeRunMode, executionOfRunMode,
} from './agentTypes';
import type {
  AgentMode, BehaviorMode, ExecutionMode, RunMode, WsStatus,
} from './agentTypes';

export interface AgentComposerProps {
  mode: AgentMode;
  runMode?: RunMode;
  isRunning: boolean;
  wsStatus: WsStatus;
  onSend: (text: string) => void;
  onAbort: () => void;
  compact?: boolean;
  autoFocus?: boolean;
  /**
   * 标注 `data-no-polish`，让选区级润色浮标（`SelectionPolish`）跳过本输入框。
   * 这里是"跟 Agent 说话"的指令框，润色技能是给画面提示词/台词用的，挂上来不对路。
   */
  noPolish?: boolean;
  /** 紧凑态下的模式 / 行为 / 执行切换（不传则不渲染，如全屏页） */
  onModeChange?: (m: AgentMode) => void;
  onRunModeChange?: (r: RunMode) => void;
  /** 输入框顶部附加内容（如画布「已加入会话」的节点 chip） */
  headerSlot?: React.ReactNode;
}

const MODE_OPTIONS: Array<{ value: AgentMode; label: string; hint: string }> = [
  { value: 'chat', label: '问答', hint: '只讲解不动手，零副作用' },
  { value: 'execute', label: '执行', hint: 'ReAct 循环调工具生成' },
];

/** 行为维：能干什么（standard 标准 / create 创造 / plan 计划只读），代码硬门控 */
const BEHAVIOR_OPTIONS: Array<{ value: BehaviorMode; label: string; hint: string }> = [
  { value: 'standard', label: '标准', hint: '常规工具集，按风险分级放行' },
  { value: 'create', label: '创造', hint: '缺能力先提案再造，能力变更类需人审' },
  { value: 'plan', label: '计划', hint: '只读侦察，产出计划待批准' },
];

/** 执行维：要不要逐项人审（approve 审批 / auto 自动） */
const EXECUTION_OPTIONS: Array<{ value: ExecutionMode; label: string; hint: string }> = [
  { value: 'approve', label: '审批', hint: '变异动作先审后干（默认）' },
  { value: 'auto', label: '自动', hint: '全部工具自动执行、不再逐项确认（含删源/写文件/跑命令），可随时暂停' },
];

/** 工具条上的下拉药丸（菜单向上弹，因为输入框常在屏幕底部） */
const ToolPill: React.FC<{
  label: string;
  title: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  value: string;
  onChange: (v: any) => void;
  accent?: string;
  disabled?: boolean;
}> = ({ label, title, options, value, onChange, accent = 'text-brand-light', disabled }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-surface border border-border hover:border-brand/50 hover:bg-surface-secondary text-[10px] font-semibold [color:var(--color-text-main)] transition-colors disabled:opacity-40"
      >
        <span className={accent}>{current?.label || label}</span>
        <ChevronUp className={`w-2.5 h-2.5 [color:var(--color-text-muted)] transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 min-w-[132px] bg-surface border border-border rounded-xl shadow-2xl shadow-black/40 p-1 animate-fade-in">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              title={o.hint}
              className="w-full px-2 py-1.5 rounded-lg text-left text-[11px] [color:var(--color-text-main)] hover:bg-brand/10 flex items-center gap-1.5"
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.value === value && <Check className="w-3 h-3 text-brand shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const AgentComposer: React.FC<AgentComposerProps> = ({
  mode,
  runMode,
  isRunning,
  wsStatus,
  onSend,
  onAbort,
  compact,
  autoFocus,
  noPolish,
  onModeChange,
  onRunModeChange,
  headerSlot,
}) => {
  // 草稿存独立 store（不是组件内 state）：切换工作区 tab 会卸载组件，
  // 组件内 state 一卸载就丢，用户切回来刚写的指令就没了。
  const input = useAgentDraftStore((s) => s.draft);
  const setInput = useAgentDraftStore((s) => s.setDraft);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (isRunning) { onAbort(); return; }
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');   // 发送即清空
  };

  // 两维派生：行为维决定只读/创造提示，执行维决定是否逐项人审
  const behavior = behaviorOfRunMode(runMode);
  const execution = executionOfRunMode(runMode);

  // 紧凑态（抽屉 / 画布侧栏）输入框行数少，长 placeholder 会被纵向裁掉 → 用短文案
  const placeholder = behavior === 'plan'
    ? (compact ? '计划模式 · 只读侦察出计划' : '计划模式：只读侦察并产出完整计划，如“分析当前项目给出制作计划”')
    : mode === 'chat'
      ? (compact ? '问答模式 · 只讲解不生成' : '问答模式：只讲解不生成，如“首尾帧和参考图有什么区别？”')
      : (compact ? '吩咐 AI 导演做点什么…' : '执行模式：直接调工具生成，如“为当前镜头规划特写推镜并配音”');

  const showSwitches = !!compact && (!!onModeChange || !!onRunModeChange);

  return (
    <div className={compact ? '' : 'p-4 border-t border-border bg-surface shrink-0'}>
      <div
        className={`rounded-2xl border border-border bg-surface-secondary/60 transition-colors focus-within:border-brand/60 ${
          compact ? '' : 'max-w-4xl mx-auto'
        }`}
      >
        {/* 顶部：上下文 chip（由调用方决定语义，如画布「已加入会话」的节点） */}
        {headerSlot}

        <textarea
          ref={ref}
          data-no-polish={noPolish ? '1' : undefined}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? 3 : 2}
          className={`w-full bg-transparent px-3.5 pt-3 pb-1 text-xs [color:var(--color-text-main)] placeholder-[color:var(--color-text-muted)] focus:outline-none resize-none custom-scrollbar ${
            compact ? 'max-h-40 min-h-[58px]' : 'max-h-40'
          }`}
        />

        {/* 底部工具条 */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
          {showSwitches && (
            <>
              {onModeChange && (
                <ToolPill
                  label="模式"
                  title="问答=只讲解不生成 / 执行=直接调工具"
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={onModeChange}
                  accent={mode === 'chat' ? 'text-accent-green' : 'text-brand-light'}
                  disabled={isRunning}
                />
              )}
              {onRunModeChange && runMode && (
                <>
                  <ToolPill
                    label="行为"
                    title="能干什么：标准 / 创造（缺能力先造） / 计划（只读侦察）"
                    options={BEHAVIOR_OPTIONS}
                    value={behavior}
                    onChange={(b: BehaviorMode) => onRunModeChange(composeRunMode(b, execution))}
                    accent={
                      behavior === 'plan' ? 'text-sky-300'
                        : behavior === 'create' ? 'text-violet-300' : 'text-brand-light'
                    }
                    disabled={isRunning}
                  />
                  <ToolPill
                    label="执行"
                    title="要不要逐项人审：审批=先审后干 / 自动=全部自动执行（含删源/写文件/跑命令）"
                    options={EXECUTION_OPTIONS}
                    value={execution}
                    onChange={(e: ExecutionMode) => onRunModeChange(composeRunMode(behavior, e))}
                    accent={execution === 'auto' ? 'text-red-300' : 'text-amber-300'}
                    disabled={isRunning}
                  />
                </>
              )}
            </>
          )}

          <span className="flex-1 min-w-0 text-[9px] [color:var(--color-text-muted)] truncate">
            {isRunning ? '运行中 · Enter 暂停' : 'Enter 发送 · Shift+Enter 换行'}
          </span>

          {/* 只保留一个动作键：空闲=发送、运行中=暂停。
              此前这里另有一个独立的暂停键，与"运行中会变成暂停的发送键"重复，出现两个暂停按钮。 */}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={submit}
              disabled={!isRunning && !input.trim()}
              title={isRunning ? '暂停当前任务' : wsStatus === 'open' ? '发送（WS 在线）' : '发送（HTTP 降级）'}
              className={`w-8 h-8 rounded-xl text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-35 disabled:cursor-not-allowed ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-400'
                  : 'bg-gradient-to-br from-brand to-brand-blue shadow-md shadow-brand/25 hover:shadow-brand/40 hover:scale-[1.04] active:scale-95'
              }`}
            >
              {isRunning ? <Square className="w-3.5 h-3.5 fill-white" /> : <Send className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
