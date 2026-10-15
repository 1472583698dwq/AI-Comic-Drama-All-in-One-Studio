import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, type Edge, type Node } from '@xyflow/react';

vi.mock('../../../../../services/api', () => ({
  apiService: {
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    testProvider: vi.fn(),
    listImageProviders: vi.fn(),
    updateProvider: vi.fn(),
    setProviderApiKey: vi.fn(),
    deleteProvider: vi.fn(),
    listCustomNodes: vi.fn(),
    getCustomNode: vi.fn(),
    getCanvasNode: vi.fn(),
    listSkills: vi.fn(async () => []),
  },
}));

import { apiService } from '../../../../../services/api';
import { nodeTypesMap } from '../../../kit/registry';
import { CanvasHostProvider, type CanvasHost } from '../../../kit/hostContext';
import { clearCanvasNodeSpecs } from '../../../canvasNodeSpecs';
import '../index';
import { clearCustomNodeDefs } from '../customNodeDefs';
import { COMFY_IMAGE_PROVIDER, MULTI_REF_CUSTOM, UPSCALE_DEMO_CUSTOM, UPSCALE_EXT_SPEC } from '../__dev__/samples';

/** REQ-toonflow-canvas N7：9 个换皮节点在真实 <ReactFlow> 里的渲染冒烟 + 关键交互（执行 / 健康检测 / 选源）。 */

