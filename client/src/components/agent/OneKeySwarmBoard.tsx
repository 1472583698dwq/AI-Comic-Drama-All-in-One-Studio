/**
 * 一键成片 · 子代理集群看板 —— 状态 + 运行轨迹（工具调用时间线）。
 *
 * 数据源：/onekey/tasks/{id} 的 task.subagents（后端 sink 累积：trail=[{t,tool,phase,status,detail}]）。
 * 特性：批次分组、运行中实时计时、点击行展开轨迹、成功摘要/失败原因。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Bot, CheckCircle2, XCircle, Loader2, Clock, ChevronRight, ListTree,
} from 'lucide-react';
import { roleMeta, fmtElapsed } from './swarmMeta';

interface TrailStep {
  t?: number;
  tool?: string;
  phase?: string;          // calling | result
  status?: string;         // result: success | error
  detail?: string;
}

interface SubRec {
  id: string;
  agent?: string;
  task?: string;
  status?: string;         // running | success | error | cancelled
  tool?: string;
  elapsed_ms?: number;
  started_at?: number;     // epoch 秒
  batch_id?: string;
  error?: string;
  result?: string;
  trail?: TrailStep[];
}

const fmtTime = (t?: number): string => {
  if (!t) return '';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const isRunning = (s: SubRec) => s.status === 'running' || s.status === 'queued' || s.status === 'launched';
const isFailed = (s: SubRec) => s.status === 'error' || s.status === 'cancelled';

const StatusIcon: React.FC<{ status?: string }> = ({ status }) => {
  const base = 'h-3.5 w-3.5 shrink-0';
  if (status === 'success') return <CheckCircle2 className={`${base} text-emerald-400`} />;
  if (status === 'error' || status === 'cancelled') return <XCircle className={`${base} text-red-400`} />;
  if (status === 'queued' || status === 'launched') return <Clock className={`${base} [color:var(--color-text-muted)]`} />;
  return <Loader2 className={`${base} animate-spin text-amber-400`} />;
};

export const OneKeySwarmBoard: React.FC<{ subagents: Record<string, SubRec> }> = ({ subagents }) => {
  const list = useMemo(() => Object.values(subagents || {}), [subagents]);
  const runningCount = list.filter(isRunning).length;
  const doneCount = list.filter((s) => s.status === 'success').length;
  const failCount = list.filter(isFailed).length;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!runningCount) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runningCount]);

  // 批次分组（连续同批合并；无批次各自成组）
  const groups = useMemo(() => {
    const out: Array<{ batchId: string; items: SubRec[] }> = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (s.batch_id && last && last.batchId === s.batch_id) last.items.push(s);
      else out.push({ batchId: s.batch_id || '', items: [s] });
    }
    return out;
  }, [list]);

  if (list.length === 0) {
    return (
      <div className="flex min-h-[260px] items-center justify-center rounded-2xl border border-dashed border-black/[.08] bg-black/[.015] dark:border-white/[.08] dark:bg-white/[.015]">
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-black/[.06] bg-black/[.03] dark:border-white/[.08] dark:bg-white/[.03]">
            <Bot className="h-5 w-5 [color:var(--color-text-muted)] opacity-50" />
          </div>
          <div className={`text-[11px] [color:var(--color-text-muted)]`}>任务运行中，总导演委派的子代理会出现在这里</div>
        </div>
      </div>
    );
  }

  const elapsedOf = (s: SubRec) => {
    if (isRunning(s) && s.started_at) return Math.max(0, now - s.started_at * 1000);
    return s.elapsed_ms || 0;
  };

  return (
    <div className="space-y-3">
      {/* 汇总条 */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-black/[.05] bg-white/45 px-3.5 py-2.5 dark:border-white/[.06] dark:bg-white/[.02]">
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold [color:var(--color-text-main)]`}>
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet-400/10">
            <Bot className="h-3 w-3 text-violet-400" />
          </span>
          子代理集群
          <span className="font-mono text-[10px] font-normal [color:var(--color-text-muted)]">{list.length} 个</span>
        </span>
        <span className="h-3 w-px bg-black/[.06] dark:bg-white/[.08]" />
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />{runningCount} 运行中
          </span>
        )}
        {doneCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{doneCount} 完成
          </span>
        )}
        {failCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-red-500 dark:text-red-300">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />{failCount} 失败
          </span>
        )}
        <span className="flex-1" />
        <span className={`flex items-center gap-1 text-[9px] [color:var(--color-text-muted)]`}>
          <ListTree className="h-3 w-3" />点击子代理查看运行轨迹
        </span>
      </div>

      {groups.map((g, gi) => {
        const gDone = g.items.filter((s) => s.status === 'success').length;
        const batchAgent = g.items[0]?.agent || '';
        const meta = roleMeta(batchAgent);
        const isBatch = g.items.length > 1 || !!g.batchId;
        return (
          <div key={gi} className="overflow-hidden rounded-2xl border border-black/[.05] bg-white/40 dark:border-white/[.06] dark:bg-white/[.02]">
            {isBatch && (
              <div className="flex items-center gap-2 border-b border-black/[.04] bg-black/[.015] px-3 py-2 dark:border-white/[.05] dark:bg-white/[.02]">
                <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${meta.cls}`}>
                  <meta.Icon className="h-2.5 w-2.5" />{meta.label}
                </span>
                <span className={`font-mono text-[9px] [color:var(--color-text-muted)]`}>{g.batchId || '批次'}</span>
                <span className="flex-1" />
                <span className={`font-mono text-[9px] [color:var(--color-text-muted)]`}>{gDone}/{g.items.length} 完成</span>
                <span className="h-1 w-16 overflow-hidden rounded-full bg-black/[.06] dark:bg-white/[.07]">
                  <span className="block h-full rounded-full bg-emerald-400/80" style={{ width: `${(gDone / Math.max(1, g.items.length)) * 100}%` }} />
                </span>
              </div>
            )}
            <div className="divide-y divide-black/[.04] dark:divide-white/[.05]">
              {g.items.map((s) => {
                const m = roleMeta(s.agent);
                const open = expanded[s.id] ?? isRunning(s);
                const steps = s.trail || [];
                const failed = isFailed(s);
                return (
                  <div key={s.id} className="relative">
                    <span className={`absolute inset-y-0 left-0 w-[2px] ${failed ? 'bg-red-400/70' : s.status === 'success' ? 'bg-emerald-400/60' : isRunning(s) ? 'bg-amber-400/70' : 'bg-transparent'}`} />
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-black/[.025] dark:hover:bg-white/[.03]"
                    >
                      <StatusIcon status={s.status} />
                      {!isBatch && (
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${m.cls}`}>
                          <m.Icon className="h-2.5 w-2.5" />{m.label}
                        </span>
                      )}
                      <span className={`min-w-0 flex-1 truncate text-[11px] [color:var(--color-text-main)]`}>{s.task || '—'}</span>
                      {isRunning(s) && s.tool && (
                        <span className="max-w-[140px] shrink-0 truncate rounded bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-600 dark:text-amber-300">{s.tool}</span>
                      )}
                      <span className={`shrink-0 font-mono text-[9.5px] tabular-nums [color:var(--color-text-muted)]`}>{fmtElapsed(elapsedOf(s))}</span>
                      <ChevronRight className={`h-3 w-3 shrink-0 transition-transform [color:var(--color-text-muted)] ${open ? 'rotate-90' : ''}`} />
                    </button>

                    {open && (
                      <div className="px-3 pb-3 pl-[46px]">
                        <div className="overflow-hidden rounded-xl border border-black/[.06] bg-black/[.03] dark:border-white/[.06] dark:bg-black/35">
                          <div className="max-h-52 space-y-0.5 overflow-y-auto p-2.5 font-mono custom-scrollbar">
                            {steps.length === 0 && (
                              <div className={`py-1 font-sans text-[9.5px] [color:var(--color-text-muted)]`}>等待工具调用…</div>
                            )}
                            {steps.map((st, i) => (
                              <div key={i} className="flex items-start gap-1.5 text-[9.5px] leading-relaxed">
                                <span className={`shrink-0 tabular-nums [color:var(--color-text-muted)]`}>{fmtTime(st.t)}</span>
                                {st.phase === 'result'
                                  ? (st.status === 'error'
                                    ? <XCircle className="mt-[3px] h-2.5 w-2.5 shrink-0 text-red-400" />
                                    : <CheckCircle2 className="mt-[3px] h-2.5 w-2.5 shrink-0 text-emerald-400" />)
                                  : <span className="shrink-0 font-bold text-amber-500 dark:text-amber-300">→</span>}
                                <span className={`shrink-0 ${st.phase === 'calling' ? 'text-amber-600 dark:text-amber-300' : st.status === 'error' ? 'text-red-500 dark:text-red-300' : '[color:var(--color-text-main)]'}`}>
                                  {st.tool || '—'}
                                </span>
                                {st.detail && <span className="break-all text-red-500/90 dark:text-red-300/85">{st.detail}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                        {s.error && <div className="mt-1.5 text-[9.5px] leading-relaxed text-red-500 dark:text-red-300">✗ {s.error}</div>}
                        {!s.error && s.status === 'success' && s.result && (
                          <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[9.5px] leading-relaxed text-emerald-600/90 dark:text-emerald-300/90">{s.result}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
