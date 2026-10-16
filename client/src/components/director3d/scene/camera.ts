// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 摄影机数学（three，无 React）。
 *
 * 1. 导演视角轨道（原 Director3DStage `orbitStateRef` + `updateMainCameraPosition`）：球坐标 target/radius/theta/phi。
 * 2. 运镜预设模拟（原 `handleToggleSimulation` 每帧位移 / `calculateMotionWaypoints` 轨迹预览），3D 片场原样调用。
 * 3. 机位状态与关键帧（新增，给画布 director3d 节点 N5 用）：可序列化的 `StageCameraState`、
 *    Toonflow 风格的关键帧插值（linear/smooth/cut）、「运镜预设 → 关键帧」生成。
 */
import * as THREE from 'three';
import type { CameraMotion } from '../../../types';
import {
  easeMotionProgress,
  focalLengthToFov,
  framingCameraPose,
  motionDurationMs,
  type MotionEasing,
  type Vec3Tuple,
} from './presets';

// ============================================================
// 1. 导演视角轨道（球坐标）
// ============================================================

export interface OrbitState {
  isRotating: boolean;
  isPanning: boolean;
  prevX: number;
  prevY: number;
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
}

/** 3D 片场导演视角的初始轨道（与「重置视角」一致） */
export function createOrbitState(): OrbitState {
  return {
    isRotating: false,
    isPanning: false,
    prevX: 0,
    prevY: 0,
    target: new THREE.Vector3(0, 1.2, 0),
    radius: 4.8,
    theta: 0,
    phi: Math.PI / 3.0,
  };
}

/** 轨道 → 摄影机位置并注视 target（phi 只在计算时钳制，状态本身不改） */
export function applyOrbitToCamera(camera: THREE.Camera, orbit: Pick<OrbitState, 'target' | 'radius' | 'theta' | 'phi'>): void {
  const { target, radius, theta, phi } = orbit;
  const clampedPhi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
  const x = target.x + radius * Math.sin(clampedPhi) * Math.sin(theta);
  const y = target.y + radius * Math.cos(clampedPhi);
  const z = target.z + radius * Math.sin(clampedPhi) * Math.cos(theta);
  camera.position.set(x, y, z);
  camera.lookAt(target);
}

/** 反算：摄影机位置 + 注视点 → 轨道球坐标（applyOrbitToCamera 的逆） */
export function orbitFromPose(position: Vec3Tuple, target: Vec3Tuple): { target: THREE.Vector3; radius: number; theta: number; phi: number } {
  const t = new THREE.Vector3(...target);
  const off = new THREE.Vector3(...position).sub(t);
  const radius = Math.max(1e-6, off.length());
  const phi = Math.acos(Math.max(-1, Math.min(1, off.y / radius)));
  const theta = Math.atan2(off.x, off.z);
  return { target: t, radius, theta, phi };
}

/** 荷兰角（度）：沿用 3D 片场写法——lookAt 之后直接覆盖欧拉 z；0 时不动 */
export function applyCameraRoll(camera: THREE.Camera, rollDeg: number): void {
  if (rollDeg !== 0) camera.rotation.z = (rollDeg * Math.PI) / 180;
}

// ============================================================
// 2. 运镜预设模拟（3D 片场预演 / 录制 / 白模导出）
// ============================================================

/** 运镜轨迹预览路径点（原 calculateMotionWaypoints；虚线轨迹用 CatmullRom 穿过这些点） */
export function calculateMotionWaypoints(motionType: CameraMotion | string, startPos: THREE.Vector3, target: THREE.Vector3): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  points.push(startPos.clone());
  switch (motionType) {
    case 'push_in': points.push(startPos.clone().lerp(target, 0.45)); points.push(startPos.clone().lerp(target, 0.75)); break;
    case 'pull_out': points.push(new THREE.Vector3(startPos.x, startPos.y + 0.3, startPos.z + 1.2)); points.push(new THREE.Vector3(startPos.x, startPos.y + 0.6, startPos.z + 2.4)); break;
    case 'orbit': { const r = startPos.distanceTo(target); for (let i = 1; i <= 6; i++) { const angle = (i / 6) * Math.PI * 0.9; points.push(new THREE.Vector3(target.x + r * Math.sin(angle), startPos.y, target.z + r * Math.cos(angle))); } break; }
    case 'orbit_boom_up': { const r = startPos.distanceTo(target); for (let i = 1; i <= 6; i++) { const angle = (i / 6) * Math.PI * 0.9; points.push(new THREE.Vector3(target.x + r * Math.sin(angle), startPos.y + (i / 6) * 1.5, target.z + r * Math.cos(angle))); } break; }
    case 'truck_left': points.push(new THREE.Vector3(startPos.x - 0.8, startPos.y, startPos.z)); points.push(new THREE.Vector3(startPos.x - 1.6, startPos.y, startPos.z)); break;
    case 'truck_right': points.push(new THREE.Vector3(startPos.x + 0.8, startPos.y, startPos.z)); points.push(new THREE.Vector3(startPos.x + 1.6, startPos.y, startPos.z)); break;
    case 'boom_up': points.push(new THREE.Vector3(startPos.x, startPos.y + 0.9, startPos.z)); points.push(new THREE.Vector3(startPos.x, startPos.y + 1.8, startPos.z)); break;
    case 'pan_left_crane_down': points.push(new THREE.Vector3(startPos.x - 1.0, startPos.y - 0.5, startPos.z)); points.push(new THREE.Vector3(startPos.x - 1.8, startPos.y - 1.0, startPos.z - 0.4)); break;
    default: points.push(startPos.clone().lerp(target, 0.5));
  }
  return points;
}

