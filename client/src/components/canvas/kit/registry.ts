// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 节点注册表（design §3）。
 * 画布的 nodeTypes、工具栏、拖线菜单（按端口类型过滤）全部从这里生成。
 * 纯模块级 Map：同 type 重复 defineNode 直接覆盖（HMR 安全，幂等）。
 */
import type { NodeTypes } from '@xyflow/react';
import type { AnyNodeDef, DataType, PortDef } from './types';
import { isTypeCompatible, resolvePorts } from './connection';

export { resolvePorts };

const defs = new Map<string, AnyNodeDef>();
let version = 0;
/** nodeTypesMap 的缓存：按兜底组件（无兜底 = undefined）分别记，注册表版本变了才重建。 */
const cachedTypes = new Map<unknown, { version: number; map: NodeTypes }>();
const listeners = new Set<() => void>();

/** 注册（或覆盖）节点定义；返回同一个 def 方便 `export const X = defineNode({...})`。 */
export function defineNode<T extends AnyNodeDef>(def: T): T {
  if (!def?.type) throw new Error('defineNode: type 不能为空');
  const prev = defs.get(def.type);
  if (prev === def) return def;
  defs.set(def.type, def);
  version++;
  listeners.forEach((fn) => fn());
  return def;
}

/** 仅测试/HMR 用：移除某个定义。 */
export function undefineNode(type: string): void {
  if (defs.delete(type)) {
    version++;
    listeners.forEach((fn) => fn());
  }
}

export function getNodeDef(type?: string | null): AnyNodeDef | undefined {
  return type ? defs.get(type) : undefined;
}

export function allNodeDefs(): AnyNodeDef[] {
  return [...defs.values()];
}

/** 出现在工具栏的节点（inPalette 缺省 true）。 */
export function paletteDefs(): AnyNodeDef[] {
  return allNodeDefs().filter((d) => d.inPalette !== false);
}

/** 注册表版本号：每次 define/undefine +1，可作为 useMemo 依赖。 */
export function registryVersion(): number {
  return version;
}

/** 订阅注册表变化（useSyncExternalStore 友好）。 */
export function subscribeRegistry(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 普通对象自带的键（toString / constructor / then 之类）不当作节点类型，避免兜底组件冒充它们。 */
function isTypeKey(key: string | symbol): key is string {
  return typeof key === 'string' && key !== 'then' && key !== 'toJSON' && key !== '$$typeof' && !(key in Object.prototype);
}

/**
 * type → component 映射，直接传给 `<ReactFlow nodeTypes>`。
 * 注册表不变时返回同一个对象引用，避免 React Flow 的 nodeTypes 变更告警（error002）与节点重挂载。
 *
 * REQ-toonflow-canvas FX-2：传 `fallback` 时，不认识的类型（旧画布 / 未启用插件的节点）读到的是 fallback 组件
 * （`default` 也是它）。原来宿主按「画布里出现了哪些未知类型」拼一份新对象，未知类型一变（Agent 改画布、
 * 旧画布迁移前后）nodeTypes 就换引用、React Flow 报 error002。现在用只读代理按需兜底：对象只随注册表版本变化；
 * Object.keys 仍只有已注册类型 + default。按 fallback 分别缓存（宿主只用一个兜底组件）。
 */
export function nodeTypesMap(fallback?: NodeTypes[string]): NodeTypes {
  const hit = cachedTypes.get(fallback);
  if (hit && hit.version === version) return hit.map;
  const map: NodeTypes = {};
  for (const d of defs.values()) map[d.type] = d.component;
  let out = map;
  if (fallback) {
    if (!Object.prototype.hasOwnProperty.call(map, 'default')) map.default = fallback;
    out = new Proxy(map, {
      get(target, key, receiver) {
        if (isTypeKey(key) && !Object.prototype.hasOwnProperty.call(target, key)) return fallback;
        return Reflect.get(target, key, receiver);
      },
    });
  }
  cachedTypes.set(fallback, { version, map: out });
  return out;
}

/** 在 def 上找第一个能与 dataType 相连的端口（side = 该端口自身的方向）。 */
export function findCompatiblePort(def: AnyNodeDef, dataType: DataType | DataType[], side: PortDef['type']): PortDef | undefined {
  return def.ports.find((p) => p.type === side && (side === 'target' ? isTypeCompatible(dataType, p.dataType) : isTypeCompatible(p.dataType, dataType)));
}

/** 从某个 source 端口拖线到空白处：列出能接收该类型的节点（只含 palette 节点）。 */
export function defsAcceptingFrom(dataType: DataType | DataType[]): AnyNodeDef[] {
  return paletteDefs().filter((d) => !!findCompatiblePort(d, dataType, 'target'));
}

/** 从某个 target 端口反向拖线到空白处：列出能提供该类型的节点（只含 palette 节点）。 */
export function defsProvidingTo(dataType: DataType | DataType[]): AnyNodeDef[] {
  return paletteDefs().filter((d) => !!findCompatiblePort(d, dataType, 'source'));
}

/**
 * 新建节点的默认 data：defaultData() + label。
 * K1：只在 defaultData 没有 `label` 键（含 `label: ''`）且 def 不是 computedLabel 时才写 NodeDef.label。
 */
export function createNodeData(type: string): Record<string, unknown> {
  const def = getNodeDef(type);
  if (!def) return {};
  const data: Record<string, unknown> = { ...(def.defaultData?.() || {}) };
  if (!def.computedLabel && !Object.prototype.hasOwnProperty.call(data, 'label')) return { label: def.label, ...data };
  return data;
}
