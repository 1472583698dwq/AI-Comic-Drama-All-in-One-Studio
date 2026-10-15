// REQ-toonflow-canvas T3 · 预设同源模块（纯函数）单测
import { describe, expect, it } from 'vitest';
import {
  CAST_LAYOUTS,
  FRAMING_CAMERA_POSES,
  FRAMING_PRESETS,
  MOTION_PRESETS,
  POSE_PRESETS,
  buildClayPrompt,
  buildMinimaxCameraPrompt,
  castMembers,
  easeMotionProgress,
  focalLengthToFov,
  framingCameraPose,
  framingShortLabel,
  motionDurationMs,
  ratioToNumber,
} from '../presets';
import * as legacy from '../../directorPresets';

describe('scene/presets · 海螺运镜提示词', () => {
  it('默认参数只输出 Motion/Framing/Lens 三段（与 3D 片场 LIVE PROMPT 一致）', () => {
    expect(buildMinimaxCameraPrompt({ framing: 'medium', motion: 'push_in', focalLength: 35 }))
      .toBe('[Camera: Motion: Dolly In, Framing: 中景 (MS), Lens: 35mm]');
  });

  it('荷兰角 / 速度 / 站位按需追加，取预设表的 minimaxCode 与 label', () => {
    const s = buildMinimaxCameraPrompt({
      framing: 'low_angle', motion: 'orbit_boom_up', focalLength: 24, cameraRoll: -12.34, motionSpeed: '1.5x', castLayout: 'duel',
    });
    expect(s).toBe('[Camera: Motion: Orbit + Boom Up, Framing: 贴地仰角, Lens: 24mm, Dutch Roll: -12.3°, Speed: 1.5x, Cast Staging: DUEL]');
  });

  it('正荷兰角带 + 号；|roll| ≤ 0.5 不输出；solo / 1.0x 不输出', () => {
    expect(buildMinimaxCameraPrompt({ framing: 'close_up', motion: 'static', focalLength: 50, cameraRoll: 8, motionSpeed: '1.0x', castLayout: 'solo' }))
      .toBe('[Camera: Motion: Static Camera, Framing: 特写 (CU), Lens: 50mm, Dutch Roll: +8.0°]');
    expect(buildMinimaxCameraPrompt({ framing: 'close_up', motion: 'static', focalLength: 50, cameraRoll: 0.4 }))
      .not.toContain('Dutch Roll');
  });

  it('未知（插件）景别 / 运镜原样回显 id', () => {
    expect(buildMinimaxCameraPrompt({ framing: 'pack_wide', motion: 'pack_spin', focalLength: 35 }))
      .toBe('[Camera: Motion: pack_spin, Framing: pack_wide, Lens: 35mm]');
  });
});

describe('scene/presets · 同源数组', () => {
  it('旧路径 directorPresets 与 scene/presets 是同一个数组实例（导演包合并后两边一致）', () => {
    expect(legacy.FRAMING_PRESETS).toBe(FRAMING_PRESETS);
    expect(legacy.MOTION_PRESETS).toBe(MOTION_PRESETS);
    expect(legacy.POSE_PRESETS).toBe(POSE_PRESETS);
    expect(legacy.CAST_LAYOUTS).toBe(CAST_LAYOUTS);
    expect(legacy.framingShortLabel('full')).toBe(framingShortLabel('full'));
  });

  it('每个内置景别都有机位；未知景别回落默认机位，且返回副本', () => {
    for (const f of FRAMING_PRESETS) expect(FRAMING_CAMERA_POSES[f.id]).toBeDefined();
    expect(framingCameraPose('medium')).toEqual({ position: [0, 1.3, 2.4], target: [0, 1.25, 0] });
    expect(framingCameraPose('nope')).toEqual({ position: [0, 1.3, 2.5], target: [0, 1.25, 0] });
    const p = framingCameraPose('close_up');
    p.position[0] = 99;
    expect(FRAMING_CAMERA_POSES.close_up.position[0]).toBe(0);
  });
});

