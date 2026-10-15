// REQ-toonflow-canvas N4：截取 / 变速 → 后端 /media/ops/*（mock）→ createNodes 新建 load-audio；上传走素材库（C1 起常见格式直传，只有 amr 等转码）。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../../../services/mediaOps', () => ({
  speedAudio: vi.fn(async (_url: string, rate: number) => ({ status: 'success', url: '/storage/generated/media_ops/sp.m4a', kind: 'audio', duration: 10 / rate, size_bytes: 1, rate })),
  trimMedia: vi.fn(async (_url: string, start: number, end: number) => ({ status: 'success', url: '/storage/generated/media_ops/tr.wav', kind: 'audio', duration: end - start, size_bytes: 1, start, end })),
  probeMedia: vi.fn(async () => ({ status: 'success', kind: 'audio', duration: 3, width: 0, height: 0, has_audio: true, has_video: false, size_bytes: 1 })),
}));
vi.mock('../../../../../services/api', () => ({
  apiService: {
    createAsset: vi.fn(async (fd: FormData) => ({ id: 'ast_1', file_url: fd.get('file') ? '/storage/assets/ast_1/original.mp3' : String(fd.get('file_url')) })),
    getAsset: vi.fn(async () => ({ id: 'ast_9', name: '雨声', file_url: '/storage/assets/ast_9/original.png' })),
    listProviders: vi.fn(async () => ({ providers: [] })),
    getProvider: vi.fn(async () => null),
    canvasAgentGenerate: vi.fn(),
  },
}));

import { setupFlowEnv, Canvas, node } from './helpers';
import '../index';
import { speedAudio, trimMedia, probeMedia } from '../../../../../services/mediaOps';
import { apiService } from '../../../../../services/api';
import { readDropPayload, resolveDroppedAudioUrl, toStoredUrl, uploadAudioFile } from '../media';
import { derivedLabel, isValidTrim } from '../useAudioProcessing';
import type { CanvasHost } from '../../../kit/hostContext';

