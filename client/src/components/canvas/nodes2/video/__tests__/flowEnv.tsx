// REQ-toonflow-canvas N3 测试辅助：jsdom 下渲染真实 <ReactFlow>（同 kit/__tests__/skeleton.test.tsx 的环境补丁）
import { vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import { CanvasHostProvider, type CanvasHost } from '../../../kit/hostContext';
import { nodeTypesMap } from '../../../kit/registry';

export function installFlowEnv() {
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
  // jsdom 没有媒体解码：load / play / pause 置空；canvas 2d 不可用（胶片条采样直接跳过）
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null });
}

/** 给 <video> 设元数据并触发 loadedmetadata。 */
export function setMediaMeta(el: HTMLMediaElement, meta: { duration?: number; videoWidth?: number; videoHeight?: number; currentTime?: number }) {
  for (const [k, v] of Object.entries(meta)) Object.defineProperty(el, k, { configurable: true, writable: true, value: v });
}

export function Canvas({ nodes, edges = [], host = {} }: { nodes: Node[]; edges?: Edge[]; host?: CanvasHost }) {
  return (
    <div style={{ width: 1200, height: 900 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={host}>
          <ReactFlow className="cv-canvas" defaultNodes={nodes} defaultEdges={edges} nodeTypes={nodeTypesMap()} />
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}
