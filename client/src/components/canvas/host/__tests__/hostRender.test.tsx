import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';

vi.mock('../../../../services/api', () => ({
  apiService: {
    createAsset: vi.fn(async () => ({ asset: { id: 'ast_1' } })),
    getProvider: vi.fn(),
    listProviders: vi.fn(async () => ({ providers: [] })),
  },
}));

import '../../nodes2';
import { apiService } from '../../../../services/api';
import { nodeTypesMap } from '../../kit/registry';
import { UnsupportedNode, portsFromEdges } from '../UnsupportedNode';
import { renderEdges } from '../canvasChrome';
import { canSaveNodeAsset, nodeAssetOf, useCanvasHostController } from '../useCanvasHost';
import { useCanvasStore } from '../../../../stores/useCanvasStore';
import { useProjectStore } from '../../../../stores/useProjectStore';

/** REQ-toonflow-canvas H1：「不支持的节点」卡片、连线显示层、CanvasHost 宿主实现（传播 / 删除分组 / 保存到素材库 / 跳转 / 右键菜单）。 */

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
afterEach(() => cleanup());

describe('不支持的节点', () => {
  it('端口按已有连线生成（target 左 / source 右）', () => {
    expect(portsFromEdges('u', [
      { source: 'a', target: 'u', targetHandle: 'x' },
      { source: 'u', target: 'b', sourceHandle: null },
    ]).map((p) => `${p.type}:${p.id}:${p.dataType}`)).toEqual(['target:x:*', 'source::*']);
  });

  it('未知类型渲染占位卡：显示原类型与数据键，连线不断', () => {
    const nodes: Node[] = [
      { id: 'img', type: 'load-image', position: { x: 0, y: 0 }, data: { image_url: '/a.png' } },
      { id: 'u', type: 'mystery-plugin', position: { x: 400, y: 0 }, data: { foo: 1, bar: '保留' } },
    ];
    const edges: Edge[] = [{ id: 'e', source: 'img', sourceHandle: 'image', target: 'u', targetHandle: 'input' }];
    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 1000, height: 800 }}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ ...nodeTypesMap(), 'mystery-plugin': UnsupportedNode, default: UnsupportedNode }} />
        </div>
      </ReactFlowProvider>,
    );
    expect(screen.getByText('mystery-plugin')).toBeTruthy();
    expect(screen.getByText(/数据：foo、bar/)).toBeTruthy();
    const handle = container.querySelector('.react-flow__node[data-id="u"] .react-flow__handle.target');
    expect(handle?.getAttribute('data-handleid')).toBe('input');
  });
});

describe('连线显示层', () => {
  it('统一 simplebezier；与选中 / 拖动节点相连的边加 cv-edge-active，去掉旧高亮类', () => {
    const out = renderEdges(
      [{ id: 'a', selected: true }, { id: 'b' }, { id: 'c', dragging: true }, { id: 'd' }] as Node[],
      [
        { id: 'ab', source: 'a', target: 'b', type: 'smoothstep', className: 'canvas-edge-hl' },
        { id: 'bd', source: 'b', target: 'd' },
        { id: 'dc', source: 'd', target: 'c' },
      ],
    );
    expect(out.map((e) => e.type)).toEqual(['simplebezier', 'simplebezier', 'simplebezier']);
    expect(out.map((e) => e.className)).toEqual(['cv-edge-active', undefined, 'cv-edge-active']);
  });
});

