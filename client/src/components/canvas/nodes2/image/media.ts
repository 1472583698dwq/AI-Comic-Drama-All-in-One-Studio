// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片 / 图片生成节点的素材读写与尺寸（纯函数）。
 *
 * - 读值：与下游一致，走 kit 的 readOutputValue（端口 `image` → image_url → result_url …）；
 * - 写值：load-image 三键同写（image / url / image_url，readOutputValue 先读端口同名键 `image`），
 *   图片生成写 image_url + result_url（MiniMax 执行器同款）；
 * - 尺寸：Toonflow 媒体节点按图片宽高比算宽（高 240，卡片外扩 18 = padding 8×2 + border 1×2）。
 */
import { readOutputValue } from '../../kit/references';
import { API_ORIGIN } from '../../../../utils/devOrigin';

/** Toonflow imageNode / imageGenerationNode：预览高 240。 */
export const MEDIA_HEIGHT = 240;
/** 卡片内边距 8×2 + 边框 1×2。 */
export const CARD_EXTRA = 18;
/** 超宽 / 超窄图的展示宽度夹取（Toonflow 不夹，这里防止 10:1 长图把节点拉到上千像素）。 */
export const MIN_MEDIA_WIDTH = 100;
export const MAX_MEDIA_WIDTH = 720;
/** Toonflow：单张图片不能为空且不超过 100 MB。 */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export interface NaturalSize {
  width: number;
  height: number;
}

/** 图片节点宽度 = 240 × 宽高比 + 18（未加载出尺寸时返回 undefined，用 NodeDef 默认宽）。 */
export function mediaNodeWidth(size?: NaturalSize | null): number | undefined {
  if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
  const w = (MEDIA_HEIGHT * size.width) / size.height;
  return Math.round(Math.min(MAX_MEDIA_WIDTH, Math.max(MIN_MEDIA_WIDTH, w)) + CARD_EXTRA);
}

/** 节点当前图片（与下游拿到的值一致）。 */
export function imageUrlOf(type: string, data: Record<string, unknown> | null | undefined): string {
  return readOutputValue({ type, data: data || {} }, 'image', 'IMAGE');
}

/** load-image 写图补丁：三键同写，避免旧 `image` / `url` 键遮住新值。 */
export function loadImagePatch(url: string): Record<string, unknown> {
  return { image_url: url, image: url, url };
}

/** 图片生成写当前版本：image_url + result_url；旧数据若有 `image` 键一并改，避免下游读到旧图。 */
export function genImagePatch(url: string, data?: Record<string, unknown> | null): Record<string, unknown> {
  const patch: Record<string, unknown> = { image_url: url, result_url: url };
  if (data && typeof data.image === 'string') patch.image = url;
  if (data && typeof data.url === 'string') patch.url = url;
  return patch;
}

/** 本机后端绝对地址（dev 回源 / 素材库拖拽带的 http://127.0.0.1:8001/storage/…）→ 存储相对路径；其余原样。 */
export function normalizeMediaUrl(u: string | null | undefined): string {
  const s = (u || '').trim();
  if (!s) return '';
  if (API_ORIGIN && s.startsWith(API_ORIGIN)) {
    const rest = s.slice(API_ORIGIN.length);
    if (/^\/(storage|exports)\//.test(rest)) return rest;
  }
  const m = s.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/(?:storage|exports)\/.*)$/i);
  return m ? m[1] : s;
}

/** 下载文件名。 */
export function fileNameOf(u: string | null | undefined, fallback = 'image.png'): string {
  const s = (u || '').trim();
  if (!s || s.startsWith('data:')) return fallback;
  const clean = s.split(/[?#]/)[0];
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|tiff?)(?:$|[?#])/i;

/** 是否像图片地址（拖入的纯文本 URL 过滤用）。 */
export function looksLikeImageUrl(u: string): boolean {
  const s = u.trim();
  if (/^data:image\//i.test(s)) return true;
  if (!/^(https?:\/\/|\/storage\/|\/exports\/|blob:)/i.test(s)) return false;
  return IMAGE_EXT_RE.test(s) || /^\/(storage|exports)\//.test(normalizeMediaUrl(s));
}

/** Toonflow 同款校验：必须是图片、非空、≤100MB。返回错误文案或 null。 */
export function validateImageFile(file: File | null | undefined): string | null {
  if (!file) return '请选择图片文件';
  if (!(file.type || '').startsWith('image/') && !IMAGE_EXT_RE.test(file.name)) return '请选择图片文件';
  if (!file.size || file.size > MAX_IMAGE_BYTES) return '图片不能为空且不能超过 100 MB';
  return null;
}

/** 从拖拽数据里取图片：素材库条目（application/canvas-assetid + text/plain URL）或 URL 文本。 */
export function imageUrlFromDrop(dt: Pick<DataTransfer, 'getData'>): string {
  const assetId = dt.getData('application/canvas-assetid');
  const category = dt.getData('application/asset-category');
  const kind = dt.getData('application/canvas-assetkind');
  if (kind === 'text' || category === 'text') return '';
  const raw = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  if (!raw) return '';
  if (assetId) return normalizeMediaUrl(raw);
  return looksLikeImageUrl(raw) ? normalizeMediaUrl(raw) : '';
}

/** 拖拽中是否可能是图片（dragover 阶段只能看 types）。 */
export function dragMayCarryImage(dt: Pick<DataTransfer, 'types'>): boolean {
  const types = Array.from(dt.types || []);
  return types.includes('Files') || types.includes('application/canvas-assetid') || types.includes('text/uri-list') || types.includes('text/plain');
}