describe('scene/presets · 光学 / 时长 / 缓动', () => {
  it('焦距 → 垂直 FOV（24mm 感光高度），钳制 [12,105]', () => {
    expect(focalLengthToFov(35)).toBeCloseTo(37.849, 2);
    expect(focalLengthToFov(500)).toBe(12);
    expect(focalLengthToFov(4)).toBe(105);
  });

  it('速度档 → 模拟时长', () => {
    expect(motionDurationMs('0.5x')).toBe(4500);
    expect(motionDurationMs('1.0x')).toBe(2500);
    expect(motionDurationMs('1.5x')).toBe(1800);
    expect(motionDurationMs('2.0x')).toBe(1200);
    expect(motionDurationMs(undefined)).toBe(2500);
  });

  it('缓动端点 0→0、1→1，linear 恒等', () => {
    for (const e of ['linear', 'ease_in_out', 'explosive', 'slow_out']) {
      expect(easeMotionProgress(0, e)).toBeCloseTo(0, 9);
      expect(easeMotionProgress(1, e)).toBeCloseTo(1, 9);
    }
    expect(easeMotionProgress(0.3, 'linear')).toBe(0.3);
    expect(easeMotionProgress(0.5, 'ease_in_out')).toBeCloseTo(0.5, 9);
  });

  it('画幅文本 → 数值', () => {
    expect(ratioToNumber('16:9')).toBeCloseTo(16 / 9, 9);
    expect(ratioToNumber('4/3')).toBeCloseTo(4 / 3, 9);
    expect(ratioToNumber('bad')).toBeCloseTo(9 / 16, 9);
  });
});

describe('scene/presets · 站位 castMembers', () => {
  it('solo 只有主角', () => {
    const m = castMembers('solo', 'run');
    expect(m.map((x) => x.entity)).toEqual(['entity_protagonist']);
    expect(m[0]).toMatchObject({ role: 'protagonist', pose: 'run', position: [0, 0, 0] });
    expect(m[0].rotationY).toBeUndefined();
  });

  it('duel：对手在 -2.3 面朝主角；主角武道架势时对手同摆架势', () => {
    const m = castMembers('duel', 'fight');
    expect(m.map((x) => x.entity)).toEqual(['entity_protagonist', 'entity_antagonist']);
    expect(m[1]).toMatchObject({ pose: 'fight', position: [0, 0, -2.3], rotationY: Math.PI });
    expect(castMembers('duel', 'cast_spell')[1].pose).toBe('stand');
  });

  it('ots / surrounded 摆位与 3D 片场一致，surrounded 多一个配角', () => {
    expect(castMembers('ots', 'stand')[1]).toMatchObject({ position: [-0.35, 0, -2.5], rotationY: Math.PI * 0.9 });
    const s = castMembers('surrounded', 'stand');
    expect(s.map((x) => x.entity)).toEqual(['entity_protagonist', 'entity_antagonist', 'entity_supporting']);
    expect(s[1]).toMatchObject({ position: [1.9, 0, -1.2], rotationY: -Math.PI * 0.6 });
    expect(s[2]).toMatchObject({ role: 'supporting', pose: 'fight', position: [-1.9, 0, -1.2], rotationY: Math.PI * 0.6 });
  });
});

describe('scene/presets · 白模提示词', () => {
  it('包含镜头参数与走位，无走位时不出现走位行', () => {
    const s = buildClayPrompt({
      framing: 'full', motion: 'push_in', focalLength: 28, cameraRoll: 0, motionSpeed: '1.0x', aspect: '9:16', secs: 2.5,
      waypoints: [{ x: 1, z: -0.5 }, { x: 2.25, z: 0 }],
    });
    expect(s).toContain('镜头：全景 (FS)，焦距 28mm；运镜：急进推镜 (Dolly In)（1.0x）；时长约 2.5s；画幅 9:16。');
    expect(s).toContain('主角走位：P1(1.0,-0.5) → P2(2.3,0.0)。');
    const s2 = buildClayPrompt({ framing: 'full', motion: 'push_in', focalLength: 28, cameraRoll: 0, motionSpeed: '1.0x', aspect: '9:16', secs: 2.5 });
    expect(s2).not.toContain('主角走位');
    expect(s2.split('\n')).toHaveLength(4);
  });
});
