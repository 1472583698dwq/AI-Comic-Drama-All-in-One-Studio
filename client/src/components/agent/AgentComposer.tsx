/**
 * Agent 输入区 — 页面 / 悬浮抽屉 / 画布侧栏共用。
 *
 * 形态：一整块圆角输入框 —— 上方是「上下文 chip 槽（headerSlot）+ 附件 tray + 多行输入」，
 * 下方是一条工具条（附件 + 模式预设菜单 + 发送/暂停）。
 *
 * 几处刻意的分工：
 * - 模式选择收敛为输入框左下角的**单个预设菜单**（ZCode 式）：一个菜单项 = 一组完整行为，
 *   映射到现有 run_mode token（后端零改动）。三处入口（页面 / 抽屉 / 画布侧栏）共用同一份预设。
 * - 输入框顶部留 `headerSlot` 插槽（画布侧栏用来放「已加入会话」的节点 chip）。
 *   组件本身不读画布状态 —— 那会把通用 Agent 组件绑死在画布上。
 * - 草稿与待发附件存独立 `agentDraftStore`（不是组件内 state）：切换工作区 tab 会卸载组件，
 *   组件内 state 一卸载就丢；草稿独立订阅也不会让整棵会话流跟着每次按键重渲染。
 * - 附件支持三个来源（上传 / 画布产物 / 素材库）+ 剪贴板粘贴；发送时随消息一并交给后端。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Send, Square, MessageSquarePlus, ChevronUp, Check, Paperclip, X, Loader2,
  Image as ImageIcon, Film, Music,
} from 'lucide-react';
import { useAgentDraftStore, MAX_ATTACHMENTS } from './agentDraftStore';
import { AgentAttachmentPicker, kindOfUrl } from './AgentAttachmentPicker';
import { apiService } from '../../services/api';
import { API_ORIGIN } from '../../utils/devOrigin';
import { toast } from '../../stores/useDialogStore';
import type { AgentAttachment, AgentMode, RunMode, WsStatus } from './agentTypes';

export interface AgentComposerProps {
  mode: AgentMode;
  /** 组合 token（run_mode）：决定预设菜单当前选中项 */
  runMode?: RunMode;
  isRunning: boolean;
  wsStatus: WsStatus;
  onSend: (text: string, attachments?: AgentAttachment[]) => void;
  onAbort: () => void;
  /** 运行中插话（steer）：不填则运行中回车/按钮=暂停 */
  onSteer?: (text: string, attachments?: AgentAttachment[]) => void;
  /** 模式预设菜单回调（三处入口都传；问答走 onModeChange，其余走 onRunModeChange） */
  onModeChange?: (m: AgentMode) => void;
  onRunModeChange?: (r: RunMode) => void;
  compact?: boolean;
  autoFocus?: boolean;
  /**
   * 悬浮态（全屏「AI 导演」页）：不再占一条通栏空白，而是浮在消息流之上。
   * 外壳交给调用方定位，这里只负责玻璃质感/大圆角/投影。
   */
  floating?: boolean;
  /**
   * 标注 `data-no-polish`，让选区级润色浮标（`SelectionPolish`）跳过本输入框。
   * 这里是"跟 Agent 说话"的指令框，润色技能是给画面提示词/台词用的，挂上来不对路。
   */
  noPolish?: boolean;
  /** 输入框顶部附加内容（如画布「已加入会话」的节点 chip） */
  headerSlot?: React.ReactNode;
}

/**
 * 模式预设（ZCode 式）：一个菜单项 = 一组完整行为。
 * runMode=null 表示「纯问答」—— 只切 mode，不动 run_mode（切回执行时原样恢复）。
 * 映射口径：变更前确认=approve（原「标准+审批」）、完全访问=auto（原「标准+自动」）、
 * 计划=plan、造能力=create（原「创造」）。
 */
