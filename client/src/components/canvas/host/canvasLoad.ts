// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 画布加载 / 保存（纯函数）。
 *
 * 加载：`migrateCanvas(raw)`（T4，旧类型 / 具名口 → 新模型，幂等）→ 父在子前、悬空 parentId 清理 →
 *       运行态复位（视频节点保留 `_polling` / `_taskId`，节点自己恢复轮询，N3）→ 动态端口 / 生成源重算（N7）。
 *       `changed` 为真时宿主须在第一次保存前备份原始 JSON（mediaOps.backupCanvas）。
 * 保存：去掉函数 / 选中 / 拖动等纯 UI 态，带 `schema_version: 2`（后端 manager.save_canvas 保留该顶层键）。
 */
import type { Edge, Node } from '@xyflow/react';
import { CANVAS_SCHEMA_VERSION, migrateCanvas, type MigrateReport, type RawCanvas } from '../migrate';
import { GROUP_TYPE } from '../kit/graphOps';
import { recomputeDerivedInputs } from './propagation';

type AnyData = Record<string, any>;

export interface LoadedCanvas {
  nodes: Node[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number };
  /** 迁移改动了内容（须先备份原画布再保存） */
  changed: boolean;
  /** 原画布没有 schema_version（需要尽快保存一次落 v2） */
  needsSave: boolean;
  report: MigrateReport;
}

/** 运行中状态在页面重载后是幽灵态：复位为空闲，但视频节点保留任务 id 与轮询标记以便自动恢复（N3）。 */
export function resetRuntimeState(data: AnyData, type: string | undefined, now = new Date().toISOString()): AnyData {
  const st = data?.agent_state;
  if (!st || st.status !== 'running') return data;
  const tid = data._taskId || data._last_agent_plan?.task_id || '';
  // REQ-toonflow-canvas N3：视频任务在跑（_polling + _taskId）时原样保留，节点挂载后 useTaskRecovery 自动续轮询
  if (type === 'video' && tid && data._polling) return data;
  return {
    ...data,
    agent_state: {
      status: 'idle', tool: st.tool, provider_id: st.provider_id,
      error: tid ? `服务中断前任务状态未知，task_id=${tid} 已保留，可重新查询` : '服务中断前任务状态未知，已复位为空闲',
      updated_at: now,
    },
  };
}

/**
 * React Flow 要求父节点排在子节点之前；parentId 指向不存在的节点时去掉（位置原样，按顶层处理）。
 * 不改入参。
 */
export function normalizeParents<N extends Pick<Node, 'id' | 'parentId'>>(nodes: readonly N[]): N[] {
  const ids = new Set(nodes.map((n) => n.id));
  const fixed = nodes.map((n) => {
    if (!n.parentId || (ids.has(n.parentId) && n.parentId !== n.id)) return n;
    const out = { ...n };
    delete (out as Partial<Node>).parentId;
    delete (out as Partial<Node>).extent;
    return out;
  });
  const byId = new Map(fixed.map((n) => [n.id, n]));
  const out: N[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (n: N) => {
    if (placed.has(n.id)) return;
    if (visiting.has(n.id)) { // 环：断开
      const copy = { ...n };
      delete (copy as Partial<Node>).parentId;
      placed.add(n.id);
      out.push(copy);
      return;
    }
    visiting.add(n.id);
    const p = n.parentId ? byId.get(n.parentId) : undefined;
    if (p) visit(p);
    visiting.delete(n.id);
    if (!placed.has(n.id)) { placed.add(n.id); out.push(n); }
  };
  fixed.forEach(visit);
  return out;
}

/** 分组节点缺尺寸时补上（Agent / 旧数据可能只写了 style 或 width）。 */
function ensureGroupSize(n: Node): Node {
  if (n.type !== GROUP_TYPE) return n;
  const style = (n.style || {}) as AnyData;
  const w = Number(n.width ?? style.width) || 320;
  const h = Number(n.height ?? style.height) || 200;
  return { ...n, width: w, height: h, style: { ...style, width: w, height: h } };
}

export function prepareLoadedCanvas(raw: RawCanvas | null | undefined): LoadedCanvas {
  const { canvas, changed, report } = migrateCanvas(raw || { nodes: [], edges: [] });
  const now = new Date().toISOString();
  let nodes = (canvas.nodes || []).map((n: AnyData) => {
    const data = resetRuntimeState({ ...(n.data || {}) }, n.type, now);
    // selected / dragging 是纯 UI 态：落盘的 selected:true 重载时会复活选中（P2-2）；
    // measured 是上次（可能是旧节点组件）的实测尺寸，载入后由 React Flow 重新测量，不能拿旧值做布局
    const out: AnyData = { ...n, data, selected: false };
    delete out.dragging;
    delete out.measured;
    return ensureGroupSize(out as Node);
  }) as Node[];
  nodes = normalizeParents(nodes);
  const edges = ((canvas.edges || []) as AnyData[]).map((e) => ({ ...e, selected: false })) as Edge[];
  nodes = recomputeDerivedInputs(nodes, edges);
  const vp = canvas.viewport;
  const viewport = vp && Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.zoom) && vp.zoom > 0
    ? { x: vp.x, y: vp.y, zoom: vp.zoom }
    : undefined;
  const rawVersion = Number((raw as AnyData | null | undefined)?.schema_version) || 0;
  return { nodes, edges, viewport, changed, needsSave: rawVersion < CANVAS_SCHEMA_VERSION, report };
}

