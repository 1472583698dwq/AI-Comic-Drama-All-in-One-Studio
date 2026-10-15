// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频生成节点的参数与模式（纯函数，无 React 依赖）。
 *
 * Toonflow videoGenerationNode/generationSettings 的「快捷参数」（生成模式 / 时长 / 分辨率 / 通用比例 / 生成音频）
 * 在 MiniMax 里没有 durationResolutionMap，改为从所选生成源的 params_schema 推出：
 *   - 时长：duration 的 enum，或 minimum..maximum 的整数；
 *   - 分辨率：resolution 的 enum；
 *   - 比例：aspect_ratio / ratio / aspect（Toonflow 通用比例 16:9/9:16/1:1/4:3/3:4，缺省 9:16；生成源声明了 enum 时不在其中的置灰，多出来的值追加在后）；
 *   - 生成音频：generate_audio 等布尔参数（同 Toonflow model.audio === 'optional'）。
 * 参数值统一存 data.params（并镜像 provider_params，保持 nodeAgentExecutor.buildAgentArgs 读取一致）。
 */
import type { GenMode, RefItem } from '../../kit/types';
import { autoMode, availableModes, normalizeVideoMode, resolveSlotCaps, type SlotSpec } from '../../kit/assembleInputs';
import { isEmptyParam, materializeParams } from '../../kit/paramDefaults';

/** Toonflow 通用比例（videoGenerationNode ratioOptions）。 */
export const RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export const DEFAULT_RATIO = '9:16';

const RATIO_KEYS = ['aspect_ratio', 'ratio', 'aspect'];
const DURATION_KEYS = ['duration', 'video_duration', 'seconds'];
const RESOLUTION_KEYS = ['resolution'];
const AUDIO_KEYS = ['generate_audio', 'with_audio', 'enable_audio', 'sound', 'audio'];

/** 后端 engine.py 视频分支优先读节点顶层的这些键（再读 params），参数变化时同步镜像，避免旧顶层值覆盖新参数。 */
export const ENGINE_TOP_LEVEL_KEYS = ['duration', 'resolution', 'aspect_ratio', 'fps', 'seed', 'model', 'workflow_id', 'steps', 'cfg'] as const;

export interface ProviderDefLike {
  params_schema?: { properties?: Record<string, any>; required?: string[] } | null;
  default_params?: Record<string, unknown> | null;
  input_schema?: { properties?: Record<string, any> } | null;
}

export type ParamValue = string | number | boolean;

export interface RatioOption {
  value: string;
  /** 生成源声明了比例枚举且不含该值时为 false（置灰）。 */
  supported: boolean;
}

export interface QuickParams {
  /** 比例写入的参数键（生成源声明的 aspect_ratio/ratio/aspect；未声明时用 aspect_ratio，同 Toonflow 总是下发比例）。 */
  ratioKey: string;
  ratioDeclared: boolean;
  ratioOptions: RatioOption[];
  durationKey?: string;
  durationOptions: ParamValue[];
  resolutionKey?: string;
  resolutionOptions: ParamValue[];
  /** 生成音频开关对应的布尔参数键。 */
  audioKey?: string;
}

function propsOf(def: ProviderDefLike | null | undefined): Record<string, any> {
  const p = def?.params_schema?.properties;
  return p && typeof p === 'object' ? p : {};
}

function firstKey(props: Record<string, any>, keys: readonly string[], pred?: (spec: any) => boolean): string | undefined {
  return keys.find((k) => props[k] && typeof props[k] === 'object' && (!pred || pred(props[k])));
}

function enumOf(spec: any): ParamValue[] {
  return Array.isArray(spec?.enum) ? spec.enum.filter((v: unknown) => ['string', 'number', 'boolean'].includes(typeof v)) : [];
}

