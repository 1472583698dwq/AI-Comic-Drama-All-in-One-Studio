// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 精简 3D 舞台（框架无关，只依赖 three）。
 *
 * 给画布 `director3d` 节点（N5）内嵌用：在任意容器里起一个小舞台——
 * 渲染器 / 场景 / 摄影机 / 三点光 / 地面（或 3D 片场环境预设）/ 轨道视角 / 按角色放布偶 / 关节拾取与拖拽 /
 * 机位读写 / 景别预设 / 导出 PNG / 按关键帧录制视频。
 *
 * 与 3D 片场（Director3DStage）共用同一批模块：布偶与关节限位（mannequin）、拾取与关节拖拽（picking）、
 * 渲染参数与灯光（stageSetup）、环境（environments）、轨道与关键帧（camera）、预设（presets）。
 *
 * 用法（N5 在 React 里自己管生命周期）：
 *   const stage = createMiniStage(div, { castLayout: 'duel', pose: 'fight', framing: 'medium', aspect: 9 / 16,
 *     onJointsChange: (entity, joints) => …, onCameraChange: (cam) => … });
 *   stage.applyFraming('close_up', 50);
 *   const png = await stage.snapshotPNG();
 *   const video = await stage.recordCameraPath(motionPresetKeyframes('push_in', stage.getCameraState()), 2.5);
 *   stage.dispose();
 * 容器建议加 `nodrag nowheel nopan`，避免与画布拖拽/缩放抢事件。
 */
import * as THREE from 'three';
import type { CastLayout, MannequinJointPose, MannequinPose, PosePreset, StageEnvironment } from '../../../types';
import {
  applyCameraRoll,
  applyCameraState,
  applyOrbitToCamera,
  cameraKeyframesDuration,
  createOrbitState,
  framingCameraState,
  normalizeKeyframes,
  orbitFromPose,
  sampleCameraKeyframes,
  type CameraKeyframe,
  type StageCameraState,
} from './camera';
import { buildStageEnvironment } from './environments';
import {
  applyMannequinJoints,
  createPoseMannequin,
  getMannequinRig,
  resetMannequinJoints,
  serializeMannequinJoints,
  type JointAxisLimits,
} from './mannequin';
import { dragRotateJoint, layoutRectToClient, pickJoint, raycasterAt } from './picking';
import { castMembers, ROLE_ACCENT_COLORS, type MannequinRole, type Vec3Tuple } from './presets';
import {
  applyLightingConfig,
  createStageRenderer,
  createThreePointLights,
  DEFAULT_LIGHTING,
  STAGE_BACKGROUND,
  STAGE_FOG_DENSITY,
  type LightingConfig,
} from './stageSetup';

export type MiniStageEnvironment = StageEnvironment | 'plain';

/** 上场的一个布偶 */
export interface MiniStageMember {
  /** 实体名（关节姿态 / 选中回调的 key）；默认 `entity_<role>` */
  entity?: string;
  /** protagonist / antagonist / supporting（决定木色与识别色）；默认 protagonist */
  role?: MannequinRole | string;
  pose?: PosePreset;
  accentColor?: number;
  position?: Vec3Tuple;
  /** 朝向（绕 Y，弧度） */
  rotationY?: number;
  /** 自定义关节姿态（优先于姿态预设） */
  joints?: MannequinJointPose;
}

export interface MiniStageOptions {
  /** 'plain'（默认：深色地面 + 网格，最轻）或 3D 片场环境预设 */
  environment?: MiniStageEnvironment;
  /** 初始站位与姿态（与 3D 片场 castMembers 同源）；传了 `cast` 时忽略 */
  castLayout?: CastLayout | string;
  pose?: PosePreset;
  /** 显式指定上场布偶 */
  cast?: MiniStageMember[];
  /** 初始机位；不传按 framing / focalLength / cameraRoll 生成（默认中景 35mm） */
  camera?: StageCameraState;
  framing?: string;
  focalLength?: number;
  cameraRoll?: number;
  /**
   * 画幅（宽 / 高）。给了就在容器内等比留边（letterbox）渲染，导出与所见一致；
   * 不给则铺满容器、导出按容器比例。
   */
  aspect?: number;
  lighting?: Partial<LightingConfig>;
  /** 像素比上限，默认 min(devicePixelRatio, 2) */
  pixelRatio?: number;
  /** 轨道视角 + 关节拖拽；默认 true */
  interactive?: boolean;
  /** 被锁定的实体不可拖关节 */
  isLocked?: (entity: string) => boolean;
  /** 关节拖拽结束（有实际转动）时回调该布偶的完整关节姿态 */
  onJointsChange?: (entity: string, joints: MannequinJointPose) => void;
  /** 轨道 / 缩放 / 平移结束，以及 setCameraState / applyFraming 后回调 */
  onCameraChange?: (state: StageCameraState) => void;
  /** 按下关节时回调（实体 + 关节 id）；点空白处回调 null */
  onSelect?: (entity: string | null, jointId?: string) => void;
}

