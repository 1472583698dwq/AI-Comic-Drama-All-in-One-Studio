import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../services/api', () => ({
  apiService: {
    getProvider: vi.fn(async () => ({ provider: { id: 'p', params_schema: { properties: { aspect_ratio: {}, steps: {} } }, input_schema: { properties: { prompt: {}, reference_images: {} } } } })),
    callMcpTool: vi.fn(async () => ({ status: 'success', result: { image_url: '/out.png', width: 832, height: 1216 } })),
    runCustomNode: vi.fn(async () => ({ status: 'success', image_url: '/c.png' })),
    getCustomNode: vi.fn(async () => ({ node: { id: 'cn', input_schema: { properties: { video: {} } }, params_schema: { properties: { scale: {} } } } })),
  },
}));

import { apiService } from '../../../../services/api';
import { PROMPT_OPTIONAL_TYPES, buildAgentArgs, executeAgentNode, missingRequiredInputs, patchFromPayload } from '../../hooks/nodeAgentExecutor';

/** REQ-toonflow-canvas H1：hooks/nodeAgentExecutor 两处修复（N2）。 */

describe('本次 override 参数优先于节点保存的 params', () => {
  it('buildAgentArgs：保存的 params / provider_params 不再盖掉本次参数', () => {
    const data = { params: { aspect_ratio: '9:16', steps: 20 }, provider_params: { aspect_ratio: '9:16', steps: 20 } };
    const override = { aspect_ratio: '16:9', prompt: 'p' };
    const args = buildAgentArgs({ ...data, ...override }, 'p', ['aspect_ratio', 'steps'], override);
    expect(args).toMatchObject({ aspect_ratio: '16:9', steps: 20, prompt: 'p' });
  });
  it('override.params 整体优先；未声明的键不额外下发', () => {
    const data = { params: { steps: 20 } };
    const override = { params: { steps: 8 }, mode: 'r2v', provider_id: 'x' };
    const args = buildAgentArgs({ ...data, ...override }, 'p', ['steps'], override);
    expect(args.steps).toBe(8);
    expect(args).not.toHaveProperty('mode');
    expect(args).not.toHaveProperty('provider_id');
  });
  it('executeAgentNode 实际下发：节点存 9:16，本次 16:9 → 发 16:9', async () => {
    const writes: Record<string, unknown>[] = [];
    await executeAgentNode({
      node: { id: 'n', type: 'image', data: { prompt: 'x', provider_id: 'p', params: { aspect_ratio: '9:16', steps: 20 } } },
      override: { aspect_ratio: '16:9', prompt: 'x' },
      updateNodeData: (_id, p) => writes.push(p),
    });
    expect(vi.mocked(apiService.callMcpTool).mock.calls[0][1]).toMatchObject({ aspect_ratio: '16:9', steps: 20 });
    const result = writes.find((w) => 'image_url' in w)!;
    // 产物像素比单独存，不改写用户选的比例
    expect(result).toMatchObject({ image_url: '/out.png', result_aspect: '832:1216' });
    expect(result).not.toHaveProperty('aspect_ratio');
  });
  it('custom：override 的参数值优先于保存的 params', async () => {
    await executeAgentNode({
      node: { id: 'c', type: 'custom', data: { custom_node_id: 'cn', prompt: 'x', params: { scale: 2 } } },
      override: { scale: 4, video: '/v.mp4' },
      updateNodeData: () => {},
    });
    expect(vi.mocked(apiService.runCustomNode).mock.calls[0][0]).toMatchObject({ inputs: { video: '/v.mp4' }, params: { scale: 4 } });
  });
});

describe('patchFromPayload', () => {
  it('像素比写 result_aspect，不写 aspect_ratio', () => {
    expect(patchFromPayload('image', { image_url: '/a.png', width: 832, height: 1216 })).toEqual({
      image_url: '/a.png', result_url: '/a.png', width: 832, height: 1216, result_aspect: '832:1216',
    });
  });
});