/** 由 params_schema 推出快捷参数（未选生成源时：只有通用比例）。 */
export function quickParamsOf(def: ProviderDefLike | null | undefined): QuickParams {
  const props = propsOf(def);
  const ratioKey = firstKey(props, RATIO_KEYS);
  const ratioEnum = ratioKey ? enumOf(props[ratioKey]).map(String) : [];
  const ratioOptions: RatioOption[] = RATIO_OPTIONS.map((value) => ({ value, supported: !ratioEnum.length || ratioEnum.includes(value) }));
  for (const v of ratioEnum) if (!RATIO_OPTIONS.includes(v as (typeof RATIO_OPTIONS)[number])) ratioOptions.push({ value: v, supported: true });

  const durationKey = firstKey(props, DURATION_KEYS);
  let durationOptions: ParamValue[] = [];
  if (durationKey) {
    const spec = props[durationKey];
    const en = enumOf(spec);
    if (en.length) durationOptions = en;
    else if ((spec.type === 'integer' || spec.type === 'number') && Number.isFinite(spec.minimum) && Number.isFinite(spec.maximum)) {
      const lo = Math.ceil(Number(spec.minimum));
      const hi = Math.floor(Number(spec.maximum));
      for (let v = lo; v <= hi && durationOptions.length < 60; v++) durationOptions.push(v);
    }
  }
  const resolutionKey = firstKey(props, RESOLUTION_KEYS);
  const resolutionOptions = resolutionKey ? enumOf(props[resolutionKey]) : [];
  const audioKey = firstKey(props, AUDIO_KEYS, (s) => s.type === 'boolean' || s['x-control'] === 'toggle');

  return {
    ratioKey: ratioKey ?? 'aspect_ratio',
    ratioDeclared: !!ratioKey,
    ratioOptions,
    durationKey: durationOptions.length ? durationKey : undefined,
    durationOptions,
    resolutionKey: resolutionOptions.length ? resolutionKey : undefined,
    resolutionOptions,
    audioKey,
  };
}

/** 快捷参数已占用的键（参数弹层「其他参数」列表里不再重复显示）。 */
export function quickParamKeys(q: QuickParams): string[] {
  return [q.ratioDeclared ? q.ratioKey : '', q.durationKey ?? '', q.resolutionKey ?? '', q.audioKey ?? ''].filter(Boolean);
}

/** 生成源的缺省参数：params_schema 各项 default + default_params（同 NodeAgentConsole.selectProvider）。 */
export function schemaDefaults(def: ProviderDefLike | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(propsOf(def))) {
    if (spec && typeof spec === 'object' && spec.default !== undefined) out[k] = spec.default;
  }
  return { ...out, ...(def?.default_params && typeof def.default_params === 'object' ? def.default_params : {}) };
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (a !== undefined && b !== undefined && String(a) === String(b));
}

/** 切换生成源：新源缺省参数 + 沿用旧值里对新源仍合法的快捷参数（Toonflow 切模型时保留比例 / 合法时长）。 */
export function carryOverParams(prev: Record<string, unknown> | null | undefined, def: ProviderDefLike | null | undefined): Record<string, unknown> {
  const next = schemaDefaults(def);
  const old = prev || {};
  const q = quickParamsOf(def);
  const oldRatio = [...RATIO_KEYS].map((k) => old[k]).find((v) => v !== undefined && v !== '');
  if (oldRatio !== undefined) {
    const opt = q.ratioOptions.find((o) => o.value === String(oldRatio));
    if (opt?.supported) next[q.ratioKey] = opt.value;
  }
  const keep = (key: string | undefined, options: ParamValue[]) => {
    if (!key) return;
    const v = old[key];
    const hit = options.find((o) => sameValue(o, v));
    if (hit !== undefined) next[key] = hit;
  };
  keep(q.durationKey, q.durationOptions);
  keep(q.resolutionKey, q.resolutionOptions);
  if (q.audioKey && typeof old[q.audioKey] === 'boolean') next[q.audioKey] = old[q.audioKey];
  return next;
}

/** 当前比例：params 中的比例键 → 节点顶层 aspect_ratio（旧数据）→ 9:16。 */
export function currentRatio(q: QuickParams, params: Record<string, unknown> | null | undefined, data?: Record<string, unknown>): string {
  const p = params || {};
  const v = p[q.ratioKey] ?? (q.ratioDeclared ? undefined : p.aspect_ratio) ?? data?.aspect_ratio;
  return typeof v === 'string' && v ? v : DEFAULT_RATIO;
}

/**
 * REQ-toonflow-canvas FX-2：直接生成下发的参数 = 面板显示的参数。
 * 节点 params 为空（模板 / Agent / 旧画布建的节点，没走过切源）时，面板显示的是缺省值，原来不下发（后端用自己的缺省）。
 * 这里按生成源 params_schema 补齐（kit materializeParams：已存 → 顶层旧值 → default_params / schema default → 开关缺省关），
 * 比例另按面板口径：生成源声明了比例键才补——顶层旧值（比例键 / 镜像的 aspect_ratio）→ 生成源缺省 → 9:16 → 第一个可选比例，
 * 只取该源支持的值；**没声明比例的生成源不补比例**（手动选过的 params.aspect_ratio 照旧下发）。
 * 未选生成源（def 为空）时原样返回：没有声明可以映射。
 */
