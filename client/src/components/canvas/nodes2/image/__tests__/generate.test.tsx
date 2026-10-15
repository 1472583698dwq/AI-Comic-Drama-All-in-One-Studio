// REQ-toonflow-canvas N2：发送时 useGeneration.run 的入参形状 / 宫格切分落节点 / 角色三视图绑定（mock 生成与媒体接口）
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import type { ReactNode } from 'react';
import { installFlowEnv, TestCanvas, type CanvasProbe } from './harness';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  gridSplit: vi.fn(),
  composeMask: vi.fn(),
}));

vi.mock('../../../kit/useProviderSources', async () => (await import('./harness')).providerSourcesMock());
vi.mock('../../../kit/useGeneration', async () => {
  const actual = await vi.importActual<typeof import('../../../kit/useGeneration')>('../../../kit/useGeneration');
  return { ...actual, useGeneration: () => ({ running: false, error: null, run: mocks.run, cancel: mocks.cancel }) };
});
vi.mock('../../../../../services/mediaOps', () => ({
  gridSplit: mocks.gridSplit,
  composeMask: mocks.composeMask,
  MediaOpsError: class MediaOpsError extends Error {},
}));

import '../index';
import { defineNode } from '../../../kit/registry';
import { NodeSkeleton } from '../../../kit/NodeSkeleton';
import { IconFileText } from '@tabler/icons-react';
import { useProjectStore } from '../../../../../stores/useProjectStore';
import { GRID_ROW_PITCH, GRID_GAP_X, SIDE_GAP, STACK_GAP } from '../layout';
import { useImageMedia } from '../useImageMedia';
import type { PaintEditor } from '../usePaintEditor';
import type { KitNodeActions } from '../../../kit/hostContext';

defineNode({
  type: 'n2-gen-text', label: '文本', icon: IconFileText, category: 'text', inPalette: false,
  ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }],
  component: (p) => <NodeSkeleton node={p}>{String((p.data as { prompt?: string }).prompt ?? '')}</NodeSkeleton>,
});

beforeAll(installFlowEnv);
beforeEach(() => {
  mocks.run.mockReset();
  mocks.cancel.mockReset();
  mocks.gridSplit.mockReset();
  mocks.composeMask.mockReset();
});
afterEach(() => { cleanup(); });

const IMG1 = '/storage/assets/a/original.png';
const IMG2 = '/storage/assets/b/original.png';

const graph = (genData: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } => ({
  nodes: [
    { id: 't', type: 'n2-gen-text', position: { x: -600, y: 0 }, data: { prompt: '雨夜街道' } },
    { id: 'i1', type: 'load-image', position: { x: -600, y: 200 }, data: { image_url: IMG1, image: IMG1, url: IMG1 } },
    { id: 'i2', type: 'load-image', position: { x: -600, y: 600 }, data: { image_url: IMG2, image: IMG2, url: IMG2 } },
    { id: 'g', type: 'image', selected: true, position: { x: 0, y: 0 }, data: genData },
  ],
  edges: [
    { id: 'e1', source: 't', sourceHandle: 'prompt', target: 'g', targetHandle: 'in' },
    { id: 'e2', source: 'i1', sourceHandle: 'image', target: 'g', targetHandle: 'in' },
    { id: 'e3', source: 'i2', sourceHandle: 'image', target: 'g', targetHandle: 'in' },
  ],
});

function panelOf(container: HTMLElement, id = 'g'): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"] .cv-node__slot--bottom`) as HTMLElement;
}