describe('素材库产出判定', () => {
  it('文本节点 = 正文；媒体节点按输出口取第一个媒体产出', () => {
    expect(nodeAssetOf({ type: 'prompt', data: { prompt: '正文' } })).toEqual({ kind: 'text', value: '正文' });
    expect(nodeAssetOf({ type: 'image', data: { image_url: '/g.png' } })).toEqual({ kind: 'image', value: '/g.png' });
    expect(nodeAssetOf({ type: 'director3d', data: { camera_prompt: 'x', video_url: '/d.mp4' } })).toEqual({ kind: 'video', value: '/d.mp4' });
    expect(nodeAssetOf({ type: 'image', data: {} })).toBeNull();
  });
  it('带 asset_id 的素材节点、已保存过的同一产出 → 置灰', () => {
    expect(canSaveNodeAsset({ type: 'load-image', data: { image_url: '/a.png', asset_id: 'ast' } })).toBe(false);
    expect(canSaveNodeAsset({ type: 'load-image', data: { image_url: '/a.png' } })).toBe(true);
    expect(canSaveNodeAsset({ type: 'image', data: { image_url: '/a.png', _saved_asset: { id: 'x', value: '/a.png' } } })).toBe(false);
    expect(canSaveNodeAsset({ type: 'image', data: { image_url: '/b.png', _saved_asset: { id: 'x', value: '/a.png' } } })).toBe(true);
  });
});

function useHarness(initialNodes: Node[], initialEdges: Edge[]) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const ctl = useCanvasHostController({ pid: 'proj_x', nodesRef, edgesRef, setNodes, setEdges, setSelectedNodeId: () => {} });
  return { nodes, edges, ctl };
}

