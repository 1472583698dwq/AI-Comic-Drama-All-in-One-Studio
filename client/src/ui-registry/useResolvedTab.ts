import { usePageStore, resolveTab } from '../stores/usePageStore';
import { useProjectStore } from '../stores/useProjectStore';
import { globalPageIds, isGlobalPage } from './pageTabs';

/**
 * 「当前归一页签」的唯一实现（审查 L7）。
 *
 * 归一规则（与 `App.tsx` 改造前的口径逐条一致）：
 *   · 开关未加载完 / 启动恢复中（有缓存项目正在拉取）→ `null`，绝不先闪一个未开启的页；
 *   · 请求页可用 → 就是它；已关闭 / 未知 / 历史页签 → 第一个可用页（`resolveTab`）；
 *   · 无项目时再叠既有准入：只能落在全局页（`pageTabs.globalPageIds()`），一个都不可用 → `null`；
 *   · 一个可用页都没有（config 不算，见 `firstEnabledPageId`）→ `null`（调用方渲染全关空态页）。
 *
 * 为什么必须共用：`entries/panels.tsx` 的引导卡 / 悬浮抽屉曾各自读**原始 `activeTab`**
 * 并自称「与 App 同口径」，结果缓存的 `activeTab === 'canvas'` 但该页已被关掉时，
 * 会在开关加载完之前先挂上卡片、归一后立刻卸载 —— 启动瞬间闪一下不该出现的界面。
 *
 * 每次渲染现算（几次数组成员判断，成本可忽略）：`resolveTab` 读的是 store 快照，
 * 用 memo 反而要靠「假装存在的依赖」才能重算。
 */
export function useResolvedTab(): string | null {
  const pagesLoaded = usePageStore((s) => s.loaded);
  // 只订阅、不取值：resolvedTab 是渲染期现算的，需要一个订阅来源让「页面开关一变」触发重渲染
  // （App 侧原先用 `pagesValues` 兼作归一提示的文案来源，这里只借它的订阅语义）。
  usePageStore((s) => s.values);
  const activeTab = useProjectStore((s) => s.activeTab);
  const project = useProjectStore((s) => s.project);
  const isLoading = useProjectStore((s) => s.isLoading);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const restoring = isLoading && !project && !!activeProjectId;
  if (!pagesLoaded || restoring) return null;

  const hit = resolveTab(activeTab);
  if (!project && hit && !isGlobalPage(hit)) {
    for (const g of globalPageIds()) {
      const r = resolveTab(g);
      if (r && isGlobalPage(r)) return r;
    }
    return null;
  }
  return hit;
}
