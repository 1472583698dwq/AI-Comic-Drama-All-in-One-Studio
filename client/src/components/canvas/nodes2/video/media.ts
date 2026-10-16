// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频节点的素材读写：上传、素材库拖入、URL 归一。
 *
 * 上传沿用 MiniMax 画布现有通道（CanvasResourcePickerModal：音视频走素材库 createAsset 取 file_url）。
 * REQ-toonflow-canvas C1：素材库已保留真实扩展名（mp4 / mov / webm / m4v / mkv / avi / ogv），这些格式都直接进素材库
 * （以前非 MP4 会被存成 .png，只能绕道附件上传）；素材库不收的少见格式（wmv / flv…）仍走附件上传保留扩展名。
 */
import { apiService } from '../../../../services/api';
import { API_ORIGIN } from '../../../../utils/devOrigin';

/** Toonflow videoNode：单个视频不能为空且不超过 100 MB。 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)(?:$|[?#])/i;

/** 节点当前视频（沿用 MiniMax 键：video_url 为准，旧数据回落 video / url）。 */
export function videoUrlOf(data: Record<string, unknown> | null | undefined): string {
  const d = data || {};
  for (const k of ['video_url', 'video', 'url']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 写视频的补丁：三个键一起写（readOutputValue 先读端口同名键 `video`，再读 video_url）。 */
export function videoPatch(url: string): Record<string, unknown> {
  return { video_url: url, video: url, url };
}

export function looksLikeVideoUrl(u: string): boolean {
  return VIDEO_EXT_RE.test(u) || /^data:video\//i.test(u);
}

/** 本机后端的绝对地址（dev 回源 / 素材库拖拽带的 http://127.0.0.1:8000/storage/…）→ 存储相对路径；其余原样。 */
export function normalizeMediaUrl(u: string): string {
  const s = (u || '').trim();
  if (!s) return '';
  if (API_ORIGIN && s.startsWith(API_ORIGIN)) {
    const rest = s.slice(API_ORIGIN.length);
    if (/^\/(storage|exports)\//.test(rest)) return rest;
  }
  const m = s.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/(?:storage|exports)\/.*)$/i);
  return m ? m[1] : s;
}

/** 文件名（下载用）。 */
export function fileNameOf(u: string): string {
  const clean = (u || '').split(/[?#]/)[0];
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || 'video.mp4';
}

export function validateVideoFile(file: File | null | undefined): string | null {
  if (!file) return '请选择视频文件';
  if (!(file.type || '').startsWith('video/') && !VIDEO_EXT_RE.test(file.name)) return '请选择视频文件';
  if (!file.size || file.size > MAX_VIDEO_BYTES) return '视频不能为空且不能超过 100 MB';
  return null;
}

/** 素材库原样保存的视频扩展名 / content-type（server/app/providers/asset/manager.py::ASSET_FILE_EXTS / _MIME_TO_EXT）。 */
const ASSET_VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;
const ASSET_VIDEO_TYPES = ['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/avi', 'video/ogg'];

/** REQ-toonflow-canvas C1：素材库能否原样保存这个视频（文件名扩展名或 content-type 认得出来）。 */
export function assetKeepsVideoFormat(file: Pick<File, 'name' | 'type'>): boolean {
  if (ASSET_VIDEO_EXT_RE.test(file.name)) return true;
  // 文件名带了别的扩展名（如 .wmv）时后端按文件名判断，不看 content-type
  if (/\.[a-z0-9]{1,5}$/i.test(file.name)) return false;
  return ASSET_VIDEO_TYPES.includes((file.type || '').split(';')[0].trim().toLowerCase());
}

export interface UploadedVideo {
  url: string;
  /** 走素材库上传时的素材 id（宿主可据此判断「已在素材库」）。 */
  assetId?: string;
}

/** 上传视频：素材库认得的格式 → 素材库（项目内）；其他少见格式 → 附件上传。返回存储相对 URL。 */
export async function uploadVideoFile(file: File, projectId?: string | null): Promise<UploadedVideo> {
  const err = validateVideoFile(file);
  if (err) throw new Error(err);
  if (assetKeepsVideoFormat(file)) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', file.name.replace(/\.[^/.]+$/, '') || '视频');
    // 同 CanvasResourcePickerModal；后端分类表没有 video，会归为 other
    fd.append('category', 'video');
    fd.append('scope', 'project');
    if (projectId) fd.append('project_id', projectId);
    const res: any = await apiService.createAsset(fd);
    const asset = res?.asset ?? res;
    const url = asset?.file_url || res?.file_url || res?.url;
    if (!url) throw new Error('上传成功但未返回视频地址');
    return { url: String(url), assetId: asset?.id ? String(asset.id) : undefined };
  }
  try {
    const meta = await apiService.uploadAgentAttachment(file);
    if (!meta?.ref) throw new Error('上传未返回视频地址');
    return { url: meta.ref };
  } catch (e: any) {
    throw new Error(`${file.name.split('.').pop()?.toUpperCase() || '该'} 格式上传失败（${String(e?.message || e).slice(0, 80)}），请转成 MP4 后重试`);
  }
}

export interface DroppedMedia {
  url: string;
  assetId?: string;
  category?: string;
}

/** 解析拖入的素材（素材库卡片带 application/canvas-assetid + text/plain 绝对地址；也接受 uri-list / 纯文本 URL）。 */
export function parseMediaDrop(dt: Pick<DataTransfer, 'getData'> | null | undefined): DroppedMedia | null {
  if (!dt) return null;
  const get = (t: string) => {
    try { return dt.getData(t) || ''; } catch { return ''; }
  };
  const uriList = get('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '';
  const raw = (get('text/plain') || uriList).trim();
  if (!raw || /\s/.test(raw)) return null;
  if (!/^(https?:|data:|blob:|\/)/i.test(raw)) return null;
  return {
    url: normalizeMediaUrl(raw),
    assetId: get('application/canvas-assetid') || undefined,
    category: get('application/asset-category') || undefined,
  };
}

/** 拖入的是不是视频：URL 扩展名是视频（素材库没有 video 分类，视频素材的 category 多为 other），或分类就是 video。 */
export function isVideoDrop(m: DroppedMedia | null): boolean {
  if (!m) return false;
  return looksLikeVideoUrl(m.url) || m.category === 'video';
}
