// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 3D 导演节点（`director3d`）的数据模型：纯函数，不依赖 React / three。
 *
 * 节点 data 里存全部舞台状态（刷新 / 复制 / 撤销都能还原），键名沿用旧 MinimalNodes director3d、
 * CreativeCanvas 的 director_3d_stage_plan 分支、后端 engine.py 与「分镜 → 画布」一键成图用的键：
 *   framing / motion / pose / focal_length_mm / camera_roll_deg / cast_layout / speed / ai_directive /
 *   camera_prompt / minimax_camera_prompt
 * N5 追加：mannequin_pose（与分镜同结构）/ camera_state / keyframes / environment / aspect_ratio /
 *   motion_easing / export_new_node / image_url / video_url。
 *
 * 运镜提示词（`camera_prompt` 输出口）= 本地 `buildMinimaxCameraPrompt(参数)`，与 3D 片场 LIVE PROMPT 完全一致、
 * 改参数即时生效；「AI 规划」走宿主原有的 director_3d_stage_plan 分支，只用来**改参数**，提示词随之由本地重算。
 * `minimax_camera_prompt` 始终与 `camera_prompt` 同值（旧节点 / 旧读取方兼容）。
 */
import {
  CAST_LAYOUTS,
  ENV_LABELS,
  FOCAL_PRESETS,
  FRAMING_PRESETS,
  MOTION_PRESETS,
  POSE_PRESETS,
  buildMinimaxCameraPrompt,
  framingShortLabel,
  ratioToNumber,
  type Vec3Tuple,
} from '../../../director3d/scene/presets';
import type { CameraKeyframe, KeyframeEasing, StageCameraState } from '../../../director3d/scene/camera';
import type { MannequinPose, PosePreset, StageEnvironment } from '../../../../types';

export type { CameraKeyframe, KeyframeEasing, StageCameraState };

// ============================================================
// 类型
// ============================================================

export type StageEnvironmentId = 'plain' | StageEnvironment;
export type MotionSpeed = '0.5x' | '1.0x' | '1.5x' | '2.0x';
export type MotionEasingId = 'linear' | 'ease_in_out' | 'explosive' | 'slow_out';

/** 节点里的一帧运镜关键帧：scene/camera 的 CameraKeyframe + 稳定 id（列表渲染 / 排序用） */
export interface Director3DKeyframe extends CameraKeyframe {
  id: string;
}

/** `director3d` 节点 data（旧键 + N5 追加键）。 */
export interface Director3DData extends Record<string, unknown> {
  label?: string;
  // —— 旧键（不改名）——
  framing?: string;
  motion?: string;
  pose?: string;
  focal_length_mm?: number;
  camera_roll_deg?: number;
  cast_layout?: string;
  speed?: string;
  /** 自然语言导演指令（底部提示词面板；AI 规划时作为 ai_directive 下发） */
  ai_directive?: string;
  /** 输出口 camera_prompt 的值（海螺 / MiniMax 01-Director 运镜指令） */
  camera_prompt?: string;
  /** 兼容旧读取方：始终与 camera_prompt 同值 */
  minimax_camera_prompt?: string;
  // —— N5 追加 ——
  /** 布偶关节姿态（与分镜 mannequin_pose 同结构，「在 3D 片场打开」可无损带过去） */
  mannequin_pose?: MannequinPose;
  /** 用户在舞台里环绕 / 平移 / 推拉后的机位 */
  camera_state?: StageCameraState;
  keyframes?: Director3DKeyframe[];
  environment?: StageEnvironmentId;
  /** 舞台与导出画幅，如 16:9 */
  aspect_ratio?: string;
  /** 「由运镜生成关键帧」与无关键帧导出视频时用的缓动（3D 片场同名） */
  motion_easing?: MotionEasingId;
  /** 导出 PNG / MP4 后是否在旁边新建图片 / 视频节点（缺省 true，Toonflow 同款） */
  export_new_node?: boolean;
  image_url?: string;
  video_url?: string;
  /** REQ-toonflow-canvas：导出时登记的素材库 id（「保存到素材库」据此置灰，见 exportMedia.exportSavedPatch） */
  image_asset_id?: string;
  video_asset_id?: string;
}

/** 归一后的舞台参数（缺省值与旧节点 / 3D 片场一致） */
export interface StageParams {
  framing: string;
  motion: string;
  pose: PosePreset;
  castLayout: string;
  focalLength: number;
  roll: number;
  speed: MotionSpeed;
  easing: MotionEasingId;
  environment: StageEnvironmentId;
  aspectRatio: string;
  /** 宽 / 高 */
  aspect: number;
}

