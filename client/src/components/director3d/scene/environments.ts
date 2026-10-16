// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 舞台环境构建（原 Director3DStage「环境构建」effect 体，原样迁出）。
 * 清空 `envGroup` 与场景中名为 `env_*` 的灯光，再按环境预设重建地面/远景/氛围光，并设置 scene.background / fog。
 * 纯 three，不依赖 React。
 */
import * as THREE from 'three';
import type { StageEnvironment } from '../../../types';

/** 重建舞台环境；`environment` 不在预设内时只做清理。 */
export function buildStageEnvironment(scene: THREE.Scene, envGroup: THREE.Group, environment: StageEnvironment | string): void {
  while (envGroup.children.length) envGroup.remove(envGroup.children[0]);
  // 清理旧光
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((obj) => { if ((obj as any).isLight && obj.name.startsWith('env_')) toRemove.push(obj); });
  toRemove.forEach((o) => scene.remove(o));
  if (environment === 'cyber_studio') {
    scene.background = new THREE.Color(0x07070a);
    scene.fog = new THREE.FogExp2(0x0a0a1a, 0.06);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ color: 0x0f0f1a, metalness: 0.6, roughness: 0.35 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; envGroup.add(floor);
    const grid = new THREE.GridHelper(20, 40, 0x7c3aed, 0x1a1a2e); grid.position.y = 0.01; envGroup.add(grid);
    // 霓虹环
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.55, 64), new THREE.MeshBasicMaterial({ color: 0x7c3aed, side: THREE.DoubleSide }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.02; envGroup.add(ring);
    // 远景城市剪影
    for (let i = 0; i < 18; i++) {
      const h = 1.5 + Math.random() * 3;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.6 + Math.random() * 0.7, h, 0.6), new THREE.MeshStandardMaterial({ color: 0x1a1a2e, emissive: 0x7c3aed, emissiveIntensity: 0.15 }));
      const angle = (i / 18) * Math.PI * 2;
      const r = 8 + Math.random() * 2;
      b.position.set(Math.cos(angle) * r, h / 2, Math.sin(angle) * r);
      envGroup.add(b);
      // 窗光
      for (let w = 0; w < 3; w++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.6 }));
        win.position.set(b.position.x + (Math.random() - 0.5) * 0.3, h * 0.3 + w * 0.4, b.position.z + 0.31);
        win.lookAt(0, win.position.y, 0);
        envGroup.add(win);
      }
    }
    const spot = new THREE.SpotLight(0x7c3aed, 18, 12, Math.PI / 5, 0.4); spot.position.set(0, 5, 2); spot.target.position.set(0, 0, 0); spot.name = 'env_spot'; scene.add(spot); scene.add(spot.target);
    const rim = new THREE.DirectionalLight(0x00d2ff, 4); rim.position.set(-4, 4, -3); rim.name = 'env_rim'; scene.add(rim);
  } else if (environment === 'xianxia_cloud') {
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.FogExp2(0xcfe9f5, 0.025);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0xe8f5f0, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.5; ground.receiveShadow = true; envGroup.add(ground);
    // 浮空山
    const mtnMat = new THREE.MeshStandardMaterial({ color: 0x5a6d7e, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 6; i++) {
      const mtn = new THREE.Mesh(new THREE.ConeGeometry(1.2 + Math.random() * 1.0, 3 + Math.random() * 2, 6), mtnMat);
      const a = (i / 6) * Math.PI * 2; const r = 7 + Math.random() * 4;
      mtn.position.set(Math.cos(a) * r, 1 + Math.random(), Math.sin(a) * r); mtn.castShadow = true; envGroup.add(mtn);
    }
    // 云海
    const clouds = new THREE.Group(); clouds.name = 'clouds_group';
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 1 });
    for (let i = 0; i < 12; i++) {
      const cl = new THREE.Group();
      for (let j = 0; j < 4; j++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.5 + Math.random() * 0.4, 12, 12), cloudMat);
        s.position.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.2);
        cl.add(s);
      }
      const a = (i / 12) * Math.PI * 2; const r = 4 + Math.random() * 8;
      cl.position.set(Math.cos(a) * r, 2 + Math.random() * 2, Math.sin(a) * r); clouds.add(cl);
    }
    envGroup.add(clouds);
    const sun = new THREE.DirectionalLight(0xfff2cc, 3.5); sun.position.set(5, 8, 3); sun.castShadow = true; sun.name = 'env_sun'; scene.add(sun);
    const fill = new THREE.HemisphereLight(0x87ceeb, 0xe8f5f0, 1.2); fill.name = 'env_fill'; scene.add(fill);
  } else if (environment === 'desert_battle') {
    scene.background = new THREE.Color(0xff8c42);
    scene.fog = new THREE.FogExp2(0xffa85c, 0.035);
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 20, 20), new THREE.MeshStandardMaterial({ color: 0xc2a878, roughness: 1, metalness: 0 }));
    // 起伏沙丘
    const pos = sand.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i); pos.setZ(i, Math.sin(x * 0.3) * 0.4 + Math.cos(y * 0.3) * 0.3); }
    pos.needsUpdate = true; sand.geometry.computeVertexNormals();
    sand.rotation.x = -Math.PI / 2; sand.position.y = -0.3; sand.receiveShadow = true; envGroup.add(sand);
    // 岩石
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.95 });
    for (let i = 0; i < 8; i++) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + Math.random() * 0.5), rockMat);
      const a = Math.random() * Math.PI * 2; const r = 3 + Math.random() * 6;
      rock.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r); rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0); rock.castShadow = true; envGroup.add(rock);
    }
    const sun2 = new THREE.DirectionalLight(0xff6b35, 4); sun2.position.set(4, 6, -2); sun2.castShadow = true; sun2.name = 'env_sun'; scene.add(sun2);
    const amber = new THREE.PointLight(0xff8c42, 2, 20); amber.position.set(0, 2, 0); amber.name = 'env_amber'; scene.add(amber);
  } else if (environment === 'neon_city') {
    scene.background = new THREE.Color(0x0a0a1a);
    scene.fog = new THREE.FogExp2(0x0a0a1a, 0.055);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x1a1a2e, metalness: 0.8, roughness: 0.2 }));
    street.rotation.x = -Math.PI / 2; street.position.y = 0; street.receiveShadow = true; envGroup.add(street);
    // 雨夜建筑
    for (let i = 0; i < 20; i++) {
      const h = 2 + Math.random() * 4;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.8 + Math.random(), h, 0.8), new THREE.MeshStandardMaterial({ color: 0x0f0f1e }));
      const a = (i / 20) * Math.PI * 2; const r = 6 + Math.random() * 5;
      b.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); envGroup.add(b);
      // 霓虹窗
      const neonColors = [0xff0080, 0x00ffff, 0x7c3aed, 0xffaa00];
      for (let k = 0; k < 2; k++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.35), new THREE.MeshBasicMaterial({ color: neonColors[i % neonColors.length], transparent: true, opacity: 0.7 }));
        win.position.set(b.position.x, h * 0.3 + k * 0.8, b.position.z + 0.42);
        win.lookAt(0, win.position.y, 0); envGroup.add(win);
      }
    }
    // 街灯
    for (let i = 0; i < 4; i++) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3), new THREE.MeshStandardMaterial({ color: 0x333333 }));
      const a = (i / 4) * Math.PI * 2 + 0.3; pole.position.set(Math.cos(a) * 3.5, 1.5, Math.sin(a) * 3.5); envGroup.add(pole);
      const lamp = new THREE.PointLight(0xffaa00, 3, 6); lamp.position.set(pole.position.x, 3, pole.position.z); lamp.name = 'env_lamp'; scene.add(lamp);
    }
    const moon = new THREE.DirectionalLight(0x9bbcff, 1.2); moon.position.set(-4, 6, -4); moon.name = 'env_moon'; scene.add(moon);
  }
}
