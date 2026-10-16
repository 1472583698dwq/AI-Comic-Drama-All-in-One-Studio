/**
 * REQ-toonflow-canvas 画布素材处理 / 画布备份 客户端。
 *
 * 后端：`server/app/api/media_ops_routes.py`（/media/ops/*）与
 * `server/app/api/project_routes.py`（/projects/{id}/canvases/{cid}/backup）。
 * 所有产物 URL 都是 `/storage/generated/media_ops/...` 形式的存储相对地址：
 * 直接写进节点 data（image_url / video_url / audio_url），展示时用 `resolveMediaUrl` 回源。
 *
 * 入参 URL 可以是 `/storage/...`、指回本机后端的 http(s)、外网 http(s)（后端先下载）或 data: URI。
 * 失败时抛 `MediaOpsError`：`status` 为 HTTP 状态（400 参数 / 404 素材缺失 / 422 素材不可处理 /
 * 429 并发已满 / 500 处理异常 / 503 ffmpeg 或 Pillow 未就绪），`message` 是可直接展示的中文原因。
 */
import { API_BASE_URL } from '../utils/devOrigin';

export type AudioFormat = 'm4a' | 'wav' | 'mp3';
/** 截帧位置：`current` 与 `time` 等价（都要带 time 秒数） */
export type FrameAt = 'first' | 'last' | 'time' | 'current';

export class MediaOpsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'MediaOpsError';
    this.status = status;
  }
}

export interface MediaOpsEngine {
  ffmpeg: boolean;
  ffprobe: boolean;
  pillow: boolean;
  ffmpeg_hint: string;
}

export interface ProbeResult {
  status: 'success';
  kind: 'video' | 'audio' | 'image';
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
  has_video: boolean;
  size_bytes: number;
}

export interface ImageResult {
  status: 'success';
  url: string;
  kind: 'image';
  width: number;
  height: number;
}

export interface FrameResult extends ImageResult {
  /** 实际取帧方式（time 落在结尾时会回退成 last） */
  at: 'first' | 'last' | 'time';
  /** 实际取帧时间（秒） */
  time: number;
}

export interface AudioResult {
  url: string;
  kind: 'audio';
  duration: number;
  size_bytes: number;
}

export interface VideoResult {
  url: string;
  kind: 'video';
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
  size_bytes: number;
}

export type ExtractAudioResult = AudioResult & { status: 'success' };

export interface SplitAvResult {
  status: 'success';
  /** 无声视频（MP4） */
  video_url: string;
  audio_url: string;
  video: VideoResult;
  audio: AudioResult;
}

export type TrimResult = (AudioResult | VideoResult) & { status: 'success'; start: number; end: number };

export type SpeedResult = AudioResult & { status: 'success'; rate: number };

export interface GridTile {
  url: string;
  /** 行优先序号（从 0 开始） */
  index: number;
  row: number;
  col: number;
  width: number;
  height: number;
}

export interface GridSplitResult {
  status: 'success';
  rows: number;
  cols: number;
  images: GridTile[];
  urls: string[];
}

export interface ComposeMaskResult extends ImageResult {
  /** 二值遮罩（白=重绘区、黑=保留），给支持真遮罩的生成源用 */
  mask_url: string;
  /** 标记面积占比 0–1 */
  mask_ratio: number;
}

export interface CanvasBackupResult {
  status: 'success';
  /** 相对 storage 根的路径：projects/{pid}/canvas_backups/{cid}-{yyyyMMdd-HHmmss}.json */
  path: string;
  url: string | null;
  file: string;
  canvas_id: string;
  source: 'stored' | 'payload';
  /** ISO 时间（本地时区，秒精度） */
  created_at: string;
}

function errorMessage(status: number, body: any): string {
  const detail = body?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) return detail.map((d: any) => d?.msg || JSON.stringify(d)).join('; ');
  return `请求失败 (HTTP ${status})`;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init || {};
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    ...(json !== undefined
      ? { method: rest.method || 'POST', headers: { 'Content-Type': 'application/json', ...(rest.headers || {}) }, body: JSON.stringify(json) }
      : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new MediaOpsError(errorMessage(res.status, body), res.status);
  return body as T;
}

