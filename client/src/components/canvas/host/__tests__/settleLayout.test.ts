import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { createSettleGate, measuredSizeKey, mediaSettled, useSettledRun } from '../settleLayout';

/** REQ-toonflow-canvas（E2E-3 发现 4）：迁移后去重叠等媒体尺寸确定再做。 */

afterEach(() => { vi.useRealTimers(); });

describe('measuredSizeKey', () => {
  it('只看顶层、非分组节点的测量尺寸', () => {
    const nodes = [
      { id: 'a', type: 'video', measured: { width: 240, height: 180.4 } },
      { id: 'g', type: 'group', measured: { width: 800, height: 600 } },
      { id: 'c', type: 'image', parentId: 'g', measured: { width: 1, height: 1 } },
      { id: 'b', type: 'image' },
    ] as Node[];
    expect(measuredSizeKey(nodes)).toBe('a:240x180|b:0x0');
  });
});

describe('mediaSettled', () => {
  it('图片没加载完 / 视频没拿到元数据 → 未就绪；出错或没有地址的不拦', () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('src', '/a.png');
    Object.defineProperty(img, 'complete', { configurable: true, value: false });
    root.appendChild(img);
    expect(mediaSettled(root)).toBe(false);
    Object.defineProperty(img, 'complete', { configurable: true, value: true });
    const v = document.createElement('video');
    v.setAttribute('src', '/a.mp4');
    Object.defineProperty(v, 'readyState', { configurable: true, value: 0 });
    root.appendChild(v);
    expect(mediaSettled(root)).toBe(false);
    Object.defineProperty(v, 'readyState', { configurable: true, value: 1 });
    expect(mediaSettled(root)).toBe(true);
    root.appendChild(document.createElement('video')); // 没地址
    expect(mediaSettled(root)).toBe(true);
    expect(mediaSettled(null)).toBe(true);
  });
});

describe('createSettleGate', () => {
  it('媒体就绪且尺寸连续 quietMs 不变才放行；尺寸一变重新计时', () => {
    let t = 0;
    let key = 'a:240x100';
    let ready = false;
    const gate = createSettleGate(() => key, () => ready, { quietMs: 400, maxWaitMs: 6000 }, () => t);
    t = 500;
    expect(gate.tick()).toBe(false); // 媒体还没好
    ready = true;
    key = 'a:240x420'; // 视频加载后卡片长高
    t = 600;
    expect(gate.tick()).toBe(false);
    t = 900;
    expect(gate.tick()).toBe(false);
    t = 1000;
    expect(gate.tick()).toBe(true);
  });
  it('媒体一直加载不出来：maxWaitMs 到点也执行', () => {
    let t = 0;
    const gate = createSettleGate(() => 'k', () => false, { quietMs: 400, maxWaitMs: 3000 }, () => t);
    t = 2999;
    expect(gate.tick()).toBe(false);
    t = 3000;
    expect(gate.tick()).toBe(true);
  });
});

describe('useSettledRun', () => {
  it('armed 后等尺寸稳定只跑一次（不是一测量完立刻跑）', () => {
    vi.useFakeTimers();
    let key = 'a:240x100';
    const run = vi.fn();
    const { rerender } = renderHook(({ armed }) => useSettledRun(armed, run, () => key, () => null, { quietMs: 300, maxWaitMs: 5000, intervalMs: 50 }), { initialProps: { armed: false } });
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    rerender({ armed: true });
    vi.advanceTimersByTime(200);
    key = 'a:240x420'; // 媒体加载后长高
    vi.advanceTimersByTime(200);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
