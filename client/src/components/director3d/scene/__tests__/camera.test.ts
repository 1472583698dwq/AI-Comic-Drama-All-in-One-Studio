// REQ-toonflow-canvas T3 · 摄影机数学：轨道 / 运镜模拟 / 机位关键帧
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyCameraState,
  applyMotionFrame,
  applyOrbitToCamera,
  calculateMotionWaypoints,
  createOrbitState,
  framingCameraState,
  motionPresetKeyframes,
  normalizeKeyframes,
  orbitFromPose,
  readCameraState,
  sampleCameraKeyframes,
  type CameraKeyframe,
  type StageCameraState,
} from '../camera';
import { MOTION_PRESETS, focalLengthToFov } from '../presets';

const v = (t: [number, number, number]) => new THREE.Vector3(...t);
const dist = (a: [number, number, number], b: [number, number, number]) => v(a).distanceTo(v(b));

describe('scene/camera · 轨道', () => {
  it('初始轨道与 3D 片场一致；applyOrbitToCamera 后摄影机到 target 距离 = radius 并注视 target', () => {
    const o = createOrbitState();
    expect(o.target.toArray()).toEqual([0, 1.2, 0]);
    expect(o.radius).toBe(4.8);
    const cam = new THREE.PerspectiveCamera();
    applyOrbitToCamera(cam, o);
    expect(cam.position.distanceTo(o.target)).toBeCloseTo(4.8, 9);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    expect(dir.dot(o.target.clone().sub(cam.position).normalize())).toBeCloseTo(1, 6);
  });

  it('orbitFromPose 是 applyOrbitToCamera 的逆', () => {
    const cam = new THREE.PerspectiveCamera();
    const back = orbitFromPose([1.5, 2.2, -3], [0.2, 1, 0.4]);
    applyOrbitToCamera(cam, back);
    expect(cam.position.x).toBeCloseTo(1.5, 9);
    expect(cam.position.y).toBeCloseTo(2.2, 9);
    expect(cam.position.z).toBeCloseTo(-3, 9);
  });
});

describe('scene/camera · 运镜模拟（3D 片场 step 原逻辑）', () => {
  it('push_in 终点前推 0.95m；dolly_zoom 同时 FOV +22°；未模拟的运镜不动', () => {
    const start = new THREE.Vector3(0, 1.3, 2.4);
    const cam = new THREE.PerspectiveCamera(37);
    cam.position.copy(start);
    applyMotionFrame(cam, 'push_in', start, 37, 1, 1);
    expect(cam.position.z).toBeCloseTo(2.4 - 0.95, 9);
    applyMotionFrame(cam, 'dolly_zoom', start, 37, 0.5, 0.5);
    expect(cam.fov).toBeCloseTo(48, 9);
    const before = cam.position.clone();
    applyMotionFrame(cam, 'pan_left', start, 37, 1, 1);
    expect(cam.position.equals(before)).toBe(true);
  });

  it('震颤类使用注入的随机源', () => {
    const start = new THREE.Vector3(0, 1.3, 2.4);
    const cam = new THREE.PerspectiveCamera();
    applyMotionFrame(cam, 'shake', start, 35, 0.5, 0.5, () => 1);
    expect(cam.position.x).toBeCloseTo(0.06, 9);
    expect(cam.position.y).toBeCloseTo(1.36, 9);
  });

  it('轨迹预览路径点：环绕 7 点、推镜 3 点', () => {
    const s = new THREE.Vector3(0, 1.3, 2.4);
    const t = new THREE.Vector3(0, 1.25, 0);
    expect(calculateMotionWaypoints('orbit', s, t)).toHaveLength(7);
    expect(calculateMotionWaypoints('push_in', s, t)).toHaveLength(3);
  });
});

describe('scene/camera · 机位状态', () => {
  it('framingCameraState = 景别机位 + 焦距换算 FOV', () => {
    const s = framingCameraState('close_up', 50, 5);
    expect(s).toEqual({ position: [0, 1.55, 1.35], target: [0, 1.5, 0], fov: focalLengthToFov(50), roll: 5 });
  });

  it('applyCameraState / readCameraState 往返', () => {
    const cam = new THREE.PerspectiveCamera();
    const s: StageCameraState = { position: [1, 2, 3], target: [0, 1, 0], fov: 40, roll: 0 };
    applyCameraState(cam, s);
    expect(readCameraState(cam, s.target, 0)).toEqual(s);
  });
});

