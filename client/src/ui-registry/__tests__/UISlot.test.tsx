import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { UISlot } from '../UISlot';
import { register } from '../registry';
import { APP_HOST, pageHost, SHELL_HOST_LOADING, type UIEntry } from '../types';
import { useFeatureStore } from '../../stores/useFeatureStore';
import { usePageStore } from '../../stores/usePageStore';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';

/**
 * 槽位（宿主唯一入口）的验收项 —— 对应设计 §7 六项里可在 jsdom 覆盖的部分：
 *   · §7-2 开关一切换，界面立即变化（prefs 层，同步生效）；
 *   · §7-4 锁定条目在所有开关全关时仍渲染（最小形态兜底）；
 *   · §7-5 单条 render 抛错只替换该条，宿主与其他条目不受影响、开关不被自动关闭；
 *   · §9.2 加载态渲染统一占位且**不被宿主的 fallback 覆盖**；已加载无条目才落 fallback；
 *   · L6 加载占位的自引用护栏；M6 同 host 同版本多条的取舍与告警；§2.4.1-6 版本回落不落白。
 *
 * 不可在 jsdom 覆盖的（留给后端 pytest / 浏览器冒烟）：关页后接口 404、SSE 真实推送链路。
 */

const undos: Array<() => void> = [];
afterEach(() => {
  // 先卸载再反注册：否则注册表变更会触发「已卸载/待卸载」组件的订阅更新，
  // React 会警告「update not wrapped in act」（噪声，不是失败）
  cleanup();
  act(() => { undos.splice(0).forEach((fn) => fn()); });
});

const add = (e: UIEntry) => { undos.push(register(e)); };
const base = (extra: Partial<UIEntry>): UIEntry => ({
  kind: 'panel', host: 'test.host', order: 10, source: 'builtin', render: () => null, ...extra,
} as UIEntry);

/** 让界面语言固定中文（新 toast / 壳条目文案都用它） */
const zhOnly = () => useUiPrefsStore.setState({ lang: 'zh' });

describe('§7-2 开关一切换，槽内条目即时挂载 / 卸载', () => {
  it('prefs 层：开 → 渲染，关 → 立即移除（不刷新页面）', () => {
    zhOnly();
    useUiPrefsStore.setState({ values: { tip_context: true } });
    add(base({ id: 'test.prefs', host: 'test.prefs.host', scope: 'prefs', switchId: 'tip_context', render: () => <div>PREFS-ON</div> }));

    render(<UISlot host="test.prefs.host" />);
    expect(screen.getByText('PREFS-ON')).toBeTruthy();

    act(() => { useUiPrefsStore.setState({ values: { tip_context: false } }); });
    expect(screen.queryByText('PREFS-ON')).toBeNull();
  });
});

describe('§9.2 加载占位 vs fallback（两种「空」分得清）', () => {
  it('开关未加载完 → 渲染统一加载占位（锁定壳条目），**不落宿主 fallback**', () => {
    zhOnly();
    usePageStore.setState({ loaded: false, values: {} });
    add(base({ id: 'test.loading-shell', host: SHELL_HOST_LOADING, locked: true, render: () => <div>LOADING-SHELL</div> }));

    render(<UISlot host={pageHost('home')} fallback={<div>EMPTY-FALLBACK</div>} />);
    expect(screen.getByText('LOADING-SHELL')).toBeTruthy();
    expect(screen.queryByText('EMPTY-FALLBACK')).toBeNull();
  });

  it('已加载但槽内无生效条目 → 才落到宿主的 fallback', () => {
    zhOnly();
    usePageStore.setState({ loaded: true, values: { home: false } });
    useUiPrefsStore.setState({ variants: {} });

    render(<UISlot host={pageHost('home')} fallback={<div>EMPTY-FALLBACK</div>} />);
    expect(screen.getByText('EMPTY-FALLBACK')).toBeTruthy();
  });
});

