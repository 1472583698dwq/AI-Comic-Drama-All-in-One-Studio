// REQ-toonflow-canvas N4 测试辅助：jsdom 下渲染真实 <ReactFlow> 所需的最小环境 + 画布外壳。
import { vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import { CanvasHostProvider, type CanvasHost } from '../../../kit/hostContext';
import { nodeTypesMap } from '../../../kit/registry';

/** React Flow 在 jsdom 下需要的布局 API（同 kit/__tests__/skeleton.test.tsx）+ 媒体元素桩。 */
export function setupFlowEnv(): void {
  class RO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) { this.cb([{ target, contentRect: { width: 1000, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  class DMR { m22 = 1; constructor(t?: string) { const s = t?.match(/scale\(([\d.]+)\)/)?.[1]; this.m22 = s ? Number(s) : 1; } }
  vi.stubGlobal('DOMMatrixReadOnly', DMR);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 100; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 220; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
  // jsdom 没有媒体播放实现：play/pause 打桩，duration 固定 10 秒（loadedmetadata 由用例手动触发）
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return 10; } });
}

export function Canvas({ nodes, edges = [], host = {} }: { nodes: Node[]; edges?: Edge[]; host?: CanvasHost }) {
  return (
    <div style={{ width: 1200, height: 900 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={host}>
          <ReactFlow className="cv-canvas" nodes={nodes} edges={edges} nodeTypes={nodeTypesMap()} />
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}

export const node = (id: string, type: string, data: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node => ({
  id, type, position: { x: 0, y: 0 }, data, ...extra,
});
