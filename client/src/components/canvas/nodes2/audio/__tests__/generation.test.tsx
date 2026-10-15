// REQ-toonflow-canvas N4：音频生成 → kit/useGeneration（直接生成 / 智能规划），台词读 text 优先、参考音频镜像 ref_audio。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

vi.mock('../../../hooks/nodeAgentExecutor', () => ({
  executeAgentNode: vi.fn(async () => ({ audio_url: '/storage/gen/out.mp3' })),
}));
const COSY = {
  id: 'cosyvoice',
  display_name: 'CosyVoice (本地)',
  input_schema: { properties: { text: { type: 'string', 'x-handle': 'text' }, reference_audio: { type: 'string', format: 'uri', 'x-handle': 'audio', 'x-slot': 'ref_audio' } }, required: ['text'] },
  params_schema: { properties: { voice_id: { type: 'string', 'x-agent': 'auto' }, emotion: { type: 'string', enum: ['neutral', 'happy'], default: 'neutral' }, speed: { type: 'number', default: 1 } } },
};
const MM = {
  id: 'prov_mm',
  display_name: 'MiniMax H3 音频生成',
  input_schema: { properties: { text: { type: 'string', 'x-handle': 'text' } }, required: ['text'] },
  params_schema: { properties: { text: { type: 'string' }, voice_id: { type: 'string', default: 'male-qn-qingse' }, emotion: { type: 'string', enum: ['neutral', 'sad'], default: 'neutral' } } },
};
vi.mock('../../../../../services/api', () => ({
  apiService: {
    listProviders: vi.fn(async () => ({ providers: [{ id: 'cosyvoice', display_name: 'CosyVoice (本地)', builtin: true }, { id: 'prov_mm', name: 'MiniMax H3 音频生成' }] })),
    getProvider: vi.fn(async (id: string) => ({ provider: id === 'cosyvoice' ? COSY : MM })),
    canvasAgentGenerate: vi.fn(async () => ({ status: 'success', plan: { provider_id: 'prov_mm', params: { emotion: 'sad' }, prompt: '润色后的台词' }, result: { audio_url: '/storage/gen/plan.mp3' } })),
    createAsset: vi.fn(),
    getAsset: vi.fn(),
  },
}));

import { setupFlowEnv, Canvas, node } from './helpers';
import '../index';
import { defineNode } from '../../../kit/registry';
import { executeAgentNode } from '../../../hooks/nodeAgentExecutor';
import { apiService } from '../../../../../services/api';
import { audioGenerationInputs, audioPromptValue, legacyRefAudioOf } from '../genInputs';
import type { AssembledInputs } from '../../../kit/assembleInputs';

const C = () => null;
beforeAll(() => {
  setupFlowEnv();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"voices":[],"is_configured":true,"health":true}', { status: 200 })));
  defineNode({ type: 'n4g-text', label: '文本', icon: C, category: 'text', component: C, ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }], inPalette: false });
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

function renderGen(data: Record<string, unknown>, extraNodes: ReturnType<typeof node>[] = [], edges: { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }[] = []) {
  const updateNodeData = vi.fn();
  const r = render(<Canvas host={{ updateNodeData }} nodes={[node('g1', 'audio', data, { selected: true }), ...extraNodes]} edges={edges} />);
  const bottom = () => r.container.querySelector('.react-flow__node[data-id="g1"] .cv-node__slot--bottom') as HTMLElement;
  return { ...r, updateNodeData, bottom };
}

