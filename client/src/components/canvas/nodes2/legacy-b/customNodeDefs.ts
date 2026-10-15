// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 自定义代码节点（custom）定义缓存。
 *
 * 端口要同步可读：注册表 `getPorts(data)`、宿主 `isValidConnection` / 传播都只拿得到节点 data，
 * 所以 input_schema 必须放在模块级缓存里（同 ext-node 的 `canvasNodeSpecs` 注册表）。
 * 节点组件挂载时拉列表 / 单个定义并注册；宿主也可在刷新自定义节点列表时 `registerCustomNodeDefs(list)`。
 * 旧 CustomNode 组件内的 defCache 与 nodeAgentExecutor 的 _customDefCache 是两份各自的缓存，这里不复用它们。
 */
import { apiService } from '../../../../services/api';

export interface CustomNodeDefinition {
  id: string;
  name?: string;
  kind?: string;
  language?: string;
  description?: string;
  enabled?: boolean;
  input_schema?: { properties?: Record<string, any>; required?: string[]; [k: string]: unknown };
  params_schema?: Record<string, any>;
  default_params?: Record<string, unknown>;
  [k: string]: unknown;
}

const defs = new Map<string, CustomNodeDefinition>();
let version = 0;
const listeners = new Set<() => void>();
let listPromise: Promise<CustomNodeDefinition[]> | null = null;
const pending = new Map<string, Promise<CustomNodeDefinition | null>>();

function emit() {
  version++;
  listeners.forEach((fn) => fn());
}

export function registerCustomNodeDef(def: CustomNodeDefinition | null | undefined): void {
  if (!def?.id) return;
  defs.set(def.id, def);
  emit();
}

/** 整体登记一份列表（宿主 refreshCustomNodes 拿到列表后可直接调用）。 */
export function registerCustomNodeDefs(list: readonly CustomNodeDefinition[] | null | undefined): void {
  let changed = false;
  for (const d of list || []) {
    if (d?.id) {
      defs.set(d.id, d);
      changed = true;
    }
  }
  if (changed) emit();
}

export function getCustomNodeDef(id: unknown): CustomNodeDefinition | undefined {
  return typeof id === 'string' && id ? defs.get(id) : undefined;
}

export function clearCustomNodeDefs(): void {
  defs.clear();
  listPromise = null;
  pending.clear();
  emit();
}

/** 缓存版本号：每次登记 +1（组件据此重算端口）。 */
export function customNodeDefsVersion(): number {
  return version;
}

export function subscribeCustomNodeDefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 拉自定义节点列表并登记（同一时刻只发一次请求）。
 * 功能开关 `canvas_custom_nodes` 关闭时后端整族 404 → reject，调用方据此提示。
 */
export function loadCustomNodeList(opts: { refresh?: boolean } = {}): Promise<CustomNodeDefinition[]> {
  if (opts.refresh) listPromise = null;
  if (!listPromise) {
    listPromise = apiService
      .listCustomNodes()
      .then((res: any) => {
        const list: CustomNodeDefinition[] = Array.isArray(res?.nodes) ? res.nodes : [];
        registerCustomNodeDefs(list);
        return list;
      })
      .catch((e) => {
        listPromise = null;
        throw e;
      });
  }
  return listPromise;
}

/** 单个定义：缓存优先，没有就拉详情并登记；失败返回 null。 */
export function loadCustomNodeDef(id: string): Promise<CustomNodeDefinition | null> {
  const hit = getCustomNodeDef(id);
  if (hit) return Promise.resolve(hit);
  if (!id) return Promise.resolve(null);
  let p = pending.get(id);
  if (!p) {
    p = apiService
      .getCustomNode(id)
      .then((res: any) => {
        const got: CustomNodeDefinition | null = res?.node || res || null;
        if (got?.id) registerCustomNodeDef(got);
        return got?.id ? got : null;
      })
      .catch(() => null)
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}
