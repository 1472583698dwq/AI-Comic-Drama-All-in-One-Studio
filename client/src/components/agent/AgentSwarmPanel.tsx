/**
 * 子代理集群面板 — 父会话可见的专家子代理 roster（参考 Kimi Agent Swarm 进度视图）。
 * 数据来自 subagent_started / subagent_progress / subagent_settled 事件（agentStore.subagents）。
 * 特性：角色图标 chip、批次分组、运行中实时计时、折叠。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, XCircle, Loader2, Clock, ChevronDown } from 'lucide-react';
import type { SubAgentInfo } from './agentTypes';
import { roleMeta, fmtElapsed } from './swarmMeta';

interface SwarmGroup {
  batchId: string;
  items: SubAgentInfo[];
}

const StatusIcon: React.FC<{ status: string; className?: string }> = ({ status, className }) => {
  if (status === 'success') return <CheckCircle2 className={`w-3.5 h-3.5 text-emerald-400 shrink-0 ${className || ''}`} />;
  if (status === 'error' || status === 'cancelled') return <XCircle className={`w-3.5 h-3.5 text-red-400 shrink-0 ${className || ''}`} />;
  if (status === 'queued' || status === 'launched') return <Clock className={`w-3.5 h-3.5 text-gray-400 shrink-0 ${className || ''}`} />;
  return <Loader2 className={`w-3.5 h-3.5 text-amber-300 animate-spin shrink-0 ${className || ''}`} />;
};

export const AgentSwarmPanel: React.FC<{
  subagents: Record<string, SubAgentInfo>;
  /** 悬浮窗紧凑模式：更小的行高与最多 4 行 */
  compact?: boolean;
}> = ({ subagents, compact }) => {
  const list = useMemo(() => Object.values(subagents), [subagents]);
  const running = list.filter((s) => s.status === 'running' || s.status === 'queued' || s.status === 'launched').length;
  const done = list.filter((s) => s.status === 'success').length;
  const failed = list.filter((s) => s.status === 'error' || s.status === 'cancelled').length;
  const [collapsed, setCollapsed] = useState(false);
  // 运行中：每秒刷新"当前时间"，让耗时实时走动（不在渲染期直接调 Date.now）
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // 批次分组（连续同 batch 合并；无批次各自成组）
  const groups = useMemo<SwarmGroup[]>(() => {
    const out: SwarmGroup[] = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (s.batchId && last && last.batchId === s.batchId) last.items.push(s);
      else out.push({ batchId: s.batchId || '', items: [s] });
    }
    return out;
  }, [list]);

  if (list.length === 0) return null;
  const maxRows = compact ? 4 : 12;
  let rendered = 0;

  return (
    <div className={`${compact ? 'mx-2 mt-1.5' : 'mx-4 mt-2'} rounded-xl border border-border bg-surface-secondary/40 overflow-hidden shrink-0`}>
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={`w-full px-3 ${compact ? 'py-1' : 'py-1.5'} flex items-center gap-2 text-[10px] font-bold text-gray-300 hover:bg-white/5`}
        title="子代理集群（点击折叠/展开）"
      >
        <Bot className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-accent-purple`} />
        <span>子代理集群</span>
        <span className="font-normal text-gray-500">{list.length} 个</span>
        {running > 0 && <span className="text-amber-300 animate-pulse">{running} 运行中</span>}
        {done > 0 && <span className="text-emerald-400">{done} 完成</span>}
        {failed > 0 && <span className="text-red-400">{failed} 失败</span>}
        <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>
      {!collapsed && (
        <div className={`px-3 pb-2 space-y-1 ${compact ? 'max-h-28' : 'max-h-44'} overflow-y-auto custom-scrollbar`}>
          {groups.map((g, gi) => {
            if (rendered >= maxRows) return null;
            const gDone = g.items.filter((s) => s.status === 'success').length;
            const gFail = g.items.filter((s) => s.status === 'error' || s.status === 'cancelled').length;
            const isBatch = g.items.length > 1 || !!g.batchId;
            const rows: React.ReactNode[] = [];
            if (isBatch) {
              rows.push(
                <div key={`g${gi}`} className="flex items-center gap-1.5 pt-1 text-[10px] text-gray-400">
                  <span className="font-bold">批次 ×{g.items.length}</span>
                  <span className="text-gray-500">{gDone}/{g.items.length} 完成{gFail > 0 ? ` · ${gFail} 失败` : ''}</span>
                  <span className="flex-1 h-px bg-white/5" />
                </div>,
              );
            }
            for (const s of g.items) {
              if (rendered >= maxRows) {
                rows.push(
                  <div key="more" className="text-[10px] text-gray-500 pl-1">…还有 {list.length - rendered} 个（点击列表查看）</div>,
                );
                break;
              }
              rendered += 1;
              const meta = roleMeta(s.agent);
              const elapsed = s.status === 'running' && s.startedAt ? now - s.startedAt : (s.elapsedMs || 0);
              rows.push(
                <div key={s.id} className={`flex items-center gap-2 ${compact ? 'text-[10px]' : 'text-[11px]'} ${isBatch ? 'pl-2' : ''}`}>
                  <StatusIcon status={s.status} />
                  <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded border text-[10px] font-bold ${meta.cls}`}>
                    <meta.Icon className="w-3 h-3" />
                    {meta.label}
                  </span>
                  <span className="text-gray-400 truncate flex-1" title={s.task}>{s.task}</span>
                  {s.status === 'running' && s.tool && (
                    <span className="text-gray-500 font-mono shrink-0 max-w-[110px] truncate" title={s.tool}>{s.tool}</span>
                  )}
                  {elapsed > 0 && <span className="text-gray-500 font-mono shrink-0">{fmtElapsed(elapsed)}</span>}
                  {s.status === 'error' && s.error && (
                    <span className="text-red-400/80 truncate max-w-[160px] shrink-0" title={s.error}>{s.error}</span>
                  )}
                </div>,
              );
            }
            return <React.Fragment key={gi}>{rows}</React.Fragment>;
          })}
        </div>
      )}
    </div>
  );
};