describe('发送 → useGeneration.run', () => {
  it('直接生成：assembleInputs 组装（文本参考进提示词、图片按生成源槽位进 reference_images）+ 参数 + 去掉旧槽位键', async () => {
    mocks.run.mockResolvedValue({ url: '/storage/generated/out.png', patch: { history: [{ url: '/storage/generated/out.png', created_at: 'x' }] } });
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: '{{ref 2}} 站在 {{ref 3}}', provider_id: 'p1', params: { aspect_ratio: '9:16' }, reference_images: ['/old.png'], text: 'old', smart_plan: false, history: [] });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    fireEvent.click(within(panelOf(container)).getByRole('button', { name: '生成图片' }));
    await act(async () => {});
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const o = mocks.run.mock.calls[0][0];
    // FX-2：没存值的分辨率 / 步数按弹层显示的缺省一并下发
    const shown = { aspect_ratio: '9:16', resolution: '720p', steps: 20 };
    expect(o).toMatchObject({ nodeType: 'image', kind: 'image', providerId: 'p1', smartPlan: false, params: shown });
    expect(o.assembled.args).toEqual({
      prompt: '参考 2 站在 参考 3\n\n参考 1：\n雨夜街道\n\n（参考编号对应：参考 2=第 1 张参考图，参考 3=第 2 张参考图）',
      reference_images: [IMG1, IMG2],
    });
    expect(o.intent).toBe(o.assembled.prompt);
    expect(o.data.reference_images).toBeUndefined();
    expect(o.data.text).toBeUndefined();
    expect(o.data.params).toEqual(shown);
    expect(o.data.provider_params).toEqual(shown);
    // 结果对齐 result_url
    const gn = probe.nodes.find((n) => n.id === 'g')!;
    expect(gn.data.image_url).toBe('/storage/generated/out.png');
    expect(gn.data.result_url).toBe('/storage/generated/out.png');
  });

  it('FX-2：params 为空时下发的就是弹层显示的值（比例 / 分辨率 / 步数缺省），节点数据不被改写', async () => {
    mocks.run.mockResolvedValue(null);
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: '雨夜', provider_id: 'p1', smart_plan: false });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    const panel = panelOf(container);
    // 弹层按钮摘要 = 下发值
    expect(within(panel).getByRole('button', { name: '生成参数' }).textContent).toContain('9:16 · 720p');
    fireEvent.click(within(panel).getByRole('button', { name: '生成图片' }));
    await act(async () => {});
    const o = mocks.run.mock.calls[0][0];
    expect(o.params).toEqual({ aspect_ratio: '9:16', resolution: '720p', steps: 20 });
    expect(o.data.params).toEqual(o.params);
    // 只在请求里补，不往节点里写
    expect(probe.nodes.find((n) => n.id === 'g')!.data.params).toBeUndefined();
  });

  it('FX-2：智能规划只发手动存过的参数（其余交给 Agent 规划）', async () => {
    mocks.run.mockResolvedValue(null);
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: '雨夜', provider_id: 'p1', smart_plan: true, params: { steps: 30 } });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    fireEvent.click(within(panelOf(container)).getByRole('button', { name: '生成图片' }));
    await act(async () => {});
    expect(mocks.run.mock.calls[0][0].params).toEqual({ steps: 30 });
  });

  it('智能规划 + Agent 自动选源：smartPlan=true、providerId 为空、带 skill_id', async () => {
    mocks.run.mockResolvedValue(null);
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: '画一只猫', smart_plan: true, skill_id: 'character_consistency' });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    fireEvent.click(within(panelOf(container)).getByRole('button', { name: '生成图片' }));
    await act(async () => {});
    const o = mocks.run.mock.calls[0][0];
    expect(o).toMatchObject({ smartPlan: true, providerId: '', kind: 'image' });
    expect(o.data.skill_id).toBe('character_consistency');
    expect(o.assembled.args.reference_images).toEqual([IMG1, IMG2]);
  });

  it('未选生成源且智能规划关闭：发送按钮禁用并提示', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: '画一只猫' });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    const btn = within(panelOf(container)).getByRole('button', { name: '请先选择生成源，或开启智能规划' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('切换生成源：参数重置为新源默认值（params_schema default）', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: 'x' });
    const { container } = render(<TestCanvas probe={probe} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    fireEvent.click(within(panelOf(container)).getByRole('button', { name: '生成源' }));
    const list = await screen.findByRole('listbox', { name: '生成源' });
    fireEvent.click(within(list).getByRole('option', { name: '测试源' }));
    await act(async () => {});
    const gn = probe.nodes.find((n) => n.id === 'g')!;
    expect(gn.data).toMatchObject({ provider_id: 'p1', provider: 'p1', params: { aspect_ratio: '9:16', resolution: '720p', steps: 20 } });
    expect(gn.data.aspect_ratio).toBe('9:16');
  });
});

