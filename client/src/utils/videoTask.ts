/**
 * 视频任务轮询统一工具 —— 状态协议单点收敛为 {status, task_id, video_url, error}。
 *
 * 背景：此前多处前端各写一遍轮询兜底（video_url/videoUrl/results[0]/url 口径不一）：
 * NodeAgentConsole / VideoNode / ShotCardNode / nodeAgentExecutor，现全部引用本模块。
 */
import { apiService } from '../services/api';

/** 终态失败集合（含取消/超时） */
const TERMINAL_FAIL = new Set(['FAILED', 'FAIL', 'ERROR', 'TIMEOUT', 'CANCELLED', 'CANCELED']);

/** 归一状态字符串（兼容 status / state 两种字段名） */
export function normalizeTaskStatus(st: any): string {
  return (st?.status || st?.state || '').toString().toUpperCase();
}

/** 从状态响应提取视频 URL（兼容 video_url / videoUrl / results[0] / url 四种落点） */
export function extractVideoUrl(st: any): string {
  const first = Array.isArray(st?.results) ? st.results[0] : '';
  const u = st?.video_url || st?.videoUrl || first?.url || (typeof first === 'string' ? first : '') || st?.url;
  return u || '';
}

export interface PollVideoTaskOptions {
  /** 轮询间隔，默认 3s */
  intervalMs?: number;
  /** 最大轮询次数，默认 500（约 25 分钟） */
  maxAttempts?: number;
}

/**
 * 轮询视频任务直到终态。
 * 成功：返回视频 URL；终态失败 / 排队超时：抛错（task_id 是否落盘恢复由调用方负责）。
 * 状态接口网络抖动不误杀任务，继续下一拍。
 */
export async function pollVideoTask(taskId: string, opts: PollVideoTaskOptions = {}): Promise<string> {
  const interval = opts.intervalMs ?? 3000;
  const max = opts.maxAttempts ?? 500;
  for (let i = 0; i < max; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, interval)); // 首拍立即查询，避免任务其实已完成还白等一个周期
    let st: any;
    try {
      st = await apiService.getVideoTaskStatus(taskId);
    } catch {
      continue; // 状态接口网络抖动：继续轮询，不误杀任务
    }
    const s = normalizeTaskStatus(st);
    if (s === 'SUCCESS' || s === 'COMPLETED') {
      const url = extractVideoUrl(st);
      if (url) return url;
      continue; // 状态已成功但 URL 未就绪，等下一拍
    }
    if (TERMINAL_FAIL.has(s)) {
      throw new Error(st?.error || st?.msg || st?.last_error || '视频任务失败');
    }
  }
  throw new Error(`视频排队超时 task_id=${taskId}，task_id 已保留，可恢复查询`);
}
