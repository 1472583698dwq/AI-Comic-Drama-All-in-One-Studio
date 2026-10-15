// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 舞台渲染器与基础三点光（原 Director3DStage「Three 初始化」effect 与灯光面板 effect，原样抽出）。
 * 3D 片场主视图与画布 director3d 迷你舞台用同一套渲染参数（阴影 / ACES / 曝光）与灯光默认值。纯 three，不依赖 React。
 */
import * as THREE from 'three';
import { KEY_TEMPS } from './presets';

/** 3D 片场默认背景色 / 雾（环境构建会按环境预设再覆盖） */
export const STAGE_BACKGROUND = 0x07070a;
export const STAGE_FOG_DENSITY = 0.035;

export interface StageRendererOptions {
  width: number;
  height: number;
  /** 指定画布（离屏导出时传新建的 canvas）；不传由 three 新建 */
  canvas?: HTMLCanvasElement;
  /** 像素比上限，默认 min(devicePixelRatio, 2) */
  pixelRatio?: number;
  exposure?: number;
  /**
   * 阴影贴图类型，默认 PCFSoftShadowMap（与 3D 片场原样一致）。three r185 起 PCFSoft 已弃用并自动回落 PCF，
   * 还会每个渲染器打一条 warning；新代码（迷你舞台 / 离屏导出）直接传 THREE.PCFShadowMap，效果相同且无告警。
   */
  shadowMapType?: THREE.ShadowMapType;
}

/** 主视图渲染器：抗锯齿 + 透明 + 保留绘制缓冲（截图要用）+ 软阴影 + ACES 色调映射 */
export function createStageRenderer(opts: StageRendererOptions): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, ...(opts.canvas ? { canvas: opts.canvas } : {}) });
  renderer.setSize(opts.width, opts.height);
  renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = opts.shadowMapType ?? THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.15;
  return renderer;
}

export interface ThreePointLights {
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
}

/** 基础光（会被环境光覆盖，保留兜底；灯光面板通过 applyLightingConfig 实时控制）。按 ambient → key → rim 顺序入场。 */
export function createThreePointLights(scene: THREE.Scene): ThreePointLights {
  const ambient = new THREE.AmbientLight(0x1a1528, 1.8);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0x7c3aed, 3.2);
  key.position.set(4, 5, 3.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x00d2ff, 3.5);
  rim.position.set(-3.5, 3.5, -3);
  scene.add(rim);
  return { ambient, key, rim };
}

/** 灯光面板参数（分镜 lighting_config 同结构） */
export interface LightingConfig {
  keyIntensity: number;
  /** 主光方位角（度），绕 Y 轴，半径 6、高度 5 */
  keyAzimuth: number;
  keyTemp: string;
  rimIntensity: number;
  ambientIntensity: number;
  exposure: number;
}

export const DEFAULT_LIGHTING: LightingConfig = {
  keyIntensity: 3.2,
  keyAzimuth: 40,
  keyTemp: 'neon',
  rimIntensity: 3.5,
  ambientIntensity: 1.8,
  exposure: 1.15,
};

/** 灯光面板 → 基础三点光实时应用（主光方位绕 Y 轴旋转，高度固定）；缺哪个就跳过哪个 */
export function applyLightingConfig(
  lights: Partial<ThreePointLights>,
  renderer: THREE.WebGLRenderer | null | undefined,
  cfg: LightingConfig,
): void {
  const az = THREE.MathUtils.degToRad(cfg.keyAzimuth);
  const r = 6;
  if (lights.key) {
    lights.key.position.set(Math.sin(az) * r, 5, Math.cos(az) * r);
    lights.key.color.setHex(KEY_TEMPS[cfg.keyTemp].color);
    lights.key.intensity = cfg.keyIntensity;
  }
  if (lights.rim) lights.rim.intensity = cfg.rimIntensity;
  if (lights.ambient) lights.ambient.intensity = cfg.ambientIntensity;
  if (renderer) renderer.toneMappingExposure = cfg.exposure;
}