describe('宫格切分 → createNodes', () => {
  it('2×2：调用 /media/ops/grid-split，按 Toonflow 版式落 4 个图片节点（行优先、标签带行列）', async () => {
    const tiles = [0, 1, 2, 3].map((i) => ({ url: `/storage/generated/media_ops/t${i}.png`, index: i, row: Math.floor(i / 2), col: i % 2, width: 256, height: 256 }));
    mocks.gridSplit.mockResolvedValue({ status: 'success', rows: 2, cols: 2, images: tiles, urls: tiles.map((t) => t.url) });
    const createNodes = vi.fn((specs: unknown[]) => specs.map((_, i) => `new${i}`));
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(
      <TestCanvas
        probe={probe}
        host={{ createNodes }}
        nodes={[{ id: 'a', type: 'load-image', selected: true, position: { x: 100, y: 40 }, data: { label: '分镜', image_url: IMG1, image: IMG1, url: IMG1 } }]}
      />,
    );
    await act(async () => {});
    fireEvent.click(within(container.querySelector('.react-flow__node[data-id="a"]') as HTMLElement).getByRole('button', { name: '宫格切分' }));
    const dlg = await screen.findByRole('dialog', { name: '宫格切分' });
    fireEvent.click(within(dlg).getByRole('button', { name: /4 宫格/ }));
    fireEvent.click(within(dlg).getByRole('button', { name: '切分为图片节点' }));
    await act(async () => {});
    expect(mocks.gridSplit).toHaveBeenCalledWith(IMG1, 2, 2);
    expect(createNodes).toHaveBeenCalledTimes(1);
    const [specs, opts] = createNodes.mock.calls[0] as unknown as [Array<{ type: string; position: { x: number; y: number }; data: Record<string, unknown> }>, { select?: boolean; anchorId?: string }];
    expect(opts).toMatchObject({ select: false, anchorId: 'a' });
    expect(specs.map((s) => s.type)).toEqual(['load-image', 'load-image', 'load-image', 'load-image']);
    expect(specs.map((s) => s.data.label)).toEqual(['分镜 · 1-1', '分镜 · 1-2', '分镜 · 2-1', '分镜 · 2-2']);
    expect(specs.map((s) => s.data.image_url)).toEqual(tiles.map((t) => t.url));
    expect(specs[0].data.image).toBe(tiles[0].url);
    const anchor = probe.nodes.find((n) => n.id === 'a')!;
    const aw = anchor.measured?.width ?? 220;
    const tileW = 240 + 18;
    expect(specs[0].position).toEqual({ x: 100 + aw + SIDE_GAP, y: 40 });
    expect(specs[1].position).toEqual({ x: 100 + aw + SIDE_GAP + tileW + GRID_GAP_X, y: 40 });
    expect(specs[2].position).toEqual({ x: 100 + aw + SIDE_GAP, y: 40 + GRID_ROW_PITCH });
    expect(specs[3].position).toEqual({ x: 100 + aw + SIDE_GAP + tileW + GRID_GAP_X, y: 40 + GRID_ROW_PITCH });
  });

  // REQ-toonflow-canvas F1：锚点在分组里 —— spec.position 是画布绝对坐标（K1 h），落盘后在锚点旁边保持宫格版式
  const tiles4 = [0, 1, 2, 3].map((i) => ({ url: `/storage/generated/media_ops/g${i}.png`, index: i, row: Math.floor(i / 2), col: i % 2, width: 256, height: 256 }));
  const groupedAnchor = (): Node[] => [
    { id: 'grp', type: 'group', position: { x: 1000, y: 500 }, style: { width: 1600, height: 1200 }, data: { label: '分组' } },
    { id: 'a', type: 'load-image', parentId: 'grp', selected: true, position: { x: 24, y: 40 }, data: { label: '分镜', image_url: IMG1, image: IMG1, url: IMG1 } },
    // 同组里挡在网格区域的节点：网格整体下移到它下方 40px
    { id: 'blk', type: 'load-image', parentId: 'grp', position: { x: 400, y: 40 }, width: 200, height: 100, data: {} },
  ];
  async function splitTwoByTwo(container: HTMLElement) {
    await act(async () => {});
    fireEvent.click(within(container.querySelector('.react-flow__node[data-id="a"]') as HTMLElement).getByRole('button', { name: '宫格切分' }));
    const dlg = await screen.findByRole('dialog', { name: '宫格切分' });
    fireEvent.click(within(dlg).getByRole('button', { name: /4 宫格/ }));
    fireEvent.click(within(dlg).getByRole('button', { name: '切分为图片节点' }));
    await act(async () => {});
  }

  it('锚点在分组里：传给 createNodes 的是画布绝对坐标（分组原点 + 相对坐标），避让同组节点', async () => {
    mocks.gridSplit.mockResolvedValue({ status: 'success', rows: 2, cols: 2, images: tiles4, urls: tiles4.map((t) => t.url) });
    const createNodes = vi.fn((specs: unknown[]) => specs.map((_, i) => `new${i}`));
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} host={{ createNodes }} nodes={groupedAnchor()} />);
    await splitTwoByTwo(container);
    const [specs] = createNodes.mock.calls[0] as unknown as [Array<{ position: { x: number; y: number } }>];
    const aw = probe.nodes.find((n) => n.id === 'a')!.measured?.width ?? 220;
    const tileW = 240 + 18;
    const x0 = 1000 + 24 + aw + SIDE_GAP;
    const y0 = 500 + 40 + 100 + STACK_GAP; // 压到 blk（相对 y 40、高 100）→ 下移到其下方 40
    expect(specs.map((s) => s.position)).toEqual([
      { x: x0, y: y0 },
      { x: x0 + tileW + GRID_GAP_X, y: y0 },
      { x: x0, y: y0 + GRID_ROW_PITCH },
      { x: x0 + tileW + GRID_GAP_X, y: y0 + GRID_ROW_PITCH },
    ]);
  });

  it('锚点在分组里（kit createNodesLocal 落盘）：4 个新节点挂同一分组，相对坐标在锚点右侧、保持 2×2 宫格', async () => {
    mocks.gridSplit.mockResolvedValue({ status: 'success', rows: 2, cols: 2, images: tiles4, urls: tiles4.map((t) => t.url) });
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} nodes={groupedAnchor()} />);
    await splitTwoByTwo(container);
    await act(async () => {});
    const made = probe.nodes.filter((n) => (n.data as { _origin?: { op?: string } })._origin?.op === 'grid-split');
    expect(made).toHaveLength(4);
    expect(made.every((n) => n.parentId === 'grp')).toBe(true);
    const aw = probe.nodes.find((n) => n.id === 'a')!.measured?.width ?? 220;
    const tileW = 240 + 18;
    const x0 = 24 + aw + SIDE_GAP;
    const y0 = 40 + 100 + STACK_GAP;
    expect(made.map((n) => n.position)).toEqual([
      { x: x0, y: y0 },
      { x: x0 + tileW + GRID_GAP_X, y: y0 },
      { x: x0, y: y0 + GRID_ROW_PITCH },
      { x: x0 + tileW + GRID_GAP_X, y: y0 + GRID_ROW_PITCH },
    ]);
  });
});

