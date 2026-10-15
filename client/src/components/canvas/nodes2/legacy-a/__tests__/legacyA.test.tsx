// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 独有节点换皮 A：注册 / 端口（对照 nodeRegistry.NODE_SPECS + 旧组件渲染的句柄）/ 动态端口 / 渲染冒烟与关键行为。
 * 真实 <ReactFlow> 渲染（jsdom 补齐布局 API，同 kit/__tests__/skeleton.test.tsx）；apiService 全部 mock，不连后端。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { IconFileText, IconMusic, IconVideo } from '@tabler/icons-react';

vi.mock('../../../../../services/api', () => ({
  apiService: {
    listWorkflows: vi.fn(),
    inspectWorkflow: vi.fn(),
    generateShotImage: vi.fn(),
    generateShotVideo: vi.fn(),
    getVideoTaskStatus: vi.fn(),
    exportJianYingDraft: vi.fn(),
    timelineEngine: vi.fn(),
    mergeTimeline: vi.fn(),
    getTimelineTask: vi.fn(),
    exportTimelineDraft: vi.fn(),
    openFolder: vi.fn(),
    saveProjectContent: vi.fn(),
    listAssets: vi.fn(),
  },
}));

import { apiService } from '../../../../../services/api';
import { useProjectStore } from '../../../../../stores/useProjectStore';
import { useCanvasStore } from '../../../../../stores/useCanvasStore';
import { toast } from '../../../../../stores/useDialogStore';
import { NODE_SPECS } from '../../../__tests__/fixtures/legacyNodeSpecs';
import {
  CanvasHostProvider, NodeSkeleton, defineNode, findPort, getNodeDef, nodeTypesMap, paletteDefs, resolvePorts, type CanvasHost, type PortDef,
} from '../../../kit';
import { LEGACY_A_TYPES, ShotWriteBackControls, exposedDefaults, shotCardPorts, upstreamMedia } from '../index';
import { NO_SHOTS_MESSAGE } from '../TimelineExportNode';

const api = apiService as unknown as Record<string, Mock>;

