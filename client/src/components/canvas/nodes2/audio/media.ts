// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频节点的素材存取：上传 / 拖入素材库素材 / URL 归一。
 *
 * 上传沿用 MiniMax 画布现有做法（CanvasResourcePickerModal：音视频走素材库 POST /assets 后取 file_url）。
 * REQ-toonflow-canvas C1：素材库已保留真实扩展名（asset manager `ASSET_FILE_EXTS`），浏览器能直接播放的格式
 * （mp3 / wav / m4a / aac / ogg / opus / flac / webm）原样进素材库；只有浏览器播不了、素材库也不收的格式
 * （amr / aiff / wma…）才先经 /media/ops/speed（rate=1，原速转码为 m4a）落到 storage，再以 file_url 登记进素材库。
 */
import { apiService } from '../../../../services/api';
import { probeMedia, speedAudio } from '../../../../services/mediaOps';
import { API_ORIGIN } from '../../../../utils/devOrigin';
import { readOutputValue } from '../../kit/references';

/** 认作音频的扩展名。 */
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'webm', 'amr', 'aif', 'aiff', 'wma'] as const;
/**
 * 直接进素材库的音频扩展名：素材库原样保存（server/app/providers/asset/manager.py::ASSET_FILE_EXTS）且浏览器能播放。
 * REQ-toonflow-canvas C1：以前只有 mp3 / wav（其余被素材库存成 .png），现在常见格式都直接上传。
 */
export const ASSET_SAFE_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'webm'] as const;
/** 单个音频上限（Toonflow 同款 100 MB）。 */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
/** 需要转码的格式走 data: URI，后端上限 50 MB（base64 后），原始文件约 37 MB。 */
export const MAX_TRANSCODE_BYTES = 37 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'webm',
};

