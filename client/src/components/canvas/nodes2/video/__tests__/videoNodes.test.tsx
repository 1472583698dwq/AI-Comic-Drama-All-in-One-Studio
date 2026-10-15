// REQ-toonflow-canvas N3：视频 / 视频生成节点渲染冒烟、模式显示映射、截帧 / 分离 / 截取 → createNodes、生成与重启恢复
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';

vi.mock('../../../../../services/mediaOps', () => ({
  extractFrame: vi.fn(),
  extractAudio: vi.fn(),
  splitAv: vi.fn(),
  trimMedia: vi.fn(),
}));
vi.mock('../../../../../services/api', () => ({
  apiService: {
    listProviders: vi.fn(async () => ({ providers: [
      { id: 'pv_full', name: '全能视频源', builtin: true, description: '首尾帧 + 参考图' },
      { id: 'pv_t2v', name: '文生视频源', provider_type: 'code' },
    ] })),
    getProvider: vi.fn(async (id: string) => ({ provider: PROVIDERS[id] })),
    canvasAgentGenerate: vi.fn(),
    createAsset: vi.fn(),
    uploadAgentAttachment: vi.fn(),
  },
}));
vi.mock('../../../hooks/nodeAgentExecutor', () => ({ executeAgentNode: vi.fn() }));
vi.mock('../../../../../utils/videoTask', () => ({ pollVideoTask: vi.fn() }));

import { extractAudio, extractFrame, splitAv, trimMedia } from '../../../../../services/mediaOps';
import { executeAgentNode } from '../../../hooks/nodeAgentExecutor';
import { pollVideoTask } from '../../../../../utils/videoTask';
import { defineNode } from '../../../kit/registry';
import { NodeSkeleton } from '../../../kit/NodeSkeleton';
import type { CanvasHost } from '../../../kit/hostContext';
import { Canvas, installFlowEnv, setMediaMeta } from './flowEnv';
import '../index';

const PROVIDERS: Record<string, unknown> = {
  pv_full: {
    id: 'pv_full',
    input_schema: { properties: {
      prompt: { type: 'string' },
      first_frame: { type: 'string', format: 'uri', 'x-handle': 'image', 'x-slot': 'first_frame' },
      last_frame: { type: 'string', format: 'uri', 'x-handle': 'image', 'x-slot': 'last_frame' },
      reference_images: { type: 'array', items: { type: 'string', format: 'uri' }, 'x-handle': 'image', 'x-slot': 'reference_images', maxItems: 9 },
    } },
    params_schema: { properties: {
      aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'], default: '9:16', 'x-agent': 'auto' },
      duration: { type: 'integer', default: 5, minimum: 3, maximum: 10, 'x-agent': 'auto' },
      seed: { type: 'integer', title: '随机种子', 'x-agent': 'manual', 'x-visibility': 'advanced' },
    } },
  },
  pv_t2v: { id: 'pv_t2v', input_schema: { properties: { prompt: { type: 'string' } } }, params_schema: { properties: { duration: { type: 'integer', default: 5, minimum: 3, maximum: 10 } } } },
};

// 演示上游：图片 / 文本（输出口 id 同真实节点：image / prompt）
function DemoImage(props: NodeProps) { return <NodeSkeleton node={props}>图</NodeSkeleton>; }
function DemoText(props: NodeProps) { return <NodeSkeleton node={props}>文</NodeSkeleton>; }
defineNode({ type: 'n3t-image', label: '图片', icon: () => null, category: 'image', ports: [{ id: 'image', type: 'source', dataType: 'IMAGE' }], component: DemoImage, inPalette: false });
defineNode({ type: 'n3t-text', label: '文本', icon: () => null, category: 'text', ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }], component: DemoText, inPalette: false });

const VIDEO = '/storage/assets/ast_1/original.mp4';

beforeAll(installFlowEnv);
beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"] .cv-node`) as HTMLElement;
}
function topBar(container: HTMLElement, id: string): HTMLElement {
  return nodeEl(container, id).querySelector('.cv-node__slot--top') as HTMLElement;
}

