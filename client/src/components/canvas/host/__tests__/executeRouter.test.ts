import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

vi.mock('../../../../services/api', () => ({
  apiService: {
    parseScript: vi.fn(),
    callMcpTool: vi.fn(),
    expandPrompt: vi.fn(),
    getProvider: vi.fn(),
    listProviders: vi.fn(async () => ({ providers: [] })),
  },
}));
vi.mock('../../hooks/nodeAgentExecutor', () => ({ executeAgentNode: vi.fn() }));
vi.mock('../../kit/useGeneration', async (orig) => {
  const mod = await orig<typeof import('../../kit/useGeneration')>();
  return { ...mod, runGeneration: vi.fn(async () => ({ url: '/gen.png', patch: {} })) };
});

import '../../nodes2';
import { apiService } from '../../../../services/api';
import { executeAgentNode } from '../../hooks/nodeAgentExecutor';
import { runGeneration } from '../../kit/useGeneration';
import { createExecuteRouter, formatScript, normalizeTextSkill } from '../executeRouter';

/** REQ-toonflow-canvas H1：宿主 execute 路由（文本技能 / 媒体 / 3D 导演 / custom / script-split / ext-node），失败必须 reject。 */

type AnyData = Record<string, any>;
const api = apiService as unknown as Record<string, ReturnType<typeof vi.fn>>;

function harness(nodes: Node[], edges: Edge[] = [], fetchImpl?: typeof fetch) {
  const state = new Map(nodes.map((n) => [n.id, { ...n, data: { ...(n.data as AnyData) } }]));
  const writes: Array<[string, AnyData]> = [];
  const fetchMock = vi.fn(fetchImpl ?? (async () => new Response(JSON.stringify({ status: 'success', text: '生成的正文' }), { status: 200 })));
  const execute = createExecuteRouter({
    getNode: (id) => state.get(id),
    getEdges: () => edges,
    updateNodeData: (id, patch) => {
      writes.push([id, patch]);
      const cur = state.get(id);
      if (cur) state.set(id, { ...cur, data: { ...(cur.data as AnyData), ...patch } });
    },
    projectId: () => 'proj_x',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { execute, writes, state, fetchMock, data: (id: string) => state.get(id)!.data as AnyData };
}
const node = (id: string, type: string, data: AnyData = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });

/** SSE 响应（COORDINATION 14）：每个事件一块 `data: {...}\n\n`；gapMs 控制事件间隔，signal 中止时报 AbortError。 */
function sse(events: AnyData[], opts: { gapMs?: number; signal?: AbortSignal; onEvent?: (i: number) => void } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.gapMs && i > 0) await new Promise((r) => setTimeout(r, opts.gapMs));
      if (opts.signal?.aborted) { c.error(new DOMException('The operation was aborted.', 'AbortError')); return; }
      if (i >= events.length) { c.close(); return; }
      c.enqueue(enc.encode(`data: ${JSON.stringify(events[i])}\n\n`));
      opts.onEvent?.(i);
      i++;
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset?.();
  api.listProviders.mockResolvedValue({ providers: [] });
  vi.mocked(executeAgentNode).mockReset();
  vi.mocked(runGeneration).mockClear();
});

