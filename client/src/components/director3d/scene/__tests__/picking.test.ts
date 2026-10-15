// REQ-toonflow-canvas T3 · 射线拾取与关节拖拽（three 对象图 + 纯数学射线，无 WebGL）
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPoseMannequin, getMannequinRig } from '../mannequin';
import { dragRotateJoint, layoutRectToClient, pickJoint, pickStageRoot, raycasterAt } from '../picking';

const RECT = { left: 100, top: 50, width: 800, height: 600 };

function setup() {
  const stage = new THREE.Group();
  const doll = createPoseMannequin({ pose: 'stand', role: 'protagonist', accentColor: 0x00d2ff });
  doll.name = 'entity_protagonist';
  stage.add(doll);
  const scene = new THREE.Scene();
  scene.add(stage);
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(40, RECT.width / RECT.height, 0.1, 100);
  camera.position.set(0, 1.3, 3.2);
  camera.lookAt(0, 1.2, 0);
  camera.updateMatrixWorld(true);
  return { stage, doll, camera };
}

/** 世界坐标 → 容器客户区坐标 */
function toClient(p: THREE.Vector3, camera: THREE.Camera) {
  const ndc = p.clone().project(camera);
  return { x: RECT.left + ((ndc.x + 1) / 2) * RECT.width, y: RECT.top + ((1 - ndc.y) / 2) * RECT.height };
}

describe('scene/picking · 拾取', () => {
  it('对准左肩拾取球 → 命中 shoulder_L，返回关节组与限位', () => {
    const { stage, doll, camera } = setup();
    const ball = doll.getObjectByName('jointpick_shoulder_L')!;
    const c = toClient(ball.getWorldPosition(new THREE.Vector3()), camera);
    const hit = pickJoint(raycasterAt(c.x, c.y, RECT, camera), stage);
    expect(hit).not.toBeNull();
    expect(hit!.entity).toBe('entity_protagonist');
    expect(hit!.jointId).toBe('shoulder_L');
    expect(hit!.group).toBe(getMannequinRig(doll)!.shoulder_L.group);
    expect(hit!.limits).toEqual(getMannequinRig(doll)!.shoulder_L.limits);
  });

  it('锁定实体的关节不可拾取；实体本身仍可被 pickStageRoot 选中', () => {
    const { stage, doll, camera } = setup();
    const c = toClient(doll.getObjectByName('jointpick_neck')!.getWorldPosition(new THREE.Vector3()), camera);
    const ray = raycasterAt(c.x, c.y, RECT, camera);
    expect(pickJoint(ray, stage, (e) => e === 'entity_protagonist')).toBeNull();
    expect(pickJoint(ray, stage)!.jointId).toBe('neck');
    expect(pickStageRoot(ray, stage)).toBe('entity_protagonist');
  });

  it('打空返回 null', () => {
    const { stage, camera } = setup();
    expect(pickJoint(raycasterAt(RECT.left + 5, RECT.top + 5, RECT, camera), stage)).toBeNull();
    expect(pickStageRoot(raycasterAt(RECT.left + 5, RECT.top + 5, RECT, camera), stage)).toBeNull();
  });
});

describe('scene/picking · 布局像素 → 屏幕像素（REQ-toonflow-canvas C1）', () => {
  it('元素被 CSS 缩放时，元素内的布局区域按 rect / 布局尺寸 的比例换算到屏幕', () => {
    // 布局 640×480 的容器被 scale(0.5) 缩到屏幕 320×240，位于 (100, 50)；帧区域（letterbox）在布局坐标 (0, 60) 起、640×360
    const rect = { left: 100, top: 50, width: 320, height: 240 };
    expect(layoutRectToClient(rect, { w: 640, h: 480 }, { x: 0, y: 60, w: 640, h: 360 })).toEqual({ left: 100, top: 80, width: 320, height: 180 });
    // 放大 2 倍
    const big = { left: 10, top: 20, width: 1280, height: 960 };
    expect(layoutRectToClient(big, { w: 640, h: 480 }, { x: 80, y: 0, w: 480, h: 480 })).toEqual({ left: 170, top: 20, width: 960, height: 960 });
    // 不缩放 / 不给子区域 = 原 rect；量不到尺寸时按 1:1
    expect(layoutRectToClient({ left: 1, top: 2, width: 640, height: 480 }, { w: 640, h: 480 })).toEqual({ left: 1, top: 2, width: 640, height: 480 });
    expect(layoutRectToClient({ left: 0, top: 0, width: 0, height: 0 }, { w: 640, h: 480 }, { x: 5, y: 6, w: 7, h: 8 })).toEqual({ left: 5, top: 6, width: 7, height: 8 });
  });

  it('缩放后的屏幕坐标 + 换算后的 rect 拾取到同一个关节', () => {
    const { stage, doll, camera } = setup();
    const p = doll.getObjectByName('jointpick_elbow_R')!.getWorldPosition(new THREE.Vector3());
    for (const zoom of [0.6, 1, 2]) {
      const screen = { left: 30, top: 40, width: RECT.width * zoom, height: RECT.height * zoom };
      const rect = layoutRectToClient(screen, { w: RECT.width, h: RECT.height });
      const ndc = p.clone().project(camera);
      const x = screen.left + ((ndc.x + 1) / 2) * screen.width;
      const y = screen.top + ((1 - ndc.y) / 2) * screen.height;
      expect(pickJoint(raycasterAt(x, y, rect, camera), stage)?.jointId).toBe('elbow_R');
    }
  });
});

describe('scene/picking · 关节拖拽', () => {
  it('膝盖只能向后折：向下拖弯曲，向上拖被限位钳到 0', () => {
    const { doll, camera } = setup();
    const knee = getMannequinRig(doll)!.knee_L;
    dragRotateJoint(knee.group, knee.limits, 0, 50, false, camera);
    expect(knee.group.rotation.x).toBeGreaterThan(0.3);
    expect(knee.group.rotation.x).toBeLessThanOrEqual(2.2);
    knee.group.rotation.set(0, 0, 0);
    dragRotateJoint(knee.group, knee.limits, 0, -50, false, camera);
    expect(knee.group.rotation.x).toBeCloseTo(0, 9);
    expect(Math.abs(knee.group.rotation.y)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(Math.abs(knee.group.rotation.z)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('Shift 扭转（横向为主）只改局部 Y，并按限位钳制', () => {
    const { doll, camera } = setup();
    const sh = getMannequinRig(doll)!.shoulder_R;
    const z0 = sh.group.rotation.z;
    dragRotateJoint(sh.group, sh.limits, 10, 2, true, camera);
    expect(sh.group.rotation.y).toBeCloseTo(0.12, 9);
    expect(sh.group.rotation.z).toBe(z0);
    dragRotateJoint(sh.group, sh.limits, 1000, 0, true, camera);
    expect(sh.group.rotation.y).toBe(1.0);
  });

  it('无视角摄影机时只做水平旋转', () => {
    const { doll } = setup();
    const neck = getMannequinRig(doll)!.neck;
    dragRotateJoint(neck.group, neck.limits, 25, 40, false, null);
    expect(neck.group.rotation.y).toBeCloseTo(0.3, 6);
    expect(neck.group.rotation.x).toBeCloseTo(0, 6);
  });
});