/**
 * 运镜模拟单帧（原 handleToggleSimulation 的 step 位移分支）：按缓动后进度 `ease` 改写摄影机位置/FOV。
 * 只覆盖 3D 片场实际模拟的运镜；其余运镜（pan/tilt/static…）不动摄影机。注视与荷兰角由调用方处理。
 * 注意：环绕类以 `startPos.z` 为半径、绕世界原点转（片场机位恒在 +z 轴上）——通用场景请用 `motionPresetKeyframes`。
 */
export function applyMotionFrame(
  cam: THREE.PerspectiveCamera,
  motion: CameraMotion | string,
  startPos: THREE.Vector3,
  startFov: number,
  ease: number,
  progress: number,
  rand: () => number = Math.random,
): void {
  if (motion === 'push_in') cam.position.z = startPos.z - ease * 0.95;
  else if (motion === 'pull_out') cam.position.z = startPos.z + ease * 1.3;
  else if (motion === 'orbit') { const angle = ease * Math.PI * 0.85; cam.position.x = Math.sin(angle) * startPos.z; cam.position.z = Math.cos(angle) * startPos.z; }
  else if (motion === 'orbit_boom_up') { const angle = ease * Math.PI * 0.85; cam.position.x = Math.sin(angle) * startPos.z; cam.position.z = Math.cos(angle) * startPos.z; cam.position.y = startPos.y + ease * 1.5; }
  else if (motion === 'dolly_zoom') { cam.position.z = startPos.z - ease * 1.0; cam.fov = startFov + ease * 22; cam.updateProjectionMatrix(); }
  else if (motion === 'fast_push_shake') { cam.position.z = startPos.z - ease * 1.2; if (progress > 0.6) { cam.position.x = (rand() - 0.5) * 0.15; cam.position.y = startPos.y + (rand() - 0.5) * 0.15; } }
  else if (motion === 'truck_left') cam.position.x = startPos.x - ease * 1.5;
  else if (motion === 'truck_right') cam.position.x = startPos.x + ease * 1.5;
  else if (motion === 'boom_up') cam.position.y = startPos.y + ease * 1.6;
  else if (motion === 'shake') { cam.position.x = startPos.x + (rand() - 0.5) * 0.12; cam.position.y = startPos.y + (rand() - 0.5) * 0.12; }
}

// ============================================================
// 3. 可序列化机位 + 关键帧（画布 director3d 节点 N5）
// ============================================================

/** 可 JSON 序列化的机位：位置、注视点、垂直 FOV（度）、荷兰角（度） */
export interface StageCameraState {
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov: number;
  roll?: number;
}

/** 关键帧缓动（与 Toonflow cameraFrames 同名同义）：作用于「上一帧 → 本帧」这一段 */
export type KeyframeEasing = 'linear' | 'smooth' | 'cut';

export interface CameraKeyframe {
  /** 秒，从 0 开始、严格递增 */
  time: number;
  camera: StageCameraState;
  easing?: KeyframeEasing;
}

/** 把机位写到摄影机：position → fov → lookAt(target) → roll → updateProjectionMatrix */
export function applyCameraState(camera: THREE.PerspectiveCamera, state: StageCameraState): void {
  camera.position.set(state.position[0], state.position[1], state.position[2]);
  if (Number.isFinite(state.fov) && state.fov > 0) camera.fov = state.fov;
  camera.lookAt(state.target[0], state.target[1], state.target[2]);
  applyCameraRoll(camera, state.roll || 0);
  camera.updateProjectionMatrix();
}

