// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 独有节点换皮 A —— 端口声明（design §6.2：端口 id 不变）。
 *
 * - 端口 id / 方向与旧组件、`nodeRegistry.NODE_SPECS` 一致，存量连线不断；
 * - 类型按 MiniMax 句柄类型映射：image→IMAGE、video→VIDEO、audio→AUDIO、text（及角色/分镜等文本类）→STRING；
 * - 旧组件里没有 id 的句柄（comfy-workflow 左侧输入/右侧输出、timeline-export 左侧输入）：
 *   没有 handle id 的旧连线由 React Flow 与 kit 落到该侧第一个端口，所以每侧第一个端口就是它们的新家；
 * - shot-card 的动态输入口照旧从生成源声明（`data.providerDef || data.definition` 的 input_schema）生成。
 */
import type { DataType, PortDef } from '../../kit';

export type PortDataType = Exclude<DataType, '*'>;

/** MiniMax 旧句柄类型（nodeRegistry HandleDef.type / x-handle 声明）→ kit 数据类型。 */
export function toDataType(handleType?: string | null): PortDataType {
  const t = String(handleType ?? '').trim().toLowerCase();
  if (!t) return 'STRING';
  if (t.includes('image') || t === 'first_frame' || t === 'last_frame') return 'IMAGE';
  if (t.includes('video')) return 'VIDEO';
  if (t.includes('audio')) return 'AUDIO';
  return 'STRING';
}

const target = (id: string, dataType: PortDataType, label: string): PortDef => ({ id, type: 'target', dataType, label });
const source = (id: string, dataType: PortDataType, label: string): PortDef => ({ id, type: 'source', dataType, label });

// —— shot-card（分镜卡）——
/** NODE_SPECS['shot-card'].inputs：生图源 / 参考图 / 提示词 / 角色（旧组件 specInputs 同序）。 */
export const SHOT_CARD_STATIC_INPUTS: readonly PortDef[] = Object.freeze([
  target('provider', 'IMAGE', '生图源'),
  target('reference', 'IMAGE', '参考图'),
  target('prompt', 'STRING', '提示词'),
  target('character', 'STRING', '角色'),
]);
/** NODE_SPECS['shot-card'].outputs：首帧 / 视频 / 分镜。 */
export const SHOT_CARD_OUTPUTS: readonly PortDef[] = Object.freeze([
  source('image', 'IMAGE', '首帧'),
  source('video', 'VIDEO', '视频'),
  source('shot', 'STRING', '分镜'),
]);
/** 旧组件 `[...specInputs, ...extraHandles].slice(0, 6)`：输入口最多 6 个。 */
export const SHOT_CARD_MAX_INPUTS = 6;

/**
 * 旧 ShotCardNode 的 extraHandles：生成源 input_schema 里带 `x-handle`、或是 uri 数组的属性 → 一个输入口（id = 属性键）。
 * 类型：`x-handle` 优先，否则按属性键名猜（含 image/audio/video，其余为文本），同旧组件。
 */
export function shotCardSchemaInputs(providerDef: unknown): PortDef[] {
  const props = (providerDef as { input_schema?: { properties?: Record<string, unknown> } } | null | undefined)?.input_schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const out: PortDef[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const def = (raw || {}) as Record<string, unknown>;
    const items = (def.items || {}) as Record<string, unknown>;
    const xHandle = def['x-handle'];
    if (!xHandle && !(def.type === 'array' && items.format === 'uri')) continue;
    const guessed = key.includes('image') ? 'image' : key.includes('audio') ? 'audio' : key.includes('video') ? 'video' : 'text';
    out.push(target(key, toDataType(typeof xHandle === 'string' && xHandle ? xHandle : guessed), key));
  }
  return out;
}

/** shot-card 实际端口：静态 4 口 + 生成源声明的动态口（截到 6 个，重复 id 只留第一个）+ 3 个输出。 */
export function shotCardPorts(data?: Record<string, unknown> | null): PortDef[] {
  const d = data || {};
  const providerDef = d.providerDef || d.definition;
  const inputs = [...SHOT_CARD_STATIC_INPUTS, ...shotCardSchemaInputs(providerDef)].slice(0, SHOT_CARD_MAX_INPUTS);
  const seen = new Set<string>();
  const unique = inputs.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return [...unique, ...SHOT_CARD_OUTPUTS];
}

// —— comfy-workflow（ComfyUI 工作流）——
/**
 * NODE_SPECS 只声明了输出 image / video；旧组件还渲染了两个输入：左侧无 id（垫图/参考）与 `prompt`（主提示词）。
 * 左侧无 id 的输入取名 `reference`（后端 engine 把 reference 口按参考图注入）并排在第一位，承接无 handle 的旧连线；
 * 旧的无 id 输出（主产物）同理落到第一个输出 `image`。
 */
export const COMFY_WORKFLOW_PORTS: readonly PortDef[] = Object.freeze([
  target('reference', 'IMAGE', '参考图'),
  target('prompt', 'STRING', '提示词'),
  source('image', 'IMAGE', '图像'),
  source('video', 'VIDEO', '视频'),
]);

// —— timeline（时间线）/ export（导出草稿）：NODE_SPECS 同为 video / audio 两个输入、无输出 ——
export const TIMELINE_PORTS: readonly PortDef[] = Object.freeze([
  target('video', 'VIDEO', '视频'),
  target('audio', 'AUDIO', '音频'),
]);
export const EXPORT_PORTS: readonly PortDef[] = Object.freeze([
  target('video', 'VIDEO', '视频'),
  target('audio', 'AUDIO', '音频'),
]);

// —— timeline-export（剪映导出）：NODE_SPECS 分镜 / 视频 / 音频三个输入（旧组件左侧无 id 输入落到第一个 `shots`）——
export const TIMELINE_EXPORT_PORTS: readonly PortDef[] = Object.freeze([
  target('shots', 'STRING', '分镜'),
  target('videos', 'VIDEO', '视频'),
  target('audios', 'AUDIO', '音频'),
]);