const api = apiService as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeAll(() => {
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

const BUILTIN_IMAGE = { id: 'comfyui', display_name: 'ComfyUI (本地/云端)', kind: 'image', builtin: true, provider_type: 'builtin', enabled: true, models: [], input_schema: { type: 'object', properties: { prompt: { type: 'string', 'x-handle': 'text' } } } };

beforeEach(() => {
  clearCanvasNodeSpecs();
  clearCustomNodeDefs();
  api.listProviders.mockImplementation(async ({ kind }: { kind: string }) => ({ providers: kind === 'image' ? [COMFY_IMAGE_PROVIDER, BUILTIN_IMAGE] : [], total: 0 }));
  api.getProvider.mockImplementation(async (id: string) => ({ provider: id === COMFY_IMAGE_PROVIDER.id ? COMFY_IMAGE_PROVIDER : null }));
  api.testProvider.mockResolvedValue({ provider_id: COMFY_IMAGE_PROVIDER.id, ok: true, detail: '代码体检通过（未真实调用上游）' });
  api.listCustomNodes.mockResolvedValue({ nodes: [UPSCALE_DEMO_CUSTOM, MULTI_REF_CUSTOM], total: 2 });
  api.getCustomNode.mockImplementation(async (id: string) => ({ node: id === 'upscale_demo' ? UPSCALE_DEMO_CUSTOM : MULTI_REF_CUSTOM }));
  api.getCanvasNode.mockResolvedValue({ node: UPSCALE_EXT_SPEC });
});
afterEach(() => { cleanup(); });

const at = (x: number, y = 0) => ({ x, y });
const nodes = (): Node[] => [
  { id: 'brief1', type: 'brief', position: at(0), data: { brief: '雨夜，少年拔剑。', style_preset: 'japanese_anime', aspect_ratio: '16:9' } },
  { id: 'split1', type: 'script-split', position: at(400), data: {} },
  { id: 'vid', type: 'load-video', position: at(0, 400), data: { video_url: '/storage/videos/in.mp4', video: '/storage/videos/in.mp4' } },
  { id: 'ext1', type: 'ext-node', position: at(400, 400), data: { canvas_node_id: 'upscale_ext' } },
  { id: 'cus1', type: 'custom', position: at(800, 400), data: { custom_node_id: 'upscale_demo', params: { scale: 3 } } },
  { id: 'pimg', type: 'provider-image', position: at(0, 800), data: { provider_id: COMFY_IMAGE_PROVIDER.id, kind: 'image', definition: COMFY_IMAGE_PROVIDER } },
  { id: 'pvid', type: 'provider-video', position: at(400, 800), data: {} },
  { id: 'paud', type: 'provider-audio', position: at(800, 800), data: {} },
  { id: 'pllm', type: 'provider-llm', position: at(1200, 800), data: {} },
  { id: 'pgen', type: 'provider', position: at(1600, 800), data: {} },
];
const edges = (): Edge[] => [
  { id: 'e1', source: 'brief1', sourceHandle: 'brief', target: 'split1', targetHandle: 'brief' },
  { id: 'e2', source: 'vid', sourceHandle: 'video', target: 'ext1', targetHandle: 'video' },
  { id: 'e3', source: 'vid', sourceHandle: 'video', target: 'cus1', targetHandle: 'video' },
];

function Canvas({ host }: { host: CanvasHost }) {
  return (
    <div style={{ width: 1000, height: 800 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={host}>
          <ReactFlow className="cv-canvas" nodes={nodes()} edges={edges()} nodeTypes={nodeTypesMap()} />
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}

const nodeEl = (c: HTMLElement, id: string) => c.querySelector(`.react-flow__node[data-id="${id}"] .cv-node`) as HTMLElement;
const handles = (el: HTMLElement) => Array.from(el.querySelectorAll('.react-flow__handle.cv-handle')).map((h) => `${h.classList.contains('react-flow__handle-left') ? 'in' : 'out'}:${h.getAttribute('data-handleid')}`);
const title = (el: HTMLElement) => el.querySelector(':scope > .cv-node__title .cv-node__label')?.textContent;

async function setup(host: CanvasHost = {}) {
  const view = render(<Canvas host={host} />);
  await act(async () => {});
  return view;
}

describe('legacy-b 节点渲染冒烟', () => {
  it('9 个类型都用 NodeSkeleton（标题在卡片外）且端口 id 不变', async () => {
    const { container } = await setup();
    await waitFor(() => expect(handles(nodeEl(container, 'cus1'))).toEqual(['in:video', 'in:prompt', 'out:video']));

    const brief = nodeEl(container, 'brief1');
    expect(title(brief)).toBe('灵感简报');
    expect(handles(brief)).toEqual(['out:brief']);
    expect(brief.querySelector('.cv-lb-tag')?.textContent).toBe('日式二次元');
    expect((within(brief).getByLabelText('画幅') as HTMLSelectElement).value).toBe('16:9');

    const split = nodeEl(container, 'split1');
    expect(title(split)).toBe('剧本拆解');
    expect(handles(split)).toEqual(['in:brief', 'out:characters', 'out:shots']);
    expect(within(split).getByText('雨夜，少年拔剑。')).toBeTruthy();

    // ext-node：注册表里没有 → 懒取 /canvas-nodes/upscale_ext 后按声明出端口
    await waitFor(() => expect(handles(nodeEl(container, 'ext1'))).toEqual(['in:video', 'in:prompt', 'out:video']));
    const ext = nodeEl(container, 'ext1');
    expect(title(ext)).toBe('超分扩展节点');
    expect(api.getCanvasNode).toHaveBeenCalledWith('upscale_ext');
    expect(within(ext).getByText('→ custom_node:upscale_demo')).toBeTruthy();
    expect(within(ext).getByLabelText('输入端口').textContent).toContain('in.mp4');

    const cus = nodeEl(container, 'cus1');
    expect(title(cus)).toBe('视频超分演示');
    expect(within(cus).getByRole('option', { name: '视频超分演示（video/python）' })).toBeTruthy();
    expect(within(cus).getByText('放大倍数')).toBeTruthy(); // params_schema → DynamicControl

    const pimg = nodeEl(container, 'pimg');
    expect(title(pimg)).toBe('生图源');
    expect(handles(pimg)).toEqual(['in:prompt', 'in:reference_images', 'in:img_5', 'out:provider', 'out:image_url']);
    expect(handles(nodeEl(container, 'pvid'))).toEqual(['in:prompt', 'out:provider', 'out:video']);
    expect(handles(nodeEl(container, 'paud'))).toEqual(['in:prompt', 'out:provider', 'out:audio']);
    expect(handles(nodeEl(container, 'pllm'))).toEqual(['in:prompt', 'out:provider', 'out:output']);
    expect(title(nodeEl(container, 'pllm'))).toBe('LLM源');
    expect(handles(nodeEl(container, 'pgen'))).toEqual(['in:prompt', 'out:provider', 'out:image']);
    // provider-llm 拉的是 llm 源（旧组件会落成生图源）
    expect(api.listProviders).toHaveBeenCalledWith({ kind: 'llm', include_builtin: true });
  });

  it('生成源节点：列出真实列表、连通检测走 testProvider、显示结果', async () => {
    const { container } = await setup();
    const pimg = nodeEl(container, 'pimg');
    await waitFor(() => expect(within(pimg).getByRole('option', { name: /ComfyUI·四试图生成/ })).toBeTruthy());
    const select = within(pimg).getByLabelText('选择生成源') as HTMLSelectElement;
    expect(select.value).toBe(COMFY_IMAGE_PROVIDER.id);
    expect(within(pimg).getByText('宽')).toBeTruthy(); // 参数（DynamicControl，basic 可见）
    expect(within(pimg).getAllByText('Agent可填').length).toBeGreaterThan(0); // x-agent 徽标保留
    fireEvent.click(within(pimg).getByRole('button', { name: /测试连通/ }));
    await waitFor(() => expect(api.testProvider).toHaveBeenCalledWith(COMFY_IMAGE_PROVIDER.id));
    await waitFor(() => expect(within(pimg).getByText('代码体检通过（未真实调用上游）')).toBeTruthy());
  });

  it('生成源节点：换源写 provider_id / provider / kind / definition / model（参数回到默认）', async () => {
    const host: CanvasHost = { updateNodeData: vi.fn() };
    const { container } = await setup(host);
    const pimg = nodeEl(container, 'pimg');
    await waitFor(() => expect(within(pimg).getByRole('option', { name: /ComfyUI \(本地\/云端\)/ })).toBeTruthy());
    fireEvent.change(within(pimg).getByLabelText('选择生成源'), { target: { value: 'comfyui' } });
    expect(host.updateNodeData).toHaveBeenCalledWith('pimg', expect.objectContaining({
      provider_id: 'comfyui', provider: 'comfyui', kind: 'image', definition: BUILTIN_IMAGE, model: '', params: {}, default_params: {},
    }));
  });

  it('扩展节点「运行节点」：经宿主 execute，overrides 带上声明端口 video 的上游值', async () => {
    const host: CanvasHost = { execute: vi.fn(async () => {}) };
    const { container } = await setup(host);
    await waitFor(() => expect(handles(nodeEl(container, 'ext1'))).toContain('in:video'));
    fireEvent.click(within(nodeEl(container, 'ext1')).getByRole('button', { name: /运行节点/ }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledWith('ext1', { video: '/storage/videos/in.mp4' }));
  });

  it('代码节点「运行节点」：overrides 带 input_schema 端口值；文本口未连线时可在卡片里填（写端口 id 键）', async () => {
    const host: CanvasHost = { execute: vi.fn(async () => {}), updateNodeData: vi.fn() };
    const { container } = await setup(host);
    const cus = nodeEl(container, 'cus1');
    await waitFor(() => expect(within(cus).getByLabelText('文本输入')).toBeTruthy());
    fireEvent.change(within(cus).getByLabelText('文本输入'), { target: { value: '更清晰' } });
    expect(host.updateNodeData).toHaveBeenCalledWith('cus1', { prompt: '更清晰' });
    fireEvent.click(within(cus).getByRole('button', { name: /运行节点/ }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledWith('cus1', { video: '/storage/videos/in.mp4' }));
  });

  it('剧本拆解「一键拆解」：把上游简报与画风 / 画幅作为 overrides 交给宿主；简报节点编辑写 brief', async () => {
    const host: CanvasHost = { execute: vi.fn(async () => {}), updateNodeData: vi.fn() };
    const { container } = await setup(host);
    fireEvent.click(within(nodeEl(container, 'split1')).getByRole('button', { name: /一键拆解并生成分镜卡/ }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledWith('split1', { brief: '雨夜，少年拔剑。', style_preset: 'japanese_anime', aspect_ratio: '16:9' }));
    fireEvent.change(within(nodeEl(container, 'brief1')).getByLabelText('简报内容'), { target: { value: '新的简报' } });
    expect(host.updateNodeData).toHaveBeenCalledWith('brief1', { brief: '新的简报' });
  });

  it('剧本拆解显示结果摘要（宿主写回的 result）', async () => {
    const view = render(
      <div style={{ width: 1000, height: 800 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={[{ id: 's', type: 'script-split', position: at(0), data: { result: { characters: [{}, {}], scenes: [{ shots: [{}, {}, {}] }, { shots: [{}] }] } } }]} edges={[]} nodeTypes={nodeTypesMap()} />
        </ReactFlowProvider>
      </div>,
    );
    await act(async () => {});
    expect(screen.getByText(/2 角色 · 4 镜 已生成/)).toBeTruthy();
    view.unmount();
  });
});
