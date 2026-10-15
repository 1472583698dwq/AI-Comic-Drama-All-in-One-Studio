// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · 3D 导演预设同源模块（纯数据 + 纯函数，不依赖 three / React）。
 *
 * 3D 片场（Director3DStage）、画布 `director3d` 节点（N5）、分镜参考装配（shotReference）共用这一份：
 * 景别 / 运镜 / 姿态 / 站位预设、镜头焦距档位、景别 → 机位表、运镜时长与缓动、海螺运镜提示词。
 *
 * 原 `../directorPresets.ts` 的内容整体迁入此处；旧路径保留 re-export，既有 import 不受影响。
 * 预设数组是**可变的同源数组**：`directorPackSpecs.applyDirectorPackPresets()` 会把插件导演包的
 * 预设 push 进来（舞台与画布节点读同一个数组实例，所以两边显示一致），不要在别处复制一份。
 */
import type { CameraFraming, CameraMotion, PosePreset, CastLayout, StageEnvironment } from '../../../types';

export type Vec3Tuple = [number, number, number];

// ============================================================
// 景别 / 运镜 / 姿态 / 站位（同源数组，原 directorPresets.ts）
// ============================================================

export const FRAMING_PRESETS: Array<{ id: CameraFraming; label: string; fl: number; desc: string }> = [
  { id: 'extreme_close_up', label: '大特写 (ECU)', fl: 85, desc: '眼神/微表情震撼特写' },
  { id: 'close_up', label: '特写 (CU)', fl: 50, desc: '面部与半身情绪聚焦' },
  { id: 'medium', label: '中景 (MS)', fl: 35, desc: '胸部以上经典叙事' },
  { id: 'full', label: '全景 (FS)', fl: 28, desc: '全身与站位动作展示' },
  { id: 'long', label: '远景 (LS)', fl: 24, desc: '宏大环境与场景纵深' },
  { id: 'bird_eye', label: '鸟瞰俯冲', fl: 20, desc: '高空俯视压迫视角' },
  { id: 'low_angle', label: '贴地仰角', fl: 28, desc: '低机位霸气英雄感' },
  { id: 'over_shoulder', label: '过肩对峙', fl: 40, desc: '双人对决纵深机位' },
  { id: 'dutch_angle', label: '荷兰角倾斜', fl: 32, desc: '悬疑与心理压迫' },
  { id: 'high_angle', label: '高角度俯视', fl: 28, desc: '俯视弱化视点' },
];