beforeAll(() => {
  setupFlowEnv();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"voices":[]}', { status: 200 })));
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

const SRC = '/storage/a.wav';

function renderLoadAudio(host: CanvasHost) {
  const r = render(<Canvas host={host} nodes={[node('a1', 'load-audio', { label: '旁白', audio_url: SRC, audio: SRC, url: SRC }, { selected: true })]} />);
  const el = () => r.container.querySelector('.react-flow__node[data-id="a1"] .cv-node') as HTMLElement;
  return { ...r, el };
}

describe('变速', () => {
  it('打开下方 440 面板 → 1.5× → speedAudio → createNodes 新建 load-audio（右侧）', async () => {
    const createNodes = vi.fn(() => ['new1']);
    const { el } = renderLoadAudio({ createNodes });
    await act(async () => {});
    fireEvent.click(within(el().querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('音频变速'));
    const bottom = el().querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(bottom.style.width).toBe('440px');
    const send = within(bottom).getByLabelText('生成变速音频') as HTMLButtonElement;
    expect(send.disabled).toBe(true); // 1× 不需要变速
    const input = within(bottom).getByLabelText('音频变速倍数');
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(send.disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });
    expect(speedAudio).toHaveBeenCalledWith(SRC, 1.5);
    await waitFor(() => expect(createNodes).toHaveBeenCalledTimes(1));
    expect(createNodes).toHaveBeenCalledWith(
      [{
        type: 'load-audio',
        data: expect.objectContaining({
          label: '旁白 · 1.50×',
          audio_url: '/storage/generated/media_ops/sp.m4a',
          audio: '/storage/generated/media_ops/sp.m4a',
          url: '/storage/generated/media_ops/sp.m4a',
          derived_from: { url: SRC, op: 'speed', rate: 1.5 },
        }),
      }],
      { placement: 'right', anchorId: 'a1' },
    );
    // 成功后面板关闭
    await waitFor(() => expect(el().querySelector('.cv-node__slot--bottom')).toBeNull());
  });

  it('滑块范围 0.5–2；后端报错时面板显示原因、不建节点', async () => {
    (speedAudio as any).mockRejectedValueOnce(new Error('rate 须在 0.5–2.0 之间'));
    const createNodes = vi.fn(() => []);
    const { el } = renderLoadAudio({ createNodes });
    await act(async () => {});
    fireEvent.click(within(el().querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('音频变速'));
    const bottom = el().querySelector('.cv-node__slot--bottom') as HTMLElement;
    const slider = within(bottom).getByLabelText('音频变速滑块') as HTMLInputElement;
    expect([slider.min, slider.max]).toEqual(['0.5', '2']);
    fireEvent.change(slider, { target: { value: '0.75' } });
    await act(async () => { fireEvent.click(within(bottom).getByLabelText('生成变速音频')); });
    expect(speedAudio).toHaveBeenCalledWith(SRC, 0.75);
    expect(await within(bottom).findByText('rate 须在 0.5–2.0 之间')).toBeTruthy();
    expect(createNodes).not.toHaveBeenCalled();
  });
});

describe('截取', () => {
  it('弹窗选区间（开始 / 结束输入）→ trimMedia → createNodes', async () => {
    const createNodes = vi.fn(() => ['new2']);
    const { el } = renderLoadAudio({ createNodes });
    await act(async () => {});
    fireEvent.click(within(el().querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('截取音频'));
    const dialog = await screen.findByRole('dialog', { name: '截取音频' });
    // jsdom 不加载媒体：手动触发元数据（helpers 把 duration 固定为 10s）
    fireEvent.loadedMetadata(dialog.querySelector('audio')!);
    const startInput = within(dialog).getByLabelText('开始（秒）') as HTMLInputElement;
    const endInput = within(dialog).getByLabelText('结束（秒）') as HTMLInputElement;
    expect(endInput.value).toBe('10.00'); // 默认整段
    fireEvent.change(startInput, { target: { value: '1.2' } });
    fireEvent.blur(startInput);
    fireEvent.change(endInput, { target: { value: '3.5' } });
    fireEvent.blur(endInput);
    expect(within(dialog).getByText(/选区 0:01.20 – 0:03.50（2.30 秒）/)).toBeTruthy();
    // 键盘微调结束把手：→ +0.1s
    fireEvent.keyDown(within(dialog).getByRole('slider', { name: '截取结束' }), { key: 'ArrowRight' });
    expect(endInput.value).toBe('3.60');
    await act(async () => { fireEvent.click(within(dialog).getByText('导出音频')); });
    expect(trimMedia).toHaveBeenCalledWith(SRC, 1.2, 3.6);
    await waitFor(() => expect(createNodes).toHaveBeenCalledTimes(1));
    const [specs, opts] = (createNodes.mock.calls[0] as unknown) as [any[], any];
    expect(opts).toEqual({ placement: 'right', anchorId: 'a1' });
    expect(specs).toHaveLength(1);
    expect(specs[0].type).toBe('load-audio');
    expect(specs[0].data).toMatchObject({
      label: '旁白 · 截取 0:01.20–0:03.60',
      audio_url: '/storage/generated/media_ops/tr.wav',
      derived_from: { url: SRC, op: 'trim', start: 1.2, end: 3.6 },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '截取音频' })).toBeNull());
  });

  it('音频生成节点的结果也能截取（产物同样是新的 load-audio）', async () => {
    const createNodes = vi.fn(() => ['new3']);
    const { container } = render(<Canvas host={{ createNodes }} nodes={[node('g1', 'audio', { label: '配音', text: '你好', audio_url: '/storage/gen/x.mp3' }, { selected: true })]} />);
    await act(async () => {});
    const el = container.querySelector('.react-flow__node[data-id="g1"] .cv-node') as HTMLElement;
    fireEvent.click(within(el.querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('截取音频'));
    const dialog = await screen.findByRole('dialog', { name: '截取音频' });
    fireEvent.loadedMetadata(dialog.querySelector('audio')!);
    await act(async () => { fireEvent.click(within(dialog).getByText('导出音频')); });
    expect(trimMedia).toHaveBeenCalledWith('/storage/gen/x.mp3', 0, 10);
    await waitFor(() => expect(createNodes).toHaveBeenCalledTimes(1));
    expect((createNodes.mock.calls[0] as any)[0][0]).toMatchObject({ type: 'load-audio', data: { label: '配音 · 截取 0:00.00–0:10.00' } });
  });

  it('区间校验与标题', () => {
    expect(isValidTrim(0, 0.04, 10)).toBe(false);
    expect(isValidTrim(1, 3, 10)).toBe(true);
    expect(isValidTrim(1, 10.5, 10)).toBe(false);
    expect(derivedLabel('', 'speed', 2)).toBe('音频 · 2.00×');
  });
});

describe('上传 / 拖入', () => {
  const file = (name: string, type: string, size = 16) => new File([new Uint8Array(size)], name, { type });

  it('mp3 / wav 直接进素材库（file）', async () => {
    const res = await uploadAudioFile(file('台词.mp3', 'audio/mpeg'), { projectId: 'proj_1' });
    expect(res).toEqual({ url: '/storage/assets/ast_1/original.mp3', assetId: 'ast_1', name: '台词', transcoded: false });
    const fd = (apiService.createAsset as any).mock.calls[0][0] as FormData;
    expect(fd.get('category')).toBe('other');
    expect(fd.get('scope')).toBe('project');
    expect(fd.get('project_id')).toBe('proj_1');
    expect((fd.get('file') as File).name).toBe('台词.mp3');
    expect(speedAudio).not.toHaveBeenCalled();
  });

  it('REQ-toonflow-canvas C1：m4a / ogg / flac / aac 等常见格式也直接进素材库（素材库已保留真实扩展名，不再转码）', async () => {
    for (const [name, type] of [['memo.m4a', 'audio/mp4'], ['rain.ogg', 'audio/ogg'], ['take.flac', 'audio/flac'], ['bgm.aac', 'audio/aac'], ['voice', 'audio/mp4']] as const) {
      (apiService.createAsset as any).mockClear();
      const res = await uploadAudioFile(file(name, type));
      const fd = (apiService.createAsset as any).mock.calls[0][0] as FormData;
      expect((fd.get('file') as File).name).toBe(name);
      expect(fd.get('file_url')).toBeNull();
      expect(res.transcoded).toBe(false);
    }
    expect(speedAudio).not.toHaveBeenCalled();
  });

  it('浏览器播不了的格式（amr 等）先原速转码，再以 file_url 登记', async () => {
    const res = await uploadAudioFile(file('memo.amr', 'audio/amr'));
    expect(speedAudio).toHaveBeenCalledTimes(1);
    const [dataUrl, rate] = (speedAudio as any).mock.calls[0];
    expect(String(dataUrl).startsWith('data:audio/amr;base64,')).toBe(true);
    expect(rate).toBe(1);
    const fd = (apiService.createAsset as any).mock.calls[0][0] as FormData;
    expect(fd.get('file')).toBeNull();
    expect(fd.get('file_url')).toBe('/storage/generated/media_ops/sp.m4a');
    expect(fd.get('scope')).toBe('global');
    expect(res).toMatchObject({ url: '/storage/generated/media_ops/sp.m4a', transcoded: true });
  });

  it('不是音频 / 超大文件被拒', async () => {
    await expect(uploadAudioFile(file('a.png', 'image/png'))).rejects.toThrow('请选择音频文件');
    const big = file('big.wav', 'audio/wav');
    Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
    await expect(uploadAudioFile(big)).rejects.toThrow('100 MB');
  });

  it('素材库卡片拖入：读 canvas-assetid + URL；扩展名不像音频时用 probe 判断', async () => {
    const dt = {
      files: [] as unknown as FileList,
      types: ['application/canvas-assetid', 'text/plain'],
      getData: (t: string) => (t === 'application/canvas-assetid' ? 'ast_9' : t === 'text/plain' ? 'http://127.0.0.1:8001/storage/assets/ast_9/original.png' : ''),
    } as unknown as DataTransfer;
    const payload = readDropPayload(dt)!;
    expect(payload).toEqual({ url: 'http://127.0.0.1:8001/storage/assets/ast_9/original.png', assetId: 'ast_9' });
    const res = await resolveDroppedAudioUrl(payload);
    expect(probeMedia).toHaveBeenCalled();
    expect(res.assetId).toBe('ast_9');
    expect(res.name).toBe('雨声');
    (probeMedia as any).mockResolvedValueOnce({ kind: 'video' });
    await expect(resolveDroppedAudioUrl({ url: '/storage/x.bin' })).rejects.toThrow('视频素材');
    expect(toStoredUrl('/storage/a.mp3')).toBe('/storage/a.mp3');
  });

  it('load-audio 空节点拖入本地音频文件 → 上传 → 写 audio_url / audio / url / asset_id', async () => {
    const updateNodeData = vi.fn();
    const { container } = render(<Canvas host={{ updateNodeData }} nodes={[node('a1', 'load-audio', {})]} />);
    await act(async () => {});
    const zone = container.querySelector('.react-flow__node[data-id="a1"] .cv-audio-content') as HTMLElement;
    const f = file('旁白.wav', 'audio/wav');
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [f], types: ['Files'], getData: () => '' } });
    });
    await waitFor(() => expect(updateNodeData).toHaveBeenCalled());
    expect(updateNodeData).toHaveBeenCalledWith('a1', expect.objectContaining({
      audio_url: '/storage/assets/ast_1/original.mp3', audio: '/storage/assets/ast_1/original.mp3', url: '/storage/assets/ast_1/original.mp3', asset_id: 'ast_1', name: '旁白',
    }));
  });
});
