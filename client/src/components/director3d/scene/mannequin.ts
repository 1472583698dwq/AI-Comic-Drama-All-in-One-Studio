// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 人体布偶（木偶关节人偶）与程序化 PBR 人体（原 Director3DStage 尾部函数，原样迁出）。
 *
 * - `createPoseMannequin`：3D 片场 / 画布 director3d 节点的初始角色。根节点 `userData.mannequinJoints`
 *   是关节 rig 注册表（jointId → { group, limits }），鼠标拖拽 / Agent stage_control / 姿态序列化共用这一张表；
 *   每个关节挂一个不可见拾取球（`jointpick_*`，`userData.jointPick = jointId`），供射线拾取。
 * - `serialize/apply/resetMannequinJoints`：关节姿态 ⇄ `MannequinJointPose`（分镜 `mannequin_pose` 落盘格式）。
 * - `createRealisticHuman`：旧的程序化 PBR 人体，目前只作道具 GLB 加载失败时的兜底。
 * 纯 three，不依赖 React。
 */
import * as THREE from 'three';
import type { PosePreset, MannequinJointPose } from '../../../types';

// ============================================================
// 程序化 PBR 人体（道具兜底保留；初始角色已换为人体布偶 createPoseMannequin）
// ============================================================
export function createRealisticHuman(opts: { pose: PosePreset; role: string; primaryColor: number; accentColor: number; name: string; hairColor: number }): THREE.Group {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffdcc2, roughness: 0.45, metalness: 0.02 });
  const skinShadowMat = new THREE.MeshStandardMaterial({ color: 0xe8b8a0, roughness: 0.55 });
  const clothMat = new THREE.MeshStandardMaterial({ color: opts.primaryColor, roughness: 0.35, metalness: 0.12 });
  const clothDarkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(opts.primaryColor).multiplyScalar(0.6).getHex(), roughness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: opts.accentColor, emissive: opts.accentColor, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.2 });
  const hairMat = new THREE.MeshStandardMaterial({ color: opts.hairColor, roughness: 0.7, metalness: 0.0 });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.1 });
  const irisColors: Record<string, number> = { protagonist: 0x4a90e2, antagonist: 0xff3b30, supporting: 0x34c759 };
  const irisMat = new THREE.MeshStandardMaterial({ color: irisColors[opts.role] || 0x4a90e2, emissive: irisColors[opts.role] || 0x4a90e2, emissiveIntensity: 0.15 });

  // 头部 - 颅骨
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 32, 32), skinMat);
  head.position.y = 1.68; head.castShadow = true; head.receiveShadow = true; group.add(head);
  // 面部阴影层（下颌）
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), skinShadowMat);
  jaw.position.set(0, 1.58, 0.06); jaw.scale.set(1, 0.8, 0.85); group.add(jaw);
  // 头发 - 半球 + 侧发
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.225, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
  hairCap.position.y = 1.72; hairCap.rotation.x = -0.08; group.add(hairCap);
  const hairBack = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.22, 16), hairMat);
  hairBack.position.set(0, 1.62, -0.08); group.add(hairBack);
  // 耳朵
  const earGeo = new THREE.SphereGeometry(0.045, 12, 12);
  const earL = new THREE.Mesh(earGeo, skinMat); earL.position.set(-0.19, 1.66, 0); earL.scale.set(0.6, 1.2, 0.8); group.add(earL);
  const earR = new THREE.Mesh(earGeo, skinMat); earR.position.set(0.19, 1.66, 0); earR.scale.set(0.6, 1.2, 0.8); group.add(earR);
  // 眼部
  const eyeGeo = new THREE.SphereGeometry(0.042, 16, 16);
  const eyeL = new THREE.Mesh(eyeGeo, eyeWhiteMat); eyeL.position.set(-0.075, 1.70, 0.17); eyeL.scale.set(1, 0.9, 0.6); group.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeWhiteMat); eyeR.position.set(0.075, 1.70, 0.17); eyeR.scale.set(1, 0.9, 0.6); group.add(eyeR);
  const pupilGeo = new THREE.SphereGeometry(0.022, 16, 16);
  const pupilL = new THREE.Mesh(pupilGeo, pupilMat); pupilL.position.set(-0.075, 1.70, 0.205); group.add(pupilL);
  const pupilR = new THREE.Mesh(pupilGeo, pupilMat); pupilR.position.set(0.075, 1.70, 0.205); group.add(pupilR);
  const irisGeo = new THREE.SphereGeometry(0.012, 12, 12);
  const irisL = new THREE.Mesh(irisGeo, irisMat); irisL.position.set(-0.075, 1.70, 0.215); group.add(irisL);
  const irisR = new THREE.Mesh(irisGeo, irisMat); irisR.position.set(0.075, 1.70, 0.215); group.add(irisR);
  // 眉毛
  const browGeo = new THREE.BoxGeometry(0.09, 0.015, 0.01);
  const browL = new THREE.Mesh(browGeo, hairMat); browL.position.set(-0.075, 1.735, 0.19); browL.rotation.z = 0.08; group.add(browL);
  const browR = new THREE.Mesh(browGeo, hairMat); browR.position.set(0.075, 1.735, 0.19); browR.rotation.z = -0.08; group.add(browR);
  // 鼻子
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 8), skinShadowMat); nose.position.set(0, 1.66, 0.21); nose.rotation.x = Math.PI; group.add(nose);
  // 嘴
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.008), new THREE.MeshStandardMaterial({ color: 0x8b3a3a, roughness: 0.6 })); mouth.position.set(0, 1.60, 0.20); group.add(mouth);

  // 颈部
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.14, 12), skinMat); neck.position.y = 1.48; group.add(neck);
  // 胸腔 + 服装
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.38, 0.24), clothMat); chest.position.y = 1.28; chest.castShadow = true; chest.receiveShadow = true; group.add(chest);
  const chestDark = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, 0.245), clothDarkMat); chestDark.position.y = 1.18; group.add(chestDark);
  // 腰带
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.26), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.4 })); belt.position.y = 1.02; group.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.055, 0.03), accentMat); buckle.position.set(0, 1.02, 0.135); group.add(buckle);
  // 胯部/下衣
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.18, 0.20), clothDarkMat); hips.position.y = 0.92; hips.castShadow = true; group.add(hips);

  // 手臂 - 上臂/前臂 用胶囊近似（圆柱+球端）
  const createArm = (isLeft: boolean, shoulderPos: THREE.Vector3, pose: PosePreset) => {
    const armGroup = new THREE.Group(); armGroup.position.copy(shoulderPos);
    const upperMat = clothMat;
    const skinArmMat = skinMat;
    // 上臂
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.32, 8, 16), isLeft ? upperMat : clothMat);
    upper.position.y = -0.18; upper.castShadow = true; armGroup.add(upper);
    // 肘关节
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), skinArmMat); elbow.position.y = -0.38; armGroup.add(elbow);
    // 前臂
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.30, 8, 16), skinArmMat);
    fore.position.y = -0.58; fore.castShadow = true; armGroup.add(fore);
    // 手
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), skinArmMat); hand.position.y = -0.78; hand.scale.set(1, 1.2, 0.7); armGroup.add(hand);
    // 手套/护腕
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.08, 12), accentMat); guard.position.y = -0.68; armGroup.add(guard);
    // 姿态驱动
    if (pose === 'fight') {
      if (isLeft) { armGroup.rotation.x = 1.0; armGroup.rotation.z = -0.6; armGroup.rotation.y = 0.3; }
      else { armGroup.rotation.x = 0.6; armGroup.rotation.z = 0.5; }
    } else if (pose === 'cast_spell') {
      armGroup.rotation.x = 0.9; armGroup.rotation.z = isLeft ? -0.4 : 0.4; armGroup.rotation.y = isLeft ? -0.2 : 0.2;
    } else if (pose === 'defend') {
      armGroup.position.z += 0.15; armGroup.rotation.x = 1.1; armGroup.rotation.z = isLeft ? -0.2 : 0.2;
    } else if (pose === 'run') {
      armGroup.rotation.x = isLeft ? 0.5 : -0.5; armGroup.rotation.z = isLeft ? -0.3 : 0.3;
    }
    return armGroup;
  };
  const leftArm = createArm(true, new THREE.Vector3(0.26, 1.38, 0), opts.pose);
  const rightArm = createArm(false, new THREE.Vector3(-0.26, 1.38, 0), opts.pose);
  group.add(leftArm); group.add(rightArm);

  // 腿部
  const createLeg = (isLeft: boolean) => {
    const legGroup = new THREE.Group();
    legGroup.position.set(isLeft ? 0.13 : -0.13, 0.83, 0);
    const thighMat = clothDarkMat;
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.38, 8, 16), thighMat); thigh.position.y = -0.22; thigh.castShadow = true; legGroup.add(thigh);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 12), skinMat); knee.position.y = -0.45; legGroup.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.36, 8, 16), skinMat); shin.position.y = -0.68; shin.castShadow = true; legGroup.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.24), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 })); foot.position.set(0, -0.92, 0.05); foot.castShadow = true; legGroup.add(foot);
    if (opts.pose === 'fight' || opts.pose === 'run') { legGroup.rotation.x = isLeft ? 0.25 : -0.2; legGroup.position.z += isLeft ? 0.15 : -0.12; }
    if (opts.pose === 'kneel') { if (!isLeft) { legGroup.rotation.x = -1.2; legGroup.position.y -= 0.15; } }
    if (opts.pose === 'fly') { legGroup.rotation.x = -0.4; legGroup.position.y += 0.1; }
    return legGroup;
  };
  group.add(createLeg(true)); group.add(createLeg(false));

  // 角色标识光环脚底
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.30, 32), new THREE.MeshBasicMaterial({ color: opts.accentColor, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.01; group.add(ring);
  return group;
}

// ============================================================
// 人体布偶（木偶关节人偶）— 3D 导演台初始角色模型
// 经典美术木偶造型：木质 PBR + 关节球 + 姿态预设驱动（站/斗/施法/奔跑/回眸/半跪/格挡/御风/战损）
// 结构分上半身组 + 四肢两级关节组，姿势可单独旋转各关节，不再靠整体缩放硬凑
// 交互：每个关节带不可见拾取球（jointpick_*），鼠标可直接拖拽旋转（Shift 拖=沿肢体扭转）
// ============================================================
export type JointAxisLimits = { x?: [number, number]; y?: [number, number]; z?: [number, number] };

/** 关节限位（弧度，XYZ 欧拉）— 与后端 app/director_stage/ops.py 单一口径，防反关节 */
export const MANNEQUIN_JOINT_LIMITS: Record<string, JointAxisLimits> = {
  waist: { x: [-0.6, 0.6], y: [-1.0, 1.0], z: [-0.5, 0.5] },
  neck: { x: [-0.7, 0.7], y: [-1.4, 1.4], z: [-0.5, 0.5] },
  shoulder_L: { x: [-2.6, 0.9], y: [-1.0, 1.0], z: [-0.5, 1.8] },
  shoulder_R: { x: [-2.6, 0.9], y: [-1.0, 1.0], z: [-1.8, 0.5] },
  elbow_L: { x: [-2.6, 0.1], y: [-0.25, 0.25], z: [-0.6, 0.6] },
  elbow_R: { x: [-2.6, 0.1], y: [-0.25, 0.25], z: [-0.6, 0.6] },
  hip_L: { x: [-1.7, 1.2], y: [-0.7, 0.7], z: [-0.8, 0.8] },
  hip_R: { x: [-1.7, 1.2], y: [-0.7, 0.7], z: [-0.8, 0.8] },
  knee_L: { x: [0.0, 2.2], y: [-0.1, 0.1], z: [-0.1, 0.1] },
  knee_R: { x: [0.0, 2.2], y: [-0.1, 0.1], z: [-0.1, 0.1] },
};

export const clampJointAxis = (v: number, r?: [number, number]) => (r ? Math.max(r[0], Math.min(r[1], v)) : v);

/** 布偶全部关节 id（与 MANNEQUIN_JOINT_LIMITS / 后端 ops.py 同口径） */
export type MannequinJointId = 'waist' | 'neck' | 'shoulder_L' | 'shoulder_R' | 'elbow_L' | 'elbow_R' | 'hip_L' | 'hip_R' | 'knee_L' | 'knee_R';
export const MANNEQUIN_JOINT_IDS = Object.keys(MANNEQUIN_JOINT_LIMITS) as MannequinJointId[];

/** 关节 rig 条目：被旋转的关节组 + 欧拉限位 */
export interface MannequinJointEntry {
  group: THREE.Object3D;
  limits: JointAxisLimits;
}
export type MannequinRig = Record<string, MannequinJointEntry>;

/** REQ-toonflow-canvas 取布偶根节点上的关节 rig；非布偶返回 undefined */
export function getMannequinRig(root: THREE.Object3D | null | undefined): MannequinRig | undefined {
  return (root?.userData as any)?.mannequinJoints as MannequinRig | undefined;
}

/** 是否布偶根节点（带关节 rig） */
export function isMannequin(root: THREE.Object3D | null | undefined): boolean {
  return !!getMannequinRig(root);
}

/** 序列化布偶关节姿态（只记非零关节，减少存储与 diff 噪音） */
export function serializeMannequinJoints(root: THREE.Object3D): MannequinJointPose {
  const rig = (root.userData as any)?.mannequinJoints as Record<string, { group: THREE.Object3D }> | undefined;
  const out: MannequinJointPose = {};
  if (!rig) return out;
  for (const [id, entry] of Object.entries(rig)) {
    const e = entry.group.rotation;
    if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 0.01) {
      out[id] = [Number(e.x.toFixed(4)), Number(e.y.toFixed(4)), Number(e.z.toFixed(4))];
    }
  }
  return out;
}