describe('§7-4 锁定条目：所有开关全关时仍渲染（最小形态兜底）', () => {
  it('page / feature / prefs 全关，locked 条目照常渲染', () => {
    zhOnly();
    usePageStore.setState({ loaded: true, values: {} });
    useFeatureStore.setState({ loaded: true, values: {} });
    useUiPrefsStore.setState({ values: {} });
    add(base({ id: 'test.locked', host: 'test.locked.host', locked: true, render: () => <div>LOCKED-ALWAYS</div> }));

    render(<UISlot host="test.locked.host" />);
    expect(screen.getByText('LOCKED-ALWAYS')).toBeTruthy();
  });
});

describe('§7-5 逐条错误隔离', () => {
  it('一条 render 抛错 → 只该条显示占位，同槽的另一条正常渲染', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* 静音 React 的崩溃日志 */ });
    const Boom = () => { throw new Error('boom-测试'); };
    add(base({ id: 'test.boom', host: 'test.iso.host', order: 10, render: Boom }));
    add(base({ id: 'test.ok', host: 'test.iso.host', order: 20, render: () => <div>OK-ENTRY</div> }));

    render(<UISlot host="test.iso.host" />);
    expect(screen.getByText('OK-ENTRY')).toBeTruthy();               // 宿主与其它条目不受影响
    expect(document.body.textContent).toContain('test.boom加载失败'); // 崩溃条显示可读占位（name = entry.id）
    expect(document.body.textContent).toContain('boom-测试');
    errSpy.mockRestore();
  });
});

describe('L6 加载占位的自引用护栏', () => {
  it('往 shell.loading 混入非 locked 条目 + feature 未加载时，不再自我递归（渲染出真实条目）', () => {
    zhOnly();
    // 非 locked 且依赖 feature 的条目 → 让该槽的 loading 判定为 true（修复前会在加载分支里无限递归）
    add(base({ id: 'test.guard', host: SHELL_HOST_LOADING, order: 99, scope: 'feature', switchId: 'agent_teams', render: () => <div>GUARD-ENTRY</div> }));
    add(base({ id: 'test.guard-shell', host: SHELL_HOST_LOADING, order: 1, locked: true, render: () => <div>LOADING-SHELL</div> }));
    useFeatureStore.setState({ loaded: false, values: {} });

    render(<UISlot host={SHELL_HOST_LOADING} />);
    expect(screen.getByText('LOADING-SHELL')).toBeTruthy();          // 护栏拦下加载分支 → 走真实条目
    expect(screen.queryByText('GUARD-ENTRY')).toBeNull();            // feature 未加载 → 该条不渲染（fail-closed）
  });
});

describe('M6 同 host 同版本多条：取 order 最小者并告警', () => {
  it('只渲染 order 最小的一条，并对冲突告警一次（不再静默丢弃）', async () => {
    zhOnly();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 只断言被调用 */ });
    const host = pageHost('t6');
    usePageStore.setState({ loaded: true, values: { t6: true } });
    useUiPrefsStore.setState({ variants: {} });
    add(base({ id: 'page.t6@default', host, kind: 'page', order: 10, variant: 'default', scope: 'page', switchId: 't6', render: () => <div>FIRST</div> }));
    add(base({ id: 'page.t6@default.dup', host, kind: 'page', order: 20, variant: 'default', scope: 'page', switchId: 't6', render: () => <div>SECOND</div> }));

    render(<UISlot host={host} />);
    expect(screen.getByText('FIRST')).toBeTruthy();
    expect(screen.queryByText('SECOND')).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.some((c) => String(c[0]).includes('t6'))).toBe(true);
    warn.mockRestore();
  });
});