describe('直接生成', () => {
  it('台词 = 自身 text（{{ref N}} 替换为被引用文本本身，音频不加「参考 N：」前缀，R6a）；参考音频走生成源槽位并镜像 ref_audio；结果写 audio_url + history', async () => {
    const { updateNodeData, bottom } = renderGen(
      { label: '配音', text: '{{ref 1}}，你好。', prompt: '旧 prompt', provider_id: 'cosyvoice', params: { voice_id: '中文女', speed: 1.2 } },
      [node('t1', 'n4g-text', { prompt: '旁白：' }), node('a1', 'load-audio', { audio_url: '/storage/ref.wav' })],
      [
        { id: 'e1', source: 't1', sourceHandle: 'prompt', target: 'g1', targetHandle: 'in' },
        { id: 'e2', source: 'a1', sourceHandle: 'audio', target: 'g1', targetHandle: 'in' },
      ],
    );
    await act(async () => {});
    await waitFor(() => expect((within(bottom()).getByLabelText('生成音频') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(within(bottom()).getByLabelText('生成音频')); });
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalledTimes(1));
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.node).toMatchObject({ id: 'g1', type: 'audio' });
    // R6a（与后端 inputs.assemble_audio_text 一致，REQ-toonflow-canvas 协调人决定）：音频只念自身 text，
    // {{ref N}} 替换成被引用的文本内容本身；不追加「参考 N：」段落
    const spoken = '旁白：，你好。';
    expect(call.override).toMatchObject({
      prompt: spoken,
      text: spoken,
      reference_audio: '/storage/ref.wav',
      ref_audio: '/storage/ref.wav',
      voice_id: '中文女',
      speed: 1.2,
      provider_id: 'cosyvoice',
      provider: 'cosyvoice',
    });
    await waitFor(() => expect(updateNodeData).toHaveBeenCalledWith('g1', expect.objectContaining({ audio_url: '/storage/gen/out.mp3' })));
    const last = updateNodeData.mock.calls.map((c) => c[1]).find((p) => p.history);
    expect(last.history[0]).toMatchObject({ url: '/storage/gen/out.mp3', provider_id: 'cosyvoice', prompt: spoken });
  });

  it('自身台词为空时第一条文本参考作主体（不念「参考 1：」）；没选语音源且没开智能规划时不能发送', async () => {
    const { bottom } = renderGen(
      { text: '' },
      [node('t1', 'n4g-text', { prompt: '欢迎来到无限画布。' })],
      [{ id: 'e1', source: 't1', sourceHandle: 'prompt', target: 'g1', targetHandle: 'in' }],
    );
    await act(async () => {});
    const send = within(bottom()).getByLabelText('请先选择语音源，或打开「智能规划」') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(executeAgentNode).not.toHaveBeenCalled();
  });

  it('生成源不支持参考音频（MiniMax H3 只声明 text）：提示未使用，不下发参考音频', async () => {
    const { bottom } = renderGen(
      { text: '台词', provider_id: 'prov_mm', params: { voice_id: 'female-shaonv' } },
      [node('a1', 'load-audio', { audio_url: '/storage/ref.wav' })],
      [{ id: 'e2', source: 'a1', sourceHandle: 'audio', target: 'g1', targetHandle: 'in' }],
    );
    await act(async () => {});
    expect(await within(bottom()).findByText(/生成源不支持参考音频/)).toBeTruthy();
    await act(async () => { fireEvent.click(within(bottom()).getByLabelText('生成音频')); });
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalledTimes(1));
    const o = (executeAgentNode as any).mock.calls[0][0].override;
    expect(o.text).toBe('台词');
    expect(o.ref_audio).toBeUndefined();
    expect(o.voice_id).toBe('female-shaonv');
  });
});

describe('FX-2：直接生成下发弹层显示的参数', () => {
  it('params 为空：情绪按弹层显示的缺省 neutral 下发；音色没选不补（弹层显示「默认音色」）', async () => {
    const { bottom } = renderGen({ text: '台词', provider_id: 'prov_mm' });
    await act(async () => {});
    await waitFor(() => expect(within(bottom()).getByLabelText('生成参数').textContent).toContain('neutral'));
    await act(async () => { fireEvent.click(within(bottom()).getByLabelText('生成音频')); });
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalledTimes(1));
    const o = (executeAgentNode as any).mock.calls[0][0].override;
    expect(o.emotion).toBe('neutral');
    expect(o.voice_id).toBeUndefined();
    expect(o.text).toBe('台词');
  });
});

describe('智能规划', () => {
  it('打开开关后走 /canvas/agent/generate（不选源也能发），intent = 组装后的台词，结果与规划写回', async () => {
    const { updateNodeData, bottom } = renderGen({ text: '晚安', smart_plan: true });
    await act(async () => {});
    expect(within(bottom()).getByLabelText('生成源').textContent).toContain('Agent 自动选源');
    await act(async () => { fireEvent.click(within(bottom()).getByLabelText('生成音频')); });
    await waitFor(() => expect(apiService.canvasAgentGenerate).toHaveBeenCalledTimes(1));
    expect((apiService.canvasAgentGenerate as any).mock.calls[0][0]).toMatchObject({ node_type: 'audio', idea: '晚安', node_id: 'g1' });
    expect(executeAgentNode).not.toHaveBeenCalled();
    await waitFor(() => expect(updateNodeData).toHaveBeenCalledWith('g1', expect.objectContaining({ audio_url: '/storage/gen/plan.mp3', provider_id: 'prov_mm' })));
  });
});

describe('纯函数', () => {
  it('audioPromptValue / legacyRefAudioOf / audioGenerationInputs', () => {
    expect(audioPromptValue({ text: '  ', prompt: 'p' })).toBe('p');
    expect(audioPromptValue({ text: 't', prompt: 'p' })).toBe('t');
    expect(audioPromptValue({})).toBe('');
    expect(legacyRefAudioOf({ ref_audio: ' /storage/r.wav ' })).toBe('/storage/r.wav');
    expect(legacyRefAudioOf({ reference_audios: ['', '/storage/x.wav'] })).toBe('/storage/x.wav');
    expect(legacyRefAudioOf({})).toBe('');
    const a = { prompt: 'hi', args: { prompt: 'hi', reference_audio: '/r.wav' }, ref_audio: ['/r.wav'] } as unknown as AssembledInputs;
    expect(audioGenerationInputs(a).args).toEqual({ prompt: 'hi', text: 'hi', reference_audio: '/r.wav', ref_audio: '/r.wav' });
  });
});
