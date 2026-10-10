import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiagnosticsEntry } from '../entries/consolePanels';
import { allEntries } from '../registry';
import { useUiPrefsStore } from '../../stores/useUiPrefsStore';

/**
 * M4：诊断面板的「故障注入」注册的是一条 locked 条目，**必须随面板卸载一起注销**。
 *
 * 修复前的行为：注入后关掉本面板（组件卸载、undoRef 丢失），`dev.broken-entry` 仍留在模块级
 * 注册表里；因为它 locked 常驻，红色崩溃占位会一直在，而重开面板时按钮又显示「注入故障条目」
 * —— 只能靠再注入一次（同 id 替换）才能拿回 undo。
 */

afterEach(() => { cleanup(); });

describe('M4：故障注入条目的卸载清理', () => {
  it('注入 → 注册表出现 dev.broken-entry；卸载面板 → 立即注销（无残留）', () => {
    useUiPrefsStore.setState({ lang: 'zh' }); // 按钮文案跟着界面语言走，这里固定中文
    const { unmount } = render(<DiagnosticsEntry />);

    expect(allEntries().some((e) => e.id === 'dev.broken-entry')).toBe(false);
    fireEvent.click(screen.getByText(/故障注入：注册一条会抛错的条目/));
    expect(allEntries().some((e) => e.id === 'dev.broken-entry')).toBe(true);

    unmount();
    expect(allEntries().some((e) => e.id === 'dev.broken-entry')).toBe(false);
  });
});
