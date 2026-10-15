// REQ-toonflow-canvas N5 · 3D 导演节点渲染冒烟（真实 <ReactFlow>，舞台用假实现替换：jsdom 没有 WebGL）
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, useNodesState, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { IconFileText } from '@tabler/icons-react';
import type { StageCameraState } from '../../../../director3d/scene/camera';

// —— 假舞台：记录 createMiniStage 的入参与调用，机位 / 关节在内存里 ——
const fake = vi.hoisted(() => ({ stages: [] as any[] }));
vi.mock('../stageLoader', async () => {
  const cam = await vi.importActual<typeof import('../../../../director3d/scene/camera')>('../../../../director3d/scene/camera');
  class FakeStage {
    opts: any;
    container: HTMLElement;
    camState: StageCameraState;
    cast: { layout: string; pose: string; entities?: Record<string, { joints: Record<string, [number, number, number]> }> };
    env: string;
    aspect: number;
    setCastCalls: any[] = [];
    setCameraCalls: any[] = [];
    disposed = false;
    renderer: { domElement: HTMLCanvasElement; setPixelRatio: (n: number) => void };
    constructor(container: HTMLElement, opts: any) {
      this.container = container;
      this.opts = opts;
      this.camState = opts.camera ?? cam.framingCameraState(opts.framing ?? 'medium', opts.focalLength ?? 35, opts.cameraRoll ?? 0);
      this.cast = { layout: opts.castLayout, pose: opts.pose };
      this.env = opts.environment;
      this.aspect = opts.aspect;
      const canvas = document.createElement('canvas');
      canvas.toDataURL = () => `data:image/png;base64,${'A'.repeat(120)}`;
      this.renderer = { domElement: canvas, setPixelRatio: () => {} };
      container.appendChild(canvas);
    }
    render() {}
    invalidate() {}
    resize() {}
    setAspect(a: number) { this.aspect = a; }
    setEnvironment(e: string) { this.env = e; }
    setCast(layout: string, pose: string, entities?: any) { this.cast = { layout, pose, entities }; this.setCastCalls.push([layout, pose, entities]); }
    listEntities() { return this.cast.layout === 'solo' ? ['entity_protagonist'] : ['entity_protagonist', 'entity_antagonist']; }
    getMannequinPose() { return { v: 1, entities: this.cast.entities ?? {} }; }
    getCameraState() { return this.camState; }
    setCameraState(s: StageCameraState, o?: { silent?: boolean }) {
      this.camState = s;
      this.setCameraCalls.push([s, o]);
      if (!o?.silent) this.opts.onCameraChange?.(s);
    }
    snapshotPNG = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    recordCameraPath = vi.fn(async () => new Blob(['mp4'], { type: 'video/mp4' }));
    dispose() { this.disposed = true; this.renderer.domElement.remove(); }
  }
  const mod = {
    createMiniStage: (c: HTMLElement, o: any) => { const s = new FakeStage(c, o); fake.stages.push(s); return s; },
    framingCameraState: cam.framingCameraState,
    sampleCameraKeyframes: cam.sampleCameraKeyframes,
    normalizeKeyframes: cam.normalizeKeyframes,
    cameraKeyframesDuration: cam.cameraKeyframesDuration,
    motionPresetKeyframes: cam.motionPresetKeyframes,
    pickRecorderMimeType: () => 'video/mp4',
  };
  return { loadStageModule: () => Promise.resolve(mod) };
});
vi.mock('../exportMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../exportMedia')>()),
  uploadStageBlob: vi.fn(async () => '/storage/assets/ast_test/original.png'),
  uploadStageVideo: vi.fn(async () => '/storage/assets/ast_test/original.mp4'),
  measureVideoDuration: vi.fn(async () => 2.5),
}));

import { CanvasHostProvider, defineNode, nodeTypesMap, type CanvasHost, type PortDef } from '../../../kit';
import { NodeSkeleton } from '../../../kit';
import '../index';
import { DIRECTOR3D_PORTS } from '../index';
import { deriveCameraPrompt, roundCamera } from '../model';
import { resetStageSlots } from '../stageBudget';
import { uploadStageBlob, uploadStageVideo } from '../exportMedia';

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
  // jsdom 没有 2D canvas：缩略图返回空即可
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});
beforeEach(() => { fake.stages.length = 0; resetStageSlots(); });
afterEach(() => { cleanup(); });

