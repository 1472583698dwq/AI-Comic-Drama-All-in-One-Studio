// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 程序化道具（原 Director3DStage 尾部函数，原样迁出）+ 内置道具清单。
 * 纯 three，不依赖 React。`createRealisticMagicCircle` 用 2D canvas 画符文贴图，需要 DOM。
 */
import * as THREE from 'three';
import type { StagePropType } from '../../../types';

/**
 * 道具面板条目：只保留**内置**道具（原 Director3DStage `propOptions`）。
 * 插件道具（director_packs.props）已条目化，走 UISlot `director3d.props`，不在这里。
 */
export const BUILTIN_PROP_OPTIONS: Array<{ id: StagePropType; label: string; icon: string; sub: string }> = [
  { id: 'sword' as StagePropType, label: '浮空飞剑', icon: '🗡️', sub: '程序化' },
  { id: 'shield' as StagePropType, label: '聚能护盾', icon: '🛡️', sub: '程序化' },
  { id: 'magic_circle' as StagePropType, label: '地面符文阵', icon: '🌀', sub: '程序化' },
  { id: 'chair' as StagePropType, label: '休闲椅', icon: '🪑', sub: 'SheenChair.glb' },
  { id: 'helmet' as StagePropType, label: '破损头盔', icon: '⛑️', sub: 'DamagedHelmet.glb' },
  { id: 'camera' as StagePropType, label: '复古相机', icon: '📷', sub: 'AntiqueCamera.glb' },
  { id: 'avocado' as StagePropType, label: '牛油果', icon: '🥑', sub: 'Avocado.glb' },
  { id: 'boombox' as StagePropType, label: '音响', icon: '🔊', sub: 'BoomBox.glb' },
];

export function createRealisticSword(): THREE.Group {
  const g = new THREE.Group();
  // 剑身 - 渐变发光
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xe0f0ff, emissive: 0x00aaff, emissiveIntensity: 0.45, metalness: 0.85, roughness: 0.15 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.35, 0.015), bladeMat);
  blade.position.y = 0.72; blade.castShadow = true; g.add(blade);
  // 血槽
  const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.015, 1.1, 0.016), new THREE.MeshStandardMaterial({ color: 0x88c0ff, emissive: 0x0088ff, emissiveIntensity: 0.3 }));
  fuller.position.y = 0.72; g.add(fuller);
  // 剑尖
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.18, 4), bladeMat); tip.position.y = 1.48; tip.rotation.y = Math.PI / 4; g.add(tip);
  // 护手
  const guardMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.9, roughness: 0.15, emissive: 0xffaa00, emissiveIntensity: 0.15 });
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.05), guardMat); guard.position.y = 0.08; guard.castShadow = true; g.add(guard);
  const guardGem = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 12), new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.9 })); guardGem.position.y = 0.08; g.add(guardGem);
  // 柄
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 12), new THREE.MeshStandardMaterial({ color: 0x1a0a0a, roughness: 0.9 })); handle.position.y = -0.12; g.add(handle);
  const wrap1 = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.008, 8, 16), new THREE.MeshStandardMaterial({ color: 0x8b0000 })); wrap1.position.y = -0.06; wrap1.rotation.x = Math.PI / 2; g.add(wrap1);
  const wrap2 = wrap1.clone(); wrap2.position.y = -0.14; g.add(wrap2);
  // 剑首
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 16), guardMat); pommel.position.y = -0.28; g.add(pommel);
  // 光迹
  const trail = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 1.0), new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide })); trail.position.set(0, 0.7, 0.02); g.add(trail);
  g.castShadow = true;
  return g;
}

export function createRealisticShield(): THREE.Group {
  const g = new THREE.Group();
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x4a5568, metalness: 0.75, roughness: 0.25, transparent: true, opacity: 0.92 });
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.06, 6), shieldMat); shield.rotation.x = Math.PI / 2; shield.castShadow = true; g.add(shield);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.95, roughness: 0.1, emissive: 0xffaa00, emissiveIntensity: 0.2 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.025, 12, 6), rimMat); rim.rotation.x = Math.PI / 2; g.add(rim);
  // 徽记
  const emblem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 6), new THREE.MeshStandardMaterial({ color: 0x7c3aed, emissive: 0x7c3aed, emissiveIntensity: 0.5 })); emblem.rotation.x = Math.PI / 2; emblem.position.z = 0.04; g.add(emblem);
  const inner = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.8 })); inner.position.z = 0.06; g.add(inner);
  // 盾后握把
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.04), new THREE.MeshStandardMaterial({ color: 0x2d1b0e })); grip.position.z = -0.05; g.add(grip);
  return g;
}

export function createRealisticMagicCircle(): THREE.Group {
  const g = new THREE.Group();
  const mkRing = (r1: number, r2: number, color: number, opacity = 0.7) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r1, r2, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide }));
    m.rotation.x = Math.PI / 2; return m;
  };
  g.add(mkRing(1.55, 1.65, 0x00ffff, 0.85));
  g.add(mkRing(1.25, 1.30, 0x7c3aed, 0.65));
  g.add(mkRing(0.85, 0.90, 0x00ffff, 0.5));
  // 符文
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 512);
  ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 2; ctx.font = '28px serif'; ctx.textAlign = 'center';
  const runes = ['✦', '⬢', '⬣', '✧', '❂', '⌖', '⬔', '⬓'];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const x = 256 + Math.cos(a) * 180; const y = 256 + Math.sin(a) * 180; ctx.fillStyle = '#00ffff'; ctx.fillText(runes[i % runes.length], x, y); }
  ctx.beginPath(); ctx.arc(256, 256, 120, 0, Math.PI * 2); ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true;
  const runePlane = new THREE.Mesh(new THREE.CircleGeometry(1.15, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  runePlane.rotation.x = -Math.PI / 2; runePlane.position.y = 0.01; g.add(runePlane);
  // 中心法阵柱光
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.18, 1.8, 16), new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.12 })); pillar.position.y = 0.9; g.add(pillar);
  return g;
}

export function createIncenseBurner(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.35, 16), new THREE.MeshStandardMaterial({ color: 0x8b4513, roughness: 0.6, metalness: 0.15 })); body.position.y = 0.2; g.add(body);
  const lid = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0x5a2d0c, roughness: 0.5 })); lid.position.y = 0.42; g.add(lid);
  // 香烟
  for (let i = 0; i < 3; i++) {
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 }));
    smoke.position.set((Math.random() - 0.5) * 0.1, 0.55 + i * 0.12, (Math.random() - 0.5) * 0.1); g.add(smoke);
  }
  return g;
}

export function createBattleFlag(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x2b1a0a })); pole.position.y = 1.1; g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshStandardMaterial({ color: 0x8b1a1a, side: THREE.DoubleSide, emissive: 0x441111, emissiveIntensity: 0.2 })); flag.position.set(0.45, 1.7, 0); flag.castShadow = true; g.add(flag);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), new THREE.MeshBasicMaterial({ color: 0xffd700 })); emblem.position.set(0.45, 1.7, 0.02); g.add(emblem);
  return g;
}