// —— jsdom 环境补齐（React Flow 官方测试指引同款 + 媒体 / canvas 桩）——
class RO {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(target: Element) { this.cb([{ target, contentRect: { width: 1200, height: 900 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
class DMR { m22 = 1; constructor(t?: string) { const s = t?.match(/scale\(([\d.]+)\)/)?.[1]; this.m22 = s ? Number(s) : 1; } }

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 100; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 220; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
  HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function pause() {};
  HTMLMediaElement.prototype.load = function load() {};
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', RO);
  vi.stubGlobal('DOMMatrixReadOnly', DMR);
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('测试环境不联网'))));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  api.listWorkflows.mockResolvedValue({ workflows: [] });
  api.inspectWorkflow.mockResolvedValue({ data: { exposed_inputs: [] } });
  api.timelineEngine.mockResolvedValue({ ffmpeg: true, ffprobe: true, jianyin: false, available: true, ffmpeg_hint: '', draft_hint: '' });
  useProjectStore.setState({ project: null });
  useCanvasStore.setState({ agentFocusNodeIds: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// —— 测试用上游节点（只为造连线，不进工具栏）——
const SimpleNode = (props: NodeProps) => <NodeSkeleton node={props}>上游</NodeSkeleton>;
defineNode({ type: 'la-test-video', label: '测试视频', icon: IconVideo, category: 'video', ports: [{ id: 'video', type: 'source', dataType: 'VIDEO' }], component: SimpleNode, inPalette: false });
defineNode({ type: 'la-test-audio', label: '测试音频', icon: IconMusic, category: 'audio', ports: [{ id: 'audio', type: 'source', dataType: 'AUDIO' }], component: SimpleNode, inPalette: false });
defineNode({ type: 'la-test-text', label: '测试文本', icon: IconFileText, category: 'text', ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }], component: SimpleNode, inPalette: false });

/** 宿主桥：updateNodeData 记录调用并真正写进（非受控）React Flow。 */
function HostBridge({ spy, children, extra }: { spy: Mock; children: ReactNode; extra?: Partial<CanvasHost> }) {
  const rf = useReactFlow();
  const host = useMemo<CanvasHost>(() => ({
    updateNodeData: (id, patch) => { spy(id, patch); rf.updateNodeData(id, patch); },
    ...extra,
  }), [rf, spy, extra]);
  return <CanvasHostProvider value={host}>{children}</CanvasHostProvider>;
}

function renderCanvas(nodes: Node[], edges: Edge[] = [], extra?: Partial<CanvasHost>) {
  const spy = vi.fn();
  const utils = render(
    <div style={{ width: 1200, height: 900 }}>
      <ReactFlowProvider>
        <HostBridge spy={spy} extra={extra}>
          <ReactFlow className="cv-canvas" defaultNodes={nodes} defaultEdges={edges} nodeTypes={nodeTypesMap()} />
        </HostBridge>
      </ReactFlowProvider>
    </div>,
  );
  const nodeEl = (id: string) => utils.container.querySelector(`.react-flow__node[data-id="${id}"] .cv-node`) as HTMLElement;
  const handleIds = (id: string, side: 'target' | 'source') =>
    Array.from(nodeEl(id).querySelectorAll(`.cv-handle.${side}`)).map((h) => h.getAttribute('data-handleid'));
  return { ...utils, spy, nodeEl, handleIds };
}

const patchesFor = (spy: Mock, id: string) => spy.mock.calls.filter((c) => c[0] === id).map((c) => c[1] as Record<string, unknown>);
const TYPE_MAP: Record<string, string> = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', text: 'STRING' };

describe('注册与工具栏成员', () => {
  it('5 个类型全部注册，工具栏成员同现状（export / timeline 进，其余兼容节点不进）', () => {
    for (const t of LEGACY_A_TYPES) expect(getNodeDef(t), t).toBeTruthy();
    const palette = paletteDefs().map((d) => d.type);
    expect(palette).toEqual(expect.arrayContaining(['export', 'timeline']));
    for (const t of ['shot-card', 'comfy-workflow', 'timeline-export']) expect(palette).not.toContain(t);
    expect(getNodeDef('timeline')!.width).toBe(560);
    expect(getNodeDef('shot-card')!.width).toBe(300);
    expect(getNodeDef('comfy-workflow')!.width).toBe(340);
    expect(getNodeDef('timeline-export')!.width).toBe(360);
  });
});

describe('端口：id / 方向 / 类型对照 NODE_SPECS（image/video/audio/text → IMAGE/VIDEO/AUDIO/STRING）', () => {
  it.each([...LEGACY_A_TYPES])('%s', (type) => {
    const ports = resolvePorts(getNodeDef(type), { data: {} });
    const spec = NODE_SPECS[type];
    expect(spec, `NODE_SPECS 缺 ${type}`).toBeTruthy();
    for (const [side, list] of [['target', spec.inputs], ['source', spec.outputs]] as const) {
      for (const h of list) {
        const p = ports.find((x) => x.type === side && x.id === h.id);
        expect(p, `${type} 缺 ${side} 口 ${h.id}`).toBeTruthy();
        expect(p!.dataType).toBe(TYPE_MAP[h.type]);
      }
    }
  });

  it('旧组件额外渲染的具名句柄也保留：comfy-workflow 的 prompt 入 / image 出、timeline-export 的 shots 入', () => {
    const comfy = resolvePorts(getNodeDef('comfy-workflow'), { data: {} });
    expect(comfy.find((p) => p.type === 'target' && p.id === 'prompt')?.dataType).toBe('STRING');
    expect(comfy.find((p) => p.type === 'source' && p.id === 'image')?.dataType).toBe('IMAGE');
    const tle = resolvePorts(getNodeDef('timeline-export'), { data: {} });
    expect(tle.find((p) => p.type === 'target' && p.id === 'shots')?.dataType).toBe('STRING');
  });

  it('没有 handle id 的旧连线落到每侧第一个端口（旧组件的无 id 句柄）', () => {
    const node = { data: {} };
    expect(findPort(getNodeDef('comfy-workflow'), node, null, 'target')?.id).toBe('reference');
    expect(findPort(getNodeDef('comfy-workflow'), node, null, 'source')?.id).toBe('image');
    expect(findPort(getNodeDef('timeline-export'), node, null, 'target')?.id).toBe('shots');
    expect(findPort(getNodeDef('timeline'), node, null, 'target')?.id).toBe('video');
    expect(findPort(getNodeDef('export'), node, null, 'target')?.id).toBe('video');
  });
});

describe('shot-card 动态端口（生成源 input_schema → 输入口）', () => {
  const targets = (ports: PortDef[]) => ports.filter((p) => p.type === 'target').map((p) => `${p.id}:${p.dataType}`);

  it('x-handle / uri 数组属性生成输入口，截到 6 个后重复 id 只留第一个；非媒体属性忽略', () => {
    const data = {
      definition: {
        input_schema: {
          properties: {
            prompt: { type: 'string', 'x-handle': 'text' },
            first_frame: { type: 'string', format: 'uri', 'x-handle': 'image' },
            ref_audio: { type: 'string', format: 'uri', 'x-handle': 'audio' },
            seed: { type: 'integer' },
          },
        },
      },
    };
    const ports = resolvePorts(getNodeDef('shot-card'), { data });
    // [provider, reference, prompt, character, prompt(重复), first_frame].slice(0,6) → 去重
    expect(targets(ports)).toEqual(['provider:IMAGE', 'reference:IMAGE', 'prompt:STRING', 'character:STRING', 'first_frame:IMAGE']);
    expect(ports.filter((p) => p.type === 'source').map((p) => p.id)).toEqual(['image', 'video', 'shot']);
  });

  it('providerDef 优先于 definition；无 x-handle 的 uri 数组按键名猜类型', () => {
    const data = {
      providerDef: { input_schema: { properties: { ref_audio: { type: 'string', 'x-handle': 'audio' }, motion_videos: { type: 'array', items: { type: 'string', format: 'uri' } } } } },
      definition: { input_schema: { properties: { other_image: { type: 'string', 'x-handle': 'image' } } } },
    };
    expect(targets(shotCardPorts(data))).toEqual([
      'provider:IMAGE', 'reference:IMAGE', 'prompt:STRING', 'character:STRING', 'ref_audio:AUDIO', 'motion_videos:VIDEO',
    ]);
    expect(targets(shotCardPorts({}))).toHaveLength(4);
  });

  it('画布上按动态端口渲染 handle', async () => {
    const data = { definition: { input_schema: { properties: { first_frame: { type: 'string', 'x-handle': 'image' } } } } };
    const { handleIds } = renderCanvas([{ id: 'sc', type: 'shot-card', position: { x: 0, y: 0 }, data }]);
    await act(async () => {});
    expect(handleIds('sc', 'target')).toEqual(['provider', 'reference', 'prompt', 'character', 'first_frame']);
    expect(handleIds('sc', 'source')).toEqual(['image', 'video', 'shot']);
  });
});

describe('shot-card 渲染与行为', () => {
  it('标题「分镜卡 #镜号」、徽章、字幕；空提示词不调用生成', async () => {
    const warn = vi.spyOn(toast, 'warning');
    const { nodeEl } = renderCanvas([{
      id: 'sc', type: 'shot-card', position: { x: 0, y: 0 },
      data: { shot_index: 3, provider: 'seedream-very-long-provider', camera_framing: 'close', subtitle_text: '台词', image_url: 'http://x/a.png' },
    }]);
    await act(async () => {});
    const el = nodeEl('sc');
    expect(el.style.width).toBe('300px');
    expect(el.querySelector('.cv-node__label')?.textContent).toBe('分镜卡 #3');
    expect(within(el).getByTitle('seedream-very-long-provider').textContent).toBe('seedream-ver');
    expect(within(el).getByText('close · push_in')).toBeTruthy();
    expect(within(el).getByText('台词')).toBeTruthy();
    expect(el.querySelector('img')?.getAttribute('src')).toBe('http://x/a.png');
    fireEvent.click(within(el).getByText('生成首帧'));
    expect(warn).toHaveBeenCalledWith('请填写画面提示词');
    expect(api.generateShotImage).not.toHaveBeenCalled();
  });

  it('生成首帧 / 生视频（任务轮询）写回 image_url / video_url；挂载人物与场景徽章来自项目分镜', async () => {
    useProjectStore.setState({
      project: {
        id: 'p1', aspect_ratio: '16:9', style_preset: 'donghua_xianxia',
        scenes: [{ shots: [{ id: 'shot-1', character_ids: ['c1'], scene_name: '雨夜街道' }] }],
        characters: [{ id: 'c1', name: '阿青', three_views: { front: 'http://x/c1.png' } }],
      } as never,
    });
    api.generateShotImage.mockResolvedValue({ image_url: '/storage/images/first.png' });
    api.generateShotVideo.mockResolvedValue({ video_url: '', task_id: 'task-1' });
    api.getVideoTaskStatus.mockResolvedValue({ status: 'SUCCESS', video_url: '/storage/videos/v.mp4' });
    const { nodeEl, spy } = renderCanvas([{
      id: 'sc', type: 'shot-card', position: { x: 0, y: 0 },
      data: { shotId: 'shot-1', image_prompt: 'a girl in rain', provider_id: 'seedream', model: 'm1', workflow_id: 'wf_1' },
    }]);
    await act(async () => {});
    const el = nodeEl('sc');
    // 只点卡片里的按钮（点过之后节点被选中，浮动工具栏里也有同名按钮）
    const card = el.querySelector('.cv-node__card') as HTMLElement;
    expect(within(el).getByText('阿青')).toBeTruthy();
    expect(within(el).getByText('雨夜街道')).toBeTruthy();

    fireEvent.change(within(el).getByLabelText('画面动作描述'), { target: { value: '回眸' } });
    expect(patchesFor(spy, 'sc')).toContainEqual({ action_desc: '回眸' });

    await act(async () => { fireEvent.click(within(card).getByText('生成首帧')); });
    expect(api.generateShotImage).toHaveBeenCalledWith({
      prompt: 'a girl in rain', aspect_ratio: '16:9', style_preset: 'donghua_xianxia', workflow_id: 'wf_1',
      dynamic_inputs: undefined, provider: 'seedream', model: 'm1',
    });
    expect(patchesFor(spy, 'sc')).toContainEqual({ image_url: '/storage/images/first.png' });

    await act(async () => { fireEvent.click(within(card).getByText('生视频')); });
    await waitFor(() => expect(patchesFor(spy, 'sc')).toContainEqual({ video_url: '/storage/videos/v.mp4' }));
    expect(api.generateShotVideo).toHaveBeenCalledWith({
      prompt: '回眸', mode: 'i2v', first_frame_url: '/storage/images/first.png', duration: 5, provider: 'seedream',
    });
    await waitFor(() => expect(within(el).getByText('视频已生成')).toBeTruthy());
  });
});

describe('comfy-workflow：工作流列表 + 暴露输入表单（动态端口区）', () => {
  const EXPOSED = [
    { id: 'img_10', node_id: '10', type: 'image', label: '参考垫图 (LoadImage)' },
    { id: 'num_3_steps', node_id: '3', type: 'number', label: '步数', default_value: 20 },
    { id: 'combo_4_ckpt', node_id: '4', type: 'combo', label: '模型', options: ['a.safetensors', 'b.safetensors'], default_value: 'a.safetensors' },
    { id: 'txt_7', node_id: '7', type: 'text', label: '触发词', description: '额外 LoRA 触发词' },
  ];

  it('exposedDefaults 只补没填过的键', () => {
    expect(exposedDefaults(EXPOSED, { num_3_steps: 8 })).toEqual({ combo_4_ckpt: 'a.safetensors' });
  });

  it('列出工作流、按 exposed_inputs 生成表单；改值带上默认值写回；参数与诊断派发全局事件；生成写 result_url', async () => {
    api.listWorkflows.mockResolvedValue({ workflows: [
      { id: 'wf_a', name: '角色立绘', source: 'internal', node_count: 7 },
      { id: 'ext_b', name: '外部流', source: 'external', node_count: 3 },
    ] });
    api.inspectWorkflow.mockResolvedValue({ status: 'success', data: { exposed_inputs: EXPOSED } });
    api.generateShotImage.mockResolvedValue({ image_url: '/storage/images/comfy.png' });
    const events: unknown[] = [];
    const onInspector = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('open-workflow-inspector', onInspector);
    const { nodeEl, spy, handleIds } = renderCanvas([{
      id: 'cf', type: 'comfy-workflow', position: { x: 0, y: 0 }, data: { workflow_id: 'wf_a', dynamic_inputs: { txt_7: 'hello' } },
    }]);
    await act(async () => {});
    const el = nodeEl('cf');
    expect(handleIds('cf', 'target')).toEqual(['reference', 'prompt']);
    expect(handleIds('cf', 'source')).toEqual(['image', 'video']);
    expect(api.listWorkflows).toHaveBeenCalledWith('all');
    expect(api.inspectWorkflow).toHaveBeenCalledWith('wf_a');

    const select = within(el).getByLabelText('选择工作流') as HTMLSelectElement;
    expect(select.value).toBe('wf_a');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      '— 选择工作流 (内部/外部直读) —', '角色立绘 (内部) · 7节点', '外部流 (外部) · 3节点',
    ]);
    expect(within(el).getByText('已绑定')).toBeTruthy();
    expect(within(el).getByText('4 个暴露输入')).toBeTruthy();

    const form = within(el).getByRole('group', { name: '暴露输入' });
    expect(Array.from(form.querySelectorAll('[data-exposed]')).map((x) => x.getAttribute('data-exposed'))).toEqual(['img_10', 'num_3_steps', 'combo_4_ckpt', 'txt_7']);
    expect(within(form).getByText('上传垫图')).toBeTruthy();
    expect((within(form).getByLabelText('步数') as HTMLInputElement).value).toBe('20');
    const combo = within(form).getByLabelText('模型') as HTMLSelectElement;
    expect(combo.value).toBe('a.safetensors');
    expect(Array.from(combo.options).map((o) => o.value)).toEqual(['', 'a.safetensors', 'b.safetensors']);
    const txt = within(form).getByLabelText('触发词') as HTMLInputElement;
    expect(txt.value).toBe('hello');
    expect(txt.placeholder).toBe('额外 LoRA 触发词');

    fireEvent.change(within(form).getByLabelText('步数'), { target: { value: '25' } });
    expect(patchesFor(spy, 'cf')).toContainEqual({ dynamic_inputs: { num_3_steps: 25, combo_4_ckpt: 'a.safetensors', txt_7: 'hello' } });

    fireEvent.click(within(el).getByText('参数与诊断'));
    expect(events).toEqual([{ workflowId: 'wf_a' }]);
    window.removeEventListener('open-workflow-inspector', onInspector);

    await act(async () => { fireEvent.click(within(el).getByText('使用此工作流生成')); });
    expect(api.generateShotImage).toHaveBeenCalledWith({
      prompt: 'masterpiece, high quality', workflow_id: 'wf_a', aspect_ratio: '9:16',
      dynamic_inputs: { num_3_steps: 25, combo_4_ckpt: 'a.safetensors', txt_7: 'hello' },
    });
    expect(patchesFor(spy, 'cf')).toContainEqual({
      result_url: '/storage/images/comfy.png', dynamic_inputs: { num_3_steps: 25, combo_4_ckpt: 'a.safetensors', txt_7: 'hello' },
    });
    await waitFor(() => expect(within(el).getByAltText('工作流生成结果').getAttribute('src')).toBe('/storage/images/comfy.png'));

    fireEvent.change(select, { target: { value: 'ext_b' } });
    expect(patchesFor(spy, 'cf')).toContainEqual({ workflow_id: 'ext_b' });
    await waitFor(() => expect(api.inspectWorkflow).toHaveBeenCalledWith('ext_b'));
  });

  it('垫图值是 ComfyUI 文件名（工作流默认值）时显示文件名标签，是 URL 时显示缩略图', async () => {
    api.inspectWorkflow.mockResolvedValue({ data: { exposed_inputs: [
      { id: 'img_10', node_id: '10', type: 'image', label: '垫图A', default_value: 'ref.png' },
      { id: 'img_12', node_id: '12', type: 'image', label: '垫图B' },
    ] } });
    const { nodeEl } = renderCanvas([{
      id: 'cf', type: 'comfy-workflow', position: { x: 0, y: 0 }, data: { workflow_id: 'wf_a', dynamic_inputs: { img_12: '/storage/images/b.png' } },
    }]);
    await act(async () => {});
    const a = nodeEl('cf').querySelector('[data-exposed="img_10"]') as HTMLElement;
    const b = nodeEl('cf').querySelector('[data-exposed="img_12"]') as HTMLElement;
    expect(a.querySelector('img')).toBeNull();
    expect(within(a).getByTitle('ref.png').textContent).toBe('ref.png');
    expect(b.querySelector('img')?.getAttribute('src')).toBe('/storage/images/b.png');
    expect(within(b).getByText('更换')).toBeTruthy();
  });

  it('未选工作流不生成；主提示词为空时用 prompt 口上游文本', async () => {
    const warn = vi.spyOn(toast, 'warning');
    api.generateShotImage.mockResolvedValue({ image_url: '/x.png' });
    const { nodeEl } = renderCanvas(
      [
        { id: 'txt', type: 'la-test-text', position: { x: 0, y: 0 }, data: { prompt: '上游的提示词' } },
        { id: 'cf', type: 'comfy-workflow', position: { x: 400, y: 0 }, data: {} },
        { id: 'cf2', type: 'comfy-workflow', position: { x: 400, y: 600 }, data: { workflow_id: 'wf_a' } },
      ],
      [{ id: 'e1', source: 'txt', sourceHandle: 'prompt', target: 'cf2', targetHandle: 'prompt' }],
    );
    await act(async () => {});
    const btn = within(nodeEl('cf')).getByText('使用此工作流生成').closest('button')!;
    expect(btn.disabled).toBe(true);
    expect(within(nodeEl('cf')).getByText('未选择')).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(nodeEl('cf2')).getByText('使用此工作流生成')); });
    expect(api.generateShotImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: '上游的提示词', workflow_id: 'wf_a' }));
  });
});

