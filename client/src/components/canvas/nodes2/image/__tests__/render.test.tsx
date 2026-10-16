// REQ-toonflow-canvas N2：图片 / 图片生成节点渲染冒烟（真实 <ReactFlow> + kit NodeSkeleton）
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import { installFlowEnv, TestCanvas, type CanvasProbe } from './harness';

vi.mock('../../../kit/useProviderSources', async () => (await import('./harness')).providerSourcesMock());

import '../index';
import { defineNode, getNodeDef } from '../../../kit/registry';
import { resolvePorts } from '../../../kit/connection';
import { NodeSkeleton } from '../../../kit/NodeSkeleton';
import { IconFileText } from '@tabler/icons-react';

// 测试用上游文本节点（输出口 prompt）
defineNode({
  type: 'n2-test-text', label: '文本', icon: IconFileText, category: 'text', inPalette: false,
  ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }],
  component: (p) => <NodeSkeleton node={p}>{String((p.data as { prompt?: string }).prompt ?? '')}</NodeSkeleton>,
});

beforeAll(installFlowEnv);
afterEach(() => { cleanup(); });

const IMG = '/storage/assets/a/original.png';

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${id}"] .cv-node`) as HTMLElement;
}

describe('注册', () => {
  it('load-image：来源口 in[IMAGE] + 输出 image；image：in[IMAGE,STRING] + 输出 image', () => {
    const li = getNodeDef('load-image');
    const ig = getNodeDef('image');
    expect(li?.label).toBe('图片');
    expect(ig?.label).toBe('图片生成');
    expect(resolvePorts(li, { data: {} }).map((p) => `${p.type}:${p.id}:${String(p.dataType)}`)).toEqual(['target:in:IMAGE', 'source:image:IMAGE']);
    expect(resolvePorts(ig, { data: {} }).map((p) => `${p.type}:${p.id}:${String(p.dataType)}`)).toEqual(['target:in:IMAGE,STRING', 'source:image:IMAGE']);
    expect(ig?.defaultData?.()).toMatchObject({ prompt: '', smart_plan: false, refOrder: [], refRoles: {} });
  });
});

describe('图片节点 load-image', () => {
  it('空节点：标题在卡片外、上传按钮、两个端口', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} nodes={[{ id: 'a', type: 'load-image', position: { x: 0, y: 0 }, data: {} }]} />);
    await act(async () => {});
    const el = nodeEl(container, 'a');
    expect(el.querySelector(':scope > .cv-node__title')?.textContent).toContain('图片');
    expect(within(el).getByRole('button', { name: '上传图片' })).toBeTruthy();
    expect(Array.from(el.querySelectorAll('.cv-handle')).map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'image']);
  });

  it('有图且选中：工具栏（局部重绘 / 宫格切分 / 替换图片 / 标记 / 下载 / 全屏）', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const host = { saveToAssets: vi.fn(), openFullscreen: vi.fn() };
    const { container } = render(
      <TestCanvas probe={probe} host={host} nodes={[{ id: 'a', type: 'load-image', selected: true, position: { x: 0, y: 0 }, data: { label: '立绘', image_url: IMG, image: IMG, url: IMG } }]} />,
    );
    await act(async () => {});
    const el = nodeEl(container, 'a');
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    for (const name of ['局部重绘', '宫格切分', '替换图片', '标记', '添加到素材库', '全屏']) expect(within(top).getByRole('button', { name })).toBeTruthy();
    expect((within(top).getByLabelText('下载') as HTMLAnchorElement).getAttribute('href')).toBe(IMG);
    expect((el.querySelector('.cv-img-stage img') as HTMLImageElement).getAttribute('src')).toBe(IMG);
    // 没进局部重绘时没有下方面板
    expect(el.querySelector('.cv-node__slot--bottom')).toBeNull();
    fireEvent.click(within(top).getByRole('button', { name: '全屏' }));
    expect(host.openFullscreen).toHaveBeenCalledWith({ nodeId: 'a', url: IMG, kind: 'image' });
  });

  it('宫格切分弹层：常用宫格 + 自定义行列（上限 6）', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(
      <TestCanvas probe={probe} nodes={[{ id: 'a', type: 'load-image', selected: true, position: { x: 0, y: 0 }, data: { image_url: IMG, image: IMG, url: IMG } }]} />,
    );
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 'a')).getByRole('button', { name: '宫格切分' }));
    const dlg = await screen.findByRole('dialog', { name: '宫格切分' });
    fireEvent.click(within(dlg).getByRole('button', { name: /4 宫格/ }));
    expect(within(dlg).getByText('共 4 张图片')).toBeTruthy();
    const rows = within(dlg).getByLabelText('切分行数') as HTMLInputElement;
    fireEvent.change(rows, { target: { value: '9' } });
    expect(rows.value).toBe('6');
    expect(within(dlg).getByText('共 12 张图片')).toBeTruthy();
  });
});

