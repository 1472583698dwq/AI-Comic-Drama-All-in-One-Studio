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

  it('free_generation → POST /llm/generate，text 与 prompt 写同一内容（overrides 不落盘）', async () => {
    const h = harness([node('t', 'prompt', { prompt: '旧正文', text: '旧正文' })]);
    await h.execute('t', { skill_id: 'free_generation', prompt: '写一段开场白', reference_images: ['/a.png'] });
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/llm\/generate$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: '写一段开场白', images: ['/a.png'] });
    expect(h.data('t')).toMatchObject({ text: '生成的正文', prompt: '生成的正文', agent_state: { status: 'completed', tool: 'llm/generate' } });
    expect(h.data('t').skill_id).toBeUndefined();
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

  it('策划案：走 /llm/generate + 策划案系统提示（与后端 text_skills 一致），不再调 split_novel_script', async () => {
    const h = harness([node('t', 'prompt', {})]);
    await h.execute('t', { skill_id: 'proposal_generation', prompt: '仙侠题材' });
    expect(api.callMcpTool).not.toHaveBeenCalled();
    const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/llm\/generate$/);
    const body = JSON.parse(String(init.body));
    expect(body.prompt).toBe('仙侠题材');
    expect(body.system).toMatch(/策划案/);
    expect(h.data('t').text).toBe('生成的正文');
    expect(h.data('t').prompt).toBe(h.data('t').text);
  });

  it('扩写返回空 → reject', async () => {
    api.expandPrompt.mockResolvedValue('');
    const h = harness([node('t', 'prompt', { prompt: '短' })]);
    await expect(h.execute('t', { skill_id: 'prompt_expansion' })).rejects.toThrow(/为空/);
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
  it('生成失败 → reject', async () => {
    vi.mocked(runGeneration).mockRejectedValueOnce(new Error('请先在节点内选择生成源'));
    const h = harness([node('i', 'image', { prompt: 'x' })]);
    await expect(h.execute('i')).rejects.toThrow('请先在节点内选择生成源');
  });
});