describe('timeline', () => {
  it('upstreamMedia：旧宿主 _upstream 单值 + 入边参考，去重保持顺序', () => {
    const refs = [
      { key: 'v|video', sourceId: 'v', sourceHandle: 'video', dataType: 'VIDEO' as const, value: '/s/a.mp4' },
      { key: 'a|audio', sourceId: 'a', sourceHandle: 'audio', dataType: 'AUDIO' as const, value: '/s/b.mp3' },
      { key: 't|prompt', sourceId: 't', sourceHandle: 'prompt', dataType: 'STRING' as const, value: 'x' },
    ];
    expect(upstreamMedia({ _upstream: { video: '/s/a.mp4' } }, refs)).toEqual([
      { kind: 'video', url: '/s/a.mp4' }, { kind: 'audio', url: '/s/b.mp3' },
    ]);
    expect(upstreamMedia({ video_url: '/s/c.mp4' }, [])).toEqual([{ kind: 'video', url: '/s/c.mp4' }]);
  });

  it('宽 560、video / audio 输入口；上游连线自动入列并记 _ingested，已入列过的不再加回', async () => {
    const { nodeEl, spy, handleIds } = renderCanvas(
      [
        { id: 'v', type: 'la-test-video', position: { x: 0, y: 0 }, data: { video_url: '/storage/videos/a.mp4' } },
        { id: 'a', type: 'la-test-audio', position: { x: 0, y: 300 }, data: { audio_url: '/storage/audio/b.mp3' } },
        { id: 'v2', type: 'la-test-video', position: { x: 0, y: 600 }, data: { video_url: '/storage/videos/old.mp4' } },
        { id: 'tl', type: 'timeline', position: { x: 400, y: 0 }, data: { label: '', _ingested: ['video:/storage/videos/old.mp4'] } },
      ],
      [
        { id: 'e1', source: 'v', sourceHandle: 'video', target: 'tl', targetHandle: 'video' },
        { id: 'e2', source: 'a', sourceHandle: 'audio', target: 'tl', targetHandle: 'audio' },
        { id: 'e3', source: 'v2', sourceHandle: 'video', target: 'tl', targetHandle: 'video' },
      ],
    );
    await act(async () => {});
    expect(nodeEl('tl').style.width).toBe('560px');
    expect(handleIds('tl', 'target')).toEqual(['video', 'audio']);
    const patch = patchesFor(spy, 'tl').find((p) => Array.isArray(p.clips))!;
    expect(patch).toBeTruthy();
    const clips = patch.clips as Array<{ url: string; kind: string }>;
    expect(clips.map((c) => `${c.kind}:${c.url}`)).toEqual(['video:/storage/videos/a.mp4', 'audio:/storage/audio/b.mp3']);
    expect(patch._ingested).toEqual(['video:/storage/videos/old.mp4', 'video:/storage/videos/a.mp4', 'audio:/storage/audio/b.mp3']);
    // 只入列一次（写回后 pending 为空，不再触发）
    expect(patchesFor(spy, 'tl').filter((p) => Array.isArray(p.clips))).toHaveLength(1);
    // 标题 = 成片名前缀：无自定义名时取项目名，再退「时间线」
    expect(nodeEl('tl').querySelector('.cv-node__label')?.textContent).toBe('时间线');
  });

  it('选中显示预览与浮动工具栏；导出成片提交 /timeline/merge；全屏 → 全屏编辑器；折叠 / 展开写 data.collapsed', async () => {
    useProjectStore.setState({ project: { id: 'p9', title: '樱花', aspect_ratio: '9:16', scenes: [], characters: [] } as never });
    api.mergeTimeline.mockResolvedValue({ status: 'success', task_id: 'tl_1', clips: 2, duration: 6, stage: '排队' });
    api.getTimelineTask.mockResolvedValue({ task_id: 'tl_1', status: 'running', stage: '合成', progress: 40 });
    const clips = [
      { id: 'c1', url: '/storage/videos/a.mp4', name: 'a.mp4', duration: 3, in: 0, out: 3, kind: 'video' },
      { id: 'c2', url: '/storage/videos/b.mp4', name: 'b.mp4', duration: 3, in: 0, out: 3, kind: 'video' },
    ];
    const { nodeEl, spy } = renderCanvas([{ id: 'tl', type: 'timeline', position: { x: 0, y: 0 }, selected: true, data: { clips } }]);
    await act(async () => {});
    const el = nodeEl('tl');
    expect(el.querySelector('.cv-node__label')?.textContent).toBe('樱花');
    expect(within(el).getByTestId('timeline-preview')).toBeTruthy();
    expect(el.querySelectorAll('.cv-la-tl__clip')).toHaveLength(2);
    expect(within(el).getByLabelText('播放头 / 总时长').textContent).toBe('00:00.0/00:06.0');
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    expect(within(top).getByText('添加素材')).toBeTruthy();

    await act(async () => { fireEvent.click(within(el).getByLabelText('导出成片')); });
    expect(api.mergeTimeline).toHaveBeenCalledWith({ clips, title: '樱花_6s成片', project_id: 'p9', aspect_ratio: '9:16' });

    fireEvent.click(within(top).getByLabelText('全屏'));
    await waitFor(() => expect(document.body.querySelector('.fixed.inset-0')).toBeTruthy());

    fireEvent.click(within(el).getByLabelText('折叠时间线'));
    expect(patchesFor(spy, 'tl')).toContainEqual({ collapsed: true });
    await waitFor(() => expect(within(nodeEl('tl')).getByText('时间线已折叠')).toBeTruthy());
    fireEvent.click(within(nodeEl('tl')).getByLabelText('展开时间线'));
    expect(patchesFor(spy, 'tl')).toContainEqual({ collapsed: false });
  });
});

