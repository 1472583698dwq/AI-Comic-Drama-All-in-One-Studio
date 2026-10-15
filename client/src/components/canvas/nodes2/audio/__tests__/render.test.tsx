// REQ-toonflow-canvas N4：音频 / 音频生成节点渲染冒烟（真实 <ReactFlow> + NodeSkeleton）。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../../../../services/api', () => ({
  apiService: {
    listProviders: vi.fn(async () => ({
      providers: [
        { id: 'cosyvoice', display_name: 'CosyVoice (本地)', kind: 'audio', builtin: true },
        { id: 'prov_mm', name: 'MiniMax H3 音频生成', kind: 'audio', builtin: false },
      ],
    })),
    getProvider: vi.fn(async (id: string) => ({
      provider: {
        id,
        display_name: id,
        input_schema: { properties: { text: { type: 'string', 'x-handle': 'text' }, reference_audio: { type: 'string', format: 'uri', 'x-handle': 'audio', 'x-slot': 'ref_audio' } } },
        params_schema: {
          properties: {
            voice_id: { type: 'string', title: '音色', 'x-agent': 'auto', 'x-visibility': 'basic' },
            emotion: { type: 'string', title: '情绪', enum: ['neutral', 'happy'], default: 'neutral', 'x-agent': 'auto', 'x-visibility': 'basic' },
            speed: { type: 'number', title: '语速', default: 1, minimum: 0.5, maximum: 2, 'x-agent': 'auto', 'x-visibility': 'basic' },
          },
        },
      },
    })),
    createAsset: vi.fn(),
    getAsset: vi.fn(),
    canvasAgentGenerate: vi.fn(),
  },
}));

import { setupFlowEnv, Canvas, node } from './helpers';
import '../index';
import { getNodeDef } from '../../../kit/registry';
import { cardMinHeight } from '../../../kit/NodeHandles';
import { AUDIO_GEN_PORTS, LOAD_AUDIO_PORTS } from '../index';

beforeAll(() => {
  setupFlowEnv();
  // 音色接口（/tts/voices/{id}）
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ voices: [{ id: '中文女', name: '中文女 (默认)' }], is_configured: true, health: false }), { status: 200 })));
});
afterEach(() => { cleanup(); });

describe('注册', () => {
  it('load-audio / audio 用旧类型 id、Toonflow 端口与宽度', () => {
    const load = getNodeDef('load-audio')!;
    expect(load.label).toBe('音频');
    expect(load.width).toBe(360);
    expect(load.ports).toEqual(LOAD_AUDIO_PORTS);
    const gen = getNodeDef('audio')!;
    expect(gen.label).toBe('音频生成');
    expect(gen.ports.map((p) => `${p.type}:${p.id}`)).toEqual(['target:in', 'source:audio']);
    expect(gen.ports[0].dataType).toEqual(['IMAGE', 'AUDIO', 'STRING']);
    expect(typeof gen.canConnect).toBe('function');
    expect(gen.defaultData?.()).toMatchObject({ text: '', prompt: '', language: 'zh-CN', sampleRate: 24000, format: 'wav', refOrder: [], refRoles: {} });
    expect(cardMinHeight(AUDIO_GEN_PORTS)).toBe(100);
  });
});