describe('图片生成节点 image', () => {
  const nodes = (data: Record<string, unknown>): Node[] => [
    { id: 't', type: 'n2-test-text', position: { x: -400, y: 0 }, data: { prompt: '雨夜街道' } },
    { id: 'i1', type: 'load-image', position: { x: -400, y: 200 }, data: { image_url: IMG, image: IMG, url: IMG } },
    { id: 'g', type: 'image', selected: true, position: { x: 0, y: 0 }, data },
  ];
  const edges: Edge[] = [
    { id: 'e1', source: 't', sourceHandle: 'prompt', target: 'g', targetHandle: 'in' },
    { id: 'e2', source: 'i1', sourceHandle: 'image', target: 'g', targetHandle: 'in' },
  ];

  it('选中：参考列表、生成源（含 Agent 自动选源）、参数摘要、技能、智能规划开关、发送', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} nodes={nodes({ prompt: '{{ref 2}} 站在街上', provider_id: 'p1', params: { aspect_ratio: '16:9' } })} edges={edges} />);
    await act(async () => {});
    const el = nodeEl(container, 'g');
    expect(el.querySelector(':scope > .cv-node__title')?.textContent).toContain('图片生成');
    const panel = el.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    expect(within(panel).getByRole('button', { name: '生成源' }).textContent).toContain('测试源');
    expect(within(panel).getByRole('button', { name: '生成参数' }).textContent).toContain('16:9 · 720p');
    expect(within(panel).getByRole('switch', { name: /智能规划/ }).getAttribute('aria-checked')).toBe('false');
    expect(within(panel).getByRole('button', { name: '技能' })).toBeTruthy();
    expect((within(panel).getByRole('button', { name: '生成图片' }) as HTMLButtonElement).disabled).toBe(false);
    // 空结果：占位图标
    expect(within(el).getByRole('img', { name: '暂无生成图片' })).toBeTruthy();
    // 生成源下拉首项是「Agent 自动选源」
    fireEvent.click(within(panel).getByRole('button', { name: '生成源' }));
    const list = await screen.findByRole('listbox', { name: '生成源' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Agent 自动选源', '测试源']);
  });

  it('参数弹层：比例宫格 + 分辨率 + 全部参数（保留 Agent 徽标），点比例即写回 params 与顶层镜像', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} nodes={nodes({ prompt: 'x', provider_id: 'p1', params: { aspect_ratio: '9:16' } })} edges={edges} />);
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 'g')).getByRole('button', { name: '生成参数' }));
    const dlg = await screen.findByRole('dialog', { name: '生成参数' });
    expect(within(dlg).getByRole('radio', { name: '比例 9:16' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dlg).getByRole('radio', { name: '720p' })).toBeTruthy();
    expect(within(dlg).getByText('建议')).toBeTruthy(); // steps 的 x-agent=suggest 徽标
    fireEvent.click(within(dlg).getByRole('radio', { name: '比例 1:1' }));
    await act(async () => {});
    const g = probe.nodes.find((n) => n.id === 'g')!;
    expect(g.data.params).toEqual({ aspect_ratio: '1:1' });
    expect(g.data.provider_params).toEqual({ aspect_ratio: '1:1' });
    expect(g.data.aspect_ratio).toBe('1:1');
  });

  it('历史版本条：两版以上显示，点旧版本即切换 image_url（下游跟着变）', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const history = [
      { url: '/storage/generated/v2.png', created_at: '2026-10-15T09:00:00Z', provider_id: 'p1' },
      { url: '/storage/generated/v1.png', created_at: '2026-10-15T08:00:00Z', provider_id: 'p1' },
    ];
    const { container } = render(<TestCanvas probe={probe} nodes={nodes({ prompt: 'x', image_url: history[0].url, result_url: history[0].url, history })} edges={edges} />);
    await act(async () => {});
    const strip = within(nodeEl(container, 'g')).getByRole('listbox', { name: '历史版本' });
    const opts = within(strip).getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    fireEvent.click(opts[1]);
    await act(async () => {});
    const g = probe.nodes.find((n) => n.id === 'g')!;
    expect(g.data.image_url).toBe('/storage/generated/v1.png');
    expect(g.data.result_url).toBe('/storage/generated/v1.png');
  });

  it('角色一致性技能：面板出现角色绑定行', async () => {
    const probe: CanvasProbe = { nodes: [], edges: [] };
    const { container } = render(<TestCanvas probe={probe} nodes={nodes({ prompt: 'x', skill_id: 'character_consistency' })} edges={edges} />);
    await act(async () => {});
    const panel = nodeEl(container, 'g').querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(within(panel).getByRole('group', { name: /角色一致性/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '技能' }).textContent).toContain('角色一致性');
  });
});
