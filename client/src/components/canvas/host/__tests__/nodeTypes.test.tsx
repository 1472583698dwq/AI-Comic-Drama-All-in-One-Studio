import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';

vi.mock('../../../../services/api', () => ({
  apiService: { getProvider: vi.fn(), listProviders: vi.fn(async () => ({ providers: [] })) },
}));

import '../../nodes2';
import { defineNode, nodeTypesMap, undefineNode } from '../../kit/registry';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { UnsupportedNode } from '../UnsupportedNode';
import { canvasNodeTypes, useCanvasNodeTypes } from '../nodeTypes';

/** REQ-toonflow-canvas FX-2：画布 nodeTypes 引用稳定（React Flow error002「created a new nodeTypes object」不再出现，节点不重挂载）。 */

beforeAll(() => {
  class RO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) { this.cb([{ target, contentRect: { width: 1000, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  class DMR { m22 = 1; }
  vi.stubGlobal('DOMMatrixReadOnly', DMR);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

// 记挂载次数的测试节点
let mounts = 0;
function CountingNode(props: NodeProps) {
  useEffect(() => { mounts += 1; }, []);
  return <NodeSkeleton node={props}>计数</NodeSkeleton>;
}
defineNode({ type: 'fx2-count', label: '计数', icon: () => null, category: 'tool', ports: [], component: CountingNode, inPalette: false });

describe('canvasNodeTypes / useCanvasNodeTypes', () => {
  it('同一注册表版本返回同一个对象；不认识的类型读到「不支持的节点」，Object.keys 只有已注册类型 + default', () => {
    const a = canvasNodeTypes();
    expect(canvasNodeTypes()).toBe(a);
    expect(a['fx2-count']).toBe(CountingNode);
    expect(a.default).toBe(UnsupportedNode);
    expect(a['mystery-plugin']).toBe(UnsupportedNode);
    expect(Object.keys(a)).toContain('video');
    expect(Object.keys(a)).not.toContain('mystery-plugin');
    // 普通对象自带的键不被兜底冒充
    expect((a as Record<string, unknown>).then).toBeUndefined();
    expect((a as Record<string, unknown>).toString).toBe(Object.prototype.toString);
    // 无兜底版与兜底版各自缓存，交替取也稳定
    const plain = nodeTypesMap();
    expect(canvasNodeTypes()).toBe(a);
    expect(nodeTypesMap()).toBe(plain);
    expect(plain['mystery-plugin']).toBeUndefined();
  });

  it('hook：多次重渲染引用不变；注册表变化（defineNode）后才换新对象', () => {
    const { result, rerender } = renderHook(() => useCanvasNodeTypes());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    const Other = () => null;
    act(() => { defineNode({ type: 'fx2-late', label: '晚注册', icon: () => null, category: 'tool', ports: [], component: Other, inPalette: false }); });
    expect(result.current).not.toBe(first);
    expect(result.current['fx2-late']).toBe(Other);
    act(() => { undefineNode('fx2-late'); });
  });

  it('画布里出现 / 消失未知类型：nodeTypes 不换对象、React Flow 不报 002 / 003，已有节点不重挂载', async () => {
    vi.stubEnv('NODE_ENV', 'development'); // React Flow 只在 development 下检查 nodeTypes 变更
    const onError = vi.fn();
    const seen: NodeTypes[] = [];
    let setNodes!: (n: Node[]) => void;
    const base: Node[] = [{ id: 'c', type: 'fx2-count', position: { x: 0, y: 0 }, data: {} }];
    function Host() {
      const [nodes, set] = useState<Node[]>(base);
      setNodes = set;
      const nodeTypes = useCanvasNodeTypes();
      seen.push(nodeTypes);
      return <div style={{ width: 1000, height: 800 }}><ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} onError={onError} /></div>;
    }
    render(<ReactFlowProvider><Host /></ReactFlowProvider>);
    await act(async () => {});
    mounts = 0;
    await act(async () => { setNodes([...base, { id: 'u', type: 'mystery-plugin', position: { x: 400, y: 0 }, data: { foo: 1 } }]); });
    expect(screen.getByText('mystery-plugin')).toBeTruthy(); // 「不支持的节点」卡片
    await act(async () => { setNodes([...base, { id: 'v', type: 'another-legacy', position: { x: 400, y: 0 }, data: {} }]); });
    await act(async () => { setNodes(base); });
    expect(new Set(seen).size).toBe(1);
    expect(mounts).toBe(0);
    // jsdom 里另有 004（容器尺寸）/ 013（没加载样式）环境类告警，与 nodeTypes 无关
    const codes = onError.mock.calls.map((c) => c[0]);
    expect(codes).not.toContain('002');
    expect(codes).not.toContain('003');
  });

  it('对照：按未知类型拼新对象（旧写法）在 development 下会报 002', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const onError = vi.fn();
    let setExtra!: (t: string) => void;
    function Old() {
      const [extra, set] = useState('');
      setExtra = set;
      const nodeTypes: NodeTypes = { ...nodeTypesMap(), default: UnsupportedNode, ...(extra ? { [extra]: UnsupportedNode } : {}) };
      const nodes: Node[] = extra ? [{ id: 'u', type: extra, position: { x: 0, y: 0 }, data: {} }] : [];
      return <div style={{ width: 1000, height: 800 }}><ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} onError={onError} /></div>;
    }
    render(<ReactFlowProvider><Old /></ReactFlowProvider>);
    await act(async () => {});
    await act(async () => { setExtra('mystery-plugin'); });
    expect(onError.mock.calls.map((c) => c[0])).toContain('002');
  });
});
