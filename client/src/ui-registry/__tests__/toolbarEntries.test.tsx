import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
// 副作用导入：登记 8 条工具动作条目（未完成清单第 2 条）
import '../entries/toolbar';
import { HeaderSkillsEntry } from '../entries/toolbar';
import { allEntries } from '../registry';
import { UISlot } from '../UISlot';
import { ToolbarChromeContext } from '../toolbarContext';
import { HEADER_MENU_HOST, HEADER_TOOLS_HOST, SIDEBAR_FOOTER_HOST } from '../types';
import { useModalIntentsStore } from '../modalIntents';
import { useProjectStore } from '../../stores/useProjectStore';

/**
 * 工具动作条目化（未完成清单第 2 条）：顶栏「更多」菜单与侧栏底栏的入口按钮改为注册表条目。
 *
 * 断言三件事：
 *   1. 8 条条目落在三个 toolbar 挂载点、`kind: 'toolbar'`、**不绑 switchId**（迁移期常驻 =
 *      与改造前「永远在」等价，后续绑开关零成本）；
 *   2. 菜单动作执行前先走宿主注入的 `closeMenu()`（`ToolbarChromeContext`），再执行动作
 *      —— 与改造前 `setMoreOpen(false); onOpenSkills()` 的顺序一致；
 *   3. 侧栏底栏条目的既有行为不变：设置 = 切到 config（自救入口）、收起 = 折叠侧栏。
 */

const IDS = [
  'toolbar.header.import', 'toolbar.header.skills', 'toolbar.header.mcp', 'toolbar.header.providers',
  'toolbar.sidebar.providers', 'toolbar.sidebar.theme', 'toolbar.sidebar.settings', 'toolbar.sidebar.collapse',
];

afterEach(() => { cleanup(); });

describe('第 2 条：toolbar 条目登记', () => {
  it('8 条工具动作都在册：kind=toolbar、不绑 switchId（迁移期常驻）', () => {
    const hits = allEntries().filter((e) => IDS.includes(e.id));
    expect(hits.map((e) => e.id).sort()).toEqual([...IDS].sort());
    expect(hits.every((e) => e.kind === 'toolbar')).toBe(true);
    expect(hits.every((e) => !e.switchId && !e.locked)).toBe(true);
    expect(hits.every((e) => e.source === 'builtin')).toBe(true);
  });

  it('分别落在三个挂载点：菜单动作 / 扩展工具组 / 侧栏底栏', () => {
    const hostOf = (id: string) => allEntries().find((e) => e.id === id)!.host;
    expect(hostOf('toolbar.header.import')).toBe(HEADER_MENU_HOST);
    expect(hostOf('toolbar.header.skills')).toBe(HEADER_TOOLS_HOST);
    expect(hostOf('toolbar.header.mcp')).toBe(HEADER_TOOLS_HOST);
    expect(hostOf('toolbar.header.providers')).toBe(HEADER_TOOLS_HOST);
    expect(hostOf('toolbar.sidebar.providers')).toBe(SIDEBAR_FOOTER_HOST);
    expect(hostOf('toolbar.sidebar.collapse')).toBe(SIDEBAR_FOOTER_HOST);
  });

  it('扩展工具组按 order 渲染（技能工坊 → MCP 工具 → 生成源管理）', () => {
    render(<UISlot host={HEADER_TOOLS_HOST} />);
    const texts = [...document.querySelectorAll('[data-ui-mark^="toolbar.header."]')]
      .map((el) => el.textContent || '');
    expect(texts[0]).toContain('技能工坊');
    expect(texts[1]).toContain('MCP 工具');
    expect(texts[2]).toContain('生成源管理');
  });
});

describe('第 2 条：宿主注入回调（closeMenu）', () => {
  it('点菜单动作 → 先收菜单，再打开对应弹窗（顺序与改造前一致）', () => {
    const order: string[] = [];
    const closeMenu = vi.fn(() => order.push('close'));
    useModalIntentsStore.setState({ skillsOpen: false });
    const origOpen = useModalIntentsStore.getState().openSkills;
    useModalIntentsStore.setState({
      openSkills: () => { order.push('open'); origOpen(); },
    });
    try {
      render(
        <ToolbarChromeContext.Provider value={{ closeMenu }}>
          <HeaderSkillsEntry />
        </ToolbarChromeContext.Provider>,
      );
      fireEvent.click(screen.getByText(/技能工坊/));
      expect(closeMenu).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['close', 'open']);
      expect(useModalIntentsStore.getState().skillsOpen).toBe(true);
    } finally {
      useModalIntentsStore.setState({ openSkills: origOpen, skillsOpen: false });
    }
  });

  it('没有宿主 Provider 时（宿主外渲染）不崩：回调退化为空实现', () => {
    useModalIntentsStore.setState({ skillsOpen: false });
    render(<HeaderSkillsEntry />);
    fireEvent.click(screen.getByText(/技能工坊/));
    expect(useModalIntentsStore.getState().skillsOpen).toBe(true);
    useModalIntentsStore.setState({ skillsOpen: false });
  });
});

describe('第 2 条：侧栏底栏条目（行为与改造前一致）', () => {
  it('展开态渲染 4 个入口：生成源 / 主题 / 设置 / 收起侧栏', () => {
    // jsdom 的 window.innerWidth = 1024 < 1180 → store 初值就是「已收起」，这里显式展开
    useProjectStore.setState({ activeTab: 'home', sidebarCollapsed: false });
    render(<UISlot host={SIDEBAR_FOOTER_HOST} />);
    expect(screen.getByText('生成源')).toBeTruthy();
    expect(screen.getByTitle(/切换(白天|黑夜)模式/)).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText('收起侧栏')).toBeTruthy();
  });

  it('收起成图标轨时只留图标与 tooltip（与改造前一致）', () => {
    useProjectStore.setState({ activeTab: 'home', sidebarCollapsed: true });
    render(<UISlot host={SIDEBAR_FOOTER_HOST} />);
    expect(screen.queryByText('生成源')).toBeNull();
    expect(screen.queryByText('设置')).toBeNull();
    expect(screen.getByTitle('生成源')).toBeTruthy();
    expect(screen.getByTitle(/设置：核心能力/)).toBeTruthy();
  });

  it('「设置」是自救入口：点击后把 activeTab 切到 config', () => {
    useProjectStore.setState({ activeTab: 'home', project: null, sidebarCollapsed: false });
    render(<UISlot host={SIDEBAR_FOOTER_HOST} />);
    fireEvent.click(screen.getByText('设置'));
    expect(useProjectStore.getState().activeTab).toBe('config');
  });

  it('「收起侧栏」切换折叠态', () => {
    useProjectStore.setState({ activeTab: 'home', sidebarCollapsed: false, canvasSidebarExpanded: true });
    render(<UISlot host={SIDEBAR_FOOTER_HOST} />);
    fireEvent.click(screen.getByText('收起侧栏'));
    expect(useProjectStore.getState().sidebarCollapsed).toBe(true);
  });
});
