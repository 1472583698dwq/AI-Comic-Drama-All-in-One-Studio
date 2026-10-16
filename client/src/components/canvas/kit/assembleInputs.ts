// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 生成时组装（design §4）：有序参考列表 → 生成源输入槽。
 *
 * 规则与后端唯一实现 `server/app/canvas/inputs.py`（R1–R7）逐条一致，`canonical` 与后端 `collect_inputs().slots`
 * 完全相同（见 __tests__/assembleInputs.test.ts 的「前后端同一夹具」）。前端只多做一步：按所选生成源的槽位能力
 * （input_schema 的 x-slot / maxItems，来自 providerSkills.extractSlotsFromProvider）映射入参键名并截断，给出 warnings。
 *
 * R4 显式槽位：旧具名口（连线 targetHandle）优先，其次 refRoles[edgeKey]；槽位与参考类型不符视为未指定。
 * R5 分配：STRING 显式 prompt/camera_prompt，未指定时来自 3D 导演机位 → camera_prompt，其余 → prompt；
 *    AUDIO → ref_audio；VIDEO → reference_video；IMAGE 显式 first/last 先到先得、reference_images 追加；
 *    未指定的图：目标是 video 时按模式（空 = 按图片参考数自动：0→text〔有音/视频参考记 multiReference〕、1→singleImage、≥2→multiReference），
 *    text 不发送、singleImage 第一张→首帧（已占则参考图）其余→参考图、startEnd 依次首帧/尾帧/参考图、multiReference 全→参考图；
 *    其他目标一律 → reference_images。
 * R6 提示词：主体 = 节点自身文本（{{ref N}} → 参考 N）；自身为空时第一条文本参考作主体（不加前缀）；
 *    其余文本参考 `参考 N：\n…`；去掉与自身文本完全相同的文本参考；自身文本提到的非文本参考附「参考编号对应」；段落 \n\n 连接。
 * R6a 音频目标（K1，协调人拍板，后端 T6 同步改 inputs.assemble_audio_text）：配音文本不加「参考 N：」前缀、不加对应关系附注；
 *    自身文本（text 优先，其次 prompt）非空 → 只念自身文本，`{{ref N}}` 换成第 N 项文本参考（prompt 槽）的原文
 *    （不是带值的文本参考——媒体 / 机位 / 越界 / 空值——换成空串），结果 trim；自身为空 → 文本参考按参考顺序用 "\n" 连接（无前缀）。
 * R7 生成源模式：text→t2v、singleImage/startEnd→i2v、multiReference→r2v；空：有首帧 i2v、只有参考图/视频 r2v、否则 t2v。
 */
import type { AssetSlotDef } from '../providerSkills';
import type { GenMode, RefItem, Slot } from './types';
import {
  LEGACY_HANDLE_SLOTS, NEW_IN_PORT, PROVIDER_MODE_BY_VIDEO_MODE, REF_TOKEN_RE, SLOT_KIND, isCameraSource,
  normalizeSlot, normalizeVideoMode, type Kind,
} from './inputRules';
import { refName } from './references';

export { normalizeVideoMode, normalizeSlot };
export { ownPromptOf } from './inputRules';

/** 组装只需要 AssetSlotDef 的这几个字段（直接传 extractSlotsFromProvider 的结果即可）。 */
export type SlotSpec = Pick<AssetSlotDef, 'key' | 'type'> & Partial<Pick<AssetSlotDef, 'maxCount' | 'originalKey' | 'multi' | 'required' | 'label'>>;

type MediaSlot = 'first_frame' | 'last_frame' | 'reference_images' | 'ref_audio' | 'reference_video';
const MEDIA_SLOTS: readonly MediaSlot[] = ['first_frame', 'last_frame', 'reference_images', 'ref_audio', 'reference_video'];
const SINGLE_SLOTS = new Set<MediaSlot>(['first_frame', 'last_frame']);

interface Cap {
  /** 生成源真实入参键（input_schema 属性名）。 */
  argKey: string;
  max?: number;
  multi: boolean;
  required: boolean;
  label: string;
}
type Caps = Partial<Record<MediaSlot, Cap>>;

const SLOT_LABEL: Record<MediaSlot, string> = {
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_images: '参考图',
  ref_audio: '参考音频',
  reference_video: '参考视频',
};
const SLOT_DESC: Partial<Record<Slot, string>> = { first_frame: '首帧图', last_frame: '尾帧图', ref_audio: '参考音频', reference_video: '参考视频' };