describe('timeline-export / export', () => {
  it('timeline-export：无分镜提示；优先用上游项目导出并写 lastResult、展示结果', async () => {
    api.exportJianYingDraft.mockResolvedValue({ total_shots: 3, duration_seconds: 12, export_dir: '/tmp/draft', warnings: ['w1', 'w2', 'w3'] });
    const upstreamProject = { scenes: [{ shots: [{ id: 's1' }] }] };
    const { nodeEl, spy, handleIds } = renderCanvas([
      { id: 'te', type: 'timeline-export', position: { x: 0, y: 0 }, data: {} },
      { id: 'te2', type: 'timeline-export', position: { x: 0, y: 500 }, data: { _upstream: { project: upstreamProject } } },
    ]);
    await act(async () => {});
    expect(handleIds('te', 'target')).toEqual(['shots', 'videos', 'audios']);
    await act(async () => { fireEvent.click(within(nodeEl('te')).getByText('一键导出剪映草稿')); });
    expect(within(nodeEl('te')).getByText(NO_SHOTS_MESSAGE)).toBeTruthy();
    expect(api.exportJianYingDraft).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(within(nodeEl('te2')).getByText('一键导出剪映草稿')); });
    expect(api.exportJianYingDraft).toHaveBeenCalledWith(upstreamProject);
    expect(patchesFor(spy, 'te2')).toContainEqual({ lastResult: { total_shots: 3, duration_seconds: 12, export_dir: '/tmp/draft', warnings: ['w1', 'w2', 'w3'] } });
    await waitFor(() => expect(within(nodeEl('te2')).getByText('导出成功 · 3 镜 · 12s')).toBeTruthy());
    expect(within(nodeEl('te2')).getByText('/tmp/draft')).toBeTruthy();
    expect(within(nodeEl('te2')).getByText('w1； w2')).toBeTruthy();
  });

  it('export：卡片 / 浮动工具栏的「配置导出选项」派发 open-export-modal；会话标签跟随 agentFocusNodeIds', async () => {
    const onOpen = vi.fn();
    window.addEventListener('open-export-modal', onOpen);
    useCanvasStore.setState({ agentFocusNodeIds: ['ex'] });
    const { nodeEl, handleIds } = renderCanvas([{ id: 'ex', type: 'export', position: { x: 0, y: 0 }, selected: true, data: {} }]);
    await act(async () => {});
    const el = nodeEl('ex');
    expect(handleIds('ex', 'target')).toEqual(['video', 'audio']);
    expect(el.querySelector('.cv-node__label')?.textContent).toBe('导出草稿');
    expect(within(el).getByText('会话')).toBeTruthy();
    const buttons = within(el).getAllByText('配置导出选项');
    expect(buttons).toHaveLength(2); // 浮动工具栏 + 卡片
    buttons.forEach((b) => fireEvent.click(b));
    expect(onOpen).toHaveBeenCalledTimes(2);
    window.removeEventListener('open-export-modal', onOpen);
  });
});

