// REQ-toonflow-canvas N3：截帧 / 提取音轨 / 分离音视频 / 截取 → 新节点规格（mock mediaOps）、摆放、素材 URL
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../services/mediaOps', () => ({
  extractFrame: vi.fn(),
  extractAudio: vi.fn(),
  splitAv: vi.fn(),
  trimMedia: vi.fn(),
}));

import { extractAudio, extractFrame, splitAv, trimMedia } from '../../../../../services/mediaOps';
import { captureFrameSpec, placeBeside, runVideoAction, withPlacement } from '../videoOps';
import { isVideoDrop, normalizeMediaUrl, parseMediaDrop, validateVideoFile, videoUrlOf } from '../media';
import { API_ORIGIN } from '../../../../../utils/devOrigin';

const V = '/storage/assets/ast_1/original.mp4';

describe('视频处理 → createNodes 规格', () => {
  beforeEach(() => vi.clearAllMocks());

  it('截取首帧 / 尾帧 → load-image（image_url + 旧键 image/url），标题「源 · 首帧」', async () => {
    (extractFrame as any).mockResolvedValue({ status: 'success', url: '/storage/generated/media_ops/f.png', kind: 'image', width: 320, height: 180, at: 'first', time: 0 });
    const spec = await captureFrameSpec(V, 'first', 9, '镜头 1');
    expect(extractFrame).toHaveBeenCalledWith(V, 'first');
    expect(spec).toEqual({
      type: 'load-image',
      data: {
        label: '镜头 1 · 首帧', image_url: '/storage/generated/media_ops/f.png', image: '/storage/generated/media_ops/f.png', url: '/storage/generated/media_ops/f.png',
        width: 320, height: 180, frame_time: 0, source_video: V,
      },
    });
    await captureFrameSpec(V, 'last', 0, '');
    expect(extractFrame).toHaveBeenLastCalledWith(V, 'last');
  });

  it('截取当前帧 → at=time + 播放头秒数', async () => {
    (extractFrame as any).mockResolvedValue({ status: 'success', url: '/f2.png', kind: 'image', width: 2, height: 2, at: 'time', time: 1.5 });
    const spec = await captureFrameSpec(V, 'current', 1.5, '视频');
    expect(extractFrame).toHaveBeenCalledWith(V, 'time', 1.5);
    expect(spec.data.label).toBe('视频 · 当前帧');
  });

  it('提取音轨 → 一个 load-audio', async () => {
    (extractAudio as any).mockResolvedValue({ status: 'success', url: '/storage/generated/media_ops/a.m4a', kind: 'audio', duration: 2.5, size_bytes: 10 });
    const specs = await runVideoAction('extractAudio', V, '视频');
    expect(extractAudio).toHaveBeenCalledWith(V);
    expect(specs).toEqual([{ type: 'load-audio', data: { label: '视频 · 音轨', audio_url: '/storage/generated/media_ops/a.m4a', audio: '/storage/generated/media_ops/a.m4a', url: '/storage/generated/media_ops/a.m4a', duration: 2.5 } }]);
  });

  it('分离音视频 → 静音 load-video + load-audio（视频在前）', async () => {
    (splitAv as any).mockResolvedValue({
      status: 'success', video_url: '/s.mp4', audio_url: '/s.m4a',
      video: { url: '/s.mp4', kind: 'video', duration: 2.5, width: 320, height: 240, has_audio: false, size_bytes: 1 },
      audio: { url: '/s.m4a', kind: 'audio', duration: 2.5, size_bytes: 1 },
    });
    const specs = await runVideoAction('separate', V, '视频');
    expect(splitAv).toHaveBeenCalledWith(V);
    expect(specs.map((s) => [s.type, s.data.label])).toEqual([['load-video', '视频 · 静音视频'], ['load-audio', '视频 · 音轨']]);
    expect(specs[0].data).toMatchObject({ video_url: '/s.mp4', video: '/s.mp4', url: '/s.mp4', duration: 2.5, width: 320, height: 240 });
  });

  it('截取片段 → load-video「源 · 1.00–3.00 秒」，带起止', async () => {
    (trimMedia as any).mockResolvedValue({ status: 'success', url: '/t.mp4', kind: 'video', duration: 2, width: 320, height: 240, has_audio: true, size_bytes: 1, start: 1, end: 3 });
    const specs = await runVideoAction('trim', V, '视频', { start: 1, end: 3 });
    expect(trimMedia).toHaveBeenCalledWith(V, 1, 3);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'load-video', data: { label: '视频 · 1.00–3.00 秒', video_url: '/t.mp4', trim_start: 1, trim_end: 3, duration: 2 } });
    await expect(runVideoAction('trim', V, '视频', { start: 3, end: 3 })).rejects.toThrow('有效');
  });
});

