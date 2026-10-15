// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 3D 导演导出的上传：沿用 3D 片场的做法（apiService.createAsset → 素材库 previz 分类），
 * 返回 `/storage/assets/<id>/original.<ext>` 写进节点 image_url / video_url。
 *
 * 素材库按扩展名落盘且只认 png/jpg/webp/mp4…（webm 会被存成 .png），所以视频只上传 MP4；
 * 浏览器只能录 WebM 时（如 Firefox）走 T2 媒体接口 `/media/ops/trim` 转成 H.264 MP4 再登记到素材库。
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

function pickUrl(r: any): string {
  const url = r?.asset?.file_url || r?.asset?.url || r?.file_url || r?.url || '';
  return typeof url === 'string' ? url : '';
}

/** Blob → 素材库（previz），返回文件地址 */
export async function uploadStageBlob(blob: Blob, opts: UploadOptions): Promise<string> {
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
  return url;
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

/** 以 file_url 登记到素材库（previz）；失败不影响导出结果 */
async function registerAsset(url: string, opts: { name: string; projectId?: string }): Promise<void> {
  try {
    const form = new FormData();
    form.append('name', opts.name);
    form.append('category', 'previz');
    form.append('tags', EXPORT_TAGS);
    if (opts.projectId) form.append('project_id', opts.projectId);
    form.append('file_url', url);
    await apiService.createAsset(form);
  } catch { /* 登记素材库失败不影响导出结果 */ }
}

/**
 * 录好的视频原样落地：MP4 直接进素材库；WebM 先转码（end 用实际时长留 0.1s 余量），再登记到素材库。
 */
export async function uploadStageVideo(blob: Blob, durationSec: number, opts: Omit<UploadOptions, 'fileName'> & { fileBase: string }): Promise<string> {
  if (isMp4(blob)) return uploadStageBlob(blob, { ...opts, fileName: `${opts.fileBase}.mp4` });
  let url = '';
  try {
    const res = await trimMedia(await blobToDataUrl(blob), 0, Math.max(0.1, durationSec - 0.1));
    url = res.url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`当前浏览器只能录制 WebM，服务器转 MP4 失败：${msg}。请用 Chrome / Edge 导出`);
  }
  await registerAsset(url, opts);
  return url;
}

export interface FinalizeVideoOptions extends Omit<UploadOptions, 'fileName'> {
  fileBase: string;
  /** 运镜时长（不含录制时多录的尾帧停留） */
  expectedSec: number;
  /** 录好的视频实际时长（measureVideoDuration；NaN = 读不到） */
  measuredSec: number;
}

/**
 * REQ-toonflow-canvas 录制产物落地：录制时在末尾多停留了一小段（给编码器追帧，见节点 RECORD_TAIL_HOLD_SEC），
 * 视频完整时交给 `/media/ops/trim` 精确裁到运镜时长（同时转成标准 H.264 MP4），再登记素材库；
 * 裁剪失败（如服务器没装 ffmpeg）或视频不完整时原样上传。
 */
export async function finalizeStageVideo(blob: Blob, o: FinalizeVideoOptions): Promise<{ url: string; trimmed: boolean }> {
  const complete = Number.isFinite(o.measuredSec) && o.measuredSec >= o.expectedSec - 0.05;
  if (complete) {
    try {
      const res = await trimMedia(await blobToDataUrl(blob), 0, o.expectedSec);
      await registerAsset(res.url, o);
      return { url: res.url, trimmed: true };
    } catch (e) {
      console.warn('[director3d] 服务器裁剪运镜视频失败，改为原样上传', e);
    }
  }
  const seconds = Number.isFinite(o.measuredSec) ? o.measuredSec : o.expectedSec;
  return { url: await uploadStageVideo(blob, seconds, o), trimmed: false };
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
