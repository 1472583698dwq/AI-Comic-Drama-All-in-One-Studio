// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas B1：文本节点流式生成（design §6.1 / testing B1）——后端 SSE `POST /llm/generate/stream`
 * （契约见 progress/COORDINATION.md 第 14 条）：
 *
 * - 请求体 `{prompt, skill?, system?, images?}`；skill = free_generation | prompt_expansion | proposal_generation，
 *   系统提示由后端按 skill 取（与 /llm/generate、/llm/expand 同款），`system` 只在调用方显式传入时覆盖。
 * - 响应 `text/event-stream`：增量 `data: {"delta":"…"}`，结束 `data: {"done":true,"text":"<完整文本>"}`，
 *   出错 `data: {"error":"…"}` 后结束。上游不支持流式时后端退化为一条 delta + done。
 *
 * 只负责「发请求 + 解析事件」，节流写回节点在 host/executeRouter.runTextSkill。
 */
import { API_BASE_URL } from '../../../utils/devOrigin';

export type StreamSkill = 'free_generation' | 'prompt_expansion' | 'proposal_generation';

export interface StreamTextRequest {
  prompt: string;
  skill?: StreamSkill;
  system?: string;
  images?: string[];
}

export interface StreamTextOptions {
  /** 每个增量回调：本次增量 + 已累积全文 */
  onDelta?: (delta: string, accumulated: string) => void;
  signal?: AbortSignal;
  /** 测试注入（缺省 window.fetch） */
  fetch?: typeof fetch;
}

/** 后端还没有流式接口（404 / 405）：调用方可退回一次性接口。 */
export class StreamUnavailableError extends Error {
  constructor(public readonly status: number) {
    super(`流式接口不可用（HTTP ${status}）`);
    this.name = 'StreamUnavailableError';
  }
}

export const STREAM_PATH = '/llm/generate/stream';

type SseEvent = { delta?: unknown; done?: unknown; text?: unknown; error?: unknown };

/** 解析一个 SSE 事件块（多行 data: 拼接；注释行 / 其他字段忽略）；不是 JSON 的 data 返回 null。 */
export function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const raw = data.join('\n').trim();
  if (!raw || raw === '[DONE]') return raw === '[DONE]' ? { done: true } : null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as SseEvent) : null;
  } catch {
    return null;
  }
}

async function errorDetail(res: Response): Promise<string> {
  const json = await res.json().catch(() => null) as { detail?: unknown; error?: unknown } | null;
  const d = json?.detail ?? json?.error;
  if (typeof d === 'string' && d) return d;
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message;
  return `请求失败（${res.status}）`;
}

/**
 * 流式生成文本：逐个增量回调 onDelta，resolve 完整文本（以 done 事件的 text 为准，缺省用累积值）。
 * 出错事件 / HTTP 错误 / 流中途断开 → reject；signal 中止 → reject（AbortError，调用方按 signal.aborted 区分）。
 */
export async function streamLlmText(req: StreamTextRequest, opts: StreamTextOptions = {}): Promise<string> {
  const f = opts.fetch ?? fetch;
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (req.skill) body.skill = req.skill;
  if (req.system) body.system = req.system;
  if (req.images?.length) body.images = req.images;
  const res = await f(`${API_BASE_URL}${STREAM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (res.status === 404 || res.status === 405) throw new StreamUnavailableError(res.status);
  if (!res.ok) throw new Error(await errorDetail(res));

  // 兜底：网关 / 代理把流式响应缓冲成了一次性 JSON
  const ctype = res.headers.get('content-type') || '';
  if (/application\/json/i.test(ctype)) {
    const json = await res.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (typeof json?.error === 'string' && json.error) throw new Error(json.error);
    const text = typeof json?.text === 'string' ? json.text : '';
    if (text) opts.onDelta?.(text, text);
    return text;
  }
  if (!res.body) throw new Error('流式响应为空');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  const handle = (ev: SseEvent | null): string | null => {
    if (!ev) return null;
    if (typeof ev.error === 'string' || (ev.error && typeof ev.error === 'object')) {
      throw new Error(typeof ev.error === 'string' ? (ev.error || '生成失败') : JSON.stringify(ev.error));
    }
    if (typeof ev.delta === 'string' && ev.delta) {
      acc += ev.delta;
      opts.onDelta?.(ev.delta, acc);
    }
    if (ev.done) return typeof ev.text === 'string' ? ev.text : acc;
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) buf += decoder.decode();
      // 事件以空行分隔（\n\n 或 \r\n\r\n）
      let m: RegExpExecArray | null;
      const sep = /\r?\n\r?\n/g;
      let start = 0;
      while ((m = sep.exec(buf))) {
        const final = handle(parseSseBlock(buf.slice(start, m.index)));
        start = m.index + m[0].length;
        if (final !== null) return final;
      }
      buf = buf.slice(start);
      if (done) {
        const final = handle(parseSseBlock(buf));
        if (final !== null) return final;
        throw new Error('流式响应意外结束');
      }
    }
  } finally {
    // 已结束的流 cancel 无副作用；出错 / 提前返回时关掉连接
    reader.cancel().catch(() => { /* ignore */ });
  }
}
