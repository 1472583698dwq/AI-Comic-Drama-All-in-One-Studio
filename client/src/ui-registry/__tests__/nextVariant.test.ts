import { describe, expect, it } from 'vitest';
// 副作用导入：注册页面条目（含 next 变体）
import '../entries/pages';
import { NEXT_VARIANT } from '../entries/variants';
import { allEntries } from '../registry';
import { DEFAULT_VARIANT } from '../types';

/**
 * 逐页接入的**重构新版**（设计 §2.4.1）：`entries/pages.tsx` 的 `PageImpl.nextView`。
 *
 * 约定：填了 `nextView` 的页，`next` 变体直接渲染真实实现；没填的仍是「待接入」占位。
 * 这条断言保证「接入状态」与注册表一致 —— 面板里列的版本、实际渲染的组件同源。
 */
describe('§2.4.1 next 变体：逐页接入', () => {
  const entryOf = (pageId: string, variant: string) =>
    allEntries().find((e) => e.id === `page.${pageId}@${variant}`);

  it('已接入的页（projects）渲染真实新版，不再走占位', () => {
    const projectsNext = entryOf('projects', NEXT_VARIANT)!;
    expect(projectsNext).toBeTruthy();
    expect(String(projectsNext.render.displayName)).toBe('NextProjectsPage');
    // 保底实现不受影响：同页两个变体是两个不同组件
    expect(entryOf('projects', DEFAULT_VARIANT)!.render).not.toBe(projectsNext.render);
  });

  it('未接入的页仍是「待接入」占位', () => {
    const homeNext = entryOf('home', NEXT_VARIANT)!;
    expect(homeNext).toBeTruthy();
    expect(String(homeNext.render.displayName)).toContain('PageVariantPlaceholder');
  });

  it('每个页面都有 default / next 两个变体（切换链路对每一页都成立）', () => {
    const pageIds = allEntries()
      .filter((e) => e.variant === DEFAULT_VARIANT && e.host.startsWith('page.'))
      .map((e) => e.host.slice('page.'.length));
    expect(pageIds.length).toBeGreaterThan(0);
    pageIds.forEach((pid) => {
      expect(entryOf(pid, DEFAULT_VARIANT), `${pid}@default`).toBeTruthy();
      expect(entryOf(pid, NEXT_VARIANT), `${pid}@next`).toBeTruthy();
    });
  });
});