export const MOTION_PRESETS: Array<{
  id: CameraMotion;
  label: string;
  category: 'single' | 'combo';
  desc: string;
  minimaxCode: string;
}> = [
  { id: 'static', label: '固定镜头 (Static)', category: 'single', desc: '机位静止固定', minimaxCode: 'Static Camera' },
  { id: 'push_in', label: '急进推镜 (Dolly In)', category: 'single', desc: '镜头逼近主角', minimaxCode: 'Dolly In' },
  { id: 'pull_out', label: '渐远拉出 (Dolly Out)', category: 'single', desc: '由近及远展示环境', minimaxCode: 'Dolly Out' },
  { id: 'pan_left', label: '左摇镜头 (Pan Left)', category: 'single', desc: '水平向左平滑扫视', minimaxCode: 'Pan Left' },
  { id: 'pan_right', label: '右摇镜头 (Pan Right)', category: 'single', desc: '水平向右平滑扫视', minimaxCode: 'Pan Right' },
  { id: 'tilt_up', label: '上仰升镜 (Tilt Up)', category: 'single', desc: '由下向上仰视扫视', minimaxCode: 'Tilt Up' },
  { id: 'tilt_down', label: '下俯摇镜 (Tilt Down)', category: 'single', desc: '由上向下俯视扫视', minimaxCode: 'Tilt Down' },
  { id: 'orbit', label: '360° 顺时针环绕 (Orbit)', category: 'single', desc: '英雄弧形环拍', minimaxCode: 'Orbit Clockwise' },
  { id: 'orbit_ccw', label: '逆时针环绕 (Orbit CCW)', category: 'single', desc: '逆向弧形环拍', minimaxCode: 'Orbit Counter-Clockwise' },
  { id: 'truck_left', label: '左横移 (Truck Left)', category: 'single', desc: '机位平行向左平移', minimaxCode: 'Truck Left' },
  { id: 'truck_right', label: '右横移 (Truck Right)', category: 'single', desc: '机位平行向右平移', minimaxCode: 'Truck Right' },
  { id: 'boom_up', label: '升降机升 (Boom Up)', category: 'single', desc: '垂直升起镜头', minimaxCode: 'Boom Up' },
  { id: 'boom_down', label: '升降机降 (Boom Down)', category: 'single', desc: '垂直下降镜头', minimaxCode: 'Boom Down' },
  { id: 'roll_left', label: '左滚转 (Roll Left)', category: 'single', desc: '镜头逆时针翻滚', minimaxCode: 'Roll Left' },
  { id: 'roll_right', label: '右滚转 (Roll Right)', category: 'single', desc: '镜头顺时针翻滚', minimaxCode: 'Roll Right' },
  { id: 'tracking', label: '前向跟随 (Tracking)', category: 'single', desc: '跟随主体向前推进', minimaxCode: 'Forward Tracking' },
  { id: 'shake', label: '战斗震颤 (Shake)', category: 'single', desc: '冲击感手持震动', minimaxCode: 'Handheld Camera Shake' },
  { id: 'dolly_zoom', label: '希区柯克变焦 (Vertigo Zoom)', category: 'combo', desc: '推镜反向变焦，空间扭曲', minimaxCode: 'Dolly Zoom (Vertigo)' },
  { id: 'orbit_boom_up', label: '弧旋升镜 (Orbit + Boom Up)', category: 'combo', desc: '环绕+垂直升起，英雄登场', minimaxCode: 'Orbit + Boom Up' },
  { id: 'pan_left_crane_down', label: '全景俯切 (Pan Left + Crane Down)', category: 'combo', desc: '左扫同时俯冲，战场切入', minimaxCode: 'Pan Left + Crane Down' },
  { id: 'fast_push_shake', label: '极速推镜+冲击 (Explosive Push)', category: 'combo', desc: '爆点推进带震颤，招式命中', minimaxCode: 'Explosive Push + Shake' },
  { id: 'low_angle_truck_right', label: '贴地侧滑 (Low Truck Right)', category: 'combo', desc: '低机位右横移，霸气侧身', minimaxCode: 'Low Angle + Truck Right' },
];

export const POSE_PRESETS: Array<{ id: PosePreset; label: string; icon: string }> = [
  { id: 'stand', label: '傲然站立', icon: '🧍' },
  { id: 'fight', label: '武道架势', icon: '🥋' },
  { id: 'look_back', label: '回眸凝视', icon: '👀' },
  { id: 'run', label: '极速突进', icon: '🏃' },
  { id: 'cast_spell', label: '御剑施法', icon: '⚡' },
  { id: 'kneel', label: '受创半跪', icon: '🧎' },
  { id: 'defend', label: '横刀格挡', icon: '🛡️' },
  { id: 'fly', label: '凌空御风', icon: '🦅' },
  { id: 'injured', label: '战损踉跄', icon: '💥' },
];

export const CAST_LAYOUTS: Array<{ id: CastLayout; label: string; desc: string }> = [
  { id: 'solo', label: '单人焦点', desc: '主角独奏，聚焦核心' },
  { id: 'duel', label: '双人对峙', desc: '主角 VS 宿敌双向对抗' },
  { id: 'ots', label: '过肩纵深', desc: '前景肩景 + 背景对手' },
  { id: 'surrounded', label: '群戏包围', desc: '四方包围阵形' },
];

/** 景别/运镜 id → 中文短标签（画布节点非选中态展示用，与舞台同源） */
export function framingShortLabel(id?: string): string {
  return FRAMING_PRESETS.find((f) => f.id === id)?.label || id || '中景 (MS)';
}

