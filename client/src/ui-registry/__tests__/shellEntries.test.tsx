import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// 副作用导入：登记 6 条锁定壳条目（设计 §5.2 的最小形态）
import '../entries/shell';
import { allEntries } from '../registry';
import { UISlot } from '../UISlot';
import { pageHost, SHELL_HOST_EMPTY, SHELL_HOST_LOADING, SHELL_HOST_SIDEBAR, SHELL_HOST_TOP } from '../types';
import { usePageStore } from '../../stores/usePageStore';
import { useFeatureStore } from '../../stores/useFeatureStore';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';

/**
 * 最小形态（设计 §5.2）在注册表里的**落地形态** —— 这是未完成清单第 13 条点名的两项间接覆盖之一：
 * 「`shell.loading` 加载占位实测中一闪而过，未单独断言」。这里把它与「6 条锁定壳都登记在册且
 * 不绑开关」一起变成可复跑断言。
 *
 * 另一项（应用根容器 / 页面错误边界）本就是 `App.tsx` 的不变量骨架、不是注册表条目，
 * jsdom 下不做假条目冒充（见设计 §5.2 的落地形态说明）。
 */

const SHELL_IDS = [
  'shell.header', 'shell.banner.api', 'shell.banner.mcp',
  'shell.sidebar', 'shell.loading', 'shell.empty',
];

afterEach(() => { cleanup(); });

describe('§5.2 最小形态：锁定壳条目', () => {
  it('6 条壳条目都在注册表里：locked 且不绑 switchId（注册期校验通过）', () => {
    const hits = allEntries().filter((e) => SHELL_IDS.includes(e.id));
    expect(hits.map((e) => e.id).sort()).toEqual([...SHELL_IDS].sort());
    expect(hits.every((e) => e.locked === true)).toBe(true);
    expect(hits.every((e) => !e.switchId)).toBe(true);
  });

  it('壳条目分别落在 4 个壳挂载点（顶栏含两条横幅 / 侧栏 / 加载 / 空态）', () => {
    const hostOf = (id: string) => allEntries().find((e) => e.id === id)!.host;
    expect(hostOf('shell.header')).toBe(SHELL_HOST_TOP);
    expect(hostOf('shell.banner.api')).toBe(SHELL_HOST_TOP);
    expect(hostOf('shell.banner.mcp')).toBe(SHELL_HOST_TOP);
    expect(hostOf('shell.sidebar')).toBe(SHELL_HOST_SIDEBAR);
    expect(hostOf('shell.loading')).toBe(SHELL_HOST_LOADING);
    expect(hostOf('shell.empty')).toBe(SHELL_HOST_EMPTY);
  });

  it('页面开关未加载完时，页面槽渲染 `shell.loading` 的统一加载占位（第 13 条断言）', () => {
    usePageStore.setState({ loaded: false, values: {} });
    useFeatureStore.setState({ loaded: false, values: {} });
    useUiPrefsStore.setState({ values: {}, variants: {}, lang: 'zh' });

    render(<UISlot host={pageHost('home')} />);
    expect(document.body.textContent).toContain('正在加载功能页…');
  });

  it('页面开关加载完但一个可用页都没有 → 页面槽落到 `shell.empty` 全关空态自救页', () => {
    usePageStore.setState({ loaded: true, values: { home: false, config: true } });
    useUiPrefsStore.setState({ values: {}, variants: {}, lang: 'zh' });

    render(<UISlot host={pageHost('home')} fallback={<UISlot host={SHELL_HOST_EMPTY} />} />);
    expect(document.body.textContent).toContain('当前没有开启任何功能页');
  });
});