describe('load-video 视频节点', () => {
  it('空节点：上传按钮；有视频：自定义播放器、宽度随视频比例（高 240）', async () => {
    const { container } = render(<Canvas nodes={[
      { id: 'a', type: 'load-video', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', type: 'load-video', position: { x: 400, y: 0 }, data: { video_url: VIDEO } },
    ]} />);
    await act(async () => {});
    const a = nodeEl(container, 'a');
    expect(within(a).getByLabelText('上传视频')).toBeTruthy();
    expect(a.querySelector('.cv-handle[data-handleid="video"]')).toBeTruthy();
    expect(a.querySelectorAll('.cv-handle').length).toBe(1); // 只有输出口
    const b = nodeEl(container, 'b');
    const video = b.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe(VIDEO);
    setMediaMeta(video, { duration: 4, videoWidth: 1280, videoHeight: 720 });
    fireEvent.loadedMetadata(video);
    await act(async () => {});
    expect(b.style.width).toBe(`${(240 * 1280) / 720 + 18}px`);
  });

  it('工具栏：截取首帧 → extractFrame → createNodes 一个图片节点（不连线、不改选中）', async () => {
    (extractFrame as any).mockResolvedValue({ status: 'success', url: '/storage/generated/media_ops/f.png', kind: 'image', width: 1280, height: 720, at: 'first', time: 0 });
    const host: CanvasHost = { createNodes: vi.fn(() => ['n1']) };
    const { container } = render(<Canvas host={host} nodes={[{ id: 'v', type: 'load-video', position: { x: 0, y: 0 }, selected: true, data: { label: '素材视频', video_url: VIDEO } }]} />);
    await act(async () => {});
    fireEvent.click(within(topBar(container, 'v')).getByLabelText('截取视频帧'));
    fireEvent.click(await screen.findByText('截取首帧'));
    await waitFor(() => expect(host.createNodes).toHaveBeenCalled());
    expect(extractFrame).toHaveBeenCalledWith(VIDEO, 'first');
    const [specs, opts] = (host.createNodes as any).mock.calls[0];
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'load-image', data: { label: '素材视频 · 首帧', image_url: '/storage/generated/media_ops/f.png' } });
    expect(specs[0].position).toBeTruthy(); // 顶层节点：Toonflow 式右侧摆放
    expect(opts).toMatchObject({ select: false, anchorId: 'v' });
    expect(opts.connectFrom).toBeUndefined();
  });

  it('截取当前帧用播放头时间', async () => {
    (extractFrame as any).mockResolvedValue({ status: 'success', url: '/f.png', kind: 'image', width: 2, height: 2, at: 'time', time: 1.25 });
    const host: CanvasHost = { createNodes: vi.fn(() => []) };
    const { container } = render(<Canvas host={host} nodes={[{ id: 'v', type: 'load-video', position: { x: 0, y: 0 }, selected: true, data: { video_url: VIDEO } }]} />);
    await act(async () => {});
    setMediaMeta(nodeEl(container, 'v').querySelector('video')!, { currentTime: 1.25 });
    fireEvent.click(within(topBar(container, 'v')).getByLabelText('截取视频帧'));
    fireEvent.click(await screen.findByText('截取当前帧'));
    await waitFor(() => expect(host.createNodes).toHaveBeenCalled());
    expect(extractFrame).toHaveBeenCalledWith(VIDEO, 'time', 1.25);
    expect((host.createNodes as any).mock.calls[0][0][0].data.label).toBe('视频 · 当前帧');
  });

  it('提取音轨 → 一个音频节点；分离音视频 → 静音视频 + 音频两个节点', async () => {
    (extractAudio as any).mockResolvedValue({ status: 'success', url: '/a.m4a', kind: 'audio', duration: 2, size_bytes: 1 });
    (splitAv as any).mockResolvedValue({
      status: 'success', video_url: '/s.mp4', audio_url: '/s.m4a',
      video: { url: '/s.mp4', kind: 'video', duration: 2, width: 4, height: 3, has_audio: false, size_bytes: 1 },
      audio: { url: '/s.m4a', kind: 'audio', duration: 2, size_bytes: 1 },
    });
    const host: CanvasHost = { createNodes: vi.fn(() => []) };
    const { container } = render(<Canvas host={host} nodes={[{ id: 'v', type: 'load-video', position: { x: 0, y: 0 }, selected: true, data: { label: 'V', video_url: VIDEO } }]} />);
    await act(async () => {});
    fireEvent.click(within(topBar(container, 'v')).getByText('提取音轨'));
    await waitFor(() => expect(host.createNodes).toHaveBeenCalledTimes(1));
    expect((host.createNodes as any).mock.calls[0][0]).toEqual([
      expect.objectContaining({ type: 'load-audio', data: expect.objectContaining({ label: 'V · 音轨', audio_url: '/a.m4a' }) }),
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(topBar(container, 'v')).getByText('分离音视频'));
    await waitFor(() => expect(host.createNodes).toHaveBeenCalledTimes(2));
    const specs = (host.createNodes as any).mock.calls[1][0];
    expect(specs.map((s: any) => [s.type, s.data.label])).toEqual([['load-video', 'V · 静音视频'], ['load-audio', 'V · 音轨']]);
    expect(specs[0].data.video_url).toBe('/s.mp4');
  });

  it('截取片段：弹窗选 1–3 秒 → trimMedia → 新视频节点', async () => {
    (trimMedia as any).mockResolvedValue({ status: 'success', url: '/t.mp4', kind: 'video', duration: 2, width: 4, height: 3, has_audio: true, size_bytes: 1, start: 1, end: 3 });
    const host: CanvasHost = { createNodes: vi.fn(() => []) };
    const { container } = render(<Canvas host={host} nodes={[{ id: 'v', type: 'load-video', position: { x: 0, y: 0 }, selected: true, data: { label: 'V', video_url: VIDEO } }]} />);
    await act(async () => {});
    fireEvent.click(within(topBar(container, 'v')).getByText('截取片段'));
    const dialog = await screen.findByRole('dialog');
    const preview = within(dialog).getByLabelText('截取片段预览') as HTMLVideoElement;
    setMediaMeta(preview, { duration: 5, currentTime: 0 });
    fireEvent.loadedMetadata(preview);
    const startInput = within(dialog).getByLabelText('片段开始时间') as HTMLInputElement;
    const endInput = within(dialog).getByLabelText('片段结束时间') as HTMLInputElement;
    expect(endInput.value).toBe('5');
    fireEvent.change(startInput, { target: { value: '1' } });
    fireEvent.change(endInput, { target: { value: '3' } });
    expect(within(dialog).getByText('时长 2.00 秒')).toBeTruthy();
    // 键盘微调结束边界：→ +0.1s，再 ← 回到 3
    const endHandle = within(dialog).getByRole('slider', { name: '片段结束边界' });
    fireEvent.keyDown(endHandle, { key: 'ArrowRight' });
    expect(endHandle.getAttribute('aria-valuenow')).toBe('3.1');
    fireEvent.keyDown(endHandle, { key: 'ArrowLeft' });
    fireEvent.click(within(dialog).getByRole('button', { name: '截取片段' }));
    await waitFor(() => expect(host.createNodes).toHaveBeenCalled());
    expect(trimMedia).toHaveBeenCalledWith(VIDEO, 1, 3);
    expect((host.createNodes as any).mock.calls[0][0][0]).toMatchObject({ type: 'load-video', data: { label: 'V · 1.00–3.00 秒', video_url: '/t.mp4' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('从素材库拖入视频 → 写 video_url / video / url（并拦截冒泡）；拖入图片被拒', async () => {
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const { container } = render(<Canvas host={host} nodes={[{ id: 'v', type: 'load-video', position: { x: 0, y: 0 }, data: {} }]} />);
    await act(async () => {});
    const zone = nodeEl(container, 'v').querySelector('.cv-video-content') as HTMLElement;
    const dt = (m: Record<string, string>) => ({ types: Object.keys(m), files: [], getData: (t: string) => m[t] ?? '', dropEffect: '' });
    fireEvent.drop(zone, { dataTransfer: dt({ 'text/plain': 'http://127.0.0.1:8000/storage/assets/ast_7/original.mp4', 'application/canvas-assetid': 'ast_7' }) });
    expect(host.updateNodeData).toHaveBeenCalledWith('v', expect.objectContaining({
      video_url: '/storage/assets/ast_7/original.mp4', video: '/storage/assets/ast_7/original.mp4', url: '/storage/assets/ast_7/original.mp4', asset_id: 'ast_7',
    }));
    (host.updateNodeData as any).mockClear();
    fireEvent.drop(zone, { dataTransfer: dt({ 'text/plain': '/storage/assets/ast_8/original.png', 'application/canvas-assetid': 'ast_8' }) });
    expect(host.updateNodeData).not.toHaveBeenCalled();
    // 文本素材拖拽不拦截（交给宿主新建文本节点）
    const passed = fireEvent.drop(zone, { dataTransfer: dt({ 'application/canvas-text': '一段台词', 'text/plain': '一段台词' }) });
    expect(passed).toBe(true);
    expect(host.updateNodeData).not.toHaveBeenCalled();
  });
});

describe('video 视频生成节点', () => {
  const upstream = (extra: Node[] = []): Node[] => [
    { id: 'i1', type: 'n3t-image', position: { x: 0, y: 0 }, data: { image_url: '/storage/a.png' } },
    { id: 'i2', type: 'n3t-image', position: { x: 0, y: 200 }, data: { image_url: '/storage/b.png' } },
    { id: 't1', type: 'n3t-text', position: { x: 0, y: 400 }, data: { prompt: '雨夜街道' } },
    ...extra,
  ];
  const edges = (keys: string[]): Edge[] => keys.map((k) => ({
    id: `e_${k}`, source: k, sourceHandle: k.startsWith('t') ? 'prompt' : 'image', target: 'g', targetHandle: 'in',
  }));
  const genNode = (data: Record<string, unknown>, selected = true): Node => ({ id: 'g', type: 'video', position: { x: 500, y: 0 }, selected, data });

  it('渲染：端口 in + video；空态图标；选中出面板（参考列表、生成源下拉、参数、智能规划、发送）', async () => {
    const { container } = render(<Canvas nodes={upstream([genNode({ prompt: '{{ref 3}} 中的人物回眸' })])} edges={edges(['i1', 'i2', 't1'])} />);
    await act(async () => {});
    const g = nodeEl(container, 'g');
    expect(Array.from(g.querySelectorAll('.cv-handle')).map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'video']);
    expect(within(g).getByLabelText('暂无生成视频')).toBeTruthy();
    const panel = g.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).getByLabelText('生成源')).toBeTruthy();
    expect(within(panel).getByLabelText('生成参数').textContent).toContain('9:16');
    expect(within(panel).getByRole('switch', { name: '智能规划' }).getAttribute('aria-checked')).toBe('false');
    expect(within(panel).getByTestId('cv-vgen-mode').textContent).toContain('多参考（自动）');
    // 未选生成源、智能规划关 → 不能发送
    const send = within(panel).getByLabelText('请先选择生成源（或开启智能规划由 Agent 选源）') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it.each([
    ['i2v', ['i1'], '单图参考'],
    ['r2v', ['i1', 'i2'], '多参考'],
    ['t2v', ['i1'], '文生视频'],
  ])('旧模式 %s 显示为新模式名', async (mode, keys, label) => {
    const { container } = render(<Canvas nodes={upstream([genNode({ prompt: 'x', mode })])} edges={edges(keys)} />);
    await act(async () => {});
    const hint = within(nodeEl(container, 'g')).getByTestId('cv-vgen-mode').textContent || '';
    expect(hint).toContain(`模式：${label}`);
    expect(hint).not.toContain('（自动）');
    // 参数弹层里的模式下拉也显示映射后的值
    fireEvent.click(within(nodeEl(container, 'g')).getByLabelText('生成参数'));
    const select = (await screen.findByLabelText('视频生成模式')) as HTMLSelectElement;
    expect(select.options[select.selectedIndex].textContent).toBe(label);
  });

  it('旧 i2v + 两张图分别指定首帧 / 尾帧 → 显示首尾帧；点参考卡片可改槽位（写 refRoles，同槽位互斥）', async () => {
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const { container } = render(<Canvas host={host} nodes={upstream([genNode({ prompt: 'x', mode: 'i2v', refRoles: { 'i1|image': 'first_frame', 'i2|image': 'last_frame' } })])} edges={edges(['i1', 'i2'])} />);
    await act(async () => {});
    const g = nodeEl(container, 'g');
    expect(within(g).getByTestId('cv-vgen-mode').textContent).toContain('模式：首尾帧');
    const cards = g.querySelectorAll('.cv-reflist .cv-ref');
    expect(Array.from(cards).map((c) => c.querySelector('.cv-ref__role')?.textContent)).toEqual(['首帧', '尾帧']);
    // 把参考 2 设为首帧 → 参考 1 的首帧被清掉
    fireEvent.click(cards[1].querySelector('[aria-hidden="true"][style]') as HTMLElement);
    const menu = await screen.findByRole('menu', { name: '参考设置' });
    fireEvent.click(within(menu).getByText('首帧'));
    expect(host.updateNodeData).toHaveBeenLastCalledWith('g', { refRoles: { 'i2|image': 'first_frame' } });
    // 键盘：焦点在参考卡片上按 Enter 也能打开槽位菜单；「自动」项显示当前去向
    await waitFor(() => expect(screen.queryByRole('menu', { name: '参考设置' })).toBeNull());
    (cards[0] as HTMLElement).focus();
    fireEvent.keyDown(cards[0], { key: 'Enter' });
    const menu2 = await screen.findByRole('menu', { name: '参考设置' });
    expect(within(menu2).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['自动（首帧）', '首帧', '尾帧', '参考图', '预览', '断开引用']);
  });

  it('旧视频节点上传播来的 url / image（上游图片地址）不当作生成结果显示', async () => {
    const { container } = render(<Canvas nodes={[genNode({ prompt: 'p', url: '/storage/test/c.png', image: '/storage/test/c.png' }, false)]} />);
    await act(async () => {});
    expect(nodeEl(container, 'g').querySelector('video')).toBeNull();
    expect(within(nodeEl(container, 'g')).getByLabelText('暂无生成视频')).toBeTruthy();
  });

  it('选生成源 → 写 provider_id + 该源缺省参数（params / provider_params / 顶层同步）；直接生成走 useGeneration（入参来自组装结果）', async () => {
    (executeAgentNode as any).mockResolvedValue({ video_url: '/storage/videos/out.mp4' });
    const { container } = render(<Canvas nodes={upstream([genNode({ prompt: '{{ref 1}} 慢慢转身', mode: '' })])} edges={edges(['i1'])} />);
    await act(async () => {});
    const g = () => nodeEl(container, 'g');
    fireEvent.click(within(g()).getByLabelText('生成源'));
    fireEvent.click(await screen.findByRole('option', { name: /全能视频源/ }));
    await waitFor(() => expect(within(g()).getByLabelText('生成参数').textContent).toContain('5秒'));
    // 参数弹层：模式（自动）+ 时长 + 比例 + 其他参数（DynamicControl，带 Agent 徽标）
    fireEvent.click(within(g()).getByLabelText('生成参数'));
    const ratio169 = await screen.findByLabelText('比例 16:9');
    expect((screen.getByLabelText('比例 4:3') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ratio169);
    expect(screen.getAllByText(/随机种子/).length).toBeGreaterThan(0);
    expect(screen.getByText('手填')).toBeTruthy();
    await waitFor(() => expect(within(g()).getByLabelText('生成参数').textContent).toContain('16:9'));
    fireEvent.click(within(g()).getByLabelText('生成视频'));
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalled());
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.node.type).toBe('video');
    expect(call.override).toMatchObject({
      provider_id: 'pv_full', first_frame: '/storage/a.png', mode: 'i2v', aspect_ratio: '16:9', duration: 5,
      prompt: '参考 1 慢慢转身\n\n（参考编号对应：参考 1=首帧图）',
    });
    await waitFor(() => expect(nodeEl(container, 'g').querySelector('video')?.getAttribute('src')).toBe('/storage/videos/out.mp4'));
  });

  it('FX-2：params 为空、面板显示 9:16 · 5秒 → 直接生成下发的就是 aspect_ratio 9:16 + duration 5（不往节点里写）', async () => {
    (executeAgentNode as any).mockResolvedValue({ video_url: '/storage/videos/out.mp4' });
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const { container } = render(<Canvas host={host} nodes={[genNode({ prompt: '镜头缓慢推近', provider_id: 'pv_full' })]} />);
    const g = () => nodeEl(container, 'g');
    await waitFor(() => expect(within(g()).getByLabelText('生成参数').textContent).toContain('9:16 · 5秒'));
    // 弹层：9:16 选中、时长显示 5 秒（不是「默认」）
    fireEvent.click(within(g()).getByLabelText('生成参数'));
    expect((await screen.findByLabelText('比例 9:16')).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('视频时长') as HTMLSelectElement).value).toBe('5');
    expect(host.updateNodeData).not.toHaveBeenCalledWith('g', expect.objectContaining({ params: expect.anything() }));
    fireEvent.click(within(g()).getByLabelText('生成视频'));
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalled());
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.override).toMatchObject({ provider_id: 'pv_full', aspect_ratio: '9:16', duration: 5 });
    expect(call.override).not.toHaveProperty('seed'); // 没有缺省、面板显示为空的不发
  });

  it('FX-2：生成源没声明比例 → 面板不选中比例、不下发 aspect_ratio；时长缺省照发', async () => {
    (executeAgentNode as any).mockResolvedValue({ video_url: '/storage/videos/out.mp4' });
    const { container } = render(<Canvas nodes={[genNode({ prompt: '雨夜', provider_id: 'pv_t2v' })]} />);
    const g = () => nodeEl(container, 'g');
    await waitFor(() => expect(within(g()).getByLabelText('生成参数').textContent).toContain('5秒'));
    expect(within(g()).getByLabelText('生成参数').textContent).not.toContain('9:16');
    fireEvent.click(within(g()).getByLabelText('生成参数'));
    expect((await screen.findByLabelText('比例 9:16')).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(g()).getByLabelText('生成视频'));
    await waitFor(() => expect(executeAgentNode).toHaveBeenCalled());
    const call = (executeAgentNode as any).mock.calls[0][0];
    expect(call.override).toMatchObject({ duration: 5 });
    expect(call.override).not.toHaveProperty('aspect_ratio');
  });

  it('只收文本的生成源：自动模式为文生、图片参考提示「不支持」', async () => {
    const { container } = render(<Canvas nodes={upstream([genNode({ prompt: 'x', provider_id: 'pv_t2v' })])} edges={edges(['i1'])} />);
    await waitFor(() => expect(within(nodeEl(container, 'g')).getByTestId('cv-vgen-mode').textContent).toContain('模式：文生视频（自动）'));
    expect(nodeEl(container, 'g').querySelector('.cv-prompt-warnings')?.textContent).toContain('未使用');
  });

  it('重启恢复：挂载时 _polling && _taskId → pollVideoTask，出片写 video_url + 历史 + completed', async () => {
    (pollVideoTask as any).mockResolvedValue('/storage/videos/recovered.mp4');
    const host: CanvasHost = { updateNodeData: vi.fn() };
    render(<Canvas host={host} nodes={[genNode({ prompt: 'p', provider_id: 'pv_full', _taskId: 'task_42', _polling: true, history: [] }, false)]} />);
    await waitFor(() => expect(pollVideoTask).toHaveBeenCalledWith('task_42'));
    await waitFor(() => expect(host.updateNodeData).toHaveBeenCalledWith('g', expect.objectContaining({ video_url: '/storage/videos/recovered.mp4', _polling: false })));
    const last = (host.updateNodeData as any).mock.calls.at(-1)[1];
    expect(last.history[0]).toMatchObject({ url: '/storage/videos/recovered.mp4', provider_id: 'pv_full' });
    expect(last.agent_state.status).toBe('completed');
  });

  it('宿主加载时把 _polling 复位后：保留的 task_id 可「重新查询」', async () => {
    (pollVideoTask as any).mockResolvedValue('/storage/videos/again.mp4');
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const { container } = render(<Canvas host={host} nodes={[genNode({ prompt: 'p', _taskId: 'task_9', _polling: false, agent_state: { status: 'idle', error: '服务中断前任务状态未知，task_id=task_9 已保留，可重新查询' } }, false)]} />);
    await act(async () => {});
    expect(pollVideoTask).not.toHaveBeenCalled();
    fireEvent.click(within(nodeEl(container, 'g')).getByLabelText('重新查询任务'));
    await waitFor(() => expect(host.updateNodeData).toHaveBeenCalledWith('g', expect.objectContaining({ video_url: '/storage/videos/again.mp4' })));
  });

  it('历史记录：切回旧版本只改 video_url（下游拿当前版本）', async () => {
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const history = [
      { url: '/storage/videos/v2.mp4', created_at: '2026-10-15T10:00:00Z', provider_id: 'pv_full' },
      { url: '/storage/videos/v1.mp4', created_at: '2026-10-15T09:00:00Z', provider_id: 'pv_full' },
    ];
    const { container } = render(<Canvas host={host} nodes={[genNode({ prompt: 'p', video_url: '/storage/videos/v2.mp4', history })]} />);
    await act(async () => {});
    fireEvent.click(within(topBar(container, 'g')).getByText('历史记录'));
    const dialog = await screen.findByRole('dialog');
    const items = within(dialog).getAllByRole('option');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('当前结果');
    fireEvent.click(items[1]);
    fireEvent.click(within(dialog).getByText('设为当前结果'));
    expect(host.updateNodeData).toHaveBeenLastCalledWith('g', { video_url: '/storage/videos/v1.mp4' });
  });
});