describe('load-audio 音频节点', () => {
  it('空态：标题在卡片外、大号上传按钮、只有 audio 输出口', async () => {
    const { container } = render(<Canvas nodes={[node('a1', 'load-audio', {})]} />);
    await act(async () => {});
    const el = container.querySelector('.react-flow__node[data-id="a1"] .cv-node') as HTMLElement;
    expect(el.style.width).toBe('360px');
    expect(el.querySelector(':scope > .cv-node__title')?.textContent).toContain('音频');
    expect(within(el).getByLabelText('上传音频')).toBeTruthy();
    expect(Array.from(el.querySelectorAll('.react-flow__handle')).map((h) => h.getAttribute('data-handleid'))).toEqual(['audio']);
    expect(el.querySelector('audio')).toBeNull();
  });

  it('有音频：波形播放器（jsdom 无 WebAudio → 提示无法显示波形）、选中时工具栏截取 / 变速 / 替换 / 下载', async () => {
    const host = { saveToAssets: vi.fn() };
    const { container } = render(
      <Canvas host={host} nodes={[node('a1', 'load-audio', { label: '旁白', audio_url: '/storage/a.wav', audio: '/storage/a.wav', url: '/storage/a.wav' }, { selected: true })]} />,
    );
    await act(async () => {});
    const el = container.querySelector('.react-flow__node[data-id="a1"] .cv-node') as HTMLElement;
    const audio = el.querySelector('audio') as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe('/storage/a.wav');
    expect(within(el).getByText('当前音频无法显示波形')).toBeTruthy();
    fireEvent.loadedMetadata(audio);
    expect(within(el).getByText('0:10')).toBeTruthy();
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    for (const name of ['截取音频', '音频变速', '替换音频', '添加到素材库']) expect(within(top).getByLabelText(name)).toBeTruthy();
    expect(within(top).getByLabelText('下载').getAttribute('href')).toBe('/storage/a.wav');
    expect(within(top).queryByLabelText('全屏')).toBeNull();
    fireEvent.click(within(top).getByLabelText('添加到素材库'));
    expect(host.saveToAssets).toHaveBeenCalledWith('a1');
    // 未打开变速时下方没有面板
    expect(el.querySelector('.cv-node__slot--bottom')).toBeNull();
  });
});

describe('audio 音频生成节点', () => {
  it('选中：提示词面板（660）+ 语音源下拉 + 发送；没台词时发送置灰；播放器 / 空态', async () => {
    const { container } = render(<Canvas nodes={[node('g1', 'audio', { label: '配音', text: '' }, { selected: true })]} />);
    await act(async () => {});
    const el = container.querySelector('.react-flow__node[data-id="g1"] .cv-node') as HTMLElement;
    expect(el.style.width).toBe('360px');
    expect(within(el).getByLabelText('暂无生成音频')).toBeTruthy();
    const bottom = el.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(bottom.style.width).toBe('660px');
    expect(within(bottom).getByLabelText('生成源').textContent).toContain('选择语音源');
    const send = within(bottom).getByLabelText('请输入要朗读的台词') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(within(bottom).getByRole('switch').textContent).toContain('智能规划');
    // 工具栏：没有结果时截取 / 变速置灰
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    expect((within(top).getByLabelText('截取音频') as HTMLButtonElement).disabled).toBe(true);
    expect((within(top).getByLabelText('音频变速') as HTMLButtonElement).disabled).toBe(true);
  });

  it('选了语音源：参数弹层有音色（含 Agent 徽标）、情绪、语速，语种 / 采样率 / 格式未声明时只存节点数据', async () => {
    const { container } = render(
      <Canvas nodes={[node('g1', 'audio', { text: '你好', provider_id: 'cosyvoice', params: { emotion: 'happy' }, audio_url: '/storage/x.mp3' }, { selected: true })]} />,
    );
    await act(async () => {});
    const el = container.querySelector('.react-flow__node[data-id="g1"] .cv-node') as HTMLElement;
    const bottom = el.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect((within(bottom).getByLabelText('生成音频') as HTMLButtonElement).disabled).toBe(false);
    // 健康检查未通过的提示
    expect(within(bottom).getByText(/服务未就绪/)).toBeTruthy();
    fireEvent.click(within(bottom).getByLabelText('生成参数'));
    const pop = await screen.findByRole('dialog', { name: '生成参数' });
    const voice = within(pop).getByRole('region', { name: '音色与情绪' });
    const voiceSelect = within(voice).getByLabelText('音色') as HTMLSelectElement;
    expect(within(voice).getAllByText('Agent可填').length).toBe(2); // 音色 + 情绪（x-agent: auto）
    // 情绪用 DynamicControl：枚举 + 当前值
    expect(within(voice).getByDisplayValue('happy')).toBeTruthy();
    const params = within(pop).getByRole('region', { name: '生成参数' });
    expect(within(params).getByText(/语速/)).toBeTruthy();
    expect(within(pop).getByText(/当前语音源未声明语种 \/ 采样率 \/ 输出格式参数/)).toBeTruthy();
    expect(within(pop).queryByRole('radiogroup')).toBeNull();
    // 音色列表来自 /tts/voices/{id}
    await act(async () => {});
    expect(Array.from(voiceSelect.options).map((o) => o.textContent)).toContain('中文女 (默认)');
  });
});
