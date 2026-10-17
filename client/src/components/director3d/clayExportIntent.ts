/**
 * 白模导出意图（系统 Agent → 3D 片场 的跨页面交接）。
 *
 * `stage_export_clay` 是前端代理型工具：后端只返回"请求已受理"，真正的 WebGL/MediaRecorder
 * 录制只能在浏览器里的 3D 片场执行（见 Director3DStage.handleExportClay）。
 *
 * 断链场景：Agent 发起导出时用户还停在别的页面（Agent 页 / 分镜台），片场没挂载 → 事件无人接手 →
 * 后端以为成功、实际产物为零。修复方式：
 *   1. App 全局兜底监听 agent-stage-export-clay：片场已挂载（detail.__handled=true）时不动；
 *      未挂载则把请求存进这里并切到 3D 片场页；
 *   2. 片场挂载后 consume 这份意图并自动开录。
 */
export interface ClayExportIntent {
  shot_id?: string;
  shot_index?: number;
  project_id?: string;
  duration?: number;
  fps?: number;
}

let pending: ClayExportIntent | null = null;

export function stashClayExportIntent(detail: ClayExportIntent): void {
  pending = { ...(detail || {}) };
}

export function consumeClayExportIntent(): ClayExportIntent | null {
  const p = pending;
  pending = null;
  return p;
}
