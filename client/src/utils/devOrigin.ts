/**
 * 开发环境源点工具 —— 前端唯一的端口/回源判断出口。
 *
 * 背景：此前 `window.location.port === '5173'` 的判断散布 15+ 文件，
 * dev 端口一换（如 5199）API/WS/媒体回源全线失效。现收敛到本模块，
 * 端口判断放宽为 51xx 段（vite 默认 5173 被占用时换任意 51xx 均可用）。
 */

/** 是否本地 dev 前端（vite，51xx 端口段） */
export const isDev: boolean =
  typeof window !== 'undefined' && /^51\d\d$/.test(window.location.port);

/** 后端 API 源：dev 直连本机 8000；生产走同源反代（空串前缀） */
export const API_ORIGIN: string = isDev ? 'http://127.0.0.1:8000' : '';

/** REST API 基址 */
export const API_BASE_URL: string = isDev ? `${API_ORIGIN}/api/v1` : '/api/v1';

/**
 * 相对产物 URL（/storage、/assets 等）在 dev 下必须回源到后端，
 * 否则 Vite 直接 404，节点/素材库黑盒无法回显；存值保持原样，仅展示拼接。
 */
export function resolveMediaUrl(u?: string | null): string {
  if (!u || typeof u !== 'string') return '';
  if (/^(https?:\/\/|data:|blob:)/.test(u)) return u;
  if (isDev && u.startsWith('/')) return `${API_ORIGIN}${u}`;
  return u;
}