const post = <T>(path: string, json: Record<string, unknown>) => request<T>(path, { method: 'POST', json });

/** 引擎自检：ffmpeg / ffprobe / Pillow 是否就绪（按钮置灰与安装提示用） */
export function mediaOpsEngine(): Promise<MediaOpsEngine> {
  return request<MediaOpsEngine>('/media/ops/engine');
}

/** 探测素材：类型、时长、宽高、是否有音轨 */
export function probeMedia(url: string): Promise<ProbeResult> {
  return request<ProbeResult>(`/media/ops/probe?url=${encodeURIComponent(url)}`);
}

/** 截帧 → PNG。at=time/current 时必须给 time（秒）；播放头在结尾时后端自动取末帧 */
export function extractFrame(videoUrl: string, at: FrameAt = 'first', time?: number): Promise<FrameResult> {
  return post<FrameResult>('/media/ops/frame', { video_url: videoUrl, at, ...(time !== undefined ? { time } : {}) });
}

/** 提取音轨 → 音频（默认 m4a） */
export function extractAudio(videoUrl: string, format?: AudioFormat): Promise<ExtractAudioResult> {
  return post<ExtractAudioResult>('/media/ops/extract-audio', { video_url: videoUrl, ...(format ? { format } : {}) });
}

/** 音画分离 → { video_url（无声）, audio_url } */
export function splitAv(videoUrl: string, format?: AudioFormat): Promise<SplitAvResult> {
  return post<SplitAvResult>('/media/ops/split-av', { video_url: videoUrl, ...(format ? { format } : {}) });
}

/** 截取 [start, end) 秒 → 同类型媒体（视频固定 mp4；音频可指定 format，缺省 wav 保持 wav、其余 m4a） */
export function trimMedia(url: string, start: number, end: number, format?: AudioFormat): Promise<TrimResult> {
  return post<TrimResult>('/media/ops/trim', { url, start, end, ...(format ? { format } : {}) });
}

/** 音频变速（保持音高），rate ∈ [0.5, 2] */
export function speedAudio(audioUrl: string, rate: number, format?: AudioFormat): Promise<SpeedResult> {
  return post<SpeedResult>('/media/ops/speed', { audio_url: audioUrl, rate, ...(format ? { format } : {}) });
}

/** 宫格切分 rows×cols（各 1–6）→ 行优先排列的图片列表 */
export function gridSplit(imageUrl: string, rows: number, cols: number): Promise<GridSplitResult> {
  return post<GridSplitResult>('/media/ops/grid-split', { image_url: imageUrl, rows, cols });
}

/**
 * 局部重绘标记：把遮罩（PNG base64 或 dataURL，透明底上涂抹的区域即标记区；尺寸可与原图不同，后端会拉伸）
 * 叠到原图上 → 带半透明色块 + 描边的参考图；同时返回二值遮罩 mask_url。
 */
export function composeMask(
  imageUrl: string,
  maskPng: string,
  opts?: { opacity?: number; color?: string },
): Promise<ComposeMaskResult> {
  return post<ComposeMaskResult>('/media/ops/compose-mask', {
    image_url: imageUrl,
    mask_png: maskPng,
    ...(opts?.opacity !== undefined ? { opacity: opts.opacity } : {}),
    ...(opts?.color ? { color: opts.color } : {}),
  });
}

/**
 * 画布备份：不传 canvas 时备份后端当前已存的画布；传 canvas 时备份这份原始 JSON
 * （迁移前的 raw 画布，第一次保存前调用）。
 */
export function backupCanvas(projectId: string, canvasId: string, canvas?: Record<string, unknown>): Promise<CanvasBackupResult> {
  return post<CanvasBackupResult>(
    `/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/backup`,
    canvas ? { canvas } : {},
  );
}

export const mediaOps = {
  engine: mediaOpsEngine,
  probeMedia,
  extractFrame,
  extractAudio,
  splitAv,
  trimMedia,
  speedAudio,
  gridSplit,
  composeMask,
  backupCanvas,
};