export interface ExportSizeOptions {
  /** 明确输出尺寸（两者都给才生效，会取偶数） */
  width?: number;
  height?: number;
  /** 只给长边，按舞台画幅推算短边；默认 1280 */
  longEdge?: number;
}

export interface SnapshotOptions extends ExportSizeOptions {
  /** 默认 image/png */
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number;
  /** 指定机位（不传用当前机位） */
  camera?: StageCameraState;
}

export interface RecordOptions extends ExportSizeOptions {
  /** 不传自动挑：优先 MP4(H.264)，不支持再退 WebM */
  mimeType?: string;
  videoBitsPerSecond?: number;
  signal?: AbortSignal;
  /** 0~1 */
  onProgress?: (progress: number) => void;
}

export interface MiniStage {
  readonly container: HTMLElement;
  readonly scene: THREE.Scene;
  /** 视图摄影机（导出时克隆它，不改它） */
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** 布偶 / 道具挂在这个组下（拾取范围） */
  readonly entities: THREE.Group;
  /** 立即渲染一帧 */
  render(): void;
  /** 下一帧渲染（按需渲染，没有常驻动画循环） */
  invalidate(): void;
  /** 容器尺寸变化后调用（有 ResizeObserver 时会自动调用） */
  resize(): void;
  setAspect(aspect: number | undefined): void;
  setEnvironment(env: MiniStageEnvironment): void;
  setLighting(cfg: Partial<LightingConfig>): void;
  /** 按站位预设重建全部布偶（保留 joints 里给到的自定义姿态） */
  setCast(castLayout: CastLayout | string, pose: PosePreset, joints?: MannequinPose['entities']): void;
  addMannequin(member: MiniStageMember): THREE.Group;
  removeEntity(entity: string): void;
  listEntities(): string[];
  getEntity(entity: string): THREE.Object3D | undefined;
  /** 全部布偶关节姿态（分镜 mannequin_pose 结构） */
  getMannequinPose(): MannequinPose;
  getJoints(entity: string): MannequinJointPose;
  /** 整体替换某个布偶的关节姿态（先复位再应用） */
  setJoints(entity: string, joints: MannequinJointPose): void;
  /** 应用 mannequin_pose（与 3D 片场 agent-stage-patch 同语义）：给到的实体在当前姿态上叠加这些关节，没给到的实体全部复位 */
  applyMannequinPose(pose: MannequinPose | MannequinPose['entities'] | undefined): void;
  /** 复位关节（不传实体 = 全部） */
  resetJoints(entity?: string): void;
  getCameraState(): StageCameraState;
  setCameraState(state: StageCameraState, opts?: { silent?: boolean }): void;
  /** 景别预设 → 机位（与 3D 片场监视器同表） */
  applyFraming(framing: string, focalLength?: number, rollDeg?: number): StageCameraState;
  /** 计算导出尺寸（偶数宽高） */
  exportSize(opts?: ExportSizeOptions): { width: number; height: number };
  snapshotPNG(opts?: SnapshotOptions): Promise<Blob>;
  /** 按关键帧（秒）实时录制运镜视频；返回 MP4 或 WebM（看浏览器支持，blob.type 可判断） */
  recordCameraPath(keyframes: CameraKeyframe[], durationSec?: number, fps?: number, opts?: RecordOptions): Promise<Blob>;
  dispose(): void;
}