describe('标记保存 → createNodes', () => {
  // REQ-toonflow-canvas F1：单个产物不传 position，交给宿主摆放（锚点在分组里也正确），并从本节点 image 连到新节点 in
  it('不传 position；connectFrom 本节点 image → 新节点 in；select:false', async () => {
    mocks.composeMask.mockResolvedValue({ url: '/storage/generated/media_ops/mark.png', width: 512, height: 512 });
    const createNodes = vi.fn((specs: unknown[]) => specs.map((_, i) => `mark${i}`));
    const actions = { createNodes, update: vi.fn(), projectId: 'p' } as unknown as KitNodeActions;
    const wrapper = ({ children }: { children: ReactNode }) => <ReactFlowProvider>{children}</ReactFlowProvider>;
    const { result } = renderHook(() => useImageMedia({ id: 'a', label: '分镜', url: IMG1, actions, onImage: () => {} }), { wrapper });
    const editor = {
      busy: false, color: '#ff0000', commitText: vi.fn(), hasInk: () => true, layerDataUrl: () => 'data:image/png;base64,AAAA',
      setBusy: vi.fn(), cancel: vi.fn(),
    } as unknown as PaintEditor;
    await act(async () => { await result.current.saveMark(editor); });
    expect(mocks.composeMask).toHaveBeenCalledWith(IMG1, 'data:image/png;base64,AAAA', { opacity: 0.9, color: '#ff0000' });
    expect(createNodes).toHaveBeenCalledTimes(1);
    const [specs, opts] = createNodes.mock.calls[0] as unknown as [Array<Record<string, unknown>>, Record<string, unknown>];
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty('position');
    expect(specs[0]).toMatchObject({ type: 'load-image', data: { label: '分镜 - 标记', image_url: '/storage/generated/media_ops/mark.png', _origin: { op: 'mark', from: 'a' } } });
    expect(opts).toEqual({ connectFrom: { nodeId: 'a', sourceHandle: 'image', targetHandle: 'in' }, select: false });
  });
});

