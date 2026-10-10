import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { useDirectorAgent } from '../canvas/hooks/useDirectorAgent';
import { useCanvasStore } from '../../stores/useCanvasStore';
import {
  Camera,
  Move,
  Rotate3d,
  Eye,
  Crosshair,
  Sparkles,
  Check,
  Maximize2,
  Video,
  Play,
  Pause,
  Layers,
  RefreshCw,
  Sliders,
  Compass,
  Monitor,
  ChevronDown,
  Shield,
  Sword,
  Wand2,
  Users,
  Grid,
  Sun,
  CameraOff,
  Zap,
  Download,
  Flame,
  ArrowRight,
  Focus,
  Activity,
  Maximize,
  Box,
  Mountain,
  Building2,
  Trees,
  Cloud,
  UserPlus,
  Trash2,
  Palette,
  Lightbulb,
  Film,
  Mic,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';
import { apiService } from '../../services/api';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import {
  CameraFraming,
  CameraMotion,
  PosePreset,
  CastLayout,
  StagePropType,
  StageEnvironment,
  StoryboardShot,
} from '../../types';
import { FRAMING_PRESETS, MOTION_PRESETS, POSE_PRESETS, CAST_LAYOUTS } from './directorPresets';
import { syncDirectorPacks, listDirectorPackProps, listDirectorPackEnvironments, getDirectorPackEnv } from './directorPackSpecs';
import { UISlot } from '../../ui-registry/UISlot';
import { DirectorPackBridgeContext } from '../../ui-registry/directorPackBridge';
import { syncDirectorPackEntries, clearDirectorPackEntries } from '../../ui-registry/adapters/directorPackEntries';
import { useUIEntries } from '../../ui-registry/resolveEnabled';
import { DIRECTOR_ENVS_HOST, DIRECTOR_PROPS_HOST } from '../../ui-registry/types';

// ============================================================
// MiniMax Design 3D Director - 重构版
// 对标 houdao.com / design.minimax.io 的 3D Director Stage：
// - 真实人体建模（非火柴人）+ PBR 材质 + 骨骼姿态驱动
// - 真实道具建模 + 多环境完整场景（赛博/云海/荒漠/霓虹）+ Agent 自然语言全量控制
// ============================================================

// 基础真实模型库（CC0，来自 three.js / Khronos Sample Models，已下载至 public/models）
const MODEL_URLS: Record<string, string> = {
  human_protagonist: '/models/RobotExpressive.glb', // CC0 RobotExpressive
  human_antagonist: '/models/Soldier.glb', // 2MB 高细节士兵
  human_supporting: '/models/RobotExpressive.glb',
  chair: '/models/SheenChair.glb', // 4.3MB 椅子
  helmet: '/models/DamagedHelmet.glb', // 3.7MB 头盔
  camera_prop: '/models/AntiqueCamera.glb', // 复古相机
  avocado: '/models/Avocado.glb',
  boombox: '/models/BoomBox.glb',
};
const gltfLoader = new GLTFLoader();
const modelCache = new Map<string, THREE.Group>();
/** 正在加载中的 URL → 同一个 Promise。缓存是 await 之后才写的，没有这张表的话
 *  同一个模型的并发请求会各自完整下载+解析一遍（实测 BoomBox 被拉了两次）。 */
const modelInflight = new Map<string, Promise<THREE.Group | null>>();
/** 加载失败过的 URL。坏文件不记下来的话，每放一次道具都会重试一轮，
 *  一个坏 GLB 能刷出 8 次解析失败 + 30 条贴图报错。 */
const modelFailed = new Set<string>();

function cloneWithOwnMaterials(src: THREE.Group): THREE.Group {
  const clone = src.clone(true) as THREE.Group;
  // 深拷贝材质避免共享
  clone.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      if (Array.isArray(m.material)) m.material = (m.material as any[]).map((mat: any) => mat.clone());
      else if (m.material) m.material = (m.material as any).clone();
    }
  });
  return clone;
}

/** GLB 完整性预检：文件头第 8 字节起是声明的总长度，和实际字节数对不上就是下载被截断。
 *  不先验的话 GLTFLoader 只会抛一句没头没尾的 `Invalid typed array length`。 */
async function assertGlbIntact(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 12) throw new Error(`文件只有 ${buf.byteLength} 字节，不是合法 GLB`);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'glTF') throw new Error(`不是 GLB（文件头为 ${JSON.stringify(magic)}）`);
  const declared = dv.getUint32(8, true);
  if (declared !== buf.byteLength) {
    throw new Error(
      `GLB 文件不完整：实际 ${buf.byteLength} 字节，文件头声明 ${declared} 字节`
      + `（缺 ${declared - buf.byteLength}）。这份模型下载时被截断了，需要重新下载。`,
    );
  }
  return buf;
}

async function loadGLBModel(url: string, scale = 1): Promise<THREE.Group | null> {
  if (modelCache.has(url)) return cloneWithOwnMaterials(modelCache.get(url)!);
  if (modelFailed.has(url)) return null;
  const pending = modelInflight.get(url);
  if (pending) {
    const root = await pending;
    return root ? cloneWithOwnMaterials(root) : null;
  }
  const task = loadGLBModelOnce(url, scale);
  modelInflight.set(url, task);
  try {
    const root = await task;
    return root ? cloneWithOwnMaterials(root) : null;
  } finally {
    modelInflight.delete(url);
  }
}

