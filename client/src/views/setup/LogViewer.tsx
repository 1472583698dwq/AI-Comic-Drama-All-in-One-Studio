// -*- coding: utf-8 -*-
/**
 * 日志查看器（设置 → 系统）：实时尾部滚动 + 级别过滤 + 搜索 + 下载/打开文件夹。
 * 后端 storage/logs/studio.log（含 [frontend] 前端错误回传）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Download, FolderOpen, Copy, Loader2, ScrollText, Play, Pause } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';

const LEVELS = [
  { key: '', label: '全部' },
  { key: 'DEBUG', label: 'DEBUG+' },
  { key: 'INFO', label: 'INFO+' },
  { key: 'WARNING', label: 'WARNING+' },
  { key: 'ERROR', label: 'ERROR+' },
];

const RUN_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

/** 行着色：[E]/[C] 红、[W] 黄、[I] 默认、[D] 暗 */
const lineCls = (line: string): string => {
  if (/\[(E|C)\]/.test(line)) return 'text-red-400';
  if (/\[W\]/.test(line)) return 'text-amber-300';
  if (/\[D\]/.test(line)) return 'text-gray-600';
  return 'text-gray-300';
};

export const LogViewer: React.FC = () => {
  const [lines, setLines] = useState<string[]>([]);
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<{ path?: string; size?: number; runLevel?: number }>({});
  const [runLevel, setRunLevel] = useState('INFO');
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [tail, files] = await Promise.all([
        apiService.getLogTail({ lines: 500, level, q }),
        apiService.getLogFiles().catch(() => null),
      ]);
      setLines(tail.lines || []);
      const main = files?.files?.find((f: any) => f.name === 'studio.log');
      const lvlMap: Record<number, string> = { 10: 'DEBUG', 20: 'INFO', 30: 'WARNING', 40: 'ERROR' };
      setInfo({ path: tail.path || files?.main, size: main?.size, runLevel: tail.level });
      if (tail.level !== undefined && tail.level !== null) setRunLevel(lvlMap[tail.level] || 'INFO');
    } catch (e: any) {
      toast.error(`读取日志失败：${e?.message || e}`);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [level, q]);

  // 初次加载与过滤变化（下一 tick 静默拉取，避免 effect 内同步 setState）
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [auto, load]);

  // 新内容到达时贴底（用户上滚后不打扰）
  useEffect(() => {
    if (stickRef.current && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(`已复制 ${lines.length} 行日志`);
    } catch {
      toast.error('复制失败（浏览器未授权剪贴板）');
    }
  };

  const download = async () => {
    try {
      const blob = await apiService.downloadLogBlob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'studio.log';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      toast.error(`下载失败：${e?.message || e}`);
    }
  };

  const openFolder = async () => {
    const dir = (info.path || '').replace(/[\\/][^\\/]+$/, '');
    if (!dir) { toast.error('日志路径未知'); return; }
    try {
      await apiService.openFolder(dir);
    } catch (e: any) {
      toast.error(`打开失败：${e?.message || e}`);
    }
  };

  const changeRunLevel = async (lv: string) => {
    try {
      await apiService.setLogLevel(lv);
      setRunLevel(lv);
      toast.success(`运行日志级别已切换为 ${lv}（立即生效）`);
    } catch (e: any) {
      toast.error(`切换失败：${e?.message || e}`);
    }
  };

  return (
    <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2 flex-wrap">
        <ScrollText className="w-4 h-4 text-brand-light" />
        <h3 className="text-sm font-bold [color:var(--color-text-main)]">日志</h3>
        <span className="text-[10px] text-gray-500 font-mono truncate max-w-[260px]" title={info.path}>
          {info.path || '…'}{info.size ? ` · ${(info.size / 1024).toFixed(0)}KB` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={runLevel} onChange={(e) => changeRunLevel(e.target.value)}
            title="运行级别（DEBUG 记录每个 API 请求流水）"
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1 text-[11px] [color:var(--color-text-main)] focus:outline-none focus:border-brand"
          >
            {RUN_LEVELS.map((l) => <option key={l} value={l}>运行: {l}</option>)}
          </select>
          <select
            value={level} onChange={(e) => setLevel(e.target.value)}
            title="显示最低级别"
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1 text-[11px] [color:var(--color-text-main)] focus:outline-none focus:border-brand"
          >
            {LEVELS.map((l) => <option key={l.key} value={l.key}>显示: {l.label}</option>)}
          </select>
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="搜索关键词…"
            className="w-36 bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2.5 py-1 text-[11px] [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
          />
          <button
            onClick={() => setAuto((v) => !v)}
            title={auto ? '暂停自动刷新' : '开启自动刷新（3s）'}
            className={`px-2 py-1 rounded-lg border text-[11px] flex items-center gap-1 ${auto ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-400 hover:text-white'}`}
          >
            {auto ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}{auto ? '自动' : '暂停'}
          </button>
          <button onClick={() => void load(true)} disabled={loading} title="立即刷新"
            className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] text-gray-300 hover:text-white flex items-center gap-1 disabled:opacity-40">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}刷新
          </button>
          <button onClick={copyAll} title="复制当前全部"
            className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
            <Copy className="w-3 h-3" />复制
          </button>
          <button onClick={download} title="下载 studio.log"
            className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
            <Download className="w-3 h-3" />下载
          </button>
          <button onClick={openFolder} title="打开日志文件夹"
            className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
            <FolderOpen className="w-3 h-3" />文件夹
          </button>
        </div>
      </div>

      <div
        ref={boxRef}
        onScroll={onScroll}
        className="h-72 overflow-y-auto custom-scrollbar px-4 py-2 bg-black/20 font-mono text-[10.5px] leading-[1.7] whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <div className="text-gray-500 py-8 text-center">
            {loading ? '加载中…' : '暂无日志（或被过滤条件排除）。出错后点上方「刷新」，错误会出现在这里。'}
          </div>
        ) : (
          lines.map((ln, i) => <div key={i} className={lineCls(ln)}>{ln}</div>)
        )}
      </div>

      <div className="px-5 py-2 border-t border-white/60 dark:border-white/12 text-[10px] text-gray-500">
        共 {lines.length} 行 · 前端报错自动回传（[frontend]）· 默认只记错误/警告/关键事件，排障时切 DEBUG 可见每个 API 请求耗时
      </div>
    </section>
  );
};