describe('摆放（Toonflow：右侧、避让、竖排）', () => {
  const nodes = [
    { id: 'v', position: { x: 0, y: 0 }, measured: { width: 300, height: 260 } },
    { id: 'blocker', position: { x: 350, y: 10 }, measured: { width: 200, height: 200 } },
  ];
  it('x = 源右缘 + gap；与右侧节点重叠时下移到其下方', () => {
    expect(placeBeside(nodes, 'v', { count: 1, width: 200, height: 300, gapX: 40, gapY: 24, stepY: 300 })).toEqual([{ x: 340, y: 234 }]);
    expect(placeBeside([nodes[0]], 'v', { count: 2, width: 320, height: 320, gapX: 80, gapY: 40, stepY: 320 })).toEqual([{ x: 380, y: 0 }, { x: 380, y: 320 }]);
  });
  it('源节点在分组里：不指定坐标（交给宿主）', () => {
    const specs = [{ type: 'load-image', data: {} }];
    expect(withPlacement([{ id: 'v', position: { x: 0, y: 0 }, parentId: 'g' }], 'v', specs, 'frame')).toBe(specs);
  });
});

describe('素材 URL / 上传校验 / 拖入', () => {
  it('videoUrlOf：video_url → video → url', () => {
    expect(videoUrlOf({ url: '/a.mp4', video: '/b.mp4' })).toBe('/b.mp4');
    expect(videoUrlOf({ video_url: ' /c.mp4 ', url: '/a.mp4' })).toBe('/c.mp4');
    expect(videoUrlOf(null)).toBe('');
  });
  it('本机后端绝对地址归一成 /storage 相对路径', () => {
    expect(normalizeMediaUrl('http://127.0.0.1:8000/storage/assets/x.mp4')).toBe('/storage/assets/x.mp4');
    expect(normalizeMediaUrl(`${API_ORIGIN || 'http://localhost:8001'}/storage/v.mp4`)).toBe('/storage/v.mp4');
    expect(normalizeMediaUrl('https://cdn.example.com/v.mp4')).toBe('https://cdn.example.com/v.mp4');
  });
  it('拖入：素材库卡片 / uri-list；按扩展名判视频（素材库没有 video 分类）', () => {
    const dt = (m: Record<string, string>) => ({ getData: (t: string) => m[t] ?? '' });
    const a = parseMediaDrop(dt({ 'text/plain': 'http://127.0.0.1:8000/storage/assets/ast_9/original.mp4', 'application/canvas-assetid': 'ast_9', 'application/asset-category': 'other' }));
    expect(a).toEqual({ url: '/storage/assets/ast_9/original.mp4', assetId: 'ast_9', category: 'other' });
    expect(isVideoDrop(a)).toBe(true);
    expect(isVideoDrop(parseMediaDrop(dt({ 'text/plain': '/storage/assets/ast_2/original.png', 'application/asset-category': 'character' })))).toBe(false);
    expect(parseMediaDrop(dt({ 'text/plain': '一段文字 不是地址' }))).toBeNull();
    expect(parseMediaDrop(dt({ 'text/uri-list': '# c\nhttps://x.test/a.webm' }))?.url).toBe('https://x.test/a.webm');
  });
  it('上传校验：类型、空文件、100MB 上限', () => {
    expect(validateVideoFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).toBe('请选择视频文件');
    expect(validateVideoFile(new File([], 'a.mp4', { type: 'video/mp4' }))).toContain('100 MB');
    expect(validateVideoFile(new File(['x'], 'a.mp4', { type: 'video/mp4' }))).toBeNull();
  });
});