describe('文本节点技能路由', () => {
  it('技能 id 归一：旧 custom_text / 空 → 自由生成', () => {
    expect(normalizeTextSkill('custom_text')).toBe('free_generation');
    expect(normalizeTextSkill('')).toBe('free_generation');
    expect(normalizeTextSkill('prompt_expansion')).toBe('prompt_expansion');
  });

  it('free_generation → 流式 POST /llm/generate/stream：增量写进正文（text 与 prompt 同写），done 写最终全文（overrides 不落盘）', async () => {
    const h = harness([node('t', 'prompt', { prompt: '旧正文', text: '旧正文' })], [], async () => sse([{ delta: '生成' }, { delta: '的' }, { delta: '正文' }, { done: true, text: '生成的正文' }]));
    const res = await h.execute('t', { skill_id: 'free_generation', prompt: '写一段开场白', reference_images: ['/a.png'] });
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/llm\/generate\/stream$/);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ prompt: '写一段开场白', skill: 'free_generation', images: ['/a.png'] });
    // 系统提示由后端按 skill 取，前端不传
    expect(body.system).toBeUndefined();
    // 第一个增量立刻写进正文，并标记 streaming（节点据此显示正文而不是整块转圈）
    const firstText = h.writes.find(([, p]) => 'text' in p)![1];
    expect(firstText).toMatchObject({ text: '生成', prompt: '生成', agent_state: { status: 'running', streaming: true } });
    expect(h.data('t')).toMatchObject({ text: '生成的正文', prompt: '生成的正文', agent_state: { status: 'completed' } });
    expect(h.data('t').skill_id).toBeUndefined();
    expect(res).toEqual({ text: '生成的正文' });
  });

  it('流式增量按 ~80ms 节流写回（间隔够长的增量各写一次，最后以 done 的全文为准）', async () => {
    const h = harness([node('t', 'prompt', {})], [], async () => sse([{ delta: 'a' }, { delta: 'b' }, { delta: 'c' }, { done: true, text: 'abc!' }], { gapMs: 120 }));
    await h.execute('t', { skill_id: 'free_generation', prompt: 'x' });
    const texts = h.writes.filter(([, p]) => 'text' in p).map(([, p]) => p.text);
    expect(texts).toEqual(['a', 'ab', 'abc', 'abc!']);
  });

  it('同一时刻涌来的增量合并写（不逐字写）', async () => {
    const deltas = Array.from({ length: 30 }, (_, i) => ({ delta: String(i % 10) }));
    const h = harness([node('t', 'prompt', {})], [], async () => sse([...deltas, { done: true, text: 'END' }]));
    await h.execute('t', { skill_id: 'free_generation', prompt: 'x' });
    const texts = h.writes.filter(([, p]) => 'text' in p).map(([, p]) => p.text);
    expect(texts.length).toBeLessThanOrEqual(3);
    expect(texts[texts.length - 1]).toBe('END');
  });

  it('流中途 error 事件 → reject、写 failed，并把正文还原成执行前的内容', async () => {
    const h = harness([node('t', 'prompt', { prompt: '旧正文', text: '旧正文' })], [], async () => sse([{ delta: '半截' }, { error: '上游超时' }]));
    await expect(h.execute('t', { skill_id: 'prompt_expansion', prompt: '旧正文' })).rejects.toThrow('上游超时');
    expect(h.writes.some(([, p]) => p.text === '半截')).toBe(true);
    expect(h.data('t')).toMatchObject({ text: '旧正文', prompt: '旧正文', agent_state: { status: 'failed', error: '上游超时' } });
  });

  it('流没有 done 就断开 → reject（正文还原）', async () => {
    const h = harness([node('t', 'prompt', {})], [], async () => sse([{ delta: '半截' }]));
    await expect(h.execute('t', { skill_id: 'free_generation', prompt: 'x' })).rejects.toThrow(/意外结束/);
    expect(h.data('t').text).toBeUndefined();
    expect(h.data('t').prompt).toBeUndefined();
  });

  it('停止生成：overrides.signal 中止 → resolve，保留已生成部分，状态 idle；signal 不进请求体', async () => {
    const ctrl = new AbortController();
    const h = harness([node('t', 'prompt', { prompt: '旧', text: '旧' })], [], async (_u, init) => sse([{ delta: '已生成' }, { delta: '的部分' }, { done: true, text: 'x' }], {
      gapMs: 60, signal: (init as RequestInit).signal ?? undefined, onEvent: (i) => { if (i === 0) ctrl.abort(); },
    }));
    const res = await h.execute('t', { skill_id: 'free_generation', prompt: 'x', signal: ctrl.signal });
    const body = JSON.parse(String((h.fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.signal).toBeUndefined();
    expect(h.data('t')).toMatchObject({ text: '已生成', prompt: '已生成', agent_state: { status: 'idle' } });
    expect(res).toEqual({ text: '已生成' });
  });

  it('HTTP 失败 → reject，正文不动', async () => {
    const h = harness([node('t', 'prompt', { prompt: '旧', text: '旧' })], [], async () => new Response(JSON.stringify({ detail: 'LLM 生成失败: no key' }), { status: 502 }));
    await expect(h.execute('t', { skill_id: 'free_generation', prompt: 'x' })).rejects.toThrow(/no key/);
    expect(h.data('t')).toMatchObject({ text: '旧', prompt: '旧', agent_state: { status: 'failed' } });
  });

  it('后端还没有流式接口（404）→ 退回一次性 /llm/generate', async () => {
    const h = harness([node('t', 'prompt', {})], [], async (u) => (String(u).endsWith('/stream')
      ? new Response('Not Found', { status: 404 })
      : new Response(JSON.stringify({ status: 'success', text: '一次性正文' }), { status: 200 })));
    await h.execute('t', { skill_id: 'free_generation', prompt: '写', reference_images: ['/a.png'] });
    const [url2, init2] = h.fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toMatch(/\/llm\/generate$/);
    expect(JSON.parse(String(init2.body))).toMatchObject({ prompt: '写', images: ['/a.png'] });
    expect(h.data('t')).toMatchObject({ text: '一次性正文', prompt: '一次性正文', agent_state: { status: 'completed' } });
  });

  it('失败要 reject，并写 agent_state.failed', async () => {
    const h = harness([node('t', 'prompt', {})], [], async () => new Response(JSON.stringify({ detail: 'LLM 生成失败: no key' }), { status: 502 }));
    await expect(h.execute('t', { skill_id: 'free_generation', prompt: 'x' })).rejects.toThrow(/no key/);
    expect(h.data('t').agent_state).toMatchObject({ status: 'failed' });
    expect(h.data('t').text).toBeUndefined();
  });

  it('自由生成没有指令 → reject', async () => {
    const h = harness([node('t', 'prompt', {})]);
    await expect(h.execute('t', { skill_id: 'free_generation', prompt: '  ' })).rejects.toThrow();
  });

  it('剧本拆解：parseScript → 逐行文本 + script_data', async () => {
    const res = { scenes: [{ scene_index: 1, shots: [{ shot_index: 1, camera_framing: 'medium', action_desc: '回眸', dialogue: '' }] }] };
    api.parseScript.mockResolvedValue(res);
    const h = harness([node('t', 'prompt', { prompt: '小说' })]);
    await h.execute('t', { skill_id: 'script_generation', prompt: '小说正文' });
    expect(api.parseScript).toHaveBeenCalledWith('小说正文', 'donghua_xianxia', '9:16');
    expect(h.data('t').text).toBe(formatScript(res));
    expect(h.data('t').prompt).toBe(h.data('t').text);
    expect(h.data('t').script_data).toBe(res);
  });

  it('策划案：流式 skill=proposal_generation（系统提示后端按 skill 取，与 text_skills 一致），不调 split_novel_script', async () => {
    const h = harness([node('t', 'prompt', {})], [], async () => sse([{ delta: '# 策划案' }, { done: true, text: '# 策划案\n世界观' }]));
    await h.execute('t', { skill_id: 'proposal_generation', prompt: '仙侠题材' });
    expect(api.callMcpTool).not.toHaveBeenCalled();
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/llm\/generate\/stream$/);
    expect(JSON.parse(String(init.body))).toEqual({ prompt: '仙侠题材', skill: 'proposal_generation' });
    expect(h.data('t').text).toBe('# 策划案\n世界观');
    expect(h.data('t').prompt).toBe(h.data('t').text);
  });

  it('策划案流式不可用 → 退回 /llm/generate + 策划案系统提示', async () => {
    const h = harness([node('t', 'prompt', {})], [], async (u) => (String(u).endsWith('/stream')
      ? new Response('', { status: 405 })
      : new Response(JSON.stringify({ status: 'success', text: '生成的正文' }), { status: 200 })));
    await h.execute('t', { skill_id: 'proposal_generation', prompt: '仙侠题材' });
    const body = JSON.parse(String((h.fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.system).toMatch(/策划案/);
    expect(h.data('t').text).toBe('生成的正文');
  });

  it('扩写：流式 skill=prompt_expansion；返回空 → reject', async () => {
    const ok = harness([node('t', 'prompt', { prompt: '短' })], [], async () => sse([{ delta: 'long ' }, { delta: 'prompt' }, { done: true, text: 'long prompt' }]));
    await ok.execute('t', { skill_id: 'prompt_expansion', prompt: '短' });
    expect(JSON.parse(String((ok.fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ prompt: '短', skill: 'prompt_expansion' });
    expect(api.expandPrompt).not.toHaveBeenCalled();
    expect(ok.data('t')).toMatchObject({ text: 'long prompt', prompt: 'long prompt' });

    const h = harness([node('t', 'prompt', { prompt: '短' })], [], async () => sse([{ done: true, text: '  ' }]));
    await expect(h.execute('t', { skill_id: 'prompt_expansion' })).rejects.toThrow(/为空/);
  });

  it('扩写流式不可用 → 退回 /llm/expand；返回空 → reject', async () => {
    api.expandPrompt.mockResolvedValue('');
    const h = harness([node('t', 'prompt', { prompt: '短' })], [], async () => new Response('', { status: 404 }));
    await expect(h.execute('t', { skill_id: 'prompt_expansion' })).rejects.toThrow(/为空/);
    expect(api.expandPrompt).toHaveBeenCalledWith('短', 'image');
  });
});

describe('3D 导演：director_3d_stage_plan', () => {
  it('参数写回 + 本地重算运镜提示词（两键同值）', async () => {
    api.callMcpTool.mockResolvedValue({ status: 'success', result: { framing: 'close_up', motion: 'orbit', focal_length_mm: 50, minimax_camera_prompt: '[EN]', parse_mode: 'keyword', engine: 'x' } });
    const h = harness([node('d', 'director3d', { framing: 'medium', motion: 'push_in' })]);
    await h.execute('d', { ai_directive: '特写环绕', framing: 'medium' });
    expect(api.callMcpTool).toHaveBeenCalledWith('director_3d_stage_plan', expect.objectContaining({ ai_directive: '特写环绕', framing: 'medium' }));
    const d = h.data('d');
    expect(d).toMatchObject({ framing: 'close_up', motion: 'orbit', focal_length_mm: 50, parse_mode: 'keyword' });
    expect(d.camera_prompt).toBeTruthy();
    expect(d.minimax_camera_prompt).toBe(d.camera_prompt);
    expect(d.engine).toBeUndefined();
  });
  it('MCP 报错 → reject', async () => {
    api.callMcpTool.mockResolvedValue({ status: 'error', error: 'boom' });
    const h = harness([node('d', 'director3d', {})]);
    await expect(h.execute('d', {})).rejects.toThrow(/boom/);
  });
});

describe('custom / script-split / ext-node', () => {
  it('custom → executeAgentNode（/custom-nodes/run），overrides 原样交给执行器', async () => {
    const h = harness([node('c', 'custom', { custom_node_id: 'up' })]);
    await h.execute('c', { video: '/v.mp4' });
    expect(executeAgentNode).toHaveBeenCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'c', type: 'custom' }), override: { video: '/v.mp4' } }));
  });
  it('custom：overrides 里的 signal 不交给执行器；返回产物 url', async () => {
    vi.mocked(executeAgentNode).mockResolvedValueOnce({ status: 'success', video_url: '/o.mp4' });
    const h = harness([node('c', 'custom', { custom_node_id: 'up' })]);
    const res = await h.execute('c', { video: '/v.mp4', signal: new AbortController().signal });
    expect(vi.mocked(executeAgentNode).mock.calls[0][0].override).toEqual({ video: '/v.mp4' });
    expect(res).toEqual({ url: '/o.mp4' });
  });
  it('custom 执行失败 → reject', async () => {
    vi.mocked(executeAgentNode).mockRejectedValue(new Error('缺少输入视频'));
    const h = harness([node('c', 'custom', { custom_node_id: 'up' })]);
    await expect(h.execute('c', {})).rejects.toThrow('缺少输入视频');
  });

  it('script-split：/canvas/node/execute 的 {project} 写进 result', async () => {
    const h = harness([node('s', 'script-split', {})], [], async () => new Response(JSON.stringify({ result: { status: 'success', project: { scenes: [1] } } }), { status: 200 }));
    await h.execute('s', { brief: '简报' });
    const body = JSON.parse(String((h.fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ node: { id: 's', type: 'script-split', data: { brief: '简报' } }, project_id: 'proj_x' });
    expect(h.data('s').result).toEqual({ scenes: [1] });
  });
  it('script-split 失败 → reject 并写 error', async () => {
    const h = harness([node('s', 'script-split', {})], [], async () => new Response(JSON.stringify({ result: { status: 'error', error: '拆解失败' } }), { status: 200 }));
    await expect(h.execute('s', {})).rejects.toThrow('拆解失败');
    expect(h.data('s').error).toBe('拆解失败');
  });

  it('ext-node：不上传 definition，产出 outputs 写回；失败 reject', async () => {
    const h = harness([node('x', 'ext-node', { canvas_node_id: 'upscale_ext', definition: { big: true } })], [], async () => new Response(JSON.stringify({ result: { status: 'success', video_url: '/o.mp4', outputs: { video: '/o.mp4' } } }), { status: 200 }));
    await h.execute('x', { video: '/v.mp4' });
    const body = JSON.parse(String((h.fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.node.data.definition).toBeUndefined();
    expect(body.node.data.video).toBe('/v.mp4');
    expect(h.data('x')).toMatchObject({ video_url: '/o.mp4', outputs: { video: '/o.mp4' }, agent_state: { status: 'completed' } });

    const bad = harness([node('x', 'ext-node', { canvas_node_id: 'upscale_ext' })], [], async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 500 }));
    await expect(bad.execute('x', {})).rejects.toThrow('nope');
    expect(bad.data('x').agent_state).toMatchObject({ status: 'failed' });
  });

  it('节点不存在 → reject', async () => {
    const h = harness([]);
    await expect(h.execute('missing')).rejects.toThrow('节点不存在');
  });
});

