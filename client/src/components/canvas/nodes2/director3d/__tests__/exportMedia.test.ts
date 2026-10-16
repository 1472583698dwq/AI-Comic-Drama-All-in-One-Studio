// REQ-toonflow-canvas N5 · 导出产物落地：素材库上传字段、MP4 原样上传 / WebM 转码兜底（C1 起不再多录 + 服务器裁剪）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ createAsset: vi.fn(), trimMedia: vi.fn() }));
vi.mock('../../../../../services/api', () => ({ apiService: { createAsset: api.createAsset } }));
vi.mock('../../../../../services/mediaOps', () => ({ trimMedia: api.trimMedia }));

import { exportSavedPatch, isTruncated, uploadStageBlob, uploadStageVideo } from '../exportMedia';

const formOf = (call: unknown[]) => Object.fromEntries((call[0] as FormData).entries());

beforeEach(() => {
  api.createAsset.mockReset().mockResolvedValue({ id: 'ast_1', file_url: '/storage/assets/ast_1/original.mp4' });
  api.trimMedia.mockReset().mockResolvedValue({ status: 'success', url: '/storage/generated/media_ops/x.mp4', kind: 'video' });
});

describe('exportMedia', () => {
  it('uploadStageBlob：previz 分类 + 项目 + 带扩展名的文件，返回 file_url', async () => {
    const up = await uploadStageBlob(new Blob(['png'], { type: 'image/png' }), { fileName: 'director3d_1.png', name: '3D 导演 · 机位截图', projectId: 'p1' });
    expect(up).toEqual({ url: '/storage/assets/ast_1/original.mp4', assetId: 'ast_1' });
    const f = formOf(api.createAsset.mock.calls[0]);
    expect(f).toMatchObject({ name: '3D 导演 · 机位截图', category: 'previz', project_id: 'p1' });
    expect((f.file as File).name).toBe('director3d_1.png');
    expect((f.file as File).type).toBe('image/png');
    api.createAsset.mockResolvedValueOnce({});
    await expect(uploadStageBlob(new Blob(['x'], { type: 'image/png' }), { fileName: 'a.png', name: 'a' })).rejects.toThrow('没有返回文件地址');
    await expect(uploadStageBlob(new Blob([], { type: 'image/png' }), { fileName: 'a.png', name: 'a' })).rejects.toThrow('导出内容为空');
  });

  it('MP4 原样进素材库（文件名带 .mp4，不再经服务器裁剪）', async () => {
    const up = await uploadStageVideo(new Blob(['mp4'], { type: 'video/mp4' }), 2.5, { fileBase: 'd', name: 'n', projectId: 'p1' });
    expect(up).toEqual({ url: '/storage/assets/ast_1/original.mp4', assetId: 'ast_1' });
    expect(api.trimMedia).not.toHaveBeenCalled();
    const f = formOf(api.createAsset.mock.calls[0]);
    expect((f.file as File).name).toBe('d.mp4');
    expect(f).toMatchObject({ category: 'previz', project_id: 'p1' });
  });

  it('WebM（浏览器不支持 MP4 录制）→ 按实际时长转码成 MP4；转码失败给出可读原因', async () => {
    const up = await uploadStageVideo(new Blob(['webm'], { type: 'video/webm' }), 2.4, { fileBase: 'd', name: 'n' });
    // 转码产物以 file_url 登记到素材库，带回素材 id
    expect(up).toEqual({ url: '/storage/generated/media_ops/x.mp4', assetId: 'ast_1' });
    expect(api.trimMedia.mock.calls[0][1]).toBe(0);
    expect(api.trimMedia.mock.calls[0][2]).toBeCloseTo(2.3, 9);
    api.trimMedia.mockRejectedValueOnce(new Error('ffmpeg 未安装'));
    await expect(uploadStageVideo(new Blob(['webm'], { type: 'video/webm' }), 2.4, { fileBase: 'd', name: 'n' })).rejects.toThrow(/只能录制 WebM.*ffmpeg 未安装/);
  });

  it('素材 id 兼容 {asset:{id}} 包一层的返回', async () => {
    api.createAsset.mockResolvedValueOnce({ asset: { id: 'ast_9', file_url: '/storage/assets/ast_9/original.png' } });
    await expect(uploadStageBlob(new Blob(['png'], { type: 'image/png' }), { fileName: 'a.png', name: 'a' })).resolves.toEqual({ url: '/storage/assets/ast_9/original.png', assetId: 'ast_9' });
  });

  it('exportSavedPatch：导演节点标记已入库的那份产出（宿主先取图片、再取视频）', () => {
    // 只导出过图片
    expect(exportSavedPatch({}, 'image', { url: '/i.png', assetId: 'ai' })).toEqual({ image_url: '/i.png', image_asset_id: 'ai', _saved_asset: { id: 'ai', value: '/i.png' } });
    // 只导出视频
    expect(exportSavedPatch({}, 'video', { url: '/v.mp4', assetId: 'av' })).toEqual({ video_url: '/v.mp4', video_asset_id: 'av', _saved_asset: { id: 'av', value: '/v.mp4' } });
    // 已有图片再导出视频：宿主仍取图片，_saved_asset 沿用图片那份
    expect(exportSavedPatch({ image_url: '/i.png', image_asset_id: 'ai' }, 'video', { url: '/v.mp4', assetId: 'av' }))
      .toEqual({ video_url: '/v.mp4', video_asset_id: 'av', _saved_asset: { id: 'ai', value: '/i.png' } });
    // 登记失败（没有 id）：不写 _saved_asset
    expect(exportSavedPatch({}, 'image', { url: '/i.png', assetId: '' })).toEqual({ image_url: '/i.png' });
  });

  it('isTruncated：短于运镜 85% 才算掉帧；读不到时长不算', () => {
    expect(isTruncated(1.4, 2.5)).toBe(true);
    expect(isTruncated(2.2, 2.5)).toBe(false);
    expect(isTruncated(Number.NaN, 2.5)).toBe(false);
  });
});
