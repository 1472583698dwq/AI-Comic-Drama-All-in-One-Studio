// REQ-toonflow-canvas T3 · 精简舞台 createMiniStage 的编排逻辑（jsdom 无 WebGL：用假渲染器替掉 WebGLRenderer）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    static instances: FakeWebGLRenderer[] = [];
    domElement: HTMLCanvasElement;
    shadowMap = { enabled: false, type: 0 };
    toneMapping = 0;
    toneMappingExposure = 1;
    autoClear = true;
    renders = 0;
    disposed = false;
    contextLost = false;
    constructor(params: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement = params.canvas || document.createElement('canvas');
      FakeWebGLRenderer.instances.push(this);
    }
    setSize() {}
    setPixelRatio() {}
    setClearColor() {}
    clear() {}
    setViewport() {}
    setScissor() {}
    setScissorTest() {}
    render() { this.renders++; }
    dispose() { this.disposed = true; }
    forceContextLoss() { this.contextLost = true; }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { createMiniStage, type MiniStage } from '../stageCore';
import { framingCameraState } from '../camera';

const W = 640;
const H = 480;

/** zoom ≠ 1 模拟祖先 CSS transform 缩放（React Flow 画布）：布局尺寸不变，屏幕 rect 按比例缩放并平移 */
function makeContainer(zoom = 1, left = 0, top = 0) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: H, configurable: true });
  const w = W * zoom;
  const h = H * zoom;
  el.getBoundingClientRect = () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const fire = (target: EventTarget, type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra }));

function screenOf(stage: MiniStage, obj: THREE.Object3D) {
  stage.scene.updateMatrixWorld(true);
  stage.camera.updateMatrixWorld(true);
  const ndc = obj.getWorldPosition(new THREE.Vector3()).project(stage.camera);
  return { x: ((ndc.x + 1) / 2) * W, y: ((1 - ndc.y) / 2) * H };
}

