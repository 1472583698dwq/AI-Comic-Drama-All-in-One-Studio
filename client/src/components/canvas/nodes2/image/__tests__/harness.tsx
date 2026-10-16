// REQ-toonflow-canvas N2 测试脚手架：真实 <ReactFlow>（受控 nodes/edges 状态）+ jsdom 布局补丁 + 宿主注入
import { useEffect } from 'react';
import { vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react';
import { CanvasHostProvider, type CanvasHost } from '../../../kit/hostContext';
import { nodeTypesMap } from '../../../kit/registry';

/** React Flow 在 jsdom 下需要的最小环境（同 kit/__tests__/skeleton.test.tsx）。 */
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
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 290; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 220; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
}

export interface CanvasProbe {
  nodes: Node[];
  edges: Edge[];
}

function Inner({ initialNodes, initialEdges, probe }: { initialNodes: Node[]; initialEdges: Edge[]; probe: CanvasProbe }) {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);
  useEffect(() => { probe.nodes = nodes; probe.edges = edges; }, [nodes, edges, probe]);
  return (
    <ReactFlow className="cv-canvas" nodes={nodes} edges={edges} nodeTypes={nodeTypesMap()} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} />
  );
}

/** 有状态的小画布：probe.nodes / probe.edges 随渲染更新，便于断言 updateNodeData 的结果。 */
export function TestCanvas({ nodes, edges = [], host = {}, probe }: { nodes: Node[]; edges?: Edge[]; host?: CanvasHost; probe: CanvasProbe }) {
  return (
    <div style={{ width: 1200, height: 900 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={host}>
          <Inner initialNodes={nodes} initialEdges={edges} probe={probe} />
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}

/** 测试用生成源定义：reference_images 最多 4 张 + 比例 / 分辨率 / 步数参数。 */
export const TEST_PROVIDER_DEF = {
  id: 'p1',
  display_name: '测试源',
  kind: 'image',
  builtin: true,
  input_schema: {
    properties: {
      prompt: { type: 'string', 'x-handle': 'text', 'x-role': 'prompt' },
      reference_images: { type: 'array', items: { type: 'string', format: 'uri' }, 'x-handle': 'image', 'x-slot': 'reference_images', maxItems: 4 },
    },
    required: ['prompt'],
  },
  params_schema: {
    properties: {
      aspect_ratio: { type: 'string', title: '画面比例', enum: ['9:16', '16:9', '1:1'], default: '9:16', 'x-visibility': 'basic', 'x-agent': 'auto' },
      resolution: { type: 'string', title: '分辨率', enum: ['480p', '720p', '1080p'], default: '720p', 'x-visibility': 'basic' },
      steps: { type: 'integer', title: '采样步数', default: 20, minimum: 4, maximum: 60, 'x-agent': 'suggest' },
    },
  },
};

/** vi.mock('../../../kit/useProviderSources', providerSourcesMock) 用的工厂。 */
export function providerSourcesMock() {
  const source = { id: 'p1', name: '测试源', kind: 'image', raw: TEST_PROVIDER_DEF };
  return {
    useProviderSources: () => ({ sources: [source], loading: false }),
    useProviderDefinition: (id?: string) => (id === 'p1' ? TEST_PROVIDER_DEF : null),
    loadProviderSources: async () => [source],
    loadProviderDefinition: async (id: string) => (id === 'p1' ? TEST_PROVIDER_DEF : null),
    invalidateProviderSources: () => {},
  };
}
