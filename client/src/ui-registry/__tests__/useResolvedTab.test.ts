import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
// 副作用导入：注册页面条目 —— 「哪些页是全局页」的真源已迁进注册表（设计 §9.2 / 第 15 条），
// 真实应用由 `App.tsx` 的条目导入完成这一步；单测需显式补上，否则注册表为空。
import '../entries/pages';
import { useResolvedTab } from '../useResolvedTab';
import { usePageStore } from '../../stores/usePageStore';
import { useProjectStore } from '../../stores/useProjectStore';

/**
 * 「当前归一页签」的唯一实现（审查 L7 抽出来的共享口径）。
 *
 * 为什么值得测：`App` 的页面槽、`entries/panels.tsx` 的引导卡 / 悬浮抽屉都吃这个结果 ——
 * 一旦它比真实归一「早」返回（例如直接回原始 activeTab），
 * 缓存的页签已关闭时就会先挂上卡片再被卸掉（启动闪一下）。
 */

const setPages = (values: Record<string, boolean>, loaded = true) => {
  const items = Object.keys(values).map((id, i) => ({
    id, label: id, order: (i + 1) * 10, enabled: values[id],
  }));
  usePageStore.setState({ items: items as any, values, loaded });
};

const setProject = (p: {
  project?: any; activeTab?: string; isLoading?: boolean; activeProjectId?: string | null;
} = {}) => {
  useProjectStore.setState({
    project: p.project ?? null,
    activeTab: (p.activeTab ?? 'home') as any,
    isLoading: p.isLoading ?? false,
    activeProjectId: p.activeProjectId ?? null,
  });
};

afterEach(() => { cleanup(); });

describe('useResolvedTab（与 App 归一逻辑同源）', () => {
  it('开关未加载完 → null（绝不先闪一个未确定的页）', () => {
    setPages({ home: true }, false);
    setProject({ activeTab: 'home', project: { id: 'p' } });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBeNull();
  });

  it('启动恢复中（有缓存项目正在拉取）→ null', () => {
    setPages({ home: true });
    setProject({ activeTab: 'home', isLoading: true, activeProjectId: 'p' });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBeNull();
  });

  it('请求页可用 → 就是它', () => {
    setPages({ home: true, studio: true });
    setProject({ activeTab: 'studio', project: { id: 'p' } });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBe('studio');
  });

  it('请求页已关闭 → 落到第一个可用页（order 最小、config 不算）', () => {
    setPages({ home: true, studio: false, characters: true });
    setProject({ activeTab: 'studio', project: { id: 'p' } });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBe('home');
  });

  it('一个可用页都没有 → null（App 由此渲染全关空态自救页）', () => {
    setPages({ home: false, studio: false, config: true });
    setProject({ activeTab: 'home', project: { id: 'p' } });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBeNull();
  });

  it('无项目 → 只能落在全局页（项目内页即使开着也不认）', () => {
    setPages({ home: false, projects: false, config: true, canvas: true });
    setProject({ activeTab: 'canvas', project: null });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBe('config');
  });

  it('无项目且全局页全关 → null', () => {
    setPages({ home: false, projects: false, config: false, canvas: true });
    setProject({ activeTab: 'canvas', project: null });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBeNull();
  });

  it('订阅页面开关：开关一变归一结果就跟着变（「热」的来源）', () => {
    setPages({ home: true, studio: true });
    setProject({ activeTab: 'studio', project: { id: 'p' } });
    const { result } = renderHook(() => useResolvedTab());
    expect(result.current).toBe('studio');
    act(() => { setPages({ home: true, studio: false }); });
    expect(result.current).toBe('home');
  });
});
