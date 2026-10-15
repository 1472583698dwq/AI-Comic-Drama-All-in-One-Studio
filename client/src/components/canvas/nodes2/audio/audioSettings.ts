// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 音频生成参数（纯函数，无 React 依赖）。
 *
 * Toonflow audioGenerationNode/audioSettings.ts 的语种 / 采样率 / 输出格式：节点数据固定存 `language` / `sampleRate` / `format`
 * （缺省 zh-CN / 24000 / wav）。MiniMax 生成源的 params_schema 声明了对应参数时才在参数弹层显示、并按源的参数名下发；
 * 没声明时只作为节点数据保存（不下发，避免给不认识的源传多余参数）。
 * 生成源参数值统一存 data.params（并镜像 provider_params 与顶层键，与 NodeAgentConsole / nodeAgentExecutor.buildAgentArgs 一致）。
 */
import type { DynamicProviderInfo } from '../../providerSkills';
import { isEmptyParam, materializeParams } from '../../kit/paramDefaults';

// —— Toonflow audioSettings.ts ——
export const LANGUAGE_OPTIONS = [
  { label: '中文', value: 'zh-CN' },
  { label: '英文', value: 'en' },
] as const;
export const SAMPLE_RATE_OPTIONS = [8000, 16000, 24000, 48000] as const;
export const FORMAT_OPTIONS = ['wav', 'mp3', 'pcm', 'ogg_opus'] as const;

export const DEFAULT_LANGUAGE = 'zh-CN';
export const DEFAULT_SAMPLE_RATE = 24000;
export const DEFAULT_FORMAT = 'wav';

export type AudioSettingKey = 'language' | 'sampleRate' | 'format';

/** 生成源可能用来表示这三项的参数名（按优先级）。 */
export const SETTING_PARAM_KEYS: Readonly<Record<AudioSettingKey, readonly string[]>> = Object.freeze({
  language: ['language', 'lang', 'text_lang', 'language_boost', 'locale'],
  sampleRate: ['sample_rate', 'sampleRate', 'sr', 'audio_sample_rate'],
  format: ['format', 'audio_format', 'output_format', 'response_format'],
});

export const SETTING_LABELS: Readonly<Record<AudioSettingKey, string>> = Object.freeze({
  language: '语种',
  sampleRate: '采样率',
  format: '输出格式',
});

const FORMAT_LABELS: Record<string, string> = { wav: 'WAV', mp3: 'MP3', pcm: 'PCM', ogg_opus: 'Opus', opus: 'Opus', flac: 'FLAC', aac: 'AAC', m4a: 'M4A' };

export type SettingValue = string | number;

export interface SettingOption {
  value: SettingValue;
  label: string;
}

export interface SettingControl {
  key: AudioSettingKey;
  /** 生成源参数名（下发用） */
  paramKey: string;
  options: SettingOption[];
}

export type ProviderDefLike = Partial<Pick<DynamicProviderInfo, 'params_schema' | 'default_params' | 'input_schema'>> | null | undefined;

function props(def: ProviderDefLike): Record<string, any> {
  const p = def?.params_schema?.properties;
  return p && typeof p === 'object' ? (p as Record<string, any>) : {};
}

/** 语种值的归一（zh-CN / zh / ZH / Chinese → zh；en / EN / English → en），用于在生成源枚举里找对应项。 */
function languageFamily(v: SettingValue): string {
  const s = String(v).trim().toLowerCase();
  if (/^(zh|cn|chinese|中文|普通话|mandarin)/.test(s)) return 'zh';
  if (/^(en|english|英文|英语)/.test(s)) return 'en';
  return s;
}

export function settingLabel(key: AudioSettingKey, value: SettingValue | undefined | null): string {
  if (value === undefined || value === null || value === '') return '';
  if (key === 'language') {
    const fam = languageFamily(value);
    return fam === 'zh' ? '中文' : fam === 'en' ? '英文' : String(value);
  }
  if (key === 'sampleRate') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1000 ? `${n / 1000}k` : String(value);
  }
  const s = String(value).toLowerCase();
  return FORMAT_LABELS[s] ?? String(value).toUpperCase();
}

/** 在选项里找与 value 等价的那个（语种按语系、采样率按数值、格式按小写 / opus 别名）。 */
export function matchSettingValue(key: AudioSettingKey, options: readonly SettingOption[], value: unknown): SettingValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = value as SettingValue;
  const exact = options.find((o) => o.value === v || String(o.value) === String(v));
  if (exact) return exact.value;
  if (key === 'language') return options.find((o) => languageFamily(o.value) === languageFamily(v))?.value;
  if (key === 'sampleRate') return options.find((o) => Number(o.value) === Number(v))?.value;
  const norm = (x: SettingValue) => String(x).toLowerCase().replace(/^ogg_/, '');
  return options.find((o) => norm(o.value) === norm(v))?.value;
}

