// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 独有节点换皮 A —— 非组件的小工具（单独成文件，保证组件文件可热更新）。
 */
import type { SyntheticEvent } from 'react';
import type { RefItem } from '../../kit';

export const stopProp = (e: SyntheticEvent) => e.stopPropagation();

/** 卡片里的可交互区：不拖动节点、不平移画布、滚轮不缩放（React Flow 的 nodrag / nopan / nowheel）。 */
export const NO_CANVAS = 'nodrag nopan nowheel';

/** 卡片内交互区还要拦截双击：否则会触发 NodeSkeleton 的「双击聚焦」把画布缩放过去。 */
export const interactiveGuards = { onDoubleClick: stopProp };

/** 节点 data 缺省时的稳定空对象（避免每次渲染都是新对象，使依赖它的 memo 失效）。 */
export const EMPTY_DATA: Readonly<Record<string, unknown>> = Object.freeze({});

/** 能直接当 <img src> 用的值（绝对 / 站内相对 / data / blob URL）；ComfyUI 的输入文件名（如 ref.png）不是。 */
export function isUrlLike(v: unknown): v is string {
  return typeof v === 'string' && /^(https?:|data:|blob:|\/)/.test(v);
}

/** 错误统一取 message。 */
export function errorMessage(e: unknown, fallback = '操作失败'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : fallback;
}

// —— comfy-workflow：暴露输入（inspectWorkflow 的 exposed_inputs）——

/** inspectWorkflow 返回的暴露输入（后端 auto_detect_exposed_inputs / 用户白名单）。 */
export interface ExposedInput {
  id?: string;
  node_id?: string | number;
  param_name?: string;
  label?: string;
  type?: string;
  default_value?: unknown;
  description?: string;
  options?: unknown[];
  choices?: unknown[];
}

/** 暴露输入在 dynamic_inputs 里的键：id 优先，其次 node_id（同旧组件）。 */
export const exposedKey = (e: ExposedInput): string => String(e.id || e.node_id || '');

/** 暴露输入的默认值：只补 dynamic_inputs 里还没有（== null）的键（旧组件 inspect 后的合并口径）。 */
export function exposedDefaults(exposed: readonly ExposedInput[], current: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of exposed) {
    const k = exposedKey(e);
    if (k && e.default_value !== undefined && current[k] == null) out[k] = e.default_value;
  }
  return out;
}

// —— timeline：上游自动入列 ——

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 时间线待入列的上游素材：旧宿主写进 data 的单值（`_upstream.video_url|video` / `data.video_url`，音频同理）
 * + 入边上游节点的当前产出（kit buildRefs 读到的 VIDEO / AUDIO 参考）。按 `kind:url` 去重、保持顺序。
 */
export function upstreamMedia(
  d: { _upstream?: unknown; video_url?: unknown; audio_url?: unknown },
  refs: readonly RefItem[],
): Array<{ kind: 'video' | 'audio'; url: string }> {
  const up = (d._upstream || {}) as Record<string, unknown>;
  const out: Array<{ kind: 'video' | 'audio'; url: string }> = [];
  const seen = new Set<string>();
  const push = (kind: 'video' | 'audio', url: string) => {
    if (!url || seen.has(`${kind}:${url}`)) return;
    seen.add(`${kind}:${url}`);
    out.push({ kind, url });
  };
  push('video', str(up.video_url) || str(up.video) || str(d.video_url));
  push('audio', str(up.audio_url) || str(up.audio) || str(d.audio_url));
  for (const r of refs) {
    if (r.dataType === 'VIDEO') push('video', r.value);
    else if (r.dataType === 'AUDIO') push('audio', r.value);
  }
  return out;
}

// —— export：全局意图事件 ——

/** App.tsx 监听的全局意图事件（→ modalIntents.openExport 打开 ExportModal）。 */
export const OPEN_EXPORT_MODAL_EVENT = 'open-export-modal';
/** App.tsx 监听的全局意图事件（→ modalIntents.openWorkflowInspector 打开工作流槽位配置）。 */
export const OPEN_WORKFLOW_INSPECTOR_EVENT = 'open-workflow-inspector';

export function openExportModal() {
  window.dispatchEvent(new CustomEvent(OPEN_EXPORT_MODAL_EVENT));
}

export function openWorkflowInspector(workflowId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_WORKFLOW_INSPECTOR_EVENT, { detail: { workflowId } }));
}