export function motionShortLabel(id?: string): string {
  return MOTION_PRESETS.find((m) => m.id === id)?.label || id || '急进推镜 (Dolly In)';
}

// ============================================================
// 舞台光学 / 灯光 / 环境标签（原 Director3DStage 模块级常量）
// ============================================================

/** 舞台私有的焦距档位（mm） */
export const FOCAL_PRESETS = [16, 24, 35, 50, 85, 135];

export type KeyTemp = 'neon' | 'cold' | 'warm' | 'moon';

/** 基础三点光色温预设（主光颜色，轮廓光保持冷色勾边） */
export const KEY_TEMPS: Record<string, { label: string; color: number }> = {
  neon: { label: '霓虹紫', color: 0x7c3aed },
  cold: { label: '冷白', color: 0xf5f7ff },
  warm: { label: '暖黄', color: 0xffb46b },
  moon: { label: '月夜蓝', color: 0x9bbcff },
};

export const ENV_LABELS: Record<StageEnvironment, { label: string; desc: string; icon: string }> = {
  cyber_studio: { label: '暗黑赛博影棚', desc: '霓虹网格+城市天际线', icon: '🏙️' },
  xianxia_cloud: { label: '修仙云海仙山', desc: '浮空山+云雾缭绕', icon: '⛰️' },
  desert_battle: { label: '决战古荒漠', desc: '沙丘+落日+岩石', icon: '🏜️' },
  neon_city: { label: '雨夜霓虹都市', desc: '湿漉街道+雨滴反射', icon: '🌃' },
};

/** "9:16" / "16/9" → 数值宽高比；非法回退 9:16。 */
export const ratioToNumber = (ratio?: string): number => {
  const m = String(ratio || '').match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]) / parseFloat(m[2]);
    if (isFinite(n) && n > 0) return n;
  }
  return 9 / 16;
};

// ============================================================
// 景别 → 虚拟摄影机机位（原 updateVirtualCameraOptics 内的 switch）
// ============================================================

/** 全画幅竖向感光高度（mm），焦距 → 垂直视场角换算用 */
export const SENSOR_HEIGHT_MM = 24;

/** 焦距（mm）→ 垂直 FOV（度），钳制在 [12, 105]，与 3D 片场监视器一致 */
export function focalLengthToFov(focalLengthMm: number, sensorHeightMm = SENSOR_HEIGHT_MM): number {
  const fovCalculated = 2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)) * (180 / Math.PI);
  return Math.max(12, Math.min(105, fovCalculated));
}

export interface CameraPoseTuple {
  position: Vec3Tuple;
  target: Vec3Tuple;
}

/** 未知景别（含插件导演包自定义景别）回落到这个机位 */
export const DEFAULT_FRAMING_POSE: CameraPoseTuple = { position: [0, 1.3, 2.5], target: [0, 1.25, 0] };

/** REQ-toonflow-canvas 景别 → 机位（主角站在原点、面朝 +z；与 3D 片场监视器同一张表） */
export const FRAMING_CAMERA_POSES: Record<CameraFraming, CameraPoseTuple> = {
  extreme_close_up: { position: [0, 1.68, 0.75], target: [0, 1.68, 0] },
  close_up: { position: [0, 1.55, 1.35], target: [0, 1.5, 0] },
  medium: { position: [0, 1.3, 2.4], target: [0, 1.25, 0] },
  full: { position: [0, 1.15, 3.8], target: [0, 1.0, 0] },
  long: { position: [0, 1.6, 6.0], target: [0, 1.1, 0] },
  bird_eye: { position: [0, 4.5, 2.0], target: [0, 0.5, 0] },
  low_angle: { position: [0, 0.25, 1.8], target: [0, 1.5, 0] },
  over_shoulder: { position: [0.55, 1.55, 1.8], target: [-0.2, 1.4, -1.2] },
  dutch_angle: { position: [0, 1.2, 2.2], target: [0, 1.25, 0] },
  high_angle: { position: [0, 2.8, 2.8], target: [0, 1.0, 0] },
};

