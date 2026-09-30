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

const StatusIcon: React.FC<{ status?: string }> = ({ status }) => {
  if (status === 'success') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  if (status === 'error' || status === 'cancelled') return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  if (status === 'queued' || status === 'launched') return <Clock className="w-3.5 h-3.5 [color:var(--color-text-muted)] shrink-0" />;
  return <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin shrink-0" />;
};

export const OneKeySwarmBoard: React.FC<{ subagents: Record<string, SubRec> }> = ({ subagents }) => {
  const list = useMemo(() => Object.values(subagents || {}), [subagents]);
  const runningCount = list.filter((s) => s.status === 'running' || s.status === 'queued' || s.status === 'launched').length;
  const doneCount = list.filter((s) => s.status === 'success').length;
  const failCount = list.filter((s) => s.status === 'error' || s.status === 'cancelled').length;

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
      <div className="h-full min-h-[220px] flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 flex items-center justify-center mx-auto">
            <Bot className="w-5 h-5 [color:var(--color-text-muted)]" />
          </div>
          <div className="text-[11px] [color:var(--color-text-muted)]">任务运行中，总导演委派的子代理会出现在这里</div>
        </div>
      </div>
    );
  }

  const isRunning = (s: SubRec) => s.status === 'running' || s.status === 'queued' || s.status === 'launched';
  const elapsedOf = (s: SubRec) => {
    if (isRunning(s) && s.started_at) return Math.max(0, now - s.started_at * 1000);
    return s.elapsed_ms || 0;
  };

  return (
    <div className="space-y-3">
      {/* 汇总条 */}
      <div className="flex items-center gap-3 flex-wrap rounded-2xl border border-white/70 dark:border-white/12 bg-white/60 dark:bg-black/35 px-3.5 py-2.5">
        <span className="text-[11px] font-bold [color:var(--color-text-main)] flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5 text-accent-purple" />子代理集群
          <span className="[color:var(--color-text-muted)] font-normal">{list.length} 个</span>
        </span>
        {runningCount > 0 && <span className="text-[10.5px] text-amber-300 animate-pulse">{runningCount} 运行中</span>}
        {doneCount > 0 && <span className="text-[10.5px] text-emerald-400">{doneCount} 完成</span>}
        {failCount > 0 && <span className="text-[10.5px] text-red-400">{failCount} 失败</span>}
        <span className="flex-1" />
        <span className="text-[9.5px] [color:var(--color-text-muted)] flex items-center gap-1">
          <ListTree className="w-3 h-3" />点击子代理查看运行轨迹
        </span>
      </div>

      {groups.map((g, gi) => {
        const gDone = g.items.filter((s) => s.status === 'success').length;
        const batchAgent = g.items[0]?.agent || '';
        const meta = roleMeta(batchAgent);
        const isBatch = g.items.length > 1 || !!g.batchId;
        return (
          <div key={gi} className="rounded-2xl border border-white/70 dark:border-white/12 bg-white/55 dark:bg-black/30 overflow-hidden">
            {isBatch && (
              <div className="px-3 py-1.5 border-b border-white/50 dark:border-white/10 bg-white/40 dark:bg-white/[.03] flex items-center gap-2">
                <span className={`text-[9.5px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 ${meta.cls}`}>
                  <meta.Icon className="w-2.5 h-2.5" />{meta.label}
                </span>
                <span className="text-[9.5px] font-mono [color:var(--color-text-muted)]">{g.batchId || '批次'}</span>
                <span className="text-[9.5px] [color:var(--color-text-muted)] ml-auto">{gDone}/{g.items.length} 完成</span>
              </div>
            )}
            <div className="divide-y divide-[color:var(--color-border-subtle)]">
              {g.items.map((s) => {
                const m = roleMeta(s.agent);
                const open = expanded[s.id] ?? isRunning(s);   // 运行中的默认展开
                const steps = s.trail || [];
                return (
                  <div key={s.id}>
                    <button
                      type="button"
                      onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] text-left"
                    >
                      <StatusIcon status={s.status} />
                      {!isBatch && (
                        <span className={`text-[9.5px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 shrink-0 ${m.cls}`}>
                          <m.Icon className="w-2.5 h-2.5" />{m.label}
                        </span>
                      )}
                      <span className="flex-1 min-w-0 text-[11px] [color:var(--color-text-main)] truncate">{s.task || '—'}</span>
                      {isRunning(s) && s.tool && (
                        <span className="text-[9.5px] font-mono text-brand-light animate-pulse shrink-0 max-w-[140px] truncate">{s.tool}</span>
                      )}
                      <span className="text-[9.5px] font-mono [color:var(--color-text-muted)] shrink-0">{fmtElapsed(elapsedOf(s))}</span>
                      <ChevronRight className={`w-3 h-3 shrink-0 [color:var(--color-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} />
                    </button>

                    {open && (
                      <div className="px-3 pb-2.5">
                        <div className="rounded-xl border border-white/50 dark:border-white/10 bg-white/50 dark:bg-white/[.04] p-2 max-h-52 overflow-y-auto custom-scrollbar space-y-0.5 font-mono">
                          {steps.length === 0 && (
                            <div className="text-[9.5px] [color:var(--color-text-muted)] font-sans py-1">等待工具调用…</div>
                          )}
                          {steps.map((st, i) => (
                            <div key={i} className="text-[9.5px] leading-relaxed flex items-start gap-1.5">
                              <span className="[color:var(--color-text-muted)] shrink-0">{fmtTime(st.t)}</span>
                              {st.phase === 'result'
                                ? (st.status === 'error'
                                  ? <XCircle className="w-2.5 h-2.5 text-red-400 shrink-0 mt-[3px]" />
                                  : <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400 shrink-0 mt-[3px]" />)
                                : <span className="text-brand-light shrink-0 font-bold">→</span>}
                              <span className={`shrink-0 ${st.phase === 'calling' ? 'text-brand-light' : st.status === 'error' ? 'text-red-300' : '[color:var(--color-text-main)]'}`}>
                                {st.tool || '—'}
                              </span>
                              {st.detail && <span className="text-red-300/85 break-all">{st.detail}</span>}
                            </div>
                          ))}
                        </div>
                        {s.error && <div className="text-[9.5px] text-red-300 mt-1.5 leading-relaxed">✗ {s.error}</div>}
                        {!s.error && s.status === 'success' && s.result && (
                          <div className="text-[9.5px] text-emerald-300/90 mt-1.5 leading-relaxed whitespace-pre-wrap line-clamp-3">{s.result}</div>
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