describe('角色一致性 → 绑定三视图为参考', () => {
  it('点角色：新建图片节点（左侧）并连到本节点 in', async () => {
    useProjectStore.setState({ project: { id: 'p', characters: [{ id: 'c1', name: '林川', three_views: { front: '/storage/f.png', side: '/storage/s.png' } }] } as any });
    const createNodes = vi.fn((specs: unknown[]) => specs.map((_, i) => `char${i}`));
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: 'x', skill_id: 'character_consistency' });
    const { container } = render(<TestCanvas probe={probe} host={{ createNodes }} nodes={g.nodes} edges={g.edges} />);
    await act(async () => {});
    const group = within(panelOf(container)).getByRole('group', { name: /角色一致性/ });
    fireEvent.click(within(group).getByRole('button', { name: /林川/ }));
    await act(async () => {});
    const [specs] = createNodes.mock.calls[0] as unknown as [Array<{ type: string; position: { x: number; y: number }; data: Record<string, unknown> }>];
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'load-image', data: { label: '林川·正面', image_url: '/storage/f.png', _origin: { op: 'character', character_id: 'c1', view: 'front' } } });
    expect(specs[0].position.x).toBeLessThan(0);
    expect(probe.edges.find((e) => e.source === 'char0')).toMatchObject({ target: 'g', targetHandle: 'in', sourceHandle: 'image' });
    act(() => { useProjectStore.setState({ project: null }); });
  });

  it('REQ-toonflow-canvas F1：本节点在分组里 → 三视图节点坐标为画布绝对坐标（分组原点 + 锚点左侧 80px）', async () => {
    useProjectStore.setState({ project: { id: 'p', characters: [{ id: 'c1', name: '林川', three_views: { front: '/storage/f.png', side: '/storage/s.png' } }] } as any });
    const createNodes = vi.fn((specs: unknown[]) => specs.map((_, i) => `char${i}`));
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const g = graph({ prompt: 'x', skill_id: 'character_consistency' });
    const nodes: Node[] = [
      { id: 'grp', type: 'group', position: { x: 1000, y: 500 }, style: { width: 1600, height: 1200 }, data: { label: '分组' } },
      ...g.nodes.map((n) => (n.id === 'g' ? { ...n, parentId: 'grp', position: { x: 400, y: 40 } } : n)),
    ];
    const { container } = render(<TestCanvas probe={probe} host={{ createNodes }} nodes={nodes} edges={g.edges} />);
    await act(async () => {});
    const group = within(panelOf(container)).getByRole('group', { name: /角色一致性/ });
    fireEvent.click(within(group).getByRole('button', { name: /林川/ }));
    await act(async () => {});
    const [specs] = createNodes.mock.calls[0] as unknown as [Array<{ position: { x: number; y: number } }>];
    // stackLeftOf：x = 锚点左缘 − 80 − 220；顶层的 t / i1 / i2 与锚点不同层，不参与避让
    expect(specs[0].position).toEqual({ x: 1000 + 400 - SIDE_GAP - 220, y: 500 + 40 });
    act(() => { useProjectStore.setState({ project: null }); });
  });
});