// ============================================================
// 选项表（与 3D 片场同源的预设直接引用 scene/presets 的同一数组）
// ============================================================

export const ASPECT_OPTIONS = ['16:9', '9:16', '4:3', '1:1'] as const;
export const SPEED_OPTIONS: readonly MotionSpeed[] = ['0.5x', '1.0x', '1.5x', '2.0x'];
export const EASING_OPTIONS: ReadonlyArray<{ id: MotionEasingId; label: string }> = [
  { id: 'ease_in_out', label: '缓入缓出' },
  { id: 'linear', label: '线性' },
  { id: 'explosive', label: '爆发' },
  { id: 'slow_out', label: '缓出' },
];
export const KEYFRAME_EASING_LABELS: Record<KeyframeEasing, string> = { linear: '线性', smooth: '平滑', cut: '硬切' };
const KEYFRAME_EASING_CYCLE: readonly KeyframeEasing[] = ['smooth', 'linear', 'cut'];

export function environmentOptions(): Array<{ id: StageEnvironmentId; label: string }> {
  return [
    { id: 'plain', label: '简洁地面' },
    ...(Object.keys(ENV_LABELS) as StageEnvironment[]).map((id) => ({ id, label: ENV_LABELS[id].label })),
  ];
}

export function environmentLabel(env: StageEnvironmentId): string {
  return env === 'plain' ? '简洁地面' : ENV_LABELS[env]?.label ?? env;
}

/** 布偶关节中文名（舞台角标显示当前拖拽的关节；_L/_R 指布偶自身左右） */
export const JOINT_LABELS: Record<string, string> = {
  waist: '腰', neck: '颈', shoulder_L: '左肩', shoulder_R: '右肩', elbow_L: '左肘', elbow_R: '右肘',
  hip_L: '左髋', hip_R: '右髋', knee_L: '左膝', knee_R: '右膝',
};
export const ENTITY_LABELS: Record<string, string> = {
  entity_protagonist: '主角', entity_antagonist: '对手', entity_supporting: '配角',
};

export const DEFAULTS = Object.freeze({
  framing: 'medium',
  motion: 'push_in',
  pose: 'stand' as PosePreset,
  castLayout: 'solo',
  focalLength: 35,
  roll: 0,
  speed: '1.0x' as MotionSpeed,
  easing: 'ease_in_out' as MotionEasingId,
  environment: 'plain' as StageEnvironmentId,
  aspectRatio: '16:9',
});

// ============================================================
// 读参数 / 运镜提示词
// ============================================================

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  const s = str(v);
  return (options as readonly string[]).includes(s) ? (s as T) : fallback;
}

function validRatio(v: unknown): string | undefined {
  const s = str(v);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!m || !(parseFloat(m[1]) > 0) || !(parseFloat(m[2]) > 0)) return undefined;
  return `${m[1]}:${m[2]}`;
}

/**
 * 从节点 data 读出舞台参数（容错：字符串数字、越界值、未知枚举都回落缺省）。
 * 景别 / 运镜 / 姿态 / 站位接受任意非空 id（导演包插件会往同源数组里追加自定义预设）。
 */
export function readStageParams(data: Record<string, unknown> | null | undefined): StageParams {
  const d = data || {};
  const focal = num(d.focal_length_mm);
  const roll = num(d.camera_roll_deg);
  const aspectRatio = validRatio(d.aspect_ratio) ?? DEFAULTS.aspectRatio;
  const envIds = ['plain', ...Object.keys(ENV_LABELS)] as StageEnvironmentId[];
  return {
    framing: str(d.framing) || DEFAULTS.framing,
    motion: str(d.motion) || DEFAULTS.motion,
    pose: (str(d.pose) || DEFAULTS.pose) as PosePreset,
    castLayout: str(d.cast_layout) || DEFAULTS.castLayout,
    focalLength: focal !== undefined && focal >= 8 && focal <= 300 ? focal : DEFAULTS.focalLength,
    roll: roll !== undefined && Math.abs(roll) <= 90 ? roll : DEFAULTS.roll,
    speed: oneOf(d.speed, SPEED_OPTIONS, DEFAULTS.speed),
    easing: oneOf(d.motion_easing, EASING_OPTIONS.map((e) => e.id), DEFAULTS.easing),
    environment: oneOf(d.environment, envIds, DEFAULTS.environment),
    aspectRatio,
    aspect: ratioToNumber(aspectRatio),
  };
}