/** 景别 id → 机位（返回新数组，可放心修改） */
export function framingCameraPose(framing?: string): CameraPoseTuple {
  const p = (framing && (FRAMING_CAMERA_POSES as Record<string, CameraPoseTuple>)[framing]) || DEFAULT_FRAMING_POSE;
  return { position: [...p.position] as Vec3Tuple, target: [...p.target] as Vec3Tuple };
}

// ============================================================
// 运镜时长 / 缓动（原 handleToggleSimulation / recordSecsRefValue）
// ============================================================

export type MotionSpeed = '0.5x' | '1.0x' | '1.5x' | '2.0x';
export type MotionEasing = 'linear' | 'ease_in_out' | 'explosive' | 'slow_out';

/** 运镜模拟时长（毫秒）：3D 片场预演 / 录制 / 白模导出共用 */
export function motionDurationMs(speed?: string): number {
  return speed === '0.5x' ? 4500 : speed === '1.5x' ? 1800 : speed === '2.0x' ? 1200 : 2500;
}

/** 线性进度 [0,1] → 缓动后进度 */
export function easeMotionProgress(progress: number, easing?: string): number {
  if (easing === 'ease_in_out') return 0.5 * (1 - Math.cos(Math.PI * progress));
  if (easing === 'explosive') return Math.pow(progress, 0.4);
  if (easing === 'slow_out') return Math.sin((progress * Math.PI) / 2);
  return progress;
}

/** 运镜模拟期间摄影机注视点（主角胸口） */
export const MOTION_LOOK_AT: Vec3Tuple = [0, 1.25, 0];

// ============================================================
// 海螺 / MiniMax 运镜提示词（原 minimaxPromptPreview）
// ============================================================

export interface CameraPromptInput {
  framing: string;
  motion: string;
  focalLength: number;
  /** 荷兰角（度），|roll| ≤ 0.5 不输出 */
  cameraRoll?: number;
  motionSpeed?: string;
  castLayout?: string;
}

/**
 * REQ-toonflow-canvas 输出 MiniMax 01-Director / 海螺规范的运镜指令 `[Camera: …]`。
 * 3D 片场「LIVE PROMPT」与画布 director3d 节点 `camera_prompt` 输出共用（同一份预设表取 minimaxCode/label）。
 */
export function buildMinimaxCameraPrompt(input: CameraPromptInput): string {
  const { framing, motion, focalLength } = input;
  const cameraRoll = input.cameraRoll ?? 0;
  const motionSpeed = input.motionSpeed ?? '1.0x';
  const castLayout = input.castLayout ?? 'solo';
  const framingObj = FRAMING_PRESETS.find((f) => f.id === framing);
  const motionObj = MOTION_PRESETS.find((m) => m.id === motion);
  const parts = [`Motion: ${motionObj?.minimaxCode || motion}`, `Framing: ${framingObj?.label || framing}`, `Lens: ${focalLength}mm`];
  if (Math.abs(cameraRoll) > 0.5) parts.push(`Dutch Roll: ${cameraRoll > 0 ? '+' : ''}${cameraRoll.toFixed(1)}°`);
  if (motionSpeed !== '1.0x') parts.push(`Speed: ${motionSpeed}`);
  if (castLayout !== 'solo') parts.push(`Cast Staging: ${castLayout.toUpperCase()}`);
  return `[Camera: ${parts.join(', ')}]`;
}

export interface ClayPromptInput {
  framing: string;
  motion: string;
  focalLength: number;
  cameraRoll: number;
  motionSpeed: string;
  /** 项目画幅文本，如 "9:16" */
  aspect: string;
  /** 视频时长（秒） */
  secs: number;
  /** 主角走位路径点 */
  waypoints?: Array<{ x: number; z: number }>;
}

