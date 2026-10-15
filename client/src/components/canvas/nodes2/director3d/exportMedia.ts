// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 3D 导演导出的上传：沿用 3D 片场的做法（apiService.createAsset → 素材库 previz 分类），
 * 返回 `{url: /storage/assets/<id>/original.<ext>, assetId}`：url 写进节点 image_url / video_url，
 * assetId 记进导出新建的图片 / 视频节点（asset_id）与导演节点（_saved_asset），「保存到素材库」据此置灰，不重复入库。
 *
 * 「导出 MP4」只产出 MP4（下游视频生成 / 剪辑按 H.264 MP4 处理）：浏览器录出 MP4 时直接进素材库；
 * 只能录 WebM 时（如 Firefox）走 T2 媒体接口 `/media/ops/trim` 转成 H.264 MP4 再登记到素材库。
 * （C1 起素材库已保留 .webm 等真实扩展名；录制尾部丢帧也已在 stageCore 修掉，不再需要多录 + 服务器裁剪。）
 */
import { apiService } from '../../../../services/api';
import { trimMedia } from '../../../../services/mediaOps';

export const EXPORT_TAGS = 'previz,导演预演,画布3D导演';

export interface UploadOptions {
  /** 带扩展名的文件名（后端按扩展名落盘） */
  fileName: string;
  /** 素材库里的名字 */
  name: string;
  projectId?: string;
}

export interface UploadedStageAsset {
  /** 文件地址 */
  url: string;
  /** 素材库 id（登记失败时为空串） */
  assetId: string;
}

function pickUrl(r: any): string {
  const url = r?.asset?.file_url || r?.asset?.url || r?.file_url || r?.url || '';
  return typeof url === 'string' ? url : '';
}

function pickId(r: any): string {
  const id = r?.asset?.id ?? r?.id ?? '';
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

/** Blob → 素材库（previz），返回文件地址与素材 id */
export async function uploadStageBlob(blob: Blob, opts: UploadOptions): Promise<UploadedStageAsset> {
  if (!blob.size) throw new Error('导出内容为空');
  const form = new FormData();
  form.append('name', opts.name);
  form.append('category', 'previz');
  form.append('tags', EXPORT_TAGS);
  if (opts.projectId) form.append('project_id', opts.projectId);
  form.append('file', new File([blob], opts.fileName, { type: blob.type || 'application/octet-stream' }));
  const r = await apiService.createAsset(form);
  const url = pickUrl(r);
  if (!url) throw new Error('上传成功但没有返回文件地址');
  return { url, assetId: pickId(r) };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取导出文件失败'));
    reader.readAsDataURL(blob);
  });
}

export const isMp4 = (blob: Blob) => /mp4/i.test(blob.type);

/** 以 file_url 登记到素材库（previz），返回素材 id；失败不影响导出结果（返回空串） */
async function registerAsset(url: string, opts: { name: string; projectId?: string }): Promise<string> {
  try {
    const form = new FormData();
    form.append('name', opts.name);
    form.append('category', 'previz');
    form.append('tags', EXPORT_TAGS);
    if (opts.projectId) form.append('project_id', opts.projectId);
    form.append('file_url', url);
    return pickId(await apiService.createAsset(form));
  } catch {
    return ''; /* 登记素材库失败不影响导出结果 */
  }
}

/**
 * 录好的视频原样落地：MP4 直接进素材库；WebM 先转码（end 用实际时长留 0.1s 余量），再登记到素材库。
 */
export async function uploadStageVideo(blob: Blob, durationSec: number, opts: Omit<UploadOptions, 'fileName'> & { fileBase: string }): Promise<UploadedStageAsset> {
  if (isMp4(blob)) return uploadStageBlob(blob, { ...opts, fileName: `${opts.fileBase}.mp4` });
  let url = '';
  try {
    const res = await trimMedia(await blobToDataUrl(blob), 0, Math.max(0.1, durationSec - 0.1));
    url = res.url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`当前浏览器只能录制 WebM，服务器转 MP4 失败：${msg}。请用 Chrome / Edge 导出`);
  }
  return { url, assetId: await registerAsset(url, opts) };
}

/**
 * 导出后导演节点自己的「已入库」标记（宿主 canSaveToAssets 按 `_saved_asset.value === 当前产出` 置灰）：
 * 宿主取导演产出时按输出口顺序先图片后视频，所以只在本次导出的正是那份产出时才写；
 * 另记 `image_asset_id` / `video_asset_id`，导出视频时若已有图片，就沿用图片那份的 id。
 */
export function exportSavedPatch(
  data: { image_url?: unknown; video_url?: unknown; image_asset_id?: unknown; video_asset_id?: unknown },
  kind: 'image' | 'video',
  up: UploadedStageAsset,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { [`${kind}_url`]: up.url };
  if (up.assetId) patch[`${kind}_asset_id`] = up.assetId;
  const next = { ...data, ...patch } as Record<string, unknown>;
  const primary = typeof next.image_url === 'string' && next.image_url ? 'image' : 'video';
  const url = next[`${primary}_url`];
  const id = next[`${primary}_asset_id`];
  if (typeof url === 'string' && url && typeof id === 'string' && id) patch._saved_asset = { id, value: url };
  return patch;
}

/**
 * 读录好的视频的实际时长（秒）；读不到返回 NaN。MediaRecorder 产出的分段 MP4 / WebM 常没有总时长（Infinity），
 * 这时跳到末尾让浏览器算出来。
 */
export function measureVideoDuration(blob: Blob, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') { resolve(NaN); return; }
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let done = false;
    const finish = (d: number) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(d);
    };
    const timer = window.setTimeout(() => finish(NaN), timeoutMs);
    v.muted = true;
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) { finish(v.duration); return; }
      v.ondurationchange = () => { if (Number.isFinite(v.duration)) finish(v.duration); };
      try { v.currentTime = 1e7; } catch { finish(NaN); }
    };
    v.onerror = () => finish(NaN);
    v.src = url;
  });
}

/** 成片比运镜短 15% 以上视为录制掉帧（读不到时长时不算） */
export function isTruncated(actualSec: number, expectedSec: number): boolean {
  return Number.isFinite(actualSec) && expectedSec > 0 && actualSec < expectedSec * 0.85;
}
