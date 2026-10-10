import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastExtensionsChanged, refreshExtensionState, startExtensionsStream } from '../extensionsStream';

/**
 * 扩展事件流（Phase 4）的两条口径：
 *   · 事件表就是各宿主原本监听的 `*-list-refresh`（SSE 只负责「什么时候」，不负责「各拉什么」）；
 *   · **L5**：页面开关的变更也走 `/extensions/page:<id>/enable|disable`，但它有自己的加载路径，
 *     不该顺带引发一轮全量扩展刷新（此前每次开/关页面都会多拉 /plugins、主题、生成源等）。
 */

const NAMES = [
  'plugin-list-refresh', 'provider-list-refresh', 'theme-list-refresh', 'canvasnode-list-refresh',
  'exporter-list-refresh', 'directorpacks-list-refresh', 'storyboard-slots-refresh', 'customnode-list-refresh',
];

const spies: Array<{ name: string; fn: ReturnType<typeof vi.fn> }> = [];

const listen = () => NAMES.map((name) => {
  const fn = vi.fn();
  // EventListener 需要的签名比 vi.fn() 宽，运行时只是被调用的桩
  window.addEventListener(name, fn as any);
  spies.push({ name, fn });
  return fn;
});

afterEach(() => {
  spies.splice(0).forEach(({ name, fn }) => window.removeEventListener(name, fn as any));
});

describe('broadcastExtensionsChanged', () => {
  it('页面开关事件（id = page:<id>）不广播任何刷新事件（L5）', () => {
    const fns = listen();
    broadcastExtensionsChanged({ kind: 'extension', action: 'enable', id: 'page:studio' });
    broadcastExtensionsChanged({ kind: 'extension', action: 'disable', id: 'page:canvas' });
    expect(fns.every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('插件事件广播全部 8 条刷新事件（含 storyboard-slots-refresh）', () => {
    const fns = listen();
    broadcastExtensionsChanged({ kind: 'plugin', action: 'enable', id: 'demo-pack' });
    expect(fns.every((f) => f.mock.calls.length === 1)).toBe(true);
    expect(NAMES).toHaveLength(8);
  });

  it('手刷兜底（无 id）照常广播一轮（SSE 断线时的「再来一次」）', () => {
    const fns = listen();
    refreshExtensionState();
    expect(fns.every((f) => f.mock.calls.length === 1)).toBe(true);
  });

  it('连接建立（kind=stream，无 id）也照常广播一次，补上断线期间漏掉的变更', () => {
    const fns = listen();
    broadcastExtensionsChanged({ kind: 'stream', action: 'open' });
    expect(fns.every((f) => f.mock.calls.length === 1)).toBe(true);
  });
});

describe('startExtensionsStream 的兜底', () => {
  it('没有 EventSource 的环境（jsdom / 老浏览器）安全退化：不抛错、返回可调用的停止函数', () => {
    expect(typeof EventSource).toBe('undefined'); // jsdom 不实现 EventSource
    const stop = startExtensionsStream();
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });
});
