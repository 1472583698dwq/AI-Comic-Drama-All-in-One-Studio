import { useMemo } from 'react';
import { usePageStore } from '../stores/usePageStore';
import { useFeatureStore } from '../stores/useFeatureStore';
import { useUiPrefsStore } from '../stores/useUiPrefsStore';
import { allEntries, useRegistryVersion } from './registry';
import { DEFAULT_VARIANT, pageIdOfHost, variantOf, type UIEntry } from './types';

/**
 * 条目生效判定（《UI开关热插拔设计》§3.3）。
 *
 * 真相源不新造 —— 四类开关里本注册表只用三层（plugin 层由「条目是否被注册」表达）：
 *   scope 'page'    → usePageStore.values[switchId]（switchId = page id）
 *   scope 'feature' → useFeatureStore.values[switchId]
 *   scope 'prefs'   → useUiPrefsStore.values[switchId]
 * 缺省分支（设计 §3.3）：
 *   locked: true                → 短路，无视以上全部；
 *   switchId 不存在（迁移期）    → 常驻（已进注册表，后续绑开关零成本）；
 *   store 未加载完              → 不渲染（宿主显示占位，避免「默认全隐藏再逐个蹦出」）。
 */

export interface ResolveSnapshot {
  pagesLoaded: boolean;
  pages: Record<string, boolean>;
  featuresLoaded: boolean;
  features: Record<string, boolean>;
  prefs: Record<string, boolean>;
  /** pageId → 激活版本；缺项 = DEFAULT_VARIANT */
  variants: Record<string, string>;
}

/** 单条生效判定（纯函数，便于单测与复用） */
export function resolveEntryCore(entry: UIEntry, snap: ResolveSnapshot): boolean {
  if (entry.locked) return true;

  // 版本匹配：激活版本不同的条目一律不渲染（同 host 多版本天然互斥，不会双版本同屏）
  const pageId = pageIdOfHost(entry.host);
  if (pageId && variantOf(entry) !== (snap.variants[pageId] || DEFAULT_VARIANT)) return false;

  if (!entry.switchId) return true; // 迁移期常驻

  switch (entry.scope) {
    case 'feature':
      return snap.featuresLoaded ? snap.features[entry.switchId] === true : false;
    case 'prefs':
      return snap.prefs[entry.switchId] === true;
    case 'page':
    default:
      return snap.pagesLoaded ? snap.pages[entry.switchId] === true : false;
  }
}

/**
 * 版本选择：激活版本有条目就用它；否则回落保底版本并标记 fellBack（供 UI 提示一次）。
 *
 * 注意返回值**可能不止一条** —— `register` 只按 **id** 去重，两条 id 不同但 host+variant 相同的
 * 条目（如两个来源各登记一次同一页的同一版本）会一起返回。这种情况由**页面槽**兜住：只渲染
 * `order` 最小的一条（`allEntries` 已按 order 排序），并告警一次（`UISlot` 的
 * `warnDuplicatePageEntries`，审查 M6）。要真正互斥须在 `register` 里做 host+variant 唯一校验，
 * 那会改变插件动态注册的语义，留给「扩展点收敛」（未完成清单第 4 条）一起定。
 */
export function selectVariant(
  entries: UIEntry[],
  activeVariant: string,
): { entries: UIEntry[]; fellBack: boolean } {
  const hit = entries.filter((e) => variantOf(e) === activeVariant);
  if (hit.length > 0) return { entries: hit, fellBack: false };
  if (activeVariant === DEFAULT_VARIANT) return { entries: [], fellBack: false };
  // 激活版本没人提供（如插件提供的版本被停用）→ 回落保底版本，不落空白
  return { entries: entries.filter((e) => variantOf(e) === DEFAULT_VARIANT), fellBack: true };
}

/** 已激活版本无对应条目（回落保底发生）。UISlot 用它做一次 toast，避免同一页重复刷屏 */
const toastedFallback = new Set<string>();
export function markFallbackToast(pageId: string, activeVariant: string): boolean {
  const key = `${pageId}@${activeVariant}`;
  if (toastedFallback.has(key)) return false;
  toastedFallback.add(key);
  return true;
}

/**
 * 某挂载点下当前应渲染的条目：已按 order 排序（allEntries 保证）、版本匹配、开关放行。
 * 返回值引用稳定（useMemo），宿主可以直接 map。
 *
 * `loading` 是「开关未加载完」的**统一口径**（设计 §3.3 补充分支、§9.2 收进槽里）：
 *   · 页面槽（`page.<id>`）—— 准入依赖 pages 开关，未加载完一律算 loading；
 *   · 其它槽位 —— 只看槽内条目**实际依赖**的 store（当前只有 `scope: 'feature'` 会异步加载；
 *     prefs 是本地同步读取，永不 loading）。
 * 这样既不会让页面被无关的 feature 拉取拖住，也不会让 feature 条目先用默认值渲染出来。
 * `loading` 由 `UISlot` 渲染统一加载占位，宿主不必再自己判断 `pagesLoaded`。
 */