/** 文件名 / URL 的小写扩展名（忽略 ?query 与 #hash）。 */
export function extOf(nameOrUrl: string | undefined | null): string {
  if (!nameOrUrl) return '';
  const path = nameOrUrl.split(/[?#]/)[0];
  const last = path.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

export function isAudioFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type?.startsWith('audio/')) return true;
  return (AUDIO_EXTS as readonly string[]).includes(extOf(file.name));
}

export function looksLikeAudioUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  if (/^data:audio\//i.test(url)) return true;
  return (AUDIO_EXTS as readonly string[]).includes(extOf(url));
}

/** URL 里的文件名（下载名 / 列表展示用）。 */
export function fileNameOf(url: string | undefined | null): string {
  if (!url || /^(data|blob):/i.test(url)) return '';
  const last = url.split(/[?#]/)[0].split('/').pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * 存进节点数据的 URL：去掉 dev 回源前缀（VITE_API_ORIGIN）与同源前缀，保留 `/storage/...` 相对地址，
 * 换端口 / 换机器后仍可用；其余（外网 http、相对路径）原样。
 */
export function toStoredUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (API_ORIGIN && u.startsWith(`${API_ORIGIN}/`)) return u.slice(API_ORIGIN.length);
  if (typeof window !== 'undefined' && /^https?:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      if (parsed.origin === window.location.origin && /^\/(storage|exports)\//.test(parsed.pathname)) return `${parsed.pathname}${parsed.search}`;
    } catch {
      /* 非法 URL 原样返回 */
    }
  }
  return u;
}

/** 音频节点当前音频（与下游读取同一规则：kit/references.readOutputValue，audio 口先读 data.audio 再 audio_url）。 */
export function loadAudioUrlOf(data: Record<string, unknown> | undefined, nodeType = 'load-audio'): string {
  return readOutputValue({ type: nodeType, data: data || {} }, 'audio', 'AUDIO');
}

/** load-audio 节点的数据补丁：同时写 audio_url / audio / url（旧 LoaderNodes 与迁移约定的三个键）。 */
export function loadAudioPatch(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { audio_url: url, audio: url, url, ...extra };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export interface UploadedAudio {
  /** 存储相对地址（/storage/...） */
  url: string;
  /** 登记进素材库的素材 id（宿主「保存到素材库」可据此避免重复入库） */
  assetId?: string;
  /** 不带扩展名的文件名 */
  name: string;
  /** 是否经过转码（amr / aiff / wma 等浏览器播不了的格式） */
  transcoded: boolean;
}

/** 上传音频文件：常见格式（ASSET_SAFE_EXTS）直接进素材库；其他格式先转码再登记。失败抛 Error（message 可直接展示）。 */
export async function uploadAudioFile(file: File, opts: { projectId?: string } = {}): Promise<UploadedAudio> {
  if (!isAudioFile(file)) throw new Error('请选择音频文件');
  if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error('音频不能为空且不能超过 100 MB');
  const name = file.name.replace(/\.[^/.]+$/, '') || '音频';
  const ext = extOf(file.name) || MIME_EXT[file.type] || '';
  const direct = (ASSET_SAFE_EXTS as readonly string[]).includes(ext);
  let fileUrl = '';
  if (!direct) {
    if (file.size > MAX_TRANSCODE_BYTES) throw new Error('该格式需要先转码，文件不能超过 37 MB；也可以先转成 mp3 / m4a / wav 再上传');
    // rate=1：atempo=1 等于原速转码（默认输出 m4a/AAC 192k）
    const res = await speedAudio(await readAsDataUrl(file), 1);
    fileUrl = res.url;
  }
  const fd = new FormData();
  fd.append('name', name);
  fd.append('category', 'other');
  fd.append('tags', 'audio,canvas');
  fd.append('description', '画布音频节点上传');
  fd.append('scope', opts.projectId ? 'project' : 'global');
  if (opts.projectId) fd.append('project_id', opts.projectId);
  if (direct) fd.append('file', file, file.name);
  else fd.append('file_url', fileUrl);
  try {
    const res: any = await apiService.createAsset(fd);
    const asset = res?.asset ?? res;
    const url = String(asset?.file_url || fileUrl || '');
    if (!url) throw new Error('上传失败：服务端没有返回文件地址');
    return { url, assetId: asset?.id ? String(asset.id) : undefined, name, transcoded: !direct };
  } catch (e) {
    // 转码产物已在 storage：登记素材库失败也照样可用
    if (fileUrl) return { url: fileUrl, name, transcoded: true };
    throw e;
  }
}

export interface DropPayload {
  file?: File;
  url?: string;
  assetId?: string;
}

/** 读取拖放数据：本地文件 / 素材库卡片（application/canvas-assetid + text/plain URL）/ 任意音频 URL。 */
export function readDropPayload(dt: DataTransfer | null | undefined): DropPayload | null {
  if (!dt) return null;
  const file = Array.from(dt.files || []).find((f) => isAudioFile(f)) ?? dt.files?.[0];
  if (file) return { file };
  const assetId = dt.getData('application/canvas-assetid') || undefined;
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  const plain = (dt.getData('text/plain') || '').trim();
  const url = [uri, plain].find((v) => !!v && /^(https?:\/\/|\/|data:audio\/)/i.test(v.trim()));
  if (!url && !assetId) return null;
  return { url: url?.trim(), assetId };
}

/** 拖放类型是否可能是音频（dragover 时只能看类型，看不到内容）。 */
export function dragMayCarryAudio(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes('Files') || types.includes('application/canvas-assetid') || types.includes('text/uri-list') || types.includes('text/plain');
}

/** 把拖进来的 URL / 素材 id 解析成可存的音频地址；不是音频时抛错。 */
export async function resolveDroppedAudioUrl(payload: Pick<DropPayload, 'url' | 'assetId'>): Promise<{ url: string; name?: string; assetId?: string }> {
  let url = payload.url || '';
  let name: string | undefined;
  if (payload.assetId) {
    const asset: any = await apiService.getAsset(payload.assetId).catch(() => null);
    if (asset) {
      url = url || String(asset.file_url || '');
      name = asset.name ? String(asset.name) : undefined;
    }
  }
  if (!url) throw new Error('没有读到素材地址');
  if (/^blob:/i.test(url)) throw new Error('临时地址无法保存，请先上传该音频');
  if (/^data:/i.test(url)) throw new Error('请直接上传音频文件');
  const stored = toStoredUrl(url);
  if (!looksLikeAudioUrl(stored)) {
    // 没有可识别的扩展名（或 C1 修复前素材库把 m4a 存成了 .png 的旧素材）：交给后端 ffprobe 判断
    const info = await probeMedia(stored);
    if (info.kind !== 'audio') throw new Error(info.kind === 'video' ? '这是视频素材，请拖到视频节点' : '请拖入音频素材');
  }
  return { url: stored, name, assetId: payload.assetId };
}