/** 生成源选项值写回节点数据时换成 Toonflow 词汇（zh → zh-CN、opus → ogg_opus、采样率转数字）。 */
export function toDataValue(key: AudioSettingKey, value: SettingValue): SettingValue {
  if (key === 'language') {
    const fam = languageFamily(value);
    return fam === 'zh' ? 'zh-CN' : fam === 'en' ? 'en' : String(value);
  }
  if (key === 'sampleRate') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  const s = String(value).toLowerCase();
  return s === 'opus' ? 'ogg_opus' : s;
}

function defaultOptions(key: AudioSettingKey): SettingOption[] {
  if (key === 'language') return LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
  if (key === 'sampleRate') return SAMPLE_RATE_OPTIONS.map((v) => ({ value: v, label: settingLabel('sampleRate', v) }));
  return FORMAT_OPTIONS.map((v) => ({ value: v, label: settingLabel('format', v) }));
}

/**
 * 生成源声明了哪些 Toonflow 音频设置（只返回声明了的；没有声明的保持「仅节点数据」）。
 * 参数带 enum 时选项取 enum（数值型 enum 保留数值），否则用 Toonflow 默认选项。
 */
export function settingControls(def: ProviderDefLike): SettingControl[] {
  const p = props(def);
  const out: SettingControl[] = [];
  for (const key of ['language', 'sampleRate', 'format'] as AudioSettingKey[]) {
    const paramKey = SETTING_PARAM_KEYS[key].find((k) => k in p);
    if (!paramKey) continue;
    const schema = p[paramKey] || {};
    const options: SettingOption[] = Array.isArray(schema.enum) && schema.enum.length
      ? schema.enum.map((v: SettingValue) => ({ value: v, label: settingLabel(key, v) }))
      : defaultOptions(key);
    out.push({ key, paramKey, options });
  }
  return out;
}

/** 节点数据里的 Toonflow 设置（缺省值兜底）。 */
export function audioSettingsOf(data: Record<string, unknown> | undefined | null): Record<AudioSettingKey, SettingValue> {
  const d = data || {};
  const sr = Number(d.sampleRate);
  return {
    language: typeof d.language === 'string' && d.language ? d.language : DEFAULT_LANGUAGE,
    sampleRate: Number.isFinite(sr) && sr > 0 ? sr : DEFAULT_SAMPLE_RATE,
    format: typeof d.format === 'string' && d.format ? d.format : DEFAULT_FORMAT,
  };
}

/** 设置控件当前显示值：已下发的参数值优先，其次把节点数据映射到源的选项，最后取源的 schema 默认值。 */
export function currentSettingValue(control: SettingControl, params: Record<string, unknown>, data: Record<string, unknown>, def: ProviderDefLike): SettingValue | undefined {
  const fromParams = matchSettingValue(control.key, control.options, params[control.paramKey]);
  if (fromParams !== undefined) return fromParams;
  const fromData = matchSettingValue(control.key, control.options, audioSettingsOf(data)[control.key]);
  if (fromData !== undefined) return fromData;
  return matchSettingValue(control.key, control.options, props(def)[control.paramKey]?.default);
}

// —— 音色 / 情绪 / 台词键 ——
export const VOICE_PARAM_KEYS = ['voice_id', 'voice', 'speaker', 'speaker_id'] as const;
export const EMOTION_PARAM_KEYS = ['emotion'] as const;
/** 台词本身由提示词输入提供，params_schema 里重复声明的文本参数不在参数弹层出现。 */
export const TEXT_PARAM_KEYS = ['text', 'prompt', 'dialogue', 'input'] as const;

/** 生成源声明的音色参数名（没有则 undefined）。 */
export function voiceParamKey(def: ProviderDefLike): string | undefined {
  const p = props(def);
  return VOICE_PARAM_KEYS.find((k) => k in p) ?? Object.keys(p).find((k) => p[k]?.['x-role'] === 'voice');
}

export function emotionParamKey(def: ProviderDefLike): string | undefined {
  const p = props(def);
  return EMOTION_PARAM_KEYS.find((k) => k in p) ?? Object.keys(p).find((k) => p[k]?.['x-role'] === 'emotion');
}

/** 参数弹层里不再交给 DynamicControl 渲染的键（台词 / 音色 / Toonflow 设置）。 */
export function specialParamKeys(def: ProviderDefLike): Set<string> {
  const p = props(def);
  const keys = new Set<string>();
  for (const k of Object.keys(p)) {
    const role = p[k]?.['x-role'];
    if ((TEXT_PARAM_KEYS as readonly string[]).includes(k) || role === 'dialogue' || role === 'prompt') keys.add(k);
  }
  const voice = voiceParamKey(def);
  if (voice) keys.add(voice);
  for (const c of settingControls(def)) keys.add(c.paramKey);
  return keys;
}