describe('scene/stageCore · createMiniStage', () => {
  let stage: MiniStage | null = null;
  let container: HTMLDivElement;

  beforeEach(() => { container = makeContainer(); });
  afterEach(() => { stage?.dispose(); stage = null; container.remove(); });

  it('按站位放布偶、按景别放机位，并立即渲染一帧', () => {
    stage = createMiniStage(container, { castLayout: 'duel', pose: 'fight', framing: 'full', focalLength: 28 });
    expect(stage.listEntities()).toEqual(['entity_protagonist', 'entity_antagonist']);
    expect(stage.getEntity('entity_antagonist')!.position.z).toBeCloseTo(-2.3, 9);
    const want = framingCameraState('full', 28);
    const got = stage.getCameraState();
    got.position.forEach((n, i) => expect(n).toBeCloseTo(want.position[i], 6));
    expect(got.target).toEqual(want.target);
    expect(got.fov).toBeCloseTo(want.fov, 9);
    expect(container.querySelector('canvas')).toBe(stage.renderer.domElement);
    expect((stage.renderer as any).renders).toBeGreaterThan(0);
  });

  it('拖关节：选中回调 + 拖完回调该布偶的关节姿态（与 3D 片场同一套拾取/限位）', () => {
    const onSelect = vi.fn();
    const onJointsChange = vi.fn();
    stage = createMiniStage(container, { castLayout: 'solo', pose: 'stand', framing: 'full', onSelect, onJointsChange });
    const before = stage.getJoints('entity_protagonist');
    const ball = stage.getEntity('entity_protagonist')!.getObjectByName('jointpick_shoulder_L')!;
    const p = screenOf(stage, ball);
    const el = stage.renderer.domElement;
    fire(el, 'pointerdown', p.x, p.y, { button: 0 });
    expect(onSelect).toHaveBeenCalledWith('entity_protagonist', 'shoulder_L');
    fire(el, 'pointermove', p.x + 30, p.y + 40, { buttons: 1 });
    fire(el, 'pointerup', p.x + 30, p.y + 40);
    expect(onJointsChange).toHaveBeenCalledTimes(1);
    const [entity, joints] = onJointsChange.mock.calls[0];
    expect(entity).toBe('entity_protagonist');
    expect(joints).toEqual(stage.getJoints('entity_protagonist'));
    expect(joints.shoulder_L).not.toEqual(before.shoulder_L);
  });

  it('REQ-toonflow-canvas C1：容器被 CSS 缩放（画布 zoom 0.6 / 2）且画幅留边时，按屏幕坐标仍能拾取到关节', () => {
    for (const zoom of [0.6, 2]) {
      const scaled = makeContainer(zoom, 37, 21);
      const onSelect = vi.fn();
      // 640×480 容器里 16:9 画幅 → 帧区域布局坐标 (0, 60) 起、640×360
      const s = createMiniStage(scaled, { castLayout: 'solo', pose: 'stand', framing: 'full', aspect: 16 / 9, onSelect });
      try {
        const ball = s.getEntity('entity_protagonist')!.getObjectByName('jointpick_elbow_R')!;
        s.scene.updateMatrixWorld(true);
        s.camera.updateMatrixWorld(true);
        const ndc = ball.getWorldPosition(new THREE.Vector3()).project(s.camera);
        const x = 37 + ((ndc.x + 1) / 2) * 640 * zoom;
        const y = 21 + 60 * zoom + ((1 - ndc.y) / 2) * 360 * zoom;
        fire(s.renderer.domElement, 'pointerdown', x, y, { button: 0 });
        expect(onSelect).toHaveBeenCalledWith('entity_protagonist', 'elbow_R');
        fire(s.renderer.domElement, 'pointerup', x, y);
      } finally {
        s.dispose();
        scaled.remove();
      }
    }
  });

  it('空白处拖动 = 轨道旋转（半径不变）并回调机位；单击空白回调取消选中', () => {
    const onCameraChange = vi.fn();
    const onSelect = vi.fn();
    stage = createMiniStage(container, { framing: 'medium', onCameraChange, onSelect });
    const s0 = stage.getCameraState();
    const r0 = new THREE.Vector3(...s0.position).distanceTo(new THREE.Vector3(...s0.target));
    const el = stage.renderer.domElement;
    fire(el, 'pointerdown', 10, 10, { button: 0 });
    fire(el, 'pointermove', 60, 20, { buttons: 1 });
    fire(el, 'pointerup', 60, 20);
    expect(onCameraChange).toHaveBeenCalledTimes(1);
    const s1 = onCameraChange.mock.calls[0][0];
    expect(s1.position).not.toEqual(s0.position);
    expect(new THREE.Vector3(...s1.position).distanceTo(new THREE.Vector3(...s1.target))).toBeCloseTo(r0, 6);
    fire(el, 'pointerdown', 10, 10, { button: 0 });
    fire(el, 'pointerup', 10, 10);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('机位读写往返；applyFraming 用 3D 片场景别表', () => {
    const onCameraChange = vi.fn();
    stage = createMiniStage(container, { onCameraChange });
    stage.setCameraState({ position: [1, 2, 3], target: [0, 1, 0], fov: 33, roll: 4 });
    const s = stage.getCameraState();
    s.position.forEach((n, i) => expect(n).toBeCloseTo([1, 2, 3][i], 9));
    expect(s).toMatchObject({ target: [0, 1, 0], fov: 33, roll: 4 });
    expect(onCameraChange).toHaveBeenCalledTimes(1);
    const f = stage.applyFraming('close_up', 50);
    expect(f).toEqual(framingCameraState('close_up', 50));
    stage.setCameraState(f, { silent: true });
    expect(onCameraChange).toHaveBeenCalledTimes(2);
  });

  it('mannequin_pose 读写（与 3D 片场 agent-stage-patch 同语义）：给到的实体叠加姿态、没给到的复位；setCast 重建站位', () => {
    stage = createMiniStage(container, { castLayout: 'duel', pose: 'cast_spell' });
    const preset = stage.getJoints('entity_protagonist');
    expect(preset.shoulder_L).toEqual([-1.35, 0, 0.42]);
    stage.applyMannequinPose({ v: 1, entities: { entity_protagonist: { joints: { neck: [0.3, 0.5, 0] } } } });
    const pose = stage.getMannequinPose();
    expect(pose.entities.entity_protagonist.joints).toEqual({ ...preset, neck: [0.3, 0.5, 0] });
    expect(pose.entities.entity_antagonist.joints).toEqual({});
    stage.setCast('surrounded', 'stand', pose.entities);
    expect(stage.listEntities()).toEqual(['entity_protagonist', 'entity_antagonist', 'entity_supporting']);
    expect(stage.getJoints('entity_protagonist')).toEqual(pose.entities.entity_protagonist.joints);
    stage.setJoints('entity_supporting', { knee_L: [1, 0, 0] });
    expect(stage.getJoints('entity_supporting')).toEqual({ knee_L: [1, 0, 0] });
    stage.resetJoints();
    expect(stage.getJoints('entity_protagonist')).toEqual({});
  });

  it('导出尺寸按画幅；snapshotPNG 走离屏渲染器并释放上下文', async () => {
    stage = createMiniStage(container, { aspect: 9 / 16 });
    expect(stage.exportSize()).toEqual({ width: 720, height: 1280 });
    expect(stage.exportSize({ longEdge: 1001 })).toEqual({ width: 564, height: 1002 });
    expect(stage.exportSize({ width: 101, height: 57 })).toEqual({ width: 102, height: 58 });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([`${this.width}x${this.height}`], { type: type || 'image/png' }));
    });
    const Fake = (THREE as any).WebGLRenderer;
    const n0 = Fake.instances.length;
    const blob = await stage.snapshotPNG({ longEdge: 640 });
    expect(blob.type).toBe('image/png');
    expect(toBlob).toHaveBeenCalledTimes(1);
    const off = Fake.instances[n0];
    expect(off.renders).toBe(1);
    expect(off.disposed && off.contextLost).toBe(true);
  });

  it('recordCameraPath：不支持 MediaRecorder 时明确报错；支持时产出视频 Blob', async () => {
    stage = createMiniStage(container, {});
    const kf = [
      { time: 0, camera: framingCameraState('medium') },
      { time: 0.15, camera: framingCameraState('close_up') },
    ];
    await expect(stage.recordCameraPath(kf, 0.15)).rejects.toThrow(/不支持视频录制/);

    const started: string[] = [];
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === 'video/webm';
      state: 'inactive' | 'recording' = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_s: unknown, o: { mimeType: string }) { started.push(o.mimeType); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['frames'], { type: 'video/webm' }) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    (HTMLCanvasElement.prototype as any).captureStream = () => ({ getTracks: () => [] });
    try {
      const progress: number[] = [];
      const blob = await stage.recordCameraPath(kf, 0.15, 30, { onProgress: (p) => progress.push(p) });
      expect(started).toEqual(['video/webm']);
      expect(blob.type).toBe('video/webm');
      expect(blob.size).toBeGreaterThan(0);
      expect(progress[progress.length - 1]).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      delete (HTMLCanvasElement.prototype as any).captureStream;
    }
  });

  it('REQ-toonflow-canvas C1 recordCameraPath：首帧起点机位、末帧终点机位；末帧后不再出帧，等探针看到末帧离开采集管线再停录', async () => {
    stage = createMiniStage(container, {});
    const main = stage.renderer;
    const kf = [
      { time: 0, camera: framingCameraState('medium') },
      { time: 0.2, camera: framingCameraState('close_up') },
    ];
    const LAG = 350; // 模拟机器忙：采集管线落后 350ms
    let streamAt = 0;
    let controller: ReadableStreamDefaultController<{ timestamp: number; close(): void }> | null = null;
    const draws: { at: number; fov: number }[] = [];
    let finalDeliveredAt = 0;
    let stopAt = 0;
    const enqueue = (tsMs: number, isFinal: () => boolean) => setTimeout(() => {
      if (isFinal()) finalDeliveredAt = performance.now();
      try { controller?.enqueue({ timestamp: tsMs * 1000, close() {} }); } catch { /* 探针已关闭 */ }
    }, LAG);
    const Fake = (THREE as any).WebGLRenderer;
    const origRender = Fake.prototype.render;
    Fake.prototype.render = function (this: any, _scene: unknown, cam: THREE.PerspectiveCamera) {
      origRender.call(this);
      if (this === main || !streamAt) return;
      const at = performance.now();
      draws.push({ at, fov: cam.fov });
      const idx = draws.length - 1;
      enqueue(at - streamAt, () => idx === draws.length - 1 && Math.abs(cam.fov - kf[1].camera.fov) < 1e-9);
    };
    class FakeProcessor {
      readable = new ReadableStream<{ timestamp: number; close(): void }>({ start(c) { controller = c; } });
    }
    class FakeRecorder {
      static isTypeSupported = (t: string) => t === 'video/mp4';
      state: 'inactive' | 'recording' = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { stopAt = performance.now(); this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['mp4'], { type: 'video/mp4' }) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor);
    (HTMLCanvasElement.prototype as any).captureStream = () => {
      streamAt = performance.now();
      enqueue(0, () => false); // 建流时采集到的首帧（起点机位）
      return { getTracks: () => [], getVideoTracks: () => [{ clone: () => ({ stop() {} }) }] };
    };
    try {
      const blob = await stage.recordCameraPath(kf, 0.2, 30);
      expect(blob.type).toBe('video/mp4');
      const fovMedium = framingCameraState('medium').fov;
      const fovClose = kf[1].camera.fov;
      expect(draws[0].fov).toBeCloseTo(fovMedium, 9);
      const last = draws[draws.length - 1];
      expect(last.fov).toBeCloseTo(fovClose, 9);
      // 末帧落在「运镜时长 − 1 帧」：成片时长 = 末帧时间戳 + 一帧 = 运镜时长
      expect(last.at - streamAt).toBeGreaterThanOrEqual(200 - 1000 / 30 - 1);
      expect(last.at - streamAt).toBeLessThan(200 + 40);
      // 停录发生在末帧送达之后（旧逻辑末帧后 66ms 就停，落后 350ms 的末帧会被丢掉）
      expect(finalDeliveredAt).toBeGreaterThan(0);
      expect(stopAt).toBeGreaterThanOrEqual(finalDeliveredAt);
      expect(stopAt - last.at).toBeLessThan(LAG + 1500);
      // 末帧之后没有再画新帧（画面不变就不产生新帧，成片不会变长）
      expect(draws.filter((d) => d.at > last.at)).toHaveLength(0);
    } finally {
      Fake.prototype.render = origRender;
      vi.unstubAllGlobals();
      delete (HTMLCanvasElement.prototype as any).captureStream;
    }
  });

  it('dispose 移除画布并释放渲染器', () => {
    const s = createMiniStage(container, {});
    const r = s.renderer as any;
    s.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    expect(r.disposed && r.contextLost).toBe(true);
    expect(() => s.dispose()).not.toThrow();
  });
});