export function useResolvedSlot(host: string): { entries: UIEntry[]; fellBack: boolean; activeVariant: string; loading: boolean } {
  const version = useRegistryVersion();
  const pagesLoaded = usePageStore((s) => s.loaded);
  const pages = usePageStore((s) => s.values);
  const featuresLoaded = useFeatureStore((s) => s.loaded);
  const features = useFeatureStore((s) => s.values);
  const prefs = useUiPrefsStore((s) => s.values);
  const variants = useUiPrefsStore((s) => s.variants);
  // 注册表是外部可变 Map，条目增删不在 React 数据流里 —— 用 {version, list} 这个快照把
  // 「版本号」和「当时的条目列表」绑在一起，既让 memo 依赖真实成立，也避免每次渲染重排条目。
  const registry = useMemo(() => ({ version, list: allEntries() }), [version]);

  return useMemo(() => {
    const pageId = pageIdOfHost(host);
    const activeVariant = pageId ? variants[pageId] || DEFAULT_VARIANT : DEFAULT_VARIANT;

    const candidates = registry.list.filter((e) => e.host === host);
    const picked = pageId ? selectVariant(candidates, activeVariant) : { entries: candidates, fellBack: false };

    // 回落时把「生效版本」也改成保底版本再逐条判定：否则条目虽已按保底版本选出，
    // 却会在 resolveEntryCore 的版本匹配里被用户那条失效偏好（如已下线的插件版本）再拒一次，
    // 结果是槽位渲染空白 —— 正是「回落不许落白」要避免的情况。
    const effectiveVariants = picked.fellBack && pageId
      ? { ...variants, [pageId]: DEFAULT_VARIANT }
      : variants;
    const snap: ResolveSnapshot = { pagesLoaded, pages, featuresLoaded, features, prefs, variants: effectiveVariants };

    // 「未加载」统一口径：见上方函数注释。按**本次候选条目**实际依赖的 store 判定，
    // 而不是「任一 store 没加载就算 loading」—— 后者会让页面等一个与它无关的 feature 拉取。
    const needsFeatures = candidates.some((e) => !e.locked && e.scope === 'feature' && !!e.switchId);
    const loading = pageId ? !pagesLoaded : needsFeatures && !featuresLoaded;

    return {
      entries: picked.entries.filter((e) => resolveEntryCore(e, snap)),
      fellBack: picked.fellBack,
      activeVariant,
      loading,
    };
  }, [registry, host, pagesLoaded, pages, featuresLoaded, features, prefs, variants]);
}

/** 只需要条目列表时的便捷入口（`when(ctx)` 等数据驱动宿主用它；它们自带加载态，不看 `loading`） */
export function useUIEntries(host: string): UIEntry[] {
  return useResolvedSlot(host).entries;
}

/* ─────────────── 注册表视图 / 诊断面板用的「为什么没渲染」解释层 ─────────────── */

/** 条目当前状态：生效 / 锁定常驻 / 被哪一层开关拦下 / 非激活版本 / 开关还没加载 */
export type EntryState =
  | 'on' | 'locked' | 'off-page' | 'off-feature' | 'off-prefs' | 'variant' | 'loading';

/**
 * 与 `resolveEntryCore` **同源**的解释版本：判定顺序完全一致，只是把 boolean 换成原因。
 * 两份逻辑必须一起改 —— 所以这里刻意复用它已有的分支顺序（locked → 版本 → switchId → scope）。
 */
export function explainEntry(entry: UIEntry, snap: ResolveSnapshot): EntryState {
  if (entry.locked) return 'locked';

  const pageId = pageIdOfHost(entry.host);
  if (pageId && variantOf(entry) !== (snap.variants[pageId] || DEFAULT_VARIANT)) return 'variant';

  if (!entry.switchId) return 'on';

  switch (entry.scope) {
    case 'feature':
      return snap.featuresLoaded ? (snap.features[entry.switchId] === true ? 'on' : 'off-feature') : 'loading';
    case 'prefs':
      return snap.prefs[entry.switchId] === true ? 'on' : 'off-prefs';
    case 'page':
    default:
      return snap.pagesLoaded ? (snap.pages[entry.switchId] === true ? 'on' : 'off-page') : 'loading';
  }
}

/**
 * 注册表 + 三层开关快照（设置台的注册表视图 / 诊断面板消费）。
 * 只读，不改任何开关；返回的条目列表按 order 排序且引用稳定。
 */
export function useRegistryDiagnostics(): { entries: UIEntry[]; snap: ResolveSnapshot } {
  const version = useRegistryVersion();
  const pagesLoaded = usePageStore((s) => s.loaded);
  const pages = usePageStore((s) => s.values);
  const featuresLoaded = useFeatureStore((s) => s.loaded);
  const features = useFeatureStore((s) => s.values);
  const prefs = useUiPrefsStore((s) => s.values);
  const variants = useUiPrefsStore((s) => s.variants);

  const registry = useMemo(() => ({ version, list: allEntries() }), [version]);
  const snap: ResolveSnapshot = useMemo(
    () => ({ pagesLoaded, pages, featuresLoaded, features, prefs, variants }),
    [pagesLoaded, pages, featuresLoaded, features, prefs, variants],
  );

  return useMemo(() => ({ entries: registry.list, snap }), [registry, snap]);
}
