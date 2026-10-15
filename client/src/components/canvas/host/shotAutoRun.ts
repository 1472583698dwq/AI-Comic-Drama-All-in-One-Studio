// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas D4：分镜「在画布中运行」建好子图后的自动运行：3D 导演规划 → 视频生成 → 回写分镜。
 *
 * 视频 url 以 execute 的返回值为准（host/executeRouter.ExecuteResult）——生成结果经 updateNodeData → setNodes 写入，
 * 宿主的 nodesRef 要等下一次渲染才更新，await 之后立刻读它拿到的是旧 data（原先因此必定提示「视频未自动产出」）。
 * 返回值缺 url 时才兜底：等一会儿再从画布读节点 data。只有真失败才提示错误。
 */
import type { ExecuteResult } from './executeRouter';

export interface ShotAutoRunDeps {
  execute: (nodeId: string, overrides?: Record<string, unknown>) => Promise<ExecuteResult | void>;
  /** 读节点当前 data（兜底用） */
  readNodeData: (nodeId: string) => Record<string, unknown> | undefined;
  writeBack: (opts: { shotId: string; field: 'video_url'; value: string }) => { ok: boolean; error?: string };
  notify: (level: 'success' | 'warning' | 'error', message: string) => void;
  /** 测试注入（缺省 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

export interface ShotAutoRunInput {
  shotId: string;
  shotIndex?: number | string;
  directorNodeId?: string;
  videoNodeId: string;
}

export type ShotAutoRunOutcome =
  | { status: 'written'; url: string }
  | { status: 'writeback-failed'; url: string; error?: string }
  | { status: 'generate-failed'; error: string }
  | { status: 'no-result' };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function autoRunShotSubgraph(input: ShotAutoRunInput, deps: ShotAutoRunDeps): Promise<ShotAutoRunOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  // 等子图渲染提交、宿主 nodesRef 能读到新节点
  await sleep(800);
  if (input.directorNodeId) {
    try { await deps.execute(input.directorNodeId); } catch (e) { (deps.warn ?? console.warn)('[Canvas] 3D 导演规划失败', e); }
    await sleep(400);
  }
  let url = '';
  try {
    const res = await deps.execute(input.videoNodeId);
    url = res && typeof res.url === 'string' ? res.url : '';
  } catch (e) {
    const error = String((e as Error)?.message || e || '生成失败');
    deps.notify('error', `视频生成失败：${error}（子图已建好，可在视频节点内重试）`);
    return { status: 'generate-failed', error };
  }
  if (!url) {
    await sleep(120);
    const v = deps.readNodeData(input.videoNodeId)?.video_url;
    url = typeof v === 'string' ? v : '';
  }
  if (!url) {
    deps.notify('warning', '视频生成没有返回结果，请在视频节点内重试（子图已建好）');
    return { status: 'no-result' };
  }
  const wb = deps.writeBack({ shotId: input.shotId, field: 'video_url', value: url });
  if (wb.ok) {
    deps.notify('success', `分镜 #${input.shotIndex ?? ''} 视频已生成并回写`);
    return { status: 'written', url };
  }
  deps.notify('warning', `视频已生成，回写分镜失败：${wb.error || '未知错误'}（可在节点右键「回写到分镜」手动回写）`);
  return { status: 'writeback-failed', url, error: wb.error };
}
