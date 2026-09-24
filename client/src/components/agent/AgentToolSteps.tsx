/**
 * IDE 风格工具步骤卡 — 默认折叠一行（图标 + 工具名 + 关键参数 + 状态 + 耗时），
 * 展开看完整参数与结果；敏感操作直接在卡上行内审批（含"本会话始终允许"，免打扰）。
 * 连续同类调用自动合并为一组（"Ran N tool calls"，防批量刷屏）；完成步骤带结果缩略图。
 */
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, XCircle, RefreshCw, ChevronDown, ShieldAlert, Wrench,
  Circle, Loader2, ListTodo, Film, Mic,
} from 'lucide-react';
import type { ApprovalInfo, AgentTodoItem, ToolStep } from './agentTypes';
import { roleMeta } from './swarmMeta';

/** 服务端审批超时（与 ApprovalService 默认 120s 对齐） */
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
  return u.startsWith('http') ? u : `http://127.0.0.1:8000${u.startsWith('/') ? '' : '/'}${u}`;
}

/** 从工具结果里找可预览的媒体（image_url/video_url/audio_url/url，限两层） */
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
        // url/thumb/file：按扩展名或工具名判断
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

/** 行内审批卡（Cursor 式：参数可见 + 允许/拒绝 + 始终允许 + 超时倒计时） */
const ApprovalInline: React.FC<{
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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
      <div className="text-[10px] font-bold text-amber-300 flex items-center gap-1">
        <ShieldAlert className="w-3 h-3" />
        <span>敏感操作待确认 · <span className="font-mono">{tool}</span></span>
        {remain !== null && (
          <span className={`ml-auto font-mono font-normal ${remain <= 15 ? 'text-red-300' : 'text-gray-400'}`}>
            {remain > 0 ? `${remain}s 后自动拒绝` : '已超时，后端自动拒绝'}
          </span>
        )}
      </div>
      {Object.keys(args || {}).length > 0 && (
        <pre className="mt-1 text-[10px] font-mono text-gray-400 bg-surface/60 border border-border rounded-lg p-1.5 max-h-28 overflow-auto custom-scrollbar whitespace-pre-wrap break-all">
          {JSON.stringify(args, null, 1).slice(0, 2000)}
        </pre>
      )}
      <div className="mt-1.5 flex gap-1.5">
        <button onClick={() => onApprove(aid, true, always)} className="flex-1 py-1 rounded-lg bg-amber-500 text-black text-[11px] font-bold">允许</button>
        <button onClick={() => onApprove(aid, false, false)} className="flex-1 py-1 rounded-lg border border-border text-[11px] text-gray-300">拒绝</button>
      </div>
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer select-none">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-amber-500" />
        本会话始终允许此工具（不再打扰）
      </label>
    </div>
  );
};

