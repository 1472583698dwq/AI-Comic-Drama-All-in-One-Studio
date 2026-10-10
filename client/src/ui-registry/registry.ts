import { useSyncExternalStore } from 'react';
import type { UIEntry, UISource } from './types';

/**
 * 前端 UI 注册表（《UI开关热插拔设计》§3.2）。
 *
 * 沿用项目既有注册表范式（`components/storyboard/slots/registry.ts` 的 Map + 排序 + unregister），
 * 差异只有两点，都是为了「热插拔」：
 *   1. 同 id 重复注册 = **替换**（兼容 React 严格模式双调用与热重载，不产生重复条目）；
 *   2. 有版本号 + 订阅，供 `useSyncExternalStore` 在条目动态增删时驱动宿主重渲染。
 *
 * 注册期校验（设计 §5.4-2）：`locked` 与 `switchId` 互斥——标了 locked 又绑开关是自相矛盾条目
 * （要么永远显示、要么可关），这里以 locked 为准并告警，绝不悄悄产生「既锁定又可关」的条目。
 */

const entries = new Map<string, UIEntry>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => { try { l(); } catch { /* 单个订阅者出错不影响其他 */ } });
}

/** 注册表版本号（每次增删自增）；配合 `useRegistryVersion` 触发宿主重渲染 */
export const registryVersion = (): number => version;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 订阅注册表变化（条目动态增删时宿主需要重渲染） */
export const useRegistryVersion = (): number =>
  useSyncExternalStore(subscribe, registryVersion, registryVersion);

/** 注册/替换一个条目；返回反注册函数（只反注册「仍是自己」的那条，避免误删后来者） */
export function register(entry: UIEntry): () => void {
  if (!entry || typeof entry.id !== 'string' || !entry.id) {
    console.error('[ui-registry] 条目缺少 id，已忽略', entry);
    return () => {};
  }
  if (!entry.host || typeof entry.host !== 'string') {
    console.error(`[ui-registry] 条目 ${entry.id} 缺少 host，已忽略`);
    return () => {};
  }
  if (typeof entry.render !== 'function') {
    console.error(`[ui-registry] 条目 ${entry.id} 缺少 render，已忽略`);
    return () => {};
  }
  if (entry.locked && entry.switchId) {
    console.error(`[ui-registry] 条目 ${entry.id} 既标 locked 又绑 switchId(${entry.switchId})，按 locked 处理`);
    entry = { ...entry, switchId: undefined };
  }
  entries.set(entry.id, entry);
  emit();
  return () => {
    if (entries.get(entry.id) === entry) {
      entries.delete(entry.id);
      emit();
    }
  };
}

/**
 * 按来源批量反注册（与后端插件 disable/uninstall 的「精确回滚」对称，设计 §3.2-1 / §6.4）。
 * 当前调用方（未完成清单第 9 条已接线）：分镜槽 `components/storyboard/slots/loader.ts` 与
 * §12 桥接的三个扩展点适配器 —— `adapters/exporterEntries.ts` / `canvasPalette.ts` /
 * `directorPackEntries.ts` 的 `clearXxx()`，按 `plugin:<域>` 一次清干净，不再逐条记 undo 账。
 *
 * `hostPrefix`（审查 L8）：**限定作用域**，只删 host 以该前缀开头的条目。分镜槽 loader 传
 * `SLOT_HOST_PREFIX`，三个桥接适配器各传自己登记的挂载点前缀 —— 于是「按来源回滚」只作用
 * 于调用方自己登记的挂载点，否则将来任何以同一个 `plugin:<id>` 作来源注册条目的模块，
 * 都会被别人的重载顺手清掉。
 */
export function unregisterSource(source: UISource, hostPrefix?: string): void {
  let removed = false;
  entries.forEach((entry, id) => {
    if (entry.source !== source) return;
    if (hostPrefix && !String(entry.host).startsWith(hostPrefix)) return;
    entries.delete(id);
    removed = true;
  });
  if (removed) emit();
}

/** 全部条目（按 order 排序的副本；调用方不得依赖其稳定性，需自行 useMemo） */
export function allEntries(): UIEntry[] {
  return [...entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
