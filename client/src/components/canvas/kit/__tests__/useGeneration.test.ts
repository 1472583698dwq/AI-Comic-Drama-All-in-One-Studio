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

import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { runGeneration, appendHistory, stripStaleSlotKeys, STALE_SLOT_KEYS, useNodeGeneration } from '../useGeneration';
import { CanvasHostProvider } from '../hostContext';
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

// REQ-toonflow-canvas K1：迁移后的旧节点 data 顶层残留槽位键不能被执行器（buildAgentArgs）悄悄下发
describe('stripStaleSlotKeys', () => {
  const legacy = {
    prompt: '新提示词 {{ref 1}}', text: '旧传播文本', provider_id: 'p1', provider: 'p1', model: 'm', params: { duration: 5 }, provider_params: { duration: 5 },
    aspect_ratio: '9:16', history: [{ url: '/h.png', created_at: '' }], skill_id: 'k', refOrder: ['a|image'], label: '视频',
    first_frame: '/old/f.png', last_frame: '/old/l.png', reference_images: ['/old/r.png'], reference: '/old/r2.png', images: ['/old/i.png'],
    videos: ['/old/v.mp4'], reference_video: ['/old/rv.mp4'], ref_audio: '/old/a.wav', reference_audios: ['/old/a.wav'], camera_prompt: '旧机位',
    image: '/old/img.png', video: '/old/vid.mp4', audio: '/old/aud.mp3', url: '/old/u.png', img_5: '/old/c.png', start_image: '/old/s.png',
  };

  it('图片 / 视频：去掉旧槽位键、旧传播键、img_N 与 text；保留提示词 / 生成源 / 参数 / 历史等，不改原对象', () => {
    const out = stripStaleSlotKeys(legacy, 'video');
    for (const k of [...STALE_SLOT_KEYS, 'text', 'img_5']) expect(out).not.toHaveProperty(k);
    expect(out).toMatchObject({
      prompt: '新提示词 {{ref 1}}', provider_id: 'p1', provider: 'p1', model: 'm', params: { duration: 5 }, provider_params: { duration: 5 },
      aspect_ratio: '9:16', skill_id: 'k', label: '视频', start_image: '/old/s.png',
    });
    expect(out.history).toBe(legacy.history);
    expect(legacy).toHaveProperty('first_frame');
    expect(stripStaleSlotKeys(legacy, 'image')).not.toHaveProperty('text');
  });

  it('音频保留 text（台词）；extraKeys 去掉生成源声明的输入键；keep 优先', () => {
    const audio = stripStaleSlotKeys(legacy, 'audio', { extraKeys: ['start_image'], keep: ['ref_audio'] });
    expect(audio.text).toBe('旧传播文本');
    expect(audio).not.toHaveProperty('start_image');
    expect(audio.ref_audio).toBe('/old/a.wav');
    expect(audio).not.toHaveProperty('reference_audios');
    expect(stripStaleSlotKeys(null, 'image')).toEqual({});
  });

  it('runGeneration 直接生成：交给执行器的是去掉旧键后的 data，槽位只来自本次组装', async () => {
    (executeAgentNode as any).mockResolvedValue({ video_url: '/storage/v.mp4' });
    await runGeneration({
      nodeId: 'v', nodeType: 'video', kind: 'video', data: legacy,
      assembled: assembled({ args: { prompt: '一只猫', reference_images: ['/storage/a.png'] } }), providerId: 'p1',
      inputKeys: ['start_image'], updateNodeData: vi.fn(),
    });
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.node.data).not.toHaveProperty('first_frame');
    expect(call.node.data).not.toHaveProperty('text');
    expect(call.node.data).not.toHaveProperty('start_image');
    expect(call.node.data.params).toEqual({ duration: 5 });
    expect(call.override.reference_images).toEqual(['/storage/a.png']);
  });

  it('runGeneration 音频：没有连参考音频时保留旧画布遗留的参考音频键（N4 面板可见可清除），连了就去掉', async () => {
    (executeAgentNode as any).mockResolvedValue({ audio_url: '/storage/a.mp3' });
    const data = { text: '台词', ref_audio: '/old/a.wav', first_frame: '/old/f.png' };
    await runGeneration({ nodeId: 'a', nodeType: 'audio', kind: 'audio', data, assembled: assembled({ reference_images: [], args: { prompt: '台词' } }), providerId: 'p', updateNodeData: vi.fn() });
    expect((executeAgentNode as any).mock.calls[0][0].node.data).toEqual({ text: '台词', ref_audio: '/old/a.wav' });
    await runGeneration({
      nodeId: 'a', nodeType: 'audio', kind: 'audio', data,
      assembled: assembled({ canonical: { ref_audio: ['/s/new.wav'] }, ref_audio: ['/s/new.wav'], args: { prompt: '台词', ref_audio: '/s/new.wav' } }),
      providerId: 'p', updateNodeData: vi.fn(),
    });
    const second = (executeAgentNode as any).mock.calls[1][0];
    expect(second.node.data).toEqual({ text: '台词' });
    expect(second.override.ref_audio).toBe('/s/new.wav');
  });
});

describe('useNodeGeneration（K1）', () => {
  it('回写走 useKitNodeActions(nodeId).update → 宿主 updateNodeData(nodeId, patch)，不用自己包 (id, patch)', async () => {
    (executeAgentNode as any).mockResolvedValue({ image_url: '/storage/out.png' });
    const updateNodeData = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ReactFlowProvider, null, createElement(CanvasHostProvider, { value: { updateNodeData }, children }));
    const { result } = renderHook(() => useNodeGeneration('n9'), { wrapper });
    await act(async () => {
      await result.current.run({ nodeType: 'image', kind: 'image', data: {}, assembled: assembled(), providerId: 'p1' });
    });
    expect(updateNodeData).toHaveBeenCalledWith('n9', expect.objectContaining({ image_url: '/storage/out.png' }));
    expect(result.current.running).toBe(false);
    act(() => result.current.cancel());
    expect(updateNodeData).toHaveBeenLastCalledWith('n9', expect.objectContaining({ agent_state: expect.objectContaining({ status: 'idle' }), _polling: false }));
  });
});
