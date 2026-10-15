import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { IconPhotoAi } from '@tabler/icons-react';
import { NodeSkeleton } from '../NodeSkeleton';
import { CanvasHostProvider, useKitNodeActions, type CanvasHost } from '../hostContext';
import { defineNode, nodeTypesMap } from '../registry';
import { cardMinHeight } from '../NodeHandles';
import { SelectionToolbar } from '../SelectionToolbar';
import { ToolbarButton } from '../FloatingToolbar';
import type { PortDef } from '../types';

/** REQ-toonflow-canvas design §5：NodeSkeleton + NodeHandles 渲染冒烟（真实 <ReactFlow>，jsdom 补齐布局 API）。 */

beforeAll(() => {
  // React Flow 在 jsdom 下需要的最小环境（官方测试指引同款）
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
});
afterEach(() => { cleanup(); });

const GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'STRING'], label: '图片、文本输入' },
  { id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' },
];
const SRC_PORTS: PortDef[] = [{ id: 'text', type: 'source', dataType: 'STRING', label: '文本输出' }];

function GenNode(props: NodeProps) {
  return (
    <NodeSkeleton
      node={props}
      toolbar={<ToolbarButton title="局部重绘">局部重绘</ToolbarButton>}
      downloadUrl={(props.data as { image_url?: string }).image_url}
      panel={<div data-testid="panel">提示词面板</div>}
    >
      <div data-testid={`content-${props.id}`}>内容</div>
    </NodeSkeleton>
  );
}
function SrcNode(props: NodeProps) {
  return <NodeSkeleton node={props}>文本</NodeSkeleton>;
}

defineNode({ type: 'sk-gen', label: '图片生成', icon: IconPhotoAi, category: 'image', ports: GEN_PORTS, component: GenNode });
defineNode({ type: 'sk-src', label: '文本', icon: IconPhotoAi, category: 'text', ports: SRC_PORTS, component: SrcNode });

