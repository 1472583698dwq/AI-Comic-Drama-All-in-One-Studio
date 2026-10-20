/**
 * 工具时间线 + 审批卡。
 *
 * 交互对齐 dsh：
 * - 工具调用不再折叠在消息底部，而是作为「思维链」内的行内时间线（AgentToolInline）；
 * - 审批卡是前台卡片（ApprovalCard，挂在输入框上方），不塞进工具行里。
 */
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, RefreshCw, ChevronDown, ShieldAlert, Film, Mic,
  Circle, Loader2, ListTodo,
} from 'lucide-react';
import type { ApprovalInfo, AgentTodoItem, ToolStep } from './agentTypes';
import { roleMeta } from './swarmMeta';
import { resolveMediaUrl as resolveOriginUrl } from '../../utils/devOrigin';

/** 审批等待超时（与 ApprovalService 默认 120s 对齐） */
const APPROVAL_TIMEOUT_S = 120;

function fmtElapsed(ms?: number): string {
  if (ms === undefined || ms === null) return '';
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function argPreview(args?: Record<string, any>): string {
  if (!args || typeof args !== 'object') return '';
  const keys = ['prompt', 'text', 'url', 'path', 'command', 'tool', 'instruction', 'query', 'name', 'description'];
  for (const k of keys) {
    const v = (args as any)[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 64);
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 64);
  }
  return '';
}

function resultSummary(result: any): string {
  try {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result.slice(0, 600);
    const s = JSON.stringify(result);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch { return ''; }
}

function resolveMediaUrl(u?: string): string {
  if (!u) return '';
  return resolveOriginUrl(u.startsWith('/') || /^(https?:|data:|blob:)/.test(u) ? u : `/${u}`);
}

/** 从工具结果里找可预览媒体（image_url/video_url/audio_url/url 兜底） */
function resultMedia(step: ToolStep): { url: string; kind: 'image' | 'video' | 'audio' } | null {
  const r = step.result;
  if (!r || typeof r !== 'object' || step.status !== 'completed') return null;
  const pick = (obj: any): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of ['image_url', 'video_url', 'audio_url', 'url', 'thumb_url', 'file_url']) {
      const v = (obj as any)[k];
      if (typeof v === 'string' && v.trim()) {
        const key = k.startsWith('video') ? 'video' : k.startsWith('audio') ? 'audio' : 'media';
        if (key !== 'media') return `${key}:${v.trim()}`;
        const low = v.toLowerCase();
        if (/\.(mp4|webm|mov)(\?|$)/.test(low)) return `video:${v.trim()}`;
        if (/\.(mp3|wav|ogg|m4a)(\?|$)/.test(low)) return `audio:${v.trim()}`;
        if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/.test(low)) return `image:${v.trim()}`;
        if (/video/.test(step.name)) return `video:${v.trim()}`;
        if (/voice|audio|tts/.test(step.name)) return `audio:${v.trim()}`;
        return `image:${v.trim()}`;
      }
    }
    return null;
  };
  let found = pick(r);
  if (!found) {
    for (const v of Object.values(r)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        found = pick(v);
        if (found) break;
      }
    }
  }
  if (!found) return null;
  const [kind, url] = found.split(/:(.+)/).filter(Boolean) as ['image' | 'video' | 'audio', string];
  return { url, kind };
}

/** 前台审批卡（dsh ApprovalPanel 同语义：等待中、工具名、参数、拒绝/允许一次、本会话始终允许） */
export const ApprovalCard: React.FC<{
  aid: string;
  tool: string;
  args: Record<string, any>;
  createdAt?: number;
  autoAllowed: boolean;
  onApprove: (aid: string, ok: boolean, always: boolean) => void;
}> = ({ aid, tool, args, createdAt, autoAllowed, onApprove }) => {
  const [always, setAlways] = useState(autoAllowed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remain = createdAt ? Math.max(0, APPROVAL_TIMEOUT_S - Math.floor((now - createdAt) / 1000)) : null;
  return (
    <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-2.5 shadow-sm">
      <div className="text-[11px] font-bold text-amber-600 dark:text-amber-300 flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5" />
        <span>等待确认 · <span className="font-mono">{tool}</span></span>
        {remain !== null && (
          <span className={`ml-auto font-mono font-normal ${remain <= 15 ? 'text-red-500 dark:text-red-300' : '[color:var(--color-text-secondary)]'}`}>
            {remain > 0 ? `${remain}s 后自动拒绝` : '已超时（会自动拒绝）'}
          </span>
        )}
      </div>
      {Object.keys(args || {}).length > 0 && (
        <pre className="mt-1.5 text-[10px] font-mono [color:var(--color-text-secondary)] bg-black/[.05] dark:bg-black/35 border border-black/5 dark:border-white/12 rounded-lg p-1.5 max-h-28 overflow-auto custom-scrollbar whitespace-pre-wrap break-all">
          {JSON.stringify(args, null, 1).slice(0, 2000)}
        </pre>
      )}
      <div className="mt-2 flex gap-1.5">
        <button onClick={() => onApprove(aid, false, false)} className="flex-1 py-1.5 rounded-lg border border-white/70 dark:border-white/12 text-[11px] font-semibold [color:var(--color-text-main)] hover:bg-black/5 dark:hover:bg-white/5">
          拒绝
        </button>
        <button onClick={() => onApprove(aid, true, always)} className="flex-1 py-1.5 rounded-lg bg-amber-500 text-black text-[11px] font-bold hover:bg-amber-400">
          允许一次
        </button>
      </div>
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px] [color:var(--color-text-secondary)] cursor-pointer select-none">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-amber-500" />
        本会话始终允许此工具（不再询问）
      </label>
    </div>
  );
};