/** REQ-toonflow-canvas 节点输出的运镜提示词：与 3D 片场 LIVE PROMPT 同一个函数（scene/presets） */
export function deriveCameraPrompt(input: Record<string, unknown> | StageParams | null | undefined): string {
  const p = isStageParams(input) ? input : readStageParams(input as Record<string, unknown>);
  return buildMinimaxCameraPrompt({
    framing: p.framing,
    motion: p.motion,
    focalLength: p.focalLength,
    cameraRoll: p.roll,
    motionSpeed: p.speed,
    castLayout: p.castLayout,
  });
}

function isStageParams(v: unknown): v is StageParams {
  return !!v && typeof v === 'object' && typeof (v as StageParams).focalLength === 'number' && typeof (v as StageParams).aspect === 'number';
}

/** camera_prompt / minimax_camera_prompt 与参数不一致时返回需要写回的补丁，否则 null（只含输出键，避免旧宿主把别的键一起往下游透传） */
export function cameraPromptPatch(data: Record<string, unknown> | null | undefined, derived = deriveCameraPrompt(data)): { camera_prompt: string; minimax_camera_prompt: string } | null {
  const d = data || {};
  if (d.camera_prompt === derived && d.minimax_camera_prompt === derived) return null;
  return { camera_prompt: derived, minimax_camera_prompt: derived };
}

/** 新建节点的默认 data（含已算好的 camera_prompt，节点未挂载时下游 / 后端也能读到） */
export function createDirector3DData(): Director3DData {
  const base: Director3DData = {
    framing: DEFAULTS.framing,
    motion: DEFAULTS.motion,
    pose: DEFAULTS.pose,
    cast_layout: DEFAULTS.castLayout,
    focal_length_mm: DEFAULTS.focalLength,
    camera_roll_deg: DEFAULTS.roll,
    speed: DEFAULTS.speed,
    environment: DEFAULTS.environment,
    aspect_ratio: DEFAULTS.aspectRatio,
    motion_easing: DEFAULTS.easing,
    keyframes: [],
    ai_directive: '',
  };
  const prompt = deriveCameraPrompt(base);
  return { ...base, camera_prompt: prompt, minimax_camera_prompt: prompt };
}

// ============================================================
// 预设选择 → data 补丁（与 3D 片场的按钮行为一致）
// ============================================================

/** 选景别：同时把焦距换成该景别的推荐焦距（3D 片场 setFraming + setFocalLength(f.fl)） */
export function framingPatch(id: string): Partial<Director3DData> {
  const fl = FRAMING_PRESETS.find((f) => f.id === id)?.fl;
  return { framing: id, ...(fl ? { focal_length_mm: fl } : {}) };
}

/** 选姿态预设：清掉自定义关节（3D 片场 handlePickPosePreset → clearCustomJoints） */
export function posePatch(id: string): Partial<Director3DData> {
  return { pose: id, mannequin_pose: undefined };
}

/** 焦距下拉的选项：常用档位 + 当前值（景别推荐焦距可能不在档位里） */
export function focalOptions(current: number): number[] {
  return [...new Set([...FOCAL_PRESETS, Math.round(current * 10) / 10])].sort((a, b) => a - b);
}

export interface PickerOption {
  id: string;
  label: string;
  desc?: string;
  group?: string;
}

export const framingOptions = (): PickerOption[] => FRAMING_PRESETS.map((f) => ({ id: f.id, label: f.label, desc: f.desc }));
export const motionOptions = (): PickerOption[] =>
  MOTION_PRESETS.map((m) => ({ id: m.id, label: m.label, desc: m.desc, group: m.category === 'combo' ? '复合运镜' : '单轴运镜' }));
export const poseOptions = (): PickerOption[] => POSE_PRESETS.map((p) => ({ id: p.id, label: p.label }));
export const castOptions = (): PickerOption[] => CAST_LAYOUTS.map((c) => ({ id: c.id, label: c.label, desc: c.desc }));

/** 选项里找不到当前值（插件预设被卸载等）时补一项，避免下拉显示空白 */
export function withCurrent(options: PickerOption[], current: string): PickerOption[] {
  return options.some((o) => o.id === current) ? options : [...options, { id: current, label: current }];
}

export function labelOf(options: PickerOption[], id: string): string {
  return options.find((o) => o.id === id)?.label ?? id;
}