/** 单步行（含缩略图/耗时/审批） */
const ToolStepRow: React.FC<{
  step: ToolStep;
  indexLabel?: string;
  approvalAid?: string;
  approvalInfo?: ApprovalInfo;
  autoAllowed: boolean;
  onApprove: (aid: string, ok: boolean, always: boolean) => void;
}> = ({ step: s, indexLabel, approvalAid, approvalInfo, autoAllowed, onApprove }) => {
  const [isOpen, setIsOpen] = useState(!!approvalAid);
  const preview = argPreview(s.args);
  const media = resultMedia(s);
  return (
    <div className="px-2.5 py-1.5 text-[11px]">
      <button onClick={() => setIsOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
        {s.status === 'completed' ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-accent-green shrink-0" />
        ) : s.status === 'error' ? (
          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
        )}
        <span className="font-mono text-gray-200 shrink-0 max-w-[32%] truncate" title={s.name}>
          {indexLabel ? `${s.name} #${indexLabel}` : s.name}
        </span>
        {s.name === 'subagent_run' && (s.args as any)?.agent && (
          <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded border text-[9px] font-bold ${roleMeta(String((s.args as any).agent)).cls}`}>
            {(() => { const M = roleMeta(String((s.args as any).agent)); return <M.Icon className="w-2.5 h-2.5" />; })()}
            {roleMeta(String((s.args as any).agent)).label}
          </span>
        )}
        {media && (
          <span className="w-8 h-8 rounded-md overflow-hidden bg-surface-secondary border border-border shrink-0 flex items-center justify-center" title="结果预览">
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
          <span className="text-gray-500 truncate flex-1" title={preview}>{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        {s.elapsedMs !== undefined && (
          <span className="text-[10px] text-gray-500 font-mono shrink-0">{fmtElapsed(s.elapsedMs)}</span>
        )}
        {s.status === 'executing' && !approvalAid && (
          <span className="text-[10px] text-amber-300 shrink-0 animate-pulse">执行中…</span>
        )}
        {approvalAid && (
          <span className="text-[10px] font-bold text-amber-300 shrink-0">待确认</span>
        )}
        <ChevronDown className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          {s.args && Object.keys(s.args).length > 0 && (
            <pre className="text-[10px] font-mono text-gray-400 bg-surface/60 border border-border rounded-lg p-1.5 max-h-32 overflow-auto custom-scrollbar whitespace-pre-wrap break-all">
              {JSON.stringify(s.args, null, 1).slice(0, 3000)}
            </pre>
          )}
          {s.status === 'error' && s.error && (
            <div className="text-[10px] text-red-400 break-all">{String(s.error).slice(0, 600)}</div>
          )}
          {s.status === 'completed' && s.result !== undefined && resultSummary(s.result) && (
            <div className="text-[10px] text-gray-500 break-all">{resultSummary(s.result)}</div>
          )}
          {approvalAid && approvalInfo && (
            <ApprovalInline
              aid={approvalAid}
              tool={s.name}
              args={approvalInfo.args || {}}
              createdAt={approvalInfo.createdAt}
              autoAllowed={autoAllowed}
              onApprove={onApprove}
            />
          )}
        </div>
      )}
    </div>
  );
};

interface StepGroup { name: string; steps: ToolStep[]; }

export const AgentToolSteps: React.FC<{
  steps: ToolStep[];
  approvals: Record<string, ApprovalInfo>;
  autoAllowTools: Record<string, boolean>;
  onApprove: (aid: string, ok: boolean, always: boolean) => void;
}> = ({ steps, approvals, autoAllowTools, onApprove }) => {
  const [expanded, setExpanded] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  if (!steps || steps.length === 0) return null;
  const done = steps.filter((s) => s.status === 'completed').length;
  const pendingFor = (name: string) =>
    Object.entries(approvals).find(([, v]) => v.decided === undefined && v.tool_name === name)?.[0];

  // 连续同类调用合并为一组（批量刷屏收敛，Zed 式 "Ran N tool calls"）
  const groups: StepGroup[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.name === s.name) last.steps.push(s);
    else groups.push({ name: s.name, steps: [s] });
  }

  return (
    <div className="mt-2 rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2.5 py-1.5 flex items-center gap-1.5 text-[10px] font-bold text-gray-300 hover:bg-white/5"
      >
        <Wrench className="w-3 h-3 text-accent-orange" />
        <span>工具步骤 {done}/{steps.length}</span>
        {groups.length < steps.length && (
          <span className="text-[9px] font-normal text-gray-500">（已合并 {groups.length} 组）</span>
        )}
        <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-white/5">
          {groups.map((g, gi) => {
            if (g.steps.length === 1) {
              const s = g.steps[0];
              const aid = s.status === 'executing' ? pendingFor(s.name) : undefined;
              return (
                <ToolStepRow
                  key={s.id}
                  step={s}
                  approvalAid={aid}
                  approvalInfo={aid ? approvals[aid] : undefined}
                  autoAllowed={!!autoAllowTools[s.name]}
                  onApprove={onApprove}
                />
              );
            }
            const gDone = g.steps.filter((s) => s.status === 'completed').length;
            const gErr = g.steps.filter((s) => s.status === 'error').length;
            const gKey = `${gi}:${g.name}`;
            const gOpen = openGroups[gKey] ?? g.steps.some((s) => s.status === 'executing');
            const totalMs = g.steps.reduce((a, s) => a + (s.elapsedMs || 0), 0);
            return (
              <div key={gKey}>
                <button
                  onClick={() => setOpenGroups((p) => ({ ...p, [gKey]: !gOpen }))}
                  className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[11px] text-left bg-white/[0.02]"
                >
                  {gErr > 0 ? (
                    <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  ) : gDone === g.steps.length ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent-green shrink-0" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                  )}
                  <span className="font-mono text-gray-200 shrink-0 truncate">{g.name}</span>
                  <span className="text-[10px] text-gray-400 shrink-0">× {g.steps.length}</span>
                  <span className="text-[10px] text-gray-500 flex-1 truncate">
                    {gDone}/{g.steps.length} 完成{gErr > 0 ? ` · ${gErr} 失败` : ''}
                  </span>
                  {totalMs > 0 && (
                    <span className="text-[10px] text-gray-500 font-mono shrink-0">{fmtElapsed(totalMs)}</span>
                  )}
                  <ChevronDown className={`w-3 h-3 text-gray-500 shrink-0 transition-transform ${gOpen ? 'rotate-180' : ''}`} />
                </button>
                {gOpen && (
                  <div className="border-t border-white/5 divide-y divide-white/5 bg-black/10">
                    {g.steps.map((s, si) => {
                      const aid = s.status === 'executing' ? pendingFor(s.name) : undefined;
                      return (
                        <ToolStepRow
                          key={s.id}
                          step={s}
                          indexLabel={String(si + 1)}
                          approvalAid={aid}
                          approvalInfo={aid ? approvals[aid] : undefined}
                          autoAllowed={!!autoAllowTools[s.name]}
                          onApprove={onApprove}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** 待办清单（todo_write 实时事件驱动：pending / in_progress / completed） */
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
              <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin shrink-0 mt-px" />
            ) : (
              <Circle className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-px" />
            )}
            <span className={t.status === 'completed' ? 'text-gray-500 line-through' : 'text-gray-200'}>{t.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
