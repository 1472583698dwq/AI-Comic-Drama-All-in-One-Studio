// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片生成参数（纯函数）：生成源 params_schema → DynamicControl 列表 +
 * Toonflow generationSettings 的「分辨率 / 比例」快捷项。
 *
 * 快捷项不写死参数名：比例 = 键名 aspect_ratio / x-std-key aspect_ratio / 名称含 ratio·比例 且枚举值形如 `W:H`；
 * 分辨率 = resolution / size / x-std-key resolution|size / 名称含 分辨率·尺寸。
 * 枚举值原样存（如 ComfyUI 的 `9:16 (Portrait Widescreen)`），展示时取出 `9:16`。
 */
import { paramsSchemaToSpecs } from '../../providerSkills';
import type { ControlSpec } from '../../controls/DynamicControl';
import { materializeParams } from '../../kit/paramDefaults';

export interface QuickParams {
  /** 全部参数控件（含快捷项本身）。 */
  specs: ControlSpec[];
  ratio?: ControlSpec;
  size?: ControlSpec;
}

const RATIO_RE = /(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)/;

/** `9:16 (Portrait Widescreen)` → `9:16`；不像比例返回 null。 */
export function ratioText(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const m = String(v).match(RATIO_RE);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  // 大数（如 1024x1024）是分辨率不是比例
  if (w > 64 || h > 64) return null;
  return `${m[1]}:${m[2]}`;
}

/** 像素尺寸 → 比例文字：1024×768 → `4:3`；约不尽的写成 `1.78:1`。 */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '1:1';
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const w = Math.round(width);
  const h = Math.round(height);
  const g = gcd(w, h) || 1;
  if (w / g <= 64 && h / g <= 64) return `${w / g}:${h / g}`;
  return `${(width / height).toFixed(2)}:1`;
}

/** `9:16` → 0.5625 */
export function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

function schemaProps(schema: unknown): Record<string, Record<string, unknown>> {
  const props = (schema as { properties?: unknown } | null | undefined)?.properties;
  return props && typeof props === 'object' ? (props as Record<string, Record<string, unknown>>) : {};
}

/** 从生成源 params_schema 解析参数控件与比例 / 分辨率快捷项。 */
export function detectQuickParams(paramsSchema: unknown): QuickParams {
  const specs = paramsSchemaToSpecs(paramsSchema as Record<string, any> | undefined);
  const props = schemaProps(paramsSchema);
  const stdKey = (s: ControlSpec) => String(props[s.param_name]?.['x-std-key'] ?? '').toLowerCase();
  const text = (s: ControlSpec) => `${s.param_name} ${s.label ?? ''}`.toLowerCase();
  const enumOf = (s: ControlSpec) => (s.options ?? []).filter((o) => o !== '');

  const ratio = specs.find((s) => {
    const opts = enumOf(s);
    if (!opts.length || !opts.some((o) => ratioText(o))) return false;
    return s.param_name === 'aspect_ratio' || stdKey(s) === 'aspect_ratio' || /aspect|ratio|比例/.test(text(s));
  });
  const size = specs.find((s) => {
    if (s === ratio || !enumOf(s).length) return false;
    const k = stdKey(s);
    return ['resolution', 'size', 'image_size'].includes(s.param_name) || k === 'resolution' || k === 'size' || /resolution|分辨率|尺寸|image_size/.test(text(s));
  });
  return { specs, ratio, size };
}

/** 生成源默认参数：params_schema 各项 default + default_params（同旧 NodeAgentConsole.selectProvider）。 */
export function providerDefaultParams(def: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schemaProps(def?.params_schema))) {
    if (v && v.default !== undefined) out[k] = v.default;
  }
  const dp = def?.default_params;
  if (dp && typeof dp === 'object' && !Array.isArray(dp)) Object.assign(out, dp as Record<string, unknown>);
  return out;
}

