// REQ-toonflow-canvas N5 · 导出产物落地：素材库上传字段、MP4 原样上传 / WebM 转码兜底（C1 起不再多录 + 服务器裁剪）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ createAsset: vi.fn(), trimMedia: vi.fn() }));
vi.mock('../../../../../services/api', () => ({ apiService: { createAsset: api.createAsset } }));
vi.mock('../../../../../services/mediaOps', () => ({ trimMedia: api.trimMedia }));

import { isTruncated, uploadStageBlob, uploadStageVideo } from '../exportMedia';

const formOf = (call: unknown[]) => Object.fromEntries((call[0] as FormData).entries());

beforeEach(() => {
  api.createAsset.mockReset().mockResolvedValue({ id: 'ast_1', file_url: '/storage/assets/ast_1/original.mp4' });
  api.trimMedia.mockReset().mockResolvedValue({ status: 'success', url: '/storage/generated/media_ops/x.mp4', kind: 'video' });
});

describe('exportMedia', () => {
  it('uploadStageBlob：previz 分类 + 项目 + 带扩展名的文件，返回 file_url', async () => {
    const url = await uploadStageBlob(new Blob(['png'], { type: 'image/png' }), { fileName: 'director3d_1.png', name: '3D 导演 · 机位截图', projectId: 'p1' });
    expect(url).toBe('/storage/assets/ast_1/original.mp4');
    const f = formOf(api.createAsset.mock.calls[0]);
    expect(f).toMatchObject({ name: '3D 导演 · 机位截图', category: 'previz', project_id: 'p1' });
    expect((f.file as File).name).toBe('director3d_1.png');
    expect((f.file as File).type).toBe('image/png');
    api.createAsset.mockResolvedValueOnce({});
    await expect(uploadStageBlob(new Blob(['x'], { type: 'image/png' }), { fileName: 'a.png', name: 'a' })).rejects.toThrow('没有返回文件地址');
    await expect(uploadStageBlob(new Blob([], { type: 'image/png' }), { fileName: 'a.png', name: 'a' })).rejects.toThrow('导出内容为空');
  });

  it('MP4 原样进素材库（文件名带 .mp4，不再经服务器裁剪）', async () => {
    const url = await uploadStageVideo(new Blob(['mp4'], { type: 'video/mp4' }), 2.5, { fileBase: 'd', name: 'n', projectId: 'p1' });
    expect(url).toBe('/storage/assets/ast_1/original.mp4');
    expect(api.trimMedia).not.toHaveBeenCalled();
    const f = formOf(api.createAsset.mock.calls[0]);
    expect((f.file as File).name).toBe('d.mp4');
    expect(f).toMatchObject({ category: 'previz', project_id: 'p1' });
  });

  it('WebM（浏览器不支持 MP4 录制）→ 按实际时长转码成 MP4；转码失败给出可读原因', async () => {
    const url = await uploadStageVideo(new Blob(['webm'], { type: 'video/webm' }), 2.4, { fileBase: 'd', name: 'n' });
    expect(url).toBe('/storage/generated/media_ops/x.mp4');
    expect(api.trimMedia.mock.calls[0][1]).toBe(0);
    expect(api.trimMedia.mock.calls[0][2]).toBeCloseTo(2.3, 9);
    api.trimMedia.mockRejectedValueOnce(new Error('ffmpeg 未安装'));
    await expect(uploadStageVideo(new Blob(['webm'], { type: 'video/webm' }), 2.4, { fileBase: 'd', name: 'n' })).rejects.toThrow(/只能录制 WebM.*ffmpeg 未安装/);
  });

  it('isTruncated：短于运镜 85% 才算掉帧；读不到时长不算', () => {
    expect(isTruncated(1.4, 2.5)).toBe(true);
    expect(isTruncated(2.2, 2.5)).toBe(false);
    expect(isTruncated(Number.NaN, 2.5)).toBe(false);
  });
});