/** 白模导出（Clay Pass → Seedance 参考视频）的结构化提示词（原 buildClayPrompt） */
export function buildClayPrompt(input: ClayPromptInput): string {
  const { framing, motion, focalLength, cameraRoll, motionSpeed, aspect, secs } = input;
  const framingLabel = FRAMING_PRESETS.find((f) => f.id === framing)?.label || framing;
  const motionLabel = MOTION_PRESETS.find((m) => m.id === motion)?.label || motion;
  const wp = input.waypoints || [];
  const lines = [
    '参考 @video1 的运镜、构图、景别、空间关系、主体轨迹与镜头节奏（@video1 为白模调度参考，忽略其灰色材质与光照，不要复制它的外观）。',
    '将白模渲染为：<在此填写目标风格/材质/光照/氛围，或引用 @image1 的角色外形与 @image2 的场景>。',
    `镜头：${framingLabel}，焦距 ${focalLength}mm${Math.abs(cameraRoll) > 0.5 ? `，荷兰角 ${cameraRoll > 0 ? '+' : ''}${cameraRoll.toFixed(1)}°` : ''}；运镜：${motionLabel}（${motionSpeed}）；时长约 ${secs.toFixed(1)}s；画幅 ${aspect}。`,
    wp.length ? `主角走位：${wp.map((w, i) => `P${i + 1}(${w.x.toFixed(1)},${w.z.toFixed(1)})`).join(' → ')}。` : '',
    '约束：单镜头连贯无剪辑；保持主体位置、镜头路径与节奏不变，不要重复描述运镜。',
  ];
  return lines.filter(Boolean).join('\n');
}

// ============================================================
// 站位（blocking）：站位预设 → 上场角色及默认摆位（原角色重建 effect）
// ============================================================

export type MannequinRole = 'protagonist' | 'antagonist' | 'supporting';

/** 角色识别色（布偶腰带 / 脚底光环） */
export const ROLE_ACCENT_COLORS: Record<MannequinRole, number> = {
  protagonist: 0x00d2ff,
  antagonist: 0xff3b30,
  supporting: 0x60a5fa,
};

export interface CastMemberSpec {
  /** 场景内实体名（选中/摆位/关节姿态持久化的 key），如 `entity_protagonist` */
  entity: string;
  role: MannequinRole;
  pose: PosePreset;
  accentColor: number;
  /** 默认摆位（没有用户保存的摆位时使用） */
  position: Vec3Tuple;
  /** 默认朝向（绕 Y，弧度）；undefined = 不改朝向 */
  rotationY?: number;
}

/**
 * REQ-toonflow-canvas 站位预设 → 上场角色（顺序即入场顺序：主角 → 对手 → 配角）。
 * 主角姿态 = 当前姿态预设；对手在主角「武道架势」时同样摆架势，否则站立；配角恒为架势。
 */
export function castMembers(castLayout: string, pose: PosePreset): CastMemberSpec[] {
  const out: CastMemberSpec[] = [
    { entity: 'entity_protagonist', role: 'protagonist', pose, accentColor: ROLE_ACCENT_COLORS.protagonist, position: [0, 0, 0] },
  ];
  if (castLayout === 'duel' || castLayout === 'ots' || castLayout === 'surrounded') {
    const antagonistPose: PosePreset = pose === 'fight' ? 'fight' : 'stand';
    const base = { entity: 'entity_antagonist', role: 'antagonist' as const, pose: antagonistPose, accentColor: ROLE_ACCENT_COLORS.antagonist };
    if (castLayout === 'duel') out.push({ ...base, position: [0, 0, -2.3], rotationY: Math.PI });
    else if (castLayout === 'ots') out.push({ ...base, position: [-0.35, 0, -2.5], rotationY: Math.PI * 0.9 });
    else out.push({ ...base, position: [1.9, 0, -1.2], rotationY: -Math.PI * 0.6 });
  }
  if (castLayout === 'surrounded') {
    out.push({ entity: 'entity_supporting', role: 'supporting', pose: 'fight', accentColor: ROLE_ACCENT_COLORS.supporting, position: [-1.9, 0, -1.2], rotationY: Math.PI * 0.6 });
  }
  return out;
}