/** 舞台角标：景别 · 焦距 */
export function stageBadge(p: StageParams): string {
  return `${framingShortLabel(p.framing)} · ${Math.round(p.focalLength * 10) / 10}mm`;
}

/** 舞台外框的宽高比：横画幅按原比例；竖画幅 / 方画幅限制外框高度（帧在框内等比留边） */
export function stageBoxAspect(aspect: number): number {
  return Math.max(aspect, 1.25);
}

// ============================================================
// 机位 / 关键帧
// ============================================================

const isVec3 = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

export function isValidCamera(c: unknown): c is StageCameraState {
  if (!c || typeof c !== 'object') return false;
  const s = c as StageCameraState;
  return isVec3(s.position) && isVec3(s.target) && typeof s.fov === 'number' && Number.isFinite(s.fov) && s.fov > 0
    && (s.roll === undefined || (typeof s.roll === 'number' && Number.isFinite(s.roll)));
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** 机位取 4 位小数存盘（JSON 小、diff 稳定） */
export function roundCamera(c: StageCameraState, digits = 4): StageCameraState {
  return {
    position: c.position.map((n) => round(n, digits)) as Vec3Tuple,
    target: c.target.map((n) => round(n, digits)) as Vec3Tuple,
    fov: round(c.fov, digits),
    roll: round(c.roll || 0, digits),
  };
}

export const KEYFRAME_LIMIT = 60;
/** 相邻关键帧最小间隔（秒） */
export const MIN_KEYFRAME_GAP = 0.05;
/** 「添加关键帧」默认接在上一帧之后多少秒 */
export const DEFAULT_KEYFRAME_GAP = 1;
export const MAX_KEYFRAME_DURATION = 300;

let kfSeq = 0;
export function newKeyframeId(): string {
  kfSeq = (kfSeq + 1) % 1e6;
  return `kf_${Date.now().toString(36)}${kfSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const isEasing = (v: unknown): v is KeyframeEasing => v === 'linear' || v === 'smooth' || v === 'cut';

/** 读 data.keyframes：丢坏帧、按时间排序、补 id / easing（缺 id 时用确定性 id，保证多次读取一致） */
export function readKeyframes(raw: unknown): Director3DKeyframe[] {
  if (!Array.isArray(raw)) return [];
  const out: Director3DKeyframe[] = [];
  raw.forEach((k, i) => {
    if (!k || typeof k !== 'object') return;
    const kf = k as Partial<Director3DKeyframe>;
    const time = num(kf.time);
    if (time === undefined || time < 0 || !isValidCamera(kf.camera)) return;
    out.push({
      id: typeof kf.id === 'string' && kf.id ? kf.id : `kf_${i}`,
      time,
      camera: kf.camera,
      easing: isEasing(kf.easing) ? kf.easing : 'smooth',
    });
  });
  return out.sort((a, b) => a.time - b.time);
}

export function keyframesDuration(list: readonly CameraKeyframe[]): number {
  return list.length ? list[list.length - 1].time : 0;
}

const t2 = (n: number) => round(n, 2);

/** 末尾追加一帧（时间 = 上一帧 + gap；第一帧为 0） */
export function appendKeyframe(
  list: readonly Director3DKeyframe[],
  camera: StageCameraState,
  opts: { gap?: number; easing?: KeyframeEasing; id?: string } = {},
): Director3DKeyframe[] {
  if (list.length >= KEYFRAME_LIMIT) return [...list];
  const time = list.length ? t2(Math.min(MAX_KEYFRAME_DURATION, keyframesDuration(list) + (opts.gap ?? DEFAULT_KEYFRAME_GAP))) : 0;
  if (list.length && time <= keyframesDuration(list)) return [...list];
  return [...list, { id: opts.id ?? newKeyframeId(), time, camera: roundCamera(camera), easing: opts.easing ?? 'smooth' }];
}

/** 删除一帧；删掉首帧时整体前移，让时间轴始终从 0 开始 */
export function removeKeyframe(list: readonly Director3DKeyframe[], id: string): Director3DKeyframe[] {
  const next = list.filter((k) => k.id !== id);
  const shift = next.length ? next[0].time : 0;
  return shift > 0 ? next.map((k) => ({ ...k, time: t2(k.time - shift) })) : next;
}

/** 调整顺序：机位与缓动跟着移动，时间留在原位（时间列始终递增，Toonflow 拖动排序同义） */
export function moveKeyframe(list: readonly Director3DKeyframe[], from: number, to: number): Director3DKeyframe[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const slots = list.map((k) => k.time);
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next.map((k, i) => ({ ...k, time: slots[i] }));
}

/** 改某帧时间：夹在相邻两帧之间（保持严格递增） */
export function retimeKeyframe(list: readonly Director3DKeyframe[], id: string, time: number): Director3DKeyframe[] {
  const i = list.findIndex((k) => k.id === id);
  if (i < 0 || !Number.isFinite(time)) return [...list];
  const lo = i === 0 ? 0 : list[i - 1].time + MIN_KEYFRAME_GAP;
  const hi = i === list.length - 1 ? MAX_KEYFRAME_DURATION : list[i + 1].time - MIN_KEYFRAME_GAP;
  const clamped = t2(Math.min(Math.max(time, lo), Math.max(lo, hi)));
  return list.map((k, j) => (j === i ? { ...k, time: clamped } : k));
}

export function setKeyframeEasing(list: readonly Director3DKeyframe[], id: string, easing: KeyframeEasing): Director3DKeyframe[] {
  return list.map((k) => (k.id === id ? { ...k, easing } : k));
}

/** 缓动按钮循环：平滑 → 线性 → 硬切 → 平滑 */
export function nextKeyframeEasing(e: KeyframeEasing | undefined): KeyframeEasing {
  const i = KEYFRAME_EASING_CYCLE.indexOf(e ?? 'smooth');
  return KEYFRAME_EASING_CYCLE[(i + 1) % KEYFRAME_EASING_CYCLE.length];
}

export function replaceKeyframeCamera(list: readonly Director3DKeyframe[], id: string, camera: StageCameraState): Director3DKeyframe[] {
  return list.map((k) => (k.id === id ? { ...k, camera: roundCamera(camera) } : k));
}

/** 改总时长：按比例缩放所有帧时间（首帧固定 0，相邻帧至少隔 MIN_KEYFRAME_GAP） */
export function scaleKeyframesDuration(list: readonly Director3DKeyframe[], duration: number): Director3DKeyframe[] {
  const total = keyframesDuration(list);
  if (list.length < 2 || !(total > 0) || !Number.isFinite(duration)) return [...list];
  const minTotal = MIN_KEYFRAME_GAP * (list.length - 1);
  const target = Math.min(MAX_KEYFRAME_DURATION, Math.max(minTotal, duration));
  const f = target / total;
  let prev = -Infinity;
  return list.map((k, i) => {
    let t = i === 0 ? 0 : t2(k.time * f);
    if (i > 0 && t < prev + MIN_KEYFRAME_GAP) t = t2(prev + MIN_KEYFRAME_GAP);
    prev = t;
    return { ...k, time: t };
  });
}

const SHAKE_MOTIONS = new Set(['shake', 'fast_push_shake']);
const CURVED_MOTIONS = new Set(['orbit', 'orbit_ccw', 'orbit_boom_up', 'pan_left_crane_down', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down']);

/**
 * 「由运镜生成关键帧」的采样段数：直线类运镜 + 线性/缓入缓出只要首尾两帧（缓入缓出用「平滑」插值表达）；
 * 弧线 / 摇移类 8 段；震颤类 16 段；其余缓动（爆发 / 缓出）6 段把缓动烘进采样点。
 */
export function motionKeyframeSamples(motion: string, easing: MotionEasingId): number {
  if (SHAKE_MOTIONS.has(motion)) return 16;
  if (CURVED_MOTIONS.has(motion)) return 8;
  return easing === 'linear' || easing === 'ease_in_out' ? 1 : 6;
}

/** motionPresetKeyframes 结果 → 节点关键帧（取整、补 id；两帧时把缓入缓出落成「平滑」） */
export function presetToKeyframes(frames: readonly CameraKeyframe[], easing: MotionEasingId): Director3DKeyframe[] {
  const two = frames.length === 2;
  return frames.map((f, i) => ({
    id: newKeyframeId(),
    time: t2(f.time),
    camera: roundCamera(f.camera),
    easing: two && i === 1 && easing === 'ease_in_out' ? 'smooth' : (f.easing ?? 'linear'),
  }));
}

/** AI 规划前后参数差异的中文摘要（提示条用），无变化返回空串 */
export function describeParamChanges(before: StageParams, after: StageParams): string {
  const parts: string[] = [];
  const label = (opts: PickerOption[], id: string) => labelOf(opts, id);
  if (before.framing !== after.framing) parts.push(`景别 ${label(framingOptions(), before.framing)} → ${label(framingOptions(), after.framing)}`);
  if (before.motion !== after.motion) parts.push(`运镜 ${label(motionOptions(), before.motion)} → ${label(motionOptions(), after.motion)}`);
  if (before.pose !== after.pose) parts.push(`姿态 ${label(poseOptions(), before.pose)} → ${label(poseOptions(), after.pose)}`);
  if (before.castLayout !== after.castLayout) parts.push(`站位 ${label(castOptions(), before.castLayout)} → ${label(castOptions(), after.castLayout)}`);
  if (before.focalLength !== after.focalLength) parts.push(`焦距 ${before.focalLength} → ${after.focalLength}mm`);
  if (before.roll !== after.roll) parts.push(`荷兰角 ${before.roll} → ${after.roll}°`);
  if (before.speed !== after.speed) parts.push(`速度 ${before.speed} → ${after.speed}`);
  return parts.join('，');
}

/** director_3d_stage_plan 返回的 parse_mode → 中文 */
export const PARSE_MODE_LABELS: Record<string, string> = { llm: '大模型解析', keyword: '关键词匹配', explicit: '未解析指令' };

// ============================================================
// 「在 3D 片场打开」/ 导出新节点
// ============================================================

export interface MinimalEdge { source: string; target: string }
export interface MinimalNode { id: string; type?: string; data?: Record<string, unknown> }

/** 节点关联的分镜：自身 shotId，否则下游第一个带 shotId 的节点（「分镜 → 画布」把 shotId 记在视频节点上） */
export function findShotId(nodeId: string, data: Record<string, unknown>, edges: readonly MinimalEdge[], getNode: (id: string) => MinimalNode | undefined): string | undefined {
  const own = str(data.shotId) || str(data.shot_id);
  if (own) return own;
  for (const e of edges) {
    if (e.source !== nodeId) continue;
    const t = getNode(e.target)?.data || {};
    const sid = str(t.shotId) || str(t.shot_id);
    if (sid) return sid;
  }
  return undefined;
}

/**
 * REQ-toonflow-canvas「在 3D 片场打开」的跳转载荷。
 * 3D 片场目前只跟随 useProjectStore.activeShotId 读分镜字段（不读载荷），所以：
 * - shotId：宿主可先 setActiveShotId(shotId) 再切页；
 * - shotPatch：分镜同名字段（camera_framing / camera_motion / pose_preset / … / mannequin_pose），宿主可 updateShot 后再切页；
 * - stage：节点原始舞台状态（含关键帧 / 机位 / 环境），留给页面以后直接接收。
 */
export function buildNavigatePayload(nodeId: string, data: Director3DData, shotId?: string) {
  const p = readStageParams(data);
  const mannequinPose = data.mannequin_pose && typeof data.mannequin_pose === 'object' ? data.mannequin_pose : undefined;
  return {
    source: 'canvas-director3d',
    nodeId,
    ...(shotId ? { shotId } : {}),
    shotPatch: {
      camera_framing: p.framing,
      camera_motion: p.motion,
      pose_preset: p.pose,
      cast_layout: p.castLayout,
      focal_length_mm: p.focalLength,
      camera_roll_deg: p.roll,
      motion_speed: p.speed,
      ...(mannequinPose ? { mannequin_pose: mannequinPose } : {}),
    },
    stage: {
      framing: p.framing,
      motion: p.motion,
      pose: p.pose,
      cast_layout: p.castLayout,
      focal_length_mm: p.focalLength,
      camera_roll_deg: p.roll,
      speed: p.speed,
      motion_easing: p.easing,
      environment: p.environment,
      aspect_ratio: p.aspectRatio,
      ...(mannequinPose ? { mannequin_pose: mannequinPose } : {}),
      ...(isValidCamera(data.camera_state) ? { camera_state: data.camera_state } : {}),
      keyframes: readKeyframes(data.keyframes),
      camera_prompt: deriveCameraPrompt(p),
    },
  };
}

/** 导出文件名（ASCII，后端按扩展名落盘）与素材名 */
export function exportNames(label: string | undefined, kind: 'image' | 'video', now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const title = (label || '3D 导演').trim() || '3D 导演';
  return {
    fileBase: `director3d_${stamp}`,
    assetName: `${title} · ${kind === 'image' ? '机位截图' : '运镜预演'} ${stamp}`,
    nodeLabel: `${title} · ${kind === 'image' ? '截图' : '运镜'}`,
  };
}
