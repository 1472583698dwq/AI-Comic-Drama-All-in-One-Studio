import { describe, expect, it, vi } from 'vitest';
import { StreamUnavailableError, parseSseBlock, streamLlmText } from '../textStream';

/** REQ-toonflow-canvas B1：SSE 解析（COORDINATION 14 契约）。 */

function chunked(chunks: string[], headers: Record<string, string> = { 'Content-Type': 'text/event-stream' }): Response {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) { c.close(); return; }
      c.enqueue(enc.encode(chunks[i++]));
    },
  }), { status: 200, headers });
}

describe('parseSseBlock', () => {
  it('data 行拼接、注释 / 其他字段忽略、非 JSON 返回 null', () => {
    expect(parseSseBlock('data: {"delta":"a"}')).toEqual({ delta: 'a' });
    expect(parseSseBlock(': ping\nevent: message\ndata: {"done":true,"text":"x"}')).toEqual({ done: true, text: 'x' });
    expect(parseSseBlock('data:{"delta":"无空格"}')).toEqual({ delta: '无空格' });
    expect(parseSseBlock(': keep-alive')).toBeNull();
    expect(parseSseBlock('data: not json')).toBeNull();
  });
});

describe('streamLlmText', () => {
  it('事件被拆在任意分块边界（含 CRLF）也能正确累积；以 done.text 为准', async () => {
    const f = vi.fn(async () => chunked(['data: {"del', 'ta":"你"}\r\n\r\ndata: {"delta":"好', '"}\n\ndata: {"done":true,"text":"你好！"}\n\n']));
    const deltas: string[] = [];
    const out = await streamLlmText({ prompt: 'p', skill: 'free_generation' }, { fetch: f as unknown as typeof fetch, onDelta: (d, all) => deltas.push(`${d}|${all}`) });
    expect(out).toBe('你好！');
    expect(deltas).toEqual(['你|你', '好|你好']);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/llm\/generate\/stream$/);
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'p', skill: 'free_generation' });
  });

  it('done 不带 text 时用累积值；中文多字节被拆开也不乱码', async () => {
    const bytes = new TextEncoder().encode('data: {"delta":"中文"}\n\ndata: {"done":true}\n\n');
    const enc = [bytes.slice(0, 17), bytes.slice(17)];
    let i = 0;
    const res = new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i >= enc.length) c.close(); else c.enqueue(enc[i++]); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => res) as unknown as typeof fetch })).resolves.toBe('中文');
  });

  it('error 事件 → reject；没有 done 就结束 → reject', async () => {
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => chunked(['data: {"delta":"a"}\n\ndata: {"error":"上游超时"}\n\n'])) as unknown as typeof fetch })).rejects.toThrow('上游超时');
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => chunked(['data: {"delta":"a"}\n\n'])) as unknown as typeof fetch })).rejects.toThrow(/意外结束/);
  });

  it('404 / 405 → StreamUnavailableError；其余 HTTP 错误带 detail', async () => {
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })).rejects.toBeInstanceOf(StreamUnavailableError);
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => new Response(JSON.stringify({ detail: '未配置 LLM' }), { status: 502 })) as unknown as typeof fetch })).rejects.toThrow('未配置 LLM');
  });

  it('代理把流缓冲成 JSON：按 {text} 一次性返回', async () => {
    const onDelta = vi.fn();
    const res = new Response(JSON.stringify({ text: '整段' }), { headers: { 'Content-Type': 'application/json' } });
    await expect(streamLlmText({ prompt: 'p' }, { fetch: (async () => res) as unknown as typeof fetch, onDelta })).resolves.toBe('整段');
    expect(onDelta).toHaveBeenCalledWith('整段', '整段');
  });
});