export function resolveVideoParams(
  def: ProviderDefLike | null | undefined,
  params: Record<string, unknown> | null | undefined,
  data?: Record<string, unknown> | null,
): Record<string, unknown> {
  const saved = params || {};
  if (!def) return { ...saved };
  const q = quickParamsOf(def);
  const out = materializeParams(def, saved, data, { skip: q.ratioDeclared ? [q.ratioKey] : [] });
  if (q.ratioDeclared && isEmptyParam(saved[q.ratioKey])) {
    const supported = q.ratioOptions.filter((o) => o.supported).map((o) => o.value);
    const pick = (v: unknown) => (typeof v === 'string' && v ? supported.find((o) => o === v) : undefined);
    const fallback = def.default_params?.[q.ratioKey] ?? propsOf(def)[q.ratioKey]?.default;
    const r = pick(data?.[q.ratioKey]) ?? pick(data?.aspect_ratio) ?? pick(fallback) ?? pick(DEFAULT_RATIO) ?? supported[0];
    if (r) out[q.ratioKey] = r;
  }
  return out;
}

/**
 * 面板显示的比例（FX-2，与 resolveVideoParams 同口径）：
 * - 未选生成源：Toonflow 缺省 9:16（只能走智能规划，比例由 Agent 定）；
 * - 生成源声明了比例：补齐后的值；
 * - 生成源没声明比例：只显示手动选过的值，没选过就不选中任何比例（不下发）。
 */
export function displayRatio(q: QuickParams, resolved: Record<string, unknown>, data: Record<string, unknown> | undefined, providerSelected: boolean): string {
  if (!providerSelected) return currentRatio(q, resolved, data);
  const v = resolved[q.ratioDeclared ? q.ratioKey : 'aspect_ratio'];
  return typeof v === 'string' ? v : '';
}

/** 比例小框只对 `w:h` 形式的值有意义（adaptive 等不画）。 */
export function isRatioShape(v: string): boolean {
  return /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(v);
}

export function formatDuration(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v)) ? `${v}秒` : String(v);
}

/** 参数按钮摘要（Toonflow：比例 · 分辨率 · 时长）。ratio 传入时用它（FX-2 displayRatio，可为空串 = 不显示比例）。 */
export function paramsSummary(q: QuickParams, params: Record<string, unknown> | null | undefined, data?: Record<string, unknown>, ratio?: string): string {
  const p = params || {};
  const res = q.resolutionKey ? p[q.resolutionKey] : p.resolution;
  const dur = q.durationKey ? p[q.durationKey] : p.duration;
  return [ratio ?? currentRatio(q, p, data), res ? String(res) : '', formatDuration(dur)].filter(Boolean).join(' · ');
}

/**
 * 写参数的补丁：params 与 provider_params 同时写（buildAgentArgs 先展开 params 再展开 provider_params，不同步会被旧值覆盖），
 * 并把 engine 优先读取的顶层键同步（含删除），比例另写顶层 aspect_ratio 供旧显示 / 后端回落。
 */
export function paramsPatch(next: Record<string, unknown>, q?: QuickParams, prevParams?: Record<string, unknown> | null): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (v !== undefined) clean[k] = v;
  const patch: Record<string, unknown> = { params: clean, provider_params: clean };
  for (const k of ENGINE_TOP_LEVEL_KEYS) {
    if (clean[k] !== undefined && clean[k] !== '') patch[k] = clean[k];
    else if (prevParams && prevParams[k] !== undefined) patch[k] = undefined;
  }
  if (q) {
    const r = clean[q.ratioKey];
    if (typeof r === 'string' && r) patch.aspect_ratio = r;
  }
  return patch;
}

// ———————————————————————————— 参考模式 ————————————————————————————

export interface EffectiveMode {
  /** 实际生效模式（显示用）。 */
  mode: GenMode;
  /** data.mode 为空 = 自动。 */
  auto: boolean;
  /** data.mode 归一后的值（旧 i2v/r2v/t2v → 新名）；自动时为空串。 */
  explicit: GenMode | '';
  /** 传给 assembleInputs 的 mode：显式时原样（旧值让 kit 做 i2v+首尾帧→startEnd）；自动且与 kit 一致时为空串。 */
  assembleMode: string;
}

