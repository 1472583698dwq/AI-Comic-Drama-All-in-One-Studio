// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片上传与落盘。
 *
 * 上传：沿用 MiniMax 画布现有通道里能拿到可访问 URL 的那条 —— 素材库 `POST /assets`（CanvasResourcePickerModal 的
 * 降级路径、3D 片场导出同款），返回 `/storage/assets/<id>/original.<ext>`。旧 LoadImageNode 用的
 * `/images/comfyui/upload` 只把文件传进 ComfyUI 的 input 目录、返回 ComfyUI 内部文件名，浏览器和生成源都取不到，
 * 这里不再使用。宿主（H1）可用 setImageUploader 换成别的通道。
 *
 * 落盘：浏览器端合成的 PNG（局部重绘贴回原图）走 mediaOps.gridSplit(dataURL, 1, 1)——1×1 切分即「按 PNG 原样保存」，
 * 产物在 storage/generated/media_ops/，不进素材库。
 */
import { apiService } from '../../../../services/api';
import { gridSplit } from '../../../../services/mediaOps';

export interface UploadContext {
  nodeId: string;
  projectId?: string;
}

export interface UploadResult {
  url: string;
  /** 走素材库上传时的素材 id（宿主「保存到素材库」可据此去重）。 */
  assetId?: string;
}

export type ImageUploader = (file: File, ctx: UploadContext) => Promise<UploadResult>;

/** 缺省：上传进当前项目素材库（category=other，标签 canvas），取 file_url。 */
export const assetLibraryUploader: ImageUploader = async (file, ctx) => {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('name', file.name.replace(/\.[^/.]+$/, '') || '画布图片');
  fd.append('category', 'other');
  fd.append('tags', JSON.stringify(['canvas']));
  fd.append('scope', 'project');
  if (ctx.projectId) fd.append('project_id', ctx.projectId);
  const res: any = await apiService.createAsset(fd);
  const asset = res?.asset ?? res;
  const url = asset?.file_url || asset?.thumb_url || asset?.url;
  if (!url) throw new Error('上传未返回图片地址');
  return { url: String(url), assetId: asset?.id ? String(asset.id) : undefined };
};

let uploader: ImageUploader = assetLibraryUploader;

/** 宿主替换上传通道（传 null 恢复缺省）。 */
export function setImageUploader(fn: ImageUploader | null): void {
  uploader = fn ?? assetLibraryUploader;
}

export function uploadImageFile(file: File, ctx: UploadContext): Promise<UploadResult> {
  return uploader(file, ctx);
}

/** 把浏览器端生成的 PNG dataURL 落盘，返回 /storage/... 地址。 */
export async function persistDataUrl(dataUrl: string): Promise<string> {
  const res = await gridSplit(dataUrl, 1, 1);
  const url = res?.images?.[0]?.url || res?.urls?.[0];
  if (!url) throw new Error('保存图片失败：未返回地址');
  return url;
}