/** 切换生成源时的初始参数：params_schema 默认值 + default_params（同 NodeAgentConsole.selectProvider）。 */
export function schemaDefaults(def: ProviderDefLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props(def))) {
    if ((TEXT_PARAM_KEYS as readonly string[]).includes(k)) continue;
    if (v && typeof v === 'object' && (v as any).default !== undefined) out[k] = (v as any).default;
  }
  const extra = def?.default_params;
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  return out;
}

/**
 * REQ-toonflow-canvas FX-2：直接生成下发的参数 = 参数弹层显示的参数。
 * - 语种 / 采样率 / 格式（生成源声明了才有控件）：没存值时取控件显示的值（currentSettingValue：节点 Toonflow 设置映射 → schema 缺省）；
 * - 其余声明参数（情绪、语速…）：kit materializeParams（已存 → 顶层旧值 → default_params / schema default → 开关缺省关）；
 * - 台词键、音色键不补（音色没选时弹层显示「默认音色」，由生成源自己定；顶层 voice_id 执行器照旧补发）。
 * 未选生成源时原样返回。
 */
export function resolveAudioParams(def: ProviderDefLike, params: Record<string, unknown> | null | undefined, data?: Record<string, unknown> | null): Record<string, unknown> {
  const saved = params || {};
  if (!def) return { ...saved };
  const voice = voiceParamKey(def);
  const controls = settingControls(def);
  const out = materializeParams(def as Parameters<typeof materializeParams>[0], saved, data, {
    skip: [...TEXT_PARAM_KEYS, ...(voice ? [voice] : []), ...controls.map((c) => c.paramKey)],
  });
  for (const c of controls) {
    if (!isEmptyParam(saved[c.paramKey])) continue;
    const v = currentSettingValue(c, saved, data || {}, def);
    if (v !== undefined) out[c.paramKey] = v;
  }
  return out;
}

/** 节点里当前生效的参数（data.params → provider_params）。 */
export function paramsOf(data: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const d = data || {};
  const p = d.params ?? d.provider_params;
  return p && typeof p === 'object' && !Array.isArray(p) ? { ...(p as Record<string, unknown>) } : {};
}

/**
 * 改一个参数后的节点补丁：params + provider_params + 顶层同名键（engine 执行器优先读顶层，必须同步，
 * 否则旧顶层值会盖过新参数）。value 为空（'' / undefined / null）时删除该参数。
 */
export function paramPatch(data: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = paramsOf(data);
  const empty = value === undefined || value === null || value === '';
  if (empty) delete next[key];
  else next[key] = value;
  return { params: next, provider_params: next, [key]: empty ? undefined : value };
}

/**
 * 选择生成源后的节点补丁（同 NodeAgentConsole.selectProvider）：换源时参数重置为新源默认值，
 * 已有的 Toonflow 设置按新源的选项映射进参数；同源重选保持原参数；清掉旧源的规划白盒与排队任务。
 */
export function providerSwitchPatch(data: Record<string, unknown>, providerId: string, def: ProviderDefLike): Record<string, unknown> {
  const prev = String(data.provider_id || data.provider || '');
  if (!providerId) {
    return { provider_id: undefined, provider: undefined, _last_agent_plan: undefined, _taskId: undefined, _polling: false };
  }
  const params = providerId === prev ? paramsOf(data) : schemaDefaults(def);
  for (const control of settingControls(def)) {
    const v = matchSettingValue(control.key, control.options, audioSettingsOf(data)[control.key]);
    if (v !== undefined && (providerId !== prev || params[control.paramKey] === undefined)) params[control.paramKey] = v;
  }
  const patch: Record<string, unknown> = {
    provider_id: providerId,
    provider: providerId,
    params,
    provider_params: params,
    _last_agent_plan: undefined,
    _taskId: undefined,
    _polling: false,
  };
  if (providerId !== prev) {
    // 顶层音色 / 情绪跟随新源（旧源的音色 id 在新源上多半无效）
    const voiceKey = voiceParamKey(def) ?? 'voice_id';
    const emotionKey = emotionParamKey(def) ?? 'emotion';
    patch[voiceKey] = params[voiceKey];
    patch[emotionKey] = params[emotionKey];
    if (voiceKey !== 'voice_id') patch.voice_id = params[voiceKey];
  }
  return patch;
}

/** 参数按钮上的摘要（Toonflow：中文 · 24k · wav）。 */
export function paramsSummary(parts: (string | undefined | null | false)[]): string {
  return parts.filter((p): p is string => !!p).join(' · ');
}
