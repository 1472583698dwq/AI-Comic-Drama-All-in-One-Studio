// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 射线拾取 + 关节拖拽（原 Director3DStage 鼠标交互 effect 内的 pickRoot / pickJointAt /
 * 关节拖拽分支，原样抽成纯 three 函数）。3D 片场与画布 director3d 迷你舞台（stageCore）共用同一套逻辑：
 *   拾取球命中 → 找到挂在舞台实体组下的根实体 → 取其关节 rig 条目 → 拖拽时按世界轴增量旋转 → 欧拉限位钳制。
 */
import * as THREE from 'three';
import { clampJointAxis, type JointAxisLimits } from './mannequin';

/** 关节拖拽灵敏度（弧度 / 像素） */
export const JOINT_DRAG_SENSITIVITY = 0.012;

/** 客户区坐标 → NDC → 射线（rect 一般是渲染容器的 getBoundingClientRect()） */
export function raycasterAt(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  camera: THREE.Camera,
): THREE.Raycaster {
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  return raycaster;
}

/** 从命中的子网格向上找，直到父节点是舞台实体组为止（不校验最终父节点，与片场关节拾取一致） */
export function climbToStageChild(obj: THREE.Object3D, stageGroup: THREE.Object3D): THREE.Object3D | null {
  let cur: THREE.Object3D | null = obj;
  while (cur && cur.parent && cur.parent !== stageGroup) cur = cur.parent;
  return cur;
}

/** 射线命中的第一个「有名字的舞台实体」名；没有则 null（原 pickRoot） */
export function pickStageRoot(raycaster: THREE.Raycaster, stageGroup: THREE.Object3D): string | null {
  const intersects = raycaster.intersectObjects(stageGroup.children, true);
  for (const hit of intersects) {
    const cur = climbToStageChild(hit.object, stageGroup);
    if (cur && cur.name) return cur.name;
  }
  return null;
}

export interface JointHit {
  /** 实体名（布偶根节点 name，如 entity_protagonist） */
  entity: string;
  jointId: string;
  /** 被旋转的关节组 */
  group: THREE.Object3D;
  limits: JointAxisLimits;
}

/**
 * 射线命中的第一个可拖关节（原 pickJointAt）：只认 `userData.jointPick` 拾取球；
 * `isLocked(entity)` 为真（图层锁定）的实体跳过。
 */
export function pickJoint(
  raycaster: THREE.Raycaster,
  stageGroup: THREE.Object3D,
  isLocked?: (entity: string) => boolean,
): JointHit | null {
  const hits = raycaster.intersectObjects(stageGroup.children, true);
  for (const hit of hits) {
    const jointId = (hit.object.userData as any)?.jointPick as string | undefined;
    if (!jointId) continue;
    const cur = climbToStageChild(hit.object, stageGroup);
    const entity = cur?.name || '';
    if (!entity || (isLocked && isLocked(entity))) continue;
    const entry = (cur?.userData as any)?.mannequinJoints?.[jointId];
    if (!entry?.group) continue;
    return { entity, jointId, group: entry.group, limits: entry.limits || {} };
  }
  return null;
}

/**
 * REQ-toonflow-canvas 关节拖拽一步（原 onMouseMove 关节分支）：
 * - twist（Shift 拖）且横向为主：沿肢体扭转（局部 Y）；
 * - 否则：水平位移绕世界 Y 轴、竖直位移绕视角右轴旋转（换算到关节局部），再按 XYZ 欧拉限位钳制。
 * `viewCamera` 为空时只做水平旋转。
 */
export function dragRotateJoint(
  group: THREE.Object3D,
  limits: JointAxisLimits | undefined,
  dx: number,
  dy: number,
  twist: boolean,
  viewCamera: THREE.Camera | null | undefined,
  sensitivity = JOINT_DRAG_SENSITIVITY,
): void {
  const lim = limits || {};
  if (twist && Math.abs(dx) >= Math.abs(dy)) {
    group.rotation.y = clampJointAxis(group.rotation.y + dx * sensitivity, lim.y);
    return;
  }
  const applyWorld = (axis: THREE.Vector3, angle: number) => {
    if (!angle) return;
    const wq = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
    const pq = new THREE.Quaternion();
    (group.parent || group).getWorldQuaternion(pq);
    const localDelta = pq.clone().invert().multiply(wq).multiply(pq);
    group.quaternion.premultiply(localDelta);
  };
  applyWorld(new THREE.Vector3(0, 1, 0), dx * sensitivity);
  if (viewCamera) {
    const right = new THREE.Vector3().setFromMatrixColumn(viewCamera.matrixWorld, 0);
    applyWorld(right, dy * sensitivity);
  }
  const e2 = new THREE.Euler().setFromQuaternion(group.quaternion, 'XYZ');
  e2.x = clampJointAxis(e2.x, lim.x);
  e2.y = clampJointAxis(e2.y, lim.y);
  e2.z = clampJointAxis(e2.z, lim.z);
  group.quaternion.setFromEuler(e2);
}