function capOf(slot: SlotSpec, fallbackLabel: string): Cap {
  const max = slot.maxCount;
  return {
    argKey: slot.originalKey || slot.key,
    max,
    multi: slot.multi ?? (max === undefined || max > 1),
    required: !!slot.required,
    label: slot.label || fallbackLabel,
  };
}

/** 把生成源槽位归到 5 个标准槽；`null/undefined` = 生成源未知。 */
export function resolveSlotCaps(slots?: readonly SlotSpec[] | null): Caps | null {
  if (!slots) return null;
  const caps: Caps = {};
  const otherImages: SlotSpec[] = [];
  for (const s of slots) {
    const norm = normalizeSlot(s.key);
    if (s.type === 'image') {
      if (norm === 'first_frame' || norm === 'last_frame' || norm === 'reference_images') {
        if (!caps[norm]) caps[norm] = capOf(s, SLOT_LABEL[norm]);
      } else otherImages.push(s);
    } else if (s.type === 'audio') {
      if (!caps.ref_audio) caps.ref_audio = capOf(s, SLOT_LABEL.ref_audio);
    } else if (s.type === 'video') {
      if (!caps.reference_video) caps.reference_video = capOf(s, SLOT_LABEL.reference_video);
    }
  }
  // 其他图片槽（如 image / image_url 这类单图垫图入参）视作参考图
  if (!caps.reference_images && otherImages.length) caps.reference_images = capOf(otherImages[0], SLOT_LABEL.reference_images);
  return caps;
}

/** 生成源支持的参考模式（供模式切换 UI；组装本身不受它影响，与后端一致）。未知生成源 = 全部。 */
export function availableModes(slots?: readonly SlotSpec[] | null): GenMode[] {
  const caps = resolveSlotCaps(slots);
  if (!caps) return ['text', 'singleImage', 'startEnd', 'multiReference'];
  const modes: GenMode[] = ['text'];
  if (caps.first_frame || caps.reference_images) modes.push('singleImage');
  if (caps.first_frame && caps.last_frame) modes.push('startEnd');
  if (caps.reference_images) modes.push('multiReference');
  return modes;
}

/**
 * 视频自动模式（R5）：按全部图片参考数（含暂无值的）——0 → text（有音频/视频参考时记 multiReference）、1 → singleImage、≥2 → multiReference。
 */
export function autoMode(refs: readonly Pick<RefItem, 'dataType'>[]): GenMode {
  const images = refs.filter((r) => r.dataType === 'IMAGE').length;
  if (images === 0) return refs.some((r) => r.dataType === 'AUDIO' || r.dataType === 'VIDEO') ? 'multiReference' : 'text';
  return images === 1 ? 'singleImage' : 'multiReference';
}

/** R7：视频节点下发给生成源的模式（t2v / i2v / r2v）。 */
export function providerVideoMode(mode: string | null | undefined, canonical: Pick<CanonicalSlots, 'first_frame' | 'reference_images' | 'reference_video'>): 't2v' | 'i2v' | 'r2v' {
  const m = normalizeVideoMode(mode);
  if (m) return PROVIDER_MODE_BY_VIDEO_MODE[m];
  if (canonical.first_frame) return 'i2v';
  if (canonical.reference_images?.length || canonical.reference_video?.length) return 'r2v';
  return 't2v';
}

/** 与后端 collect_inputs().slots 同形：空槽不出现；prompt / camera_prompt / first_frame / last_frame 为字符串，其余为列表。 */
export interface CanonicalSlots {
  prompt?: string;
  camera_prompt?: string;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  ref_audio?: string[];
  reference_video?: string[];
}

export interface AssembleParams {
  refs: readonly RefItem[];
  /** 目标节点类型：只有 `video` 按模式分配图片，其他（image/audio/prompt/director3d）未指定的图一律进参考图。 */
  targetType: string;
  /** 节点自身文本（用 ownPromptOf(type, data)：audio 取 text 优先，其余 prompt 优先），可含 `{{ref N}}`。 */
  prompt: string;
  /** data.mode（含旧值 i2v/r2v/t2v）；空 = 自动。只对 video 生效。 */
  mode?: string | null;
  /** data.refRoles（缺省用 RefItem.role）。 */
  refRoles?: Record<string, string> | null;
  /** 所选生成源的槽位（extractSlotsFromProvider 结果）；null/undefined = 未知（不截断，入参用执行器约定键）。 */
  slots?: readonly SlotSpec[] | null;
}