describe('scene/camera · 关键帧插值', () => {
  const A: StageCameraState = { position: [0, 1, 4], target: [0, 1, 0], fov: 40, roll: 0 };
  const B: StageCameraState = { position: [2, 3, 2], target: [1, 1, 0], fov: 20, roll: 10 };

  it('linear：中点取平均；越界夹到首尾', () => {
    const kf: CameraKeyframe[] = [{ time: 0, camera: A }, { time: 2, camera: B, easing: 'linear' }];
    const mid = sampleCameraKeyframes(kf, 1);
    expect(mid.position).toEqual([1, 2, 3]);
    expect(mid.target).toEqual([0.5, 1, 0]);
    expect(mid.fov).toBe(30);
    expect(mid.roll).toBe(5);
    expect(sampleCameraKeyframes(kf, -1).position).toEqual(A.position);
    expect(sampleCameraKeyframes(kf, 5).position).toEqual(B.position);
  });

  it('smooth 用 smoothstep，cut 到点硬切', () => {
    const smooth: CameraKeyframe[] = [{ time: 0, camera: A }, { time: 1, camera: B, easing: 'smooth' }];
    expect(sampleCameraKeyframes(smooth, 0.25).fov).toBeCloseTo(40 - 20 * (0.25 * 0.25 * (3 - 0.5)), 9);
    const cut: CameraKeyframe[] = [{ time: 0, camera: A }, { time: 1, camera: B, easing: 'cut' }];
    expect(sampleCameraKeyframes(cut, 0.99).position).toEqual(A.position);
    expect(sampleCameraKeyframes(cut, 1).position).toEqual(B.position);
  });

  it('normalizeKeyframes 排序并丢弃坏帧；空关键帧报错', () => {
    const n = normalizeKeyframes([{ time: 2, camera: B }, { time: 0, camera: A }, { time: NaN, camera: A }, null as any]);
    expect(n.map((k) => k.time)).toEqual([0, 2]);
    expect(() => sampleCameraKeyframes([], 0)).toThrow();
  });
});

describe('scene/camera · 运镜预设 → 关键帧', () => {
  const base = framingCameraState('medium', 35);

  it('push_in：首帧 = 当前机位，末帧沿视线前推 0.95m，时长按速度档', () => {
    const kf = motionPresetKeyframes('push_in', base, { speed: '2.0x', samples: 10 });
    expect(kf).toHaveLength(11);
    expect(kf[0].time).toBe(0);
    expect(kf[10].time).toBeCloseTo(1.2, 9);
    expect(kf[0].camera.position).toEqual(base.position);
    expect(dist(kf[10].camera.position, base.position)).toBeCloseTo(0.95, 6);
    expect(dist(kf[10].camera.position, base.target)).toBeLessThan(dist(base.position, base.target));
  });

  it('orbit：到注视点的水平距离不变；static 全程不动', () => {
    const kf = motionPresetKeyframes('orbit', base, { durationSec: 3 });
    const flat = (p: [number, number, number]) => Math.hypot(p[0] - base.target[0], p[2] - base.target[2]);
    for (const k of kf) expect(flat(k.camera.position)).toBeCloseTo(flat(base.position), 6);
    expect(kf[kf.length - 1].time).toBe(3);
    for (const k of motionPresetKeyframes('static', base)) expect(k.camera).toEqual({ ...base, roll: 0 });
  });

  it('所有内置运镜都能生成关键帧且可插值', () => {
    for (const m of MOTION_PRESETS) {
      const kf = motionPresetKeyframes(m.id, base, { rand: () => 0.5 });
      expect(kf.length).toBeGreaterThan(1);
      const s = sampleCameraKeyframes(kf, 1);
      expect(s.position.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(s.fov)).toBe(true);
    }
  });
});