/** 从摄影机 + 已知注视点读出机位（roll 由调用方记账，摄影机欧拉里读不准） */
export function readCameraState(camera: THREE.PerspectiveCamera, target: THREE.Vector3 | Vec3Tuple, rollDeg = 0): StageCameraState {
  const t = Array.isArray(target) ? target : [target.x, target.y, target.z];
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [t[0], t[1], t[2]] as Vec3Tuple,
    fov: camera.fov,
    roll: rollDeg,
  };
}

/** 景别 + 焦距 + 荷兰角 → 机位（与 3D 片场监视器的预设机位同一张表） */
export function framingCameraState(framing: string, focalLengthMm = 35, rollDeg = 0): StageCameraState {
  const pose = framingCameraPose(framing);
  return { position: pose.position, target: pose.target, fov: focalLengthToFov(focalLengthMm), roll: rollDeg };
}

/** 关键帧总时长（最后一帧时间；空数组为 0） */
export function cameraKeyframesDuration(keyframes: CameraKeyframe[]): number {
  return keyframes.length ? keyframes[keyframes.length - 1].time : 0;
}

/** 按时间排序并丢弃非法帧（不改入参） */
export function normalizeKeyframes(keyframes: CameraKeyframe[]): CameraKeyframe[] {
  return keyframes
    .filter((k) => k && Number.isFinite(k.time) && k.camera && Array.isArray(k.camera.position) && Array.isArray(k.camera.target))
    .slice()
    .sort((a, b) => a.time - b.time);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3Tuple => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * REQ-toonflow-canvas 关键帧插值（纯函数）：返回 `time` 秒处的机位。
 * 位置 / 注视点 / FOV / roll 线性插值；本帧 easing 为 smooth 时用 smoothstep，cut 时到点硬切；
 * 早于首帧取首帧、晚于末帧保持末帧。`keyframes` 须已按时间递增（见 normalizeKeyframes）。
 */
export function sampleCameraKeyframes(keyframes: CameraKeyframe[], time: number): StageCameraState {
  if (!keyframes.length) throw new Error('关键帧为空');
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (!(time > first.time)) return { ...first.camera, roll: first.camera.roll || 0 };
  if (time >= last.time) return { ...last.camera, roll: last.camera.roll || 0 };
  let i = 1;
  while (i < keyframes.length && keyframes[i].time < time) i++;
  const prev = keyframes[i - 1];
  const next = keyframes[i];
  const span = next.time - prev.time;
  let p = span > 0 ? Math.min(1, Math.max(0, (time - prev.time) / span)) : 1;
  const easing = next.easing || 'linear';
  if (easing === 'cut') p = time >= next.time ? 1 : 0;
  else if (easing === 'smooth') p = p * p * (3 - 2 * p);
  return {
    position: lerp3(prev.camera.position, next.camera.position, p),
    target: lerp3(prev.camera.target, next.camera.target, p),
    fov: lerp(prev.camera.fov, next.camera.fov, p),
    roll: lerp(prev.camera.roll || 0, next.camera.roll || 0, p),
  };
}

export interface MotionKeyframeOptions {
  /** 时长（秒）；默认按 3D 片场速度档 motionDurationMs(speed) */
  durationSec?: number;
  speed?: string;
  /** 缓动（3D 片场同名）：默认 ease_in_out */
  easing?: MotionEasing | string;
  /** 采样段数（关键帧数 = samples + 1），默认 24 */
  samples?: number;
  /** 震颤类运镜用的随机源（测试可注入确定值） */
  rand?: () => number;
}

/**
 * REQ-toonflow-canvas 运镜预设 → 关键帧（画布 director3d 节点导出 MP4 用）。
 * 与 3D 片场模拟同一套幅度（推 0.95m / 拉 1.3m / 环绕 0.85π / 横移 1.5m / 升 1.6m / 变焦 +22°…），
 * 但改为**相对当前机位**的摄影机坐标系（前 = 指向注视点、右 = 前×上），机位不在 +z 轴时也成立；
 * 片场未模拟的运镜按后端 MOTION_TRAJECTORY 幅度补齐（摇 ±35° / 俯仰 ±25° / 降 1.5m / 滚转 ±25° / 跟随 1.8m）。
 * 缓动已烘焙进采样点，所以返回帧的 easing 均为 linear。
 */
export function motionPresetKeyframes(motion: CameraMotion | string, base: StageCameraState, opts: MotionKeyframeOptions = {}): CameraKeyframe[] {
  const durationSec = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : motionDurationMs(opts.speed) / 1000;
  const samples = Math.max(1, Math.round(opts.samples ?? 24));
  const easing = opts.easing ?? 'ease_in_out';
  const rand = opts.rand ?? Math.random;
  const pos0 = new THREE.Vector3(...base.position);
  const tgt0 = new THREE.Vector3(...base.target);
  const up = new THREE.Vector3(0, 1, 0);
  const forward = tgt0.clone().sub(pos0);
  const dist = Math.max(1e-6, forward.length());
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, up);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const flatOffset = pos0.clone().sub(tgt0);
  const roll0 = base.roll || 0;
  const deg = Math.PI / 180;

  const at = (progress: number): StageCameraState => {
    const e = easeMotionProgress(progress, easing);
    const pos = pos0.clone();
    const tgt = tgt0.clone();
    let fov = base.fov;
    let roll = roll0;
    const yawAround = (center: THREE.Vector3, point: THREE.Vector3, angle: number) => point.sub(center).applyAxisAngle(up, angle).add(center);
    switch (motion) {
      case 'push_in': pos.addScaledVector(forward, Math.min(e * 0.95, dist * 0.9)); break;
      case 'pull_out': pos.addScaledVector(forward, -e * 1.3); break;
      case 'tracking': pos.addScaledVector(forward, Math.min(e * 1.8, dist * 0.9)); tgt.addScaledVector(forward, e * 1.8); break;
      case 'orbit': pos.copy(tgt0).add(flatOffset.clone().applyAxisAngle(up, e * Math.PI * 0.85)); break;
      case 'orbit_ccw': pos.copy(tgt0).add(flatOffset.clone().applyAxisAngle(up, -e * Math.PI * 0.85)); break;
      case 'orbit_boom_up': pos.copy(tgt0).add(flatOffset.clone().applyAxisAngle(up, e * Math.PI * 0.85)); pos.y += e * 1.5; break;
      case 'truck_left': pos.addScaledVector(right, -e * 1.5); tgt.addScaledVector(right, -e * 1.5); break;
      case 'truck_right': pos.addScaledVector(right, e * 1.5); tgt.addScaledVector(right, e * 1.5); break;
      case 'low_angle_truck_right': pos.addScaledVector(right, e * 1.6); tgt.addScaledVector(right, e * 1.6); break;
      case 'boom_up': pos.y += e * 1.6; tgt.y += e * 1.6; break;
      case 'boom_down': pos.y -= e * 1.5; tgt.y -= e * 1.5; break;
      case 'pan_left': yawAround(pos0, tgt, e * 35 * deg); break;
      case 'pan_right': yawAround(pos0, tgt, -e * 35 * deg); break;
      case 'tilt_up': tgt.addScaledVector(up, Math.tan(e * 25 * deg) * dist); break;
      case 'tilt_down': tgt.addScaledVector(up, -Math.tan(e * 25 * deg) * dist); break;
      case 'roll_left': roll = roll0 - e * 25; break;
      case 'roll_right': roll = roll0 + e * 25; break;
      case 'dolly_zoom': pos.addScaledVector(forward, Math.min(e * 1.0, dist * 0.9)); fov = base.fov + e * 22; break;
      case 'pan_left_crane_down': yawAround(pos0, tgt, e * 40 * deg); pos.y -= e * 1.6; tgt.y -= e * 1.6 * 0.5; break;
      case 'fast_push_shake':
        pos.addScaledVector(forward, Math.min(e * 1.2, dist * 0.9));
        if (progress > 0.6 && progress < 1) { pos.addScaledVector(right, (rand() - 0.5) * 0.15); pos.y += (rand() - 0.5) * 0.15; }
        break;
      case 'shake':
        if (progress > 0 && progress < 1) { pos.addScaledVector(right, (rand() - 0.5) * 0.12); pos.y += (rand() - 0.5) * 0.12; }
        break;
      default: break; // static / 未知（插件自定义）运镜：机位不动
    }
    return { position: [pos.x, pos.y, pos.z], target: [tgt.x, tgt.y, tgt.z], fov, roll };
  };

  const frames: CameraKeyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const progress = i / samples;
    frames.push({ time: Number((progress * durationSec).toFixed(4)), camera: at(progress), easing: 'linear' });
  }
  return frames;
}