/** 去掉节点 data 里的函数（旧 onUpdate / onExecute 等运行时回调）。 */
function plainData(data: unknown): AnyData {
  const out: AnyData = {};
  for (const [k, v] of Object.entries((data || {}) as AnyData)) if (typeof v !== 'function') out[k] = v;
  return out;
}

/** 保存快照：schema_version 2 + 纯数据。 */
export function buildSaveSnapshot(
  nodes: readonly Node[],
  edges: readonly Edge[],
  viewport?: { x: number; y: number; zoom: number } | null,
): AnyData {
  return {
    nodes: nodes.map((n) => {
      const out: AnyData = { ...n, data: plainData(n.data), selected: false };
      delete out.dragging;
      delete out.resizing;
      return out;
    }),
    edges: edges.map((e) => {
      const out: AnyData = { ...e };
      delete out.selected;
      return out;
    }),
    viewport: viewport || undefined,
    schema_version: CANVAS_SCHEMA_VERSION,
    version: 2,
    updated_at: new Date().toISOString(),
  };
}

/**
 * REQ-toonflow-canvas H1：迁移备份闸门——每张画布（项目 + 画布 id）每次会话最多备份一次；
 * 保存前 `wait` 等备份结束（失败只告警，不阻塞保存）。
 */
export interface BackupGate {
  /** 迁移改动了内容时调用：第一次真正发起备份，之后同一画布不再备份。返回是否发起了备份。 */
  ensure: (projectId: string, canvasId: string, raw: unknown) => boolean;
  wait: (projectId: string | null | undefined, canvasId?: string) => Promise<void>;
  has: (projectId: string, canvasId: string) => boolean;
}

export function createBackupGate(
  backup: (projectId: string, canvasId: string, raw: Record<string, unknown>) => Promise<unknown>,
  log: Pick<Console, 'info' | 'warn'> = console,
): BackupGate {
  const pending = new Map<string, Promise<void>>();
  const key = (p: string | null | undefined, c?: string) => `${p || ''}::${c || 'default'}`;
  return {
    ensure(projectId, canvasId, raw) {
      const k = key(projectId, canvasId);
      if (!projectId || pending.has(k)) return false;
      pending.set(k, Promise.resolve()
        .then(() => backup(projectId, canvasId, (raw || {}) as Record<string, unknown>))
        .then(
          (r) => { log.info('[Canvas] 画布备份完成', (r as { path?: string } | undefined)?.path ?? ''); },
          (e) => { log.warn('[Canvas] 画布备份失败（仍会保存迁移结果）', e); },
        ));
      return true;
    },
    async wait(projectId, canvasId) {
      const p = pending.get(key(projectId, canvasId));
      if (p) await p;
    },
    has: (projectId, canvasId) => pending.has(key(projectId, canvasId)),
  };
}

/**
 * REQ-toonflow-canvas H1：迁移后的一次性去重叠。旧画布按旧卡片尺寸排的位置，换成 kit 节点后尺寸变了
 * （如 3D 导演内嵌舞台更高），常见上下相叠。只在「迁移改动了内容」的那次加载、全部节点测量完后调用：
 * 顶层非分组节点按 (y, x) 依次放置，与已放置节点相交（含 gap）就下移到其下方 + gap，只往下挪、不改 x。
 * 没有测量尺寸的节点不动。返回新数组（未移动的节点保持原引用）。
 */
export function resolveOverlaps<N extends Pick<Node, 'id' | 'type' | 'position' | 'parentId' | 'measured' | 'width' | 'height'>>(nodes: readonly N[], gap = 48): N[] {
  const sizeOf = (n: N) => ({ w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 });
  const movable = nodes.filter((n) => !n.parentId && n.type !== GROUP_TYPE && sizeOf(n).w > 0 && sizeOf(n).h > 0);
  const order = [...movable].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const moved = new Map<string, { x: number; y: number }>();
  for (const n of order) {
    const { w, h } = sizeOf(n);
    const r = { x: n.position.x, y: n.position.y, w, h };
    for (let guard = 0; guard < 500; guard++) {
      const hit = placed.find((p) => r.x < p.x + p.w + gap / 2 && r.x + r.w + gap / 2 > p.x && r.y < p.y + p.h + gap / 2 && r.y + r.h + gap / 2 > p.y);
      if (!hit) break;
      r.y = hit.y + hit.h + gap;
    }
    placed.push(r);
    if (r.y !== n.position.y) moved.set(n.id, { x: r.x, y: Math.round(r.y / 16) * 16 });
  }
  if (!moved.size) return nodes as N[];
  return nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n));
}
