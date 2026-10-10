import { describe, expect, it } from 'vitest';
import { explainEntry, resolveEntryCore, selectVariant, type ResolveSnapshot } from '../resolveEnabled';
import { DEFAULT_VARIANT, pageHost, type UIEntry } from '../types';

/**
 * 开关放行判定（设计 §3.3）的纯函数回归：
 * locked 短路 → 版本匹配 → switchId 缺省常驻 → 按 scope 路由（page / feature / prefs）。
 * 这层是「开关一变界面就变」的判定核心，也是最容易被后续改动悄悄弄坏的地方。
 */

const snap = (p: Partial<ResolveSnapshot> = {}): ResolveSnapshot => ({
  pagesLoaded: true,
  pages: {},
  featuresLoaded: true,
  features: {},
  prefs: {},
  variants: {},
  ...p,
});

const e = (extra: Partial<UIEntry> = {}): UIEntry => ({
  id: 'test.entry', kind: 'panel', host: 'test.host', order: 10, render: () => null, ...extra,
});

describe('resolveEntryCore（单条放行）', () => {
  it('locked 短路：无视 scope / switchId，即使对应开关是关的也渲染', () => {
    expect(resolveEntryCore(e({ locked: true, scope: 'page', switchId: 'home' }), snap({ pages: { home: false } }))).toBe(true);
    expect(resolveEntryCore(e({ locked: true, scope: 'feature', switchId: 'agent_teams' }), snap({ featuresLoaded: false }))).toBe(true);
  });

  it('switchId 缺省 = 迁移期常驻（已进注册表但还没绑开关）', () => {
    expect(resolveEntryCore(e(), snap())).toBe(true);
  });

  it('scope: page —— store 未加载一律不放行（fail-closed），加载后按值', () => {
    expect(resolveEntryCore(e({ scope: 'page', switchId: 'home' }), snap({ pagesLoaded: false, pages: { home: true } }))).toBe(false);
    expect(resolveEntryCore(e({ scope: 'page', switchId: 'home' }), snap({ pages: { home: true } }))).toBe(true);
    expect(resolveEntryCore(e({ scope: 'page', switchId: 'home' }), snap({ pages: { home: false } }))).toBe(false);
  });

  it('scope: feature —— 未加载视为关（与后端「出厂全关」一致）', () => {
    expect(resolveEntryCore(e({ scope: 'feature', switchId: 'agent_teams' }), snap({ featuresLoaded: false, features: { agent_teams: true } }))).toBe(false);
    expect(resolveEntryCore(e({ scope: 'feature', switchId: 'agent_teams' }), snap({ features: { agent_teams: true } }))).toBe(true);
  });

  it('scope: prefs —— 本机同步读取，永不 loading', () => {
    expect(resolveEntryCore(e({ scope: 'prefs', switchId: 'tip_context' }), snap({ prefs: { tip_context: true } }))).toBe(true);
    expect(resolveEntryCore(e({ scope: 'prefs', switchId: 'tip_context' }), snap({ prefs: {} }))).toBe(false);
  });

  it('页面版本不匹配的条目不渲染（同 host 多版本天然互斥）', () => {
    const host = pageHost('home');
    const next = e({ host, variant: 'next', scope: 'page', switchId: 'home' });
    expect(resolveEntryCore(next, snap({ pages: { home: true } }))).toBe(false);
    expect(resolveEntryCore(next, snap({ pages: { home: true }, variants: { home: 'next' } }))).toBe(true);
    const fallback = e({ host, variant: DEFAULT_VARIANT, scope: 'page', switchId: 'home' });
    expect(resolveEntryCore(fallback, snap({ pages: { home: true }, variants: { home: 'next' } }))).toBe(false);
  });
});

describe('selectVariant（版本选择 / 回落不落白）', () => {
  const host = pageHost('home');
  const def = e({ id: 'page.home@default', host, variant: 'default' });
  const nx = e({ id: 'page.home@next', host, variant: 'next' });

  it('激活版本有条目 → 用它', () => {
    const r = selectVariant([def, nx], 'next');
    expect(r.entries.map((x) => x.id)).toEqual(['page.home@next']);
    expect(r.fellBack).toBe(false);
  });

  it('激活版本没人提供（如插件版本被停用）→ 回落保底并标记 fellBack', () => {
    const r = selectVariant([def], 'ghost');
    expect(r.entries.map((x) => x.id)).toEqual(['page.home@default']);
    expect(r.fellBack).toBe(true);
  });

  it('激活的就是保底版本且有条目 → 直接命中（不标记回落）', () => {
    const r = selectVariant([def, nx], DEFAULT_VARIANT);
    expect(r.entries.map((x) => x.id)).toEqual(['page.home@default']);
    expect(r.fellBack).toBe(false);
  });

  it('保底版本也没条目 → 返回空（宿主落到 fallback），不谎报回落', () => {
    const r = selectVariant([], DEFAULT_VARIANT);
    expect(r.entries).toHaveLength(0);
    expect(r.fellBack).toBe(false);
  });

  it('M6：同 host 同 variant 的多条会「一起返回」，由页面槽取 order 最小者兜住', () => {
    const dup = e({ id: 'page.home@default.dup', host, variant: 'default', order: 20 });
    const r = selectVariant([def, dup], DEFAULT_VARIANT);
    expect(r.entries).toHaveLength(2);
  });
});

describe('explainEntry（注册表视图的「为什么没渲染」）', () => {
  it('与 resolveEntryCore 同源：locked / 版本 / 未加载 / 各层关', () => {
    expect(explainEntry(e({ locked: true }), snap())).toBe('locked');
    expect(explainEntry(e({ host: pageHost('home'), variant: 'next' }), snap())).toBe('variant');
    expect(explainEntry(e({ scope: 'page', switchId: 'home' }), snap({ pagesLoaded: false }))).toBe('loading');
    expect(explainEntry(e({ scope: 'page', switchId: 'home' }), snap({ pages: { home: false } }))).toBe('off-page');
    expect(explainEntry(e({ scope: 'feature', switchId: 'agent_teams' }), snap({ featuresLoaded: false }))).toBe('loading');
    expect(explainEntry(e({ scope: 'feature', switchId: 'agent_teams' }), snap())).toBe('off-feature');
    expect(explainEntry(e({ scope: 'prefs', switchId: 'tip_context' }), snap())).toBe('off-prefs');
    expect(explainEntry(e({ scope: 'prefs', switchId: 'tip_context' }), snap({ prefs: { tip_context: true } }))).toBe('on');
    expect(explainEntry(e(), snap())).toBe('on');
  });
});
