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

function makeContainer() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: H, configurable: true });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON() {} }) as DOMRect;
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

  it('dispose 移除画布并释放渲染器', () => {
    const s = createMiniStage(container, {});
    const r = s.renderer as any;
    s.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    expect(r.disposed && r.contextLost).toBe(true);
    expect(() => s.dispose()).not.toThrow();
  });
});
