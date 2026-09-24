// -*- coding: utf-8 -*-
/**
 * 一键绑定 — 资源池 × 生成源插槽声明的确定性编排（纯函数，零网络，分镜/画布共用）。
 *
 * 规则：
 * - 资源池：真首帧（仅 i2v 语义）> 各绑定角色主图 > 场景底图 > 道具/背景 > 白模截图 > 白模视频；
 *   音频：当前说话角色 ref_audio_url > 旁白角色 > 其余绑定角色。
 * - 目标：所选生成源 input_schema 声明的媒体插槽（extractSlotsFromProvider 唯一解析口径）。
 * - 分配：必填优先；单值槽只放最高优先资源；数组槽按优先级装箱、去重、maxItems 截断；
 *   默认「仅填空槽」不覆盖手工值，可切「覆盖重绑」。
 * - 落盘：写归一槽键 + 源真实键（双写），与 ProviderSlotList/setSlotValue 完全同口径。
 */

export type BindKind = 'image' | 'video' | 'audio';

export type BindResourceSource =
  | 'frame'          // 分镜首帧图（仅进 first_frame 语义槽）
  | 'character'      // 角色三视图/立绘
  | 'scene'          // 场景底图
  | 'prop'           // 道具/背景/特效素材
  | 'shot_image'     // 本镜自有图（首帧图/插槽里存的旧键图，可作参考图兜底）
  | 'previz'         // 3D 白模截图
  | 'previz_video'   // 3D 动态预演
  | 'audio_ref';     // 角色参考音频（音色克隆）

/**
 * 旧单数 / 带 _url 后缀写法 → 源声明键的归一别名（唯一口径）。
 * 生成路径（keepDeclaredOnly）与一键绑定必须同表，否则预览显示"旧键被忽略"其实生成时会透传。
 */
export const LEGACY_SLOT_ALIASES: Record<string, string[]> = {
  reference_image: ['reference_images', 'reference'],
  first_frame_url: ['first_frame'],
  last_frame_url: ['last_frame'],
  reference_audio_url: ['reference_audio', 'reference_audios'],
};

export interface BindResource {
  id: string;
  type: 'image' | 'audio' | 'video';
  url: string;
  name: string;
  source: BindResourceSource;
  priority: number; // 越小越优先
  charId?: string;
  weight?: number;
  /** 资源来源键（shot.dynamic_inputs 的旧键），用于残留键判定 */
  fromKey?: string;
}

export interface BindSlotLike {
  key: string;
  originalKey?: string;
  label: string;
  type: 'image' | 'audio' | 'video';
  role?: string;
  maxCount?: number;
  minCount?: number;
  required?: boolean;
  multi?: boolean;
}

export interface BindFillItem {
  slotKey: string;
  slotLabel: string;
  url: string;
  name: string;
  source: BindResourceSource | 'existing';
  charId?: string;
  weight?: number;
  /** true = 保留槽内原有手工值（仅填空槽模式） */
  kept?: boolean;
}

export interface BindGap {
  slotKey: string;
  slotLabel: string;
  reason: string;
}

export interface BindTruncated {
  slotKey: string;
  slotLabel: string;
  name: string;
  reason: string;
}

export interface BindPlan {
  /** 直接并入 shot.dynamic_inputs（归一键 + 源真实键双写） */
  patch: Record<string, any>;
  filled: BindFillItem[];
  gaps: BindGap[];
  truncated: BindTruncated[];
  /** 现有 dynamic_inputs 中不被该源任何插槽声明的键（切源残留） */
  stale: string[];
  /** 该源声明的媒体插槽（预览显示"源要什么"，与资源池对照） */
  slots: Array<{ key: string; label: string; type: 'image' | 'audio' | 'video'; required: boolean }>;
}

export interface CollectOptions {
  shot: any;
  project: any;
  projectAssets?: any[];
  kind: BindKind;
  /** i2v 语义才把真首帧放入 first_frame 槽 */
  includeFirstFrame?: boolean;
  includePreviz?: boolean;
  includePrevizVideo?: boolean;
}