/** MediaRecorder 可用的视频 MIME：优先 MP4(H.264)，再退 WebM；都不支持返回 '' */
export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1.420028',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** REQ-toonflow-canvas C1 录制收尾：末帧后至少可等多久（实际上限再加运镜时长，管线卡死时尽力而为） */
const RECORD_DRAIN_MAX_MS = 4000;
/** 末帧后最多等多久的绝对上限 */
const RECORD_DRAIN_CAP_MS = 15000;
/** 没有帧探针时（非 Chromium），末帧后至少等多久 */
const RECORD_DRAIN_MIN_MS = 600;
/** 没有帧探针、录制器也不增量吐数据（整段封装到 stop 才输出）时，末帧后至少等多久（看不到进度，只能多等） */
const RECORD_DRAIN_BLIND_MS = 1500;
/** 没有帧探针时，轮询 requestData 的间隔 */
const RECORD_DRAIN_POLL_MS = 150;
/** 探针看到末帧离开采集管线后，再留给编码器的时间（Chromium 编码队列最多积压约 10 帧） */
const RECORD_ENCODER_GRACE_MS = 200;
/** 探针兜底：末帧画完后已有帧到达、随后这么久没有新帧，视为管线已排空（时间戳语义对不上时用） */
const PROBE_QUIET_MS = 1000;

interface FrameProbe {
  /**
   * 等末帧离开采集管线：看到时间戳（相对建流时刻）≥ relMs 的帧，或末帧画完后（finalAt 之后）有帧到达且随后
   * PROBE_QUIET_MS 内再无新帧，返回 true；`cancelled()` 变真、探针关闭或超时返回 false。
   */
  waitFor(relMs: number, finalAt: number, cancelled: () => boolean, timeoutMs: number): Promise<boolean>;
  close(): void;
}

/**
 * REQ-toonflow-canvas C1 · 采集管线探针：在克隆的视频轨道上挂 MediaStreamTrackProcessor（Chromium 才有），
 * 读到的帧就是录制器同时收到的帧（同源同时分发），用时间戳判断末帧是否已经离开采集管线。不支持时返回 null。
 *
 * 时间戳原点：Chromium 画布采集的帧时间戳从建流时刻（首帧）起算。探针在机器忙时会漏掉开头几帧，
 * 所以不能拿它读到的第一帧当原点——第一帧时间戳落在 [0, 到达时刻] 内就认定原点 = 建流时刻 `t0`；
 * 否则（其他实现用绝对时钟）退回以第一帧为原点，再加「排空后静默」兜底。
 */
function createFrameProbe(stream: MediaStream, t0: number): FrameProbe | null {
  type ProbeFrame = { timestamp: number; close(): void };
  const Processor = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<ProbeFrame> } }).MediaStreamTrackProcessor;
  const track = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : undefined;
  if (typeof Processor !== 'function' || !track || typeof track.clone !== 'function') return null;
  let clone: MediaStreamTrack | null = null;
  let reader: ReadableStreamDefaultReader<ProbeFrame>;
  try {
    clone = track.clone();
    reader = new Processor({ track: clone }).readable.getReader();
  } catch {
    try { clone?.stop(); } catch { /* ignore */ }
    return null;
  }
  let origin = Number.NaN;
  let latestRelMs = -Infinity;
  let lastArrival = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const tsMs = value.timestamp / 1000;
        try { value.close(); } catch { /* ignore */ }
        lastArrival = performance.now();
        if (Number.isNaN(origin)) origin = tsMs >= -50 && tsMs <= lastArrival - t0 + 50 ? 0 : tsMs;
        latestRelMs = Math.max(latestRelMs, tsMs - origin);
        notify();
      }
    } catch { /* 探针被关闭 */ }
    closed = true;
    notify();
  })();
  return {
    waitFor: (relMs, finalAt, cancelled, timeoutMs) => new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(poll);
        listeners.delete(check);
        resolve(ok);
      };
      const check = () => {
        if (latestRelMs >= relMs) finish(true);
        else if (lastArrival > finalAt && performance.now() - lastArrival >= PROBE_QUIET_MS) finish(true);
        else if (closed || cancelled()) finish(false);
      };
      const deadline = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(check, 50);
      listeners.add(check);
      check();
    }),
    close: () => {
      closed = true;
      try { void reader.cancel(); } catch { /* ignore */ }
      try { clone?.stop(); } catch { /* ignore */ }
      notify();
    },
  };
}

/** 画布 → Blob（toBlob 失败时报错，而不是 resolve(null)） */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画面导出失败（画布不可读）'))), type, quality);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats as THREE.Material[]) {
      const map = (m as any).map as THREE.Texture | undefined;
      if (map?.dispose) map.dispose();
      m.dispose();
    }
  });
}