describe('ShotWriteBackControls（换皮）', () => {
  it('有结果才显示；选镜后回写调用 updateShot，并经宿主记住 shotId', async () => {
    const updateShot = vi.fn();
    useProjectStore.setState({
      project: { id: 'p1', scenes: [{ scene_index: 1, shots: [{ id: 'shot-9', shot_index: 9 }] }], characters: [] } as never,
      updateShot,
    } as never);
    const success = vi.spyOn(toast, 'success');
    const spy = vi.fn();
    const { container, rerender } = render(
      <CanvasHostProvider value={{ updateNodeData: spy }}>
        <ShotWriteBackControls nodeId="n1" nodeType="image" data={{}} />
      </CanvasHostProvider>,
    );
    expect(container.textContent).toBe('');
    rerender(
      <CanvasHostProvider value={{ updateNodeData: spy }}>
        <ShotWriteBackControls nodeId="n1" nodeType="image" data={{ image_url: '/storage/i.png' }} />
      </CanvasHostProvider>,
    );
    const btn = screen.getByText('回写图片/首帧').closest('button')!;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('目标分镜'), { target: { value: 'shot-9' } });
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    expect(updateShot).toHaveBeenCalledWith('shot-9', expect.objectContaining({ image_url: '/storage/i.png', status: 'completed' }));
    expect(spy).toHaveBeenCalledWith('n1', { shotId: 'shot-9' });
    expect(success).toHaveBeenCalled();
  });
});