describe('M3 覆盖层宿主（app / main.tips）不加槽位包裹层', () => {
  it('app 宿主：条目直接渲染，槽位不套一层（避免描边退化成游离细线）', () => {
    add(base({ id: 'test.overlay', host: APP_HOST, render: () => <div>OVERLAY</div> }));
    render(<UISlot host={APP_HOST} />);
    const root = screen.getByText('OVERLAY');
    expect(root.parentElement?.hasAttribute('data-ui-mark')).toBe(false);
  });

  it('普通宿主（settings.panels）仍由槽位自动标注 —— 免得误伤「免配置生效」的那批', () => {
    add(base({ id: 'test.panel', host: 'settings.panels', render: () => <div>PANEL</div> }));
    render(<UISlot host="settings.panels" />);
    const root = screen.getByText('PANEL');
    expect(root.parentElement?.getAttribute('data-ui-mark')).toBe('test.panel');
  });
});

describe('§2.4.1-6 版本回落不落白', () => {
  it('激活版本没有条目 → 回落保底版本渲染 + 提示一次（不落空白）', () => {
    zhOnly();
    const host = pageHost('t7');
    usePageStore.setState({ loaded: true, values: { t7: true } });
    useUiPrefsStore.setState({ values: {}, variants: { t7: 'ghost' } });
    add(base({ id: 'page.t7@default', host, kind: 'page', order: 10, variant: 'default', scope: 'page', switchId: 't7', render: () => <div>FALLBACK-RENDERED</div> }));

    render(<UISlot host={host} />);
    expect(screen.getByText('FALLBACK-RENDERED')).toBeTruthy();
  });
});

describe('§9.2 页面布局声明（STAGE_HOSTS → 条目上的 layout）', () => {
  it('条目声明 layout → 由它包住 render 的输出', () => {
    usePageStore.setState({ loaded: true, values: { t9: true } });
    useUiPrefsStore.setState({ variants: {} });
    const host = pageHost('t9');
    const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <div data-testid="stage-layout">{children}</div>
    );
    add(base({
      id: 'page.t9@default', host, kind: 'page', order: 10, variant: 'default',
      scope: 'page', switchId: 't9', layout: Layout, render: () => <div>STAGE-INNER</div>,
    }));

    render(<UISlot host={host} />);
    expect(screen.getByTestId('stage-layout').textContent).toBe('STAGE-INNER');
  });

  it('缺省无 layout → 不额外包一层（页面自带满屏布局）', () => {
    usePageStore.setState({ loaded: true, values: { t10: true } });
    useUiPrefsStore.setState({ variants: {} });
    const host = pageHost('t10');
    add(base({
      id: 'page.t10@default', host, kind: 'page', order: 10, variant: 'default',
      scope: 'page', switchId: 't10', render: () => <div>PLAIN-PAGE</div>,
    }));

    render(<UISlot host={host} />);
    const inner = screen.getByText('PLAIN-PAGE');
    expect(inner.parentElement?.hasAttribute('data-ui-mark')).toBe(false);
  });

  it('studio ↔ timeline 共用 render + layout：换页不重建页内实例（state 保持）', () => {
    usePageStore.setState({ loaded: true, values: { s1: true, s2: true } });
    useUiPrefsStore.setState({ variants: {} });
    let mounts = 0;
    const Stage: React.FC = () => {
      const [n] = React.useState(() => { mounts += 1; return mounts; });
      return <div>STAGE-{n}</div>;
    };
    const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => <div>{children}</div>;
    const entry = (pageId: string, order: number) => base({
      id: `page.${pageId}@default`, host: pageHost(pageId), kind: 'page', order,
      variant: 'default', scope: 'page', switchId: pageId, layout: Layout, render: Stage,
    });
    add(entry('s1', 10));
    add(entry('s2', 20));

    const { rerender } = render(<UISlot host={pageHost('s1')} />);
    expect(screen.getByText('STAGE-1')).toBeTruthy();
    rerender(<UISlot host={pageHost('s2')} />);
    expect(screen.getByText('STAGE-1')).toBeTruthy(); // 同一实例：初始 state 仍在
    expect(mounts).toBe(1);                           // 没有第二次挂载
  });
});