/** REQ-toonflow-canvas 在容器里创建精简 3D 舞台（N5 director3d 节点内嵌用） */
export function createMiniStage(container: HTMLElement, opts: MiniStageOptions = {}): MiniStage {
  const interactive = opts.interactive !== false;
  let aspectOpt = opts.aspect && opts.aspect > 0 ? opts.aspect : undefined;
  let disposed = false;

  const size = () => ({ w: Math.max(1, container.clientWidth || 1), h: Math.max(1, container.clientHeight || 1) });
  const { w: w0, h: h0 } = size();

  // —— 场景 / 摄影机 / 渲染器（与 3D 片场主视图同参） ——
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(STAGE_BACKGROUND);
  scene.fog = new THREE.FogExp2(STAGE_BACKGROUND, STAGE_FOG_DENSITY);
  const camera = new THREE.PerspectiveCamera(45, aspectOpt ?? w0 / h0, 0.1, 100);
  const renderer = createStageRenderer({ width: w0, height: h0, pixelRatio: opts.pixelRatio, shadowMapType: THREE.PCFShadowMap });
  renderer.autoClear = false;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  const lights = createThreePointLights(scene);
  let lighting: LightingConfig = { ...DEFAULT_LIGHTING, ...(opts.lighting || {}) };
  applyLightingConfig(lights, renderer, lighting);

  const envGroup = new THREE.Group();
  envGroup.name = 'env_group';
  scene.add(envGroup);
  const entities = new THREE.Group();
  entities.name = 'stage_entities';
  scene.add(entities);

  // —— 帧区域（letterbox）：画幅固定时在容器内居中等比 ——
  const frame = () => {
    const { w, h } = size();
    if (!aspectOpt) return { x: 0, y: 0, w, h };
    let fw = w;
    let fh = Math.round(w / aspectOpt);
    if (fh > h) { fh = h; fw = Math.round(h * aspectOpt); }
    return { x: Math.floor((w - fw) / 2), y: Math.floor((h - fh) / 2), w: fw, h: fh };
  };
  // REQ-toonflow-canvas C1：帧区域是布局像素（与渲染器视口同一单位），getBoundingClientRect 是屏幕像素。
  // 舞台挂在被 CSS 缩放的容器里（画布 zoom ≠ 1）时两者差一个缩放比，必须按比例换算后再与 clientX/Y 比较。
  // 优先量画布元素本身（它承载渲染结果；容器带内边距时画布被拉伸也能对上），量不到（未布局 / jsdom）退回容器。
  const frameClientRect = () => {
    const cr = renderer.domElement.getBoundingClientRect();
    const rect = cr.width > 0 && cr.height > 0 ? cr : container.getBoundingClientRect();
    return layoutRectToClient(rect, size(), frame());
  };

  // —— 渲染（按需） ——
  let rafId = 0;
  const render = () => {
    if (disposed) return;
    const { h } = size();
    const f = frame();
    // 先整幅清成透明（留边区露出容器底色），再在帧区域内渲染；颜色背景会在 scissor 内自行清屏
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    // WebGL 视口原点在左下角
    renderer.setViewport(f.x, h - f.y - f.h, f.w, f.h);
    renderer.setScissor(f.x, h - f.y - f.h, f.w, f.h);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  };
  const invalidate = () => {
    if (disposed || rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  };

  const resize = () => {
    if (disposed) return;
    const { w, h } = size();
    renderer.setSize(w, h, false);
    camera.aspect = aspectOpt ?? w / h;
    camera.updateProjectionMatrix();
    invalidate();
  };
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(container);
  }

  // —— 机位（轨道球坐标 + roll 记账） ——
  const orbit = createOrbitState();
  let roll = 0;
  const cameraState = (): StageCameraState => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [orbit.target.x, orbit.target.y, orbit.target.z],
    fov: camera.fov,
    roll,
  });
  const emitCamera = () => opts.onCameraChange?.(cameraState());
  const setCameraState = (state: StageCameraState, o: { silent?: boolean } = {}) => {
    applyCameraState(camera, state);
    roll = state.roll || 0;
    const o2 = orbitFromPose(state.position, state.target);
    orbit.target.copy(o2.target);
    orbit.radius = o2.radius;
    orbit.theta = o2.theta;
    orbit.phi = o2.phi;
    invalidate();
    if (!o.silent) emitCamera();
  };
  const applyOrbit = () => {
    applyOrbitToCamera(camera, orbit);
    applyCameraRoll(camera, roll);
    invalidate();
  };

  // —— 环境 ——
  const setEnvironment = (env: MiniStageEnvironment) => {
    if (env === 'plain') {
      buildStageEnvironment(scene, envGroup, 'plain'); // 只做清理（非预设环境）
      scene.background = new THREE.Color(STAGE_BACKGROUND);
      scene.fog = new THREE.FogExp2(STAGE_BACKGROUND, STAGE_FOG_DENSITY);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ color: 0x0f0f1a, metalness: 0.6, roughness: 0.35 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      envGroup.add(floor);
      const grid = new THREE.GridHelper(20, 40, 0x7c3aed, 0x1a1a2e);
      grid.position.y = 0.01;
      envGroup.add(grid);
    } else {
      buildStageEnvironment(scene, envGroup, env);
    }
    invalidate();
  };

  // —— 布偶 ——
  const addMannequin = (m: MiniStageMember): THREE.Group => {
    const role = m.role || 'protagonist';
    const entity = m.entity || `entity_${role}`;
    const existing = entities.getObjectByName(entity);
    if (existing && existing.parent === entities) { entities.remove(existing); disposeObjectTree(existing); }
    const g = createPoseMannequin({
      pose: m.pose || 'stand',
      role,
      accentColor: m.accentColor ?? (ROLE_ACCENT_COLORS as Record<string, number>)[role] ?? ROLE_ACCENT_COLORS.protagonist,
    });
    g.name = entity;
    if (m.joints) applyMannequinJoints(g, m.joints);
    const p = m.position || [0, 0, 0];
    g.position.set(p[0], p[1], p[2]);
    if (m.rotationY !== undefined) g.rotation.y = m.rotationY;
    entities.add(g);
    invalidate();
    return g;
  };
  const removeEntity = (entity: string) => {
    const o = entities.getObjectByName(entity);
    if (o && o.parent === entities) { entities.remove(o); disposeObjectTree(o); invalidate(); }
  };
  const clearEntities = () => {
    for (const c of [...entities.children]) { entities.remove(c); disposeObjectTree(c); }
  };
  const setCast = (castLayout: CastLayout | string, pose: PosePreset, joints?: MannequinPose['entities']) => {
    clearEntities();
    for (const spec of castMembers(castLayout, pose)) {
      addMannequin({ ...spec, joints: joints?.[spec.entity]?.joints });
    }
    invalidate();
  };
  const mannequins = () => entities.children.filter((o) => !!getMannequinRig(o));
  const getMannequinPose = (): MannequinPose => {
    const out: MannequinPose = { v: 1, entities: {} };
    for (const o of mannequins()) out.entities[o.name] = { joints: serializeMannequinJoints(o) };
    return out;
  };
  const applyMannequinPose = (pose: MannequinPose | MannequinPose['entities'] | undefined) => {
    const map = ((pose as MannequinPose)?.entities ?? pose ?? {}) as MannequinPose['entities'];
    for (const o of mannequins()) {
      const joints = map[o.name]?.joints;
      if (joints) applyMannequinJoints(o, joints);
      else resetMannequinJoints(o);
    }
    invalidate();
  };

  // —— 交互：轨道视角 + 关节拖拽（与 3D 片场同一套拾取 / 拖拽 / 限位） ——
  type JointDrag = { entity: string; jointId: string; group: THREE.Object3D; limits: JointAxisLimits; lastX: number; lastY: number; moved: boolean; twist: boolean };
  let jointDrag: JointDrag | null = null;
  let orbitMode: 'rotate' | 'pan' | null = null;
  let orbitMoved = false;
  let prevX = 0;
  let prevY = 0;
  let downX = 0;
  let downY = 0;
  const el = renderer.domElement;
  const raycast = (clientX: number, clientY: number) => {
    camera.updateMatrixWorld();
    return raycasterAt(clientX, clientY, frameClientRect(), camera);
  };
  const jointAt = (clientX: number, clientY: number) => pickJoint(raycast(clientX, clientY), entities, opts.isLocked);

  const onPointerDown = (e: PointerEvent) => {
    if (!interactive) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件无 pointerId 时忽略 */ }
    prevX = downX = e.clientX;
    prevY = downY = e.clientY;
    orbitMoved = false;
    if (e.button === 0) {
      const hit = jointAt(e.clientX, e.clientY);
      if (hit) {
        jointDrag = { ...hit, lastX: e.clientX, lastY: e.clientY, moved: false, twist: e.shiftKey };
        el.style.cursor = 'grabbing';
        opts.onSelect?.(hit.entity, hit.jointId);
        return;
      }
      orbitMode = 'rotate';
    } else if (e.button === 1 || e.button === 2) {
      orbitMode = 'pan';
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!interactive) return;
    const jd = jointDrag;
    if (jd) {
      const dx = e.clientX - jd.lastX;
      const dy = e.clientY - jd.lastY;
      jd.lastX = e.clientX;
      jd.lastY = e.clientY;
      if (!dx && !dy) return;
      jd.moved = true;
      camera.updateMatrixWorld();
      dragRotateJoint(jd.group, jd.limits, dx, dy, e.shiftKey || jd.twist, camera);
      invalidate();
      return;
    }
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    prevX = e.clientX;
    prevY = e.clientY;
    if (orbitMode === 'rotate') {
      if (!orbitMoved && Math.hypot(e.clientX - downX, e.clientY - downY) <= 3) return;
      orbitMoved = true;
      orbit.theta -= dx * 0.006;
      orbit.phi -= dy * 0.006;
      applyOrbit();
    } else if (orbitMode === 'pan') {
      orbitMoved = true;
      const factor = orbit.radius * 0.0015;
      orbit.target.x -= dx * factor;
      orbit.target.y += dy * factor;
      applyOrbit();
    } else if (e.buttons === 0) {
      el.style.cursor = jointAt(e.clientX, e.clientY) ? 'grab' : '';
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const jd = jointDrag;
    if (jd) {
      jointDrag = null;
      el.style.cursor = '';
      if (jd.moved) {
        const root = entities.getObjectByName(jd.entity);
        if (root) opts.onJointsChange?.(jd.entity, serializeMannequinJoints(root));
      }
      return;
    }
    if (orbitMode === 'rotate' && !orbitMoved) opts.onSelect?.(null);
    if (orbitMode && orbitMoved) emitCamera();
    orbitMode = null;
    orbitMoved = false;
  };
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  const onWheel = (e: WheelEvent) => {
    if (!interactive) return;
    e.preventDefault();
    orbit.radius = Math.max(1.2, Math.min(16.0, orbit.radius + e.deltaY * 0.003));
    applyOrbit();
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTimer = null; emitCamera(); }, 200);
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContextMenu);

  // —— 导出 ——
  const exportSize = (o: ExportSizeOptions = {}) => {
    if (o.width && o.height) return { width: even(o.width), height: even(o.height) };
    const f = frame();
    const aspect = aspectOpt ?? f.w / Math.max(1, f.h);
    const longEdge = o.longEdge && o.longEdge > 0 ? o.longEdge : 1280;
    return aspect >= 1
      ? { width: even(longEdge), height: even(longEdge / aspect) }
      : { width: even(longEdge * aspect), height: even(longEdge) };
  };
  /** 离屏渲染器（与主视图同参）；用完 dispose + 主动释放 WebGL 上下文，避免挤掉页面上其他舞台 */
  const withOffscreen = async <T,>(width: number, height: number, fn: (r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) => Promise<T>): Promise<T> => {
    const canvas = document.createElement('canvas');
    const r = createStageRenderer({ width, height, canvas, pixelRatio: 1, exposure: renderer.toneMappingExposure, shadowMapType: THREE.PCFShadowMap });
    const cam = camera.clone();
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    try {
      return await fn(r, cam, canvas);
    } finally {
      r.dispose();
      try { r.forceContextLoss(); } catch { /* ignore */ }
    }
  };

  const snapshotPNG = (o: SnapshotOptions = {}) => {
    const { width, height } = exportSize(o);
    return withOffscreen(width, height, (r, cam, canvas) => {
      if (o.camera) applyCameraState(cam, o.camera);
      r.render(scene, cam);
      return canvasToBlob(canvas, o.type || 'image/png', o.quality);
    });
  };

  /**
   * REQ-toonflow-canvas C1 · 按关键帧实时录制。
   *
   * 时间轴：MediaRecorder 用「画面被采集的时刻」当帧时间戳，成片时长 = 末帧时间戳 + 一帧。所以按 1/fps 的网格出帧，
   * 运镜内容 [0, duration] 均匀映射到 [0, duration − 1 帧] 的墙钟时间上，末帧（内容 = 终点机位）落在 duration − 1 帧，
   * 成片时长正好等于 duration，首帧是起点机位、末帧是终点机位。
   *
   * 收尾（修尾部丢帧）：采集（WebGL 读回像素）和编码在别的线程排队，机器忙时会落后 0.5～1s；
   * 以前末帧后只等两帧就 stop()，还在队列里的帧被直接丢掉，成片尾部被截。现在末帧画完后**不再画新帧**
   * （画面不变就不产生新帧，成片不会变长），等管线把末帧送进录制器再 stop()：
   * - Chromium：在克隆轨道上挂 MediaStreamTrackProcessor 当探针，看到末帧（按时间戳）出了采集管线，再留一点编码时间；
   * - 其他浏览器：录制器还在吐数据（WebM 等增量封装）就接着等，直到连续两次 requestData 无新数据（至少 RECORD_DRAIN_MIN_MS）；
   *   录制器不增量吐数据时看不到进度，至少等 RECORD_DRAIN_BLIND_MS；
   * - 总等待不超过 RECORD_DRAIN_MAX_MS + 运镜时长（封顶 RECORD_DRAIN_CAP_MS；管线卡死时尽力而为）。
   * 实测（无头 Chromium + SwiftShader、1280×720、CPU 压满）：旧逻辑 2.5s 运镜只剩 1.2～1.9s，现在 2.50±0.01s，首末帧机位正确。
   */
  const recordCameraPath = async (keyframes: CameraKeyframe[], durationSec?: number, fps = 30, o: RecordOptions = {}): Promise<Blob> => {
    const frames = normalizeKeyframes(keyframes);
    if (!frames.length) throw new Error('没有可用的机位关键帧');
    const duration = durationSec && durationSec > 0 ? durationSec : cameraKeyframesDuration(frames);
    if (!(duration > 0)) throw new Error('运镜时长必须大于 0');
    const mimeType = o.mimeType || pickRecorderMimeType();
    if (!mimeType) throw new Error('当前浏览器不支持视频录制（MediaRecorder 不可用）');
    if (typeof document !== 'undefined' && document.hidden) throw new Error('请在当前窗口保持可见时导出视频');
    o.signal?.throwIfAborted?.();
    const rate = Math.max(1, Math.min(60, fps || 30));
    const { width, height } = exportSize(o);
    return withOffscreen(width, height, async (r, cam, canvas) => {
      const draw = (t: number) => { applyCameraState(cam, sampleCameraKeyframes(frames, t)); r.render(scene, cam); };
      const interval = 1000 / rate;
      const durationMs = duration * 1000;
      // 末帧的采集时刻（墙钟，相对首帧）：比运镜时长早一帧
      const lastAtMs = Math.max(interval, durationMs - interval);
      draw(0);
      const stream = (canvas as HTMLCanvasElement & { captureStream(frameRate?: number): MediaStream }).captureStream(rate);
      // 首帧（起点机位）在建流时被采集，视频时间轴从这里开始
      const t0 = performance.now();
      const probe = createFrameProbe(stream, t0);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: o.videoBitsPerSecond ?? 8_000_000 });
      const chunks: Blob[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;
      let ended = false;
      try {
        await new Promise<void>((resolve, reject) => {
          let failure: unknown = null;
          let lastDataAt = 0;
          let dataEvents = 0;
          const stop = (err?: unknown) => {
            if (err && !failure) failure = err;
            ended = true;
            if (timer) { clearTimeout(timer); timer = null; }
            if (recorder.state !== 'inactive') recorder.stop();
            else if (failure) reject(failure);
            else resolve();
          };
          onAbort = () => stop(o.signal?.reason ?? new Error('已取消'));
          o.signal?.addEventListener('abort', onAbort, { once: true });
          recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) { chunks.push(ev.data); lastDataAt = performance.now(); dataEvents++; } };
          recorder.onerror = () => stop(new Error('视频编码失败，请重试'));
          recorder.onstop = () => (failure ? reject(failure) : resolve());

          const wait = (ms: number) => new Promise<void>((res) => { timer = setTimeout(() => { timer = null; res(); }, ms); });
          /** 末帧画完后等管线把它送进录制器（见上方说明）；被取消 / 出错时 ended 置位，立即返回 */
          const drain = async (finalMs: number) => {
            const maxWait = Math.min(RECORD_DRAIN_CAP_MS, RECORD_DRAIN_MAX_MS + durationMs);
            if (probe) {
              const seen = await probe.waitFor(finalMs - interval / 2, t0 + finalMs, () => ended, maxWait);
              if (seen && !ended) await wait(Math.max(RECORD_ENCODER_GRACE_MS, interval * 3));
              return;
            }
            const deadline = performance.now() + maxWait;
            // 录制中已经陆续吐过数据（WebM / 分片 MP4）→ 静默即排空；否则看不到进度，按盲等下限
            const minUntil = performance.now() + (dataEvents >= 2 ? RECORD_DRAIN_MIN_MS : RECORD_DRAIN_BLIND_MS);
            let quiet = 0;
            while (!ended && performance.now() < deadline) {
              const before = lastDataAt;
              try { if (typeof recorder.requestData === 'function' && recorder.state === 'recording') recorder.requestData(); } catch { /* ignore */ }
              await wait(RECORD_DRAIN_POLL_MS);
              quiet = lastDataAt === before ? quiet + 1 : 0;
              if (quiet >= 2 && performance.now() >= minUntil) return;
            }
          };

          recorder.start(250);
          const tick = () => {
            timer = null;
            if (ended) return;
            try {
              const elapsed = performance.now() - t0;
              if (elapsed >= lastAtMs) {
                draw(duration);
                o.onProgress?.(1);
                drain(performance.now() - t0).then(() => { if (!ended) stop(); }, (err) => stop(err));
                return;
              }
              draw((duration * elapsed) / lastAtMs);
              o.onProgress?.(Math.min(1, elapsed / lastAtMs));
              // 对齐到 1/fps 网格（不累积 setTimeout 误差）；最后一跳正好落在末帧时刻
              const next = Math.min(lastAtMs, (Math.floor(elapsed / interval) + 1) * interval);
              timer = setTimeout(tick, Math.max(1, next - (performance.now() - t0)));
            } catch (err) { stop(err); }
          };
          timer = setTimeout(tick, 0);
        });
      } finally {
        ended = true;
        if (timer) clearTimeout(timer);
        if (onAbort) o.signal?.removeEventListener('abort', onAbort);
        if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
        probe?.close();
        stream.getTracks().forEach((t) => t.stop());
      }
      const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
      if (!blob.size) throw new Error('未采集到视频画面');
      return blob;
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (wheelTimer) clearTimeout(wheelTimer);
    ro?.disconnect();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', onContextMenu);
    disposeObjectTree(scene);
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch { /* ignore */ }
    try { el.remove(); } catch { /* ignore */ }
  };

  // —— 初始状态 ——
  setEnvironment(opts.environment || 'plain');
  if (opts.cast) opts.cast.forEach((m) => addMannequin(m));
  else setCast(opts.castLayout || 'solo', opts.pose || 'stand');
  setCameraState(opts.camera || framingCameraState(opts.framing || 'medium', opts.focalLength ?? 35, opts.cameraRoll ?? 0), { silent: true });
  render();

  return {
    container,
    scene,
    camera,
    renderer,
    entities,
    render,
    invalidate,
    resize,
    setAspect: (aspect) => { aspectOpt = aspect && aspect > 0 ? aspect : undefined; resize(); },
    setEnvironment,
    setLighting: (cfg) => { lighting = { ...lighting, ...cfg }; applyLightingConfig(lights, renderer, lighting); invalidate(); },
    setCast,
    addMannequin,
    removeEntity,
    listEntities: () => entities.children.map((c) => c.name).filter(Boolean),
    getEntity: (entity) => entities.getObjectByName(entity),
    getMannequinPose,
    getJoints: (entity) => { const o = entities.getObjectByName(entity); return o ? serializeMannequinJoints(o) : {}; },
    setJoints: (entity, joints) => { const o = entities.getObjectByName(entity); if (o) { resetMannequinJoints(o); applyMannequinJoints(o, joints); invalidate(); } },
    applyMannequinPose,
    resetJoints: (entity) => {
      for (const o of mannequins()) if (!entity || o.name === entity) resetMannequinJoints(o);
      invalidate();
    },
    getCameraState: cameraState,
    setCameraState,
    applyFraming: (framing, focalLength = 35, rollDeg = 0) => {
      const s = framingCameraState(framing, focalLength, rollDeg);
      setCameraState(s);
      return s;
    },
    exportSize,
    snapshotPNG,
    recordCameraPath,
    dispose,
  };
}