function Canvas({ nodes, edges, host = {}, onNodesChange }: { nodes: Node[]; edges: Edge[]; host?: CanvasHost; onNodesChange?: (c: unknown) => void }) {
  return (
    <div style={{ width: 1000, height: 800 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={host}>
          <ReactFlow className="cv-canvas" nodes={nodes} edges={edges} nodeTypes={nodeTypesMap()} onNodesChange={onNodesChange}>
            <SelectionToolbar />
          </ReactFlow>
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}

const base = (): Node[] => [
  { id: 'src', type: 'sk-src', position: { x: 0, y: 0 }, data: { label: '剧情' } },
  { id: 'gen', type: 'sk-gen', position: { x: 400, y: 0 }, data: { image_url: 'http://x/a.png' } },
];

describe('NodeSkeleton + NodeHandles', () => {
  it('标题在卡片外、卡片最小高度、端口按 id 渲染并标记已连接', async () => {
    const { container } = render(<Canvas nodes={base()} edges={[{ id: 'e', source: 'src', sourceHandle: 'text', target: 'gen', targetHandle: 'in' }]} />);
    await act(async () => {});
    const gen = container.querySelector('.react-flow__node[data-id="gen"] .cv-node') as HTMLElement;
    expect(gen).toBeTruthy();
    expect(gen.style.width).toBe('220px');
    // 结构：标题栏（卡片外）→ 卡片容器（卡片 + 端口）
    const title = gen.querySelector(':scope > .cv-node__title');
    expect(title?.textContent).toContain('图片生成');
    const card = gen.querySelector(':scope > .cv-node__card-wrap > .cv-node__card') as HTMLElement;
    expect(card.style.minHeight).toBe(`${cardMinHeight(GEN_PORTS)}px`);
    expect(cardMinHeight(GEN_PORTS)).toBe(100);
    expect(cardMinHeight([...GEN_PORTS, { id: 'a', type: 'target', dataType: 'IMAGE' }, { id: 'b', type: 'target', dataType: 'IMAGE' }])).toBe(176);
    const handles = gen.querySelectorAll('.react-flow__handle.cv-handle');
    expect(Array.from(handles).map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'image']);
    const inHandle = gen.querySelector('.cv-handle[data-handleid="in"]') as HTMLElement;
    expect(inHandle.classList.contains('react-flow__handle-left')).toBe(true);
    expect(inHandle.classList.contains('is-connected')).toBe(true);
    expect(inHandle.style.top).toBe('50%');
    expect(inHandle.getAttribute('title')).toBe('图片、文本输入 · IMAGE / STRING');
    const outHandle = gen.querySelector('.cv-handle[data-handleid="image"]') as HTMLElement;
    expect(outHandle.classList.contains('react-flow__handle-right')).toBe(true);
    expect(outHandle.classList.contains('is-connected')).toBe(false);
    // 未选中：没有浮层
    expect(gen.querySelector('.cv-node__slot')).toBeNull();
    expect(screen.getByTestId('content-gen')).toBeTruthy();
  });

  it('选中时出现上方工具栏（含节点动作、下载）与下方面板；面板宽 660', async () => {
    const nodes = base().map((n) => (n.id === 'gen' ? { ...n, selected: true } : n));
    const host: CanvasHost = { saveToAssets: vi.fn(), openFullscreen: vi.fn() };
    const { container } = render(<Canvas nodes={nodes} edges={[]} host={host} />);
    await act(async () => {});
    const gen = container.querySelector('.react-flow__node[data-id="gen"] .cv-node') as HTMLElement;
    expect(gen.classList.contains('is-selected')).toBe(true);
    const top = gen.querySelector('.cv-node__slot--top') as HTMLElement;
    expect(top).toBeTruthy();
    expect(top.classList.contains('nodrag')).toBe(true);
    expect(within(top).getByText('局部重绘')).toBeTruthy();
    fireEvent.click(within(top).getByLabelText('添加到素材库'));
    expect(host.saveToAssets).toHaveBeenCalledWith('gen');
    expect(within(top).getByLabelText('下载').getAttribute('href')).toBe('http://x/a.png');
    fireEvent.click(within(top).getByLabelText('全屏'));
    expect(host.openFullscreen).toHaveBeenCalledWith({ nodeId: 'gen', url: 'http://x/a.png', kind: undefined });
    const bottom = gen.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(bottom.style.width).toBe('660px');
    expect(within(bottom).getByTestId('panel')).toBeTruthy();
  });

  it('双击标题改名 → 宿主 rename；右键菜单 → 复制 / 创建副本 / 删除走宿主', async () => {
    const host: CanvasHost = { rename: vi.fn(), copy: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), saveToAssets: vi.fn() };
    const { container } = render(<Canvas nodes={base()} edges={[]} host={host} />);
    await act(async () => {});
    const gen = container.querySelector('.react-flow__node[data-id="gen"] .cv-node') as HTMLElement;
    fireEvent.doubleClick(gen.querySelector('.cv-node__label')!);
    const input = gen.querySelector('.cv-node__label-input') as HTMLInputElement;
    expect(input.value).toBe('图片生成');
    fireEvent.change(input, { target: { value: '主角定妆' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(host.rename).toHaveBeenCalledWith('gen', '主角定妆');

    fireEvent.contextMenu(gen, { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole('menu', { name: '节点菜单' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['保存到素材库', '复制节点', '创建副本', '删除节点']);
    fireEvent.click(within(menu).getByText('创建副本'));
    expect(host.duplicate).toHaveBeenCalledWith('gen');
    expect(screen.queryByRole('menu', { name: '节点菜单' })).toBeNull();
    fireEvent.contextMenu(gen, { clientX: 10, clientY: 10 });
    fireEvent.click(within(await screen.findByRole('menu', { name: '节点菜单' })).getByText('删除节点'));
    await act(async () => {});
    expect(host.remove).toHaveBeenCalledWith('gen');

    // 标题栏 24×24 动作：没有 refresh 能力时置灰
    const refresh = gen.querySelector('.cv-node__actions [aria-label="刷新节点"]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });

  it('选中 ≥2 个节点出现选区工具栏；成组后生成 group 节点并把子节点挂到分组下', async () => {
    const changes: unknown[] = [];
    const nodes = base().map((n) => ({ ...n, selected: true }));
    render(<Canvas nodes={nodes} edges={[]} onNodesChange={(c) => changes.push(c)} />);
    await act(async () => {});
    const bar = screen.getByRole('toolbar', { name: '选区操作' });
    fireEvent.click(within(bar).getByText('成组'));
    await act(async () => {});
    const flat = (changes as { type: string; item?: Node }[][]).flat();
    const added = flat.find((c) => c.type === 'add' && c.item?.type === 'group');
    expect(added).toBeTruthy();
    const replaced = flat.filter((c) => c.type === 'replace' && c.item?.parentId === added!.item!.id);
    expect(replaced.map((c) => c.item!.id).sort()).toEqual(['gen', 'src']);
  });
});

// REQ-toonflow-canvas K1
function PortalNode(props: NodeProps) {
  return (
    <NodeSkeleton node={props}>
      <div data-testid="own">卡片内</div>
      {createPortal(<div data-testid="portal">全屏编辑器</div>, document.body)}
    </NodeSkeleton>
  );
}
function CanSaveNode(props: NodeProps) {
  const actions = useKitNodeActions(props.id);
  return <NodeSkeleton node={props}><span data-testid={`can-${props.id}`}>{String(actions.canSaveToAssets)}</span></NodeSkeleton>;
}
defineNode({ type: 'sk-portal', label: '时间线', icon: IconPhotoAi, category: 'tool', ports: [], component: PortalNode });
defineNode({ type: 'sk-cansave', label: '图片', icon: IconPhotoAi, category: 'image', ports: [], component: CanSaveNode });

describe('K1：右键菜单只认节点自己的 DOM；canSaveToAssets 随节点数据更新', () => {
  it('portal 出去的弹层里右键 / 双击不触发节点菜单 / 聚焦；节点内右键照常；子元素 preventDefault 过的右键也不弹', async () => {
    const { container } = render(<Canvas nodes={[{ id: 'p', type: 'sk-portal', position: { x: 0, y: 0 }, data: {} }]} edges={[]} />);
    await act(async () => {});
    fireEvent.contextMenu(screen.getByTestId('portal'), { clientX: 5, clientY: 5 });
    expect(screen.queryByRole('menu', { name: '节点菜单' })).toBeNull();
    fireEvent.doubleClick(screen.getByTestId('portal'));
    const own = screen.getByTestId('own');
    own.addEventListener('contextmenu', (e) => e.preventDefault(), { once: true });
    fireEvent.contextMenu(own, { clientX: 5, clientY: 5 });
    expect(screen.queryByRole('menu', { name: '节点菜单' })).toBeNull();
    fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="p"] .cv-node__card') as HTMLElement, { clientX: 5, clientY: 5 });
    expect(await screen.findByRole('menu', { name: '节点菜单' })).toBeTruthy();
  });

  it('宿主 canSaveToAssets 依赖节点产出：生成出图后按钮状态跟着变', async () => {
    const ref: { rf?: ReactFlowInstance } = {};
    function Grab() { ref.rf = useReactFlow(); return null; }
    const host: CanvasHost = { saveToAssets: vi.fn(), canSaveToAssets: (id) => !!(ref.rf?.getNode(id)?.data as { image_url?: string } | undefined)?.image_url };
    render(
      <div style={{ width: 1000, height: 800 }}>
        <ReactFlowProvider>
          <CanvasHostProvider value={host}>
            <ReactFlow className="cv-canvas" defaultNodes={[{ id: 'c', type: 'sk-cansave', position: { x: 0, y: 0 }, data: {} }]} defaultEdges={[]} nodeTypes={nodeTypesMap()}>
              <Grab />
            </ReactFlow>
          </CanvasHostProvider>
        </ReactFlowProvider>
      </div>,
    );
    await act(async () => {});
    expect(screen.getByTestId('can-c').textContent).toBe('false');
    await act(async () => { ref.rf!.updateNodeData('c', { image_url: '/storage/out.png' }); });
    expect(screen.getByTestId('can-c').textContent).toBe('true');
  });
});