/** 应用关节姿态（按限位钳制；未给出的关节保持现状） */
export function applyMannequinJoints(root: THREE.Object3D, joints?: MannequinJointPose) {
  const rig = (root.userData as any)?.mannequinJoints as Record<string, { group: THREE.Object3D; limits: JointAxisLimits }> | undefined;
  if (!rig || !joints) return;
  for (const [id, rot] of Object.entries(joints)) {
    const entry = rig[id];
    if (!entry || !Array.isArray(rot)) continue;
    const lim = entry.limits || {};
    entry.group.rotation.set(
      clampJointAxis(rot[0] || 0, lim.x),
      clampJointAxis(rot[1] || 0, lim.y),
      clampJointAxis(rot[2] || 0, lim.z),
    );
  }
}

/** 清零全部关节（切到没有自定义姿态的分镜 / 复位） */
export function resetMannequinJoints(root: THREE.Object3D) {
  const rig = (root.userData as any)?.mannequinJoints as Record<string, { group: THREE.Object3D }> | undefined;
  if (!rig) return;
  for (const entry of Object.values(rig)) entry.group.rotation.set(0, 0, 0);
}

export function createPoseMannequin(opts: { pose: PosePreset; role: string; accentColor: number }): THREE.Group {
  const root = new THREE.Group();
  const woodByRole: Record<string, number> = { protagonist: 0xd9aa6b, antagonist: 0xc08a4e, supporting: 0xcfa060 };
  const woodMat = new THREE.MeshStandardMaterial({ color: woodByRole[opts.role] ?? 0xd9aa6b, roughness: 0.62, metalness: 0.04 });
  const woodDarkMat = new THREE.MeshStandardMaterial({ color: 0xa9743c, roughness: 0.7, metalness: 0.03 });
  const accentMat = new THREE.MeshStandardMaterial({ color: opts.accentColor, emissive: opts.accentColor, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.2 });
  const cast = (m: THREE.Mesh) => { m.castShadow = true; m.receiveShadow = true; return m; };
  // 关节拾取球（opacity 0 但可见：可被 Raycaster 命中，不渲染像素）
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const mkPick = (r: number, jointId: string, parent: THREE.Object3D) => {
    const p = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), pickMat);
    p.name = `jointpick_${jointId}`;
    (p.userData as any).jointPick = jointId;
    parent.add(p);
    return p;
  };

  const body = new THREE.Group();
  root.add(body);

  // 骨盆 + 腰关节球
  const pelvis = cast(new THREE.Mesh(new THREE.SphereGeometry(0.155, 24, 24), woodMat));
  pelvis.scale.set(1.15, 0.78, 0.72); pelvis.position.y = 0.9; body.add(pelvis);
  const waist = cast(new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 20), woodDarkMat));
  waist.position.y = 1.01; body.add(waist);
  // 角色识别腰带（不影响木偶中性造型）
  const belt = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.178, 0.188, 0.028, 24), accentMat));
  belt.position.y = 0.99; body.add(belt);

  // 上半身组（胸/肩/手臂/颈头；前倾、回眸转身都作用在这组）
  const upper = new THREE.Group(); upper.position.y = 1.04; body.add(upper);
  const chest = cast(new THREE.Mesh(new THREE.SphereGeometry(0.225, 28, 28), woodMat));
  chest.scale.set(1.02, 1.28, 0.6); chest.position.y = 0.2; upper.add(chest);
  const neck = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 16), woodDarkMat));
  neck.position.y = 0.42; upper.add(neck);
  const headGroup = new THREE.Group(); headGroup.position.y = 0.5; upper.add(headGroup);
  const head = cast(new THREE.Mesh(new THREE.SphereGeometry(0.14, 28, 28), woodMat));
  head.scale.set(0.95, 1.18, 0.95); head.position.y = 0.09; headGroup.add(head);
  mkPick(0.15, 'neck', headGroup);
  mkPick(0.14, 'waist', upper);

  // 手臂：肩关节球 → 上臂 → 肘关节组（前臂+手）
  const makeArm = (side: 1 | -1) => {
    const shoulder = cast(new THREE.Mesh(new THREE.SphereGeometry(0.072, 20, 20), woodDarkMat));
    shoulder.position.set(0.275 * side, 0.34, 0); upper.add(shoulder);
    const arm = new THREE.Group(); arm.position.set(0.275 * side, 0.34, 0); upper.add(arm);
    mkPick(0.095, side > 0 ? 'shoulder_L' : 'shoulder_R', arm);
    const upperArm = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.2, 8, 16), woodMat));
    upperArm.position.y = -0.155; arm.add(upperArm);
    const elbowGroup = new THREE.Group(); elbowGroup.position.y = -0.31; arm.add(elbowGroup);
    elbowGroup.add(cast(new THREE.Mesh(new THREE.SphereGeometry(0.058, 18, 18), woodDarkMat)));
    mkPick(0.08, side > 0 ? 'elbow_L' : 'elbow_R', elbowGroup);
    const forearm = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.046, 0.2, 8, 16), woodMat));
    forearm.position.y = -0.15; elbowGroup.add(forearm);
    const hand = cast(new THREE.Mesh(new THREE.SphereGeometry(0.052, 16, 16), woodDarkMat));
    hand.scale.set(0.85, 1.25, 0.6); hand.position.y = -0.33; elbowGroup.add(hand);
    return { arm, elbowGroup };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // 腿：髋关节球 → 大腿 → 膝关节组（小腿+脚）
  const makeLeg = (side: 1 | -1) => {
    const hip = cast(new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 20), woodDarkMat));
    hip.position.set(0.115 * side, 0.86, 0); body.add(hip);
    const leg = new THREE.Group(); leg.position.set(0.115 * side, 0.86, 0); body.add(leg);
    mkPick(0.095, side > 0 ? 'hip_L' : 'hip_R', leg);
    const thigh = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.24, 8, 16), woodMat));
    thigh.position.y = -0.19; leg.add(thigh);
    const kneeGroup = new THREE.Group(); kneeGroup.position.y = -0.38; leg.add(kneeGroup);
    kneeGroup.add(cast(new THREE.Mesh(new THREE.SphereGeometry(0.062, 18, 18), woodDarkMat)));
    mkPick(0.085, side > 0 ? 'knee_L' : 'knee_R', kneeGroup);
    const shin = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.26, 8, 16), woodMat));
    shin.position.y = -0.19; kneeGroup.add(shin);
    const foot = cast(new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.06, 0.21), woodDarkMat));
    foot.position.set(0, -0.445, 0.045); kneeGroup.add(foot);
    return { leg, kneeGroup };
  };
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  // 关节 rig 注册（鼠标拖拽 / Agent stage_control / 姿态序列化共用同一张表）
  (root.userData as any).mannequinJoints = {
    waist: { group: upper, limits: MANNEQUIN_JOINT_LIMITS.waist },
    neck: { group: headGroup, limits: MANNEQUIN_JOINT_LIMITS.neck },
    shoulder_L: { group: armL.arm, limits: MANNEQUIN_JOINT_LIMITS.shoulder_L },
    shoulder_R: { group: armR.arm, limits: MANNEQUIN_JOINT_LIMITS.shoulder_R },
    elbow_L: { group: armL.elbowGroup, limits: MANNEQUIN_JOINT_LIMITS.elbow_L },
    elbow_R: { group: armR.elbowGroup, limits: MANNEQUIN_JOINT_LIMITS.elbow_R },
    hip_L: { group: legL.leg, limits: MANNEQUIN_JOINT_LIMITS.hip_L },
    hip_R: { group: legR.leg, limits: MANNEQUIN_JOINT_LIMITS.hip_R },
    knee_L: { group: legL.kneeGroup, limits: MANNEQUIN_JOINT_LIMITS.knee_L },
    knee_R: { group: legR.kneeGroup, limits: MANNEQUIN_JOINT_LIMITS.knee_R },
  };

  // 角色识别光环
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.365, 40), new THREE.MeshBasicMaterial({ color: opts.accentColor, transparent: true, opacity: 0.28, side: THREE.DoubleSide }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.012; root.add(ring);

  // 姿态预设（关节旋转；负 x = 手臂/大腿向前摆，肘/膝正 x = 回折）
  const pose = opts.pose;
  if (pose === 'fight') {
    upper.rotation.y = -0.25;
    armL.arm.rotation.x = -0.55; armL.arm.rotation.z = 0.35; armL.elbowGroup.rotation.x = -1.45;
    armR.arm.rotation.x = -0.35; armR.arm.rotation.z = -0.45; armR.elbowGroup.rotation.x = -1.2;
    legL.leg.rotation.x = -0.28; legL.leg.rotation.z = 0.12;
    legR.leg.rotation.x = 0.32; legR.leg.rotation.z = -0.12; legR.kneeGroup.rotation.x = 0.35;
  } else if (pose === 'cast_spell') {
    upper.rotation.x = -0.06; headGroup.rotation.x = -0.18;
    armL.arm.rotation.x = -1.35; armL.arm.rotation.z = 0.42; armL.elbowGroup.rotation.x = -0.35;
    armR.arm.rotation.x = -1.15; armR.arm.rotation.z = -0.5; armR.elbowGroup.rotation.x = -0.5;
    legL.leg.rotation.x = -0.1; legR.leg.rotation.x = 0.1;
  } else if (pose === 'run') {
    upper.rotation.x = 0.16;
    armL.arm.rotation.x = -1.0; armL.elbowGroup.rotation.x = -1.5;
    armR.arm.rotation.x = 0.75; armR.elbowGroup.rotation.x = -0.6;
    legL.leg.rotation.x = -0.75; legL.kneeGroup.rotation.x = 1.15;
    legR.leg.rotation.x = 0.5; legR.kneeGroup.rotation.x = 0.55;
  } else if (pose === 'look_back') {
    upper.rotation.y = 0.55; headGroup.rotation.y = 2.0;
    legR.leg.rotation.y = -0.25;
  } else if (pose === 'kneel') {
    body.position.y -= 0.34;
    upper.rotation.x = 0.1;
    armL.arm.rotation.x = -0.5; armL.arm.rotation.z = 0.3; armL.elbowGroup.rotation.x = -1.2;
    armR.arm.rotation.x = 0.3; armR.arm.rotation.z = -0.25; armR.elbowGroup.rotation.x = -0.7;
    legR.leg.rotation.x = 0.05; legR.kneeGroup.rotation.x = 1.58;
    legL.leg.rotation.x = -1.4; legL.kneeGroup.rotation.x = 1.32;
  } else if (pose === 'defend') {
    upper.rotation.x = 0.12;
    armL.arm.rotation.x = -0.95; armL.arm.rotation.z = 0.3; armL.elbowGroup.rotation.x = -1.9;
    armR.arm.rotation.x = -0.85; armR.arm.rotation.z = -0.35; armR.elbowGroup.rotation.x = -1.85;
    legL.leg.rotation.x = -0.3; legL.leg.rotation.z = 0.14;
    legR.leg.rotation.x = 0.24; legR.leg.rotation.z = -0.14; legR.kneeGroup.rotation.x = 0.3;
  } else if (pose === 'fly') {
    body.position.y += 0.3; body.rotation.x = 0.22;
    armL.arm.rotation.x = -2.55; armL.arm.rotation.z = 0.5; armL.elbowGroup.rotation.x = -0.25;
    armR.arm.rotation.x = -2.4; armR.arm.rotation.z = -0.45; armR.elbowGroup.rotation.x = -0.3;
    legL.leg.rotation.x = 0.55; legL.kneeGroup.rotation.x = 0.5;
    legR.leg.rotation.x = 0.75; legR.kneeGroup.rotation.x = 0.35;
  } else if (pose === 'injured') {
    body.position.y -= 0.08;
    upper.rotation.x = 0.3; upper.rotation.z = 0.12; headGroup.rotation.z = 0.25;
    armL.arm.rotation.x = -0.6; armL.arm.rotation.z = 0.15; armL.elbowGroup.rotation.x = -2.0;
    armR.arm.rotation.x = 0.35; armR.arm.rotation.z = -0.1;
    legL.leg.rotation.x = -0.45; legL.kneeGroup.rotation.x = 0.7;
    legR.leg.rotation.x = 0.3; legR.kneeGroup.rotation.x = 0.25;
  } else {
    armL.arm.rotation.z = 0.07; armR.arm.rotation.z = -0.07;
  }
  return root;
}