export interface AssembledInputs {
  /** 后端同款槽位（未截断）。 */
  canonical: CanonicalSlots;
  /** 截断后的最终值（便于直接展示 / 下发）。 */
  prompt: string;
  camera_prompt?: string;
  first_frame?: string;
  last_frame?: string;
  reference_images: string[];
  ref_audio: string[];
  reference_video: string[];
  /** 视频节点实际生效的参考模式；其余节点为空串（同后端 mode）。 */
  mode: GenMode | '';
  /** 视频节点下发生成源的模式（R7）；其余节点 undefined。 */
  providerMode?: 't2v' | 'i2v' | 'r2v';
  /** 入参：生成源已知时按 input_schema 属性名组装（含 prompt / camera_prompt）；未知时同后端 to_engine_upstream 的键。 */
  args: Record<string, string | string[]>;
  /** refKey → 实际去向（null = 未使用 / 被截断 / 空参考）。 */
  assignments: Record<string, Slot | null>;
  /** 是否有文本参考进了提示词（后端 has_text_refs）。 */
  hasTextRefs: boolean;
  /** 面板提示：空参考、截断、生成源不支持的槽位、缺必填槽等（前端独有）。 */
  warnings: string[];
}

/** R4：显式槽位——旧具名口优先，其次 refRoles；类型不符视为未指定。 */
function explicitSlotOf(item: RefItem, refRoles?: Record<string, string> | null): Slot | undefined {
  const th = (item.targetHandle ?? '').trim();
  const slot = th && th !== NEW_IN_PORT && th in LEGACY_HANDLE_SLOTS
    ? LEGACY_HANDLE_SLOTS[th]
    : normalizeSlot(refRoles ? refRoles[item.key] : item.role);
  return slot && SLOT_KIND[slot] === item.dataType ? slot : undefined;
}

function names(indexes: number[]): string {
  return indexes.map((i) => refName(i + 1)).join('、');
}

/** R6 提示词组装（与 inputs.assemble_prompt 一致）。 */
export function assemblePrompt(own: string, texts: readonly [number, string][], mapping = ''): string {
  const o = (own || '').trim();
  let items = texts.map(([n, t]) => [n, (t || '').trim()] as const).filter(([, t]) => t && t !== o);
  const parts: string[] = [];
  if (o) parts.push(o.replace(REF_TOKEN_RE, (_w, n: string) => refName(Number(n))));
  else if (items.length) {
    parts.push(items[0][1]);
    items = items.slice(1);
  }
  for (const [n, t] of items) parts.push(`${refName(n)}：\n${t}`);
  if (mapping) parts.push(mapping);
  return parts.filter(Boolean).join('\n\n');
}

/** R6a 音频目标的配音文本（与 inputs.assemble_audio_text 一致）：无「参考 N：」前缀、无对应关系附注。 */
export function assembleAudioText(own: string, texts: readonly [number, string][]): string {
  const o = (own || '').trim();
  const byN = new Map<number, string>();
  for (const [n, t] of texts) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (v) byN.set(n, v);
  }
  if (o) return o.replace(REF_TOKEN_RE, (_w, n: string) => byN.get(Number(n)) ?? '').trim();
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('\n');
}

/** 后端 to_engine_upstream 的键（生成源未知时的入参）。 */
export function toEngineArgs(c: CanonicalSlots): Record<string, string | string[]> {
  const up: Record<string, string | string[]> = {};
  if (c.prompt) { up.prompt = c.prompt; up.text = c.prompt; }
  if (c.camera_prompt) up.camera_prompt = c.camera_prompt;
  if (c.first_frame) { up.first_frame = c.first_frame; up.first_frame_url = c.first_frame; }
  if (c.last_frame) { up.last_frame = c.last_frame; up.last_frame_url = c.last_frame; }
  if (c.reference_images?.length) up.reference_images = [...c.reference_images];
  if (c.ref_audio?.length) { up.ref_audio = c.ref_audio[0]; up.reference_audios = [...c.ref_audio]; }
  if (c.reference_video?.length) up.reference_videos = [...c.reference_video];
  return up;
}

