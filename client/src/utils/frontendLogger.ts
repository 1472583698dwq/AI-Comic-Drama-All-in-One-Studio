// -*- coding: utf-8 -*-
/**
 * 前端错误采集 → 回传后端日志（storage/logs/studio.log，标 [frontend]）。
 * 钩住三类来源，调用点零改动：
 * ① window.onerror（同步异常）
 * ② unhandledrejection（未处理 Promise）
 * ③ window.fetch 包装（API 4xx/5xx 自动记录 URL/状态/响应片段）
 * 环形缓冲 + 5s 批量回传（keepalive），15s 内相同消息去重，防止错误风暴打爆日志。
 */
import { API_BASE_URL } from './devOrigin';

export interface FrontendLogEntry {
  level: 'error' | 'warn';
  message: string;
  stack?: string;
  source: string;
  ts?: number;
}

const BUFFER: FrontendLogEntry[] = [];
const MAX_BUFFER = 100;
const DEDUPE_MS = 15000;
const FLUSH_MS = 5000;
const recent = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function dedupeKey(e: FrontendLogEntry): string {
  return `${e.source}|${e.message.slice(0, 200)}`;
}

export function pushFrontendLog(entry: FrontendLogEntry): void {
  try {
    const key = dedupeKey(entry);
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < DEDUPE_MS) return;
    recent.set(key, now);
    if (recent.size > 300) {
      for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);
    }
    BUFFER.push({ ...entry, ts: now });
    if (BUFFER.length > MAX_BUFFER) BUFFER.splice(0, BUFFER.length - MAX_BUFFER);
    if (!flushTimer) flushTimer = setTimeout(flushFrontendLogs, FLUSH_MS);
  } catch { /* 采集自身绝不抛错 */ }
}

export async function flushFrontendLogs(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!BUFFER.length) return;
  const entries = BUFFER.splice(0, BUFFER.length);
  try {
    await fetch(`${API_BASE_URL}/system/logs/frontend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      keepalive: true,
    });
  } catch { /* 丢了就丢了，不能因日志再报错 */ }
}

/** 应用入口调用一次（main.tsx）：装好全部钩子 */
export function installFrontendErrorHooks(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    pushFrontendLog({
      level: 'error',
      message: `未捕获异常: ${e.message || 'unknown'} (${e.filename || '?'}:${e.lineno || 0}:${e.colno || 0})`,
      stack: (e.error && (e.error as any).stack) ? String((e.error as any).stack).slice(0, 4000) : undefined,
      source: 'window.onerror',
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r ?? 'unknown');
    pushFrontendLog({
      level: 'error',
      message: `未处理 Promise 拒绝: ${msg}`,
      stack: r instanceof Error && r.stack ? String(r.stack).slice(0, 4000) : undefined,
      source: 'unhandledrejection',
    });
  });

  // fetch 包装：API 4xx/5xx 自动入档（排除日志接口自身，防循环）
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await origFetch(input as any, init);
    try {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request)?.url || '');
      if (res.status >= 400 && !url.includes('/system/logs/')) {
        const method = (init?.method || (input as Request)?.method || 'GET').toUpperCase();
        let body = '';
        try { body = (await res.clone().text()).slice(0, 500); } catch { /* ignore */ }
        pushFrontendLog({
          level: res.status >= 500 ? 'error' : 'warn',
          message: `API ${method} ${url} -> ${res.status}`,
          stack: body || undefined,
          source: 'fetch',
        });
      }
    } catch { /* ignore */ }
    return res;
  };

  // 页面关闭前把缓冲冲掉
  window.addEventListener('pagehide', () => { void flushFrontendLogs(); });
}
