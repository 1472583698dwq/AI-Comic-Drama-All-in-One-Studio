// REQ-toonflow-canvas T3 · 人体布偶关节 rig：序列化 / 应用 / 复位 / 限位（three 对象图，无 WebGL）
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MANNEQUIN_JOINT_IDS,
  MANNEQUIN_JOINT_LIMITS,
  applyMannequinJoints,
  createPoseMannequin,
  getMannequinRig,
  isMannequin,
  resetMannequinJoints,
  serializeMannequinJoints,
} from '../mannequin';
import { POSE_PRESETS } from '../presets';

const mk = (pose: any = 'stand') => createPoseMannequin({ pose, role: 'protagonist', accentColor: 0x00d2ff });

describe('scene/mannequin · rig', () => {
  it('10 个关节都注册了关节组与限位，每个关节有拾取球', () => {
    const m = mk();
    const rig = getMannequinRig(m)!;
    expect(Object.keys(rig).sort()).toEqual([...MANNEQUIN_JOINT_IDS].sort());
    for (const id of MANNEQUIN_JOINT_IDS) {
      expect(rig[id].group).toBeInstanceOf(THREE.Object3D);
      expect(rig[id].limits).toBe(MANNEQUIN_JOINT_LIMITS[id]);
      const pick = m.getObjectByName(`jointpick_${id}`)!;
      expect(pick).toBeTruthy();
      expect((pick.userData as any).jointPick).toBe(id);
    }
    expect(isMannequin(m)).toBe(true);
    expect(isMannequin(new THREE.Group())).toBe(false);
  });

  it('所有姿态预设都能构建', () => {
    for (const p of POSE_PRESETS) expect(isMannequin(mk(p.id))).toBe(true);
  });
});

describe('scene/mannequin · 关节姿态', () => {
  it('站姿只有两肩微张（非零关节才序列化）', () => {
    expect(serializeMannequinJoints(mk('stand'))).toEqual({ shoulder_L: [0, 0, 0.07], shoulder_R: [0, 0, -0.07] });
  });

  it('serialize → apply 到新布偶 → serialize 往返一致', () => {
    const a = mk('fight');
    const joints = {
      waist: [0.1, -0.4, 0.05],
      neck: [-0.2, 0.9, 0],
      elbow_L: [-1.1, 0, 0.2],
      knee_R: [1.3, 0.05, -0.02],
    } as Record<string, [number, number, number]>;
    resetMannequinJoints(a);
    applyMannequinJoints(a, joints);
    const s1 = serializeMannequinJoints(a);
    expect(s1).toEqual(joints);

    const b = mk('run');
    resetMannequinJoints(b);
    applyMannequinJoints(b, s1);
    expect(serializeMannequinJoints(b)).toEqual(s1);
  });

  it('应用时按限位钳制（膝盖不能反折）；未给出的关节保持现状；未知关节忽略', () => {
    const m = mk('stand');
    applyMannequinJoints(m, { knee_L: [-1, 0.5, 0], bogus: [1, 1, 1] } as any);
    const out = serializeMannequinJoints(m);
    expect(out.knee_L).toEqual([0, 0.1, 0]);
    expect(out.shoulder_L).toEqual([0, 0, 0.07]);
    expect((out as any).bogus).toBeUndefined();
  });

  it('复位后全部归零；非布偶对象安全忽略', () => {
    const m = mk('cast_spell');
    resetMannequinJoints(m);
    expect(serializeMannequinJoints(m)).toEqual({});
    const g = new THREE.Group();
    expect(() => { applyMannequinJoints(g, { neck: [1, 0, 0] }); resetMannequinJoints(g); }).not.toThrow();
    expect(serializeMannequinJoints(g)).toEqual({});
  });
});
