import { describe, expect, it } from 'vitest';
// 副作用导入：注册页面条目（真源）
import '../entries/pages';
import { globalPageIds, isGlobalPage, legacyTabLabel } from '../pageTabs';
import { allEntries } from '../registry';
import { RETIRED_VARIANT } from '../types';

/**
 * 页签归一进注册表（设计 §9.2 / 未完成清单第 15 条）：
 * 原 `GLOBAL_TABS` / `LEGACY_TAB_LABEL` 两张硬编码表已删除，真相改为页面条目自带 ——
 * `meta.global`（全局页）与 `variant: 'retired'` 条目（已下线页签展示名）。
 */
describe('§9.2 页签归一的真源 = 页面条目', () => {
  it('全局页来自页面条目的 meta.global（原 GLOBAL_TABS）', () => {
    expect([...globalPageIds()].sort()).toEqual(['config', 'home', 'projects']);
    expect(isGlobalPage('home')).toBe(true);
    expect(isGlobalPage('config')).toBe(true);
    expect(isGlobalPage('studio')).toBe(false);
    expect(isGlobalPage('nope')).toBe(false);
  });

  it('已下线页签展示名来自 variant:"retired" 条目（原 LEGACY_TAB_LABEL）', () => {
    expect(legacyTabLabel('mcp')).toBe('MCP 工具');
    expect(legacyTabLabel('studio')).toBeUndefined();
    expect(legacyTabLabel('nope')).toBeUndefined();
  });

  it('retired 条目只作元数据：带上 label 与占位 render，且不参与版本选择', () => {
    const retired = allEntries().filter((e) => e.variant === RETIRED_VARIANT);
    expect(retired.map((e) => e.id)).toEqual(['page.mcp@retired']);
    expect(retired[0].meta).toEqual({ retired: true, label: 'MCP 工具' });
    // 激活版本只能是 default/next，故该条目永不被页面槽选中
    expect(retired[0].variant).not.toBe('default');
  });
});