async function loadGLBModelOnce(url: string, scale = 1): Promise<THREE.Group | null> {
  try {
    const buf = await assertGlbIntact(url);
    const gltf = await gltfLoader.parseAsync(buf, '');
    const root = gltf.scene as THREE.Group;
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 修正过亮的金属度
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat && (mat as any).isMeshStandardMaterial) {
          if (mat.metalness > 0.9) mat.metalness = 0.3;
          mat.needsUpdate = true;
        }
      }
    });
    // 归一化尺寸至 ~1.6m 高
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      const s = (1.6 / maxDim) * scale;
      root.scale.setScalar(s);
    }
    // 底部对齐到 y=0
    const box2 = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    root.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
    // 淡入
    root.traverse((obj) => {
      if ((obj as any).isMesh) (obj as THREE.Mesh).userData.isRealModel = true;
    });
    modelCache.set(url, root);
    return root;
  } catch (e) {
    modelFailed.add(url);
    console.warn(`[Director3D] GLB 加载失败 ${url}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// 预设已迁移至 ./directorPresets（舞台与画布节点同源），此处仅保留舞台私有的焦距档位
const FOCAL_PRESETS = [16, 24, 35, 50, 85, 135];

// 基础三点光色温预设（主光颜色，轮廓光保持冷色勾边）
const KEY_TEMPS: Record<string, { label: string; color: number }> = {
  neon: { label: '霓虹紫', color: 0x7c3aed },
  cold: { label: '冷白', color: 0xf5f7ff },
  warm: { label: '暖黄', color: 0xffb46b },
  moon: { label: '月夜蓝', color: 0x9bbcff },
};

const ENV_LABELS: Record<StageEnvironment, { label: string; desc: string; icon: string }> = {
  cyber_studio: { label: '暗黑赛博影棚', desc: '霓虹网格+城市天际线', icon: '🏙️' },
  xianxia_cloud: { label: '修仙云海仙山', desc: '浮空山+云雾缭绕', icon: '⛰️' },
  desert_battle: { label: '决战古荒漠', desc: '沙丘+落日+岩石', icon: '🏜️' },
  neon_city: { label: '雨夜霓虹都市', desc: '湿漉街道+雨滴反射', icon: '🌃' },
};

/** "9:16" / "16/9" → 数值宽高比；非法回退 9:16。 */
const ratioToNumber = (ratio?: string): number => {
  const m = String(ratio || '').match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]) / parseFloat(m[2]);
    if (isFinite(n) && n > 0) return n;
  }
  return 9 / 16;
};

/** 摄影机位（对标 LibTV 导演台：多机位保存/切换/多视角截图） */
interface StageCamera {
  id: string;
  name: string;
  pos: [number, number, number];
  quat: [number, number, number, number];
  fov: number;
}

/** 截图队列项（本地 dataUrl 立即可用；上传成功后带资产地址） */
interface QueueShot {
  id: string;
  camera: string;
  dataUrl: string;
  assetUrl?: string;
  uploading?: boolean;
  error?: string;
}

export const Director3DStage: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pipContainerRef = useRef<HTMLDivElement>(null);
  const pipBoxRef = useRef<HTMLDivElement>(null);
  const [pipFrame, setPipFrame] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const { project, activeShotId, setActiveShotId, updateShot } = useProjectStore();
  const { invokeTool } = useMcpStore();

  // 画幅唯一真源：项目 aspect_ratio（与生成结果一致）
  const projectAspect = project?.aspect_ratio || '9:16';
  const projectAspectNum = ratioToNumber(projectAspect);

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((sh) => sh.id === activeShotId) || shots[0];

  // 1. Stage & Optical States
  const [framing, setFraming] = useState<CameraFraming>(activeShot?.camera_framing || 'medium');
  const [motion, setMotion] = useState<CameraMotion>(activeShot?.camera_motion || 'push_in');
  const [pose, setPose] = useState<PosePreset>(activeShot?.pose_preset || 'stand');
  const [castLayout, setCastLayout] = useState<CastLayout>(activeShot?.cast_layout || 'solo');
  const [focalLength, setFocalLength] = useState<number>(activeShot?.focal_length_mm || 35);
  const [cameraRoll, setCameraRoll] = useState<number>(activeShot?.camera_roll_deg || 0);
  const [motionSpeed, setMotionSpeed] = useState<'0.5x' | '1.0x' | '1.5x' | '2.0x'>('1.0x');
  const [motionEasing, setMotionEasing] = useState<'linear' | 'ease_in_out' | 'explosive' | 'slow_out'>('ease_in_out');
  // 灯光（基础三点光；环境氛围光由影棚预设叠加）
  const [keyIntensity, setKeyIntensity] = useState(3.2);
  const [keyAzimuth, setKeyAzimuth] = useState(40);
  const [keyTemp, setKeyTemp] = useState<'neon' | 'cold' | 'warm' | 'moon'>('neon');
  const [rimIntensity, setRimIntensity] = useState(3.5);
  const [ambientIntensity, setAmbientIntensity] = useState(1.8);
  const [exposure, setExposure] = useState(1.15);
  // 走位（主角地面路径点，点击地面打点，模拟时沿路径行走）
  const [walkMode, setWalkMode] = useState(false);
  const [waypoints, setWaypoints] = useState<Array<{ x: number; z: number }>>([]);
  const walkModeRef = useRef(false);
  const waypointsRef = useRef<Array<{ x: number; z: number }>>([]);
  // 预演录制（录制监视器画面为 webm，可下载并上传资产库）
  const [isRecording, setIsRecording] = useState(false);
  const [recordUrl, setRecordUrl] = useState<string | null>(null);
  const [recordSecs, setRecordSecs] = useState(0);
  const [recordMsg, setRecordMsg] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<StageEnvironment>('cyber_studio');
  const [propsConfig, setPropsConfig] = useState<StagePropType[]>(['sword', 'magic_circle']);
  // 插件导演包（director_packs 扩展点）：预设注入 + 扩展环境背景底图/GLB 道具
  const [packEnvId, setPackEnvId] = useState('');
  const [packRev, setPackRev] = useState(0);
  /**
   * 注入给导演包条目的桥接（设计 §12 规则 1 / 2）：「按下道具 / 环境之后发生什么」只有舞台知道
   * —— 道具改 `propsConfig`（进而重建场景、装配 GLB），环境改 `packEnvId` + 场景描述。
   * 依赖放进 `propsConfig` / `packEnvId`：行 UI 由条目渲染，选中态必须跟着一起更新。
   */
  const directorBridge = useMemo(() => ({
    toggleProp: (id: string) => setPropsConfig((prev) => (
      prev.includes(id as StagePropType) ? prev.filter((x) => x !== id) : [...prev, id as StagePropType]
    )),
    isPropOn: (id: string) => propsConfig.includes(id as StagePropType),
    applyEnvironment: (id: string) => {
      const env = getDirectorPackEnv(id);
      setPackEnvId(id);
      if (env) setSceneDesc(`${env.label} · ${env.desc || '插件背景底图'}`);
    },
    activeEnvironmentId: packEnvId,
  }), [propsConfig, packEnvId]);
  /** 当前插件环境条目数（宿主据此决定「扩展环境」这一节是否显示，替代改造前的裸数组长度） */
  const envEntries = useUIEntries(DIRECTOR_ENVS_HOST);
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      syncDirectorPacks(project?.id)
        .then(() => {
          if (cancelled) return;
          setPackRev((v) => v + 1);
          // 把插件声明送进注册表（设计 §12 规则 1）：行 UI 由条目渲染，宿主只注入回调。
          // 放在同步完成之后、且不重挂舞台 —— 这台舞台挂着 three.js 场景，重挂很贵。
          syncDirectorPackEntries(listDirectorPackProps(), listDirectorPackEnvironments());
        })
        .catch(() => {});
    };
    sync();
    const h = () => sync();
    window.addEventListener('directorpacks-list-refresh', h as any);
    return () => {
      cancelled = true;
      window.removeEventListener('directorpacks-list-refresh', h as any);
      // 卸载 / 切项目：撤掉导演包条目，别在注册表里留下陈旧行
      clearDirectorPackEntries();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // 2. Agent 场景生成
  const [scenePrompt, setScenePrompt] = useState('');
  const [sceneGenerating, setSceneGenerating] = useState(false);
  const [sceneDesc, setSceneDesc] = useState<string>('赛博影棚 · 霓虹灯光 · 中央舞台');

  // 2.1 本地 GLB 导入
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importingModel, setImportingModel] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [customModelNames, setCustomModelNames] = useState<string[]>([]);

  // 3. Interactive & UI States
  const [selectedEntity, setSelectedEntity] = useState<string | null>('protagonist');
  // —— 对标小云雀/updream的物体摆放：Gizmo模式 + 吸附 + 锁定 + 大纲 + 数值面板 ——
  // 小云雀：选中进可移动态 + 坐标轴手柄 + 右侧数值 + 复位/锁定/撤销
  // updream：G移动/R旋转/W选择/Q导航 + 黄色选中 + 单轴拖 + 图层锁定 + 从当前视角建机位
  // MiniMax Design：Agent自动搭 + 手动微调兜底（本文件既有Agent布景即该层）
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [lockedIds, setLockedIds] = useState<Record<string, boolean>>({});
  const [entityList, setEntityList] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedTransform, setSelectedTransform] = useState<{ p: [number, number, number]; r: [number, number, number]; s: number } | null>(null);
  const gizmoModeRef = useRef<'translate' | 'rotate' | 'scale'>('translate');
  const [compositionGrid, setCompositionGrid] = useState<'rule_of_thirds' | 'golden_ratio' | 'crosshair' | 'diagonal' | 'none'>('rule_of_thirds');
  // 遮幅/比例跟随项目画幅（不再独立默认 9:16，避免与生成结果不一致）
  const [aspectRatioMask, setAspectRatioMask] = useState<string>(project?.aspect_ratio || '9:16');
  useEffect(() => {
    setAspectRatioMask(project?.aspect_ratio || '9:16');
  }, [project?.aspect_ratio]);
  const [showPip, setShowPip] = useState(true);
  const [showHelpers, setShowHelpers] = useState(true);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [isSimulating, setIsSimulating] = useState(false);
  const [scrubberProgress, setScrubberProgress] = useState(0);
  const [activeRightTab, setActiveRightTab] = useState<'optics_motion' | 'cast_props' | 'environment' | 'lighting' | 'agent'>('optics_motion');

  // AI Directing Assistant — unified via useDirectorAgent (single MCP)
  const [aiPrompt, setAiPrompt] = useState('');
  const { execute: directorExecute, loading: aiThinking } = useDirectorAgent();
  const [appliedSuccess, setAppliedSuccess] = useState(false);
  const [snapshotSuccess, setSnapshotSuccess] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);
  const [lastRecordAssetUrl, setLastRecordAssetUrl] = useState<string | null>(null);
  // —— 多机位 + 截图队列（LibTV 式：机位保存/切换 + 多视角截图队列 → 资产库 → 分镜参考）——
  const [stageCameras, setStageCameras] = useState<StageCamera[]>([]);
  const [shotQueue, setShotQueue] = useState<QueueShot[]>([]);
  const [activeCamId, setActiveCamId] = useState<string | null>(null);
  const camOverrideRef = useRef<StageCamera | null>(null);
  const presetKeyRef = useRef('');

  // 同步 activeShot（仅跟随 activeShotId，避免任何 project 更新都重置未保存的手动调整）
  useEffect(() => {
    const st = useProjectStore.getState();
    const shots = st.project?.scenes.flatMap((s) => s.shots) || [];
    const shot = shots.find((sh) => sh.id === st.activeShotId) || shots[0];
    if (!shot) return;
    if (shot.camera_framing) setFraming(shot.camera_framing);
    if (shot.camera_motion) setMotion(shot.camera_motion);
    if (shot.pose_preset) setPose(shot.pose_preset);
    if (shot.focal_length_mm) setFocalLength(shot.focal_length_mm);
    if (shot.camera_roll_deg !== undefined) setCameraRoll(shot.camera_roll_deg);
    if (shot.cast_layout) setCastLayout(shot.cast_layout);
    if (shot.props_config) setPropsConfig(shot.props_config);
    if (shot.motion_speed) setMotionSpeed(shot.motion_speed);
    if (shot.walk_path) setWaypointsBoth(shot.walk_path);
    // 机位列表跟随分镜；切镜清空本镜截图队列与机位覆盖（避免串镜）
    setStageCameras(Array.isArray((shot as any).stage_cameras) ? (shot as any).stage_cameras : []);
    setShotQueue([]);
    camOverrideRef.current = null;
    setActiveCamId(null);
    // 摆位持久化恢复（小云雀式：切镜不丢摆放）
    if ((shot as any).stage_layout) {
      entityTransformsRef.current = { ...(shot as any).stage_layout };
      // 已重建的物体即时应用，未重建的在重建effect中应用
      const g = stageEntitiesGroupRef.current;
      if (g) {
        Object.entries(entityTransformsRef.current).forEach(([id, t]: any) => {
          const o = g.getObjectByName(id);
          if (o && t?.p && t?.r) { o.position.set(t.p[0], t.p[1], t.p[2]); o.rotation.set(t.r[0], t.r[1], t.r[2]); o.scale.setScalar(t.s || 1); }
        });
      }
    } else { entityTransformsRef.current = {}; }
    if (shot.lighting_config) {
      const lc = shot.lighting_config;
      setKeyIntensity(lc.keyIntensity ?? 3.2);
      setKeyAzimuth(lc.keyAzimuth ?? 40);
      setKeyTemp(lc.keyTemp ?? 'neon');
      setRimIntensity(lc.rimIntensity ?? 3.5);
      setAmbientIntensity(lc.ambientIntensity ?? 1.8);
      setExposure(lc.exposure ?? 1.15);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShotId]);

  // 灯光面板 → 基础三点光实时应用（主光方位绕 Y 轴旋转，高度固定）
  useEffect(() => {
    const az = THREE.MathUtils.degToRad(keyAzimuth);
    const r = 6;
    if (keyLightRef.current) {
      keyLightRef.current.position.set(Math.sin(az) * r, 5, Math.cos(az) * r);
      keyLightRef.current.color.setHex(KEY_TEMPS[keyTemp].color);
      keyLightRef.current.intensity = keyIntensity;
    }
    if (rimLightRef.current) rimLightRef.current.intensity = rimIntensity;
    if (ambientRef.current) ambientRef.current.intensity = ambientIntensity;
    if (rendererRef.current) rendererRef.current.toneMappingExposure = exposure;
  }, [keyIntensity, keyAzimuth, keyTemp, rimIntensity, ambientIntensity, exposure]);

  // 走位模式 ref 镜像（供 canvas 点击监听读取，避免闭包过期）
  useEffect(() => { walkModeRef.current = walkMode; }, [walkMode]);

  // 走位路径标记渲染（青色圆点 + 连线，随 waypoints 重建）
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (walkMarkersRef.current) { scene.remove(walkMarkersRef.current); walkMarkersRef.current = null; }
    if (waypoints.length === 0) return;
    const group = new THREE.Group();
    group.name = 'walk_markers';
    const dotGeo = new THREE.SphereGeometry(0.05, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x34c759 });
    waypoints.forEach((wp, idx) => {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(wp.x, 0.06, wp.z);
      group.add(dot);
      if (idx > 0) {
        const prev = waypoints[idx - 1];
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(prev.x, 0.06, prev.z),
          new THREE.Vector3(wp.x, 0.06, wp.z),
        ]);
        group.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x34c759 })));
      }
    });
    scene.add(group);
    walkMarkersRef.current = group;
    return () => { if (walkMarkersRef.current && sceneRef.current) { sceneRef.current.remove(walkMarkersRef.current); walkMarkersRef.current = null; } };
  }, [waypoints]);

  const setWaypointsBoth = useCallback((wps: Array<{ x: number; z: number }>) => {
    waypointsRef.current = wps;
    setWaypoints(wps);
  }, []);

  const clearWalk = useCallback(() => { setWaypointsBoth([]); walkBaseRef.current = null; }, [setWaypointsBoth]);

  // 场景底图背景板：分镜绑定的 scene_ref_image 挂为舞台远景，第1集和第10集同一地点即同背景
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (backdropRef.current) { scene.remove(backdropRef.current); (backdropRef.current.material as THREE.Material)?.dispose?.(); (backdropRef.current.geometry as THREE.BufferGeometry)?.dispose?.(); backdropRef.current = null; }
    const url = activeShot?.scene_ref_image || getDirectorPackEnv(packEnvId)?.background_url;
    if (!url) return;
    let cancelled = false;
    new THREE.TextureLoader().load(url, (tex) => {
      if (cancelled || !sceneRef.current) { tex.dispose(); return; }
      try {
        const geo = new THREE.PlaneGeometry(18, 10);
        const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
        (mat as any).toneMapped = false;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(0, 3.2, -8);
        mesh.name = 'scene_backdrop';
        sceneRef.current.add(mesh);
        backdropRef.current = mesh;
      } catch { tex.dispose(); }
    }, undefined, () => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShotId, (activeShot as any)?.scene_ref_image, packEnvId, packRev]);

  // Three refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const mainCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const virtualCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pipRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const stageEntitiesGroupRef = useRef<THREE.Group | null>(null);
  const envGroupRef = useRef<THREE.Group | null>(null);
  const protagonistGroupRef = useRef<THREE.Group | null>(null);
  const antagonistGroupRef = useRef<THREE.Group | null>(null);
  const trajectoryLineRef = useRef<THREE.Line | null>(null);
  const cameraHelperRef = useRef<THREE.CameraHelper | null>(null);
  // 基础三点光引用（环境光为叠加氛围，不受灯光面板控制）
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const rimLightRef = useRef<THREE.DirectionalLight | null>(null);
  const ambientRef = useRef<THREE.AmbientLight | null>(null);
  // 走位路径标记组 + 模拟起点（避免与位姿/相机状态互相覆盖）
  const walkMarkersRef = useRef<THREE.Group | null>(null);
  const walkBaseRef = useRef<{ x: number; z: number; rotY: number } | null>(null);
  // 场景底图背景板（分镜绑定的 scene_ref_image，预演与剧本场景同地）
  const backdropRef = useRef<THREE.Mesh | null>(null);
  // 预演录制
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<any>(null);
  // —— 物体摆放操控 refs（对标三家：Gizmo + 选中高亮 + 撤销 + 持久化）——
  const transformControlsRef = useRef<TransformControls | null>(null);
  const selectionBoxRef = useRef<THREE.BoxHelper | null>(null);
  const entityTransformsRef = useRef<Record<string, { p: [number, number, number]; r: [number, number, number]; s: number }>>({});
  const undoStackRef = useRef<Array<{ id: string; prev: { p: [number, number, number]; r: [number, number, number]; s: number } }>>([]);
  const gizmoDraggingRef = useRef(false);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const lockedIdsRef = useRef<Record<string, boolean>>({});
  // 跨effect调用的稳定引用（Three初始化闭包用，避免过期闭包）
  const pushUndoRef = useRef<((id: string, prev: { p: [number, number, number]; r: [number, number, number]; s: number }) => void) | null>(null);
  const setSelectedTransformRef = useRef<((t: { p: [number, number, number]; r: [number, number, number]; s: number } | null) => void) | null>(null);
  const applySnapRef = useRef<(() => void) | null>(null);
  useEffect(() => { lockedIdsRef.current = lockedIds; }, [lockedIds]);
  useEffect(() => { gizmoModeRef.current = gizmoMode; if (transformControlsRef.current) transformControlsRef.current.setMode(gizmoMode); }, [gizmoMode]);
  useEffect(() => {
    setSelectedTransformRef.current = setSelectedTransform;
    applySnapRef.current = () => {
      const tc: any = transformControlsRef.current;
      if (!tc) return;
      try {
        if (snapEnabled) { tc.setTranslationSnap(0.1); tc.setRotationSnap(THREE.MathUtils.degToRad(5)); tc.setScaleSnap(0.05); }
        else { tc.setTranslationSnap(null); tc.setRotationSnap(null); tc.setScaleSnap(null); }
      } catch {}
    };
    applySnapRef.current();
  }, [snapEnabled]);

  const orbitStateRef = useRef({
    isRotating: false,
    isPanning: false,
    prevX: 0,
    prevY: 0,
    target: new THREE.Vector3(0, 1.2, 0),
    radius: 4.8,
    theta: 0,
    phi: Math.PI / 3.0,
  });

  const updateMainCameraPosition = useCallback(() => {
    if (!mainCameraRef.current) return;
    const { target, radius, theta, phi } = orbitStateRef.current;
    const clampedPhi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    const x = target.x + radius * Math.sin(clampedPhi) * Math.sin(theta);
    const y = target.y + radius * Math.cos(clampedPhi);
    const z = target.z + radius * Math.sin(clampedPhi) * Math.cos(theta);
    mainCameraRef.current.position.set(x, y, z);
    mainCameraRef.current.lookAt(target);
  }, []);

  const minimaxPromptPreview = useMemo(() => {
    const framingObj = FRAMING_PRESETS.find((f) => f.id === framing);
    const motionObj = MOTION_PRESETS.find((m) => m.id === motion);
    const parts = [`Motion: ${motionObj?.minimaxCode || motion}`, `Framing: ${framingObj?.label || framing}`, `Lens: ${focalLength}mm`];
    if (Math.abs(cameraRoll) > 0.5) parts.push(`Dutch Roll: ${cameraRoll > 0 ? '+' : ''}${cameraRoll.toFixed(1)}°`);
    if (motionSpeed !== '1.0x') parts.push(`Speed: ${motionSpeed}`);
    if (castLayout !== 'solo') parts.push(`Cast Staging: ${castLayout.toUpperCase()}`);
    return `[Camera: ${parts.join(', ')}]`;
  }, [framing, motion, focalLength, cameraRoll, motionSpeed, castLayout]);

  // 道具面板条目：只保留**内置**道具。
  // 插件道具（director_packs.props）已条目化（设计 §12）：宿主注入 toggleProp/isPropOn，
  // 行由 `UISlot host="director3d.props"` 渲染，不再靠 `packRev` 重算这份数组。
  const propOptions = useMemo(() => [
    { id: 'sword' as StagePropType, label: '浮空飞剑', icon: '🗡️', sub: '程序化' },
    { id: 'shield' as StagePropType, label: '聚能护盾', icon: '🛡️', sub: '程序化' },
    { id: 'magic_circle' as StagePropType, label: '地面符文阵', icon: '🌀', sub: '程序化' },
    { id: 'chair' as StagePropType, label: '休闲椅', icon: '🪑', sub: 'SheenChair.glb' },
    { id: 'helmet' as StagePropType, label: '破损头盔', icon: '⛑️', sub: 'DamagedHelmet.glb' },
    { id: 'camera' as StagePropType, label: '复古相机', icon: '📷', sub: 'AntiqueCamera.glb' },
    { id: 'avocado' as StagePropType, label: '牛油果', icon: '🥑', sub: 'Avocado.glb' },
    { id: 'boombox' as StagePropType, label: '音响', icon: '🔊', sub: 'BoomBox.glb' },
  ], []);

  const handleResetView = useCallback(() => {
    orbitStateRef.current.target.set(0, 1.2, 0);
    orbitStateRef.current.radius = 4.8;
    orbitStateRef.current.theta = 0;
    orbitStateRef.current.phi = Math.PI / 3.0;
    updateMainCameraPosition();
  }, [updateMainCameraPosition]);

  // ============================================================
  // 物体摆放操控 helpers（对标 小云雀/ updream / MiniMax Design）
  // ============================================================
  const entityLabel = useCallback((id: string): string => {
    if (id === 'protagonist' || id === 'entity_protagonist') return '主角';
    if (id === 'antagonist' || id === 'entity_antagonist') return '对手';
    if (id === 'supporting' || id === 'entity_supporting') return '配角';
    if (id.includes('sword')) return '飞剑';
    if (id.includes('shield')) return '护盾';
    if (id.includes('magic_circle')) return '符文阵';
    if (id.includes('chair')) return '椅子';
    if (id.includes('helmet')) return '头盔';
    if (id.includes('camera')) return '相机道具';
    if (id.includes('avocado')) return '牛油果';
    if (id.includes('boombox') || id.includes('boom')) return '音响';
    if (id.includes('incense')) return '香炉';
    if (id.includes('flag')) return '战旗';
    if (id.startsWith('custom_')) return `导入模型(${id.slice(-4)})`;
    return id.replace('entity_', '').replace('prop_', '');
  }, []);

  const findStageRoot = useCallback((obj: THREE.Object3D | null): THREE.Object3D | null => {
    if (!obj || !stageEntitiesGroupRef.current) return null;
    let cur: THREE.Object3D | null = obj;
    while (cur && cur.parent && cur.parent !== stageEntitiesGroupRef.current) cur = cur.parent;
    if (cur && cur.parent === stageEntitiesGroupRef.current) return cur;
    return null;
  }, []);

  const snapshotObjectTransform = useCallback((obj: THREE.Object3D) => {
    const p: [number, number, number] = [obj.position.x, obj.position.y, obj.position.z];
    const r: [number, number, number] = [obj.rotation.x, obj.rotation.y, obj.rotation.z];
    const s = obj.scale.x;
    return { p, r, s };
  }, []);

  const refreshEntityList = useCallback(() => {
    const g = stageEntitiesGroupRef.current;
    if (!g) return;
    const list = g.children
      .filter((c) => c.name && !c.name.startsWith('walk_'))
      .map((c) => ({ id: c.name, label: '' }));
    setEntityList(list.map((e) => ({ ...e, label: entityLabel(e.id) })));
  }, [entityLabel]);

  const attachGizmoTo = useCallback((id: string | null) => {
    const tc = transformControlsRef.current;
    const scene = sceneRef.current;
    if (!tc || !scene) return;
    // 清旧高亮
    if (selectionBoxRef.current) { scene.remove(selectionBoxRef.current); (selectionBoxRef.current as any)?.dispose?.(); selectionBoxRef.current = null; }
    if (!id || !stageEntitiesGroupRef.current) { try { (tc as any).detach(); } catch {} setSelectedTransform(null); return; }
    const obj = stageEntitiesGroupRef.current.getObjectByName(id);
    if (!obj) { try { (tc as any).detach(); } catch {} setSelectedTransform(null); return; }
    if (lockedIdsRef.current[id]) { try { (tc as any).detach(); } catch {} }
    else { try { (tc as any).attach(obj); } catch {} }
    try {
      const box = new THREE.BoxHelper(obj as THREE.Object3D, 0x00d2ff);
      (box.material as THREE.Material).transparent = true;
      (box.material as any).opacity = 0.9;
      scene.add(box);
      selectionBoxRef.current = box;
    } catch {}
    // updream式黄显：选中物体描边感（emissive轻提），取消时由重建/下次选中覆盖
    setSelectedTransform(snapshotObjectTransform(obj));
  }, [snapshotObjectTransform]);

  const selectEntity = useCallback((id: string | null) => {
    setSelectedEntity(id);
    (window as any).__director_selected__ = id;
    attachGizmoTo(id);
  }, [attachGizmoTo]);

  const pushUndo = useCallback((id: string, prev: { p: [number, number, number]; r: [number, number, number]; s: number }) => {
    undoStackRef.current.push({ id, prev });
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
  }, []);

  const undoLastTransform = useCallback(() => {
    const top = undoStackRef.current.pop();
    if (!top || !stageEntitiesGroupRef.current) return;
    const obj = stageEntitiesGroupRef.current.getObjectByName(top.id);
    if (!obj) return;
    obj.position.set(...top.prev.p);
    obj.rotation.set(...top.prev.r);
    obj.scale.setScalar(top.prev.s);
    entityTransformsRef.current[top.id] = { ...top.prev };
    if (selectionBoxRef.current) selectionBoxRef.current.update();
    setSelectedTransform({ ...top.prev });
  }, []);

  const applyNumericToSelected = useCallback((patch: Partial<{ px: number; py: number; pz: number; ry: number; s: number }>) => {
    if (!selectedEntity || !stageEntitiesGroupRef.current) return;
    const obj = stageEntitiesGroupRef.current.getObjectByName(selectedEntity);
    if (!obj) return;
    pushUndo(selectedEntity, snapshotObjectTransform(obj));
    if (patch.px !== undefined) obj.position.x = patch.px;
    if (patch.py !== undefined) obj.position.y = Math.max(0, patch.py);
    if (patch.pz !== undefined) obj.position.z = patch.pz;
    if (patch.ry !== undefined) obj.rotation.y = (patch.ry * Math.PI) / 180;
    if (patch.s !== undefined) obj.scale.setScalar(Math.max(0.1, Math.min(5, patch.s)));
    const snap = snapshotObjectTransform(obj);
    entityTransformsRef.current[selectedEntity] = snap;
    if (selectionBoxRef.current) selectionBoxRef.current.update();
    setSelectedTransform(snap);
  }, [selectedEntity, pushUndo, snapshotObjectTransform]);

  const resetSelectedTransform = useCallback(() => {
    if (!selectedEntity || !stageEntitiesGroupRef.current) return;
    const obj = stageEntitiesGroupRef.current.getObjectByName(selectedEntity);
    if (!obj) return;
    pushUndo(selectedEntity, snapshotObjectTransform(obj));
    // 小云雀式复位：回到该类物体的默认摆位（角色回原点/道具回预设）
    const defaults: Record<string, { p: [number, number, number]; ry: number }> = {
      entity_protagonist: { p: [0, 0, 0], ry: 0 },
      entity_antagonist: { p: [0, 0, -2.3], ry: 180 },
      entity_supporting: { p: [-1.9, 0, -1.2], ry: 108 },
    };
    const d = defaults[selectedEntity];
    if (d) { obj.position.set(...d.p); obj.rotation.set(0, (d.ry * Math.PI) / 180, 0); obj.scale.setScalar(1); }
    else { obj.position.set(0, obj.position.y * 0 + (selectedEntity.includes('magic_circle') ? 0.02 : 0.5), 0); obj.rotation.set(0, 0, 0); obj.scale.setScalar(1); }
    const snap = snapshotObjectTransform(obj);
    entityTransformsRef.current[selectedEntity] = snap;
    if (selectionBoxRef.current) selectionBoxRef.current.update();
    setSelectedTransform(snap);
  }, [selectedEntity, pushUndo, snapshotObjectTransform]);

  const deleteSelectedCustom = useCallback(() => {
    if (!selectedEntity || !stageEntitiesGroupRef.current) return;
    if (!selectedEntity.startsWith('custom_')) return;
    const obj = stageEntitiesGroupRef.current.getObjectByName(selectedEntity);
    if (obj) stageEntitiesGroupRef.current.remove(obj);
    delete entityTransformsRef.current[selectedEntity];
    setCustomModelNames((prev) => prev.slice(0, Math.max(0, prev.length - 1)));
    selectEntity('protagonist');
    refreshEntityList();
  }, [selectedEntity, selectEntity, refreshEntityList]);

  // 同步跨effect引用
  useEffect(() => { pushUndoRef.current = pushUndo; }, [pushUndo]);
  useEffect(() => { undoLastTransformRef.current = undoLastTransform; }, [undoLastTransform]);
  useEffect(() => { deleteSelectedCustomRef.current = deleteSelectedCustom; }, [deleteSelectedCustom]);
  const selectEntityRef = useRef<((id: string | null) => void) | null>(null);
  const undoLastTransformRef = useRef<(() => void) | null>(null);
  const deleteSelectedCustomRef = useRef<(() => void) | null>(null);
  useEffect(() => { selectEntityRef.current = selectEntity; }, [selectEntity]);

  // ============================================================
  // Agent 场景生成（对标 MiniMax Design 自然语言布景）
  // ============================================================
  const handleAgentSceneGenerate = async () => {
    if (!scenePrompt.trim()) return;
    setSceneGenerating(true);
    const lower = scenePrompt.toLowerCase();
    // 1. 关键词驱动的环境切换
    if (lower.includes('云海') || lower.includes('仙山') || lower.includes('修仙') || lower.includes('云雾')) {
      setEnvironment('xianxia_cloud');
      setSceneDesc('修仙云海 · 浮空仙山 · 灵气缭绕');
    } else if (lower.includes('沙漠') || lower.includes('荒漠') || lower.includes('黄沙') || lower.includes('决战')) {
      setEnvironment('desert_battle');
      setSceneDesc('古荒漠 · 落日黄沙 · 岩石战场');
    } else if (lower.includes('霓虹') || lower.includes('雨夜') || lower.includes('都市') || lower.includes('赛博') || lower.includes('城市')) {
      if (lower.includes('雨夜')) { setEnvironment('neon_city'); setSceneDesc('雨夜霓虹都市 · 湿漉街道 · 倒影'); }
      else { setEnvironment('cyber_studio'); setSceneDesc('赛博影棚 · 霓虹网格 · 科技光效'); }
    }
    // 2. 角色指令
    if (lower.includes('添加') && (lower.includes('敌人') || lower.includes('对手') || lower.includes('宿敌'))) {
      setCastLayout('duel');
    } else if (lower.includes('群') || lower.includes('包围') || lower.includes('多人')) {
      setCastLayout('surrounded');
    } else if (lower.includes('单人') || lower.includes('独自')) {
      setCastLayout('solo');
    } else if (lower.includes('过肩')) {
      setCastLayout('ots');
    }
    // 3. 姿态指令
    const poseMap: Array<[string[], PosePreset]> = [
      [['战斗', '架势', '武道'], 'fight'],
      [['施法', '御剑', '法术'], 'cast_spell'],
      [['奔跑', '突进', '冲锋'], 'run'],
      [['回眸', '凝视', '回头'], 'look_back'],
      [['半跪', '受伤', '受创'], 'kneel'],
      [['格挡', '防御'], 'defend'],
      [['飞行', '御风', '浮空'], 'fly'],
    ];
    for (const [keys, p] of poseMap) {
      if (keys.some((k) => lower.includes(k))) { setPose(p); break; }
    }
    // 4. 道具指令（真实 GLB 已接入）
    if (lower.includes('剑') || lower.includes('飞剑')) {
      setPropsConfig((prev) => (prev.includes('sword') ? prev : [...prev, 'sword']));
    }
    if (lower.includes('盾') || lower.includes('护盾')) {
      setPropsConfig((prev) => (prev.includes('shield') ? prev : [...prev, 'shield']));
    }
    if (lower.includes('阵法') || lower.includes('符文') || lower.includes('法阵')) {
      setPropsConfig((prev) => (prev.includes('magic_circle') ? prev : [...prev, 'magic_circle']));
    }
    if (lower.includes('椅') || lower.includes('座椅') || lower.includes('chair')) {
      setPropsConfig((prev) => (prev.includes('chair' as StagePropType) ? prev : [...prev, 'chair' as StagePropType]));
    }
    if (lower.includes('头盔') || lower.includes('盔甲') || lower.includes('头饰') || lower.includes('helmet')) {
      setPropsConfig((prev) => (prev.includes('helmet' as StagePropType) ? prev : [...prev, 'helmet' as StagePropType]));
    }
    if (lower.includes('相机') || lower.includes('摄影') || lower.includes('camera')) {
      setPropsConfig((prev) => (prev.includes('camera' as StagePropType) ? prev : [...prev, 'camera' as StagePropType]));
    }
    if (lower.includes('牛油果') || lower.includes('水果') || lower.includes('avocado')) {
      setPropsConfig((prev) => (prev.includes('avocado' as StagePropType) ? prev : [...prev, 'avocado' as StagePropType]));
    }
    if (lower.includes('音响') || lower.includes('音箱') || lower.includes('boom')) {
      setPropsConfig((prev) => (prev.includes('boombox' as StagePropType) ? prev : [...prev, 'boombox' as StagePropType]));
    }
    if (lower.includes('移除') && lower.includes('剑')) {
      setPropsConfig((prev) => prev.filter((x) => x !== 'sword'));
    }
    if (lower.includes('移除') && (lower.includes('椅') || lower.includes('chair'))) {
      setPropsConfig((prev) => prev.filter((x) => x !== 'chair'));
    }
    if (lower.includes('移除') && lower.includes('头盔')) {
      setPropsConfig((prev) => prev.filter((x) => x !== 'helmet'));
    }
    // 5. 同时调用后端的 3D 导演机位推理（原有能力）
    try {
      const res = await invokeTool('director_3d_stage_plan', {
        ai_directive: scenePrompt,
        framing, motion, pose, focal_length_mm: focalLength, camera_roll_deg: cameraRoll, cast_layout: castLayout, speed: motionSpeed,
      });
      if (res.status === 'success' && res.result) {
        const r = res.result as any;
        if (r.framing) setFraming(r.framing);
        if (r.motion) setMotion(r.motion);
        if (r.pose) setPose(r.pose);
        if (r.focal_length_mm) setFocalLength(r.focal_length_mm);
        if (r.camera_roll_deg !== undefined) setCameraRoll(r.camera_roll_deg);
        if (r.cast_layout) setCastLayout(r.cast_layout);
      }
    } catch (e) { console.error(e); }
    setSceneGenerating(false);
    setTimeout(() => setScenePrompt(''), 300);
  };

  const handleImportGLB = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb') && !file.name.toLowerCase().endsWith('.gltf')) {
      setImportError('仅支持 .glb / .gltf');
      return;
    }
    setImportingModel(true);
    setImportError(null);
    try {
      const url = URL.createObjectURL(file);
      const group = await loadGLBModel(url, 1);
      if (!group) throw new Error('解析失败，确认模型为合规 glTF');
      if (stageEntitiesGroupRef.current) {
        const clone = group.clone(true) as THREE.Group;
        const newId = `custom_${Date.now()}`;
        clone.name = newId;
        const offset = new THREE.Vector3((Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.6);
        clone.position.copy(offset);
        clone.userData.baseY = offset.y;
        // 悬浮微光标识为导入模型
        const light = new THREE.PointLight(0x00d2ff, 0.7, 2.2);
        light.position.copy(offset).add(new THREE.Vector3(0, 1.1, 0));
        stageEntitiesGroupRef.current.add(clone);
        stageEntitiesGroupRef.current.add(light);
        setCustomModelNames((prev) => [...prev, file.name]);
        refreshEntityList();
        setTimeout(() => selectEntity(newId), 50);
      } else {
        const fakeKey = `custom_${Date.now()}`;
        (MODEL_URLS as any)[fakeKey] = url;
        setPropsConfig((prev) => [...prev, fakeKey as any]);
        setCustomModelNames((prev) => [...prev, file.name]);
      }
    } catch (err: any) {
      setImportError(err?.message || '导入失败');
    } finally {
      setImportingModel(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ============================================================
  // Three 初始化
  // ============================================================
  useEffect(() => {
    if (!containerRef.current) return;
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07070a);
    scene.fog = new THREE.FogExp2(0x07070a, 0.035);
    sceneRef.current = scene;
    const mainCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    mainCameraRef.current = mainCamera;
    updateMainCameraPosition();
    const virtualCam = new THREE.PerspectiveCamera(35, 9 / 16, 0.1, 50);
    virtualCam.position.set(0, 1.3, 2.5);
    virtualCam.lookAt(0, 1.2, 0);
    scene.add(virtualCam);
    virtualCameraRef.current = virtualCam;
    const helper = new THREE.CameraHelper(virtualCam);
    if (helper.material && !Array.isArray(helper.material)) {
      (helper.material as THREE.Material).opacity = 0.35;
      (helper.material as THREE.Material).transparent = true;
    }
    scene.add(helper);
    cameraHelperRef.current = helper;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    // 挂载前先清掉容器里的残留 canvas。
    // 必须这么做：本 effect 体里一旦有语句抛异常，React 就拿不到 return 的清理函数，
    // 上一次挂上去的 canvas 会永久留在 DOM 里。两个 canvas 都是 position:static 的兄弟节点，
    // 于是上下堆叠——活着的那个被顶出视口，看起来就是「3D 片场一片黑」。
    // PiP 渲染器一直用 innerHTML='' 所以从没出过这个问题，照它的做法来。
    for (const stale of Array.from(containerRef.current.querySelectorAll('canvas'))) stale.remove();
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    // 基础光（会被环境光覆盖，保留兜底；灯光面板通过 ref 实时控制）
    const ambient = new THREE.AmbientLight(0x1a1528, 1.8);
    scene.add(ambient);
    ambientRef.current = ambient;
    const keyLight = new THREE.DirectionalLight(0x7c3aed, 3.2);
    keyLight.position.set(4, 5, 3.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    keyLightRef.current = keyLight;
    const rimLight = new THREE.DirectionalLight(0x00d2ff, 3.5);
    rimLight.position.set(-3.5, 3.5, -3);
    scene.add(rimLight);
    rimLightRef.current = rimLight;
    // 环境组
    const envGroup = new THREE.Group();
    envGroup.name = 'env_group';
    scene.add(envGroup);
    envGroupRef.current = envGroup;
    const stageEntitiesGroup = new THREE.Group();
    stageEntitiesGroup.name = 'stage_entities';
    scene.add(stageEntitiesGroup);
    stageEntitiesGroupRef.current = stageEntitiesGroup;
    // —— Gizmo 手柄（对标小云雀坐标轴 / updream G-R 模式）——
    try {
      const tc = new TransformControls(mainCamera, renderer.domElement);
      tc.setMode(gizmoModeRef.current);
      tc.setSize(0.85);
      // @ts-ignore r169+ helper 模式兼容
      const helperObj: any = (tc as any).getHelper ? (tc as any).getHelper() : tc;
      scene.add(helperObj);
      (tc as any).addEventListener('dragging-changed', (e: any) => {
        gizmoDraggingRef.current = !!e.value;
        if (e.value) {
          orbitStateRef.current.isRotating = false;
          orbitStateRef.current.isPanning = false;
          const obj = (tc as any).object;
          if (obj?.name) {
            const p = obj.position, r = obj.rotation;
            pushUndoRef.current?.(obj.name, { p: [p.x, p.y, p.z], r: [r.x, r.y, r.z], s: obj.scale.x });
          }
        } else {
          const obj = (tc as any).object;
          if (obj?.name) {
            const p = obj.position, r = obj.rotation;
            const snap = { p: [p.x, p.y, p.z] as [number, number, number], r: [r.x, r.y, r.z] as [number, number, number], s: obj.scale.x };
            entityTransformsRef.current[obj.name] = snap;
            setSelectedTransformRef.current?.(snap);
            if (selectionBoxRef.current) selectionBoxRef.current.update();
          }
        }
      });
      (tc as any).addEventListener('objectChange', () => {
        const obj = (tc as any).object;
        if (!obj) return;
        // 地面约束：角色/道具不沉入地下（updream式防穿地）
        if (obj.position.y < 0) obj.position.y = 0;
        if (selectionBoxRef.current) selectionBoxRef.current.update();
        const p = obj.position, r = obj.rotation;
        setSelectedTransformRef.current?.({ p: [p.x, p.y, p.z], r: [r.x, r.y, r.z], s: obj.scale.x });
      });
      transformControlsRef.current = tc;
      applySnapRef.current?.();
    } catch (e) { console.warn('[Director3D] TransformControls init failed', e); }
    let reqId: number;
    const animate = () => {
      reqId = requestAnimationFrame(animate);
      // 呼吸浮动改为基于baseY的叠加，避免覆盖用户Gizmo摆放（此前直接赋值会丢Y）
      const t = Date.now();
      if (protagonistGroupRef.current && !gizmoDraggingRef.current) {
        const o = protagonistGroupRef.current;
        const base = (o.userData.baseY ?? o.position.y) as number;
        o.position.y = base + Math.sin(t * 0.0018) * 0.01;
      }
      if (antagonistGroupRef.current && !gizmoDraggingRef.current) {
        const o = antagonistGroupRef.current;
        const base = (o.userData.baseY ?? o.position.y) as number;
        o.position.y = base + Math.sin(t * 0.0018 + 1.2) * 0.01;
      }
      const magicCircle = scene.getObjectByName('prop_magic_circle');
      if (magicCircle && !(transformControlsRef.current as any)?.dragging) (magicCircle as THREE.Group).rotation.y += 0.006;
      const sword = scene.getObjectByName('prop_sword');
      if (sword && !(transformControlsRef.current as any)?.dragging) {
        const baseY = ((sword as THREE.Group).userData.baseY ?? sword.position.y) as number;
        if (!gizmoDraggingRef.current) sword.position.y = baseY + Math.sin(t * 0.0025) * 0.03;
        sword.rotation.y += 0.004;
      }
      // 云朵漂浮
      const clouds = scene.getObjectByName('clouds_group');
      if (clouds) clouds.rotation.y += 0.0004;
      if (cameraHelperRef.current && virtualCameraRef.current) cameraHelperRef.current.update();
      renderer.render(scene, mainCamera);
      if (pipRendererRef.current && virtualCameraRef.current) {
        if (cameraHelperRef.current) cameraHelperRef.current.visible = false;
        pipRendererRef.current.render(scene, virtualCameraRef.current);
        if (cameraHelperRef.current && showHelpers) cameraHelperRef.current.visible = true;
      }
    };
    animate();
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !mainCameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      mainCameraRef.current.aspect = w / h;
      mainCameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(reqId);
      window.removeEventListener('resize', handleResize);
      try { (transformControlsRef.current as any)?.dispose?.(); } catch {}
      transformControlsRef.current = null;
      // removeChild 在「容器已换、canvas 不是它的子节点」时会抛 NotFoundError，
      // 抛出去就会连带掐掉后面的 dispose；remove() 不依赖父节点，再包一层兜底。
      try { renderer.domElement?.remove(); } catch {}
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, [updateMainCameraPosition]);

  useEffect(() => {
    if (!pipContainerRef.current) return;
    const w = pipContainerRef.current.clientWidth;
    const h = pipContainerRef.current.clientHeight;
    const pipRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    pipRenderer.setSize(w, h);
    pipRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    pipContainerRef.current.innerHTML = '';
    pipContainerRef.current.appendChild(pipRenderer.domElement);
    pipRendererRef.current = pipRenderer;
    // 画幅变化/容器尺寸变化时同步渲染缓冲，保证监视器画面比例 = 项目画幅
    const ro = new ResizeObserver(() => {
      const el = pipContainerRef.current;
      if (!el) return;
      const nw = el.clientWidth, nh = el.clientHeight;
      if (nw > 0 && nh > 0) pipRenderer.setSize(nw, nh);
    });
    ro.observe(pipContainerRef.current);
    return () => {
      ro.disconnect();
      if (pipContainerRef.current && pipRenderer.domElement) pipContainerRef.current.innerHTML = '';
      pipRenderer.dispose();
    };
  }, [showPip, projectAspectNum]);

  // 监视器画幅 = 项目画幅：按容器尺寸做等比内接（letterbox），避免拉伸
  useEffect(() => {
    const el = pipBoxRef.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth, ch = el.clientHeight;
      if (!cw || !ch) return;
      let w = cw, h = Math.round(cw / projectAspectNum);
      if (h > ch) { h = ch; w = Math.round(ch * projectAspectNum); }
      setPipFrame((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [projectAspectNum, showPip]);

  // ============================================================
  // 环境构建（真实场景，非网格）
  // ============================================================
  useEffect(() => {
    if (!sceneRef.current || !envGroupRef.current) return;
    const envGroup = envGroupRef.current;
    while (envGroup.children.length) envGroup.remove(envGroup.children[0]);
    const scene = sceneRef.current;
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
  }, [environment]);

  // ============================================================
  // 角色与道具重建（真实建模 - GLB 优先，程序化兜底）
  // - 人体：RobotExpressive.glb / Soldier.glb（CC0，三阶归一化+底部对齐）
  // - 道具：SheenChair / DamagedHelmet / AntiqueCamera / Avocado / BoomBox 等真实 GLB
  // - 失败则回退至程序化 PBR 假人/道具，保证离线可用
  // ============================================================
  useEffect(() => {
    if (!sceneRef.current || !stageEntitiesGroupRef.current) return;
    let cancelled = false;
    const stage = stageEntitiesGroupRef.current;
    // 清理旧实体但保留环境 + 保留用户导入的custom模型（小云雀式：换姿势不丢自有资产）
    const keptCustom: THREE.Object3D[] = [];
    [...stage.children].forEach((c) => { if (c.name.startsWith('custom_')) keptCustom.push(c); });
    while (stage.children.length) stage.remove(stage.children[0]);
    keptCustom.forEach((c) => stage.add(c));
    protagonistGroupRef.current = null;
    antagonistGroupRef.current = null;
    // 保存的摆位应用（切镜/换姿势不丢摆放；用户拖过的优先于默认值）
    const applySaved = (obj: THREE.Object3D) => {
      const t = entityTransformsRef.current[obj.name];
      if (t) {
        obj.position.set(t.p[0], t.p[1], t.p[2]);
        obj.rotation.set(t.r[0], t.r[1], t.r[2]);
        obj.scale.setScalar(t.s || 1);
        return true;
      }
      return false;
    };
    const markBaseY = (obj: THREE.Object3D) => { obj.userData.baseY = obj.position.y; };

    const applyPoseToGLB = (group: THREE.Group, pose: PosePreset) => {
      // GLB 为绑定模型时，简单通过整体旋转/位移模拟姿态，避免复杂骨骼重定向
      if (pose === 'fight') { group.rotation.y = 0; group.position.y += 0.02; }
      else if (pose === 'kneel') { group.scale.set(1, 0.92, 1); group.position.y -= 0.18; }
      else if (pose === 'fly') { group.position.y += 0.25; group.rotation.x = -0.12; }
      else if (pose === 'run') { group.rotation.y = 0.35; }
    };

    (async () => {
      // Protagonist - 优先 GLB
      let protagonist: THREE.Group | null = await loadGLBModel(MODEL_URLS.human_protagonist, 1.05);
      if (!protagonist || cancelled) {
        protagonist = createRealisticHuman({ pose, role: 'protagonist', name: 'Protagonist', primaryColor: 0x7c3aed, accentColor: 0x00d2ff, hairColor: 0x1a1a2e });
      } else {
        applyPoseToGLB(protagonist, pose);
        // 叠加角色光环以区分
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.40, 32), new THREE.MeshBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide }));
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.01; protagonist.add(ring);
      }
      if (cancelled) return;
      protagonist.name = 'entity_protagonist';
      if (!applySaved(protagonist)) protagonist.position.set(0, 0, 0);
      stage.add(protagonist);
      markBaseY(protagonist);
      protagonistGroupRef.current = protagonist;

      // Antagonist
      if (castLayout === 'duel' || castLayout === 'ots' || castLayout === 'surrounded') {
        let antagonist: THREE.Group | null = await loadGLBModel(MODEL_URLS.human_antagonist, 1.02);
        if (!antagonist || cancelled) {
          antagonist = createRealisticHuman({ pose: pose === 'fight' ? 'fight' : 'stand', role: 'antagonist', name: 'Antagonist', primaryColor: 0x8b1a1a, accentColor: 0xff3b30, hairColor: 0x2b0a0a });
        } else {
          applyPoseToGLB(antagonist, pose === 'fight' ? 'fight' : 'stand');
        }
        if (cancelled) return;
        antagonist.name = 'entity_antagonist';
        if (!applySaved(antagonist)) {
          if (castLayout === 'duel') { antagonist.position.set(0, 0, -2.3); antagonist.rotation.y = Math.PI; }
          else if (castLayout === 'ots') { antagonist.position.set(-0.35, 0, -2.5); antagonist.rotation.y = Math.PI * 0.9; }
          else { antagonist.position.set(1.9, 0, -1.2); antagonist.rotation.y = -Math.PI * 0.6; }
        }
        stage.add(antagonist);
        markBaseY(antagonist);
        antagonistGroupRef.current = antagonist;
      } else antagonistGroupRef.current = null;

      if (cancelled) return;
      if (castLayout === 'surrounded') {
        let sup: THREE.Group | null = await loadGLBModel(MODEL_URLS.human_supporting, 0.98);
        if (!sup || cancelled) sup = createRealisticHuman({ pose: 'fight', role: 'supporting', name: 'Supporting', primaryColor: 0x1e3a8a, accentColor: 0x60a5fa, hairColor: 0x0f172a });
        if (cancelled) return;
        sup.name = 'entity_supporting';
        if (!applySaved(sup)) { sup.position.set(-1.9, 0, -1.2); sup.rotation.y = Math.PI * 0.6; }
        stage.add(sup);
        markBaseY(sup);
      }

      if (cancelled) return;
      // 道具 - GLB 优先，失败回退程序化（全部具名以支持选中/拖拽/持久化）
      const addPropGLBOrFallback = async (type: StagePropType, fallback: () => THREE.Group, pos: THREE.Vector3, glbKey?: string, scale = 1) => {
        if (glbKey && MODEL_URLS[glbKey]) {
          const glb = await loadGLBModel(MODEL_URLS[glbKey], scale);
          if (glb && !cancelled) {
            glb.name = `prop_${type}`;
            if (!applySaved(glb)) glb.position.copy(pos);
            // 悬浮道具加轻微发光
            const light = new THREE.PointLight(0x7c3aed, 0.6, 2);
            light.position.copy(glb.position).add(new THREE.Vector3(0, 0.2, 0));
            stage.add(light);
            stage.add(glb);
            markBaseY(glb);
            return;
          }
        }
        if (cancelled) return;
        const fb = fallback();
        fb.name = `prop_${type}`;
        if (!applySaved(fb)) fb.position.copy(pos);
        stage.add(fb);
        markBaseY(fb);
      };

      if (propsConfig.includes('sword')) {
        const sword = createRealisticSword();
        sword.name = 'prop_sword'; if (!applySaved(sword)) sword.position.set(0.65, 1.75, 0.45); stage.add(sword); markBaseY(sword);
      }
      if (propsConfig.includes('shield')) {
        const shield = createRealisticShield();
        shield.name = 'prop_shield'; if (!applySaved(shield)) shield.position.set(0, 1.2, 0.55); stage.add(shield); markBaseY(shield);
      }
      if (propsConfig.includes('magic_circle')) {
        const circle = createRealisticMagicCircle();
        circle.name = 'prop_magic_circle'; if (!applySaved(circle)) circle.position.set(0, 0.02, 0); stage.add(circle); markBaseY(circle);
      }
      // 真实 GLB 道具（新增类型）
      if (propsConfig.includes('chair' as StagePropType)) {
        await addPropGLBOrFallback('chair' as StagePropType, () => { const g = createRealisticHuman({ pose: 'stand', role: 'supporting', name: 'ChairFallback', primaryColor: 0x8b4513, accentColor: 0xffaa00, hairColor: 0x000000 }); g.scale.setScalar(0.5); return g; }, new THREE.Vector3(1.2, 0, 0.6), 'chair', 1.2);
      }
      if (propsConfig.includes('helmet' as StagePropType)) {
        await addPropGLBOrFallback('helmet' as StagePropType, () => createRealisticShield(), new THREE.Vector3(-0.9, 0.9, 0.5), 'helmet', 0.9);
      }
      if (propsConfig.includes('camera' as StagePropType)) {
        await addPropGLBOrFallback('camera' as StagePropType, () => createRealisticShield(), new THREE.Vector3(0, 1.0, 1.2), 'camera_prop', 0.8);
      }
      if (propsConfig.includes('avocado' as StagePropType)) {
        await addPropGLBOrFallback('avocado' as StagePropType, () => createRealisticMagicCircle(), new THREE.Vector3(0.9, 0.4, -0.8), 'avocado', 1.0);
      }
      if (propsConfig.includes('boombox' as StagePropType)) {
        await addPropGLBOrFallback('boombox' as StagePropType, () => createRealisticShield(), new THREE.Vector3(-1.0, 0.5, 0.9), 'boombox', 1.1);
      }
      // 插件导演包道具（director_packs.props：GLB URL 直接加载，可选中/拖拽/持久化）
      const packPropMap = new Map(listDirectorPackProps().map((p) => [p.id, p]));
      let packPropIdx = 0;
      for (const ptype of propsConfig) {
        const pp = packPropMap.get(String(ptype));
        if (!pp) continue;
        const glb = await loadGLBModel(pp.glb_url, pp.scale || 1);
        if (glb && !cancelled) {
          glb.name = `prop_${pp.id}`;
          if (!applySaved(glb)) glb.position.set(1.4 + packPropIdx * 0.6, 0.35, -0.8);
          const light = new THREE.PointLight(0x22d3ee, 0.5, 2.2);
          light.position.copy(glb.position).add(new THREE.Vector3(0, 0.2, 0));
          stage.add(light);
          stage.add(glb);
          markBaseY(glb);
        }
        packPropIdx++;
      }
      if (cancelled) return;
      // 场景专属道具（根据环境自动补充真实物品，具名可选中）
      if (environment === 'xianxia_cloud' && !propsConfig.includes('magic_circle')) {
        const incense = createIncenseBurner(); incense.name = 'prop_incense';
        if (!applySaved(incense)) incense.position.set(-1.2, 0.3, 0.8); stage.add(incense); markBaseY(incense);
      }
      if (environment === 'desert_battle') {
        const flag = createBattleFlag(); flag.name = 'prop_flag';
        if (!applySaved(flag)) flag.position.set(1.5, 0, -1.0); stage.add(flag); markBaseY(flag);
      }
      // 根据环境自动补充真实 GLB 道具（示例：赛博影棚自动放置 BoomBox，霓虹都市放置椅子）
      if (environment === 'cyber_studio' && !propsConfig.includes('boombox' as StagePropType)) {
        const autoBox = await loadGLBModel(MODEL_URLS.boombox, 0.9);
        if (autoBox && !cancelled) { autoBox.name = 'prop_auto_boombox'; if (!applySaved(autoBox)) autoBox.position.set(1.4, 0.35, -0.6); stage.add(autoBox); markBaseY(autoBox); }
      }
      if (environment === 'neon_city' && !propsConfig.includes('chair' as StagePropType)) {
        const autoChair = await loadGLBModel(MODEL_URLS.chair, 1.0);
        if (autoChair && !cancelled) { autoChair.name = 'prop_auto_chair'; if (!applySaved(autoChair)) { autoChair.position.set(-1.3, 0, 0.7); autoChair.rotation.y = Math.PI * 0.2; } stage.add(autoChair); markBaseY(autoChair); }
      }
      if (cancelled) return;
      refreshEntityList();
      // 重建后恢复选中挂载（切姿势/环境不丢选中）
      try {
        const cur = (window as any).__director_selected__ || null;
        const selName = typeof cur === 'string' ? cur : null;
        const g2 = stageEntitiesGroupRef.current;
        if (g2 && selName && g2.getObjectByName(selName) && transformControlsRef.current) {
          (transformControlsRef.current as any).attach(g2.getObjectByName(selName));
        }
      } catch {}
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pose, castLayout, propsConfig, environment, packRev]);

  const updateVirtualCameraOptics = useCallback(() => {
    if (!virtualCameraRef.current) return;
    const vCam = virtualCameraRef.current;
    const sensorHeight = 24;
    const presetKey = `${framing}|${focalLength}|${cameraRoll}|${projectAspectNum}`;
    // 机位覆盖优先：用户切到某个已保存机位时，光圈/景别预设不再抢占视角；
    // 一旦用户改了景别/焦距/roll（presetKey 变化），自动解除覆盖回到预设机位。
    if (presetKeyRef.current !== presetKey) {
      presetKeyRef.current = presetKey;
      camOverrideRef.current = null;
      setActiveCamId(null);
    }
    if (camOverrideRef.current) {
      const c = camOverrideRef.current;
      vCam.position.set(c.pos[0], c.pos[1], c.pos[2]);
      vCam.quaternion.set(c.quat[0], c.quat[1], c.quat[2], c.quat[3]);
      vCam.fov = c.fov || vCam.fov;
      vCam.aspect = projectAspectNum;
      vCam.updateProjectionMatrix();
      if (cameraHelperRef.current) cameraHelperRef.current.update();
      return;
    }
    const fovCalculated = 2 * Math.atan(sensorHeight / (2 * focalLength)) * (180 / Math.PI);
    vCam.fov = Math.max(12, Math.min(105, fovCalculated));
    // 摄像机画幅 = 项目画幅（与生成结果一致），不再用独立遮幅
    vCam.aspect = projectAspectNum;
    let target = new THREE.Vector3(0, 1.25, 0);
    let camPos = new THREE.Vector3(0, 1.3, 2.5);
    switch (framing) {
      case 'extreme_close_up': camPos.set(0, 1.68, 0.75); target.set(0, 1.68, 0); break;
      case 'close_up': camPos.set(0, 1.55, 1.35); target.set(0, 1.5, 0); break;
      case 'medium': camPos.set(0, 1.3, 2.4); target.set(0, 1.25, 0); break;
      case 'full': camPos.set(0, 1.15, 3.8); target.set(0, 1.0, 0); break;
      case 'long': camPos.set(0, 1.6, 6.0); target.set(0, 1.1, 0); break;
      case 'bird_eye': camPos.set(0, 4.5, 2.0); target.set(0, 0.5, 0); break;
      case 'low_angle': camPos.set(0, 0.25, 1.8); target.set(0, 1.5, 0); break;
      case 'over_shoulder': camPos.set(0.55, 1.55, 1.8); target.set(-0.2, 1.4, -1.2); break;
      case 'dutch_angle': camPos.set(0, 1.2, 2.2); target.set(0, 1.25, 0); break;
      case 'high_angle': camPos.set(0, 2.8, 2.8); target.set(0, 1.0, 0); break;
    }
    vCam.position.copy(camPos);
    vCam.lookAt(target);
    if (cameraRoll !== 0) vCam.rotation.z = (cameraRoll * Math.PI) / 180;
    vCam.updateProjectionMatrix();
    if (cameraHelperRef.current) cameraHelperRef.current.update();
  }, [framing, focalLength, cameraRoll, projectAspectNum]);

  useEffect(() => { updateVirtualCameraOptics(); }, [updateVirtualCameraOptics]);

  const calculateMotionWaypoints = useCallback((motionType: CameraMotion, startPos: THREE.Vector3, target: THREE.Vector3): THREE.Vector3[] => {
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
  }, []);

  useEffect(() => {
    if (!sceneRef.current || !virtualCameraRef.current || !showTrajectory) {
      if (trajectoryLineRef.current && sceneRef.current) { sceneRef.current.remove(trajectoryLineRef.current); trajectoryLineRef.current = null; }
      return;
    }
    const scene = sceneRef.current;
    const vCam = virtualCameraRef.current;
    const startPos = vCam.position.clone();
    const target = new THREE.Vector3(0, 1.25, 0);
    if (trajectoryLineRef.current) scene.remove(trajectoryLineRef.current);
    const waypoints = calculateMotionWaypoints(motion, startPos, target);
    const curve = new THREE.CatmullRomCurve3(waypoints);
    const points = curve.getPoints(50);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({ color: 0x00d2ff, dashSize: 0.12, gapSize: 0.06, linewidth: 2 });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    scene.add(line);
    trajectoryLineRef.current = line;
    return () => { if (trajectoryLineRef.current && sceneRef.current) sceneRef.current.remove(trajectoryLineRef.current); };
  }, [motion, framing, showTrajectory, calculateMotionWaypoints]);

  const handleToggleSimulation = () => {
    if (!virtualCameraRef.current) return;
    if (isSimulating) {
      setIsSimulating(false);
      // 手动停止时同样落回起点并停止录制，避免角色/机位停在半程
      const prot = protagonistGroupRef.current;
      if (prot && walkBaseRef.current) { prot.position.x = walkBaseRef.current.x; prot.position.z = walkBaseRef.current.z; prot.rotation.y = walkBaseRef.current.rotY; }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') { try { recorderRef.current.stop(); } catch {} }
      return;
    }
    setIsSimulating(true);
    const cam = virtualCameraRef.current;
    const startPos = cam.position.clone();
    const startFov = cam.fov;
    const startTime = performance.now();
    // 记录主角走位起点（模拟结束/中断时复位，保证预演可重复）
    const prot = protagonistGroupRef.current;
    if (prot) walkBaseRef.current = { x: prot.position.x, z: prot.position.z, rotY: prot.rotation.y };
    else walkBaseRef.current = null;
    const walkPath = waypointsRef.current.length > 0 && walkBaseRef.current
      ? [{ x: walkBaseRef.current.x, z: walkBaseRef.current.z }, ...waypointsRef.current]
      : [];
    // 走位路径总长度（按折线等速行走）
    let walkSegLens: number[] = [];
    let walkTotal = 0;
    for (let i = 1; i < walkPath.length; i++) {
      const dx = walkPath[i].x - walkPath[i - 1].x;
      const dz = walkPath[i].z - walkPath[i - 1].z;
      const len = Math.hypot(dx, dz);
      walkSegLens.push(len);
      walkTotal += len;
    }
    const duration = motionSpeed === '0.5x' ? 4500 : motionSpeed === '1.5x' ? 1800 : motionSpeed === '2.0x' ? 1200 : 2500;
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      setScrubberProgress(progress);
      let ease = progress;
      if (motionEasing === 'ease_in_out') ease = 0.5 * (1 - Math.cos(Math.PI * progress));
      else if (motionEasing === 'explosive') ease = Math.pow(progress, 0.4);
      else if (motionEasing === 'slow_out') ease = Math.sin((progress * Math.PI) / 2);
      if (motion === 'push_in') cam.position.z = startPos.z - ease * 0.95;
      else if (motion === 'pull_out') cam.position.z = startPos.z + ease * 1.3;
      else if (motion === 'orbit') { const angle = ease * Math.PI * 0.85; cam.position.x = Math.sin(angle) * startPos.z; cam.position.z = Math.cos(angle) * startPos.z; }
      else if (motion === 'orbit_boom_up') { const angle = ease * Math.PI * 0.85; cam.position.x = Math.sin(angle) * startPos.z; cam.position.z = Math.cos(angle) * startPos.z; cam.position.y = startPos.y + ease * 1.5; }
      else if (motion === 'dolly_zoom') { cam.position.z = startPos.z - ease * 1.0; cam.fov = startFov + ease * 22; cam.updateProjectionMatrix(); }
      else if (motion === 'fast_push_shake') { cam.position.z = startPos.z - ease * 1.2; if (progress > 0.6) { cam.position.x = (Math.random() - 0.5) * 0.15; cam.position.y = startPos.y + (Math.random() - 0.5) * 0.15; } }
      else if (motion === 'truck_left') cam.position.x = startPos.x - ease * 1.5;
      else if (motion === 'truck_right') cam.position.x = startPos.x + ease * 1.5;
      else if (motion === 'boom_up') cam.position.y = startPos.y + ease * 1.6;
      else if (motion === 'shake') { cam.position.x = startPos.x + (Math.random() - 0.5) * 0.12; cam.position.y = startPos.y + (Math.random() - 0.5) * 0.12; }
      cam.lookAt(0, 1.25, 0);
      if (cameraRoll !== 0) cam.rotation.z = (cameraRoll * Math.PI) / 180;
      cam.updateProjectionMatrix();
      // 主角沿走位路径等速行走，朝向行进方向（与运镜同一 easing 共进退）
      if (walkPath.length > 1 && walkTotal > 0.001 && protagonistGroupRef.current) {
        const target = ease * walkTotal;
        let acc = 0;
        let px = walkPath[walkPath.length - 1].x;
        let pz = walkPath[walkPath.length - 1].z;
        let dirX = 0;
        let dirZ = -1;
        for (let i = 1; i < walkPath.length; i++) {
          if (target <= acc + walkSegLens[i - 1] || i === walkPath.length - 1) {
            const segLen = walkSegLens[i - 1] || 1;
            const t = Math.max(0, Math.min(1, (target - acc) / segLen));
            px = walkPath[i - 1].x + (walkPath[i].x - walkPath[i - 1].x) * t;
            pz = walkPath[i - 1].z + (walkPath[i].z - walkPath[i - 1].z) * t;
            dirX = walkPath[i].x - walkPath[i - 1].x;
            dirZ = walkPath[i].z - walkPath[i - 1].z;
            break;
          }
          acc += walkSegLens[i - 1];
        }
        const p = protagonistGroupRef.current;
        p.position.x = px;
        p.position.z = pz;
        if (Math.hypot(dirX, dirZ) > 0.001) p.rotation.y = Math.atan2(dirX, dirZ);
      }
      if (progress < 1) requestAnimationFrame(step);
      else { cam.position.copy(startPos); cam.fov = startFov; cam.lookAt(0, 1.25, 0); if (cameraRoll !== 0) cam.rotation.z = (cameraRoll * Math.PI) / 180; cam.updateProjectionMatrix(); if (protagonistGroupRef.current && walkBaseRef.current) { protagonistGroupRef.current.position.x = walkBaseRef.current.x; protagonistGroupRef.current.position.z = walkBaseRef.current.z; protagonistGroupRef.current.rotation.y = walkBaseRef.current.rotY; } if (recorderRef.current && recorderRef.current.state !== 'inactive') { try { recorderRef.current.stop(); } catch {} } setIsSimulating(false); setScrubberProgress(0); }
    };
    requestAnimationFrame(step);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pickRoot = (clientX: number, clientY: number): string | null => {
      if (!sceneRef.current || !mainCameraRef.current || !stageEntitiesGroupRef.current) return null;
      const rect = container.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(x, y), mainCameraRef.current);
      const intersects = raycaster.intersectObjects(stageEntitiesGroupRef.current.children, true);
      for (const hit of intersects) {
        let cur: THREE.Object3D | null = hit.object;
        while (cur && cur.parent && cur.parent !== stageEntitiesGroupRef.current) cur = cur.parent;
        if (cur && (cur as THREE.Object3D).name) return (cur as THREE.Object3D).name;
      }
      return null;
    };
    const onMouseDown = (e: MouseEvent) => {
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      // Gizmo正被拖拽时，视角不抢事件（小云雀/updream：手柄优先）
      const tc: any = transformControlsRef.current;
      if (tc && (tc.dragging || tc.axis)) return;
      if (e.button === 0 && sceneRef.current && mainCameraRef.current) {
        const rect = container.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(x, y), mainCameraRef.current);
        // 走位模式：点击地面打路径点（最多 6 个），不触发旋转/选中
        if (walkModeRef.current) {
          const hit = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) {
            const cx = Math.max(-6, Math.min(6, hit.x));
            const cz = Math.max(-6, Math.min(6, hit.z));
            const cur = waypointsRef.current;
            if (cur.length < 6) {
              const next = [...cur, { x: cx, z: cz }];
              waypointsRef.current = next;
              setWaypoints(next);
            }
          }
          orbitStateRef.current.prevX = e.clientX; orbitStateRef.current.prevY = e.clientY;
          return;
        }
        // 锁定物体不可选中（updream图层锁定防误拖）
        const hitId = pickRoot(e.clientX, e.clientY);
        if (hitId) {
          if (lockedIdsRef.current[hitId]) {
            orbitStateRef.current.prevX = e.clientX; orbitStateRef.current.prevY = e.clientY;
            orbitStateRef.current.isRotating = true;
            return;
          }
          // 有命中：先选中，不立即旋转；拖动超阈值才转视角（点击=选中，拖=转视角）
          selectEntityRef.current?.(hitId);
          (window as any).__director_selected__ = hitId;
          (orbitStateRef as any).current.pendingHit = true;
        } else {
          (orbitStateRef as any).current.pendingHit = false;
        }
        orbitStateRef.current.prevX = e.clientX; orbitStateRef.current.prevY = e.clientY;
        // 延迟判定：小移动=点击选中，大移动=旋转（避免选中即转视角）
        (orbitStateRef as any).current.downPos = { x: e.clientX, y: e.clientY };
        orbitStateRef.current.isRotating = false;
        (orbitStateRef as any).current.maybeRotating = true;
      } else if (e.button === 1 || e.button === 2) orbitStateRef.current.isPanning = true;
      orbitStateRef.current.prevX = e.clientX; orbitStateRef.current.prevY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - orbitStateRef.current.prevX;
      const deltaY = e.clientY - orbitStateRef.current.prevY;
      orbitStateRef.current.prevX = e.clientX; orbitStateRef.current.prevY = e.clientY;
      const st: any = orbitStateRef.current;
      if (st.maybeRotating && st.downPos) {
        const moved = Math.hypot(e.clientX - st.downPos.x, e.clientY - st.downPos.y);
        // Gizmo拖拽中绝不转视角
        if (gizmoDraggingRef.current) return;
        if (moved > 5) { st.isRotating = true; st.maybeRotating = false; }
        else return;
      }
      if (orbitStateRef.current.isRotating) { orbitStateRef.current.theta -= deltaX * 0.006; orbitStateRef.current.phi -= deltaY * 0.006; updateMainCameraPosition(); }
      else if (orbitStateRef.current.isPanning) { const factor = orbitStateRef.current.radius * 0.0015; orbitStateRef.current.target.x -= deltaX * factor; orbitStateRef.current.target.y += deltaY * factor; updateMainCameraPosition(); }
    };
    const onMouseUp = (e: MouseEvent) => {
      const st: any = orbitStateRef.current;
      // 点击空白处清空选中（小云雀式），拖拽则保留
      if (st.maybeRotating && mouseDownPosRef.current) {
        const moved = Math.hypot(e.clientX - mouseDownPosRef.current.x, e.clientY - mouseDownPosRef.current.y);
        if (moved <= 5 && !st.pendingHit) { selectEntityRef.current?.(null); (window as any).__director_selected__ = null; }
      }
      orbitStateRef.current.isRotating = false; orbitStateRef.current.isPanning = false;
      st.maybeRotating = false; st.pendingHit = false; st.downPos = null;
      mouseDownPosRef.current = null;
    };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); orbitStateRef.current.radius = Math.max(1.2, Math.min(16.0, orbitStateRef.current.radius + e.deltaY * 0.003)); updateMainCameraPosition(); };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    // 快捷键（对标updream：W选择/G移动/R旋转 + 小云雀Ctrl+Z撤销）
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLastTransformRef.current?.(); return; }
      if (e.key.toLowerCase() === 'w') setGizmoMode('translate');
      else if (e.key.toLowerCase() === 'e') setGizmoMode('rotate');
      else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) setGizmoMode('scale');
      else if (e.key.toLowerCase() === 'g') setGizmoMode('translate');
      else if (e.key === 'Escape') { selectEntityRef.current?.(null); (window as any).__director_selected__ = null; }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = (window as any).__director_selected__ as string | null;
        if (id && id.startsWith('custom_')) deleteSelectedCustomRef.current?.();
      }
    };
    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateMainCameraPosition]);

  const handleExecuteAiDirective = async () => {
    if (!aiPrompt.trim()) return;
    try {
      const r: any = await directorExecute({ ai_directive: aiPrompt, framing, motion, pose, focal_length_mm: focalLength, camera_roll_deg: cameraRoll, cast_layout: castLayout, speed: motionSpeed });
      if (r.framing) setFraming(r.framing);
      if (r.motion) setMotion(r.motion);
      if (r.pose) setPose(r.pose);
      if (r.focal_length_mm) setFocalLength(r.focal_length_mm);
      if (r.camera_roll_deg !== undefined) setCameraRoll(r.camera_roll_deg);
      if (r.cast_layout) setCastLayout(r.cast_layout);
      try {
        const nodes = useCanvasStore.getState().nodes;
        const dirNode = nodes.find((n: any) => n.type === 'director3d');
        if (dirNode) {
          useCanvasStore.getState().updateNodeData(dirNode.id, {
            ai_directive: aiPrompt,
            minimax_camera_prompt: r.minimax_camera_prompt || r.camera_prompt,
            framing: r.framing || framing,
            motion: r.motion || motion,
          });
        }
      } catch {}
      setTimeout(() => handleToggleSimulation(), 300);
    } catch (e) { console.error(e); }
  };

  const handleApplyToShot = async () => {
    if (!activeShot) return;
    await invokeTool('director_3d_stage_plan', { framing, motion, pose, focal_length_mm: focalLength, camera_roll_deg: cameraRoll, cast_layout: castLayout, speed: motionSpeed });
    const updatedVideoPrompt = activeShot.video_prompt ? `${activeShot.video_prompt.replace(/\[Camera:[^\]]+\]/g, '').trim()} ${minimaxPromptPreview}`.trim() : minimaxPromptPreview;
    // 同步Gizmo摆位：从场景实时抓取，避免ref滞后导致丢摆放
    try {
      const g = stageEntitiesGroupRef.current;
      if (g) {
        g.children.forEach((o) => {
          if (o.name && !o.name.startsWith('walk_')) {
            entityTransformsRef.current[o.name] = { p: [o.position.x, o.position.y, o.position.z], r: [o.rotation.x, o.rotation.y, o.rotation.z], s: o.scale.x };
          }
        });
      }
    } catch {}
    updateShot(activeShot.id, { camera_framing: framing, camera_motion: motion, pose_preset: pose, focal_length_mm: focalLength, camera_roll_deg: cameraRoll, cast_layout: castLayout, props_config: propsConfig, video_prompt: updatedVideoPrompt, motion_speed: motionSpeed, walk_path: waypointsRef.current, lighting_config: { keyIntensity, keyAzimuth, keyTemp, rimIntensity, ambientIntensity, exposure }, stage_layout: { ...entityTransformsRef.current } } as any);
    setAppliedSuccess(true); setTimeout(() => setAppliedSuccess(false), 2500);
  };

  // ============================================================
  // 多机位 + 截图队列（对标 LibTV：多机位多视角截图 → 资产库 → 分镜参考）
  // ============================================================
  const makeCameraFrom = (cam: THREE.PerspectiveCamera, name: string): StageCamera => ({
    id: `cam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    name,
    pos: [cam.position.x, cam.position.y, cam.position.z],
    quat: [cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w],
    fov: cam.fov,
  });

  const applyPose = useCallback((cam: StageCamera) => {
    const v = virtualCameraRef.current;
    if (!v) return;
    camOverrideRef.current = cam;
    setActiveCamId(cam.id);
    v.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    v.quaternion.set(cam.quat[0], cam.quat[1], cam.quat[2], cam.quat[3]);
    v.fov = cam.fov || v.fov;
    v.updateProjectionMatrix();
    if (cameraHelperRef.current) cameraHelperRef.current.update();
  }, []);

  const persistCameras = (list: StageCamera[]) => {
    setStageCameras(list);
    if (activeShot) { try { updateShot(activeShot.id, { stage_cameras: list } as any); } catch {} }
  };

  /** 从当前导演视角（主视图）新建机位 → 监视器可切到该机位 */
  const addCameraFromDirectorView = () => {
    const m = mainCameraRef.current;
    if (!m) { setSnapshotMsg('舞台未就绪'); return; }
    const cam = makeCameraFrom(m, `机位${stageCameras.length + 1}`);
    persistCameras([...stageCameras, cam]);
    applyPose(cam);
    setSnapshotMsg(`已新建 ${cam.name}（当前导演视角），可继续调角度后「全部机位截图」`);
  };

  /** 抓取监视器画面（cover 裁切到项目画幅）；抓帧前强制渲染一帧保证是当前机位 */
  const captureFrameDataUrl = (): string | null => {
    const src = (showPip && pipRendererRef.current?.domElement) || rendererRef.current?.domElement;
    if (!src) return null;
    try {
      if (rendererRef.current && sceneRef.current && mainCameraRef.current) {
        rendererRef.current.render(sceneRef.current, mainCameraRef.current);
      }
      if (showPip && pipRendererRef.current && sceneRef.current && virtualCameraRef.current) {
        const helper = cameraHelperRef.current;
        if (helper) helper.visible = false;
        pipRendererRef.current.render(sceneRef.current, virtualCameraRef.current);
        if (helper) helper.visible = showHelpers;
      }
      const targetRatio = ratioToNumber(project?.aspect_ratio || '9:16');
      const outW = Math.min(1024, src.width || 1024);
      const outH = Math.max(1, Math.round(outW / targetRatio));
      const c = document.createElement('canvas');
      c.width = outW; c.height = outH;
      const ctx = c.getContext('2d')!;
      const sRatio = (src.width || 1) / (src.height || 1);
      let sx = 0, sy = 0, sW = src.width || outW, sH = src.height || outH;
      if (sRatio > targetRatio) { sW = (src.height || outH) * targetRatio; sx = ((src.width || outW) - sW) / 2; }
      else { sH = (src.width || outW) / targetRatio; sy = ((src.height || outH) - sH) / 2; }
      ctx.drawImage(src as CanvasImageSource, sx, sy, sW, sH, 0, 0, outW, outH);
      return c.toDataURL('image/jpeg', 0.88);
    } catch { return null; }
  };

  /** 截图入队：可指定机位（先切位再抓帧）；成功后自动上传资产库并落盘 previz_shots */
  const queueSnapshot = async (cameraName: string, cam?: StageCamera) => {
    if (!activeShot) return;
    if (cam) {
      applyPose(cam);
      // 等两帧，确保监视器已按该机位渲染完成
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
    const dataUrl = captureFrameDataUrl();
    if (!dataUrl) { setSnapshotMsg('截图失败（画布不可读或舞台未加载）'); return; }
    const item: QueueShot = {
      id: `qs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      camera: cameraName,
      dataUrl,
      uploading: true,
    };
    setShotQueue((q) => [...q, item]);
    setSnapshotSuccess(true); setTimeout(() => setSnapshotSuccess(false), 2000);
    setSnapshotMsg(`「${cameraName}」已入队，正在上传资产库…`);
    try {
      const assetUrl = await uploadPrevizFile(
        dataUrlToFile(dataUrl, `previz_shot${activeShot.shot_index || ''}_${Date.now()}.jpg`),
        `白模截图_分镜${activeShot.shot_index || ''}_${cameraName}`,
      );
      setShotQueue((q) => q.map((x) => (x.id === item.id ? { ...x, assetUrl, uploading: false } : x)));
      // 落盘：previz_shots 保留最近 12 张机位截图；previz_url 仅在未挂时补首张（不覆盖用户已选参考）
      const existing: string[] = Array.isArray((activeShot as any).previz_shots) ? (activeShot as any).previz_shots : [];
      const nextShots = [...existing, assetUrl].slice(-12);
      const patch: Record<string, any> = { previz_shots: nextShots };
      if (!(activeShot as any).previz_url) patch.previz_url = assetUrl;
      try { updateShot(activeShot.id, patch as any); } catch {}
      setSnapshotMsg(`「${cameraName}」已存资产库${patch.previz_url ? ' 并挂为参考' : ''}（队列 ${nextShots.length} 张）`);
    } catch {
      setShotQueue((q) => q.map((x) => (x.id === item.id ? { ...x, uploading: false, error: '上传失败' } : x)));
      setSnapshotMsg(`「${cameraName}」截图完成，但资产库上传失败（本地缩略图仍可设为首帧/参考）`);
    }
  };

  /** 全部机位依次截图入队（LibTV 式多视角截图） */
  const captureAllCameras = async () => {
    if (!activeShot) return;
    if (!stageCameras.length) { setSnapshotMsg('先点「＋机位」新建至少一个机位'); return; }
    for (const cam of stageCameras) {
      // eslint-disable-next-line no-await-in-loop
      await queueSnapshot(cam.name || '机位', cam);
    }
    // 抓完回到第一个机位，保持监视器与列表一致
    if (stageCameras[0]) applyPose(stageCameras[0]);
    setSnapshotMsg(`已按 ${stageCameras.length} 个机位截图并入队`);
  };

  const removeCamera = (camId: string) => {
    const next = stageCameras.filter((c) => c.id !== camId);
    if (camOverrideRef.current?.id === camId) camOverrideRef.current = null;
    persistCameras(next);
  };

  const removeQueueItem = (id: string) => setShotQueue((q) => q.filter((x) => x.id !== id));

  /** 队列项 → 本镜参考图（previz_url） */
  const setQueueItemAsRef = (item: QueueShot) => {
    if (!activeShot) return;
    try { updateShot(activeShot.id, { previz_url: item.assetUrl || item.dataUrl } as any); } catch {}
    setSnapshotMsg(`「${item.camera}」已设为参考图`);
  };

  /** 现有按钮入口：截当前监视器画面入队（等价于「当前机位」截图） */
  const handleCaptureSnapshot = async () => {
    await queueSnapshot('当前机位');
  };

  // 截图明确设为本镜首帧（覆盖需二次确认；与“仅作参考”分离）
  const handleSetSnapshotAsFirstFrame = async () => {
    if (!activeShot?.previz_url) { setSnapshotMsg('请先截屏'); return; }
    if (activeShot.image_url) {
      const confirmed = await confirmAsync({
        title: '覆盖首帧画面',
        message: '当前镜头已存在 AI 生成的首帧画面，确定要用 3D 虚拟片场当前画面覆盖它吗？',
        confirmText: '确认覆盖',
        cancelText: '取消'
      });
      if (!confirmed) return;
    }
    updateShot(activeShot.id, { image_url: activeShot.previz_url });
    setSnapshotMsg('已设为本镜首帧');
    toast.success('3D 虚拟片场截图已设为当前镜头首帧');
  };

  /** 队列项明确设为本镜首帧（覆盖需二次确认） */
  const setQueueItemAsFirstFrame = async (item: QueueShot) => {
    if (!activeShot) return;
    const url = item.assetUrl || item.dataUrl;
    if (!url) return;
    if (activeShot.image_url) {
      const confirmed = await confirmAsync({
        title: '覆盖首帧画面',
        message: `当前镜头已存在首帧画面，确定用「${item.camera}」的 3D 白模截图覆盖它吗？`,
        confirmText: '确认覆盖',
        cancelText: '取消',
      });
      if (!confirmed) return;
    }
    updateShot(activeShot.id, { image_url: url } as any);
    setSnapshotMsg(`「${item.camera}」已设为本镜首帧`);
    toast.success('白模截图已设为当前镜头首帧');
  };

  const dataUrlToFile = (dataUrl: string, name: string): File => {
    const [head, b64] = dataUrl.split(',');
    const mime = /data:(.*?);/.exec(head)?.[1] || 'image/jpeg';
    const bin = atob(b64 || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  };

  const uploadPrevizFile = async (file: File, name: string): Promise<string> => {
    const form = new FormData();
    form.append('name', name);
    form.append('category', 'previz');
    form.append('tags', 'previz,导演预演');
    const pid = project?.id;
    if (pid) form.append('project_id', pid);
    form.append('file', file);
    const r: any = await apiService.createAsset(form);
    const assetUrl = r?.asset?.file_url || r?.asset?.url || r?.file_url || '';
    if (!assetUrl) throw new Error('上传无返回地址');
    return assetUrl;
  };

  // 预演录制：录制监视器（导演机位视角）画面为 webm；随运镜模拟同起同止
  const finalizeRecording = useCallback(() => {
    try {
      const blob = new Blob(recordChunksRef.current, { type: 'video/webm' });
      recordChunksRef.current = [];
      if (blob.size === 0) { setRecordMsg('录制失败：未采集到画面（请确认监视器已开启）'); return; }
      const secs = recordSecsRefValue();
      const url = URL.createObjectURL(blob);
      setRecordUrl(url);
      setRecordSecs(secs);
      // 自动下载一份到本地
      const a = document.createElement('a');
      a.href = url;
      a.download = `previz_${activeShot?.shot_index ?? 'shot'}_${Date.now()}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setRecordMsg(`已录制 ${secs.toFixed(1)}s 预演（webm 已下载，正在上传资产库…）`);
      // 同步上传资产库（失败不阻塞，本地文件已落盘）
      const pid = project?.id;
      const form = new FormData();
      form.append('name', `导演预演_${activeShot?.shot_index ?? ''}_${new Date().toLocaleString()}`);
      form.append('category', 'previz');
      form.append('tags', 'previz,导演预演');
      if (pid) form.append('project_id', pid);
      form.append('file', new File([blob], 'previz.webm', { type: 'video/webm' }));
      apiService.createAsset(form).then((r: any) => {
        const assetUrl = r?.asset?.file_url || r?.asset?.url || r?.file_url || '';
        if (assetUrl) {
          setLastRecordAssetUrl(assetUrl);
          // 动态预演落盘到分镜独立字段（不碰 image_url/video_url），供白模参考链路消费
          if (activeShot) { try { updateShot(activeShot.id, { previz_video_url: assetUrl }); } catch {} }
        }
        setRecordMsg(`已录制 ${secs.toFixed(1)}s 预演（已存资产库${assetUrl ? '并挂为视频参考' : '，本地文件可用'}）`);
      }).catch(() => {
        setRecordMsg(`已录制 ${secs.toFixed(1)}s 预演（webm 已下载，资产库上传失败，可手动设为参考）`);
      });
    } catch (e: any) {
      setRecordMsg(`录制失败：${e?.message || e}`);
    }
  }, [activeShot, project]);

  const recordSecsRefValue = () => {
    // 录制时长按当前运镜模拟时长估算（与模拟同起同止）
    return motionSpeed === '0.5x' ? 4.5 : motionSpeed === '1.5x' ? 1.8 : motionSpeed === '2.0x' ? 1.2 : 2.5;
  };

  // 录制结果显式设为本镜视频参考（上传成功即资产地址；仅本地时提示会话有效期）
  const handleSetRecordAsVideoRef = () => {
    const url = lastRecordAssetUrl || recordUrl;
    if (!url) { setRecordMsg('请先录制预演'); return; }
    if (!activeShot) return;
    updateShot(activeShot.id, { previz_video_url: url });
    setRecordMsg(lastRecordAssetUrl ? '已设为本镜视频参考' : '已设为本镜视频参考（本地预览，刷新后失效，建议等待上传完成）');
  };

  const handleToggleRecording = () => {    if (isRecording) {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') { try { recorderRef.current.stop(); } catch {} }
      if (recordTimerRef.current) { clearTimeout(recordTimerRef.current); recordTimerRef.current = null; }
      setIsRecording(false);
      return;
    }
    const canvas = pipRendererRef.current?.domElement as HTMLCanvasElement | undefined;
    if (!canvas || !showPip) { setRecordMsg('请先开启监视器（右上 Monitor）再录制'); return; }
    try {
      const stream = canvas.captureStream(30);
      const mime = (window as any).MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      recordChunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) recordChunksRef.current.push(ev.data); };
      rec.onstop = () => { setIsRecording(false); finalizeRecording(); };
      rec.start(200);
      recorderRef.current = rec;
      setIsRecording(true);
      setRecordMsg(null);
      setRecordUrl(null);
      setLastRecordAssetUrl(null);
      // 与运镜模拟同起；12s 兜底停（模拟最长 4.5s，正常由模拟结束触发 stop）
      if (!isSimulating) handleToggleSimulation();
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      recordTimerRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') { try { recorderRef.current.stop(); } catch {} }
      }, 12000);
    } catch (e: any) {
      setRecordMsg(`录制启动失败：${e?.message || e}（该浏览器可能不支持 MediaRecorder）`);
    }
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full bg-background overflow-hidden select-none">
      <div className="flex-1 relative flex flex-col bg-background overflow-hidden">
        <div className="absolute top-4 left-4 z-20 flex items-center space-x-3 bg-surface/90 backdrop-blur-md px-4 py-2 rounded-2xl border border-border shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-light animate-pulse" />
            <span className="text-xs font-bold text-white tracking-wide">MiniMax 3D 虚拟导演台 · 真实建模重构版</span>
          </div>
          <span className="text-gray-600">|</span>
          <div className="flex items-center space-x-1.5">
            <span className="text-[11px] text-gray-400">当前分镜:</span>
            <select value={activeShot?.id || ''} onChange={(e) => setActiveShotId(e.target.value)} className="bg-surface-secondary border border-border rounded-lg px-2.5 py-1 text-xs font-mono text-brand-light focus:outline-none focus:border-brand cursor-pointer">
              {shots.map((sh, idx) => <option key={sh.id} value={sh.id}>#{sh.shot_index || idx + 1}: {sh.action_desc.slice(0, 16) || '分镜镜头'}</option>)}
            </select>
          </div>
          {selectedEntity && <><span className="text-gray-600">|</span><button onClick={() => selectEntity(null)} title="点击取消选中（Esc）" className="flex items-center space-x-1.5 bg-brand/20 border border-brand/40 px-2 py-0.5 rounded-full text-[10px] text-brand-light hover:bg-brand/30"><Focus className="w-3 h-3" /><span>选中: {entityLabel(selectedEntity)} ×</span></button></>}
        </div>
        <div className="absolute top-4 right-4 z-20 flex items-center space-x-2">
          <button onClick={handleResetView} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface/85 hover:bg-surface border border-border text-xs text-gray-300 hover:text-white backdrop-blur-md shadow-md transition-all"><Compass className="w-3.5 h-3.5" /><span>视角复位</span></button>
          <button onClick={() => setShowTrajectory(!showTrajectory)} className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${showTrajectory ? 'bg-accent-blue/20 border-accent-blue text-accent-blue' : 'bg-surface/85 border-border text-gray-400 hover:text-white'}`}><Activity className="w-3.5 h-3.5" /><span>轨迹曲线</span></button>
          <button onClick={() => setShowHelpers(!showHelpers)} className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${showHelpers ? 'bg-brand/20 border-brand text-brand-light' : 'bg-surface/85 border-border text-gray-400 hover:text-white'}`}><Eye className="w-3.5 h-3.5" /><span>机位视锥</span></button>
          <button onClick={() => setShowPip(!showPip)} className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${showPip ? 'bg-brand/20 border-brand text-brand-light' : 'bg-surface/85 border-border text-gray-400 hover:text-white'}`}><Monitor className="w-3.5 h-3.5" /><span>监视器</span></button>
        </div>
        <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing outline-none" />
        {/* 物体摆放工具条（对标小云雀中间工具栏 + updream左侧栏）：选择/移动/旋转/缩放/吸附/撤销 */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center space-y-1 bg-surface/90 backdrop-blur-md p-1.5 rounded-2xl border border-border shadow-xl">
          <button onClick={() => setGizmoMode('translate')} title="移动 (W/G)：拖坐标轴移动物体，空白拖拽旋转视角" className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${gizmoMode === 'translate' ? 'bg-brand text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}><Move className="w-4 h-4" /></button>
          <button onClick={() => setGizmoMode('rotate')} title="旋转 (E)：拖圆环旋转，右侧可输角度" className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${gizmoMode === 'rotate' ? 'bg-brand text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}><Rotate3d className="w-4 h-4" /></button>
          <button onClick={() => setGizmoMode('scale')} title="缩放 (R)：拖手柄缩放" className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${gizmoMode === 'scale' ? 'bg-brand text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-surface-secondary'}`}><Maximize2 className="w-4 h-4" /></button>
          <div className="w-6 h-px bg-border" />
          <button onClick={() => setSnapEnabled((v) => !v)} title={snapEnabled ? '吸附开：移动0.1m/旋转5°（点击关闭）' : '吸附关（点击开启）'} className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold transition-all ${snapEnabled ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/40' : 'text-gray-500 hover:text-white'}`}>🧲</button>
          <button onClick={undoLastTransform} title="撤销上次摆放 (Ctrl+Z)" className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 hover:text-white hover:bg-surface-secondary transition-all">↩</button>
          <button onClick={resetSelectedTransform} title="复位选中物体到默认摆位（小云雀式复位）" className="w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 hover:text-white hover:bg-surface-secondary transition-all"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {/* 底部操作提示（对标updream快捷键教学） */}
        <div className="absolute bottom-[5.2rem] left-16 z-10 hidden md:block text-[10px] text-gray-500 leading-4 bg-surface/85 px-2 py-1 rounded-lg backdrop-blur-sm pointer-events-none">
          左键点击选中 · 拖轴移动/旋转 · 拖空白旋转视角 · 右键平移 · 滚轮缩放 · <span className="text-gray-300 font-mono">W移动 E旋转 R缩放 Ctrl+Z撤销 Esc取消</span>
        </div>
        {/* 大纲列表（对标updream图层区 + 小云雀左侧素材区）：点选比视口点选更可靠，支持锁定防误拖 */}
        {entityList.length > 0 && (
          <div className="absolute left-16 top-[4.2rem] z-20 w-36 bg-surface/90 backdrop-blur-md rounded-2xl border border-border shadow-xl p-1.5 space-y-0.5 max-h-56 overflow-y-auto custom-scrollbar">
            <div className="text-[10px] text-gray-500 font-bold px-1.5 py-1">场景大纲 ({entityList.length})</div>
            {entityList.map((e) => (
              <div key={e.id} className={`group flex items-center space-x-1 px-1.5 py-1 rounded-lg text-[11px] cursor-pointer transition-all ${selectedEntity === e.id ? 'bg-brand/20 text-white border border-brand/40' : 'text-gray-400 hover:text-white hover:bg-surface-secondary border border-transparent'}`}>
                <button onClick={() => selectEntity(e.id)} className="flex-1 text-left truncate">{e.label}</button>
                <button onClick={() => setLockedIds((prev) => ({ ...prev, [e.id]: !prev[e.id] }))} title={lockedIds[e.id] ? '解锁（允许拖拽）' : '锁定（防误拖，对标updream锁定）'} className={`text-[10px] px-1 rounded ${lockedIds[e.id] ? 'text-yellow-300' : 'text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100'}`}>{lockedIds[e.id] ? '🔒' : '🔓'}</button>
              </div>
            ))}
          </div>
        )}
        {/* Agent 场景生成条 */}
        <div className="absolute top-[4.2rem] left-4 right-4 md:right-72 z-20 flex items-center space-x-2 bg-gradient-to-r from-brand/15 to-accent-blue/15 backdrop-blur-md p-2 rounded-2xl border border-brand/30 shadow-xl">
          <div className="flex items-center space-x-1.5 pl-2 text-brand-light"><Lightbulb className="w-4 h-4" /><span className="text-[10px] font-bold">Agent 布景</span></div>
          <textarea value={scenePrompt} onChange={(e) => { setScenePrompt(e.target.value); const el=e.target as HTMLTextAreaElement; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,80)+'px'; }} onInput={(e)=>{const el=e.target as HTMLTextAreaElement; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,80)+'px';}} onKeyDown={(e) => { e.stopPropagation(); if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleAgentSceneGenerate(); } }} onPaste={(e) => e.stopPropagation()} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()} placeholder="自然语言布景（Shift+Enter 换行）：如 “切换到修仙云海，添加持剑敌人对峙，地面加符文阵” 粘贴长段亦可" rows={1} className="flex-1 nodrag select-text bg-surface/70 border border-border rounded-xl px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none overflow-y-auto min-h-[28px] max-h-[80px] leading-relaxed" style={{height:'auto'}} />
          <button onClick={handleAgentSceneGenerate} disabled={sceneGenerating || !scenePrompt.trim()} className="px-3 py-1.5 rounded-xl bg-brand hover:opacity-90 disabled:opacity-40 text-white text-xs font-bold flex items-center space-x-1 self-end"><span>{sceneGenerating ? '生成中...' : '生成'}</span><Sparkles className="w-3 h-3" /></button>
          <span className="hidden md:inline text-[10px] text-gray-400 max-w-[140px] truncate" title={sceneDesc}>{sceneDesc}</span>
        </div>
        <div className="absolute bottom-4 left-4 right-4 md:right-72 z-20 flex flex-col space-y-2 pointer-events-auto">
          {isSimulating && <div className="bg-surface/90 backdrop-blur-md p-2 rounded-xl border border-brand/40 shadow-xl flex items-center space-x-3"><span className="text-[10px] font-mono text-brand-light font-bold">运镜进度</span><input type="range" min="0" max="1" step="0.01" value={scrubberProgress} onChange={(e) => setScrubberProgress(parseFloat(e.target.value))} className="flex-1 accent-brand h-1.5 bg-surface-secondary rounded cursor-pointer" /><span className="text-[10px] font-mono text-gray-400">{(scrubberProgress * 100).toFixed(0)}%</span></div>}
          <div className="flex items-end space-x-2 bg-surface/90 backdrop-blur-md p-2 rounded-2xl border border-border shadow-2xl">
            <div className="flex items-center pl-2 pr-1 pt-1.5 text-brand-light self-start"><Wand2 className="w-4 h-4 animate-pulse" /></div>
            <textarea value={aiPrompt} onChange={(e) => { setAiPrompt(e.target.value); const el=e.target as HTMLTextAreaElement; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,80)+'px'; }} onInput={(e)=>{const el=e.target as HTMLTextAreaElement; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,80)+'px';}} onKeyDown={(e) => { e.stopPropagation(); if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleExecuteAiDirective(); } }} onPaste={(e) => e.stopPropagation()} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()} placeholder="✨ AI 机位调度（Shift+Enter 换行）：如 '希区柯克变焦突显惊恐眼神'、'贴地仰角双人对峙推镜'... 粘贴长指令亦可" rows={1} className="flex-1 nodrag select-text bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none resize-none overflow-y-auto min-h-[20px] max-h-[80px] leading-relaxed py-1.5" style={{height:'auto'}} />
            <button onClick={handleExecuteAiDirective} disabled={aiThinking || !aiPrompt.trim()} className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 disabled:opacity-50 text-white text-xs font-bold shadow-md shadow-brand/20 transition-all flex items-center space-x-1.5 self-end">{aiThinking ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}<span>{aiThinking ? '正在调度...' : 'AI 机位调度'}</span></button>
          </div>
        </div>
        {showPip && (
          <div className="absolute bottom-18 md:bottom-4 right-4 z-20 w-52 h-80 bg-surface/95 border-2 border-brand/60 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md flex flex-col transition-all">
            <div className="h-7 px-3 bg-surface-secondary border-b border-border flex items-center justify-between text-[10px] text-gray-300 font-mono">
              <span className="flex items-center space-x-1.5"><span className="w-2 h-2 rounded-full bg-red-500 animate-ping" /><span className="text-white font-bold">{stageCameras.find((c) => c.id === activeCamId)?.name || 'CAM 1'} [REC]</span></span>
              <div className="flex items-center space-x-1"><span className="text-brand-light font-bold">{aspectRatioMask}</span><span className="text-gray-500">|</span><span className="text-accent-blue font-bold">{focalLength}mm</span></div>
            </div>
            <div ref={pipBoxRef} className="flex-1 relative overflow-hidden bg-surface-secondary flex items-center justify-center"><div className="relative shadow-inner" style={{ width: pipFrame.w || '100%', height: pipFrame.h || undefined, aspectRatio: projectAspect, maxHeight: '100%' }}><div ref={pipContainerRef} className="absolute inset-0" />{compositionGrid === 'rule_of_thirds' && <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 border border-white/10 opacity-40"><div className="border-r border-b border-white/25" /><div className="border-r border-b border-white/25" /><div className="border-b border-white/25" /><div className="border-r border-b border-white/25" /><div className="border-r border-b border-white/25" /><div className="border-b border-white/25" /><div className="border-r border-b border-white/25" /><div className="border-r border-b border-white/25" /><div /></div>}{compositionGrid === 'crosshair' && <div className="absolute inset-0 pointer-events-none flex items-center justify-center"><Crosshair className="w-6 h-6 text-brand-light/70" /></div>}{compositionGrid === 'golden_ratio' && <div className="absolute inset-0 pointer-events-none border border-brand-light/30 rounded-full scale-90 opacity-40" />}</div></div>
            <div className="p-2 bg-surface-secondary/95 border-t border-border flex items-center justify-between text-[10px] gap-1">
              <button onClick={() => setCompositionGrid((g) => (g === 'rule_of_thirds' ? 'crosshair' : g === 'crosshair' ? 'golden_ratio' : g === 'golden_ratio' ? 'none' : 'rule_of_thirds'))} className="px-2 py-0.5 rounded bg-surface border border-border text-gray-300 hover:text-white font-mono" title="切换构图参考线">网格: {compositionGrid === 'rule_of_thirds' ? '九宫' : compositionGrid === 'crosshair' ? '十字' : compositionGrid === 'golden_ratio' ? '黄金' : '无'}</button>
              <button onClick={handleCaptureSnapshot} className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-brand/30 hover:bg-brand border border-brand/50 text-brand-light hover:text-white font-bold transition-all" title="截取当前监视器画面入队（上传资产库 previz）">{snapshotSuccess ? <Check className="w-3 h-3 text-accent-green" /> : <Camera className="w-3 h-3" />}<span>{snapshotSuccess ? '已入队' : '截屏入队'}</span></button>
              <button onClick={handleSetSnapshotAsFirstFrame} className="px-2 py-1 rounded-lg bg-surface border border-border text-gray-300 hover:text-white font-mono" title="把当前截图参考设为本镜首帧（覆盖需确认）">设为首帧</button>
            </div>
            {/* 多机位：＋机位(当前导演视角) / 全部机位截图 / 机位切换 */}
            <div className="px-2 py-1.5 bg-surface-secondary/95 border-t border-border space-y-1">
              <div className="flex items-center gap-1 flex-wrap">
                <button onClick={addCameraFromDirectorView} className="px-1.5 py-0.5 rounded bg-brand/20 border border-brand/40 text-[9.5px] text-brand-light hover:bg-brand/30 font-bold" title="把主视图当前视角保存为一个机位">＋机位</button>
                <button onClick={() => void captureAllCameras()} disabled={!stageCameras.length} className="px-1.5 py-0.5 rounded bg-surface border border-border text-[9.5px] text-gray-300 hover:text-white disabled:opacity-40" title="按顺序为每个机位截图并入队">全部机位截图</button>
                {stageCameras.map((c) => (
                  <span key={c.id} className={`flex items-center rounded border overflow-hidden ${activeCamId === c.id ? 'border-brand/60 bg-brand/15 text-brand-light' : 'border-border bg-surface text-gray-400'}`}>
                    <button onClick={() => applyPose(c)} className="px-1.5 py-0.5 text-[9.5px] hover:text-white" title="切到此机位">{c.name}</button>
                    <button onClick={() => removeCamera(c.id)} className="px-1 py-0.5 text-[9.5px] hover:text-red-300 border-l border-border/60" title="删除机位">×</button>
                  </span>
                ))}
              </div>
              {shotQueue.length > 0 && (
                <div className="flex gap-1.5 overflow-x-auto custom-scrollbar pb-0.5">
                  {shotQueue.map((item) => (
                    <div key={item.id} className="w-[74px] shrink-0 rounded-lg overflow-hidden border border-border bg-black/40">
                      <img src={item.dataUrl} alt={item.camera} className="w-full h-11 object-cover" />
                      <div className="px-1 pt-0.5 text-[8.5px] text-gray-400 truncate" title={item.camera}>
                        {item.camera}{item.uploading ? ' · 上传中' : item.error ? ' · 失败' : ' · ✓'}
                      </div>
                      <div className="flex border-t border-border/60 text-[9px]">
                        <button onClick={() => void setQueueItemAsFirstFrame(item)} className="flex-1 py-0.5 text-gray-300 hover:text-brand-light" title="设为本镜首帧">首帧</button>
                        <button onClick={() => setQueueItemAsRef(item)} className="flex-1 py-0.5 text-gray-300 hover:text-accent-green border-l border-border/60" title="设为本镜参考图（previz_url）">参考</button>
                        <button onClick={() => removeQueueItem(item.id)} className="px-1 py-0.5 text-gray-500 hover:text-red-300 border-l border-border/60" title="移除">×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {(snapshotMsg || activeShot?.previz_url) && <div className="px-2 py-1 bg-surface-secondary/95 border-t border-border text-[10px] text-gray-400 leading-4">
              {activeShot?.previz_url && <span className="text-accent-green font-bold">✓ 参考已挂载 </span>}
              {Array.isArray((activeShot as any)?.previz_shots) && (activeShot as any).previz_shots.length > 0 && (
                <span className="text-gray-500">机位截图 {(activeShot as any).previz_shots.length} 张 · </span>
              )}
              {snapshotMsg}
            </div>}
          </div>
        )}
      </div>
      <div className="w-full md:w-96 bg-surface border-l border-border flex flex-col h-full overflow-hidden shrink-0 shadow-2xl">
        <div className="flex items-center border-b border-border bg-surface-secondary/80 p-1">
          <button onClick={() => setActiveRightTab('optics_motion')} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${activeRightTab === 'optics_motion' ? 'bg-surface text-brand-light shadow-md' : 'text-gray-400 hover:text-gray-200'}`}><Video className="w-3.5 h-3.5" /><span>光学与运镜</span></button>
          <button onClick={() => setActiveRightTab('cast_props')} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${activeRightTab === 'cast_props' ? 'bg-surface text-accent-orange shadow-md' : 'text-gray-400 hover:text-gray-200'}`}><Users className="w-3.5 h-3.5" /><span>站位与道具</span></button>
          <button onClick={() => setActiveRightTab('environment')} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${activeRightTab === 'environment' ? 'bg-surface text-accent-green shadow-md' : 'text-gray-400 hover:text-gray-200'}`}><Sun className="w-3.5 h-3.5" /><span>影棚环境</span></button>
          <button onClick={() => setActiveRightTab('lighting')} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${activeRightTab === 'lighting' ? 'bg-surface text-yellow-300 shadow-md' : 'text-gray-400 hover:text-gray-200'}`}><Lightbulb className="w-3.5 h-3.5" /><span>灯光</span></button>
          <button onClick={() => setActiveRightTab('agent')} className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1 ${activeRightTab === 'agent' ? 'bg-surface text-accent-blue shadow-md' : 'text-gray-400 hover:text-gray-200'}`}><Mic className="w-3 h-3" /><span>Agent</span></button>
        </div>
        <div className="flex-1 p-5 space-y-6 overflow-y-auto custom-scrollbar">
          {activeRightTab === 'optics_motion' && (
            <>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span className="flex items-center space-x-1.5"><Camera className="w-3.5 h-3.5 text-accent-blue" /><span>镜头焦距 (Focal Length)</span></span><span className="text-xs text-accent-blue font-mono font-bold bg-accent-blue/10 px-2 py-0.5 rounded">{focalLength} mm</span></label>
                <input type="range" min="16" max="135" step="1" value={focalLength} onChange={(e) => setFocalLength(parseInt(e.target.value))} className="w-full accent-accent-blue h-1.5 bg-surface-secondary rounded cursor-pointer" />
                <div className="grid grid-cols-6 gap-1.5 mt-2">{FOCAL_PRESETS.map((fl) => <button key={fl} onClick={() => setFocalLength(fl)} className={`py-1 rounded-lg text-[10px] font-mono font-bold border transition-all ${focalLength === fl ? 'bg-accent-blue/20 border-accent-blue text-white' : 'bg-surface-secondary border-border text-gray-400 hover:text-white'}`}>{fl}mm</button>)}</div>
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span className="flex items-center space-x-1.5"><Rotate3d className="w-3.5 h-3.5 text-brand-light" /><span>荷兰角倾斜 (Dutch Roll)</span></span><span className="text-xs text-brand-light font-mono font-bold bg-brand/10 px-2 py-0.5 rounded">{cameraRoll > 0 ? '+' : ''}{cameraRoll.toFixed(1)}°</span></label>
                <input type="range" min="-45" max="45" step="1" value={cameraRoll} onChange={(e) => setCameraRoll(parseFloat(e.target.value))} className="w-full accent-brand h-1.5 bg-surface-secondary rounded cursor-pointer" />
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>🎥 镜头景别 (Framing Preset)</span><span className="text-[10px] text-brand-light font-mono bg-brand/10 px-2 py-0.5 rounded">{framing}</span></label>
                <div className="grid grid-cols-2 gap-2">{FRAMING_PRESETS.map((f) => <button key={f.id} onClick={() => { setFraming(f.id); setFocalLength(f.fl); }} className={`p-2.5 rounded-xl text-left border transition-all ${framing === f.id ? 'bg-brand/20 border-brand text-white shadow-md shadow-brand/20 ring-1 ring-brand' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold truncate">{f.label}</div><div className="text-[9px] text-gray-500 truncate mt-0.5">{f.desc}</div></button>)}</div>
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>🚀 运镜轨迹 (MiniMax Motion Matrix)</span><span className="text-[10px] text-accent-orange font-mono bg-accent-orange/10 px-2 py-0.5 rounded">{motion}</span></label>
                <div className="space-y-3">
                  <div className="text-[10px] font-bold text-accent-orange uppercase tracking-wider">🌟 电影级双轴复合运镜 (MiniMax Combos)</div>
                  <div className="grid grid-cols-1 gap-2">{MOTION_PRESETS.filter((m) => m.category === 'combo').map((m) => <button key={m.id} onClick={() => setMotion(m.id)} className={`p-2.5 rounded-xl border text-left transition-all ${motion === m.id ? 'bg-accent-orange/20 border-accent-orange text-white shadow-md shadow-accent-orange/20 ring-1 ring-accent-orange' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold flex items-center justify-between"><span>{m.label}</span><span className="text-[9px] bg-accent-orange/30 text-accent-orange px-1.5 py-0.5 rounded font-mono">COMBO</span></div><div className="text-[9px] text-gray-400 mt-0.5">{m.desc}</div></button>)}</div>
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pt-2">🎬 经典单轴运镜</div>
                  <div className="grid grid-cols-2 gap-2">{MOTION_PRESETS.filter((m) => m.category === 'single').map((m) => <button key={m.id} onClick={() => setMotion(m.id)} className={`p-2 rounded-xl border text-left transition-all ${motion === m.id ? 'bg-brand/20 border-brand text-white shadow-md ring-1 ring-brand' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold truncate">{m.label}</div><div className="text-[9px] text-gray-500 truncate mt-0.5">{m.desc}</div></button>)}</div>
                </div>
                <div className="mt-4 space-y-2"><button onClick={handleToggleSimulation} className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-all ${isSimulating ? 'bg-red-500 text-white' : 'bg-gradient-to-r from-accent-orange to-brand text-white hover:opacity-95'}`}>{isSimulating ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}<span>{isSimulating ? '停止运镜预览' : '▶ 播放当前运镜轨迹模拟'}</span></button>
                  <button onClick={handleToggleRecording} className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-all border ${isRecording ? 'bg-red-600/20 border-red-500 text-red-300' : 'bg-surface-secondary border-border text-gray-200 hover:border-red-400'}`}><Video className="w-4 h-4" /><span>{isRecording ? '⏺ 录制中…点击停止' : '⏺ 录制预演为视频参考（webm）'}</span></button>
                  {(recordUrl || lastRecordAssetUrl) && !isRecording && <button onClick={handleSetRecordAsVideoRef} className="w-full py-2 rounded-xl bg-surface-secondary border border-border text-[11px] text-gray-200 hover:border-brand">设为本镜视频参考{activeShot?.previz_video_url ? ' ✓已挂载' : ''}</button>}
                  {recordMsg && <div className="text-[10px] text-gray-400 leading-4">{recordMsg}</div>}
                  {recordUrl && <a href={recordUrl} target="_blank" rel="noreferrer" className="block text-center text-[11px] text-accent-blue underline">回放刚录制的预演</a>}
                </div>
              </div>
            </>
          )}
          {activeRightTab === 'cast_props' && (
            <>
              {/* 选中物体数值面板（对标小云雀右侧属性 + updream右侧机位/人物选项卡）：Gizmo拖 + 数值输双通道 */}
              <div className="p-3 rounded-xl bg-surface-secondary border border-brand/30 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">🎯 选中物体 {selectedEntity ? `· ${entityLabel(selectedEntity)}` : '· 未选中'}</span>
                  {selectedEntity && <span className="text-[10px] font-mono text-gray-500">{selectedEntity}</span>}
                </div>
                {!selectedEntity && <div className="text-[11px] text-gray-500 leading-4">点击视口中任意角色/道具，或左侧大纲点选。拖坐标轴手柄移动，右侧数值可精确输入（小云雀式双通道）。</div>}
                {selectedEntity && selectedTransform && (
                  <>
                    <div className="grid grid-cols-3 gap-1.5">
                      <label className="text-[10px] text-gray-400">X<input type="number" step="0.1" value={Number(selectedTransform.p[0].toFixed(2))} onChange={(e) => applyNumericToSelected({ px: parseFloat(e.target.value) || 0 })} className="mt-0.5 w-full bg-surface border border-border rounded-lg px-1.5 py-1 text-[11px] text-white font-mono focus:border-brand focus:outline-none" /></label>
                      <label className="text-[10px] text-gray-400">Y<input type="number" step="0.1" value={Number(selectedTransform.p[1].toFixed(2))} onChange={(e) => applyNumericToSelected({ py: parseFloat(e.target.value) || 0 })} className="mt-0.5 w-full bg-surface border border-border rounded-lg px-1.5 py-1 text-[11px] text-white font-mono focus:border-brand focus:outline-none" /></label>
                      <label className="text-[10px] text-gray-400">Z<input type="number" step="0.1" value={Number(selectedTransform.p[2].toFixed(2))} onChange={(e) => applyNumericToSelected({ pz: parseFloat(e.target.value) || 0 })} className="mt-0.5 w-full bg-surface border border-border rounded-lg px-1.5 py-1 text-[11px] text-white font-mono focus:border-brand focus:outline-none" /></label>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="text-[10px] text-gray-400">朝向°<input type="number" step="5" value={Number(((selectedTransform.r[1] * 180) / Math.PI).toFixed(0))} onChange={(e) => applyNumericToSelected({ ry: parseFloat(e.target.value) || 0 })} className="mt-0.5 w-full bg-surface border border-border rounded-lg px-1.5 py-1 text-[11px] text-white font-mono focus:border-brand focus:outline-none" /></label>
                      <label className="text-[10px] text-gray-400">缩放<input type="number" step="0.1" min="0.1" max="5" value={Number(selectedTransform.s.toFixed(2))} onChange={(e) => applyNumericToSelected({ s: parseFloat(e.target.value) || 1 })} className="mt-0.5 w-full bg-surface border border-border rounded-lg px-1.5 py-1 text-[11px] text-white font-mono focus:border-brand focus:outline-none" /></label>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      <button onClick={() => setLockedIds((prev) => selectedEntity ? { ...prev, [selectedEntity]: !prev[selectedEntity] } : prev)} className="flex-1 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-gray-300 hover:text-white">{lockedIds[selectedEntity] ? '🔒 已锁定（点击解锁）' : '🔓 未锁定（点击锁定防误拖）'}</button>
                      <button onClick={resetSelectedTransform} className="flex-1 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-gray-300 hover:text-white">复位摆位</button>
                      {selectedEntity.startsWith('custom_') && <button onClick={deleteSelectedCustom} className="flex-1 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-[11px] text-red-300 hover:text-white">删除模型</button>}
                    </div>
                  </>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>👥 多角色空间站位 (Cast Staging)</span><span className="text-[10px] text-accent-orange font-mono bg-accent-orange/10 px-2 py-0.5 rounded">{castLayout}</span></label>
                <div className="grid grid-cols-2 gap-2">{CAST_LAYOUTS.map((c) => <button key={c.id} onClick={() => setCastLayout(c.id)} className={`p-2.5 rounded-xl text-left border transition-all ${castLayout === c.id ? 'bg-accent-orange/20 border-accent-orange text-white shadow-md ring-1 ring-accent-orange' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold">{c.label}</div><div className="text-[9px] text-gray-500 mt-0.5">{c.desc}</div></button>)}</div>
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>🚶 主角走位路径 (Blocking)</span><span className="text-[10px] text-accent-green font-mono bg-accent-green/10 px-2 py-0.5 rounded">{waypoints.length}/6 点</span></label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setWalkMode((v) => !v)} className={`p-2.5 rounded-xl border text-left transition-all ${walkMode ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold">{walkMode ? '✅ 打点中：点击地面' : '开始地面打点'}</div><div className="text-[9px] text-gray-500 mt-0.5">模拟时主角沿路径行走</div></button>
                  <button onClick={clearWalk} className="p-2.5 rounded-xl border text-left bg-surface-secondary border-border text-gray-400 hover:text-white transition-all"><div className="text-xs font-bold">清空路径</div><div className="text-[9px] text-gray-500 mt-0.5">恢复原站位</div></button>
                </div>
                {walkMode && <div className="text-[10px] text-accent-green mt-1.5 leading-4">在 3D 视图地面上点选，主角将在运镜模拟时按同一节奏走完全程（等速经过各点，朝向行进方向）。打点完成后请关闭打点模式再旋转视角。</div>}
                {waypoints.length > 0 && (() => {
                  let total = 0;
                  for (let i = 1; i < waypoints.length; i++) total += Math.hypot(waypoints[i].x - waypoints[i - 1].x, waypoints[i].z - waypoints[i - 1].z);
                  const secs = motionSpeed === '0.5x' ? 4.5 : motionSpeed === '1.5x' ? 1.8 : motionSpeed === '2.0x' ? 1.2 : 2.5;
                  return <div className="text-[10px] text-gray-400 mt-1.5 font-mono">路径 {total.toFixed(1)}m · {secs}s 走完（与运镜同节奏）</div>;
                })()}
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>🥋 角色动作姿态 (9 Poses)</span><span className="text-[10px] text-accent-green font-mono bg-accent-green/10 px-2 py-0.5 rounded">{pose}</span></label>
                <div className="grid grid-cols-3 gap-2">{POSE_PRESETS.map((p) => <button key={p.id} onClick={() => setPose(p.id)} className={`p-2 rounded-xl text-left border transition-all ${pose === p.id ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-sm">{p.icon}</div><div className="text-xs font-bold mt-1 truncate">{p.label}</div></button>)}</div>
              </div>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between"><span>⚔️ 场景道具与结界 (Props & FX)</span><span className="text-[10px] text-gray-500">真实 GLB 已接入</span></label>
                <div className="grid grid-cols-2 gap-2">
                  {propOptions.map((pr: any) => {
                    const active = propsConfig.includes(pr.id);
                    return (
                      <button
                        key={pr.id}
                        onClick={() => setPropsConfig((prev) => (prev.includes(pr.id) ? prev.filter((x) => x !== pr.id) : [...prev, pr.id]))}
                        className={`p-2.5 rounded-xl border text-left flex items-center space-x-2 transition-all ${active ? 'bg-brand/20 border-brand text-white shadow-md' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}
                      >
                        <span className="text-base">{pr.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold truncate">{pr.label}</div>
                          <div className="text-[9px] text-gray-500 truncate">{pr.sub}</div>
                        </div>
                      </button>
                    );
                  })}
                  {/* 插件道具行（director_packs.props）：条目自标，宿主经桥接注入
                      toggleProp / isPropOn（设计 §12，见 ui-registry/adapters/directorPackEntries.ts） */}
                  <DirectorPackBridgeContext.Provider value={directorBridge}>
                    <UISlot host={DIRECTOR_PROPS_HOST} />
                  </DirectorPackBridgeContext.Provider>
                </div>
                <div className="mt-3 p-3 rounded-xl border border-dashed border-brand/40 bg-gradient-to-br from-brand/10 to-accent-blue/10">
                  <input ref={fileInputRef} type="file" accept=".glb,.gltf,model/gltf-binary" hidden onChange={handleImportGLB} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={importingModel} className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 disabled:opacity-40 text-white text-xs font-bold shadow-md">
                    {importingModel ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    <span>{importingModel ? '正在导入...' : '导入本地模型 (.glb/.gltf)'}</span>
                  </button>
                  <div className="text-[10px] text-gray-400 mt-2 leading-4">
                    支持人体/道具/场景，自动归一化至 1.6m、底部对齐、开启阴影；已导入 <span className="text-accent-green font-mono">{customModelNames.length}</span> 个
                    {customModelNames.length > 0 && <span className="block truncate text-accent-blue mt-1">{customModelNames.join('、')}</span>}
                  </div>
                  {importError && <div className="text-[10px] text-red-400 mt-1">{importError}</div>}
                  <div className="text-[10px] text-gray-500 mt-2">提示：可从 Sketchfab / Quaternius / Khronos Sample Models 下载 CC0 模型后直接导入</div>
                </div>
                <div className="mt-2 p-2 rounded-xl bg-surface-secondary border border-border">
                  <div className="text-[10px] text-gray-400">
                    已下载真实模型：<span className="text-accent-green font-mono">RobotExpressive / Soldier / SheenChair / DamagedHelmet / AntiqueCamera / Avocado / BoomBox</span>（CC0，三阶归一化，底部对齐，阴影开启）
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">人体优先加载 GLB，失败回退程序化 PBR 假人；道具支持真实/程序化双路径</div>
                </div>
              </div>
            </>
          )}
          {activeRightTab === 'environment' && (
            <>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 block">🌆 3D 影棚氛围预设</label>
                <div className="grid grid-cols-2 gap-2">{(Object.keys(ENV_LABELS) as StageEnvironment[]).map((env) => { const info = ENV_LABELS[env]; return <button key={env} onClick={() => { setEnvironment(env); setPackEnvId(''); setSceneDesc(`${info.label} · ${info.desc}`); }} className={`p-2.5 rounded-xl border text-left transition-all ${environment === env ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green' : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'}`}><div className="text-xs font-bold flex items-center space-x-1"><span>{info.icon}</span><span>{info.label}</span></div><div className="text-[9px] text-gray-500 mt-0.5">{info.desc}</div></button>; })}</div>
              </div>
              {envEntries.length > 0 && (
                <div>
                  <label className="text-xs text-gray-300 font-semibold mb-2 block">🧩 扩展环境（插件导演包 · 背景底图）</label>
                  <div className="grid grid-cols-2 gap-2">
                    {/* 插件环境行（director_packs.environments）：条目自标，宿主经桥接注入
                        applyEnvironment / activeEnvironmentId（设计 §12） */}
                    <DirectorPackBridgeContext.Provider value={directorBridge}>
                      <UISlot host={DIRECTOR_ENVS_HOST} />
                    </DirectorPackBridgeContext.Provider>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 block">📐 画面比例（跟随项目画幅）</label>
                <div className="flex items-center gap-2">
                  <span className="px-3 py-2 rounded-xl text-xs font-bold bg-brand text-white border border-brand">{projectAspect}</span>
                  <span className="text-[10px] text-gray-500 leading-4">导演台取景与截图比例已锁定为项目画幅，与生成结果一致；如需更改画幅请在项目看板设置。</span>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-surface-secondary border border-border">
                <div className="text-[10px] text-gray-400 font-bold mb-1">当前场景描述</div>
                <div className="text-xs text-accent-green font-mono">{sceneDesc}</div>
              </div>
            </>
          )}
          {activeRightTab === 'lighting' && (
            <>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 block">💡 基础三点光（环境氛围光由影棚预设叠加）</label>
                <div className="space-y-3 p-3 rounded-xl bg-surface-secondary border border-border">
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>主光强度</span><span className="font-mono text-yellow-300">{keyIntensity.toFixed(1)}</span></div>
                    <input type="range" min="0" max="8" step="0.1" value={keyIntensity} onChange={(e) => setKeyIntensity(parseFloat(e.target.value))} className="w-full accent-yellow-400 h-1.5 bg-surface rounded cursor-pointer" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>主光方位</span><span className="font-mono text-yellow-300">{keyAzimuth}°</span></div>
                    <input type="range" min="0" max="360" step="5" value={keyAzimuth} onChange={(e) => setKeyAzimuth(parseInt(e.target.value))} className="w-full accent-yellow-400 h-1.5 bg-surface rounded cursor-pointer" />
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-300 mb-1.5">主光色温</div>
                    <div className="grid grid-cols-4 gap-1.5">{(Object.keys(KEY_TEMPS) as Array<'neon' | 'cold' | 'warm' | 'moon'>).map((t) => <button key={t} onClick={() => setKeyTemp(t)} className={`py-1.5 rounded-lg text-[11px] font-bold border transition-all ${keyTemp === t ? 'bg-yellow-400/20 border-yellow-400 text-white' : 'bg-surface border-border text-gray-400 hover:text-white'}`}>{KEY_TEMPS[t].label}</button>)}</div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>轮廓光强度</span><span className="font-mono text-cyan-300">{rimIntensity.toFixed(1)}</span></div>
                    <input type="range" min="0" max="8" step="0.1" value={rimIntensity} onChange={(e) => setRimIntensity(parseFloat(e.target.value))} className="w-full accent-cyan-400 h-1.5 bg-surface rounded cursor-pointer" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>环境光强度</span><span className="font-mono text-gray-300">{ambientIntensity.toFixed(1)}</span></div>
                    <input type="range" min="0" max="5" step="0.1" value={ambientIntensity} onChange={(e) => setAmbientIntensity(parseFloat(e.target.value))} className="w-full accent-gray-400 h-1.5 bg-surface rounded cursor-pointer" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>曝光 (ACES)</span><span className="font-mono text-gray-300">{exposure.toFixed(2)}</span></div>
                    <input type="range" min="0.4" max="2" step="0.05" value={exposure} onChange={(e) => setExposure(parseFloat(e.target.value))} className="w-full accent-gray-400 h-1.5 bg-surface rounded cursor-pointer" />
                  </div>
                </div>
                <div className="text-[10px] text-gray-500 mt-1.5 leading-4">灯光实时作用于舞台与监视器截图；保存到分镜的联动将在分镜接入阶段补上。</div>
              </div>
            </>
          )}
          {activeRightTab === 'agent' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-gradient-to-br from-brand/10 to-accent-blue/10 border border-brand/20">
                <div className="text-xs font-bold text-white flex items-center space-x-1.5"><Film className="w-3.5 h-3.5 text-brand-light" /><span>Agent 全量导演</span></div>
                <div className="text-[10px] text-gray-400 mt-1 leading-4">输入自然语言，Agent 将同时控制 <span className="text-brand-light">场景/角色/道具/机位/运镜</span>，例：<br /><span className="text-accent-green">“切换到雨夜霓虹，添加持剑敌人对峙，地面加蓝色符文阵，机位用贴地仰角推镜”</span></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setCastLayout('duel')} className="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white hover:border-brand"><UserPlus className="w-3.5 h-3.5" /><span>添加对手</span></button>
                <button onClick={() => setPropsConfig([])} className="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-gray-400 hover:text-white"><Trash2 className="w-3.5 h-3.5" /><span>清空道具</span></button>
                <button onClick={() => setEnvironment('xianxia_cloud')} className="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white hover:border-brand"><Mountain className="w-3.5 h-3.5" /><span>仙山云海</span></button>
                <button onClick={() => setEnvironment('neon_city')} className="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white hover:border-brand"><Building2 className="w-3.5 h-3.5" /><span>霓虹都市</span></button>
              </div>
              <div className="flex items-center space-x-2 text-[10px] text-gray-500"><Palette className="w-3 h-3" /><span>材质：PBR 金属/粗糙度 + 自发光，已启用阴影与 ACES 调色</span></div>
            </div>
          )}
          <div className="p-3.5 rounded-2xl bg-surface-secondary border border-border space-y-2">
            <div className="flex items-center justify-between text-[11px] font-bold text-gray-300"><span className="flex items-center space-x-1.5"><Sparkles className="w-3.5 h-3.5 text-brand-light" /><span>MiniMax 01-Director 规范语法</span></span><span className="text-[9px] bg-brand/20 text-brand-light px-1.5 py-0.5 rounded font-mono">LIVE PROMPT</span></div>
            <div className="p-2.5 rounded-xl bg-surface-secondary font-mono text-[11px] text-brand-light leading-relaxed break-all border border-brand/20">{minimaxPromptPreview}</div>
          </div>
        </div>
        <div className="p-4 border-t border-border bg-surface-secondary/40 shrink-0">
          <button onClick={handleApplyToShot} className={`w-full py-3.5 rounded-2xl text-xs font-bold flex items-center justify-center space-x-2 transition-all shadow-xl ${appliedSuccess ? 'bg-accent-green text-white shadow-accent-green/30' : 'bg-gradient-to-r from-brand to-brand-blue hover:opacity-95 text-white shadow-brand/30'}`}>{appliedSuccess ? <><Check className="w-4 h-4" /><span>已同步 3D 轨迹与机位至当前分镜！</span></> : <><Sparkles className="w-4 h-4" /><span>保存 3D 机位与 MiniMax 运镜至分镜</span></>}</button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 真实人体建模（PBR + 解剖比例 + 姿态驱动）替代原火柴人
// ============================================================
function createRealisticHuman(opts: { pose: PosePreset; role: string; primaryColor: number; accentColor: number; name: string; hairColor: number }): THREE.Group {
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

function createRealisticSword(): THREE.Group {
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

function createRealisticShield(): THREE.Group {
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

function createRealisticMagicCircle(): THREE.Group {
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

function createIncenseBurner(): THREE.Group {
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

function createBattleFlag(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x2b1a0a })); pole.position.y = 1.1; g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshStandardMaterial({ color: 0x8b1a1a, side: THREE.DoubleSide, emissive: 0x441111, emissiveIntensity: 0.2 })); flag.position.set(0.45, 1.7, 0); flag.castShadow = true; g.add(flag);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), new THREE.MeshBasicMaterial({ color: 0xffd700 })); emblem.position.set(0.45, 1.7, 0.02); g.add(emblem);
  return g;
}