describe('媒体生成（宿主侧）：按连线组装参考 → runGeneration', () => {
  it('视频：文本参考作主体、图片按 refRoles 落首帧', async () => {
    api.getProvider.mockResolvedValue({ provider: { id: 'kling', input_schema: { properties: { prompt: { type: 'string' }, first_frame: { type: 'string', format: 'uri', 'x-handle': 'first_frame' } } } } });
    const nodes = [
      node('t', 'prompt', { prompt: '少女回眸' }),
      node('i', 'load-image', { image_url: '/a.png' }),
      node('v', 'video', { prompt: '', provider_id: 'kling', refRoles: { 'i|image': 'first_frame' }, params: { duration: 5 } }),
    ];
    const edges: Edge[] = [
      { id: 'e1', source: 't', sourceHandle: 'prompt', target: 'v', targetHandle: 'in' },
      { id: 'e2', source: 'i', sourceHandle: 'image', target: 'v', targetHandle: 'in' },
    ];
    const h = harness(nodes, edges);
    await h.execute('v');
    const call = vi.mocked(runGeneration).mock.calls[0][0];
    expect(call).toMatchObject({ nodeId: 'v', nodeType: 'video', kind: 'video', providerId: 'kling', params: { duration: 5 } });
    expect(call.assembled.prompt).toBe('少女回眸');
    expect(call.assembled.canonical.first_frame).toBe('/a.png');
  });
  it('execute 返回产物 url（D4：分镜子图自动运行据此回写，不读渲染前的 nodesRef）', async () => {
    api.getProvider.mockResolvedValue({ provider: { id: 'comfyui_video', input_schema: { properties: { prompt: { type: 'string' } } } } });
    vi.mocked(runGeneration).mockResolvedValueOnce({ url: '/storage/videos/out.mp4', patch: {} });
    const h = harness([node('v', 'video', { prompt: 'x', provider_id: 'comfyui_video' })]);
    await expect(h.execute('v')).resolves.toEqual({ url: '/storage/videos/out.mp4' });
  });
  it('生成失败 → reject', async () => {
    vi.mocked(runGeneration).mockRejectedValueOnce(new Error('请先在节点内选择生成源'));
    const h = harness([node('i', 'image', { prompt: 'x' })]);
    await expect(h.execute('i')).rejects.toThrow('请先在节点内选择生成源');
  });
});
