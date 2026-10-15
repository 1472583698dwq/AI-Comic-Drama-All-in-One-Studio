// REQ-toonflow-canvas runGeneration：直接生成 / 智能规划 / 取消 / 历史
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../hooks/nodeAgentExecutor', () => ({
  executeAgentNode: vi.fn(),
}));
vi.mock('../../../../services/api', () => ({
  apiService: { canvasAgentGenerate: vi.fn() },
}));
vi.mock('../../../../utils/videoTask', () => ({
  pollVideoTask: vi.fn(async () => '/storage/v/polled.mp4'),
}));

import { runGeneration, appendHistory } from '../useGeneration';
import { executeAgentNode } from '../../hooks/nodeAgentExecutor';
import { apiService } from '../../../../services/api';
import type { AssembledInputs } from '../assembleInputs';

const assembled = (over: Partial<AssembledInputs> = {}): AssembledInputs => ({
  canonical: {},
  prompt: '一只猫',
  reference_images: ['/storage/a.png'],
  ref_audio: [],
  reference_video: [],
  mode: '',
  args: { prompt: '一只猫', reference_images: ['/storage/a.png'] },
  assignments: {},
  hasTextRefs: false,
  warnings: [],
  ...over,
});

describe('runGeneration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('直接生成：入参合并 args+params，结果写 url 与 history', async () => {
    (executeAgentNode as any).mockResolvedValue({ image_url: '/storage/out.png' });
    const update = vi.fn();
    const r = await runGeneration({
      nodeId: 'n1', nodeType: 'image', kind: 'image', data: { history: [] },
      assembled: assembled(), providerId: 'p1', params: { aspect_ratio: '9:16', empty: '' },
      updateNodeData: update,
    });
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.override).toMatchObject({ prompt: '一只猫', reference_images: ['/storage/a.png'], aspect_ratio: '9:16', provider_id: 'p1' });
    expect(call.override.empty).toBeUndefined();
    expect(r.url).toBe('/storage/out.png');
    const last = update.mock.calls.at(-1)![1];
    expect(last.image_url).toBe('/storage/out.png');
    expect(last.history[0]).toMatchObject({ url: '/storage/out.png', provider_id: 'p1' });
  });

  it('视频直接生成下发 providerMode', async () => {
    (executeAgentNode as any).mockResolvedValue({ video_url: '/storage/v.mp4' });
    await runGeneration({
      nodeId: 'v', nodeType: 'video', kind: 'video', data: {},
      assembled: assembled({ providerMode: 'i2v', mode: 'singleImage' }), providerId: 'pv',
      updateNodeData: vi.fn(),
    });
    expect((executeAgentNode as any).mock.calls[0][0].override.mode).toBe('i2v');
  });

  it('智能规划：调用 canvasAgentGenerate，视频 task 轮询，计划写回', async () => {
    (apiService.canvasAgentGenerate as any).mockResolvedValue({
      status: 'success', plan: { provider_id: 'pp', params: { duration: 5 }, prompt: '润色后' }, result: { task_id: 't1' },
    });
    const update = vi.fn();
    const r = await runGeneration({
      nodeId: 'v', nodeType: 'video', kind: 'video', data: {},
      assembled: assembled({ args: { prompt: 'x', first_frame: '/storage/f.png' } }), smartPlan: true, intent: '猫跑',
      updateNodeData: update,
    });
    const payload = (apiService.canvasAgentGenerate as any).mock.calls[0][0];
    expect(payload).toMatchObject({ node_type: 'video', idea: '猫跑', slots: { first_frame: '/storage/f.png' } });
    expect(payload.slots.prompt).toBeUndefined();
    expect(r.url).toBe('/storage/v/polled.mp4');
    const last = update.mock.calls.at(-1)![1];
    expect(last).toMatchObject({ provider_id: 'pp', video_url: '/storage/v/polled.mp4' });
    expect(last.agent_state.status).toBe('completed');
  });

  it('取消后丢弃结果、不写回', async () => {
    (executeAgentNode as any).mockResolvedValue({ image_url: '/storage/late.png' });
    const update = vi.fn();
    const r = await runGeneration({
      nodeId: 'n', nodeType: 'image', kind: 'image', data: {}, assembled: assembled(),
      updateNodeData: update, isCurrent: () => false,
    });
    expect(r.patch).toEqual({});
    expect(update).not.toHaveBeenCalled();
  });

  it('appendHistory 去重、新的在前、限长', () => {
    const h = appendHistory([{ url: 'a', created_at: '1' }, { url: 'b', created_at: '2' }], { url: 'b', created_at: '3' }, 2);
    expect(h.map((x) => x.url)).toEqual(['b', 'a']);
  });
});
