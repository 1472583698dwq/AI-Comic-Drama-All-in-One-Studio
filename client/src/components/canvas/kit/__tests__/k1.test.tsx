// REQ-toonflow-canvas K1：kit 向后兼容修复（媒体地址回源、PromptPanel 告警 / 名称 / 转圈、下载按钮、占位文字、
// 生成源缓存失效重拉、createNodesLocal 摆放与连线、通用表单控件）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { IconPhoto } from '@tabler/icons-react';

// 模拟 dev 环境回源：相对地址拼后端源点，绝对地址原样（存值不变，只在展示时解析）
vi.mock('../../../../utils/devOrigin', () => ({
  resolveMediaUrl: (u?: string | null) => (!u ? '' : /^(https?:|data:|blob:)/.test(u) ? u : `http://api.test${u}`),
}));
vi.mock('../../../../services/api', () => ({
  apiService: { listProviders: vi.fn(), getProvider: vi.fn() },
}));

import { RefList } from '../RefList';
import { PromptInput } from '../PromptInput';
import { PromptPanel, normalizeWarnings } from '../PromptPanel';
import { FloatingToolbar } from '../FloatingToolbar';
import { createNodesLocal } from '../hostContext';
import { defineNode, undefineNode } from '../registry';
import {
  invalidateProviderSources, loadProviderSources, PROVIDER_REFRESH_EVENT, useProviderDefinition, useProviderSources,
} from '../useProviderSources';
import { KitButton, KitField, KitInput, KitSelect } from '../ui/controls';
import { apiService } from '../../../../services/api';
import type { RefItem } from '../types';

afterEach(() => { cleanup(); });

const IMG: RefItem = { key: 'i|image', sourceId: 'i', sourceHandle: 'image', dataType: 'IMAGE', value: '/storage/a.png', thumb: '/storage/a.png', label: '图' };
const VID_THUMB: RefItem = { key: 'v|video', sourceId: 'v', sourceHandle: 'video', dataType: 'VIDEO', value: '/storage/v.mp4', thumb: '/storage/v.jpg' };
const VID: RefItem = { key: 'w|video', sourceId: 'w', sourceHandle: 'video', dataType: 'VIDEO', value: '/storage/w.mp4' };
const ABS: RefItem = { key: 'x|image', sourceId: 'x', sourceHandle: 'image', dataType: 'IMAGE', value: 'https://cdn/x.png' };