describe('CanvasHost 宿主实现', () => {
  const UPSCALE_SPEC = { id: 'upscale_ext', name: '视频超分', inputs: [{ id: 'video', type: 'video' }], outputs: [{ id: 'video', type: 'video' }] };

  it('updateNodeData：合并 + undefined 删键 + 只向动态端口下游写端口值', () => {
    const { result } = renderHook(() => useHarness(
      [
        { id: 'v', type: 'video', position: { x: 0, y: 0 }, data: { mode: 'i2v', stale: 1 } },
        { id: 'x', type: 'ext-node', position: { x: 300, y: 0 }, data: { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC } },
        { id: 't', type: 'timeline', position: { x: 300, y: 300 }, data: {} },
      ],
      [{ id: 'e1', source: 'v', sourceHandle: 'video', target: 'x', targetHandle: 'video' }, { id: 'e2', source: 'v', sourceHandle: 'video', target: 't', targetHandle: 'video' }],
    ));
    act(() => {
      result.current.ctl.updateNodeData('v', { video_url: '/out.mp4', history: [{ url: '/out.mp4' }], params: { duration: 5 }, agent_state: { status: 'completed' }, stale: undefined });
    });
    const by = (id: string) => result.current.nodes.find((n) => n.id === id)!.data as Record<string, unknown>;
    expect(by('v')).toMatchObject({ video_url: '/out.mp4', mode: 'i2v' });
    expect(by('v')).not.toHaveProperty('stale');
    expect(by('x')).toEqual({ canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC, video: '/out.mp4' });
    expect(by('t')).toEqual({});
  });

  it('删除分组只删框：子节点回到顶层且保持画布位置；连线一起清理', () => {
    const { result } = renderHook(() => useHarness(
      [
        { id: 'g', type: 'group', position: { x: 100, y: 100 }, width: 400, height: 300, data: { label: '分组' } },
        { id: 'c', type: 'prompt', parentId: 'g', position: { x: 24, y: 40 }, data: {} },
        { id: 'o', type: 'image', position: { x: 800, y: 0 }, data: {} },
      ],
      [{ id: 'e', source: 'c', sourceHandle: 'prompt', target: 'o', targetHandle: 'in' }],
    ));
    act(() => { result.current.ctl.removeNodes(['g'], { silent: true }); });
    const c = result.current.nodes.find((n) => n.id === 'c')!;
    expect(result.current.nodes.map((n) => n.id)).toEqual(['c', 'o']);
    expect(c.parentId).toBeUndefined();
    expect(c.position).toEqual({ x: 124, y: 140 });
    expect(result.current.edges).toHaveLength(1);
    act(() => { result.current.ctl.removeNodes(['o'], { silent: true }); });
    expect(result.current.edges).toHaveLength(0);
  });

  it('copy / duplicate：副本放在下方，duplicate 带入边', () => {
    const { result } = renderHook(() => useHarness(
      [
        { id: 'a', type: 'load-image', position: { x: 0, y: 0 }, measured: { width: 220, height: 200 }, data: { image_url: '/a.png' } },
        { id: 'b', type: 'image', position: { x: 400, y: 0 }, measured: { width: 220, height: 200 }, data: { label: '图' } },
      ],
      [{ id: 'e', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'in' }],
    ));
    act(() => { result.current.ctl.host.duplicate!('b'); });
    const copy = result.current.nodes.find((n) => n.id !== 'a' && n.id !== 'b')!;
    expect(copy.position).toEqual({ x: 400, y: 232 });
    expect((copy.data as { label: string }).label).toBe('图 - 副本');
    expect(result.current.edges.some((e) => e.target === copy.id && e.source === 'a')).toBe(true);
    act(() => { result.current.ctl.host.copy!('a'); });
    expect(result.current.nodes).toHaveLength(4);
    expect(result.current.edges).toHaveLength(2);
  });

  it('保存到素材库：POST /assets（file_url / 文本 content），写 _saved_asset 后置灰', async () => {
    const { result } = renderHook(() => useHarness(
      [
        { id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { image_url: '/g.png', label: '樱花' } },
        { id: 't', type: 'prompt', position: { x: 0, y: 300 }, data: { prompt: '正文' } },
      ],
      [],
    ));
    expect(result.current.ctl.host.canSaveToAssets!('i')).toBe(true);
    await act(async () => { await result.current.ctl.host.saveToAssets!('i'); });
    const fd = vi.mocked(apiService.createAsset).mock.calls[0][0] as FormData;
    expect(fd.get('file_url')).toBe('/g.png');
    expect(fd.get('project_id')).toBe('proj_x');
    expect(fd.get('name')).toBe('樱花');
    expect(result.current.ctl.host.canSaveToAssets!('i')).toBe(false);
    await act(async () => { await result.current.ctl.host.saveToAssets!('t'); });
    const fd2 = vi.mocked(apiService.createAsset).mock.calls[1][0] as FormData;
    expect(fd2.get('category')).toBe('text');
    expect(fd2.get('content')).toBe('正文');
  });

  it('navigate(director3d)：切到该镜、写回机位参数、切页签', () => {
    const ps = useProjectStore.getState();
    const setActiveShotId = vi.spyOn(ps, 'setActiveShotId').mockImplementation(() => {});
    const updateShot = vi.spyOn(ps, 'updateShot').mockImplementation(() => {});
    const setActiveTab = vi.spyOn(ps, 'setActiveTab').mockImplementation(() => {});
    const { result } = renderHook(() => useHarness([], []));
    result.current.ctl.host.navigate!('director3d', { shotId: 's1', shotPatch: { camera_framing: 'close_up' } });
    expect(setActiveShotId).toHaveBeenCalledWith('s1');
    expect(updateShot).toHaveBeenCalledWith('s1', { camera_framing: 'close_up' });
    expect(setActiveTab).toHaveBeenCalledWith('director3d');
    setActiveShotId.mockClear();
    result.current.ctl.host.navigate!('director3d', {});
    expect(setActiveShotId).not.toHaveBeenCalled();
  });

  it('右键菜单追加：添加到会话 / 回写到分镜（有产出时）', () => {
    useCanvasStore.setState({ agentFocusNodeIds: [] });
    const { result } = renderHook(() => useHarness(
      [
        { id: 'v', type: 'video', position: { x: 0, y: 0 }, data: { video_url: '/v.mp4' } },
        { id: 't', type: 'prompt', position: { x: 0, y: 0 }, data: {} },
      ],
      [],
    ));
    const items = result.current.ctl.host.contextMenuItems!('v');
    expect(items.map((i) => i.key)).toEqual(['agent-focus', 'shot-writeback']);
    act(() => { items[0].onSelect!(); });
    expect(useCanvasStore.getState().agentFocusNodeIds).toEqual(['v']);
    act(() => { items[1].onSelect!(); });
    expect(result.current.ctl.writeBack).toEqual({ nodeId: 'v', nodeType: 'video' });
    expect(result.current.ctl.host.contextMenuItems!('t').map((i) => i.key)).toEqual(['agent-focus']);
  });
});