describe('C5：不需要提示词的节点不拦「提示词为空」', () => {
  it('custom 只连了视频、没填提示词也能跑（prompt 在 input_schema 里不是必填）', async () => {
    vi.mocked(apiService.getCustomNode).mockResolvedValueOnce({
      node: { id: 'upscale_c5', input_schema: { properties: { video: {}, prompt: {} }, required: ['video'] }, params_schema: { properties: {} } },
    });
    vi.mocked(apiService.runCustomNode).mockResolvedValueOnce({ status: 'success', video_url: '/up.mp4', text: 'upscaled x2' });
    const writes: Record<string, unknown>[] = [];
    const payload = await executeAgentNode({
      node: { id: 'c', type: 'custom', data: { custom_node_id: 'upscale_c5' } },
      override: { video: '/v.mp4' },
      updateNodeData: (_id, p) => writes.push(p),
    });
    expect(payload).toMatchObject({ video_url: '/up.mp4' });
    expect(vi.mocked(apiService.runCustomNode).mock.calls.at(-1)![0]).toMatchObject({ custom_node_id: 'upscale_c5', inputs: { video: '/v.mp4' } });
    expect(writes.at(-1)).toMatchObject({ agent_state: { status: 'completed' } });
  });

  it('custom 的必填项由 input_schema.required 决定：缺了就报「缺少必填输入」且不发请求', async () => {
    vi.mocked(apiService.getCustomNode).mockResolvedValueOnce({
      node: { id: 'need_video', input_schema: { properties: { video: { title: '输入视频' }, prompt: {} }, required: ['video'] } },
    });
    const before = vi.mocked(apiService.runCustomNode).mock.calls.length;
    const writes: Record<string, unknown>[] = [];
    await expect(executeAgentNode({
      node: { id: 'c', type: 'custom', data: { custom_node_id: 'need_video', prompt: '有提示词也不够' } },
      updateNodeData: (_id, p) => writes.push(p),
    })).rejects.toThrow('缺少必填输入：输入视频（video）');
    expect(vi.mocked(apiService.runCustomNode).mock.calls.length).toBe(before);
    expect(writes.at(-1)).toMatchObject({ agent_state: { status: 'failed' } });
  });

  it('missingRequiredInputs：params_schema.required 也校验；空数组 / 空串算缺', () => {
    const def = { input_schema: { required: ['images'] }, params_schema: { properties: { scale: { title: '倍数' } }, required: ['scale'] } };
    expect(missingRequiredInputs(def, { images: [] }, {})).toEqual(['images', '倍数（scale）']);
    expect(missingRequiredInputs(def, { images: ['/a.png'] }, { scale: 2 })).toEqual([]);
    expect(missingRequiredInputs(null, {}, {})).toEqual([]);
  });

  it('豁免列表覆盖 custom / ext-node / export / timeline / director3d；媒体生成节点仍要提示词', async () => {
    for (const t of ['custom', 'ext-node', 'export', 'timeline', 'director3d']) expect(PROMPT_OPTIONAL_TYPES.has(t)).toBe(true);
    for (const t of ['image', 'video', 'audio']) expect(PROMPT_OPTIONAL_TYPES.has(t)).toBe(false);
    await expect(executeAgentNode({ node: { id: 'i', type: 'image', data: { provider_id: 'p' } }, updateNodeData: () => {} })).rejects.toThrow('提示词为空');
  });
});

describe('B8：视频节点放行本次 mode（多参考 → r2v）', () => {
  it('buildAgentArgs：video 放行未声明的 mode；界面模式名映射成生成源模式；其他类型照旧不放行', () => {
    expect(buildAgentArgs({}, 'p', ['reference_images'], { mode: 'r2v', reference_images: ['/a.png', '/b.png'] }, { nodeType: 'video' }))
      .toMatchObject({ mode: 'r2v', reference_images: ['/a.png', '/b.png'] });
    expect(buildAgentArgs({}, 'p', [], { mode: 'multiReference' }, { nodeType: 'video' }).mode).toBe('r2v');
    expect(buildAgentArgs({}, 'p', [], { mode: 'startEnd' }, { nodeType: 'video' }).mode).toBe('i2v');
    expect(buildAgentArgs({}, 'p', [], { mode: 'text' }, { nodeType: 'video' }).mode).toBe('t2v');
    expect(buildAgentArgs({}, 'p', [], { mode: 'bogus' }, { nodeType: 'video' })).not.toHaveProperty('mode');
    expect(buildAgentArgs({}, 'p', [], { mode: 'r2v' }, { nodeType: 'image' })).not.toHaveProperty('mode');
    // 节点 data.mode 是界面模式名，不从节点数据补
    expect(buildAgentArgs({ mode: 'multiReference' }, 'p', [], {}, { nodeType: 'video' })).not.toHaveProperty('mode');
  });

  it('executeAgentNode 实际下发：comfyui_video 不声明 mode，多参考也带 mode=r2v', async () => {
    vi.mocked(apiService.getProvider).mockResolvedValueOnce({ provider: { id: 'comfyui_video_b8', input_schema: { properties: { prompt: {}, reference_images: {} } }, params_schema: { properties: { duration: {} } } } });
    vi.mocked(apiService.callMcpTool).mockResolvedValueOnce({ status: 'success', result: { video_url: '/v.mp4' } });
    await executeAgentNode({
      node: { id: 'v', type: 'video', data: { prompt: '雨夜', provider_id: 'comfyui_video_b8', mode: 'multiReference' } },
      override: { prompt: '雨夜', reference_images: ['/a.png', '/b.png'], mode: 'r2v', provider_id: 'comfyui_video_b8', provider: 'comfyui_video_b8' },
      updateNodeData: () => {},
    });
    const [tool, args] = vi.mocked(apiService.callMcpTool).mock.calls.at(-1)!;
    expect(tool).toBe('provider_comfyui_video_b8');
    expect(args).toMatchObject({ mode: 'r2v', reference_images: ['/a.png', '/b.png'], prompt: '雨夜' });
  });
});