// 上游文本节点（AI 规划会把它拼进导演指令）
const TEXT_PORTS: PortDef[] = [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }];
function TextNode(props: NodeProps) { return <NodeSkeleton node={props}>{String((props.data as { prompt?: string }).prompt ?? '')}</NodeSkeleton>; }
defineNode({ type: 'n5-test-text', label: '文本', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: TextNode, inPalette: false });

interface Patch { id: string; patch: Record<string, unknown> }
const latest: { nodes: Node[]; patches: Patch[]; update?: (id: string, patch: Record<string, unknown>) => void } = { nodes: [], patches: [] };

function Harness({ initial, edges = [], host = {} }: { initial: Node[]; edges?: Edge[]; host?: CanvasHost }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initial);
  latest.nodes = nodes;
  const value = useMemo<CanvasHost>(() => ({
    ...host,
    updateNodeData: (id, patch) => {
      latest.patches.push({ id, patch });
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  latest.update = value.updateNodeData;
  return (
    <div style={{ width: 1200, height: 900 }}>
      <ReactFlowProvider>
        <CanvasHostProvider value={value}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypesMap()} onNodesChange={onNodesChange} />
        </CanvasHostProvider>
      </ReactFlowProvider>
    </div>
  );
}

const d3Data = () => latest.nodes.find((n) => n.id === 'd3')!.data as Record<string, any>;
const nodeEl = (c: HTMLElement) => c.querySelector('.react-flow__node[data-id="d3"]') as HTMLElement;
async function mount(data: Record<string, unknown>, opts: { selected?: boolean; edges?: Edge[]; extra?: Node[]; host?: CanvasHost } = {}) {
  latest.patches = [];
  const initial: Node[] = [{ id: 'd3', type: 'director3d', position: { x: 300, y: 0 }, selected: opts.selected ?? true, data }, ...(opts.extra ?? [])];
  const r = render(<Harness initial={initial} edges={opts.edges} host={opts.host} />);
  await waitFor(() => expect(r.container.querySelector('.react-flow__node[data-id="d3"] .cv-d3__stage[data-stage-status="ready"]')).toBeTruthy());
  return r;
}

const LEGACY = { framing: 'close_up', motion: 'orbit', pose: 'fight', focal_length_mm: 50, cast_layout: 'duel', speed: '1.5x', ai_directive: '' };

describe('director3d 节点', () => {
  it('渲染冒烟：外壳标题、端口 id、旧数据自动补齐 camera_prompt、舞台按 data 挂载', async () => {
    const { container } = await mount({ ...LEGACY, minimax_camera_prompt: '[Camera: Motion: Orbit Clockwise 180°, Cinematic arc shot, Framing: Close Up, Lens: 50mm]' });
    const el = nodeEl(container);
    expect(el.querySelector('.cv-node__title')?.textContent).toContain('3D 导演');
    expect((el.querySelector('.cv-node') as HTMLElement).style.width).toBe('320px');
    expect([...el.querySelectorAll('.react-flow__handle')].map((h) => h.getAttribute('data-handleid'))).toEqual(DIRECTOR3D_PORTS.map((p) => p.id));
    expect(DIRECTOR3D_PORTS.find((p) => p.type === 'source')?.id).toBe('camera_prompt');

    const want = '[Camera: Motion: Orbit Clockwise, Framing: 特写 (CU), Lens: 50mm, Speed: 1.5x, Cast Staging: DUEL]';
    expect(el.querySelector('.cv-d3__prompt code')?.textContent).toBe(want);
    await waitFor(() => expect(d3Data().camera_prompt).toBe(want));
    expect(d3Data().minimax_camera_prompt).toBe(want);
    expect(latest.patches.find((p) => 'camera_prompt' in p.patch)?.patch).toEqual({ camera_prompt: want, minimax_camera_prompt: want });

    expect(fake.stages).toHaveLength(1);
    expect(fake.stages[0].opts).toMatchObject({ castLayout: 'duel', pose: 'fight', framing: 'close_up', focalLength: 50, environment: 'plain' });
    expect(fake.stages[0].opts.aspect).toBeCloseTo(16 / 9, 6);
    // 舞台容器不让画布抢拖拽 / 滚轮
    const stageBox = el.querySelector('.cv-d3__stage') as HTMLElement;
    expect(['nodrag', 'nopan', 'nowheel'].every((c) => stageBox.classList.contains(c))).toBe(true);
    // 选中：上方工具栏 + 下方面板
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    expect(within(top).getByLabelText('导出当前机位 PNG')).toBeTruthy();
    expect(within(top).getByLabelText(/导出 MP4/)).toBeTruthy();
    expect(within(top).getByLabelText('当前宿主未接入页面跳转')).toBeTruthy();
    expect(el.querySelector('.cv-node__slot--bottom .cv-prompt-card')).toBeTruthy();
  });

  it('预设 → camera_prompt 即时更新，景别跳到预设机位并回写 camera_state', async () => {
    const { container } = await mount({ ai_directive: '' });
    const el = nodeEl(container);
    fireEvent.click(within(el).getByRole('button', { name: /^景别：/ }));
    fireEvent.click(await screen.findByRole('option', { name: /全景 \(FS\)/ }));
    await waitFor(() => expect(d3Data().framing).toBe('full'));
    expect(d3Data().focal_length_mm).toBe(28);
    const want = deriveCameraPrompt({ framing: 'full', focal_length_mm: 28 });
    await waitFor(() => expect(el.querySelector('.cv-d3__prompt code')?.textContent).toBe(want));
    await waitFor(() => expect(d3Data().camera_prompt).toBe(want));
    const stage = fake.stages[0];
    await waitFor(() => expect(d3Data().camera_state).toBeTruthy());
    expect(d3Data().camera_state).toEqual(roundCamera(stage.getCameraState()));
    expect(stage.getCameraState().position).toEqual([0, 1.15, 3.8]);

    // 运镜 / 速度 / 站位
    fireEvent.click(within(el).getByRole('button', { name: /^运镜：/ }));
    fireEvent.click(await screen.findByRole('option', { name: /^右横移/ }));
    fireEvent.click(within(el).getByRole('button', { name: /^站位：/ }));
    fireEvent.click(await screen.findByRole('option', { name: /群戏包围/ }));
    await waitFor(() => expect(d3Data().camera_prompt).toBe(deriveCameraPrompt({ framing: 'full', focal_length_mm: 28, motion: 'truck_right', cast_layout: 'surrounded' })));
    expect(stage.cast.layout).toBe('surrounded');
  });

  it('关节 / 机位 / 关键帧写进 data；按存下的 data 重新挂载可还原', async () => {
    const r = await mount({ ai_directive: '' });
    const el = nodeEl(r.container);
    const stage = fake.stages[0];
    // 模拟舞台里拖了左肘
    stage.cast.entities = { entity_protagonist: { joints: { elbow_L: [-1.2, 0.1, 0] } } };
    act(() => { stage.opts.onJointsChange('entity_protagonist', { elbow_L: [-1.2, 0.1, 0] }); });
    expect(d3Data().mannequin_pose).toEqual({ v: 1, entities: { entity_protagonist: { joints: { elbow_L: [-1.2, 0.1, 0] } } } });
    // 模拟环绕后的机位（存 4 位小数）
    const orbit = { position: [1.234567, 1.4, 2.0001] as [number, number, number], target: [0, 1.25, 0] as [number, number, number], fov: 37.849312, roll: 0 };
    act(() => { stage.setCameraState(orbit); });
    expect(d3Data().camera_state).toEqual({ position: [1.2346, 1.4, 2.0001], target: [0, 1.25, 0], fov: 37.8493, roll: 0 });
    // 记录两个关键帧
    fireEvent.click(within(el).getByRole('button', { name: '添加关键帧（当前机位）' }));
    act(() => { stage.setCameraState({ ...orbit, position: [0, 1.3, 1.5] }); });
    fireEvent.click(within(el).getByRole('button', { name: '添加关键帧（当前机位）' }));
    await waitFor(() => expect(d3Data().keyframes).toHaveLength(2));
    const kfs = d3Data().keyframes;
    expect(kfs.map((k: any) => [k.time, k.easing])).toEqual([[0, 'smooth'], [1, 'smooth']]);
    expect(kfs[0].camera).toEqual({ position: [1.2346, 1.4, 2.0001], target: [0, 1.25, 0], fov: 37.8493, roll: 0 });
    expect(typeof kfs[0].id).toBe('string');
    expect(el.querySelectorAll('.cv-d3-kf__row')).toHaveLength(2);

    // 存盘 → 重新打开
    const saved = JSON.parse(JSON.stringify(d3Data()));
    r.unmount();
    expect(stage.disposed).toBe(true);
    const r2 = await mount(saved);
    const stage2 = fake.stages[1];
    expect(stage2.opts.camera).toEqual(saved.camera_state);
    expect(stage2.setCastCalls[0]).toEqual(['solo', 'stand', saved.mannequin_pose.entities]);
    expect(nodeEl(r2.container).querySelectorAll('.cv-d3-kf__row')).toHaveLength(2);
    expect(latest.patches.filter((p) => 'camera_prompt' in p.patch)).toHaveLength(0);
    // 换姿态预设：清掉自定义关节并按新姿态重建
    fireEvent.click(within(nodeEl(r2.container)).getByRole('button', { name: /^姿态：/ }));
    fireEvent.click(await screen.findByRole('option', { name: /御剑施法/ }));
    await waitFor(() => expect(d3Data().pose).toBe('cast_spell'));
    expect(d3Data().mannequin_pose).toBeUndefined();
    expect(stage2.setCastCalls.at(-1)).toEqual(['solo', 'cast_spell', undefined]);
  });

  it('AI 规划走宿主 execute（指令拼入上游文本）；「在 3D 片场打开」带分镜字段；导出 PNG 写 image_url 并新建图片节点', async () => {
    // 同 CreativeCanvas 的 director3d 分支：MCP 结果整体写回节点（含英文版 minimax_camera_prompt）
    const execute = vi.fn(async (nodeId: string) => {
      latest.update!(nodeId, { minimax_camera_prompt: '[Camera: Motion: Orbit Clockwise 180°, Framing: Low Angle, Lens: 28mm]', framing: 'low_angle', focal_length_mm: 28, motion: 'orbit', pose: 'fight', cast_layout: 'duel', speed: '1.5x', parse_mode: 'keyword', engine: 'minimax-01-director-camera-calculator' });
    });
    const navigate = vi.fn();
    const createNodes = vi.fn(() => ['new1']);
    const host: CanvasHost = { execute, navigate, createNodes, projectId: 'proj_test' };
    const { container } = await mount({ ...LEGACY, ai_directive: '{{ref 1}}，最后定格' }, {
      host,
      extra: [
        { id: 'txt', type: 'n5-test-text', position: { x: 0, y: 0 }, data: { prompt: '雨夜屋顶对峙' } },
        { id: 'vid', type: 'n5-test-text', position: { x: 800, y: 0 }, data: { shotId: 'shot_42' } },
      ],
      edges: [
        { id: 'e1', source: 'txt', sourceHandle: 'prompt', target: 'd3', targetHandle: 'in' },
        { id: 'e2', source: 'd3', sourceHandle: 'camera_prompt', target: 'vid', targetHandle: 'in' },
      ],
    });
    const el = nodeEl(container);
    fireEvent.click(within(el).getByRole('button', { name: 'AI 规划机位' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith('d3', {
      // 自身指令里的 {{ref 1}} → 参考 1，再附上该文本参考原文（与后端 inputs.py 的提示词拼装同规则）
      ai_directive: '参考 1，最后定格\n\n参考 1：\n雨夜屋顶对峙',
      framing: 'close_up', motion: 'orbit', pose: 'fight', focal_length_mm: 50, camera_roll_deg: 0, cast_layout: 'duel', speed: '1.5x',
    });
    await waitFor(() => expect(el.querySelector('.cv-d3__notice')?.textContent).toContain('AI 规划（关键词匹配）：景别 特写 (CU) → 贴地仰角，焦距 50 → 28mm'));
    // 参数变了 → 本地重算运镜提示词，覆盖 MCP 的英文版，两个键保持一致
    const want = deriveCameraPrompt({ ...LEGACY, framing: 'low_angle', focal_length_mm: 28 });
    await waitFor(() => expect(d3Data().camera_prompt).toBe(want));
    expect(d3Data().minimax_camera_prompt).toBe(want);
    expect(fake.stages[0].getCameraState().position).toEqual([0, 0.25, 1.8]);

    fireEvent.click(within(el).getByRole('button', { name: '在完整的 3D 片场里打开' }));
    expect(navigate).toHaveBeenCalledWith('director3d', expect.objectContaining({
      nodeId: 'd3',
      shotId: 'shot_42',
      shotPatch: expect.objectContaining({ camera_framing: 'low_angle', camera_motion: 'orbit', pose_preset: 'fight', cast_layout: 'duel', focal_length_mm: 28, motion_speed: '1.5x' }),
    }));

    fireEvent.click(within(el).getByRole('button', { name: '导出当前机位 PNG' }));
    await waitFor(() => expect(d3Data().image_url).toBe('/storage/assets/ast_test/original.png'));
    expect(fake.stages[0].snapshotPNG).toHaveBeenCalledWith({ longEdge: 1280 });
    expect(uploadStageBlob).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ projectId: 'proj_test', fileName: expect.stringMatching(/^director3d_\d{8}-\d{6}\.png$/) }));
    expect(createNodes).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'load-image', data: expect.objectContaining({ image_url: '/storage/assets/ast_test/original.png' }), position: expect.any(Object) })],
      expect.objectContaining({ anchorId: 'd3', select: false }),
    );
  });

  it('AI 规划：宿主没写回任何数据（旧宿主出错只弹窗）时提示失败', async () => {
    const execute = vi.fn(async () => {});
    const { container } = await mount({ ai_directive: '贴地仰角' }, { host: { execute } });
    const el = nodeEl(container);
    fireEvent.click(within(el).getByRole('button', { name: 'AI 规划机位' }));
    await waitFor(() => expect(el.querySelector('.cv-d3__notice')?.textContent).toContain('AI 规划没有返回结果'));
  });

  it('导出 MP4：无关键帧时按当前运镜预设录制（REQ-toonflow-canvas C1：按运镜时长原样录制，MP4 直接进素材库），写 video_url', async () => {
    const createNodes = vi.fn(() => ['v1']);
    const { container } = await mount({ ai_directive: '', export_new_node: false }, { host: { createNodes, projectId: 'proj_test' } });
    const el = nodeEl(container);
    fireEvent.click(within(el).getByRole('button', { name: /按运镜「急进推镜 \(Dolly In\)」导出 MP4/ }));
    await waitFor(() => expect(d3Data().video_url).toBe('/storage/assets/ast_test/original.mp4'));
    expect(fake.stages[0].recordCameraPath).toHaveBeenCalledTimes(1);
    const [frames, duration, fps, opts] = fake.stages[0].recordCameraPath.mock.calls[0];
    expect(frames.length).toBeGreaterThan(2);
    expect(duration).toBeCloseTo(2.5, 6);
    // 不再在末尾追加停留帧
    expect(frames.at(-1).time).toBeCloseTo(2.5, 6);
    expect(frames.at(-1).camera).not.toEqual(frames.at(-2).camera);
    expect(fps).toBe(30);
    expect(opts).toMatchObject({ longEdge: 1280 });
    expect(uploadStageVideo).toHaveBeenCalledWith(expect.any(Blob), 2.5, expect.objectContaining({ projectId: 'proj_test' }));
    expect(createNodes).not.toHaveBeenCalled();
    expect(el.querySelector('.cv-d3__notice')?.textContent).toContain('已导出运镜视频 MP4（2.5s');
  });
});