export function assembleInputs(params: AssembleParams): AssembledInputs {
  const { refs, refRoles, targetType } = params;
  const isVideo = targetType === 'video';
  const warnings: string[] = [];
  const assignments: Record<string, Slot | null> = {};

  const promptTexts: [number, string][] = [];
  const cameraTexts: string[] = [];
  // 媒体落位：refs 下标 → 槽位；单值槽先到先得
  const placed: { i: number; slot: MediaSlot }[] = [];
  const single: Partial<Record<MediaSlot, number>> = {};
  const unassignedImages: number[] = [];
  const place = (i: number, slot: MediaSlot) => {
    if (SINGLE_SLOTS.has(slot)) {
      if (single[slot] !== undefined) return false;
      single[slot] = i;
    }
    placed.push({ i, slot });
    assignments[refs[i].key] = slot;
    return true;
  };

  refs.forEach((item, i) => {
    assignments[item.key] = null;
    const explicit = explicitSlotOf(item, refRoles);
    const kind: Kind = item.dataType;
    if (!item.value) {
      warnings.push(`${refName(i + 1)} 暂无内容，已跳过`);
      return;
    }
    if (kind === 'STRING') {
      const slot: Slot = explicit ?? (isCameraSource(item.sourceType, item.sourceHandle) ? 'camera_prompt' : 'prompt');
      if (slot === 'camera_prompt') cameraTexts.push(item.value.trim());
      else promptTexts.push([i + 1, item.value]);
      assignments[item.key] = slot;
    } else if (kind === 'IMAGE') {
      if (explicit) place(i, explicit as MediaSlot);
      else unassignedImages.push(i);
    } else if (kind === 'AUDIO') place(i, 'ref_audio');
    else if (kind === 'VIDEO') place(i, 'reference_video');
  });

  // —— R5：视频模式（显式 / 自动），未指定槽位的图片按模式落位 ——
  let mode: GenMode | '' = '';
  if (isVideo) mode = normalizeVideoMode(params.mode) || autoMode(refs);
  unassignedImages.forEach((i, k) => {
    let prefer: MediaSlot[];
    if (!isVideo || mode === 'multiReference') prefer = ['reference_images'];
    else if (mode === 'text') return; // 文生视频：未指定槽位的图不发送
    else if (mode === 'singleImage') prefer = k === 0 ? ['first_frame', 'reference_images'] : ['reference_images'];
    else prefer = ['first_frame', 'last_frame', 'reference_images'];
    const slot = prefer.find((s) => !SINGLE_SLOTS.has(s) || single[s] === undefined) ?? 'reference_images';
    place(i, slot);
  });
  const unusedImages = unassignedImages.filter((i) => assignments[refs[i].key] === null);
  if (unusedImages.length && mode === 'text') warnings.push(`当前为文生模式，${names(unusedImages)} 未使用`);
  const lostSingles = refs.map((_, i) => i).filter((i) => refs[i].dataType === 'IMAGE' && refs[i].value && assignments[refs[i].key] === null && !unusedImages.includes(i));
  if (lostSingles.length) warnings.push(`${names(lostSingles)} 的槽位已被占用，未使用`);
  if (isVideo && typeof params.mode === 'string' && params.mode.trim().toLowerCase() === 'i2v' && single.first_frame !== undefined && single.last_frame !== undefined) {
    mode = 'startEnd'; // 旧 i2v 节点同时有首尾帧
  }

  // —— 后端同款槽位（列表按参考顺序、去重）——
  const listOf = (slot: MediaSlot): string[] => {
    const out: string[] = [];
    for (const p of [...placed].sort((a, b) => a.i - b.i)) {
      if (p.slot === slot && !out.includes(refs[p.i].value)) out.push(refs[p.i].value);
    }
    return out;
  };
  const canonical: CanonicalSlots = {};
  if (cameraTexts.length) canonical.camera_prompt = cameraTexts.join('\n');
  if (single.first_frame !== undefined) canonical.first_frame = refs[single.first_frame].value;
  if (single.last_frame !== undefined) canonical.last_frame = refs[single.last_frame].value;
  for (const s of ['reference_images', 'ref_audio', 'reference_video'] as const) {
    const l = listOf(s);
    if (l.length) canonical[s] = l;
  }

  // —— 前端独有：按生成源能力截断 ——
  const caps = resolveSlotCaps(params.slots);
  const finalLists: Record<MediaSlot, number[]> = { first_frame: [], last_frame: [], reference_images: [], ref_audio: [], reference_video: [] };
  for (const s of MEDIA_SLOTS) {
    const seen = new Set<string>();
    for (const p of [...placed].sort((a, b) => a.i - b.i)) {
      if (p.slot !== s || seen.has(refs[p.i].value)) continue;
      seen.add(refs[p.i].value);
      finalLists[s].push(p.i);
    }
  }
  if (caps) {
    for (const s of MEDIA_SLOTS) {
      const list = finalLists[s];
      if (!list.length) continue;
      const cap = caps[s];
      if (!cap) {
        warnings.push(`生成源不支持${SLOT_LABEL[s]}，${names(list)} 未使用`);
        list.forEach((i) => { assignments[refs[i].key] = null; });
        finalLists[s] = [];
        continue;
      }
      const max = cap.multi ? cap.max : 1;
      if (max !== undefined && list.length > max) {
        const dropped = list.splice(max);
        dropped.forEach((i) => { assignments[refs[i].key] = null; });
        warnings.push(`${cap.label}超出生成源上限（最多 ${max} 个），已忽略 ${names(dropped)}`);
      }
    }
    for (const [s, cap] of Object.entries(caps) as [MediaSlot, Cap][]) {
      if (cap.required && !finalLists[s].length) warnings.push(`生成源需要${cap.label}`);
    }
  }

  // —— R6 提示词（对应关系只写最终仍会下发的媒体）——
  const own = (params.prompt || '').trim();
  const mentioned = new Set<number>();
  for (const m of own.matchAll(REF_TOKEN_RE)) mentioned.add(Number(m[1]));
  const mapping: string[] = [];
  const refImageUrls = finalLists.reference_images.map((i) => refs[i].value);
  if (mentioned.size) {
    refs.forEach((r, i) => {
      if (!mentioned.has(i + 1) || r.dataType === 'STRING' || !r.value) return;
      const slot = assignments[r.key];
      if (!slot) return;
      // k = 该图在最终 reference_images（按 URL 去重）里的位置，同后端 ref_mapping
      const k = refImageUrls.indexOf(r.value);
      const desc = slot === 'reference_images' ? (k >= 0 ? `第 ${k + 1} 张参考图` : '') : SLOT_DESC[slot] ?? '';
      if (desc) mapping.push(`${refName(i + 1)}=${desc}`);
    });
  }
  let prompt: string;
  if (targetType === 'audio') {
    // R6a：只念自身文本（{{ref N}} 换成原文）；自身为空才念文本参考。前端额外：没被念到的文本参考标为未使用并提示
    prompt = assembleAudioText(own, promptTexts);
    if (own) {
      const unusedTexts = promptTexts.map(([n]) => n - 1).filter((i) => !mentioned.has(i + 1));
      unusedTexts.forEach((i) => { assignments[refs[i].key] = null; });
      if (unusedTexts.length) warnings.push(`台词里没有引用 ${names(unusedTexts)}，不会念出`);
      const nonText = [...mentioned].map((n) => n - 1).filter((i) => i >= 0 && i < refs.length && refs[i].dataType !== 'STRING');
      if (nonText.length) warnings.push(`${names(nonText)} 不是文本，台词里的引用会被忽略`);
    }
  } else {
    prompt = assemblePrompt(own, promptTexts, mapping.length ? `（参考编号对应：${mapping.join('，')}）` : '');
  }
  if (prompt) canonical.prompt = prompt;

  const val = (s: MediaSlot) => finalLists[s].map((i) => refs[i].value);
  const out: AssembledInputs = {
    canonical,
    prompt,
    ...(canonical.camera_prompt ? { camera_prompt: canonical.camera_prompt } : {}),
    ...(finalLists.first_frame.length ? { first_frame: refs[finalLists.first_frame[0]].value } : {}),
    ...(finalLists.last_frame.length ? { last_frame: refs[finalLists.last_frame[0]].value } : {}),
    reference_images: val('reference_images'),
    ref_audio: val('ref_audio'),
    reference_video: val('reference_video'),
    mode,
    ...(isVideo ? { providerMode: providerVideoMode(params.mode, canonical) } : {}),
    args: {},
    assignments,
    hasTextRefs: promptTexts.some(([, t]) => !!t.trim()),
    warnings,
  };

  if (!caps) {
    out.args = toEngineArgs({ ...canonical });
  } else {
    const args: Record<string, string | string[]> = {};
    if (prompt) args.prompt = prompt;
    if (canonical.camera_prompt) args.camera_prompt = canonical.camera_prompt;
    for (const s of MEDIA_SLOTS) {
      const cap = caps[s];
      const list = val(s);
      if (!cap || !list.length) continue;
      args[cap.argKey] = cap.multi ? list : list[0];
    }
    out.args = args;
  }
  return out;
}