/**
 * Toonflow「模式自动匹配」：引用变化时按生成源能力挑模式，普通媒体优先作为参考，避免自动变成首尾帧。
 * kit.autoMode 不看生成源能力（与后端一致）；这里在它不被所选生成源支持时退到能用的模式：
 *   1 张图：有首帧槽 → 单图参考，只有参考图槽 → 多参考；
 *   ≥2 张图：有参考图槽 → 多参考，只有首尾帧槽 → 首尾帧，只有首帧槽 → 单图参考；
 *   生成源不收图 → 文生。
 */
export function resolveAutoMode(refs: readonly Pick<RefItem, 'dataType'>[], slots?: readonly SlotSpec[] | null): GenMode {
  const base = autoMode(refs);
  const caps = resolveSlotCaps(slots);
  if (!caps) return base;
  const images = refs.filter((r) => r.dataType === 'IMAGE').length;
  if (images === 0) return base;
  if (images === 1) {
    if (caps.first_frame) return 'singleImage';
    if (caps.reference_images) return 'multiReference';
    return 'text';
  }
  if (caps.reference_images) return 'multiReference';
  if (caps.first_frame && caps.last_frame) return 'startEnd';
  if (caps.first_frame) return 'singleImage';
  return 'text';
}

/** 计算实际生效模式（显示 + 组装入参）。旧值 i2v/r2v/t2v 经 kit normalizeVideoMode 映射成新模式名。 */
export function effectiveMode(dataMode: unknown, refs: readonly Pick<RefItem, 'dataType'>[], slots?: readonly SlotSpec[] | null): EffectiveMode {
  const explicit = normalizeVideoMode(dataMode);
  if (explicit) return { mode: explicit, auto: false, explicit, assembleMode: String(dataMode) };
  const kitAuto = autoMode(refs);
  const mode = resolveAutoMode(refs, slots);
  return { mode, auto: true, explicit: '', assembleMode: mode === kitAuto ? '' : mode };
}

/** 模式下拉的可选项：生成源支持的模式；当前显式值不在其中时也列出（标「不支持」）。 */
export function modeOptions(slots: readonly SlotSpec[] | null | undefined, explicit: GenMode | ''): { value: GenMode; supported: boolean }[] {
  const modes = availableModes(slots);
  const out = modes.map((m) => ({ value: m, supported: true }));
  if (explicit && !modes.includes(explicit)) out.push({ value: explicit, supported: false });
  return out;
}

/** 面板里的模式说明（Toonflow referenceHint 的扩展）。 */
export function modeHint(mode: GenMode): string {
  switch (mode) {
    case 'text': return '图片引用不会发送';
    case 'singleImage': return '第 1 张图片作为首帧，其余作为参考图';
    case 'startEnd': return '图片引用按顺序作为首帧、尾帧';
    case 'multiReference': return '图片引用全部作为参考图';
    default: return '';
  }
}

// ———————————————————————————— 生成入参 ————————————————————————————

/** 旧画布节点 data 上残留的槽位 / 文本键（连线时的 _upstream 传播写进来的）。 */
const STALE_INPUT_KEYS = [
  'first_frame', 'first_frame_url', 'last_frame', 'last_frame_url',
  'reference_images', 'reference', 'reference_image', 'images', 'image_list', 'image',
  'reference_videos', 'reference_video', 'videos',
  'reference_audios', 'ref_audio', 'ref_audio_path', 'audios',
  'camera_prompt', 'minimax_camera_prompt', 'text',
];

/**
 * 交给 useGeneration 的节点数据：去掉本次组装结果里没有的旧槽位键 / 生成源输入键。
 * nodeAgentExecutor.buildAgentArgs 会按生成源 input_schema 的键从节点顶层补值（`text` 也会优先于 prompt），
 * 不去掉的话，断开的首帧 / 旧连线时拷贝来的文本会被悄悄下发（面板上看不到）。history / skill_id / params 等保留。
 */
export function dataForRun(data: Record<string, unknown>, def: ProviderDefLike | null | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const declared = Object.keys(def?.input_schema?.properties || {});
  for (const k of [...STALE_INPUT_KEYS, ...declared]) {
    if (k === 'prompt') continue;
    if (args[k] === undefined) delete out[k];
  }
  return out;
}
