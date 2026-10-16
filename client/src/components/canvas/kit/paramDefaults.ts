// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas FX-2：生成参数「面板显示什么，直接生成就发什么」。
 *
 * 参数面板对节点里没存值的参数显示生成源的缺省值（params_schema default / default_params），
 * 但节点 params 里没有这些键，直接生成时就不会下发——后端各用各的缺省，和面板显示的可能不一致
 * （例：视频节点 params 为空时面板显示比例 9:16，请求里却没有 aspect_ratio）。
 *
 * materializeParams 按生成源声明的参数键（params_schema.properties）补齐面板会显示成「已选」的值：
 *   已存值 → 节点顶层同名旧值（旧画布 / engine 镜像键；执行器原本就会从顶层补发，类型要对得上）
 *   → default_params → schema default → 布尔开关没有缺省时按「关」（开关只显示开 / 关两态）。
 * 只补生成源声明过的键；提示词类（prompt / text / x-role prompt·dialogue）、媒体（format: uri）、数组 / 对象、
 * 隐藏参数（x-visibility: hidden，面板不显示）不补；opts.skip 里的键不补。
 * 节点 params 里已有的其他键原样保留（与原来一样照发）。不写节点数据，只在发请求时用。
 */

export interface ParamsDefLike {
  params_schema?: { properties?: Record<string, unknown> | null } | null;
  default_params?: Record<string, unknown> | null;
}

type Spec = Record<string, unknown>;

/** 提示词类参数：由提示词输入 / 组装结果提供，不当作参数补。 */
const PROMPT_KEYS = new Set(['prompt', 'text']);
const PROMPT_ROLES = new Set(['prompt', 'dialogue']);

export function isEmptyParam(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function isToggle(spec: Spec): boolean {
  return spec.type === 'boolean' || spec['x-control'] === 'toggle';
}

/**
 * 把一个值按参数声明规范化（用于认旧画布顶层的同名值）：枚举里有的取枚举项；布尔只认布尔；数值认有限数；
 * 字符串只认字符串；对不上返回 undefined（例如视频参数 `audio` 是开关，顶层 `audio` 却是旧传播拷来的音频地址）。
 */
export function coerceParamValue(spec: Spec, v: unknown): unknown {
  if (isEmptyParam(v) || typeof v === 'object' || typeof v === 'function') return undefined;
  const en = spec.enum;
  if (Array.isArray(en) && en.length) return en.find((o) => o === v || String(o) === String(v));
  if (isToggle(spec)) return typeof v === 'boolean' ? v : undefined;
  if (spec.type === 'integer' || spec.type === 'number') {
    if (typeof v === 'boolean') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.type === 'string') return typeof v === 'string' ? v : undefined;
  return v;
}

export interface MaterializeOptions {
  /** 不补的键（由节点自己处理的快捷参数、音色等）。 */
  skip?: Iterable<string>;
}

/** 生成源声明的参数里，节点没存值的补成面板显示的值（见文件头）。返回新对象，不改入参。 */
export function materializeParams(
  def: ParamsDefLike | null | undefined,
  params: Record<string, unknown> | null | undefined,
  data?: Record<string, unknown> | null,
  opts: MaterializeOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(params || {}) };
  const props = def?.params_schema?.properties;
  if (!props || typeof props !== 'object') return out;
  const skip = new Set(opts.skip || []);
  const dp = def?.default_params && typeof def.default_params === 'object' && !Array.isArray(def.default_params) ? def.default_params : {};
  for (const [key, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== 'object' || skip.has(key) || PROMPT_KEYS.has(key)) continue;
    const spec = raw as Spec;
    if (!isEmptyParam(out[key])) continue;
    if (PROMPT_ROLES.has(String(spec['x-role'] ?? ''))) continue;
    if (spec['x-visibility'] === 'hidden' || spec.format === 'uri' || spec.type === 'array' || spec.type === 'object') continue;
    const legacy = data ? coerceParamValue(spec, data[key]) : undefined;
    if (legacy !== undefined) { out[key] = legacy; continue; }
    const dv = !isEmptyParam(dp[key]) ? dp[key] : spec.default;
    if (!isEmptyParam(dv)) { out[key] = dv; continue; }
    if (isToggle(spec)) out[key] = false;
  }
  return out;
}
