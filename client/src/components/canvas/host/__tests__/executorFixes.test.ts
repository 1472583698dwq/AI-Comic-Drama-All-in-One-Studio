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
import { buildAgentArgs, executeAgentNode, patchFromPayload } from '../../hooks/nodeAgentExecutor';

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