export const AGENT_MODE_PRESETS: Array<{
  key: string;
  label: string;
  hint: string;
  accent: string;
  runMode: RunMode | null;
}> = [
  { key: 'approve', label: '变更前确认', hint: '正常干活；删源/写文件/跑命令等危险操作逐个问你', accent: 'text-amber-300', runMode: 'approve' },
  { key: 'plan', label: '计划', hint: '只读侦察先出完整方案，批准后才执行；不生成不花钱', accent: 'text-sky-300', runMode: 'plan' },
  { key: 'auto', label: '完全访问', hint: '全部工具自动执行、不再逐项确认（含删源/写文件/跑命令），可随时暂停', accent: 'text-red-300', runMode: 'auto' },
  { key: 'create', label: '造能力', hint: '缺能力先提案：试跑验证后由你决定转正/丢弃，默认不写生产', accent: 'text-violet-300', runMode: 'create' },
  { key: 'chat', label: '纯问答', hint: '只讲解不动手，不调工具、零副作用', accent: 'text-accent-green', runMode: null },
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
        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 hover:border-brand/50 hover:bg-white/55 dark:bg-white/[.06] text-[10px] font-semibold [color:var(--color-text-main)] transition-colors disabled:opacity-40"
      >
        <span className={accent}>{current?.label || label}</span>
        <ChevronUp className={`w-2.5 h-2.5 [color:var(--color-text-muted)] transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 min-w-[236px] max-w-[300px] bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 rounded-xl shadow-2xl shadow-black/40 p-1 animate-fade-in">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              title={o.hint}
              className={`w-full px-2 py-1.5 rounded-lg text-left hover:bg-brand/10 flex items-start gap-1.5 ${
                o.value === value ? 'bg-brand/10' : ''
              }`}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[11px] font-semibold [color:var(--color-text-main)]">{o.label}</span>
                {o.hint && (
                  <span className="block text-[9px] leading-3 [color:var(--color-text-muted)] mt-0.5">{o.hint}</span>
                )}
              </span>
              {o.value === value && <Check className="w-3 h-3 text-brand shrink-0 mt-0.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const ATT_ICON: Record<string, any> = { image: ImageIcon, video: Film, audio: Music };

/** 粘贴文本超过该长度：消息列表里默认折叠为摘要（可展开全文） */
const BULK_PASTE_CHARS = 1200;

const resolveMediaUrl = (u?: string) => (!u ? '' : (u.startsWith('/') ? API_ORIGIN + u : u));

export const AgentComposer: React.FC<AgentComposerProps> = ({
  mode,
  runMode,
  isRunning,
  wsStatus,
  onSend,
  onAbort,
  onSteer,
  onModeChange,
  onRunModeChange,
  compact,
  autoFocus,
  floating,
  noPolish,
  headerSlot,
}) => {
  // 草稿与附件存独立 store（不是组件内 state）：切换工作区 tab 会卸载组件，
  // 组件内 state 一卸载就丢，用户切回来刚写的指令/附件就没了。
  const input = useAgentDraftStore((s) => s.draft);
  const setInput = useAgentDraftStore((s) => s.setDraft);
  const attachments = useAgentDraftStore((s) => s.attachments);
  const addAttachments = useAgentDraftStore((s) => s.addAttachments);
  const removeAttachment = useAgentDraftStore((s) => s.removeAttachment);
  const clearAttachments = useAgentDraftStore((s) => s.clearAttachments);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pasting, setPasting] = useState(false);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const text = input.trim();
    const atts = attachments.length ? [...attachments] : undefined;
    if (isRunning) {
      // 运行中：有插话通道则投进下一轮（可带附件），否则暂停
      if (onSteer) {
        if (!text && !atts) return;
        onSteer(text, atts);
        setInput('');
        clearAttachments();
      } else {
        onAbort();
      }
      return;
    }
    if (!text && !atts) return;
    onSend(text, atts);
    setInput('');
    clearAttachments();
  };

  /** 剪贴板里的文件（截图/复制的文件）直接作为附件上传；长文本粘贴标记为 bulk（消息列表折叠展示） */
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = e.clipboardData?.getData('text') || '';
    if (pastedText.length >= BULK_PASTE_CHARS) {
      useAgentDraftStore.getState().markPastedBulk(true);
    }
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    setPasting(true);
    const picked: AgentAttachment[] = [];
    const errors: string[] = [];
    for (const f of files.slice(0, MAX_ATTACHMENTS)) {
      try {
        const meta = await apiService.uploadAgentAttachment(f);
        if (meta?.ref) {
          picked.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            kind: (meta.kind as AgentAttachment['kind']) || kindOfUrl(f.name),
            name: meta.name || f.name || '粘贴附件',
            ref: meta.ref,
            size: meta.size || f.size,
            mime: meta.mime || f.type,
            source: 'paste',
          });
        }
      } catch (err: any) {
        errors.push(`${f.name || '粘贴文件'}: ${err?.message || '上传失败'}`);
      }
    }
    setPasting(false);
    if (picked.length) {
      addAttachments(picked);
      toast.success(`已添加 ${picked.length} 个粘贴附件`);
    }
    if (errors.length) toast.error(errors[0]);
  };

  // 预设派生：mode='chat' 即「纯问答」；执行态按 runMode token 归到对应预设
  const activePresetKey = (() => {
    if (mode === 'chat') return 'chat';
    if (runMode === 'plan' || runMode === 'plan_auto') return 'plan';
    if (runMode === 'create' || runMode === 'create_auto') return 'create';
    if (runMode === 'auto') return 'auto';
    return 'approve';
  })();
  const activePreset = AGENT_MODE_PRESETS.find((p) => p.key === activePresetKey) || AGENT_MODE_PRESETS[0];

  const handlePresetChange = (key: string) => {
    const p = AGENT_MODE_PRESETS.find((x) => x.key === key);
    if (!p) return;
    if (p.runMode == null) {
      onModeChange?.('chat');
    } else {
      onModeChange?.('execute');
      onRunModeChange?.(p.runMode);
    }
  };

  const placeholder = isRunning && onSteer
    ? '运行中：输入补充指令后回车插话（进入下一轮，不打断已产出）'
    : activePresetKey === 'chat'
      ? (compact ? '纯问答 · 只讲解不生成' : '问答模式：只讲解不生成，如“首尾帧和参考图有什么区别？”')
      : activePresetKey === 'plan'
        ? (compact ? '计划模式 · 只读侦察出计划' : '计划模式：只读侦察并产出完整计划，如“分析当前项目给出制作计划”')
        : activePresetKey === 'auto'
          ? (compact ? '吩咐 AI 导演做点什么…（完全访问）' : '完全访问：全部工具自动执行不弹确认，如“把画布现有节点全量执行一遍”')
          : activePresetKey === 'create'
            ? (compact ? '吩咐 AI 导演做点什么…（造能力）' : '造能力：缺什么能力直接说，如“做一个竖屏封面生成节点”')
            : (compact ? '吩咐 AI 导演做点什么…' : '变更前确认：危险操作会先问你，如“为当前镜头规划特写推镜并配音”');

  const hasMenu = !!(onModeChange && onRunModeChange && runMode != null);

  return (
    <div className={compact || floating ? '' : 'p-4 border-t border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] shrink-0'}>
      <div
        className={`transition-colors focus-within:border-brand/60 ${
          floating
            ? 'rounded-[26px] border border-white/55 dark:border-white/10 bg-white/80 dark:bg-black/55 backdrop-blur-xl shadow-2xl shadow-black/30'
            : 'rounded-2xl border border-white/70 dark:border-white/12 bg-white/55 dark:bg-white/[.05]'
        } ${compact ? '' : 'max-w-4xl mx-auto'}`}
      >
        {/* 顶部：上下文 chip（由调用方决定语义，如画布「已加入会话」的节点） */}
        {headerSlot}

        {/* 待发附件 tray */}
        {(attachments.length > 0 || pasting) && (
          <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2.5">
            {attachments.map((a) => {
              const Icon = ATT_ICON[a.kind] || ImageIcon;
              return (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-[10px] [color:var(--color-text-main)] max-w-full"
                  title={`${a.kind}：${a.ref}`}
                >
                  {a.kind === 'image' ? (
                    <img src={resolveMediaUrl(a.ref)} alt="" className="w-4 h-4 rounded object-cover shrink-0" />
                  ) : (
                    <Icon className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                  )}
                  <span className="truncate max-w-[160px]">{a.name}</span>
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="p-0.5 rounded text-sky-300/60 hover:text-red-300 hover:bg-red-500/20"
                    title="移除附件"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              );
            })}
            {pasting && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 text-[10px] [color:var(--color-text-muted)]">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />粘贴上传中…
              </span>
            )}
          </div>
        )}

        <textarea
          ref={ref}
          data-no-polish={noPolish ? '1' : undefined}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? (hasMenu ? 3 : 1) : 2}
          className={`w-full bg-transparent px-3.5 pt-3 pb-1 text-xs text-white placeholder-gray-500 focus:outline-none resize-none custom-scrollbar ${
            compact ? 'max-h-40 min-h-[32px]' : 'max-h-40'
          }`}
        />

        {/* 底部工具条 */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-0.5">
          {/* 附件入口 */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              title="添加图片 / 视频 / 音频（上传 / 画布产物 / 素材库；也可直接 Ctrl+V 粘贴）"
              className={`w-7 h-7 rounded-lg border flex items-center justify-center transition-colors ${
                pickerOpen || attachments.length
                  ? 'bg-brand/15 border-brand/40 text-brand'
                  : 'bg-white/60 dark:bg-white/[.05] border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:border-brand/50 hover:[color:var(--color-text-main)]'
              }`}
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            {attachments.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-brand text-white text-[9px] font-bold flex items-center justify-center">
                {attachments.length}
              </span>
            )}
            {pickerOpen && (
              <AgentAttachmentPicker
                selectedRefs={attachments.map((a) => a.ref)}
                onPick={(list) => addAttachments(list)}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>

          {/* 模式预设菜单（ZCode 式）：一个胶囊 = 一组完整行为，向上弹菜单 */}
          {hasMenu && (
            <ToolPill
              label="模式"
              title="工作模式：变更前确认 / 计划 / 完全访问 / 造能力 / 纯问答"
              options={AGENT_MODE_PRESETS.map((p) => ({ value: p.key, label: p.label, hint: p.hint }))}
              value={activePresetKey}
              onChange={handlePresetChange}
              accent={activePreset.accent}
              disabled={isRunning}
            />
          )}

          <span className={`flex-1 min-w-0 text-[9px] [color:var(--color-text-muted)] truncate ${hasMenu ? '' : 'pl-1'}`}>
            {isRunning
              ? (onSteer ? '运行中 · Enter 插话（不打断已产出）' : '运行中 · Enter 暂停')
              : 'Enter 发送 · Shift+Enter 换行'}
          </span>

          {isRunning && onSteer ? (
            <>
              <button
                type="button"
                onClick={submit}
                disabled={!input.trim() && attachments.length === 0}
                title="把输入投进当前运行的下一轮（插话，不打断已产出）"
                className="w-8 h-8 rounded-xl text-white flex items-center justify-center shrink-0 bg-brand disabled:opacity-35 disabled:cursor-not-allowed hover:scale-[1.04] active:scale-95 transition-all"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onAbort}
                title="暂停当前任务"
                className="w-8 h-8 rounded-xl text-white flex items-center justify-center shrink-0 bg-red-500 hover:bg-red-400 transition-all"
              >
                <Square className="w-3.5 h-3.5 fill-white" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!isRunning && !input.trim() && attachments.length === 0}
              title={isRunning ? '暂停当前任务' : wsStatus === 'open' ? '发送（WS 在线）' : '发送（HTTP 降级）'}
              className={`w-8 h-8 rounded-xl text-white flex items-center justify-center shrink-0 transition-all disabled:opacity-35 disabled:cursor-not-allowed ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-400'
                  : 'bg-gradient-to-br from-brand to-brand-blue shadow-md shadow-brand/25 hover:shadow-brand/40 hover:scale-[1.04] active:scale-95'
              }`}
            >
              {isRunning ? <Square className="w-3.5 h-3.5 fill-white" /> : <Send className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
