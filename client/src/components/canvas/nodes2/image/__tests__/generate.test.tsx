// REQ-toonflow-canvas N2：发送时 useGeneration.run 的入参形状 / 宫格切分落节点 / 角色三视图绑定（mock 生成与媒体接口）
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
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
import { GRID_ROW_PITCH, GRID_GAP_X, SIDE_GAP } from '../layout';

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
    expect(o).toMatchObject({ nodeType: 'image', kind: 'image', providerId: 'p1', smartPlan: false, params: { aspect_ratio: '9:16' } });
    expect(o.assembled.args).toEqual({
      prompt: '参考 2 站在 参考 3\n\n参考 1：\n雨夜街道\n\n（参考编号对应：参考 2=第 1 张参考图，参考 3=第 2 张参考图）',
      reference_images: [IMG1, IMG2],
    });
    expect(o.intent).toBe(o.assembled.prompt);
    expect(o.data.reference_images).toBeUndefined();
    expect(o.data.text).toBeUndefined();
    expect(o.data.params).toEqual({ aspect_ratio: '9:16' });
    expect(o.data.provider_params).toEqual({ aspect_ratio: '9:16' });
    // 结果对齐 result_url
    const gn = probe.nodes.find((n) => n.id === 'g')!;
    expect(gn.data.image_url).toBe('/storage/generated/out.png');
    expect(gn.data.result_url).toBe('/storage/generated/out.png');
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
});
