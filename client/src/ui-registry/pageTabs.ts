import { allEntries, registryVersion } from './registry';
import { DEFAULT_VARIANT, pageIdOfHost, variantOf } from './types';

/**
 * **页签归一的共用真源**（设计 §9.2 / 未完成清单第 15 条：页签归一进注册表）。
 *
 * 归一前 `GLOBAL_TABS`（全局页 id）与 `LEGACY_TAB_LABEL`（已下线页签展示名）是
 * `stores/usePageStore.ts` 里的两张硬编码表，与「页面清单」这份真相（`entries/pages.tsx`
 * 的条目）各活一份 —— 加一页 / 下线一页都要记着改表，漏改就诞生两套口径。
 *
 * 现在两张表都由**页面条目自带**、本模块从注册表读回：
 *   · `meta.global === true`（保底版本条目）→ 无项目时仍可停留的全局页；
 *   · `variant: 'retired'` + `meta.label`  → 已下线页签的展示名。
 *
 * 读取结果按**注册表版本号**缓存：`Sidebar` 会在渲染期逐项判断，不能每次都全表排序。
 * 注册表尚未登记时读到的空结果不会被永久缓存 —— 版本号一变就会重算。
 */

let cachedVersion = -1;
let globalIds: string[] = [];
let legacyLabels: Record<string, string> = {};

function refresh(): void {
  const v = registryVersion();
  if (v === cachedVersion) return;
  const globals: string[] = [];
  const labels: Record<string, string> = {};
  for (const e of allEntries()) {
    const pid = pageIdOfHost(e.host);
    if (!pid) continue;
    const meta = (e.meta || {}) as { global?: boolean; retired?: boolean; label?: string };
    if (meta.retired) {
      if (meta.label) labels[pid] = String(meta.label);
      continue;
    }
    if (variantOf(e) === DEFAULT_VARIANT && meta.global === true) globals.push(pid);
  }
  cachedVersion = v;
  globalIds = globals;
  legacyLabels = labels;
}

/** 无项目时仍可停留的**全局页** id（原 `stores/usePageStore.ts` 的 `GLOBAL_TABS`） */
export function globalPageIds(): readonly string[] {
  refresh();
  return globalIds;
}

/** 该页是否全局页（无项目也可停留） */
export function isGlobalPage(id: string): boolean {
  return globalPageIds().includes(id);
}

/** 已下线页签的展示名（原 `stores/usePageStore.ts` 的 `LEGACY_TAB_LABEL`）；查不到返回 undefined */
export function legacyTabLabel(id: string): string | undefined {
  refresh();
  return legacyLabels[id];
}