describe('媒体地址经 resolveMediaUrl 展示（存值不变）', () => {
  it('RefList：图片缩略图、视频封面、无封面视频都回源；绝对地址不变', () => {
    const { container } = render(<RefList refs={[IMG, VID_THUMB, VID, ABS]} onMove={() => {}} />);
    const imgs = Array.from(container.querySelectorAll('img.cv-ref__preview')).map((i) => i.getAttribute('src'));
    expect(imgs).toEqual(['http://api.test/storage/a.png', 'http://api.test/storage/v.jpg', 'https://cdn/x.png']);
    expect(container.querySelector('video.cv-ref__preview')?.getAttribute('src')).toBe('http://api.test/storage/w.mp4');
  });

  it('PromptInput：引用标签缩略图回源，回写的字符串仍是 {{ref N}}', async () => {
    const onChange = vi.fn();
    const { container } = render(<PromptInput value="看 {{ref 1}}" onChange={onChange} refs={[IMG]} />);
    await act(async () => {});
    const chip = container.querySelector('.cv-ref-chip') as HTMLElement;
    expect(chip.querySelector('img')?.getAttribute('src')).toBe('http://api.test/storage/a.png');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('FloatingToolbar：下载链接回源；没有 downloadUrl 时不显示下载（showDownload 可强制显示置灰按钮）', () => {
    const { rerender } = render(<FloatingToolbar downloadUrl="/storage/a.png" downloadName="a.png" onFullscreen={() => {}} />);
    expect(screen.getByLabelText('下载').getAttribute('href')).toBe('http://api.test/storage/a.png');
    rerender(<FloatingToolbar onFullscreen={() => {}} />);
    expect(screen.queryByLabelText('下载')).toBeNull();
    expect((screen.getByLabelText('全屏') as HTMLButtonElement).disabled).toBe(true); // 全屏行为不变
    rerender(<FloatingToolbar showDownload />);
    expect((screen.getByLabelText('下载') as HTMLButtonElement).disabled).toBe(true);
    rerender(<FloatingToolbar downloadUrl="blob:http://x/1" />);
    expect(screen.getByLabelText('下载').getAttribute('href')).toBe('blob:http://x/1');
  });
});

describe('PromptInput 占位文字', () => {
  it('placeholder prop 变化后编辑器里的占位跟着变', async () => {
    const { container, rerender } = render(<PromptInput value="" onChange={() => {}} refs={[]} placeholder="写一段旁白" />);
    await act(async () => {});
    expect(container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('写一段旁白');
    rerender(<PromptInput value="" onChange={() => {}} refs={[]} placeholder="输入要扩写的内容" />);
    await act(async () => {});
    expect(container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('输入要扩写的内容');
  });
});

describe('PromptPanel', () => {
  const base = { refs: [], prompt: '', onPromptChange: () => {}, sources: [{ id: 'a', label: '扩写' }], onSourceChange: () => {}, onSend: () => {} };

  it('normalizeWarnings：字符串 = warn；空文本丢弃；同语气同文本去重；按 error → warn → info 分组', () => {
    expect(normalizeWarnings(['A', { text: 'B', tone: 'info' }, { text: 'C', tone: 'error' }, 'A', { text: '' }, { text: 'D', tone: 'bogus' as never }]))
      .toEqual([{ text: 'C', tone: 'error' }, { text: 'A', tone: 'warn' }, { text: 'D', tone: 'warn' }, { text: 'B', tone: 'info' }]);
    expect(normalizeWarnings(undefined)).toEqual([]);
  });

  it('告警按语气分组渲染（纯字符串仍可用，显示为琥珀色 warn）', () => {
    const { container } = render(<PromptPanel {...base} warnings={['参考 2 暂无内容，已跳过', { text: '只处理文本', tone: 'info' }, { text: '生成源需要首帧', tone: 'error' }]} />);
    const box = container.querySelector('.cv-prompt-warnings') as HTMLElement;
    expect(box.getAttribute('role')).toBe('status');
    const groups = Array.from(box.querySelectorAll('.cv-prompt-warnings__group'));
    expect(groups.map((g) => g.getAttribute('data-tone'))).toEqual(['error', 'warn', 'info']);
    expect(groups.map((g) => g.textContent)).toEqual(['生成源需要首帧', '参考 2 暂无内容，已跳过', '只处理文本']);
  });

  it('sourceLabel：下拉按钮 / 搜索框 / 空列表文案；sourceSearchable=false 不显示搜索框；缺省仍是「生成源」', () => {
    const { rerender } = render(<PromptPanel {...base} sourceLabel="技能" sourceSearchable={false} />);
    const btn = screen.getByLabelText('技能');
    expect(btn.textContent).toContain('选择技能');
    fireEvent.click(btn);
    expect(screen.getByRole('listbox', { name: '技能' })).toBeTruthy();
    expect(screen.queryByLabelText('搜索技能')).toBeNull();
    fireEvent.click(btn);
    rerender(<PromptPanel {...base} sources={[]} />);
    fireEvent.click(screen.getByLabelText('生成源'));
    expect(screen.getByLabelText('搜索生成源')).toBeTruthy();
    expect(screen.getByText('暂无可用生成源，请先在设置中配置')).toBeTruthy();
  });

  it('running：有 onStop 显示可点的「停止生成」；没有 onStop 显示转圈（禁用、aria-busy）', () => {
    const onStop = vi.fn();
    const { container, rerender } = render(<PromptPanel {...base} running onStop={onStop} />);
    const stop = screen.getByLabelText('停止生成') as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalled();
    rerender(<PromptPanel {...base} running />);
    const busy = container.querySelector('.cv-send') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-label')).toBe('生成中…');
    expect(busy.querySelector('.cv-spin')).toBeTruthy();
  });
});

describe('createNodesLocal（宿主未接管时的缺省实现）', () => {
  function fakeRf(nodes: Node[]) {
    const state = { nodes: [...nodes] as Node[], edges: [] as unknown[] };
    return {
      state,
      rf: {
        getNode: (id: string) => state.nodes.find((n) => n.id === id),
        getNodes: () => state.nodes,
        addNodes: (ns: Node | Node[]) => { state.nodes.push(...(Array.isArray(ns) ? ns : [ns])); },
        addEdges: (es: unknown) => { state.edges.push(...(Array.isArray(es) ? es : [es])); },
        setNodes: (fn: unknown) => { if (typeof fn === 'function') state.nodes = (fn as (n: Node[]) => Node[])(state.nodes); },
      },
    };
  }
  const nd = (id: string, x: number, y: number, w = 200, h = 100, extra: Partial<Node> = {}): Node =>
    ({ id, type: 'k1-src', position: { x, y }, data: {}, measured: { width: w, height: h }, ...extra }) as Node;

  afterEach(() => { undefineNode('k1-out'); });

  it('right：锚点右侧 48px 一列竖排（间隔 48，按测量尺寸），与已有节点重叠就挪到其下方', () => {
    const { rf, state } = fakeRf([nd('a', 0, 0, 200, 100), nd('block', 260, -20, 200, 80)]);
    const ids = createNodesLocal(rf as never, [{ type: 'k1-x', data: {} }, { type: 'k1-x', data: {} }], { anchorId: 'a' });
    const placed = ids.map((id) => state.nodes.find((n) => n.id === id)!.position);
    // x = 0 + 200 + 48；第一个避开 block（-20..60）→ y = 60 + 48 = 108；第二个在其下方 108 + 100 + 48
    expect(placed).toEqual([{ x: 248, y: 108 }, { x: 248, y: 256 }]);
  });

  it('below：锚点下方一行横排', () => {
    const { rf, state } = fakeRf([nd('a', 10, 20, 200, 100)]);
    const ids = createNodesLocal(rf as never, [{ type: 'k1-x', data: {} }, { type: 'k1-x', data: {} }], { anchorId: 'a', placement: 'below' });
    expect(ids.map((id) => state.nodes.find((n) => n.id === id)!.position)).toEqual([{ x: 10, y: 168 }, { x: 278, y: 168 }]);
  });

  it('spec.position 是画布绝对坐标：锚点在分组里时换算成相对分组的坐标（同一 parentId）', () => {
    const { rf, state } = fakeRf([nd('g', 100, 50, 600, 400, { type: 'group' }), nd('a', 20, 30, 200, 100, { parentId: 'g' })]);
    const [id] = createNodesLocal(rf as never, [{ type: 'k1-x', data: {}, position: { x: 400, y: 300 } }], { anchorId: 'a' });
    const n = state.nodes.find((x) => x.id === id)!;
    expect(n.parentId).toBe('g');
    expect(n.position).toEqual({ x: 300, y: 250 });
  });

  it('connectTo：每个新节点的主输出口 → 锚点 in（缺省）；connectFrom 照旧', () => {
    defineNode({ type: 'k1-out', label: '图', icon: IconPhoto, category: 'image', component: () => null, ports: [{ id: 'img_out', type: 'source', dataType: 'IMAGE' }] });
    const { rf, state } = fakeRf([nd('a', 0, 0)]);
    const ids = createNodesLocal(rf as never, [{ type: 'k1-out', data: {} }, { type: 'load-image', data: {} }], { anchorId: 'a', connectTo: {}, select: false });
    expect(state.edges).toEqual([
      expect.objectContaining({ source: ids[0], sourceHandle: 'img_out', target: 'a', targetHandle: 'in' }),
      expect.objectContaining({ source: ids[1], sourceHandle: 'image', target: 'a', targetHandle: 'in' }),
    ]);
    const { rf: rf2, state: s2 } = fakeRf([nd('a', 0, 0)]);
    const [nid] = createNodesLocal(rf2 as never, [{ type: 'k1-x', data: {} }], { anchorId: 'a', connectFrom: { nodeId: 'a', sourceHandle: 'image' } });
    expect(s2.edges).toEqual([expect.objectContaining({ source: 'a', sourceHandle: 'image', target: nid, targetHandle: 'in' })]);
  });

  it('rf 没有 getNodes 时也能用（只在新节点之间避让）', () => {
    const { rf, state } = fakeRf([nd('a', 0, 0, 200, 100)]);
    const { getNodes: _omit, ...narrow } = rf;
    const ids = createNodesLocal(narrow as never, [{ type: 'k1-x', data: {} }], { anchorId: 'a' });
    expect(state.nodes.find((n) => n.id === ids[0])!.position).toEqual({ x: 248, y: 0 });
  });
});

describe('useProviderSources / useProviderDefinition：失效后已挂载的 hook 重拉', () => {
  it('invalidateProviderSources() 与 provider-list-refresh 事件都会重拉（同一轮只拉一次）', async () => {
    let round = 0;
    (apiService.listProviders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      round += 1;
      return { providers: [{ id: `p${round}`, name: `源 ${round}` }] };
    });
    invalidateProviderSources();
    const { result } = renderHook(() => useProviderSources('image'));
    await waitFor(() => expect(result.current.sources.map((s) => s.id)).toEqual(['p1']));
    act(() => { invalidateProviderSources(); window.dispatchEvent(new Event(PROVIDER_REFRESH_EVENT)); });
    await waitFor(() => expect(result.current.sources.map((s) => s.id)).toEqual(['p2']));
    act(() => { window.dispatchEvent(new Event(PROVIDER_REFRESH_EVENT)); });
    await waitFor(() => expect(result.current.sources.map((s) => s.id)).toEqual(['p3']));
    act(() => { result.current.reload(); });
    await waitFor(() => expect(result.current.sources.map((s) => s.id)).toEqual(['p4']));
    expect(apiService.listProviders).toHaveBeenCalledTimes(4);
    await loadProviderSources('image'); // 没有失效时命中缓存，不再请求
    expect(apiService.listProviders).toHaveBeenCalledTimes(4);
  });

  it('useProviderDefinition 换 id 时不返回上一个源的定义', async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    (apiService.getProvider as ReturnType<typeof vi.fn>).mockImplementation((id: string) => new Promise((r) => { resolvers[id] = r; }));
    invalidateProviderSources();
    const { result, rerender } = renderHook(({ id }) => useProviderDefinition(id), { initialProps: { id: 'a' } });
    await act(async () => { resolvers.a({ provider: { id: 'a' } }); });
    expect(result.current).toEqual({ id: 'a' });
    rerender({ id: 'b' });
    expect(result.current).toBeNull();
    await act(async () => { resolvers.b({ provider: { id: 'b' } }); });
    expect(result.current).toEqual({ id: 'b' });
  });
});

describe('kit/ui/controls（通用表单控件）', () => {
  it('Field 关联标签；输入类控件拦截冒泡但调用方回调照常执行；Button 变体与 loading', () => {
    const outer = vi.fn();
    const onKeyDown = vi.fn();
    const onClick = vi.fn();
    render(
      <div onKeyDown={outer} onPointerDown={outer} onClick={outer}>
        <KitField label="模型" htmlFor="m" required hint="可手填" error={undefined}>
          <KitInput id="m" defaultValue="x" onKeyDown={onKeyDown} />
        </KitField>
        <KitSelect aria-label="比例" placeholder="请选择" options={[{ value: '16:9', label: '16:9' }]} defaultValue="" size="sm" />
        <KitButton variant="primary" onClick={onClick}>运行</KitButton>
        <KitButton loading>保存</KitButton>
      </div>,
    );
    const input = screen.getByLabelText(/模型/) as HTMLInputElement;
    expect(input.className).toContain('cv-ctl-input');
    expect(input.className).toContain('nodrag');
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(onKeyDown).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByText('可手填').className).toContain('cv-ctl-hint');
    const select = screen.getByLabelText('比例') as HTMLSelectElement;
    expect(select.className).toContain('cv-ctl--sm');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['请选择', '16:9']);
    fireEvent.click(screen.getByText('运行'));
    expect(onClick).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByText('运行').className).toContain('cv-ctl-btn--primary');
    const saving = screen.getByText('保存').closest('button') as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect(saving.getAttribute('aria-busy')).toBe('true');
  });
});