/**
 * REQ-toonflow-canvas FX-2：直接生成下发的参数 = 参数弹层显示的参数。
 * 弹层对没存值的参数显示缺省值（比例 / 分辨率 / DynamicControl 都回落 default），原来却只发节点里存过的键；
 * 这里按生成源 params_schema 补齐（kit materializeParams：已存 → 顶层旧值 → default_params / schema default → 开关缺省关），
 * 弹层与请求都用它。未选生成源时原样返回。
 */
export function resolveImageParams(
  def: Record<string, unknown> | null | undefined,
  params: Record<string, unknown> | null | undefined,
  data?: Record<string, unknown> | null,
): Record<string, unknown> {
  return materializeParams(def as Parameters<typeof materializeParams>[0], params, data);
}

/** 生成源有多个模型时「模型」控件显示的缺省模型（default_model → 第一个）；只有 0 / 1 个模型时没有该控件，返回 undefined。 */
export function defaultModelOf(def: Record<string, unknown> | null | undefined): string | undefined {
  const models = Array.isArray(def?.models) ? (def!.models as unknown[]).map(String).filter(Boolean) : [];
  if (models.length < 2) return undefined;
  return typeof def?.default_model === 'string' && def.default_model ? def.default_model : models[0];
}

/** 当前生效值：节点 params 优先，其次控件默认值。 */
export function paramValue(params: Record<string, unknown> | null | undefined, spec: ControlSpec | undefined): unknown {
  if (!spec) return undefined;
  const v = params?.[spec.param_name];
  return v === undefined || v === null || v === '' ? spec.default_value : v;
}

/** 参数按钮摘要：`16:9 · 720p`（Toonflow `16:9 · 2K · 1张`）；没有快捷项时退化为「N 项参数」。 */
export function paramsSummary(params: Record<string, unknown> | null | undefined, quick: QuickParams): { text: string; ratio?: string } {
  const parts: string[] = [];
  const r = ratioText(paramValue(params, quick.ratio));
  if (r) parts.push(r);
  const s = paramValue(params, quick.size);
  if (s !== undefined && s !== null && s !== '') parts.push(String(s));
  if (parts.length) return { text: parts.join(' · '), ...(r ? { ratio: r } : {}) };
  const visible = quick.specs.filter((sp) => sp.visibility !== 'hidden').length;
  return { text: visible ? `${visible} 项参数` : '参数' };
}

/** 比例枚举里最接近给定宽高比的那一项（局部重绘让输出比例跟随原图）。 */
export function closestRatioOption(spec: ControlSpec | undefined, aspect: number): string | undefined {
  if (!spec?.options?.length || !(aspect > 0)) return undefined;
  let best: string | undefined;
  let bestDiff = Infinity;
  for (const o of spec.options) {
    const r = ratioText(o);
    if (!r) continue;
    const diff = Math.abs(Math.log(ratioValue(r) / aspect));
    if (diff < bestDiff) { bestDiff = diff; best = o; }
  }
  return best;
}

/**
 * 后端执行器（engine.py 图片分支）先读节点顶层的这几个标准键、再读 params / provider_params 包，
 * 所以这几个键要镜像到顶层（旧 NodeAgentConsole 是把全部参数铺到顶层；ComfyUI 工作流动辄几十个参数，这里只铺标准键）。
 */
export const ENGINE_TOP_LEVEL_KEYS = ['aspect_ratio', 'resolution', 'steps', 'cfg', 'seed', 'style_preset', 'negative_prompt'] as const;

/**
 * 写参数的补丁（沿用 MiniMax：params + provider_params 同写；标准键镜像到顶层，换源后不再存在的标准键清掉）。
 */
export function paramsPatch(next: Record<string, unknown>, prevParams?: Record<string, unknown> | null): Record<string, unknown> {
  const patch: Record<string, unknown> = { params: next, provider_params: next };
  for (const k of ENGINE_TOP_LEVEL_KEYS) {
    if (k in next) patch[k] = next[k];
    else if (prevParams && k in prevParams) patch[k] = undefined;
  }
  return patch;
}

/** 生成时下发的参数：去掉空值（runGeneration 也会再清一次）。 */
export function effectiveParams(params: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}