const isFirstFrameSlot = (s: BindSlotLike) =>
  s.role === 'first_frame' || /first.?frame|^first$|start.?frame/i.test(`${s.key} ${s.originalKey || ''}`);
const isLastFrameSlot = (s: BindSlotLike) =>
  s.role === 'last_frame' || /last.?frame|^last$|end.?frame/i.test(`${s.key} ${s.originalKey || ''}`);

/** 角色主图：三视图优先，avatar 兜底（同一角色只出一张） */
export function characterMainImage(c: any): string {
  return c?.three_views?.front || c?.three_views?.three_quarter || c?.three_views?.side || c?.avatar_url || '';
}

function assetUrl(a: any): string {
  return a?.file_url || a?.thumb_url || a?.image_url || '';
}

/** URL 形态判定：/storage 相对路径、http(s) 直链、或带图片扩展名 */
const isImageLikeUrl = (v: any): v is string =>
  typeof v === 'string' && v.length > 0 &&
  (/^\/storage\//.test(v) || /^https?:\/\//i.test(v) || /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(\?|#|$)/i.test(v));

/** 收集图片/视频资源（按优先级升序） */
export function collectMediaResources(opts: CollectOptions): BindResource[] {
  const { shot, project, projectAssets = [], includeFirstFrame, includePreviz = true, includePrevizVideo = true } = opts;
  const out: BindResource[] = [];

  // 0. 真首帧（只给 first_frame 语义槽消费）
  if (includeFirstFrame && shot?.image_url) {
    out.push({ id: `frame_${shot.id}`, type: 'image', url: shot.image_url, name: `镜头#${shot.shot_index || ''} 首帧`, source: 'frame', priority: 0 });
  }

  // 1. 绑定角色主图（按 character_ids 顺序 = 用户绑定顺序）
  const chars: any[] = project?.characters || [];
  (shot?.character_ids || []).forEach((cid: string, i: number) => {
    const c = chars.find((x: any) => x.id === cid);
    if (!c) return;
    const url = characterMainImage(c);
    if (!url) return;
    out.push({
      id: `char_${cid}`, type: 'image', url, name: c.name || cid, source: 'character',
      priority: 10 + i, charId: cid, weight: Number(shot?.character_weights?.[cid] ?? 0.8),
    });
  });

  // 2. 场景底图
  if (shot?.scene_ref_image) {
    out.push({ id: `scene_${shot.scene_asset_id || 'shot'}`, type: 'image', url: shot.scene_ref_image, name: shot.scene_name || '场景底图', source: 'scene', priority: 100 });
  }

  // 3. 道具/背景/特效（ID → 项目素材 URL）
  const byId = new Map<string, any>();
  for (const a of projectAssets) if (a?.id) byId.set(a.id, a);
  (shot?.prop_asset_ids || []).forEach((aid: string, i: number) => {
    const a = byId.get(aid);
    const url = assetUrl(a);
    if (!url) return;
    out.push({ id: `prop_${aid}`, type: 'image', url, name: a?.name || aid, source: 'prop', priority: 200 + i });
  });

  // 3.5 本镜自有图（仅视频源：首帧图 / 插槽里存的旧键图，角色缺立绘时也能兜底出参考）
  if (opts.kind === 'video') {
    const skip = new Set<string>(
      [shot?.previz_url, shot?.previz_video_url, shot?.scene_ref_image].filter(Boolean) as string[],
    );
    const pushStill = (url: any, key: string, label: string, priority: number) => {
      if (!isImageLikeUrl(url) || skip.has(url)) return;
      if (out.some((r) => r.url === url)) return;
      out.push({ id: `shotimg_${key}_${priority}`, type: 'image', url, name: label, source: 'shot_image', priority, fromKey: key });
    };
    pushStill(shot?.image_url, 'image_url', `镜头#${shot?.shot_index || ''} 首帧图`, 250);
    const di = (shot?.dynamic_inputs || {}) as Record<string, any>;
    Object.entries(di).forEach(([k, v]) => {
      const vals = Array.isArray(v) ? v : [v];
      vals.forEach((u, i) => pushStill(u, k, `镜头#${shot?.shot_index || ''} 已存图·${k}`, 260 + i));
    });
  }

  // 4. 白模预演
  if (includePreviz && shot?.previz_url) {
    out.push({ id: `previz_${shot.id}`, type: 'image', url: shot.previz_url, name: '白模预演截图', source: 'previz', priority: 300 });
  }
  if (includePrevizVideo && shot?.previz_video_url) {
    out.push({ id: `previzv_${shot.id}`, type: 'video', url: shot.previz_video_url, name: '白模动态预演', source: 'previz_video', priority: 300 });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** 收集音频资源：说话角色 ref_audio_url > 旁白角色 > 其余绑定角色（去重） */
export function collectAudioResources(shot: any, project: any): BindResource[] {
  const chars: any[] = project?.characters || [];
  const ids: string[] = shot?.character_ids || [];
  const ordered: any[] = [];
  const speaker = chars.find((c: any) => c?.name && c.name === shot?.speaker_name);
  if (speaker && ids.includes(speaker.id)) ordered.push(speaker);
  const narrator = chars.find((c: any) => c?.role === 'narrator' && ids.includes(c.id));
  if (narrator && !ordered.includes(narrator)) ordered.push(narrator);
  for (const id of ids) {
    const c = chars.find((x: any) => x.id === id);
    if (c && !ordered.includes(c)) ordered.push(c);
  }
  const out: BindResource[] = [];
  const seen = new Set<string>();
  ordered.forEach((c: any, i: number) => {
    const url = c?.ref_audio_url || '';
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ id: `aud_${c.id}`, type: 'audio', url, name: `参考音频·${c.name || c.id}`, source: 'audio_ref', priority: i === 0 ? 0 : 10 + i, charId: c.id });
  });
  return out;
}

export function collectResources(opts: CollectOptions): BindResource[] {
  return [...collectMediaResources(opts), ...collectAudioResources(opts.shot, opts.project)];
}

/**
 * 编排：资源 → 槽位。
 * @param slots 该源 input_schema 解析出的媒体插槽（extractSlotsFromProvider）
 * @param current 现有 dynamic_inputs（仅填空槽模式下保留的手工值）
 */
export function planBinding(
  resources: BindResource[],
  slots: BindSlotLike[],
  current: Record<string, any>,
  opts: { overwrite: boolean },
): BindPlan {
  const patch: Record<string, any> = {};
  const filled: BindFillItem[] = [];
  const gaps: BindGap[] = [];
  const truncated: BindTruncated[] = [];
  const declared = new Set<string>();
  slots.forEach((s) => { declared.add(s.key); if (s.originalKey) declared.add(s.originalKey); });

  const images = resources.filter((r) => r.type === 'image');
  const videos = resources.filter((r) => r.type === 'video');
  const audios = resources.filter((r) => r.type === 'audio');
  const used = new Set<string>();

  const slotKeys = (s: BindSlotLike) => Array.from(new Set([s.key, s.originalKey].filter(Boolean) as string[]));
  /** 旧键 → 该源声明槽的别名（如 reference_image → reference_images）；生成路径同表透传 */
  const aliasSlotKeys = (k: string) => (LEGACY_SLOT_ALIASES[k] || []).filter((a) => declared.has(a));
  const currentVal = (s: BindSlotLike) => {
    for (const k of slotKeys(s)) {
      const v = current?.[k];
      if (Array.isArray(v) ? v.length : (v !== undefined && v !== null && v !== '')) return v;
    }
    // 旧键别名：切源后旧值仍会沿别名通道透传，这里也认（避免"保留原值"漏报 + 重复绑定）
    for (const k of Object.keys(current || {})) {
      if (declared.has(k)) continue;
      if (!aliasSlotKeys(k).some((a) => slotKeys(s).includes(a))) continue;
      const v = current[k];
      if (Array.isArray(v) ? v.length : (v !== undefined && v !== null && v !== '')) return v;
    }
    return undefined;
  };
  /** 数组槽保留原值时补成数组（源声明为 array，字符串会挂） */
  const asSlotValue = (s: BindSlotLike, v: any) =>
    (s.multi || (typeof s.maxCount === 'number' && s.maxCount > 1)) && !Array.isArray(v) ? [v] : v;
  const write = (s: BindSlotLike, value: any, items: BindFillItem[]) => {
    for (const k of slotKeys(s)) patch[k] = value;
    filled.push(...items);
  };
  const markExistingUsed = (s: BindSlotLike, raw: any) => {
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const u of arr) if (typeof u === 'string' && u) used.add(u);
  };

  const alloc = (slot: BindSlotLike, pool: BindResource[]) => {
    const existing = currentVal(slot);
    const limit = typeof slot.maxCount === 'number' && slot.maxCount > 0 ? slot.maxCount : (slot.multi ? 9 : 1);
    if (!opts.overwrite && existing !== undefined) {
      // 仅填空槽：保留手工值，标记占用，避免同一资源重复进其他槽
      markExistingUsed(slot, existing);
      const arr = Array.isArray(existing) ? existing : [existing];
      write(slot, asSlotValue(slot, existing), arr.filter(Boolean).map((u: any) => ({
        slotKey: slot.key, slotLabel: slot.label, url: String(u), name: '保留手动值', source: 'existing' as const, kept: true,
      })));
      return;
    }
    const picked: BindResource[] = [];
    for (const r of pool) {
      if (picked.length >= limit) break;
      if (used.has(r.url)) continue;
      used.add(r.url);
      picked.push(r);
    }
    const over = pool.filter((r) => !picked.includes(r) && !used.has(r.url));
    for (const r of over.slice(0, 3)) {
      truncated.push({ slotKey: slot.key, slotLabel: slot.label, name: r.name, reason: `超出 ${slot.label} 上限 ${limit} 项` });
    }
    if (picked.length) {
      const value = slot.multi || limit > 1 ? picked.map((r) => r.url) : picked[0].url;
      write(slot, value, picked.map((r) => ({
        slotKey: slot.key, slotLabel: slot.label, url: r.url, name: r.name, source: r.source, charId: r.charId, weight: r.weight,
      })));
      return;
    }
    if (slot.required && currentVal(slot) === undefined) {
      gaps.push({ slotKey: slot.key, slotLabel: slot.label, reason: '必填槽无可用资源（先绑定人物/场景/素材，或上传/选择）' });
    }
  };

  // 槽位分类：首帧/尾帧 > 音频 > 视频参考 > 图片参考
  const firstSlots = slots.filter((s) => s.type === 'image' && isFirstFrameSlot(s));
  const lastSlots = slots.filter((s) => s.type === 'image' && isLastFrameSlot(s));
  const audioSlots = slots.filter((s) => s.type === 'audio' && !isFirstFrameSlot(s) && !isLastFrameSlot(s));
  const videoSlots = slots.filter((s) => s.type === 'video' && !isFirstFrameSlot(s) && !isLastFrameSlot(s));
  const imageSlots = slots.filter((s) => s.type === 'image' && !isFirstFrameSlot(s) && !isLastFrameSlot(s));

  // first_frame 只认真首帧资源；last_frame 目前无自动来源（保留手工值/缺口）
  for (const s of firstSlots) alloc(s, images.filter((r) => r.source === 'frame'));
  for (const s of lastSlots) alloc(s, []);
  for (const s of [...imageSlots, ...audioSlots, ...videoSlots]) {
    const pool = s.type === 'audio' ? audios : s.type === 'video' ? videos : images.filter((r) => r.source !== 'frame');
    alloc(s, pool);
  }

  // 残留键：既不是该源声明槽（含旧键别名通道），也没被重绑进新槽的值
  const stale = Object.keys(current || {}).filter((k) => {
    if (declared.has(k)) return false;
    if (aliasSlotKeys(k).length) return false;
    const v = current[k];
    const vals = Array.isArray(v) ? v : [v];
    if (vals.some((u) => typeof u === 'string' && u && used.has(u))) return false;
    return true;
  });
  return {
    patch, filled, gaps, truncated, stale,
    slots: slots.map((s) => ({ key: s.key, label: s.label, type: s.type, required: !!s.required })),
  };
}