/** 单条工具行：图标 + 名称 + 关键参数 + 状态 + 耗时；点开看参数/结果/预览 */
export const ToolStepRow: React.FC<{ step: ToolStep }> = ({ step: s }) => {
  const [isOpen, setIsOpen] = useState(false);
  const preview = argPreview(s.args);
  const media = resultMedia(s);
  return (
    <div className="px-2.5 py-1.5 text-[11px]">
      <button onClick={() => setIsOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
        {s.status === 'completed' ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-accent-green shrink-0" />
        ) : s.status === 'error' ? (
          <XCircle className="w-3.5 h-3.5 text-red-500 dark:text-red-400 shrink-0" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 animate-spin shrink-0" />
        )}
        <span className="font-mono [color:var(--color-text-main)] shrink-0 max-w-[32%] truncate" title={s.name}>
          {s.name}
        </span>
        {s.name === 'subagent_run' && (s.args as any)?.agent && (
          <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded border text-[9px] font-bold ${roleMeta(String((s.args as any).agent)).cls}`}>
            {(() => { const M = roleMeta(String((s.args as any).agent)); return <M.Icon className="w-2.5 h-2.5" />; })()}
            {roleMeta(String((s.args as any).agent)).label}
          </span>
        )}
        {media && (
          <span className="w-8 h-8 rounded-md overflow-hidden bg-surface/80 border border-white/70 dark:border-white/12 shrink-0 flex items-center justify-center" title="点击展开预览">
            {media.kind === 'image' ? (
              <img src={resolveMediaUrl(media.url)} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : media.kind === 'video' ? (
              <span className="relative w-full h-full flex items-center justify-center">
                <video src={resolveMediaUrl(media.url)} className="w-full h-full object-cover" muted preload="metadata" />
                <Film className="absolute w-3 h-3 text-white drop-shadow" />
              </span>
            ) : (
              <Mic className="w-3.5 h-3.5 text-pink-300" />
            )}
          </span>
        )}
        {preview ? (
          <span className="[color:var(--color-text-muted)] truncate flex-1" title={preview}>{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        {s.elapsedMs !== undefined && (
          <span className="text-[10px] [color:var(--color-text-muted)] font-mono shrink-0">{fmtElapsed(s.elapsedMs)}</span>
        )}
        {s.status === 'executing' && (
          <span className="text-[10px] text-amber-600 dark:text-amber-300 shrink-0 animate-pulse truncate max-w-[220px]" title={s.note || '执行中…'}>{s.note || '执行中…'}</span>
        )}
        <ChevronDown className={`w-3 h-3 [color:var(--color-text-muted)] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          {s.args && Object.keys(s.args).length > 0 && (
            <pre className="text-[10px] font-mono [color:var(--color-text-secondary)] bg-black/[.04] dark:bg-black/35 border border-black/5 dark:border-white/12 rounded-lg p-1.5 max-h-32 overflow-auto custom-scrollbar whitespace-pre-wrap break-all">
              {JSON.stringify(s.args, null, 1).slice(0, 3000)}
            </pre>
          )}
          {s.status === 'error' && s.error && (
            <div className="text-[10px] text-red-500 dark:text-red-400 break-all">{String(s.error).slice(0, 600)}</div>
          )}
          {s.status === 'completed' && s.result !== undefined && resultSummary(s.result) && (
            <div className="text-[10px] [color:var(--color-text-muted)] break-all">{resultSummary(s.result)}</div>
          )}
        </div>
      )}
    </div>
  );
};

/** 思维链里的工具时间线：平铺行，不再包一层「工具步骤」折叠盒 */
export const AgentToolInline: React.FC<{ steps: ToolStep[] }> = ({ steps }) => {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="rounded-lg border border-white/60 dark:border-white/10 overflow-hidden divide-y divide-black/5 dark:divide-white/5 bg-black/[.02] dark:bg-black/20">
      {steps.map((s) => <ToolStepRow key={s.id} step={s} />)}
    </div>
  );
};

/** 待办清单（todo_write 事件驱动：pending / in_progress / completed） */
export const AgentTodoPanel: React.FC<{ todo?: AgentTodoItem[] }> = ({ todo }) => {
  if (!todo || todo.length === 0) return null;
  const done = todo.filter((t) => t.status === 'completed').length;
  return (
    <div className="mt-2 rounded-xl border border-sky-500/25 bg-sky-500/5 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 text-[10px] font-bold text-sky-300">
        <ListTodo className="w-3 h-3" />
        <span>待办 {done}/{todo.length}</span>
      </div>
      <div className="px-2.5 pb-2 space-y-1">
        {todo.map((t, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11px]">
            {t.status === 'completed' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" />
            ) : t.status === 'in_progress' ? (
              <Loader2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-300 animate-spin shrink-0 mt-px" />
            ) : (
              <Circle className="w-3.5 h-3.5 [color:var(--color-text-muted)] shrink-0 mt-px" />
            )}
            <span className={t.status === 'completed' ? '[color:var(--color-text-muted)] line-through' : '[color:var(--color-text-main)]'}>{t.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** 兼容旧引用：整组折叠的工具步骤（新交互已不再使用，保留导出避免外部断链） */
export const AgentToolSteps: React.FC<{ steps: ToolStep[] }> = ({ steps }) => <AgentToolInline steps={steps} />;
